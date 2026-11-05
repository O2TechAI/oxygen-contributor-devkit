'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';

import { Input } from '@/components/ui/input';
import type { Review } from '@/lib/review-types';
import {
  formatWhen,
  generationLabel,
  generationReviews,
  generationStatus,
  locate,
  primaryReview,
  progressText,
  reviewStatus,
  sessionReview,
  sessionStatus,
  type SessionStatus,
  type TrajectoryIndex,
} from '@/lib/trajectory-index';
import { reviewTitle } from '@/lib/trajectory-list';
import { cn } from '@/lib/utils';

const STATUS_TEXT: Record<SessionStatus, string> = {
  completed: 'Labeled',
  in_progress: 'In progress',
  not_started: 'Not started',
};

/** A coloured dot: green labeled, amber in progress, hollow grey not started. */
function StatusDot({
  status,
  small = false,
}: {
  status: SessionStatus;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full',
        small ? 'size-2.5' : 'size-3.5',
        status === 'completed' && 'bg-emerald-600 text-white',
        status === 'in_progress' && 'bg-amber-500',
        status === 'not_started' && 'border-2 border-muted-foreground/40',
      )}
    >
      {status === 'completed' && !small && (
        <Check className="size-2.5" strokeWidth={3.5} />
      )}
    </span>
  );
}

/** "✓ Done", "3/6" or "To do", readable at a glance. */
function StatusBadge({
  status,
  progress,
  small = false,
}: {
  status: SessionStatus;
  progress: string;
  small?: boolean;
}) {
  return (
    <span
      title={STATUS_TEXT[status]}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full font-medium whitespace-nowrap',
        small
          ? 'px-1.5 text-[10px] leading-4'
          : 'px-2 py-px text-[11px] leading-4',
        status === 'completed' && 'bg-emerald-100 text-emerald-800',
        status === 'in_progress' && 'bg-amber-100 text-amber-900',
        status === 'not_started' && 'border text-muted-foreground',
      )}
    >
      {status === 'completed' && <Check className="size-3" strokeWidth={3} />}
      {status === 'completed'
        ? 'Done'
        : status === 'in_progress'
          ? progress || 'Started'
          : 'To do'}
    </span>
  );
}

const itemClass =
  'flex w-full items-start gap-2 rounded-[4px] px-2 py-1.5 text-left hover:bg-[color:var(--ui-hover)] disabled:cursor-default disabled:opacity-60';

/**
 * Every trajectory (agent session), oldest first, with its labeling status.
 * The open session lists the runs that processed it.
 */
