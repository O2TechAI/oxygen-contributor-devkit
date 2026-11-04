import type { ReactNode } from 'react';
import { Check, PencilLine, Trash2, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InsightTakeaway, InsightProse } from '@/components/insight-takeaway';
import type { Insight, InsightKey, InsightStatus } from '@/lib/review-types';
import { detectedInsightKeys } from '@/lib/v5-format';
import { cn } from '@/lib/utils';

export function insightStatusLabel(status: InsightStatus) {
  if (status === 'accepted') return 'Accepted';
  if (status === 'rejected') return 'Declined';
  if (status === 'needs_review') return 'Evidence changed';
  return 'Pending';
}

function InsightKeyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

const SELECTED_CARD =
  'shadow-[0_0_0_2px_rgba(35,131,226,0.45),rgba(15,15,15,0.08)_0_2px_6px]';

// Pastel status tags.
function insightStatusClasses(status: InsightStatus) {
  if (status === 'accepted') return 'bg-[#dbeddb] text-[#1c3829]';
  if (status === 'needs_review') return 'bg-[#ffe2dd] text-[#5d1715]';
  if (status === 'rejected') return 'bg-[#e3e2e080] text-[#32302c]/70';
  return 'bg-[#e3e2e080] text-[#32302c]';
}

function insightTypeClasses(type?: string) {
  switch (type) {
    case 'user-agent':
    case 'user explicit':
      return {
        badge:
          'border-transparent bg-[color:var(--type-explicit-bg)] text-[color:var(--type-explicit-strong)]',
        selected: SELECTED_CARD,
      };
    case 'user implicit':
      return {
        badge:
          'border-transparent bg-[color:var(--type-implicit-bg)] text-[color:var(--type-implicit-strong)]',
        selected: SELECTED_CARD,
      };
    case 'agent':
    case 'agent encountered':
      return {
        badge:
          'border-transparent bg-[color:var(--type-agent-bg)] text-[color:var(--type-agent-strong)]',
        selected: SELECTED_CARD,
      };
    default:
      return {
        badge: 'border-transparent bg-[#e3e2e080] text-[#32302c]',
        selected: SELECTED_CARD,
      };
  }
}

export function InsightCard({
  insight,
  structured,
  skillCandidate,
  evidenceLabels,
  selected,
  onSelect,
  onEvidence,
  onEdit,
  onDelete,
  onStatus,
}: {
  insight: Insight;
  structured: boolean;
  skillCandidate: boolean;
  evidenceLabels?: Record<string, string>;
  selected: boolean;
  onSelect: () => void;
  onEvidence: (lineId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (status: InsightStatus) => void;
}) {
  const keys = new Set<InsightKey>(detectedInsightKeys(insight));
  const typeClasses = insightTypeClasses(insight.type);

  return (
    <article
      id={`insight-${insight.id}`}
      className={cn(
        'rounded-[6px] border-0 bg-card shadow-[var(--ui-shadow)] transition-[box-shadow]',
        selected && typeClasses.selected,
        insight.status === 'rejected' && 'opacity-60',
      )}
    >
      <div className="min-w-0 px-5 pt-4 pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {insight.id}
              </span>
              {insight.authorship === 'reviewer' && (
                <Badge variant="secondary">Added by reviewer</Badge>
              )}
              {structured && keys.has('type') && insight.type && (
                <Badge variant="outline" className={typeClasses.badge}>
                  {insight.type}
                </Badge>
              )}
            </div>
            <div className="mt-2 flex min-w-0 items-baseline gap-2">
              <h3 className="min-w-0 text-lg font-semibold leading-[1.35]">
                <button
                  type="button"
                  aria-pressed={selected}
                  className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={onSelect}
                >
                  {insight.title}
                </button>
              </h3>
            </div>
          </div>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-xs',
              insightStatusClasses(insight.status),
            )}
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-current opacity-70"
            />
            {insightStatusLabel(insight.status)}
          </span>
        </div>
        {structured ? (
          <>
            {skillCandidate ? (
              <>
                <div className="mt-3">
                  <InsightKeyLabel>Description</InsightKeyLabel>
                  <InsightProse markdown={insight.description ?? ''} />
                </div>
                {keys.has('workflow') && (
                  <div className="mt-4">
                    <InsightKeyLabel>Workflow</InsightKeyLabel>
                    <InsightProse markdown={insight.workflow ?? ''} />
                  </div>
                )}
                <div className="mt-4">
                  <InsightKeyLabel>Example</InsightKeyLabel>
                  <InsightProse markdown={insight.example ?? ''} />
                </div>
              </>
            ) : (
              <>
                {keys.has('takeaway') && insight.takeaway && (
                  <div className="mt-3">
                    <InsightKeyLabel>Takeaway</InsightKeyLabel>
                    <InsightTakeaway markdown={insight.takeaway} />
                  </div>
                )}
                <dl className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
                  {insight.appliesWhen && (
                    <div>
                      <dt className="font-semibold text-foreground">
                        Applies when
                      </dt>
                      <dd>{insight.appliesWhen}</dd>
                    </div>
                  )}
                  {keys.has('scope') && insight.scope && (
                    <div>
                      <dt>
                        <InsightKeyLabel>Scope</InsightKeyLabel>
                      </dt>
                      <dd className="mt-1">{insight.scope}</dd>
                    </div>
                  )}
                  {insight.why && (
                    <div>
                      <dt className="font-semibold text-foreground">Why</dt>
                      <dd>{insight.why}</dd>
                    </div>
                  )}
                </dl>
                {insight.text && (
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {insight.text}
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
            {insight.text}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {structured && keys.has('evidence') && (
            <InsightKeyLabel>Evidence</InsightKeyLabel>
          )}
          {insight.evidence.map((line) => (
            <button
              key={line}
              type="button"
              className="rounded-[3px] bg-[color:var(--ui-callout)] px-1.5 py-0.5 font-mono text-xs text-foreground/80 transition-colors hover:bg-[color:var(--evidence-bg)] hover:text-[color:var(--evidence-strong)]"
              title={
                evidenceLabels
                  ? `Source ${evidenceLabels[line] ?? line} · editor line ${line}`
                  : undefined
              }
              onClick={() => onEvidence(line)}
            >
              {evidenceLabels?.[line] ?? line}
            </button>
          ))}
          {!insight.evidence.length && (
            <span
              className={cn(
                'text-xs',
                insight.authorship === 'reviewer'
                  ? 'text-muted-foreground'
                  : 'text-destructive',
              )}
            >
              {insight.authorship === 'reviewer'
                ? 'Evidence not provided (optional)'
                : insight.status === 'rejected'
                  ? 'Declined'
                  : 'Evidence needs repair'}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            aria-label={`Accept ${insight.id}`}
            title={`Accept ${insight.id}`}
            variant={insight.status === 'accepted' ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={() => onStatus('accepted')}
          >
            <Check />
          </Button>
          <Button
            aria-label={`Decline ${insight.id}`}
            title={`Decline ${insight.id}; keep in export`}
            variant={insight.status === 'rejected' ? 'destructive' : 'ghost'}
            size="icon-sm"
            onClick={() => onStatus('rejected')}
          >
            <X />
          </Button>
          <Button
            aria-label={`Edit ${insight.id}`}
            title={`Edit ${insight.id}`}
            variant="ghost"
            size="icon-sm"
            onClick={onEdit}
          >
            <PencilLine />
          </Button>
          <Button
            aria-label={`Delete ${insight.id}`}
            title={`Delete ${insight.id}`}
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </article>
  );
}
