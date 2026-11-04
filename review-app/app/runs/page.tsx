'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, X } from 'lucide-react';

import { AppShell } from '@/components/oxygen/app-shell';
import { ServiceNotice } from '@/components/oxygen/service-notice';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  api,
  ApiError,
  postJson,
  type Imported,
  type RunDetail,
  type TrajectoryState,
} from '@/lib/oxygen-api';
import {
  averageSeconds,
  describeError,
  formatBytes,
  formatDate,
  formatDuration,
  isActivePhase,
  phaseText,
  runCounts,
  runFraction,
  STAGE_LABELS,
  STAGES,
  stepState,
  timeAgo,
} from '@/lib/run-progress';
import { cn } from '@/lib/utils';

const SOURCE_LABEL = { codex: 'Codex', claude: 'Claude Code' } as const;
const POLL_MS = 2000;

type Loaded =
  | { run: RunDetail }
  | { error: string; reason?: string; unauthorized?: boolean };

async function fetchRun(id: string): Promise<Loaded> {
  try {
    return {
      run: await api<RunDetail>(`/api/oxygen/runs/${encodeURIComponent(id)}`),
    };
  } catch (failure) {
    if (failure instanceof ApiError) {
      return {
        error:
          failure.status === 404 ? 'This run does not exist.' : failure.message,
        reason: failure.reason,
        unauthorized: failure.status === 401,
      };
    }
    return { error: 'Unable to load the run.' };
  }
}

function secondsSince(iso: string | null | undefined, now: number) {
  const start = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(start) ? 0 : Math.max(0, (now - start) / 1000);
}

