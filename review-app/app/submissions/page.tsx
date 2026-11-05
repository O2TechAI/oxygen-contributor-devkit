'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  LoaderCircle,
  X,
} from 'lucide-react';

import { AgentChoiceFields } from '@/components/agent-choice-fields';
import { AppShell } from '@/components/oxygen/app-shell';
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
import { needsImport, useInsightJobsContext } from '@/hooks/use-insight-jobs';
import {
  fetchCapabilities,
  resolveChoice,
  type AgentChoice,
  type Capabilities,
} from '@/lib/agent-capabilities';
import {
  api,
  postJson,
  type InsightJob,
  type Submission,
} from '@/lib/oxygen-api';
import type { Review } from '@/lib/review-types';
import {
  describeError,
  formatDate,
  formatDuration,
  INSIGHT_STEPS,
  insightStepState,
  isActivePhase,
  phaseText,
  timeAgo,
} from '@/lib/run-progress';
import { changedSinceSubmission, DEFAULT_AGENT } from '@/lib/submission';
import {
  buildTrajectoryIndex,
  formatWhen,
  locate,
  type IndexRun,
} from '@/lib/trajectory-index';

/** The time in an id such as `20261105T215311Z-a8c758`, as ISO. */
function stampTime(id: string) {
  const match = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
    : null;
}
import { cn } from '@/lib/utils';

export default function SubmissionsPage() {
  return (
    <AppShell active="submit">
      <Submissions />
    </AppShell>
  );
}

function trajectories(count: number) {
  return `${count} ${count === 1 ? 'trajectory' : 'trajectories'}`;
}

function jobText(job: InsightJob) {
  if (isActivePhase(job.phase)) return 'Generating insights';
  if (job.phase === 'done')
    return job.candidateCount
      ? `${job.candidateCount} global ${job.candidateCount === 1 ? 'insight' : 'insights'}`
      : 'No shared methods found';
  return phaseText(job.phase);
}

