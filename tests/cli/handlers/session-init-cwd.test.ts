import { afterEach, describe, expect, it } from 'bun:test';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';

describe('sessionInitHandler sends cwd to the worker', () => {
  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  it('includes the hook cwd in /api/sessions/init so the observer can be routed before it spawns', async () => {
    const calls: Array<{ apiPath: string; body: Record<string, unknown> }> = [];
    setSessionInitDependenciesForTesting({
      executeWithWorkerFallback: async (apiPath, _method, body) => {
        calls.push({ apiPath, body: body as Record<string, unknown> });
        return { sessionDbId: 7, promptNumber: 1 };
      },
    });

    const savedInternal = process.env.CLAUDE_MEM_INTERNAL;
    delete process.env.CLAUDE_MEM_INTERNAL;
    try {
      await sessionInitHandler.execute({
        sessionId: 'sess-cwd',
        cwd: '/Users/me/projects/personal/career',
        platform: 'claude-code',
        prompt: 'hello',
      });
    } finally {
      if (savedInternal === undefined) delete process.env.CLAUDE_MEM_INTERNAL;
      else process.env.CLAUDE_MEM_INTERNAL = savedInternal;
    }

    const init = calls.find(c => c.apiPath === '/api/sessions/init');
    expect(init).toBeDefined();
    expect(init!.body.cwd).toBe('/Users/me/projects/personal/career');
    expect(init!.body.project).toBeDefined();
  });
});
