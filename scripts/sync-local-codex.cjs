#!/usr/bin/env node

const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_SELECTOR = 'claude-mem@claude-mem-local';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const HEALTH_TIMEOUT_MS = 5_000;

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
}

function readPluginVersion() {
  const manifestPath = path.join(__dirname, '..', 'plugin', '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`Plugin version is missing from ${manifestPath}`);
  }
  return manifest.version;
}

function resolveWorkerPort() {
  const configured = Number.parseInt(process.env.CLAUDE_MEM_WORKER_PORT ?? '', 10);
  if (Number.isInteger(configured) && configured > 0 && configured <= 65535) {
    return configured;
  }
  return 37700 + ((process.getuid?.() ?? 77) % 100);
}

async function readProcessingStatus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/processing-status`, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Worker status returned HTTP ${response.status}`);
  }
  return response.json();
}

function canRestart(status) {
  return status?.queueDepth === 0 && status?.isProcessing === false;
}

async function main() {
  const noRestart = process.argv.includes('--no-restart');
  const npmRegistry = process.env.CLAUDE_MEM_LOCAL_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;

  console.log('\nSyncing the local marketplace and Claude cache...');
  run('npm', ['run', 'sync-marketplace:force'], {
    env: {
      ...process.env,
      NPM_CONFIG_REGISTRY: npmRegistry,
    },
  });

  console.log('\nRefreshing the Codex plugin cache...');
  run('codex', ['plugin', 'add', PLUGIN_SELECTOR, '--json']);

  if (noRestart) {
    console.log('\nSync complete. Worker restart skipped by --no-restart.');
    return;
  }

  const port = resolveWorkerPort();
  let status;
  try {
    status = await readProcessingStatus(port);
  } catch (error) {
    console.warn(`\nSync complete, but worker status could not be verified on port ${port}.`);
    console.warn('Worker restart was skipped to avoid losing in-memory work.');
    console.warn(error instanceof Error ? error.message : String(error));
    return;
  }

  if (!canRestart(status)) {
    console.warn(`\nSync complete. Worker restart skipped: queueDepth=${status.queueDepth}, isProcessing=${status.isProcessing}.`);
    console.warn('Run this command again after the queue drains, or use --no-restart when only refreshing caches.');
    return;
  }

  const version = readPluginVersion();
  const workerPath = path.join(
    os.homedir(),
    '.codex',
    'plugins',
    'cache',
    'claude-mem-local',
    'claude-mem',
    version,
    'scripts',
    'worker-service.cjs',
  );

  console.log('\nQueue is empty. Restarting the worker with the refreshed plugin...');
  run('bun', [workerPath, 'restart']);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nLocal Codex sync failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  canRestart,
  readPluginVersion,
  resolveWorkerPort,
};
