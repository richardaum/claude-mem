import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// paths.dataDir() is fixed at the first module load in the bun process (a shared
// preload may already have pointed it at a temp dir), so never assume our own
// dir: ask paths for it. If we are the first loader, CLAUDE_MEM_DATA_DIR keeps
// the user's real ~/.claude-mem out of play. The credentials file is redirected
// per call via CLAUDE_MEM_ENV_FILE.
const OWN_DIR = fs.mkdtempSync(join(tmpdir(), 'claude-mem-provider-profiles-'));
const ORIGINAL_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
const ORIGINAL_ENV_FILE = process.env.CLAUDE_MEM_ENV_FILE;
process.env.CLAUDE_MEM_DATA_DIR ??= OWN_DIR;
process.env.CLAUDE_MEM_ENV_FILE = join(OWN_DIR, '.env');

const {
  parseProviderProfileRules,
  matchProviderProfileRule,
  resolveProviderProfile,
  profileEnvFilePath,
} = await import('../src/shared/provider-profiles.js');
const { buildIsolatedEnv, getAuthMethodDescription } = await import('../src/shared/EnvManager.js');
const { paths } = await import('../src/shared/paths.js');
const PROFILES_DIR = join(paths.dataDir(), 'env.d');

const RULES = JSON.stringify([
  { match: '**/projects/work/**', profile: 'gateway' },
  { match: '**/projects/personal/**', profile: 'personal' },
  { match: 'scratch', profile: 'default' },
]);

function writeProfile(name: string, body: string): void {
  const file = profileEnvFilePath(name);
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.writeFileSync(file, body);
}

