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
// (default ~/.oxygen/runs). Submissions (frozen copies of the reviews a
// contributor chose to hand in) and their cross-session insight jobs live under
// OXYGEN_HOME/submissions.
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
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
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
const SUBMISSIONS = join(HOME, 'submissions');
/** Runs and insight jobs together: each starts model workers. */
const MAX_ACTIVE_RUNS = 2;
const MAX_SUBMISSION_BODY = 64 * 1024 * 1024;
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
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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
        windowsHide: true,
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
  effort?: string;
  createdAt?: string;
  finishedAt?: string | null;
  trajectories?: {
    index: number;
    status: string;
    source?: string;
    sessionId?: string;
    startedAt?: string;
    title?: string;
    name?: string;
  }[];
};

const ACTIVE_PHASES = ['starting', 'preparing', 'generating'];

/** Mark a run or job whose process stopped beating and disappeared as interrupted. */
function withLiveness<
  T extends { phase: string; pid?: number; heartbeat?: number },
>(state: T) {
  if (
    ACTIVE_PHASES.includes(state.phase) &&
    state.phase !== 'starting' &&
    Date.now() - (state.heartbeat ?? 0) * 1000 > STALE_AFTER_MS &&
    !alive(state.pid)
  ) {
    state.phase = 'interrupted';
  }
  return state;
}

