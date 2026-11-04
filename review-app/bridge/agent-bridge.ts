// Local bridge between the review app and the Codex / Claude Code command-line
// tools installed on this machine. It listens on loopback only, answers only
// requests that carry the shared token, and runs each request once with the
// contributor's own CLI login. It stores nothing.
//
//   OXYGEN_AGENT_BRIDGE_TOKEN=<secret> npm run agent-bridge
//
// The review app reads the same OXYGEN_AGENT_BRIDGE_TOKEN (and optionally
// OXYGEN_AGENT_BRIDGE_URL) and calls the bridge from its own server, so the
// browser never sees the token.
//
// The bridge also lists the contributor's local agent sessions and starts the
// pipeline runner (tools/oxygen_run.py), whose runs live under OXYGEN_HOME
// (default ~/.oxygen/runs).
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Provider = 'codex' | 'claude';
type Model = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
};
type ProviderInfo = {
  id: Provider;
  label: string;
  installed: boolean;
  signedIn: boolean;
  version: string;
  models: Model[];
};

const PORT = Number(process.env.OXYGEN_AGENT_BRIDGE_PORT || 3777);
const HOST = '127.0.0.1';
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_RUNNING = 2;
const TOKEN =
  process.env.OXYGEN_AGENT_BRIDGE_TOKEN || randomBytes(24).toString('hex');
const BINARIES: Record<Provider, string> = {
  codex: process.env.OXYGEN_CODEX_BIN || 'codex',
  claude: process.env.OXYGEN_CLAUDE_BIN || 'claude',
};
const DEVKIT = process.env.OXYGEN_DEVKIT_ROOT
  ? resolve(process.env.OXYGEN_DEVKIT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = join(DEVKIT, 'tools', 'oxygen_run.py');
const PYTHON = process.env.OXYGEN_PYTHON || 'python3';
const HOME = resolve(process.env.OXYGEN_HOME || join(homedir(), '.oxygen'));
const RUNS = join(HOME, 'runs');
const MAX_ACTIVE_RUNS = 2;
const STALE_AFTER_MS = 30_000;
const LANGUAGES = ['en', 'zh'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS: Model[] = [
  { id: 'opus', label: 'Opus', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
  {
    id: 'sonnet',
    label: 'Sonnet',
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'haiku',
    label: 'Haiku',
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'low',
  },
];

function exec(file: string, args: string[], timeout = 15000) {
  return new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }),
    );
  });
}

async function codexInfo(): Promise<ProviderInfo> {
  const bin = BINARIES.codex;
  const version = await exec(bin, ['--version'], 5000);
  const info: ProviderInfo = {
    id: 'codex',
    label: 'Codex',
    installed: version.ok,
    signedIn: false,
    version: version.stdout.trim(),
    models: [],
  };
  if (!version.ok) return info;
  info.signedIn = (await exec(bin, ['login', 'status'], 8000)).ok;
  const listed = await exec(bin, ['debug', 'models']);
  try {
    const parsed = JSON.parse(listed.stdout) as {
      models?: {
        slug: string;
        display_name?: string;
        visibility?: string;
        default_reasoning_level?: string;
        supported_reasoning_levels?: { effort: string }[];
      }[];
    };
    info.models = (parsed.models ?? [])
      .filter((model) => model.visibility === 'list')
      .map((model) => {
        const efforts = (model.supported_reasoning_levels ?? []).map(
          (level) => level.effort,
        );
        return {
          id: model.slug,
          label: model.display_name || model.slug,
          efforts,
          defaultEffort: model.default_reasoning_level || efforts[0] || 'low',
        };
      });
  } catch {
    info.models = [];
  }
  return info;
}

async function claudeInfo(): Promise<ProviderInfo> {
  const bin = BINARIES.claude;
  const version = await exec(bin, ['--version'], 5000);
  const info: ProviderInfo = {
    id: 'claude',
    label: 'Claude',
    installed: version.ok,
    signedIn: false,
    version: version.stdout.trim(),
    models: version.ok ? CLAUDE_MODELS : [],
  };
  if (!version.ok) return info;
  const status = await exec(bin, ['auth', 'status'], 8000);
  try {
    info.signedIn =
      (JSON.parse(status.stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    info.signedIn = false;
  }
  return info;
}

let cache: { at: number; providers: ProviderInfo[] } | null = null;
async function providers(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.providers;
  const list = await Promise.all([codexInfo(), claudeInfo()]);
  cache = { at: Date.now(), providers: list };
  return list;
}

// ---------------------------------------------------------------------------
// Local sessions and pipeline runs

type RunnerOutput = Record<string, unknown>;

function runner(args: string[], timeout = 120_000) {
  return new Promise<RunnerOutput>((resolveOutput, reject) => {
    execFile(
      PYTHON,
      [RUNNER, ...args],
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          let reason = String(stderr).trim().split('\n').pop() || error.message;
          try {
            reason = (JSON.parse(reason) as { error?: string }).error ?? reason;
          } catch {
            // Keep the raw line.
          }
          return reject(new Error(reason.slice(0, 300)));
        }
        try {
          resolveOutput(JSON.parse(String(stdout)) as RunnerOutput);
        } catch {
          reject(new Error('The session scanner returned unreadable output.'));
        }
      },
    );
  });
}

