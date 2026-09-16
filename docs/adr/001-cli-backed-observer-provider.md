# ADR-001: Add a CLI-backed observer provider without duplicating the worker lifecycle

- Status: Accepted
- Date: 2026-09-16
- Decision owners: claude-mem-codex maintainers
- First implementation: Codex CLI

## Context

The original Codex fork was based on claude-mem 12.4.8 and implemented a 557-line `CodexAgent` that copied the provider session lifecycle. Upstream 13.25.1 had since centralized that lifecycle in `OpenAICompatibleProvider`, `SessionRoutes`, provider dispatch, quota cooldowns, observer recycling, and generator-exit handling. Keeping the copied agent would bypass fixes in those shared paths and make queue loss more likely during authentication, quota, or setup failures.

The rework rebased the fork on upstream 13.25.1 and implemented Codex as a thin provider adapter. Despite its historical name, `OpenAICompatibleProvider` is the current reusable lifecycle for non-Claude observer providers; it is not limited to HTTP transports.

This ADR describes how to repeat that integration for a future provider. It does not create a runtime-configurable arbitrary-command provider. Each new CLI must be implemented and reviewed in source code.

## Decision

A provider adapter owns only the provider-specific boundary:

1. Resolve and validate configuration.
2. Convert conversation history to the provider request format.
3. Execute the request.
4. Return normalized content and usage.
5. Convert boundary failures into `ClassifiedProviderError`.

The shared lifecycle continues to own:

- memory-session IDs;
- init, observation, continuation, summary, and Telegram prompts;
- conversation history and recycling;
- oversized-field compression;
- message claiming, confirmation, and retry behavior;
- cumulative usage;
- queue preservation on recoverable provider failures;
- generator concurrency and provider switching.

For Codex, the boundary is `CodexProvider`. It invokes `codex exec` directly with `spawn`, never through a shell.

## Invariants

Every future provider integration must preserve these invariants.

### Data continuity

- Do not change `CLAUDE_MEM_DATA_DIR` as part of a provider switch.
- The default remains `~/.claude-mem`; the SQLite database and pending state stay in place.
- Do not copy, migrate, truncate, or recreate the database merely to change providers.
- Reuse an existing synthetic memory-session ID when it has the provider prefix expected by the adapter.

### Queue continuity

- `quota_exhausted`, `rate_limit`, `auth_invalid`, and `setup_required` must pause the generator and preserve buffered work.
- Set the preserving `abortReason` before the error unwinds to `SessionRoutes`.
- `handleGeneratorExit` must recognize the resulting category and must not finalize or remove the session.
- A missing executable must fail closed as `setup_required`; dispatch must not silently fall back to another provider.

### Process safety

- Spawn an executable plus an argument array with `shell: false`.
- Do not accept an arbitrary shell command from an unauthenticated settings endpoint.
- Use a private temporary directory and remove it in `finally`.
- Apply a finite timeout and a finite output-size limit.
- Terminate the process group on abort or timeout where the platform supports it.
- Pass only an explicit environment allowlist. Never forward the worker's complete environment by default.
- Do not log prompts, tool input, tool output, stdout, stderr, tokens, or credentials.

### Error safety

- Classify raw provider output at the boundary, then expose a short sanitized message.
- Do not place raw stderr or stdout in `ClassifiedProviderError.message` or its logged cause.
- Use the shared error classes: `setup_required`, `auth_invalid`, `quota_exhausted`, `rate_limit`, `transient`, and `unrecoverable`.
- Add provider-specific codes only when the upstream protocol exposes a stable structured code.

## Codex process contract

Codex runs with the following argument policy:

```text
codex exec
  --skip-git-repo-check
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --color never
  --sandbox read-only
  -o <private-temporary-output-file>
  [-m <configured-model>]
  -
```

The complete normalized conversation is sent on stdin. The final answer is read from the output file. The model flag is omitted when `CLAUDE_MEM_CODEX_MODEL` is empty, allowing the installed Codex CLI to select its default. Authentication remains the Codex CLI's existing login state.

`--ignore-user-config` and `--ignore-rules` make observer behavior independent from repository or user instructions. `--ephemeral` avoids persisting observer conversations. `--sandbox read-only` prevents the observer subprocess from modifying the project.

The supported settings are:

