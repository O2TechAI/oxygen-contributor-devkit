'use client';

import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';

import { InsightCard } from '@/components/insight-card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { evidencePlainText } from '@/lib/review-queue';
import type { Insight, InsightStatus, Review } from '@/lib/review-types';
import { cn } from '@/lib/utils';

const SHORTCUTS: [string, string][] = [
  ['A', 'Accept'],
  ['D', 'Decline'],
  ['E', 'Edit'],
  ['J', 'Next'],
  ['K', 'Previous'],
];

export function ReviewQueue({
  review,
  insight,
  index,
  remaining,
  structured,
  skillCandidate,
  evidenceLabels,
  hasPrevious,
  hasNext,
  completable,
  disabled,
  onStatus,
  onEdit,
  onDelete,
  onPrevious,
  onNext,
  onOpenEvidence,
  onComplete,
  tab,
  onTabChange,
  summary,
  summaryCount,
}: {
  review: Review;
  insight: Insight | undefined;
  /** Zero-based position of the card inside this review. */
  index: number;
  /** Cards still needing a decision across every review. */
  remaining: number;
  structured: boolean;
  skillCandidate: boolean;
  evidenceLabels?: Record<string, string>;
  hasPrevious: boolean;
  hasNext: boolean;
  completable: boolean;
  disabled: boolean;
  onStatus: (status: InsightStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onOpenEvidence: (lineId: string) => void;
  onComplete: () => void;
  tab: 'insights' | 'summary';
  onTabChange: (tab: 'insights' | 'summary') => void;
  /** The same Summary the side-by-side layout shows, with the card's evidence highlighted. */
  summary: ReactNode;
  summaryCount: number;
}) {
  const tabs = (
    <nav
      aria-label="Review sections"
      className="shrink-0 border-b bg-background px-4 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-[760px] gap-5">
        {(
          [
            ['insights', 'Insights', review.insights.length],
            ['summary', 'Summary', summaryCount],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => onTabChange(id)}
            className={cn(
              '-mb-px border-b-2 py-2.5 text-sm transition-colors',
              tab === id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {count}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );

  if (tab === 'summary') {
    return (
      <>
        {tabs}
        <ScrollArea className="h-[min(760px,80dvh)] lg:h-auto lg:min-h-0 lg:flex-1">
          {summary}
        </ScrollArea>
      </>
    );
  }

  if (!insight) {
    return (
      <>
        {tabs}
        <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">
          No Insights in this review
        </div>
      </>
    );
  }

  const lines = new Map(review.summaryLines.map((line) => [line.id, line]));
  const excerpts = insight.evidence
    .map((id) => ({
      id,
      label: evidenceLabels?.[id] ?? id,
      text: evidencePlainText(lines.get(id)?.text ?? ''),
    }))
    .filter((excerpt) => excerpt.text);

  return (
    <>
      {tabs}
      <ScrollArea className="h-[min(760px,80dvh)] lg:h-auto lg:min-h-0 lg:flex-1">
        <div className="mx-auto w-full max-w-[760px] px-4 pt-6 pb-44 sm:px-6">
          {remaining === 0 && (
            <output className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[6px] bg-[color:var(--ui-callout)] px-4 py-3 text-sm">
              <span>Every card is reviewed.</span>
              {review.status !== 'completed' && (
                <Button size="sm" disabled={!completable} onClick={onComplete}>
                  <Check data-icon="inline-start" />
                  Complete
                </Button>
              )}
            </output>
          )}
          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              Insight {index + 1} of {review.insights.length}
            </span>
            <span>{remaining} left to review</span>
          </div>

          <InsightCard
            insight={insight}
            structured={structured}
            skillCandidate={skillCandidate}
            evidenceLabels={evidenceLabels}
            selected={false}
            onSelect={() => undefined}
            onEvidence={onOpenEvidence}
            onEdit={onEdit}
            onDelete={onDelete}
            onStatus={onStatus}
          />

          {excerpts.length > 0 && (
            <section aria-label="Evidence" className="mt-5">
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                Evidence
              </h2>
              <ul className="space-y-2">
                {excerpts.map((excerpt) => (
                  <li
                    key={excerpt.id}
                    className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 rounded-[6px] bg-[color:var(--evidence-bg)] px-3 py-2.5"
                  >
                    <button
                      type="button"
                      className="self-start text-left font-mono text-xs text-[color:var(--evidence-strong)] hover:underline"
                      title="Show in the full summary"
                      onClick={() => onOpenEvidence(excerpt.id)}
                    >
                      {excerpt.label}
                    </button>
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {excerpt.text}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || !hasPrevious}
                onClick={onPrevious}
              >
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || !hasNext}
                onClick={onNext}
              >
                Next
                <ChevronRight data-icon="inline-end" />
              </Button>
            </div>
            <p className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
              {SHORTCUTS.map(([key, label]) => (
                <span key={key} className="inline-flex items-center gap-1">
                  <kbd className="rounded-[3px] border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                    {key}
                  </kbd>
                  {label}
                </span>
              ))}
            </p>
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