const scanCache = new Map<string, { at: number; value: RunnerOutput }>();
async function scanned(key: string, args: string[], maxAge: number) {
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.value;
  const value = await runner(args);
  scanCache.set(key, { at: Date.now(), value });
  return value;
}

const RUN_ID = /^[0-9A-Za-z-]{8,64}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type RunState = {
  id?: string;
  phase: string;
  pid?: number;
  heartbeat?: number;
  workspace?: string;
  workspaceName?: string;
  language?: string;
  host?: string;
  model?: string;
  createdAt?: string;
  finishedAt?: string | null;
  trajectories?: { index: number; status: string }[];
};

function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The runner's state, with a run whose process disappeared marked interrupted. */
async function runState(id: string) {
  const directory = join(RUNS, id);
  const config = await readJson<Record<string, unknown>>(
    join(directory, 'config.json'),
  );
  if (!config) return null;
  const state: RunState = (await readJson<RunState>(
    join(directory, 'state.json'),
  )) ?? { ...(config as RunState), phase: 'starting', trajectories: [] };
  const active = ['starting', 'preparing', 'generating'].includes(state.phase);
  if (
    active &&
    state.phase !== 'starting' &&
    Date.now() - (state.heartbeat ?? 0) * 1000 > STALE_AFTER_MS &&
    !alive(state.pid)
  ) {
    state.phase = 'interrupted';
    for (const item of state.trajectories ?? []) {
      if (['queued', 'converting', 'running'].includes(item.status)) {
        item.status = 'interrupted';
      }
    }
  }
  const imports =
    (await readJson<Record<string, Record<string, string>>>(
      join(directory, 'imports.json'),
    )) ?? {};
  return { ...state, imports };
}

async function listRuns() {
  let names: string[] = [];
  try {
    names = await readdir(RUNS);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names.filter((item) => RUN_ID.test(item))) {
    const state = await runState(name);
    if (!state) continue;
    const trajectories = state.trajectories ?? [];
    runs.push({
      id: state.id,
      workspace: state.workspace,
      workspaceName: state.workspaceName ?? state.workspace,
      phase: state.phase,
      language: state.language,
      host: state.host,
      model: state.model,
      createdAt: state.createdAt,
      finishedAt: state.finishedAt ?? null,
      imports: state.imports,
      total: trajectories.length,
      done: trajectories.filter((item) => item.status === 'done').length,
      failed: trajectories.filter((item) =>
        ['failed', 'skipped'].includes(item.status),
      ).length,
    });
  }
  return runs.sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
}

async function activeRuns() {
  return (await listRuns()).filter((run) =>
    ['starting', 'preparing', 'generating'].includes(String(run.phase)),
  ).length;
}

type StartRequest = {
  workspace: string;
  language: string;
  provider: Provider;
  model: string;
  effort: string;
  concurrency: number;
  sessions: { source: Provider; id: string }[];
};

function parseStart(body: unknown): StartRequest {
  const value = body as Partial<StartRequest> | null;
  const bad = () => new Error('The run request is incomplete.');
  if (!value || typeof value !== 'object') throw bad();
  if (
    typeof value.workspace !== 'string' ||
    !isAbsolute(value.workspace) ||
    value.workspace.includes('\0')
  )
    throw bad();
  if (!value.language || !LANGUAGES.includes(value.language)) throw bad();
  if (value.provider !== 'codex' && value.provider !== 'claude') throw bad();
  if (typeof value.model !== 'string' || typeof value.effort !== 'string')
    throw bad();
  const sessions = value.sessions;
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 100)
    throw bad();
  const seen = new Set<string>();
  for (const item of sessions) {
    if (
      !item ||
      (item.source !== 'codex' && item.source !== 'claude') ||
      typeof item.id !== 'string' ||
      !SESSION_ID.test(item.id) ||
      seen.has(`${item.source}:${item.id}`)
    )
      throw bad();
    seen.add(`${item.source}:${item.id}`);
  }
  const concurrency = Number.isInteger(value.concurrency)
    ? Math.min(4, Math.max(1, value.concurrency as number))
    : 3;
  return {
    workspace: value.workspace,
    language: value.language,
    provider: value.provider,
    model: value.model,
    effort: value.effort,
    concurrency,
    sessions: sessions.map((item) => ({ source: item.source, id: item.id })),
  };
}

