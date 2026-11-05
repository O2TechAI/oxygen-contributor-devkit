import type {
  InsightJob,
  InsightStage,
  RunPhase,
  Stage,
  TrajectoryState,
  TrajectoryStatus,
} from './oxygen-api.ts';

export const STAGES: Stage[] = ['summary', 'insight', 'humanize', 'redaction'];

export const STAGE_LABELS: Record<Stage, string> = {
  summary: 'Summary',
  insight: 'Insights',
  humanize: 'Readability',
  redaction: 'Privacy',
};

export function isActivePhase(phase: RunPhase) {
  return (
    phase === 'starting' || phase === 'preparing' || phase === 'generating'
  );
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (total < 3600)
    return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()) {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${name}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function formatDate(iso: string) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function runCounts(trajectories: TrajectoryState[]) {
  const count = (...statuses: TrajectoryStatus[]) =>
    trajectories.filter((item) => statuses.includes(item.status)).length;
  return {
    total: trajectories.length,
    done: count('done'),
    failed: count('failed', 'skipped', 'interrupted'),
    running: count('running', 'converting'),
    waiting: count('queued'),
  };
}

/** Finished stages out of all stages of all trajectories, from 0 to 1. */
export function runFraction(trajectories: TrajectoryState[]) {
  if (!trajectories.length) return 0;
  const finished = trajectories.reduce(
    (sum, item) =>
      sum + (item.status === 'done' ? STAGES.length : item.stagesDone.length),
    0,
  );
  return finished / (trajectories.length * STAGES.length);
}

/** Average time a finished trajectory took, or null before the first one ends. */
export function averageSeconds(trajectories: TrajectoryState[]) {
  const times = trajectories
    .filter((item) => item.status === 'done')
    .map((item) =>
      Object.values(item.stageSeconds).reduce((sum, value) => sum + value, 0),
    );
  return times.length
    ? times.reduce((sum, value) => sum + value, 0) / times.length
    : null;
}

export type StepState = 'done' | 'active' | 'waiting' | 'failed';

export function stepState(item: TrajectoryState, stage: Stage): StepState {
  if (item.stagesDone.includes(stage)) return 'done';
  if (item.status === 'running' && item.stage === stage) return 'active';
  if (item.status === 'failed' && item.stage === stage) return 'failed';
  return 'waiting';
}

const REASONS: [RegExp, string][] = [
  [/transcript_larger_than_2mb/, 'The transcript is larger than 2 MB.'],
  [/conversion_failed/, 'The session could not be converted to a transcript.'],
  [/worker_timed_out/, 'The agent took too long and was stopped.'],
  [/worker_exited_\d+/, 'The agent stopped with an error.'],
  [/worker_not_complete/, 'The agent did not finish this stage.'],
  [/worker_reported_error/, 'The agent reported an error.'],
  [/stage_failed_use_new_run/, 'An earlier attempt failed. Start a new run.'],
  [
    /no_sessions_found/,
    'The selected sessions were not found on this computer.',
  ],
  [
    /insufficient_distinct_trajectories/,
    'Cross-session insights need at least two different trajectories.',
  ],
];

export function describeError(error: string | null) {
  if (!error) return '';
  return REASONS.find(([pattern]) => pattern.test(error))?.[1] ?? error;
}

export function phaseText(phase: RunPhase) {
  switch (phase) {
    case 'starting':
    case 'preparing':
      return 'Preparing transcripts';
    case 'generating':
      return 'Generating summaries and insights';
    case 'done':
      return 'Finished';
    case 'cancelled':
      return 'Stopped';
    case 'interrupted':
      return 'Stopped unexpectedly';
    default:
      return 'Failed';
  }
}

export type InsightStep = 'prepare' | InsightStage;

export const INSIGHT_STEPS: { id: InsightStep; label: string }[] = [
  { id: 'prepare', label: 'Preparing the submission' },
  { id: 'synthesis', label: 'Finding methods shared across sessions' },
  { id: 'humanize', label: 'Rewriting for readability' },
];

/** Where a cross-session job is on one of its three steps. */
export function insightStepState(
  job: InsightJob,
  step: InsightStep,
): StepState {
  const done = job.stagesDone ?? [];
  const active = isActivePhase(job.phase);
  if (step === 'prepare') {
    if (job.stage || done.length || job.phase === 'done') return 'done';
    if (active) return 'active';
    return job.phase === 'failed' ? 'failed' : 'waiting';
  }
  if (done.includes(step) || job.phase === 'done') return 'done';
  if (job.stage === step) {
    if (active) return 'active';
    if (job.phase === 'failed') return 'failed';
  }
  return 'waiting';
}
