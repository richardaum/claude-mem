# AGENTS.md

Instructions for AI agents working with this fork.

## Installing This Fork (richardaum/claude-mem)

This fork carries per-folder provider profiles (`CLAUDE_MEM_PROVIDER_PROFILES`) and a project filter synced with the viewer URL on top of upstream (Codex support is upstream's own provider), and is installed **from this repo**, not from the official npm package. Do not use `npx claude-mem <anything>` — `npx` always resolves the name `claude-mem` against the npm registry unless this fork's CLI is globally linked, and that link breaks on every fresh clone (it points at the old clone's path). Call the built CLI directly instead (steps 4-5 below); that bypasses npx name resolution entirely, so there's nothing for it to get wrong.

**Requirements:** Node >= 20 (install via nvm), Claude Code CLI (`claude`).

```bash
# 1. Remove any official install (keeps data in ~/.claude-mem)
npx claude-mem stop
npx claude-mem uninstall

# 2. Register this fork as the `richardaum` marketplace and install the plugin
claude plugin marketplace add richardaum/claude-mem
claude plugin install claude-mem@richardaum

# 3. Install runtime deps and build the fork's CLI (bun is installed with the plugin; use it directly)
cd ~/.claude/plugins/cache/richardaum/claude-mem/<version> && ~/.bun/bin/bun install
cd ~/.claude/plugins/marketplaces/richardaum && ~/.bun/bin/bun install && ~/.bun/bin/bun run build

# 4. Register the hooks and worker service — run the built CLI directly, not through npx
node dist/npx-cli/index.js install

# 5. Start the worker and verify
node dist/npx-cli/index.js start
node dist/npx-cli/index.js doctor   # run from this repo root; dashboard at http://127.0.0.1:37701
```

Restart Claude Code afterwards so the hooks load.

**Notes**
- `install` (step 4) is what registers the plugin hooks and worker service — `claude plugin install` (step 2) only clones the marketplace source, it doesn't configure claude-mem itself. Skipping step 4 makes `start`/`doctor` fail with `claude-mem is not installed`.
- Always invoke the fork via `node dist/npx-cli/index.js <command>` from `~/.claude/plugins/marketplaces/richardaum` (built in step 3). Never `npx claude-mem <command>` — see the warning above.
- To update the fork: `git push` to `main`, then `claude plugin marketplace update richardaum`, reinstall the plugin, and re-run step 3 (`bun install && bun run build`) so `dist/npx-cli/index.js` matches the new code.
- `node dist/npx-cli/index.js doctor` should report the plugin path under `.../cache/richardaum/claude-mem/<fork version>`. A different version means something pulled the official package.
- Last synced with `thedotmack/claude-mem` upstream (`upstream` remote) at v15.2.1 on 2026-10-26. Merge upstream deliberately; expect conflicts around `EnvManager`, `ClaudeProvider` and `SessionRoutes` (per-folder provider profiles).

## Agent Rules

- Never run `npx claude-mem <anything>` here: `npx` resolves the official package and replaces the fork.
- Invoke the fork's CLI as `node dist/npx-cli/index.js <command>`.
- Build and sync from source with `npm run build-and-sync` (see `CLAUDE.md`).