export function TrajectorySidebar({
  index,
  activeId,
  disabled,
  onOpen,
  inSheet = false,
}: {
  index: TrajectoryIndex;
  activeId: string;
  disabled?: boolean;
  onOpen: (reviewId: string) => void;
  /** Leave room for the slide-over's close button. */
  inSheet?: boolean;
}) {
  const [query, setQuery] = useState('');
  const current = useMemo(() => locate(index, activeId), [index, activeId]);
  const activeRow = useRef<HTMLButtonElement>(null);
  const currentKey =
    current?.kind === 'session' ? current.session.key : activeId;
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: 'nearest' });
  }, [currentKey]);

  const filter = query.trim().toLowerCase();
  const sessions = index.sessions.filter(
    (session) =>
      !filter ||
      session.label.toLowerCase().includes(filter) ||
      session.project.toLowerCase().includes(filter),
  );
  const labeled = index.sessions.filter(
    (session) => sessionStatus(session) === 'completed',
  ).length;
  const projects = new Set(index.sessions.map((session) => session.project));

  return (
    <nav aria-label="Trajectories" className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'shrink-0 space-y-2 border-b px-3 py-3',
          inSheet && 'pr-12',
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Trajectories</h2>
          <span className="text-xs text-muted-foreground">
            {labeled} of {index.sessions.length} labeled
          </span>
        </div>
        {index.sessions.length > 0 && (
          <div
            aria-hidden="true"
            className="flex h-1.5 overflow-hidden rounded-full bg-muted"
            title={`${labeled} of ${index.sessions.length} labeled`}
          >
            <span
              className="bg-emerald-600"
              style={{ width: `${(100 * labeled) / index.sessions.length}%` }}
            />
          </div>
        )}
        {index.sessions.length > 6 && (
          <Input
            aria-label="Filter trajectories"
            placeholder="Filter"
            className="h-7 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 text-sm">
        {sessions.map((session, position) => {
          const active =
            current?.kind === 'session' && current.session.key === session.key;
          const showProject =
            projects.size > 1 &&
            (position === 0 ||
              sessions[position - 1].project !== session.project);
          const review = sessionReview(session);
          const status = sessionStatus(session);
          const runs = session.generations.length;
          return (
            <div key={session.key}>
              {showProject && (
                <h3 className="mt-3 mb-1 px-2 text-xs font-medium text-muted-foreground first:mt-0">
                  {session.project}
                </h3>
              )}
              <button
                ref={active ? activeRow : undefined}
                type="button"
                disabled={disabled}
                aria-current={active ? 'page' : undefined}
                aria-label={`${session.label}, ${STATUS_TEXT[status].toLowerCase()}`}
                className={cn(
                  itemClass,
                  active && 'bg-[color:var(--ui-hover)]',
                )}
                title={session.label}
                onClick={() => review && onOpen(review.id)}
              >
                <span className="mt-1">
                  <StatusDot status={status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] text-muted-foreground">
                    {session.startedAt
                      ? formatWhen(session.startedAt)
                      : 'Session time unknown'}
                    {runs > 1 && !active && ` · ${runs} runs`}
                  </span>
                  <span
                    className={cn(
                      'line-clamp-2 leading-5',
                      active && 'font-medium',
                    )}
                  >
                    {session.name}
                  </span>
                </span>
                <span className="mt-3.5">
                  <StatusBadge
                    status={status}
                    progress={progressText(
                      session.generations.flatMap(generationReviews),
                    )}
                  />
                </span>
              </button>
              {active && runs > 1 && (
                <ul className="mb-1 ml-6 border-l pl-1.5">
                  {session.generations.map((generation) => {
                    const target = primaryReview(generation);
                    const here = current.generation.key === generation.key;
                    const runStatus = generationStatus(generation);
                    return (
                      <li key={generation.key}>
                        <button
                          type="button"
                          disabled={disabled || !target}
                          aria-current={here ? 'page' : undefined}
                          className={cn(
                            itemClass,
                            'items-center py-1 text-xs text-muted-foreground',
                            here &&
                              'bg-[color:var(--ui-hover)] text-foreground',
                          )}
                          onClick={() => target && onOpen(target.id)}
                        >
                          <StatusDot status={runStatus} small />
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={generationLabel(generation)}
                          >
                            {generationLabel(generation, { short: true })}
                          </span>
                          <StatusBadge
                            status={runStatus}
                            progress={progressText(
                              generationReviews(generation),
                            )}
                            small
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            {index.sessions.length
              ? 'No trajectory matches.'
              : 'No trajectories yet.'}
          </p>
        )}
        {[
          { title: 'Global insights', reviews: index.global },
          { title: 'Other reviews', reviews: index.other },
        ].map(
          (section) =>
            section.reviews.length > 0 && (
              <div key={section.title} className="mt-4">
                <h3 className="mb-1 px-2 text-xs font-medium text-muted-foreground">
                  {section.title}
                </h3>
                {section.reviews.map((review: Review) => {
                  const status = reviewStatus(review);
                  const active = review.id === activeId;
                  return (
                    <button
                      key={review.id}
                      ref={active ? activeRow : undefined}
                      type="button"
                      disabled={disabled}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        itemClass,
                        active && 'bg-[color:var(--ui-hover)]',
                      )}
                      onClick={() => onOpen(review.id)}
                    >
                      <span className="mt-1">
                        <StatusDot status={status} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] text-muted-foreground">
                          {formatWhen(review.generatedAt || review.updatedAt)}
                        </span>
                        <span className="line-clamp-2 leading-5">
                          {review.reviewLevel === 'global'
                            ? review.projectName
                            : reviewTitle(review)}
                        </span>
                      </span>
                      <span className="mt-3.5">
                        <StatusBadge
                          status={status}
                          progress={progressText([review])}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            ),
        )}
      </div>
    </nav>
  );
}
