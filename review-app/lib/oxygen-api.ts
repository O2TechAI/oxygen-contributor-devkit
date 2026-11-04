export type SourceKind = 'codex' | 'claude';
export type RunLanguage = 'en' | 'zh';
export type Stage = 'summary' | 'insight' | 'humanize' | 'redaction';
export type TrajectoryStatus =
  | 'queued'
  | 'converting'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'interrupted';
export type RunPhase =
  | 'starting'
  | 'preparing'
  | 'generating'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type Workspace = {
  path: string;
  name: string;
  exists: boolean;
  sessions: Record<SourceKind, number>;
  lastActivity: string;
  bytes: number;
};

export type SessionInfo = {
  source: SourceKind;
  id: string;
  started: string;
  bytes: number;
  title: string;
  suggested: boolean;
};

export type TrajectoryState = {
  index: number;
  source: SourceKind;
  sessionId: string;
  startedAt: string;
  title: string;
  bytes: number;
  status: TrajectoryStatus;
  stage: Stage | null;
  stagesDone: Stage[];
  stageSeconds: Partial<Record<Stage, number>>;
  stageStartedAt: string | null;
  startedRunAt: string | null;
  finishedAt: string | null;
  error: string | null;
  markdownBytes?: number;
  insights?: number;
  summaryLines?: number;
};

export type Imported = { redaction: string; humanize: string };

export type RunDetail = {
  id: string;
  workspace: string;
  workspaceName: string;
  language: RunLanguage;
  host: SourceKind;
  model: string;
  effort: string;
  createdAt: string;
  startedAt?: string;
  finishedAt: string | null;
  phase: RunPhase;
  error: string | null;
  trajectories: TrajectoryState[];
  imports: Record<string, Imported>;
};

export type RunListItem = {
  id: string;
  workspace: string;
  workspaceName: string;
  phase: RunPhase;
  language: RunLanguage;
  host: SourceKind;
  model: string;
  createdAt: string;
  finishedAt: string | null;
  imports: Record<string, Imported>;
  total: number;
  done: number;
  failed: number;
};

export class ApiError extends Error {
  status: number;
  reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** Call the app's own API; failures carry the server's message. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string; reason?: string })
    | null;
  if (!response.ok || !body) {
    throw new ApiError(
      body?.error || 'The request failed.',
      response.status,
      body?.reason,
    );
  }
  return body;
}

export function postJson<T>(url: string, body: unknown) {
  return api<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