function Steps({ item, now }: { item: TrajectoryState; now: number }) {
  return (
    <ol
      className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-4"
      aria-label="Stages"
    >
      {STAGES.map((stage) => {
        const state = stepState(item, stage);
        return (
          <li key={stage} className="min-w-0">
            <div
              className={cn(
                'h-1 rounded-full',
                state === 'done' && 'bg-primary',
                state === 'active' && 'animate-pulse bg-primary/60',
                state === 'failed' && 'bg-destructive',
                state === 'waiting' && 'bg-[color:var(--ui-hover)]',
              )}
            />
            <p
              className={cn(
                'mt-1.5 flex items-center gap-1 truncate text-xs',
                state === 'waiting'
                  ? 'text-muted-foreground'
                  : state === 'failed'
                    ? 'text-destructive'
                    : 'text-foreground',
              )}
            >
              {state === 'done' && <Check className="size-3 shrink-0" />}
              {state === 'failed' && <X className="size-3 shrink-0" />}
              <span className="truncate">{STAGE_LABELS[stage]}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {state === 'done' &&
                  formatDuration(item.stageSeconds[stage] ?? 0)}
                {state === 'active' &&
                  formatDuration(secondsSince(item.stageStartedAt, now))}
              </span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function statusText(item: TrajectoryState, now: number) {
  switch (item.status) {
    case 'queued':
      return 'Waiting';
    case 'converting':
      return 'Preparing';
    case 'running':
      return `Working · ${formatDuration(secondsSince(item.startedRunAt, now))}`;
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Stopped';
    default:
      return '';
  }
}

function TrajectoryRow({
  item,
  now,
  opening,
  onReview,
}: {
  item: TrajectoryState;
  now: number;
  opening: boolean;
  onReview: () => void;
}) {
  const total = Object.values(item.stageSeconds).reduce(
    (sum, value) => sum + value,
    0,
  );
  return (
    <li className="rounded-[6px] border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-48 flex-1">
          <p className="text-xs text-muted-foreground">
            Trajectory {item.index} · {SOURCE_LABEL[item.source]} ·{' '}
            {formatDate(item.startedAt)} · {formatBytes(item.bytes)}
          </p>
          <h3 className="mt-0.5 line-clamp-2 text-sm font-medium">
            {item.title || 'Session without a typed request'}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          {item.status === 'done' ? (
            <>
              <span className="text-xs text-muted-foreground">
                {item.insights === undefined
                  ? ''
                  : `${item.insights} ${item.insights === 1 ? 'insight' : 'insights'} · `}
                {formatDuration(total)}
              </span>
              <Button size="sm" disabled={opening} onClick={onReview}>
                {opening ? 'Opening…' : 'Review'}
              </Button>
            </>
          ) : (
            <span
              className={cn(
                'text-xs',
                item.status === 'failed' || item.status === 'skipped'
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {statusText(item, now)}
            </span>
          )}
        </div>
      </div>
      <Steps item={item} now={now} />
      {item.error && (
        <p className="mt-3 text-xs leading-5 text-destructive">
          {describeError(item.error)}
        </p>
      )}
    </li>
  );
}

export default function RunPage() {
  return (
    <AppShell active="projects">
      <RunView />
    </AppShell>
  );
}

/** Rendered only once access is confirmed, so it can read the address directly. */
function RunView() {
  const [id] = useState(
    () => new URLSearchParams(window.location.search).get('id') ?? '',
  );
  const [run, setRun] = useState<RunDetail | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [opening, setOpening] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);

  const apply = useCallback((result: Loaded) => {
    if ('run' in result) {
      setRun(result.run);
      setError('');
      setUnavailable(null);
    } else if (result.unauthorized) {
      window.location.reload();
    } else if (result.reason) {
      setUnavailable(result.reason);
    } else {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void fetchRun(id).then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [id, apply]);

  const active = run ? isActivePhase(run.phase) : false;
  useEffect(() => {
    if (!active) return;
    const poll = window.setInterval(
      () => void fetchRun(id).then(apply),
      POLL_MS,
    );
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [active, id, apply]);

  async function openReview(index: number) {
    setOpening(index);
    setNotice('');
    try {
      const { reviews } = await postJson<{ reviews: Imported }>(
        `/api/oxygen/runs/${encodeURIComponent(id)}/import`,
        { index },
      );
      window.location.assign(`/review?review=${reviews.redaction}`);
    } catch (failure) {
      setNotice(
        failure instanceof Error
          ? failure.message
          : 'Unable to open the review.',
      );
      setOpening(null);
    }
  }

  async function stop() {
    setConfirmStop(false);
    try {
      await postJson(`/api/oxygen/runs/${encodeURIComponent(id)}/cancel`, {});
      apply(await fetchRun(id));
    } catch (failure) {
      setNotice(
        failure instanceof Error ? failure.message : 'Unable to stop the run.',
      );
    }
  }

  const trajectories = run?.trajectories ?? [];
  const counts = runCounts(trajectories);
  const percent = Math.round(runFraction(trajectories) * 100);
  const average = averageSeconds(trajectories);
  const firstDone = trajectories.find((item) => item.status === 'done');
  const elapsed = run
    ? run.finishedAt
      ? (Date.parse(run.finishedAt) -
          Date.parse(run.startedAt ?? run.createdAt)) /
        1000
      : secondsSince(run.startedAt ?? run.createdAt, now)
    : 0;

  return (
    <>
      <main className="mx-auto w-full max-w-[860px] px-4 py-8 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Projects
        </Link>

        {unavailable ? (
          <ServiceNotice reason={unavailable} />
        ) : error ? (
          <p role="alert" className="mt-8 text-sm text-destructive">
            {error}
          </p>
        ) : !run ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold">
                  {run.workspaceName}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {run.language === 'zh' ? '中文' : 'English'} ·{' '}
                  {SOURCE_LABEL[run.host]} {run.model} · {run.effort} · started{' '}
                  {timeAgo(run.startedAt ?? run.createdAt, now)}
                </p>
              </div>
              {active ? (
                <Button variant="outline" onClick={() => setConfirmStop(true)}>
                  Stop run
                </Button>
              ) : (
                <Link
                  href={`/runs/new?workspace=${encodeURIComponent(run.workspace)}`}
                  className={cn(buttonVariants({ variant: 'outline' }))}
                >
                  New run
                </Link>
              )}
            </div>

            <section
              aria-label="Progress"
              className="mt-6 rounded-[6px] border bg-card p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm font-medium">
                  {counts.done} of {counts.total}{' '}
                  {counts.total === 1 ? 'trajectory' : 'trajectories'} finished
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {formatDuration(elapsed)} elapsed
                  {average !== null &&
                    ` · ${formatDuration(average)} per trajectory`}
                </p>
              </div>
              <progress
                aria-label="Run progress"
                max={100}
                value={percent}
                className="mt-3 block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-[color:var(--ui-hover)] [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-[color:var(--ui-hover)] [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-all"
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {run.error
                    ? describeError(run.error)
                    : active && counts.done > 0
                      ? 'You can review finished trajectories while the others keep running.'
                      : phaseText(run.phase)}
                </p>
                {firstDone && (
                  <Button
                    size="sm"
                    disabled={opening !== null}
                    onClick={() => void openReview(firstDone.index)}
                  >
                    Start reviewing
                  </Button>
                )}
              </div>
            </section>

            {notice && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {notice}
              </p>
            )}

            <ul className="mt-4 space-y-3">
              {trajectories.map((item) => (
                <TrajectoryRow
                  key={item.index}
                  item={item}
                  now={now}
                  opening={opening === item.index}
                  onReview={() => void openReview(item.index)}
                />
              ))}
            </ul>
          </>
        )}
      </main>

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this run?</AlertDialogTitle>
            <AlertDialogDescription>
              Trajectories that already finished stay available for review. The
              ones still in progress are stopped and not saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <AlertDialogAction onClick={() => void stop()}>
              Stop run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
