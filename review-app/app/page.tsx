'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { AppShell } from '@/components/oxygen/app-shell';
import { ServiceNotice } from '@/components/oxygen/service-notice';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  api,
  ApiError,
  type RunListItem,
  type Workspace,
} from '@/lib/oxygen-api';
import { isUndecided } from '@/lib/review-queue';
import type { Review } from '@/lib/review-types';
import { visibleReviews } from '@/lib/trajectory-list';
import { isActivePhase, phaseText, timeAgo } from '@/lib/run-progress';
import { cn } from '@/lib/utils';

const FIRST_PAGE = 12;

function sessionCount(workspace: Workspace) {
  return workspace.sessions.codex + workspace.sessions.claude;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function sourceSummary(workspace: Workspace) {
  return [
    workspace.sessions.codex ? `Codex ${workspace.sessions.codex}` : '',
    workspace.sessions.claude ? `Claude Code ${workspace.sessions.claude}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function ProjectCard({
  workspace,
  lastRun,
}: {
  workspace: Workspace;
  lastRun: RunListItem | undefined;
}) {
  return (
    <article className="flex flex-col rounded-[6px] border bg-card p-4">
      <h3 className="truncate text-sm font-medium" title={workspace.name}>
        {workspace.name}
      </h3>
      <p
        className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
        title={workspace.path}
      >
        {workspace.path}
      </p>
      <p className="mt-4 text-sm">
        {plural(sessionCount(workspace), 'session')}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {sourceSummary(workspace)} · active {timeAgo(workspace.lastActivity)}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        {lastRun ? (
          <Link
            href={`/runs?id=${lastRun.id}`}
            className="min-w-0 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {isActivePhase(lastRun.phase)
              ? `Running · ${lastRun.done} of ${lastRun.total} done`
              : `Last run ${timeAgo(lastRun.createdAt)} · ${lastRun.done} of ${lastRun.total} done`}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">No runs yet</span>
        )}
        <Link
          href={`/runs/new?workspace=${encodeURIComponent(workspace.path)}`}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'shrink-0',
          )}
        >
          New run
        </Link>
      </div>
    </article>
  );
}

function RunRow({ run }: { run: RunListItem }) {
  const active = isActivePhase(run.phase);
  return (
    <li>
      <Link
        href={`/runs?id=${run.id}`}
        className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm transition-colors hover:bg-[color:var(--ui-hover)]"
      >
        <span className="min-w-0 truncate">
          <span className="font-medium">{run.workspaceName}</span>
          <span className="text-muted-foreground">
            {' '}
            · {run.done} of {run.total}{' '}
            {run.total === 1 ? 'trajectory' : 'trajectories'} ·{' '}
            {run.language === 'zh' ? '中文' : 'English'}
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 text-xs',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {active ? 'In progress' : phaseText(run.phase)} ·{' '}
          {timeAgo(run.createdAt)}
        </span>
      </Link>
    </li>
  );
}

export default function HomePage() {
  // Loads nothing until access is confirmed, so a sign-in page never reloads itself.
  return (
    <AppShell active="projects">
      <Projects />
    </AppShell>
  );
}

function Projects() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    // Review links from earlier versions pointed at the home address.
    if (new URLSearchParams(window.location.search).has('review')) {
      window.location.replace(`/review${window.location.search}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const guard = (failure: unknown) => {
      if (cancelled) return;
      if (failure instanceof ApiError && failure.status === 401) {
        window.location.reload();
      } else if (failure instanceof ApiError && failure.reason) {
        setUnavailable(failure.reason);
      } else {
        setError(
          failure instanceof Error ? failure.message : 'Unable to load.',
        );
      }
    };
    api<{ workspaces: Workspace[] }>('/api/oxygen/workspaces')
      .then((result) => !cancelled && setWorkspaces(result.workspaces))
      .catch(guard);
    api<{ runs: RunListItem[] }>('/api/oxygen/runs')
      .then((result) => !cancelled && setRuns(result.runs))
      .catch(() => undefined);
    api<{ reviews: Review[] }>('/api/reviews')
      .then((result) => !cancelled && setReviews(result.reviews))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the activity of running work current.
  useEffect(() => {
    if (!runs.some((run) => isActivePhase(run.phase))) return;
    const timer = window.setInterval(() => {
      api<{ runs: RunListItem[] }>('/api/oxygen/runs')
        .then((result) => setRuns(result.runs))
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [runs]);

  const waiting = useMemo(() => {
    const open = visibleReviews(reviews).filter(
      (review) =>
        review.status !== 'completed' &&
        review.insights.some((insight) => isUndecided(insight.status)),
    );
    return {
      next: open[0],
      cards: open.reduce(
        (sum, review) =>
          sum +
          review.insights.filter((insight) => isUndecided(insight.status))
            .length,
        0,
      ),
    };
  }, [reviews]);

  const matching = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (workspaces ?? []).filter(
      (workspace) =>
        !query ||
        workspace.name.toLowerCase().includes(query) ||
        workspace.path.toLowerCase().includes(query),
    );
  }, [workspaces, filter]);
  const shown = showAll || filter ? matching : matching.slice(0, FIRST_PAGE);
  const lastRunOf = (path: string) =>
    runs.find((run) => run.workspace === path);
  const recent = runs.slice(0, 5);

  return (
    <>
      <main className="mx-auto w-full max-w-[1040px] px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sessions recorded by Codex and Claude Code on this computer.
        </p>

        {waiting.next && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[6px] bg-[color:var(--ui-callout)] px-4 py-3 text-sm">
            <span>
              {plural(waiting.cards, 'insight')} waiting for your review
            </span>
            <Link
              href={`/review?review=${waiting.next.id}`}
              className={cn(buttonVariants({ size: 'sm' }))}
            >
              Continue reviewing
            </Link>
          </div>
        )}

        {unavailable ? (
          <ServiceNotice reason={unavailable} />
        ) : error ? (
          <p role="alert" className="mt-8 text-sm text-destructive">
            {error}
          </p>
        ) : workspaces === null ? (
          <p className="mt-10 text-sm text-muted-foreground">
            Looking for sessions…
          </p>
        ) : (
          <>
            {recent.length > 0 && (
              <section className="mt-8" aria-labelledby="recent-runs">
                <h2 id="recent-runs" className="mb-2 text-sm font-medium">
                  Recent runs
                </h2>
                <ul className="divide-y rounded-[6px] border bg-card">
                  {recent.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-8" aria-labelledby="project-list">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 id="project-list" className="text-sm font-medium">
                  {plural(workspaces.length, 'project')}
                </h2>
                {workspaces.length > 6 && (
                  <Input
                    aria-label="Filter projects"
                    placeholder="Filter projects"
                    className="h-8 max-w-56"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                )}
              </div>
              {workspaces.length === 0 ? (
                <p className="rounded-[6px] border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
                  No sessions found. Oxygen reads Codex sessions from ~/.codex
                  and Claude Code sessions from ~/.claude.
                </p>
              ) : matching.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No project matches “{filter}”.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map((workspace) => (
                    <ProjectCard
                      key={workspace.path}
                      workspace={workspace}
                      lastRun={lastRunOf(workspace.path)}
                    />
                  ))}
                </div>
              )}
              {!showAll && !filter && matching.length > FIRST_PAGE && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-4 text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  Show all {matching.length} projects
                </button>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
