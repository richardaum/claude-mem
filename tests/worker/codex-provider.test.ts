import { describe, expect, it } from 'bun:test';

import {
  buildCodexArgs,
  classifyCodexCliFailure,
  CodexProvider,
} from '../../src/services/worker/CodexProvider.js';

describe('CodexProvider', () => {
  it('uses an ephemeral, read-only Codex execution without user config or rules', () => {
    const args = buildCodexArgs('gpt-test');

    expect(args).toEqual([
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
      '-m',
      '{model}',
      '-',
    ]);
  });

  it('omits the model flag when the Codex CLI default should be used', () => {
    expect(buildCodexArgs('')).not.toContain('-m');
  });

  it.each([
    ['Not logged in; please login', 'auth_invalid'],
    ['usage limit reached', 'quota_exhausted'],
    ['429 rate limit', 'rate_limit'],
    ['network timed out', 'transient'],
    ['unexpected command failure', 'unrecoverable'],
  ] as const)('classifies CLI failures without exposing raw output: %s', (detail, kind) => {
    const error = classifyCodexCliFailure(`${detail} SECRET_PAYLOAD`, new Error('sanitized'));

    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain('SECRET_PAYLOAD');
  });

  it('preserves buffered work when the Codex executable needs setup', async () => {
    const priorPath = process.env.CLAUDE_MEM_CODEX_PATH;
    process.env.CLAUDE_MEM_CODEX_PATH = '/definitely/missing/claude-mem-codex';
    const session = {
      sessionDbId: 1,
      abortController: new AbortController(),
      abortReason: null,
    } as any;
    const provider = new CodexProvider({} as any, {} as any);

    try {
      await expect(provider.startSession(session)).rejects.toMatchObject({ kind: 'setup_required' });
      expect(session.abortReason).toBe('auth:setup_required');
      expect(session.abortController.signal.aborted).toBe(true);
    } finally {
      if (priorPath === undefined) delete process.env.CLAUDE_MEM_CODEX_PATH;
      else process.env.CLAUDE_MEM_CODEX_PATH = priorPath;
    }
  });
});
