#!/usr/bin/env node
// Start Oxygen on this computer: the review app and the local service that finds your
// agent sessions and runs Codex / Claude Code on them. Both listen on 127.0.0.1 only.
//
//   ./oxygen                 from the toolkit folder (or: npm run oxygen in review-app/)
//   ./oxygen --no-open       do not open the browser
//   OXYGEN_PORT=4000         choose the app's port (default 3000, next free port if busy)
//   OXYGEN_HOME=~/.oxygen    where runs and the review database are kept
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolve(process.env.OXYGEN_HOME || join(homedir(), '.oxygen'));
const open = !process.argv.includes('--no-open');

function fail(message) {
  console.error(`oxygen: ${message}`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(
    `Node.js 22.13 or newer is required (this is ${process.versions.node}).`,
  );
}
const candidates = process.env.OXYGEN_PYTHON
  ? [process.env.OXYGEN_PYTHON]
  : process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3', 'python'];
const python = candidates.find(
  (candidate) =>
    spawnSync(
      candidate,
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
      { stdio: 'ignore', timeout: 5000, windowsHide: true },
    ).status === 0,
);
if (!python)
  fail(
    'Python 3.10 or newer is required. Set OXYGEN_PYTHON to its executable.',
  );

if (!existsSync(join(app, 'node_modules'))) {
  console.log('Installing dependencies (first run only)…');
  const npmCli =
    process.env.npm_execpath ||
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (process.platform === 'win32' && !existsSync(npmCli))
    fail('Run npm ci with Node.js 22.13+ before starting Oxygen.');
  const install = spawnSync(
    process.platform === 'win32' ? process.execPath : 'npm',
    process.platform === 'win32' ? [npmCli, 'ci'] : ['ci'],
    { cwd: app, stdio: 'inherit', windowsHide: true },
  );
  if (install.status !== 0) fail('npm ci failed.');
}

function free(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

async function pick(start) {
  for (let port = start; port < start + 50; port += 1) {
    if (await free(port)) return port;
  }
  return fail(`No free port found from ${start}.`);
}

mkdirSync(home, { recursive: true, mode: 0o700 });
const appPort = await pick(Number(process.env.OXYGEN_PORT) || 3000);
const bridgePort = await pick(
  Number(process.env.OXYGEN_AGENT_BRIDGE_PORT) || 3777,
);
const token = randomBytes(24).toString('hex');
const environment = {
  ...process.env,
  OXYGEN_HOME: home,
  OXYGEN_PYTHON: python,
  PYTHONUTF8: '1',
  OXYGEN_REVIEW_DB:
    process.env.OXYGEN_REVIEW_DB || join(home, 'reviews.sqlite'),
  OXYGEN_AGENT_BRIDGE_TOKEN: token,
  OXYGEN_AGENT_BRIDGE_PORT: String(bridgePort),
  OXYGEN_AGENT_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
  PYTHONDONTWRITEBYTECODE: '1',
};

const children = [
  spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'bridge/agent-bridge.ts'],
    {
      cwd: app,
      env: environment,
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    },
  ),
  spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--config',
      'vite.node.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(appPort),
      '--strictPort',
    ],
    {
      cwd: app,
      env: environment,
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    },
  ),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping) {
      console.error('oxygen: a component stopped unexpectedly.');
      stop(code ?? 1);
    }
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const url = `http://127.0.0.1:${appPort}/`;
for (let attempt = 0; attempt < 120 && !stopping; attempt += 1) {
  try {
    const response = await fetch(`${url}api/auth/session`);
    if (response.ok) break;
  } catch {
    // Still starting.
  }
  await new Promise((wait) => setTimeout(wait, 500));
}
if (stopping) process.exit(1);

console.log(`Oxygen is running at ${url}`);
console.log(`Runs and reviews are kept in ${home}. Press Ctrl+C to stop.`);
if (open) {
  const opener = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] }[
    process.platform
  ] ?? ['xdg-open'];
  const launched = spawn(opener[0], [...opener.slice(1), url], {
    stdio: 'ignore',
    detached: true,
  });
  launched.on('error', () => undefined);
  launched.unref();
}
