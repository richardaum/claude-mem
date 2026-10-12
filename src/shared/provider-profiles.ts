import { existsSync, readFileSync } from 'fs';
import { parseEnv } from 'util';
import { join } from 'path';
import { paths } from './paths.js';
import { matchesAnyGlob } from '../utils/project-filter.js';
import { logger } from '../utils/logger.js';

/**
 * The only env keys ever copied out of a credentials file (~/.claude-mem/.env
 * or a profile file). Whitelist, never Object.assign: an arbitrary key in the
 * file must not reach the SDK subprocess (see #2375).
 */
export const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

export type CredentialKey = typeof CREDENTIAL_KEYS[number];

/** Reserved name: the pre-existing behavior (~/.claude-mem/.env + CLAUDE_MEM_MODEL). */
export const DEFAULT_PROFILE_NAME = 'default';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface ProviderProfileRule {
  /** Glob (same syntax as CLAUDE_MEM_EXCLUDED_PROJECTS), tested against the session cwd or project name. */
  match: string;
  /** Profile name; backed by ~/.claude-mem/env.d/<name>.env, or the reserved `default`. */
  profile: string;
}

/**
 * A resolved profile. A profile file with no credential keys is valid and means
 * "no gateway/API key": the subprocess falls through to Claude Code OAuth.
 * `model` replaces CLAUDE_MEM_MODEL for sessions on this profile, because the
 * same model is often spelled differently per provider (gateway vs. direct).
 */
export interface ResolvedProviderProfile {
  name: string;
  credentials: Partial<Record<CredentialKey, string>>;
  model?: string;
}

export type ProfileResolution =
  | { kind: 'none' }                                   // no rule matched, or rule says `default`
  | { kind: 'profile'; profile: ResolvedProviderProfile }
  | { kind: 'unresolved'; name: string; reason: string }; // rule matched but the profile can't be used

export function profileEnvFilePath(name: string): string {
  return join(paths.dataDir(), 'env.d', `${name}.env`);
}

export function parseProviderProfileRules(raw: string | undefined): ProviderProfileRule[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    logger.warn('ENV', 'CLAUDE_MEM_PROVIDER_PROFILES is not valid JSON; ignoring', {}, error instanceof Error ? error : new Error(String(error)));
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn('ENV', 'CLAUDE_MEM_PROVIDER_PROFILES must be a JSON array; ignoring');
    return [];
  }
  const rules: ProviderProfileRule[] = [];
  for (const entry of parsed) {
    if (
      entry && typeof entry === 'object' &&
      typeof (entry as ProviderProfileRule).match === 'string' && (entry as ProviderProfileRule).match.trim() &&
      typeof (entry as ProviderProfileRule).profile === 'string' && (entry as ProviderProfileRule).profile.trim()
    ) {
      rules.push({ match: (entry as ProviderProfileRule).match.trim(), profile: (entry as ProviderProfileRule).profile.trim() });
    } else {
      logger.warn('ENV', 'Skipping malformed CLAUDE_MEM_PROVIDER_PROFILES entry', { entry: JSON.stringify(entry) });
    }
  }
  return rules;
}

/** First rule whose glob matches the cwd (preferred) or, failing that, the project name. */
export function matchProviderProfileRule(
  rules: ProviderProfileRule[],
  target: { cwd?: string; project?: string },
): ProviderProfileRule | null {
  const subject = target.cwd?.trim() || target.project?.trim();
  if (!subject) return null;
  for (const rule of rules) {
    if (matchesAnyGlob(subject, [rule.match])) return rule;
  }
  return null;
}

function loadProfileFile(name: string): ProfileResolution {
  if (!PROFILE_NAME_RE.test(name)) {
    return { kind: 'unresolved', name, reason: 'invalid profile name (use letters, digits, - and _)' };
  }
  const file = profileEnvFilePath(name);
  if (!existsSync(file)) {
    return { kind: 'unresolved', name, reason: `profile file not found: ${file}` };
  }
  try {
    const parsed = parseEnv(readFileSync(file, 'utf-8')) as Record<string, string>;
    const credentials: ResolvedProviderProfile['credentials'] = {};
    for (const key of CREDENTIAL_KEYS) {
      if (parsed[key]) credentials[key] = parsed[key];
    }
    const model = parsed.CLAUDE_MEM_MODEL?.trim() || undefined;
    return { kind: 'profile', profile: { name, credentials, model } };
  } catch (error: unknown) {
    return { kind: 'unresolved', name, reason: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Pick the provider profile for a session. Fail closed: when a rule matches but
 * its profile cannot be loaded, the result is `unresolved` — callers must not
 * silently fall back to the default credentials, which would send the folder's
 * content to a provider the user explicitly routed it away from.
 */
export function resolveProviderProfile(
  rulesRaw: string | undefined,
  target: { cwd?: string; project?: string },
): ProfileResolution {
  const rule = matchProviderProfileRule(parseProviderProfileRules(rulesRaw), target);
  if (!rule || rule.profile === DEFAULT_PROFILE_NAME) return { kind: 'none' };
  return loadProfileFile(rule.profile);
}