async function startRun(request: StartRequest) {
  const provider = (await providers()).find(
    (item) => item.id === request.provider,
  );
  if (!provider?.installed || !provider.signedIn) {
    throw new Error(`${request.provider} is not installed or not signed in.`);
  }
  const model = provider.models.find((item) => item.id === request.model);
  if (!model || !model.efforts.includes(request.effort)) {
    throw new Error('That model or effort is not available.');
  }
  if ((await activeRuns()) >= MAX_ACTIVE_RUNS) {
    throw new Error('Two runs are already in progress.');
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
  const id = `${stamp}-${randomBytes(3).toString('hex')}`;
  const directory = join(RUNS, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      id,
      workspace: request.workspace,
      language: request.language,
      host: request.provider,
      model: request.model,
      effort: request.effort,
      concurrency: request.concurrency,
      sessions: request.sessions,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const log = openSync(join(directory, 'runner.log'), 'a', 0o600);
  try {
    const child = spawn(PYTHON, [RUNNER, 'run', '--run-dir', directory], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(log);
  }
  return id;
}

async function cancelRun(id: string) {
  const state = await runState(id);
  if (!state) return false;
  if (state.pid && alive(state.pid)) process.kill(state.pid, 'SIGTERM');
  return true;
}

async function reviewPayloads(id: string, index: number) {
  const state = await runState(id);
  const item = state?.trajectories?.find((entry) => entry.index === index);
  if (!state || !item) throw new Error('That trajectory does not exist.');
  if (item.status !== 'done') throw new Error('That trajectory is not ready.');
  return runner([
    'payloads',
    '--run-dir',
    join(RUNS, id),
    '--index',
    String(index),
  ]);
}

async function recordImport(id: string, index: number, reviews: unknown) {
  const state = await runState(id);
  const item = state?.trajectories?.find((entry) => entry.index === index);
  if (!state || !item || item.status !== 'done') {
    throw new Error('That trajectory is not ready.');
  }
  const value = reviews as Record<string, unknown> | null;
  const clean: Record<string, string> = {};
  for (const stage of ['redaction', 'humanize']) {
    const reviewId = value?.[stage];
    if (
      typeof reviewId !== 'string' ||
      !/^[0-9A-Za-z_-]{1,128}$/.test(reviewId)
    )
      throw new Error('The review ids are not valid.');
    clean[stage] = reviewId;
  }
  const path = join(RUNS, id, 'imports.json');
  const imports = (await readJson<Record<string, unknown>>(path)) ?? {};
  imports[String(index)] = clean;
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(imports), { mode: 0o600 });
  await rename(temporary, path);
}

type RunRequest = {
  provider: Provider;
  model: string;
  effort: string;
  prompt: string;
  schema: unknown;
};

function run(
  file: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(file, args, { cwd, env, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const stop = () => child.kill('SIGTERM');
      const timer = setTimeout(stop, TIMEOUT_MS);
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    },
  );
}

function tail(text: string) {
  return text.trim().split('\n').slice(-4).join(' ').slice(0, 400);
}

async function runAgent(request: RunRequest, signal: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), 'oxygen-agent-'));
  try {
    const schemaPath = join(dir, 'schema.json');
    await writeFile(schemaPath, JSON.stringify(request.schema));
    if (request.provider === 'codex') {
      const outputPath = join(dir, 'output.json');
      const result = await run(
        BINARIES.codex,
        [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '--ignore-rules',
          '--sandbox',
          'read-only',
          '--model',
          request.model,
          '-c',
          `model_reasoning_effort=${JSON.stringify(request.effort)}`,
          '--output-schema',
          schemaPath,
          '-o',
          outputPath,
          '-C',
          dir,
          '-',
        ],
        request.prompt,
        process.env,
        dir,
        signal,
      );
      if (result.code !== 0) {
        throw new Error(`Codex stopped: ${tail(result.stderr) || result.code}`);
      }
      return JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    }
    const result = await run(
      BINARIES.claude,
      [
        '-p',
        '--model',
        request.model,
        '--effort',
        request.effort,
        '--no-session-persistence',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(request.schema),
        '--tools',
        '',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--no-chrome',
      ],
      request.prompt,
      {
        ...process.env,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      dir,
      signal,
    );
    if (result.code !== 0) {
      throw new Error(
        `Claude stopped: ${tail(result.stderr || result.stdout) || result.code}`,
      );
    }
    const envelope = JSON.parse(result.stdout) as {
      structured_output?: unknown;
      result?: unknown;
      is_error?: boolean;
    };
    if (envelope.is_error) {
      throw new Error(
        `Claude stopped: ${String(envelope.result).slice(0, 400)}`,
      );
    }
    if (envelope.structured_output) return envelope.structured_output;
    return JSON.parse(String(envelope.result)) as unknown;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function validate(request: unknown): Promise<RunRequest> {
  const body = request as Partial<RunRequest> | null;
  if (
    !body ||
    (body.provider !== 'codex' && body.provider !== 'claude') ||
    typeof body.model !== 'string' ||
    typeof body.effort !== 'string' ||
    typeof body.prompt !== 'string' ||
    !body.prompt.trim() ||
    typeof body.schema !== 'object' ||
    body.schema === null
  ) {
    throw new Error('The request is incomplete.');
  }
  const provider = (await providers()).find(
    (item) => item.id === body.provider,
  );
  if (!provider?.installed || !provider.signedIn) {
    throw new Error(`${body.provider} is not installed or not signed in.`);
  }
  const model = provider.models.find((item) => item.id === body.model);
  if (!model || !model.efforts.includes(body.effort)) {
    throw new Error('That model or effort is not available.');
  }
  return body as RunRequest;
}

function authorized(header: string | undefined) {
  const given = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(request: import('node:http').IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('The request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

let running = 0;

const server = createServer((request, response) => {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  };
  void (async () => {
    // Browsers send Origin; only the app's own server should be calling.
    const allowedHosts = [`${HOST}:${PORT}`, `localhost:${PORT}`];
    if (
      request.headers.origin ||
      !allowedHosts.includes(request.headers.host ?? '')
    ) {
      return send(403, { error: 'Forbidden.' });
    }
    if (!authorized(request.headers.authorization)) {
      return send(401, { error: 'Unauthorized.' });
    }
    try {
      const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
      const path = url.pathname;
      const method = request.method;
      if (method === 'GET' && path === '/capabilities') {
        return send(200, { providers: await providers(true) });
      }
      if (method === 'GET' && path === '/workspaces') {
        return send(200, await scanned('workspaces', ['workspaces'], 20_000));
      }
      if (method === 'GET' && path === '/sessions') {
        const workspace = url.searchParams.get('workspace') ?? '';
        if (!isAbsolute(workspace) || workspace.includes('\0')) {
          return send(400, { error: 'A workspace path is required.' });
        }
        return send(
          200,
          await scanned(
            `sessions:${workspace}`,
            ['sessions', '--workspace', workspace],
            10_000,
          ),
        );
      }
      if (method === 'GET' && path === '/runs') {
        return send(200, { runs: await listRuns() });
      }
      if (method === 'POST' && path === '/runs') {
        const id = await startRun(
          parseStart(JSON.parse(await readBody(request))),
        );
        return send(201, { id });
      }
      const match =
        /^\/runs\/([^/]+)(?:\/(cancel)|\/trajectories\/(\d{1,3})\/(payloads|imported))?$/.exec(
          path,
        );
      if (match && RUN_ID.test(match[1])) {
        const [, id, cancel, number, action] = match;
        if (method === 'GET' && !cancel && !action) {
          const state = await runState(id);
          return state ? send(200, state) : send(404, { error: 'Not found.' });
        }
        if (method === 'POST' && cancel) {
          return (await cancelRun(id))
            ? send(200, { ok: true })
            : send(404, { error: 'Not found.' });
        }
        if (method === 'GET' && action === 'payloads') {
          return send(200, await reviewPayloads(id, Number(number)));
        }
        if (method === 'POST' && action === 'imported') {
          await recordImport(
            id,
            Number(number),
            JSON.parse(await readBody(request)),
          );
          return send(200, { ok: true });
        }
      }
      if (method === 'POST' && path === '/run') {
        const body = await validate(JSON.parse(await readBody(request)));
        if (running >= MAX_RUNNING) {
          return send(429, { error: 'Two requests are already running.' });
        }
        running += 1;
        const abort = new AbortController();
        response.on('close', () => abort.abort());
        try {
          return send(200, { output: await runAgent(body, abort.signal) });
        } finally {
          running -= 1;
        }
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      return send(500, {
        error: error instanceof Error ? error.message : 'The request failed.',
      });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Oxygen agent bridge listening on http://${HOST}:${PORT}`);
  console.log(`Runs are stored in ${RUNS}`);
  if (!process.env.OXYGEN_AGENT_BRIDGE_TOKEN) {
    console.log(
      `Token for this session (set OXYGEN_AGENT_BRIDGE_TOKEN to the same value for the app): ${TOKEN}`,
    );
  }
});
