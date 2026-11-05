'use client';

import Link from 'next/link';
import { AlertTriangle, Check } from 'lucide-react';

import type { SubmissionRow } from '@/lib/submission';
import { cn } from '@/lib/utils';

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return [...groups.entries()];
}

/**
 * Every trajectory by project, named by its session. Under each, the versions
 * that can be submitted (one may be checked), or why none can.
 */
export function SubmitChecklist({
  rows,
  selected,
  onToggle,
}: {
  rows: SubmissionRow[];
  selected: string[];
  onToggle: (reviewId: string) => void;
}) {
  return (
    <div className="space-y-8">
      {groupBy(rows, (row) => row.review.projectName).map(
        ([project, projectRows]) => (
          <section key={project} aria-label={project}>
            <h2 className="text-sm font-medium">{project}</h2>
            <ul className="mt-3 divide-y rounded-[6px] border bg-card">
              {groupBy(projectRows, (row) => row.group).map(
                ([group, versions]) => (
                  <li key={group} className="px-3 py-2.5">
                    <p
                      className="truncate text-sm font-medium"
                      title={versions[0].label}
                    >
                      {versions[0].label}
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {versions.map((row) => {
                        const id = row.review.id;
                        const checked = selected.includes(id);
                        return (
                          <li key={id}>
                            {/* relative: keeps the visually hidden checkbox in its row (see runs/new). */}
                            <label
                              className={cn(
                                'relative flex w-full items-start gap-3 rounded-[4px] px-1.5 py-1',
                                row.reason
                                  ? 'cursor-default'
                                  : 'cursor-pointer hover:bg-[color:var(--ui-hover)]',
                              )}
                            >
                              <input
                                type="checkbox"
                                className="peer sr-only"
                                checked={checked}
                                disabled={!!row.reason}
                                onChange={() => onToggle(id)}
                              />
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[3px] border peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
                                  checked
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-[color:var(--input)] bg-background',
                                  row.reason && 'opacity-40',
                                )}
                              >
                                {checked && <Check className="size-3" />}
                              </span>
                              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                                <span className="flex flex-wrap items-center gap-x-2">
                                  {row.version === 'unredacted' ? (
                                    <span className="inline-flex items-center gap-1 rounded-[3px] bg-amber-100 px-1.5 py-px font-medium text-amber-900">
                                      <AlertTriangle className="size-3" />
                                      Unredacted
                                    </span>
                                  ) : (
                                    row.version && (
                                      <span className="rounded-[3px] bg-muted px-1.5 py-px font-medium text-foreground">
                                        Redacted
                                      </span>
                                    )
                                  )}
                                  {row.generation && (
                                    <span>{row.generation}</span>
                                  )}
                                  <span>
                                    {row.counts.accepted} accepted ·{' '}
                                    {row.counts.declined} declined
                                    {row.counts.pending > 0 &&
                                      ` · ${row.counts.pending} open`}
                                  </span>
                                </span>
                                {row.reason && (
                                  <span className="mt-0.5 block">
                                    {row.reason}{' '}
                                    <Link
                                      href={`/review?review=${id}`}
                                      className="text-foreground underline underline-offset-2"
                                    >
                                      Open review
                                    </Link>
                                  </span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {versions.filter((row) => !row.reason).length > 1 && (
                      <p className="mt-1 pl-1.5 text-xs text-muted-foreground">
                        Versions of one session; only one can be submitted.
                      </p>
                    )}
                  </li>
                ),
              )}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}
