/**
 * CodexAgent: Codex CLI-based observation extraction
 *
 * Uses the local `codex` CLI authenticated with the user's ChatGPT account.
 * Codex runs as a stateless one-shot subprocess, so this provider maintains
 * context in ActiveSession.conversationHistory just like Gemini/OpenRouter.
 */

import * as childProcess from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  type WorkerRef
} from './agents/index.js';

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const DEFAULT_TIMEOUT_MS = 300000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

interface CodexConfig {
  executablePath: string;
  model: string;
  timeoutMs: number;
}

interface CodexRunResult {
  stdout: string;
  stderr: string;
}

export class CodexAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start Codex agent for a session.
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const { executablePath, model, timeoutMs } = this.getCodexConfig();

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `codex-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Codex`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryCodexMultiTurn(session.conversationHistory, executablePath, model, timeoutMs, session.abortController.signal);
      await this.handleInitResponse(initResponse, session, worker, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Codex init failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Codex init failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleCodexError(error, session, worker);
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, executablePath, model, timeoutMs, worker, mode);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Codex message processing failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Codex message processing failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleCodexError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Codex agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model
    });
  }

  private prepareMessageMetadata(session: ActiveSession, message: { _persistentId: number; agentId?: string | null; agentType?: string | null }): void {
    session.processingMessageIds.push(message._persistentId);
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
  }

  private async handleInitResponse(
    initResponse: { content: string; tokensUsed?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, 'Codex', undefined, model
      );
    } else {
      logger.error('SDK', 'Empty Codex init response - session may lack context', {
        sessionId: session.sessionDbId,
        model
      });
    }
  }

  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type?: string; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    executablePath: string,
    model: string,
    timeoutMs: number,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<string | undefined> {
    this.prepareMessageMetadata(session, message);

    if (message.cwd) {
      lastCwd = message.cwd;
    }
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(
        session, message, originalTimestamp, lastCwd,
        executablePath, model, timeoutMs, worker
      );
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(
        session, message, originalTimestamp, lastCwd,
        executablePath, model, timeoutMs, worker, mode
      );
    }

    return lastCwd;
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    executablePath: string,
    model: string,
    timeoutMs: number,
    worker: WorkerRef | undefined
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const obsResponse = await this.queryCodexMultiTurn(session.conversationHistory, executablePath, model, timeoutMs, session.abortController.signal);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    if (obsResponse.content) {
      await processAgentResponse(
        obsResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, 'Codex', lastCwd, model
      );
    } else {
      logger.warn('SDK', 'Empty Codex observation response, skipping processing to preserve message', {
        sessionId: session.sessionDbId,
        messageId: session.processingMessageIds[session.processingMessageIds.length - 1]
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    executablePath: string,
    model: string,
    timeoutMs: number,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const summaryResponse = await this.queryCodexMultiTurn(session.conversationHistory, executablePath, model, timeoutMs, session.abortController.signal);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    if (summaryResponse.content) {
      await processAgentResponse(
        summaryResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, originalTimestamp, 'Codex', lastCwd, model
      );
    } else {
      logger.warn('SDK', 'Empty Codex summary response, skipping processing to preserve message', {
        sessionId: session.sessionDbId,
        messageId: session.processingMessageIds[session.processingMessageIds.length - 1]
      });
    }
  }

  private handleCodexError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Codex agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'Codex agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const maxContextMessages = parseInt(settings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxEstimatedTokens = parseInt(settings.CLAUDE_MEM_CODEX_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= maxContextMessages) {
      const totalTokens = history.reduce((sum, message) => sum + this.estimateTokens(message.content), 0);
      if (totalTokens <= maxEstimatedTokens) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      const messageTokens = this.estimateTokens(message.content);

      if (truncated.length > 0 && (truncated.length >= maxContextMessages || tokenCount + messageTokens > maxEstimatedTokens)) {
        logger.warn('SDK', 'Codex context window truncated to prevent runaway cost/time', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxEstimatedTokens
        });
        break;
      }

      truncated.unshift(message);
      tokenCount += messageTokens;
    }

    return truncated;
  }

  private conversationToCodexPrompt(history: ConversationMessage[]): string {
    const turns = history
      .map((message, index) => {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        return `<message index="${index + 1}" role="${role}">\n${message.content}\n</message>`;
      })
      .join('\n\n');

    return [
      'You are the claude-mem memory compression worker.',
      'Use earlier messages only as context. Answer only the final user message.',
      'Return only the structured XML requested by that final message. Do not add markdown fences or commentary.',
      '',
      '<conversation>',
      turns,
      '</conversation>',
    ].join('\n');
  }

  private async queryCodexMultiTurn(
    history: ConversationMessage[],
    executablePath: string,
    model: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const prompt = this.conversationToCodexPrompt(truncatedHistory);
    const estimatedInputTokens = this.estimateTokens(prompt);
    const tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-codex-'));
    const outputPath = path.join(tempDir, 'last-message.txt');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '-o',
      outputPath,
    ];

    if (model.trim()) {
      args.push('-m', model.trim());
    }
    args.push('-');

    logger.debug('SDK', `Querying Codex CLI (${model || 'default'})`, {
      turns: truncatedHistory.length,
      totalTurns: history.length,
      estimatedInputTokens,
      timeoutMs
    });

    try {
      const result = await this.runCodexCli(executablePath, args, prompt, tempDir, timeoutMs, signal);
      const outputFileContent = existsSync(outputPath)
        ? readFileSync(outputPath, 'utf-8').trim()
        : '';
      const content = outputFileContent
        || this.extractFinalMessageFromCodexOutput(result.stdout).trim()
        || this.extractFinalMessageFromCodexOutput(result.stderr).trim();

      if (!content) {
        logger.error('SDK', 'Empty response from Codex CLI', {
          stdoutBytes: result.stdout.length,
          stderrBytes: result.stderr.length
        });
        return { content: '' };
      }

      const tokensUsed = estimatedInputTokens + this.estimateTokens(content);
      return { content, tokensUsed };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private runCodexCli(
    executablePath: string,
    args: string[],
    prompt: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let terminationReason: Error | null = null;

      const child = childProcess.spawn(executablePath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      const finish = (error: Error | null, result?: CodexRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) {
          reject(error);
        } else {
          resolve(result!);
        }
      };

      const terminateChild = (reason: Error): void => {
        terminationReason = reason;
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          setTimeout(() => {
            if (!settled) {
              try {
                process.kill(-child.pid!, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            }
          }, 2000).unref();
        } else {
          child.kill('SIGTERM');
        }
      };

      const timer = setTimeout(() => {
        terminateChild(new Error(`Codex CLI timed out after ${timeoutMs}ms. Increase CLAUDE_MEM_CODEX_TIMEOUT_MS if needed.`));
      }, timeoutMs);
      timer.unref();

      const onAbort = (): void => {
        terminateChild(new Error('Codex CLI request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          finish(new Error('Codex executable not found. Install Codex CLI or set CLAUDE_MEM_CODEX_PATH in ~/.claude-mem/settings.json.'));
          return;
        }
        finish(error);
      });
      child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
        if (terminationReason) {
          finish(terminationReason);
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal ${signalName ?? 'unknown'}`;
          finish(new Error(`Codex CLI exited with code ${code ?? 'null'}: ${detail}`));
          return;
        }
        finish(null, { stdout, stderr });
      });

      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }

  private extractFinalMessageFromCodexOutput(output: string): string {
    const lines = output.split(/\r?\n/);
    const tokenLineIndex = lines.findIndex(line => line.trim().toLowerCase() === 'tokens used');
    const messageLines = tokenLineIndex >= 0 ? lines.slice(0, tokenLineIndex) : lines;
    let codexLineIndex = -1;
    for (let i = messageLines.length - 1; i >= 0; i--) {
      if (messageLines[i].trim().toLowerCase() === 'codex') {
        codexLineIndex = i;
        break;
      }
    }
    return (codexLineIndex >= 0 ? messageLines.slice(codexLineIndex + 1) : messageLines).join('\n');
  }

  private getCodexConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const executablePath = resolveCodexExecutable(settings.CLAUDE_MEM_CODEX_PATH);
    if (!executablePath) {
      throw new Error('Codex executable not found. Install Codex CLI or set CLAUDE_MEM_CODEX_PATH in ~/.claude-mem/settings.json.');
    }

    const timeoutMs = parseInt(settings.CLAUDE_MEM_CODEX_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;

    return {
      executablePath,
      model: settings.CLAUDE_MEM_CODEX_MODEL || '',
      timeoutMs,
    };
  }
}

function resolveCodexExecutable(configuredPath?: string): string | null {
  if (configuredPath) {
    if (!existsSync(configuredPath)) {
      return null;
    }
    return configuredPath;
  }

  try {
    const command = process.platform === 'win32' ? 'where codex.cmd' : 'which codex';
    return childProcess.execSync(command, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function isCodexAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return resolveCodexExecutable(settings.CLAUDE_MEM_CODEX_PATH) !== null;
}

export function isCodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'codex';
}
