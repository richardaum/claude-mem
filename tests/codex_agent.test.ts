import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { CodexAgent } from '../src/services/worker/CodexAgent';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

describe('CodexAgent', () => {
  let agent: CodexAgent;
  let spawnSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let mockUpdateMemorySessionId: ReturnType<typeof mock>;
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let capturedStdin = '';

  beforeEach(() => {
    capturedStdin = '';

    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'codex',
      CLAUDE_MEM_CODEX_MODEL: 'gpt-5.5',
      CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES: '20',
      CLAUDE_MEM_CODEX_MAX_TOKENS: '100000',
      CLAUDE_MEM_CODEX_TIMEOUT_MS: '300000',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => '/usr/local/bin/codex\n');

    spawnSpy = spyOn(childProcess, 'spawn').mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 12345;
      child.killed = false;
      child.kill = mock(() => {
        child.killed = true;
        return true;
      });
      child.stdin = {
        write: mock((chunk: string) => {
          capturedStdin += chunk;
          return true;
        }),
        end: mock(() => {}),
      };

      const outputPath = args[args.indexOf('-o') + 1];
      queueMicrotask(() => {
        writeFileSync(outputPath, '<observation><type>discovery</type><title>Codex OK</title></observation>');
        child.emit('close', 0, null);
      });

      return child;
    });

    mockUpdateMemorySessionId = mock(() => {});
    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const mockSessionStore = {
      updateMemorySessionId: mockUpdateMemorySessionId,
      storeObservations: mockStoreObservations,
      getSessionById: mock(() => ({ memory_session_id: 'codex-test-session' })),
      ensureMemorySessionIdRegistered: mock(() => {}),
    };

    const mockChromaSync = {
      syncObservation: mock(() => Promise.resolve()),
      syncSummary: mock(() => Promise.resolve()),
    };

    mockDbManager = {
      getSessionStore: () => mockSessionStore,
      getChromaSync: () => mockChromaSync,
    } as unknown as DatabaseManager;

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: mock(() => {}),
        cleanupProcessed: mock(() => 0),
        resetStuckMessages: mock(() => 0),
      }),
    } as unknown as SessionManager;

    agent = new CodexAgent(mockDbManager, mockSessionManager);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    execSyncSpy.mockRestore();
    loadFromFileSpy.mockRestore();
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('invokes codex exec non-interactively and stores the response', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'content-session-1',
      memorySessionId: null,
      project: 'test-project',
      platformSource: 'claude-code',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      earliestPendingTimestamp: null,
      currentProvider: null,
      startTime: Date.now(),
      processingMessageIds: [],
    } as any;

    await agent.startSession(session);

    expect(execSyncSpy).toHaveBeenCalledWith(
      'which codex',
      expect.objectContaining({ encoding: 'utf8' })
    );
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnSpy.mock.calls[0] as [string, string[], any];
    expect(command).toBe('/usr/local/bin/codex');
    expect(args).toContain('exec');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('-o');
    expect(args.at(-1)).toBe('-');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(capturedStdin).toContain('test prompt');
    expect(session.memorySessionId).toStartWith('codex-content-session-1-');
    expect(mockUpdateMemorySessionId).toHaveBeenCalled();
    expect(mockStoreObservations).toHaveBeenCalled();
  });

  it('falls back to the Codex stderr transcript when the output file is empty', async () => {
    spawnSpy.mockRestore();
    spawnSpy = spyOn(childProcess, 'spawn').mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 12346;
      child.killed = false;
      child.kill = mock(() => {
        child.killed = true;
        return true;
      });
      child.stdin = {
        write: mock((chunk: string) => {
          capturedStdin += chunk;
          return true;
        }),
        end: mock(() => {}),
      };

      const outputPath = args[args.indexOf('-o') + 1];
      queueMicrotask(() => {
        writeFileSync(outputPath, '');
        child.stderr.emit('data', Buffer.from([
          'OpenAI Codex v0.125.0',
          'codex',
          '<observation><type>discovery</type><title>Codex stderr OK</title></observation>',
          'tokens used',
          '42',
        ].join('\n')));
        child.emit('close', 0, null);
      });

      return child;
    });

    const session = {
      sessionDbId: 2,
      contentSessionId: 'content-session-2',
      memorySessionId: null,
      project: 'test-project',
      platformSource: 'claude-code',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      earliestPendingTimestamp: null,
      currentProvider: null,
      startTime: Date.now(),
      processingMessageIds: [],
    } as any;

    await agent.startSession(session);

    expect(mockStoreObservations).toHaveBeenCalled();
  });
});
