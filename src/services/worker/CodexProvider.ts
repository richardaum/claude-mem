import { spawn } from 'child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { ClassifiedProviderError } from './provider-errors.js';

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const BASE_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME',
  'SHELL', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY',
  'HTTPS_PROXY', 'NO_PROXY',
];

interface CliConfig {
  apiKey: string;
  model: string;
  executablePath: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
}

interface CliRunResult {
  stdout: string;
  stderr: string;
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function findExecutable(command: string): string | null {
  const trimmed = command.trim().replace(/^~(?=$|[\\/])/, homedir());
  if (!trimmed) return null;

  const candidates = path.isAbsolute(trimmed) || trimmed.includes(path.sep)
    ? [path.resolve(trimmed)]
    : (process.env.PATH ?? '').split(path.delimiter).flatMap((directory) => {
        if (!directory) return [];
        if (process.platform !== 'win32') return [path.join(directory, trimmed)];
        const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';');
        return extensions.map((extension) => path.join(directory, `${trimmed}${extension}`));
      });

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return null;
}

function buildChildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of BASE_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

export function classifyCodexCliFailure(detail: string, cause: unknown): ClassifiedProviderError {
  const lower = detail.toLowerCase();
  const label = 'Codex CLI';
  if (lower.includes('not logged in') || lower.includes('login required') || lower.includes('unauthorized') || lower.includes('401')) {
    return new ClassifiedProviderError(`${label} authentication is required`, { kind: 'auth_invalid', cause });
  }
  if (lower.includes('quota') || lower.includes('allowance') || lower.includes('usage limit') || lower.includes('insufficient credits')) {
    return new ClassifiedProviderError(`${label} reported exhausted quota`, { kind: 'quota_exhausted', cause });
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return new ClassifiedProviderError(`${label} reported a rate limit`, { kind: 'rate_limit', cause });
  }
  if (lower.includes('timed out') || lower.includes('network') || lower.includes('econnreset') || /\b5\d\d\b/.test(lower)) {
    return new ClassifiedProviderError(`${label} failed temporarily`, { kind: 'transient', cause });
  }
  return new ClassifiedProviderError(`${label} exited unsuccessfully`, { kind: 'unrecoverable', cause });
}

export function buildCodexArgs(model: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '-o',
    '{output}',
    ...(model ? ['-m', '{model}'] : []),
    '-',
  ];
}

function abortError(): Error {
  const error = new Error('CLI request aborted');
  error.name = 'AbortError';
  return error;
}

export class CodexProvider extends OpenAICompatibleProvider<CliConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = false;

  protected getConfig(): CliConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const configuredCommand = settings.CLAUDE_MEM_CODEX_PATH || 'codex';
    const executablePath = findExecutable(configuredCommand);
    if (!executablePath) {
      throw new ClassifiedProviderError(`${this.providerName} executable was not found`, {
        kind: 'setup_required',
        cause: new Error('CLI executable unavailable'),
      });
    }

    const model = settings.CLAUDE_MEM_CODEX_MODEL;
    const args = buildCodexArgs(model);
    const timeoutMs = positiveInt(settings.CLAUDE_MEM_CODEX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxOutputBytes = positiveInt(settings.CLAUDE_MEM_CLI_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);

    return {
      apiKey: 'local-cli',
      model,
      executablePath,
      args,
      timeoutMs,
      maxOutputBytes,
      env: buildChildEnvironment(),
    };
  }

  protected missingApiKeyError(): Error {
    return new Error(`${this.providerName} is not configured`);
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return result.inputTokens !== undefined && result.outputTokens !== undefined
      ? { input: result.inputTokens, output: result.outputTokens }
      : null;
  }

  protected async query(history: ConversationMessage[], config: CliConfig, signal?: AbortSignal): Promise<ProviderQueryResult> {
    const prompt = [
      'You are the claude-mem memory compression worker.',
      'Use earlier messages only as context. Answer only the final user message.',
      'Return only the structured XML or plain text requested by that final message. Do not add markdown fences.',
      '',
      JSON.stringify(history),
    ].join('\n');
    const tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-cli-'));
    const outputPath = path.join(tempDir, 'last-message.txt');
    const args = config.args.map((arg) => arg.replaceAll('{model}', config.model).replaceAll('{output}', outputPath));

    try {
      logger.debug('SDK', 'Querying Codex CLI', {
        turns: history.length,
        model: config.model || 'default',
        timeoutMs: config.timeoutMs,
      });
      const result = await this.runCli(config, args, prompt, tempDir, signal);
      let content = '';
      if (config.args.some((arg) => arg.includes('{output}')) && existsSync(outputPath)) {
        if (statSync(outputPath).size > config.maxOutputBytes) {
          throw new ClassifiedProviderError(`${this.providerName} output exceeded the configured limit`, {
            kind: 'unrecoverable',
            cause: new Error('CLI output file too large'),
          });
        }
        content = readFileSync(outputPath, 'utf8').trim();
      }
      content ||= result.stdout.trim();
      if (!content) {
        logger.warn('SDK', 'Codex CLI returned an empty response');
      }
      const inputTokens = this.estimateTokens(prompt);
      const outputTokens = this.estimateTokens(content);
      return { content, inputTokens, outputTokens, tokensUsed: inputTokens + outputTokens };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private runCli(config: CliConfig, args: string[], prompt: string, cwd: string, signal?: AbortSignal): Promise<CliRunResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      let terminationError: Error | null = null;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      const child = spawn(config.executablePath, args, {
        cwd,
        env: config.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
      });

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };
      const terminate = (error: Error): void => {
        if (terminationError) return;
        terminationError = error;
        if (child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        } else {
          child.kill('SIGTERM');
        }
        forceKillTimer = setTimeout(() => {
          if (settled) return;
          if (child.pid && process.platform !== 'win32') {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          } else {
            child.kill('SIGKILL');
          }
        }, 2_000);
        forceKillTimer.unref();
      };
      const timer = setTimeout(() => terminate(new Error('CLI request timed out')), config.timeoutMs);
      timer.unref();
      const onAbort = (): void => terminate(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });

      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > config.maxOutputBytes) {
          terminate(new Error('CLI output exceeded the configured limit'));
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          finish(new ClassifiedProviderError(`${this.providerName} executable was not found`, {
            kind: 'setup_required', cause: new Error('CLI executable unavailable'),
          }));
        } else {
          finish(classifyCodexCliFailure(error.message, new Error('CLI spawn failed')));
        }
      });
      child.on('close', (code) => {
        if (terminationError) {
          if (terminationError.name === 'AbortError') finish(terminationError);
          else finish(classifyCodexCliFailure(terminationError.message, terminationError));
          return;
        }
        if (code !== 0) {
          finish(classifyCodexCliFailure(`${stderr}\n${stdout}`, new Error(`CLI exit code ${code ?? 'null'}`)));
          return;
        }
        finish();
      });
      child.stdin?.end(prompt);
    });
  }
}

export function isCodexSelected(): boolean {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER === 'codex';
}