| Setting | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_MEM_PROVIDER` | `claude` | Set to `codex` to select this provider. |
| `CLAUDE_MEM_CODEX_PATH` | empty | Absolute path or command name; empty resolves `codex` from `PATH`. This is filesystem/env configuration, not browser-writable. |
| `CLAUDE_MEM_CODEX_MODEL` | empty | Optional model passed with `-m`. |
| `CLAUDE_MEM_CODEX_TIMEOUT_MS` | `300000` | Per-request timeout. |
| `CLAUDE_MEM_CLI_MAX_OUTPUT_BYTES` | `1048576` | Combined stdout/stderr and final-output bound. |

## Reproduction guide for another provider

### 1. Start from current upstream architecture

1. Add the canonical upstream remote.
2. Create a backup branch at the original fork tip.
3. Rebase the feature branch onto the target upstream release.
4. Resolve conflicts in favor of current upstream lifecycle code.
5. Port only the provider-specific behavior after the rebase succeeds.

Do not resolve architectural conflicts by restoring an old copied agent wholesale.

### 2. Implement the adapter

1. Extend `OpenAICompatibleProvider<ProviderConfig>`.
2. Define `providerName`, `syntheticIdPrefix`, and `forwardEmptyMessageResponse`.
3. Implement `getConfig`, `missingApiKeyError`, `query`, `estimateTokens`, and `buildLastUsage`.
4. Keep request construction and raw error inspection inside the adapter.
5. Return `ProviderQueryResult`; do not call storage or response-processing code directly.
6. If the transport is a subprocess, apply every process-safety invariant above.

For HTTP providers, reuse the shared retry helper and respect abort signals. For CLI providers, do not add automatic retries around commands that might have completed but failed to report success; let the next safe generator start retry preserved work.

### 3. Wire the provider through closed unions

Update all of these locations together:

1. `ActiveSession.currentProvider` in `worker-types.ts`.
2. `ProviderSelection` and both selection functions in `provider-dispatch.ts`.
3. `QuotaProvider` in `quota-cooldown.ts`.
4. Provider construction and AI status in `worker-service.ts`.
5. The `SessionRoutes` constructor, Telegram formatter, selected-provider parameter types, agent selection, and display name.
6. Settings defaults and their TypeScript interface.
7. Settings validation and the safe write allowlist.
8. Viewer settings types, defaults, provider option, and provider-specific fields.

Search for the existing provider union and every `new SessionRoutes(...)` call. Constructor changes commonly break test fixtures even when production type-checks.

### 4. Preserve work for repairable setup failures

1. Classify missing binaries, missing local services, or incomplete setup as `setup_required`.
2. Map `setup_required` to a preserving abort category in the shared provider lifecycle.
3. Verify that `GeneratorExitHandler` leaves the session and message buffer alive.
4. Verify that selection returns the requested provider even when setup is broken. The adapter must surface the repair instruction; dispatch must not route the same data to an unintended provider.

### 5. Keep browser-writable configuration non-executable

`SettingsRoutes` exposes a local write endpoint without authentication. It may accept safe scalar choices such as provider, model, and timeout. It must not accept executable paths, argument arrays, shell fragments, environment-variable names, or arbitrary endpoints that turn a browser request into local code execution.

If executable configuration is necessary, require a direct settings-file or environment edit and document it explicitly.

### 6. Add focused tests

At minimum, test:

- the exact safe request/argument contract;
- the default-model case;
- every error-classification branch;
- redaction of raw provider output;
- provider selection and provider switching;
- Telegram formatting through the provider;
- settings defaults and validation;
- queue preservation for auth, quota, rate-limit, and setup failures;
- missing dependency behavior with no silent fallback.

Update all `SessionRoutes` fixtures after adding a constructor dependency.

### 7. Build and validate

Run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint:spawn-env
bun test tests
bun run build
git diff --check
```

The repository tracks the worker and viewer bundles used by local installs. Review generated changes and keep only artifacts affected by the provider integration. Do not commit incidental sourcemaps or unrelated bundle churn.

### 8. Roll out without moving data

1. Stop the current worker cleanly so in-memory claims return to a recoverable state.
2. Back up `~/.claude-mem` as a rollback precaution; do not restore or transform it during the normal switch.
3. Build the new clone.
4. Point the local marketplace/plugin installation at the clone using the repository's sync/install workflow.
5. Keep the existing settings file and data directory.
6. Set `CLAUDE_MEM_PROVIDER` to the new provider only after its authentication/setup preflight succeeds.
7. Start the worker and verify health, provider status, queue depth, one new observation, and one summary.
8. Confirm that pre-existing prompts, observations, summaries, and pending work remain visible.

Rollback is the reverse code switch: stop the worker, point the plugin back to the prior installation, restore the prior provider setting, and restart. The database does not need to roll back because the provider adapter does not change its schema.

## Consequences

### Positive

- Codex inherits current upstream queue, recycle, compression, and telemetry fixes.
- Provider failures no longer expose raw CLI output in logs.
- The observer cannot modify the project through its Codex sandbox.
- Switching providers does not require a database migration.
- Future integrations have a repeatable checklist instead of copying an entire agent.

### Trade-offs

- Each CLI provider requires source code and review; arbitrary commands are intentionally unsupported.
- Codex performs one ephemeral CLI execution per provider query, so startup latency is higher than a persistent HTTP session.
- Token usage is estimated from characters because the CLI output contract does not currently provide structured usage.
- Authentication health is learned at request time from the Codex CLI rather than from a separate account API.

## Rejected alternatives

### Keep the old `CodexAgent`

Rejected because it duplicated session, queue, prompt, token, and error logic from an obsolete upstream version.

### Implement a browser-configurable custom command provider

Rejected because the local settings write endpoint is unauthenticated. Allowing it to set an executable or shell command would create a local code-execution boundary reachable from browser content.

### Fall back to Claude when Codex is unavailable

Rejected because silent provider fallback changes the data-egress and billing destination and can consume queued work under an unintended account. The system fails closed and preserves the queue instead.