describe('provider profiles', () => {
  beforeAll(() => {
    fs.writeFileSync(
      join(OWN_DIR, '.env'),
      'ANTHROPIC_BASE_URL=https://default-gateway.example\nANTHROPIC_AUTH_TOKEN=default-token\n',
    );
  });

  afterAll(() => {
    fs.rmSync(PROFILES_DIR, { recursive: true, force: true });
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = ORIGINAL_DATA_DIR;
    if (ORIGINAL_ENV_FILE === undefined) delete process.env.CLAUDE_MEM_ENV_FILE;
    else process.env.CLAUDE_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
  });

  beforeEach(() => {
    fs.rmSync(PROFILES_DIR, { recursive: true, force: true });
  });

  describe('parseProviderProfileRules', () => {
    it('returns [] for empty, invalid JSON, and non-arrays', () => {
      expect(parseProviderProfileRules(undefined)).toEqual([]);
      expect(parseProviderProfileRules('')).toEqual([]);
      expect(parseProviderProfileRules('[]')).toEqual([]);
      expect(parseProviderProfileRules('{not json')).toEqual([]);
      expect(parseProviderProfileRules('{"match":"a","profile":"b"}')).toEqual([]);
    });

    it('skips malformed entries but keeps valid ones', () => {
      const rules = parseProviderProfileRules(
        JSON.stringify([{ match: 'a', profile: 'p' }, { match: 'b' }, { profile: 'c' }, null, { match: ' ', profile: 'x' }]),
      );
      expect(rules).toEqual([{ match: 'a', profile: 'p' }]);
    });
  });

  describe('matchProviderProfileRule', () => {
    const rules = parseProviderProfileRules(RULES);

    it('matches a nested path with **', () => {
      expect(matchProviderProfileRule(rules, { cwd: '/Users/me/projects/work/api/src' })?.profile).toBe('gateway');
      expect(matchProviderProfileRule(rules, { cwd: '/Users/me/projects/personal/career' })?.profile).toBe('personal');
    });

    it('does not match a sibling that only shares a prefix', () => {
      expect(matchProviderProfileRule(rules, { cwd: '/Users/me/projects/work-old/api' })).toBeNull();
      expect(matchProviderProfileRule(rules, { cwd: '/Users/me/projects/other' })).toBeNull();
    });

    it('first matching rule wins', () => {
      const ordered = parseProviderProfileRules(
        JSON.stringify([
          { match: '**/projects/work/special/**', profile: 'a' },
          { match: '**/projects/work/**', profile: 'b' },
        ]),
      );
      expect(matchProviderProfileRule(ordered, { cwd: '/h/projects/work/special/x' })?.profile).toBe('a');
      expect(matchProviderProfileRule(ordered, { cwd: '/h/projects/work/y' })?.profile).toBe('b');
    });

    it('falls back to the project name when there is no cwd', () => {
      expect(matchProviderProfileRule(rules, { project: 'scratch' })?.profile).toBe('default');
      expect(matchProviderProfileRule(rules, {})).toBeNull();
    });
  });

  describe('resolveProviderProfile', () => {
    it('returns none when no rule matches or the rule says default', () => {
      expect(resolveProviderProfile(RULES, { cwd: '/h/projects/other' })).toEqual({ kind: 'none' });
      expect(resolveProviderProfile(RULES, { project: 'scratch' })).toEqual({ kind: 'none' });
      expect(resolveProviderProfile('[]', { cwd: '/h/projects/work/a' })).toEqual({ kind: 'none' });
    });

    it('loads credentials and model from the profile file, ignoring other keys', () => {
      writeProfile(
        'gateway',
        'ANTHROPIC_BASE_URL=https://gw.example\nANTHROPIC_AUTH_TOKEN=tok\nCLAUDE_MEM_MODEL=anthropic/claude-haiku-5-5\nCLAUDE_CODE_OAUTH_TOKEN=leak\nRANDOM=1\n',
      );
      const res = resolveProviderProfile(RULES, { cwd: '/h/projects/work/a' });
      expect(res.kind).toBe('profile');
      if (res.kind !== 'profile') return;
      expect(res.profile.name).toBe('gateway');
      expect(res.profile.model).toBe('anthropic/claude-haiku-5-5');
      expect(res.profile.credentials).toEqual({
        ANTHROPIC_BASE_URL: 'https://gw.example',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      });
    });

    it('a profile file with only a model means no credentials (OAuth path)', () => {
      writeProfile('personal', 'CLAUDE_MEM_MODEL=claude-haiku-5-5\n');
      const res = resolveProviderProfile(RULES, { cwd: '/h/projects/personal/career' });
      expect(res.kind).toBe('profile');
      if (res.kind !== 'profile') return;
      expect(res.profile.credentials).toEqual({});
      expect(res.profile.model).toBe('claude-haiku-5-5');
    });

    it('fails closed when the matched profile file is missing', () => {
      const res = resolveProviderProfile(RULES, { cwd: '/h/projects/work/a' });
      expect(res.kind).toBe('unresolved');
      if (res.kind === 'unresolved') {
        expect(res.name).toBe('gateway');
        expect(res.reason).toContain('not found');
      }
    });

    it('fails closed on an unsafe profile name instead of reading outside env.d', () => {
      const evil = JSON.stringify([{ match: '**', profile: '../.env' }]);
      const res = resolveProviderProfile(evil, { cwd: '/h/anything' });
      expect(res.kind).toBe('unresolved');
    });
  });

  describe('buildIsolatedEnv with a profile', () => {
    it('without a profile, behavior is unchanged: the default .env is injected', () => {
      const env = buildIsolatedEnv(true);
      expect(env.ANTHROPIC_BASE_URL).toBe('https://default-gateway.example');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('default-token');
    });

    it('a credential-less profile does NOT inherit the default gateway', () => {
      const env = buildIsolatedEnv(true, { name: 'personal', credentials: {} });
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('a profile with credentials replaces the default, never merges with it', () => {
      const env = buildIsolatedEnv(true, {
        name: 'gateway',
        credentials: { ANTHROPIC_BASE_URL: 'https://gw.example' },
      });
      expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('describes the auth method by profile without printing secrets', () => {
      expect(getAuthMethodDescription({ name: 'personal', credentials: {} })).toContain('OAuth');
      const gw = getAuthMethodDescription({ name: 'gw', credentials: { ANTHROPIC_AUTH_TOKEN: 'super-secret' } });
      expect(gw).toContain('Gateway');
      expect(gw).not.toContain('super-secret');
    });
  });
});
