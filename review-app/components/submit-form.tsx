'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CircleCheck } from 'lucide-react';

import { SubmitChecklist } from '@/components/submit-checklist';
import { Button } from '@/components/ui/button';
import { postJson, type Submission } from '@/lib/oxygen-api';
import type { Review } from '@/lib/review-types';
import {
  defaultGlobalSelection,
  defaultSubmissionSelection,
  globalCurrent,
  globalRows,
  selectionProblem,
  submissionRows,
  toggleSubmission,
  visibleSubmissionRows,
} from '@/lib/submission';
import { formatWhen, type IndexRun } from '@/lib/trajectory-index';
import { cn } from '@/lib/utils';

function trajectories(count: number) {
  return `${count} ${count === 1 ? 'trajectory' : 'trajectories'}`;
}

function Checkbox({
  checked,
  disabled,
  onChange,
  children,
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    // relative: keeps the visually hidden checkbox in its row (see runs/new).
    <label
      className={cn(
        'relative flex items-start gap-3 text-sm',
        disabled ? 'cursor-default' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[3px] border peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
          checked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-[color:var(--input)] bg-background',
          disabled && 'opacity-40',
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/**
 * The one way to hand in work: choose the labeled trajectories (and completed
 * global insights), then freeze them as a submission on this computer. Used by
 * the Submit page and by the review page's Submit button.
 */
export function SubmitForm({
  reviews,
  runs,
  submissions,
  onSubmitted,
}: {
  reviews: Review[];
  runs: IndexRun[];
  /** Earlier submissions, to tell whether global insights are current. */
  submissions: Submission[];
  onSubmitted: (submissionId: string) => void;
}) {
  const rows = submissionRows(reviews, runs);
  const shown = visibleSubmissionRows(rows);
  const globals = globalRows(reviews);
  // null until the contributor changes the default selection.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedGlobal, setPickedGlobal] = useState<string[] | null>(null);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selected = picked ?? defaultSubmissionSelection(rows);
  const selectedGlobal = pickedGlobal ?? defaultGlobalSelection(globals);
  const chosen = rows.filter((row) => selected.includes(row.review.id));
  const chosenGlobals = globals.filter((row) =>
    selectedGlobal.includes(row.review.id),
  );
  const totals = chosen.reduce(
    (sum, row) => ({
      accepted: sum.accepted + row.counts.accepted,
      declined: sum.declined + row.counts.declined,
    }),
    { accepted: 0, declined: 0 },
  );
  const groups = new Set(shown.map((row) => row.group)).size;
  const ready = new Set(
    shown.filter((row) => !row.reason).map((row) => row.group),
  ).size;
  const unredacted = chosen.filter(
    (row) => row.version === 'unredacted',
  ).length;
  const problem = selectionProblem(rows, selected);
  const status = (id: string) =>
    globalCurrent(
      globals.find((row) => row.review.id === id)!,
      submissions,
      reviews,
      selected,
    );
  const currentGlobal = globals.find(
    (row) => !row.reason && status(row.review.id).current,
  );

  async function submit() {
    if (problem || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const { id } = await postJson<{ id: string }>('/api/oxygen/submissions', {
        reviewIds: selected,
        globalReviewIds: selectedGlobal,
        updatedAt: Object.fromEntries(
          [...chosen, ...chosenGlobals].map((row) => [
            row.review.id,
            row.review.updatedAt,
          ]),
        ),
        includeHistory,
      });
      onSubmitted(id);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to submit.',
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-7">
      {currentGlobal && (
        <p className="flex items-start gap-2 rounded-[6px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            Global insights for these trajectories are complete. They are
            included in this submission; nothing needs to be generated again.
          </span>
        </p>
      )}

      {shown.length === 0 ? (
        <p className="rounded-[6px] border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No trajectories have been reviewed yet.
        </p>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {selected.length} of {groups} selected · {ready} ready to submit
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPicked(defaultSubmissionSelection(rows))}
              >
                All ready
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
                None
              </Button>
            </div>
          </div>
          <SubmitChecklist
            rows={shown}
            selected={selected}
            onToggle={(id) => setPicked(toggleSubmission(selected, rows, id))}
          />
        </div>
      )}

      {globals.length > 0 && (
        <section aria-label="Global insights">
          <h2 className="text-sm font-medium">Global insights</h2>
          <ul className="mt-3 divide-y rounded-[6px] border bg-card">
            {globals.map((row) => {
              const id = row.review.id;
              const state = status(id);
              return (
                <li key={id} className="px-3 py-2.5">
                  <Checkbox
                    checked={selectedGlobal.includes(id)}
                    disabled={!!row.reason}
                    onChange={() =>
                      setPickedGlobal(
                        selectedGlobal.includes(id)
                          ? selectedGlobal.filter((item) => item !== id)
                          : [...selectedGlobal, id],
                      )
                    }
                  >
                    <span className="block truncate font-medium">
                      Global insights of{' '}
                      {formatWhen(
                        row.review.generatedAt || row.review.updatedAt,
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {row.counts.accepted} accepted · {row.counts.declined}{' '}
                      declined
                      {row.counts.pending > 0 &&
                        ` · ${row.counts.pending} open`}
                      {' · '}
                      {row.reason
                        ? row.reason
                        : state.current
                          ? 'complete for these trajectories'
                          : state.known && state.changed
                            ? `${state.changed} of its trajectories changed since`
                            : state.known
                              ? 'made from a different set of trajectories'
                              : 'completed'}
                    </span>
                  </Checkbox>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="Edit history" className="pt-2">
        <h2 className="text-sm font-medium">Edit history</h2>
        <Checkbox
          checked={includeHistory}
          onChange={() => setIncludeHistory((value) => !value)}
          className="mt-3 rounded-[6px] border bg-card px-3 py-2.5"
        >
          Include edit history and agent requests
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            Every saved version, with the requests you typed to the agent. Those
            requests may contain details you would not want to share; they are
            kept apart from the reviews and are not used to generate insights.
          </span>
        </Checkbox>
      </section>

      <div className="space-y-3 border-t pt-5">
        {unredacted > 0 && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[6px] border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {unredacted === 1
                ? '1 trajectory is submitted in its unredacted version.'
                : `${unredacted} trajectories are submitted in their unredacted versions.`}{' '}
              Unredacted text has not been through privacy redaction and can
              contain names, paths, credentials or other private details. It is
              included in the contribution package and sent to the model if you
              generate cross-session insights.
            </span>
          </p>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          A frozen copy is saved on this computer; later edits do not change it
          and you can submit again. Nothing is uploaded. Next you can download
          the contribution package and generate cross-session insights.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">
            {trajectories(selected.length)}
            {chosenGlobals.length > 0 && ' + global insights'}{' '}
            <span className="text-muted-foreground">
              · {totals.accepted} accepted · {totals.declined} declined
            </span>
          </span>
          <Button
            disabled={!!problem || submitting}
            title={problem ?? undefined}
            onClick={() => void submit()}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </Button>
        </div>
      </div>
    </div>
  );
}