function Submissions() {
  const jobs = useInsightJobsContext();
  const [id] = useState(() =>
    new URLSearchParams(window.location.search).get('id'),
  );
  const [reviews, setReviews] = useState<Review[]>([]);
  const [runs, setRuns] = useState<IndexRun[]>([]);

  useEffect(() => {
    api<{ reviews: Review[] }>('/api/reviews')
      .then((result) => setReviews(result.reviews))
      .catch(() => undefined);
    api<{ runs: IndexRun[] }>('/api/oxygen/runs')
      .then((result) => setRuns(result.runs))
      .catch(() => undefined);
  }, []);

  const list = jobs?.submissions;
  const submission = id ? list?.find((item) => item.id === id) : undefined;

  return (
    <main className="mx-auto w-full max-w-[760px] px-4 py-8 sm:px-6">
      <Link
        href={id ? '/submissions' : '/submit'}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {id ? 'Submissions' : 'Submit'}
      </Link>
      {list == null ? (
        <p className="mt-10 text-sm text-muted-foreground">Loading…</p>
      ) : id ? (
        submission ? (
          <Detail submission={submission} reviews={reviews} runs={runs} />
        ) : (
          <p className="mt-10 text-sm text-muted-foreground">
            This submission was not found. Is the Oxygen service running?
          </p>
        )
      ) : (
        <>
          <h1 className="mt-3 text-xl font-semibold">Submissions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Frozen copies of the trajectories you handed in, kept on this
            computer.
          </p>
          {list.length === 0 ? (
            <p className="mt-8 rounded-[6px] border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing submitted yet.{' '}
              <Link href="/submit" className="underline">
                Choose trajectories to submit
              </Link>
              .
            </p>
          ) : (
            <ul className="mt-6 divide-y rounded-[6px] border bg-card">
              {list.map((item) => {
                const latest = item.jobs[0];
                return (
                  <li key={item.id}>
                    <Link
                      href={`/submissions?id=${item.id}`}
                      className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm hover:bg-[color:var(--ui-hover)]"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium">
                          {formatDate(item.createdAt)}
                        </span>
                        <span className="text-muted-foreground">
                          {' '}
                          · {trajectories(item.reviews.length)} ·{' '}
                          {item.projects.join(', ')}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-xs',
                          latest && isActivePhase(latest.phase)
                            ? 'text-primary'
                            : 'text-muted-foreground',
                        )}
                      >
                        {latest ? jobText(latest) : timeAgo(item.createdAt)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function Detail({
  submission,
  reviews,
  runs,
}: {
  submission: Submission;
  reviews: Review[];
  runs: IndexRun[];
}) {
  const index = useMemo(
    () => buildTrajectoryIndex(reviews, runs),
    [reviews, runs],
  );
  // Named by session on this computer; the submission itself stores only Summary headings.
  const labelFor = (reviewId: string) => {
    const place = locate(index, reviewId);
    return place?.kind === 'session' ? place.session.label : undefined;
  };
  const changed = reviews.length
    ? changedSinceSubmission(submission.reviews, reviews)
    : [];
  const changedGlobal = reviews.length
    ? changedSinceSubmission(submission.globalReviews ?? [], reviews)
    : [];
  const counts = submission.validation.counts;
  return (
    <>
      <h1 className="mt-3 text-xl font-semibold">
        Submission of {formatDate(submission.createdAt)}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {trajectories(submission.reviews.length)} · {counts.accepted} accepted ·{' '}
        {counts.declined} declined
        {submission.historyIncluded ? ' · with edit history' : ''}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a
          href={`/api/oxygen/submissions/${submission.id}/download`}
          download
          className={buttonVariants({ size: 'lg' })}
        >
          <Download data-icon="inline-start" />
          Export
        </a>
        <span className="text-xs text-muted-foreground">
          A .zip of the submitted trajectories
          {(submission.globalReviews?.length ?? 0) > 0 && ', global insights'}
          {submission.historyIncluded && ' and edit history'}.
        </span>
      </div>
      {changed.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[6px] bg-[color:var(--ui-callout)] px-4 py-3 text-sm">
          <span>
            {changed.length === 1
              ? '1 review was edited after this submission.'
              : `${changed.length} reviews were edited after this submission.`}{' '}
            This copy is unchanged.
          </span>
          <Link href="/submit" className={buttonVariants({ size: 'sm' })}>
            Submit again
          </Link>
        </div>
      )}

      <Generation submission={submission} />

      {(submission.globalReviews?.length ?? 0) > 0 && (
        <section className="mt-8" aria-labelledby="submitted-global">
          <h2 id="submitted-global" className="mb-2 text-sm font-medium">
            Global insights included
          </h2>
          <ul className="divide-y rounded-[6px] border bg-card">
            {submission.globalReviews!.map((item) => (
              <li key={item.reviewId} className="px-4 py-2.5 text-sm">
                <Link
                  href={`/review?review=${item.reviewId}`}
                  className="block truncate hover:underline"
                >
                  Global insights
                  {item.generatedFrom &&
                    ` · generated ${formatWhen(stampTime(item.generatedFrom.jobId)) || item.generatedFrom.jobId}`}
                </Link>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {item.accepted} accepted · {item.declined} declined
                  {changedGlobal.includes(item.reviewId) && ' · edited since'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8" aria-labelledby="submitted-list">
        <h2 id="submitted-list" className="mb-2 text-sm font-medium">
          Submitted trajectories
        </h2>
        <ul className="divide-y rounded-[6px] border bg-card">
          {submission.reviews.map((item) => (
            <li key={item.reviewId} className="px-4 py-2.5 text-sm">
              <Link
                href={`/review?review=${item.reviewId}`}
                className="block truncate hover:underline"
              >
                {labelFor(item.reviewId) ?? item.title}
              </Link>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {item.privacyStatus === 'unredacted' && (
                  <span className="text-amber-700">Unredacted · </span>
                )}
                {item.projectName} · {item.accepted} accepted · {item.declined}{' '}
                declined
                {changed.includes(item.reviewId) && ' · edited since'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Generation({ submission }: { submission: Submission }) {
  const jobs = useInsightJobsContext();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    state: 'loading',
  });
  const suggested = submission.suggestedAgent ?? DEFAULT_AGENT;
  const [choice, setChoice] = useState<AgentChoice>({
    provider: suggested.host,
    model: suggested.model,
    effort: suggested.effort,
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const latest = submission.jobs[0];
  // Completed global insights already submitted for exactly these trajectories.
  const sameReviews = (other: Submission) =>
    other.reviews.length === submission.reviews.length &&
    other.reviews.every((item) =>
      submission.reviews.some(
        (mine) =>
          mine.reviewId === item.reviewId && mine.updatedAt === item.updatedAt,
      ),
    );
  const globalDone = (submission.globalReviews ?? []).some((item) => {
    const source = jobs?.submissions?.find(
      (other) => other.id === item.generatedFrom?.submissionId,
    );
    return Boolean(source && sameReviews(source));
  });
  const active = latest && isActivePhase(latest.phase);
  const distinct = submission.validation.counts.trajectories;
  const unredacted = submission.reviews.filter(
    (item) => item.privacyStatus === 'unredacted',
  ).length;
  const providers =
    capabilities.state === 'ready' ? capabilities.providers : [];
  const resolved = resolveChoice(providers, choice);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  function openDialog() {
    setError('');
    setOpen(true);
    void fetchCapabilities().then(setCapabilities);
  }

  async function start() {
    if (
      !resolved.usable ||
      !resolved.provider ||
      !resolved.model ||
      !resolved.effort
    )
      return;
    setStarting(true);
    setError('');
    try {
      await postJson(`/api/oxygen/submissions/${submission.id}/generations`, {
        provider: resolved.provider.id,
        model: resolved.model.id,
        effort: resolved.effort,
      });
      setOpen(false);
      await jobs?.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to start.');
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!latest) return;
    await postJson(
      `/api/oxygen/submissions/${submission.id}/generations/${latest.id}/cancel`,
      {},
    ).catch(() => undefined);
    await jobs?.refresh();
  }

  const elapsed =
    latest?.startedAt && active
      ? (now - Date.parse(latest.startedAt)) / 1000
      : null;
  const workerLabel = (job: InsightJob) =>
    `${job.host === 'claude' ? 'Claude' : 'Codex'} ${job.model ?? ''}${job.effort ? ` · ${job.effort}` : ''}`;

  return (
    <section
      className="mt-8 rounded-[6px] border bg-card p-4"
      aria-labelledby="generation"
    >
      <h2 id="generation" className="text-sm font-medium">
        Cross-session insights
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Look across these trajectories for methods you used more than once, and
        draft them as global insight cards for you to review.
      </p>

      {!latest && globalDone && (
        <p className="mt-4 flex items-start gap-2 rounded-[6px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
          <Check className="mt-0.5 size-4 shrink-0" />
          <span>
            Global insights for these trajectories are already complete and
            included in this submission.
          </span>
        </p>
      )}
      {!latest ? null : active ? (
        <div className="mt-4">
          <ol className="space-y-1.5 text-sm">
            {INSIGHT_STEPS.map((step) => {
              const state = insightStepState(latest, step.id);
              return (
                <li key={step.id} className="flex items-center gap-2">
                  {state === 'done' ? (
                    <Check className="size-3.5 text-primary" />
                  ) : state === 'active' ? (
                    <LoaderCircle className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <span className="grid size-3.5 place-items-center">
                      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                    </span>
                  )}
                  <span
                    className={cn(
                      state === 'waiting' && 'text-muted-foreground',
                    )}
                  >
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            {workerLabel(latest)}
            {elapsed !== null &&
              ` · running for ${formatDuration(elapsed)}`} ·
            this can take a while; you can leave this page.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            onClick={() => setStopping(true)}
          >
            Stop
          </Button>
        </div>
      ) : latest.phase === 'done' ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[6px] bg-[color:var(--ui-callout)] px-4 py-3 text-sm">
          {!latest.candidateCount ? (
            <span>No method recurred across these trajectories.</span>
          ) : latest.imported?.reviewId ? (
            <>
              <span>
                {latest.candidateCount === 1
                  ? '1 global insight is ready to review.'
                  : `${latest.candidateCount} global insights are ready to review.`}
              </span>
              <Link
                href={`/review?review=${latest.imported.reviewId}`}
                onClick={() => jobs?.dismiss(latest.id)}
                className={buttonVariants({ size: 'sm' })}
              >
                Open
              </Link>
            </>
          ) : (
            <span>
              {needsImport(latest)
                ? 'Adding the global insights to your reviews…'
                : ''}
            </span>
          )}
        </div>
      ) : (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {phaseText(latest.phase)}
          {latest.error ? `: ${describeError(latest.error)}` : '.'}
        </p>
      )}

      {!active && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant={
              latest?.phase === 'done' || globalDone ? 'outline' : 'default'
            }
            disabled={distinct < 2}
            onClick={openDialog}
          >
            {latest || globalDone
              ? 'Generate again…'
              : 'Generate cross-session insights…'}
          </Button>
          {distinct < 2 && (
            <span className="text-xs text-muted-foreground">
              Needs at least two different trajectories; this submission has{' '}
              {distinct}.
            </span>
          )}
        </div>
      )}

      {submission.jobs.length > 1 && (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Earlier attempts</summary>
          <ul className="mt-2 space-y-1">
            {submission.jobs.slice(1).map((job) => (
              <li key={job.id}>
                {timeAgo(job.createdAt)} · {workerLabel(job)} · {jobText(job)}
                {job.error ? ` (${describeError(job.error)})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Generate cross-session insights?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The summaries and cards of these {trajectories(distinct)} are sent
              to {resolved.provider?.label ?? 'the agent'} through your own
              login. The result is a draft that you review like any other.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {unredacted > 0 && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[6px] border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {unredacted === 1
                  ? '1 of them is unredacted:'
                  : `${unredacted} of them are unredacted:`}{' '}
                its text has not been through privacy redaction and is sent as
                it is.
              </span>
            </p>
          )}
          <AgentChoiceFields
            id="insights"
            capabilities={capabilities}
            choice={choice}
            onChange={setChoice}
          />
          <p className="text-xs text-muted-foreground">
            Suggested from the runs these trajectories came from.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={!resolved.usable || starting}
              onClick={() => void start()}
            >
              {starting ? 'Starting…' : 'Generate'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={stopping} onOpenChange={setStopping}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop generating?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent is stopped and this attempt ends. You can generate again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <AlertDialogAction onClick={() => void stop()}>
              <X data-icon="inline-start" />
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
