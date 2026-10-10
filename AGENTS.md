# AGENTS.md

Instructions for AI agents working with this fork.

## Installing This Fork (richardaum/claude-mem)

This fork carries the Codex provider work (`feat/codex-provider-v13.25.1`, merged into `main`) and is installed **from this repo**, not from the official npm package. Do not use `npx claude-mem install`, `npx claude-mem update` or `npx claude-mem repair`: they pull the official package and overwrite the fork.

**Requirements:** Node >= 20 (install via nvm), Claude Code CLI (`claude`).

```bash
# 1. Remove any official install (keeps data in ~/.claude-mem)
npx claude-mem stop
npx claude-mem uninstall

# 2. Register this fork as the `thedotmack` marketplace and install the plugin
claude plugin marketplace add richardaum/claude-mem
claude plugin install claude-mem@thedotmack

# 3. Install runtime deps (bun is installed with the plugin; use it directly)
cd ~/.claude/plugins/cache/thedotmack/claude-mem/<version> && ~/.bun/bin/bun install
cd ~/.claude/plugins/marketplaces/thedotmack && ~/.bun/bin/bun install

# 4. Start the worker and verify
npx claude-mem start
npx claude-mem doctor   # run from outside the repo; dashboard at http://127.0.0.1:37701
```

Restart Claude Code afterwards so the hooks load.

**Notes**
- Run `npx` commands from a directory outside this repo; inside it, `npx` resolves the unbuilt local package and fails with `claude-mem: command not found`.
- To update the fork: `git push` to `main`, then `claude plugin marketplace update thedotmack`, reinstall the plugin and re-run step 3.
- `npx claude-mem doctor` should report the plugin path under `.../cache/thedotmack/claude-mem/<fork version>`. A different version means the official package was installed.
- This fork is behind `thedotmack/claude-mem` upstream (`upstream` remote). Merge upstream deliberately; expect conflicts around the Codex provider.

## Agent Rules

- Never run `npx claude-mem install|update|repair` here: it replaces the fork with the official package.
- Build and sync from source with `npm run build-and-sync` (see `CLAUDE.md`).
- Run `npx claude-mem ...` from outside the repo.