function newId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** An error the caller caused; answered with its status instead of 500. */
class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

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
  if (withLiveness(state).phase === 'interrupted') {
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

// The agents' own session titles (Codex thread names, Claude Code titles) can change,
// so they are looked up live and kept for a few minutes.
const NAME_TTL_MS = 5 * 60 * 1000;
const sessionNames = new Map<string, { at: number; name: string }>();

let refreshing: Promise<void> | null = null;

/**
 * Names for the given sessions. Stale ones are looked up, but the run list never
 * waits more than a few seconds for that: it answers with what is known (the
 * run's snapshot fills the gaps) and the lookup finishes in the background.
 */
async function lookupNames(keys: string[]) {
  const stale = [...new Set(keys)].filter((key) => {
    const hit = sessionNames.get(key);
    return !hit || Date.now() - hit.at > NAME_TTL_MS;
  });
  if (stale.length && !refreshing) {
    refreshing = runner([
      'session-names',
      ...stale.flatMap((key) => ['--session', key]),
    ])
      .then((output) => {
        const names = (output as { names?: Record<string, string> }).names;
        for (const key of stale)
          sessionNames.set(key, { at: Date.now(), name: names?.[key] ?? '' });
      })
      .catch(() => {
        // Keep earlier names; the run's own snapshot is the fallback.
      })
      .finally(() => {
        refreshing = null;
      });
  }
  if (refreshing)
    await Promise.race([
      refreshing,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  return (key: string) => sessionNames.get(key)?.name ?? '';
}

async function listRuns({ names = false }: { names?: boolean } = {}) {
  let runNames: string[] = [];
  try {
    runNames = await readdir(RUNS);
  } catch {
    return [];
  }
  const states = [];
  for (const name of runNames.filter((item) => RUN_ID.test(item))) {
    const state = await runState(name);
    if (state) states.push(state);
  }
  const keyOf = (item: { source?: string; sessionId?: string }) =>
    `${item.source}:${item.sessionId}`;
  const nameOf = names
    ? await lookupNames(
        states
          .flatMap((state) => state.trajectories ?? [])
          .filter(
            (item) =>
              (item.source === 'codex' || item.source === 'claude') &&
              SESSION_ID.test(item.sessionId ?? ''),
          )
          .map(keyOf),
      )
    : () => '';
  const runs = [];
  for (const state of states) {
    const trajectories = state.trajectories ?? [];
    runs.push({
      id: state.id,
      workspace: state.workspace,
      workspaceName: state.workspaceName ?? state.workspace,
      phase: state.phase,
      language: state.language,
      host: state.host,
      model: state.model,
      effort: state.effort,
      createdAt: state.createdAt,
      finishedAt: state.finishedAt ?? null,
      imports: state.imports,
      // Which session each trajectory came from, so copies across runs can be matched
      // and trajectories named by session (start time and the agent's own title).
      trajectories: trajectories.map((item) => ({
        index: item.index,
        source: item.source,
        sessionId: item.sessionId,
        startedAt: item.startedAt,
        title: item.title,
        name: nameOf(keyOf(item)) || item.name || '',
      })),
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
  const runs = (await listRuns()).filter((run) =>
    ACTIVE_PHASES.includes(String(run.phase)),
  ).length;
  const jobs = (await listSubmissions())
    .flatMap((item) => item.jobs)
    .filter((job) => ACTIVE_PHASES.includes(job.phase)).length;
  return runs + jobs;
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

/** The worker must be installed, signed in, and offer this model and effort. */
async function checkWorker(choice: {
  provider: Provider;
  model: string;
  effort: string;
}) {
  const provider = (await providers()).find(
    (item) => item.id === choice.provider,
  );
  if (!provider?.installed || !provider.signedIn) {
    throw new RequestError(
      `${choice.provider} is not installed or not signed in.`,
    );
  }
  const model = provider.models.find((item) => item.id === choice.model);
  if (!model || !model.efforts.includes(choice.effort)) {
    throw new RequestError('That model or effort is not available.');
  }
}

async function startRun(request: StartRequest) {
  await checkWorker(request);
  if ((await activeRuns()) >= MAX_ACTIVE_RUNS) {
    throw new Error('Two runs or insight jobs are already in progress.');
  }
  const id = newId();
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
      windowsHide: true,
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
  if (state.pid && alive(state.pid)) {
    if (process.platform === 'win32') {
      // Windows SIGTERM terminates Python immediately, bypassing worker cleanup.
      await writeFile(join(RUNS, id, 'cancel.request'), '', { mode: 0o600 });
    } else {
      process.kill(state.pid, 'SIGTERM');
    }
  }
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

// ---------------------------------------------------------------------------
// Submissions and cross-session insight jobs
//
// submissions/<id>/
//   submission.json         what was submitted (no session titles or paths)
//   export/                 the collection layout the cross-session helper reads
//   history/<review>/       edit history and agent requests, when included
//   generations/<job>/      config.json, state.json, run/, logs/, runner.log, imported.json

const REVIEW_FILES = [
  'summary.md',
  'summary_labeled.md',
  'insight.md',
  'insight_reviewed.md',
  'insight_declined.md',
  'review.json',
  'approval.json',
]
  .join('|')
  .replace(/\./g, '\\.');
const EXPORT_PATH = new RegExp(
  `^(?:manifest\\.json|[A-Za-z0-9_-]{1,100}/(?:trajectory-\\d{1,6}|review)/(?:redacted|unredacted)-\\d{1,3}-[A-Za-z0-9_-]{1,100}/(?:${REVIEW_FILES}))$`,
);
const HISTORY_PATH = /^[A-Za-z0-9_-]{1,128}\/history\.(?:json|md)$/;
const GLOBAL_PATH = new RegExp(`^[A-Za-z0-9_-]{1,128}/(?:${REVIEW_FILES})$`);
const REVIEW_ID = /^[0-9A-Za-z_-]{1,128}$/;

type JobState = {
  id: string;
  submissionId?: string;
  phase: string;
  pid?: number;
  heartbeat?: number;
  host?: string;
  model?: string | null;
  effort?: string | null;
  createdAt?: string;
  finishedAt?: string | null;
  stage?: string | null;
  stagesDone?: string[];
  stageSeconds?: Record<string, number>;
  stageStartedAt?: string | null;
  counts?: Record<string, number> | null;
  candidateCount?: number | null;
  result?: string | null;
  error?: string | null;
  imported?: { reviewId: string; importedAt: string } | null;
};

type SubmissionRecord = {
  id: string;
  createdAt?: string;
  validation?: { counts?: { trajectories?: number } };
  [key: string]: unknown;
};

function submissionDir(id: string) {
  if (!RUN_ID.test(id)) throw new RequestError('Not found.', 404);
  return join(SUBMISSIONS, id);
}

async function writePrivate(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600, flag: 'wx' });
}

function textFiles(value: unknown, pattern: RegExp, what: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RequestError(`The ${what} files are missing.`);
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [path, text] of entries) {
    if (!pattern.test(path) || typeof text !== 'string')
      throw new RequestError(`Unexpected ${what} file: ${path.slice(0, 120)}`);
  }
  return entries as [string, string][];
}

async function createSubmission(body: unknown) {
  const value = body as {
    metadata?: Record<string, unknown>;
    files?: unknown;
    history?: unknown;
    global?: unknown;
  } | null;
  if (!value?.metadata || typeof value.metadata !== 'object')
    throw new RequestError('The submission is incomplete.');
  const files = textFiles(value.files, EXPORT_PATH, 'export');
  if (!files.some(([path]) => path === 'manifest.json'))
    throw new RequestError('The export has no manifest.');
  const history =
    value.history === undefined
      ? []
      : textFiles(value.history, HISTORY_PATH, 'history');
  // Completed global insights reviews: kept beside the export, never read as trajectories.
  const global =
    value.global === undefined
      ? []
      : textFiles(value.global, GLOBAL_PATH, 'global insights');
  const id = newId();
  const incoming = join(SUBMISSIONS, `.incoming-${id}`);
  await mkdir(SUBMISSIONS, { recursive: true, mode: 0o700 });
  await mkdir(incoming, { mode: 0o700 });
  try {
    for (const [path, text] of files)
      await writePrivate(join(incoming, 'export', path), text);
    let validation: RunnerOutput;
    try {
      validation = await runner([
        'validate-submission',
        '--dir',
        join(incoming, 'export'),
      ]);
    } catch (error) {
      throw new RequestError(
        `The submission did not pass validation: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    for (const [path, text] of history)
      await writePrivate(join(incoming, 'history', path), text);
    for (const [path, text] of global)
      await writePrivate(join(incoming, 'global', path), text);
    const { reviews, globalReviews, projects, suggestedAgent } = value.metadata;
    const submission = {
      format: 'oxygen-submission/v1',
      id,
      createdAt: new Date().toISOString(),
      reviews: Array.isArray(reviews) ? reviews : [],
      globalReviews: Array.isArray(globalReviews) ? globalReviews : [],
      projects: Array.isArray(projects) ? projects : [],
      suggestedAgent: suggestedAgent ?? null,
      historyIncluded: history.length > 0,
      validation,
    };
    await writePrivate(
      join(incoming, 'submission.json'),
      JSON.stringify(submission, null, 2),
    );
    await mkdir(join(incoming, 'generations'), { mode: 0o700 });
    await rename(incoming, join(SUBMISSIONS, id));
    return id;
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
}

async function jobState(submission: string, job: string) {
  if (!RUN_ID.test(job)) return null;
  const directory = join(submissionDir(submission), 'generations', job);
  const config = await readJson<JobState>(join(directory, 'config.json'));
  if (!config) return null;
  const state = withLiveness(
    (await readJson<JobState>(join(directory, 'state.json'))) ?? {
      ...config,
      phase: 'starting',
    },
  );
  const imported = await readJson<JobState['imported']>(
    join(directory, 'imported.json'),
  );
  return { ...state, id: job, submissionId: submission, imported };
}

async function submissionDetail(id: string) {
  const directory = submissionDir(id);
  const submission = await readJson<SubmissionRecord>(
    join(directory, 'submission.json'),
  );
  if (!submission) return null;
  let names: string[] = [];
  try {
    names = await readdir(join(directory, 'generations'));
  } catch {
    names = [];
  }
  const jobs = [];
  for (const name of names) {
    const state = await jobState(id, name);
    if (state) jobs.push(state);
  }
  jobs.sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
  return { ...submission, jobs };
}

async function listSubmissions() {
  let names: string[] = [];
  try {
    names = await readdir(SUBMISSIONS);
  } catch {
    return [];
  }
  const submissions = [];
  // `.incoming-*` folders are unfinished uploads and never match RUN_ID.
  for (const name of names.filter((item) => RUN_ID.test(item))) {
    const detail = await submissionDetail(name);
    if (detail) submissions.push(detail);
  }
  return submissions.sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
}

/** The frozen files of a submission, for the contribution download. */
async function submissionFiles(id: string) {
  const directory = submissionDir(id);
  const files: Record<string, string> = {};
  async function walk(folder: string, prefix: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else if (entry.isFile())
        files[`${prefix}${entry.name}`] = await readFile(path, 'utf8');
    }
  }
  await walk(join(directory, 'export'), '');
  try {
    await walk(join(directory, 'history'), 'history/');
  } catch {
    // No history was included.
  }
  try {
    await walk(join(directory, 'global'), 'global/');
  } catch {
    // No global insights were included.
  }
  return files;
}

async function startGeneration(id: string, body: unknown) {
  const value = body as {
    provider?: unknown;
    model?: unknown;
    effort?: unknown;
  } | null;
  if (
    (value?.provider !== 'codex' && value?.provider !== 'claude') ||
    typeof value.model !== 'string' ||
    typeof value.effort !== 'string'
  )
    throw new RequestError('Choose an agent, model and effort.');
  const choice = {
    provider: value.provider as Provider,
    model: value.model,
    effort: value.effort,
  };
  const detail = await submissionDetail(id);
  if (!detail) throw new RequestError('Not found.', 404);
  if ((detail.validation?.counts?.trajectories ?? 0) < 2)
    throw new RequestError(
      'Cross-session insights need at least two different trajectories.',
    );
  if (detail.jobs.some((job) => ACTIVE_PHASES.includes(job.phase)))
    throw new RequestError(
      'Insights are already being generated for this submission.',
      409,
    );
  await checkWorker(choice);
  if ((await activeRuns()) >= MAX_ACTIVE_RUNS)
    throw new RequestError(
      'Two runs or insight jobs are already in progress.',
      429,
    );
  const job = newId();
  const directory = join(submissionDir(id), 'generations', job);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      id: job,
      submissionId: id,
      host: choice.provider,
      model: choice.model,
      effort: choice.effort,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const log = openSync(join(directory, 'runner.log'), 'a', 0o600);
  try {
    const child = spawn(
      PYTHON,
      [RUNNER, 'cross-session', '--job-dir', directory],
      {
        windowsHide: true,
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(log);
  }
  return job;
}

async function cancelGeneration(id: string, job: string) {
  const state = await jobState(id, job);
  if (!state) return false;
  if (state.pid && alive(state.pid)) {
    if (process.platform === 'win32') {
      await writeFile(
        join(submissionDir(id), 'generations', job, 'cancel.request'),
        '',
        { mode: 0o600 },
      );
    } else process.kill(state.pid, 'SIGTERM');
  }
  return true;
}

async function generationResult(id: string, job: string) {
  const state = await jobState(id, job);
  if (!state) throw new RequestError('Not found.', 404);
  if (state.phase !== 'done' || !state.result)
    throw new RequestError('The insights are not ready.', 409);
  const directory = join(submissionDir(id), 'generations', job);
  const path = resolve(directory, state.result);
  if (!path.startsWith(directory + sep))
    throw new RequestError('The result is outside its job.', 500);
  const result = await readJson<unknown>(path);
  if (!result) throw new RequestError('The result cannot be read.', 500);
  return result;
}

async function recordGenerationImport(id: string, job: string, body: unknown) {
  const state = await jobState(id, job);
  if (!state || state.phase !== 'done')
    throw new RequestError('The insights are not ready.', 409);
  const reviewId = (body as { reviewId?: unknown } | null)?.reviewId;
  if (typeof reviewId !== 'string' || !REVIEW_ID.test(reviewId))
    throw new RequestError('The review id is not valid.');
  const path = join(submissionDir(id), 'generations', job, 'imported.json');
  const temporary = `${path}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ reviewId, importedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  await rename(temporary, path);
}

/** Uploads interrupted by a restart leave `.incoming-*` folders; nothing else uses them. */
async function removeIncoming() {
  try {
    for (const name of await readdir(SUBMISSIONS)) {
      if (name.startsWith('.incoming-'))
        await rm(join(SUBMISSIONS, name), { recursive: true, force: true });
    }
  } catch {
    // No submissions yet.
  }
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
      const child = spawn(file, args, {
        cwd,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
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

function readBody(
  request: import('node:http').IncomingMessage,
  limit = MAX_BODY,
) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
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
        return send(200, { runs: await listRuns({ names: true }) });
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
      if (method === 'GET' && path === '/submissions') {
        return send(200, { submissions: await listSubmissions() });
      }
      if (method === 'POST' && path === '/submissions') {
        const id = await createSubmission(
          JSON.parse(await readBody(request, MAX_SUBMISSION_BODY)),
        );
        return send(201, { id });
      }
      const submission =
        /^\/submissions\/([^/]+)(?:\/(files)|\/(generations)(?:\/([^/]+)\/(cancel|result|imported))?)?$/.exec(
          path,
        );
      if (submission && RUN_ID.test(submission[1])) {
        const [, id, files, generations, job, action] = submission;
        if (method === 'GET' && !files && !generations) {
          const detail = await submissionDetail(id);
          return detail
            ? send(200, detail)
            : send(404, { error: 'Not found.' });
        }
        if (method === 'GET' && files) {
          return send(200, { files: await submissionFiles(id) });
        }
        if (method === 'POST' && generations && !job) {
          const started = await startGeneration(
            id,
            JSON.parse(await readBody(request)),
          );
          return send(201, { id: started });
        }
        if (job && RUN_ID.test(job)) {
          if (method === 'POST' && action === 'cancel') {
            return (await cancelGeneration(id, job))
              ? send(200, { ok: true })
              : send(404, { error: 'Not found.' });
          }
          if (method === 'GET' && action === 'result') {
            return send(200, await generationResult(id, job));
          }
          if (method === 'POST' && action === 'imported') {
            await recordGenerationImport(
              id,
              job,
              JSON.parse(await readBody(request)),
            );
            return send(200, { ok: true });
          }
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
      return send(error instanceof RequestError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'The request failed.',
      });
    }
  })();
});

void removeIncoming();

server.listen(PORT, HOST, () => {
  console.log(`Oxygen agent bridge listening on http://${HOST}:${PORT}`);
  console.log(`Runs are stored in ${RUNS}`);
  if (!process.env.OXYGEN_AGENT_BRIDGE_TOKEN) {
    console.log(
      `Token for this session (set OXYGEN_AGENT_BRIDGE_TOKEN to the same value for the app): ${TOKEN}`,
    );
  }
});
