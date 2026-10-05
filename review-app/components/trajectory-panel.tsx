'use client';

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ExportLabelingWarning } from '@/components/export-labeling-warning';
import { exportLabelingSummary } from '@/lib/export-labeling';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import {
  decisionCounts,
  filterTrajectories,
  groupTrajectories,
  reviewVersion,
  trajectoryIdentity,
} from '@/lib/trajectory-list';
import type { Review } from '@/lib/review-types';

export function TrajectoryPanel({
  reviews,
  active,
  open,
  onOpenChange,
  selectedIds,
  setSelectedIds,
  onOpenReview,
  unsaved,
}: {
  reviews: Review[];
  active: Review;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  setSelectedIds: Dispatch<SetStateAction<string[]>>;
  onOpenReview: (id: string) => void;
  unsaved: boolean;
}) {
  const groups = useMemo(() => groupTrajectories(reviews), [reviews]);
  const activeRun = trajectoryIdentity(active.sourcePath, active.id).run;
  const [query, setQuery] = useState('');
  const [run, setRun] = useState(activeRun);
  const [version, setVersion] = useState('all');
  const [status, setStatus] = useState('all');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [format, setFormat] = useState('zip');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState('');
  const [labelingWarning, setLabelingWarning] = useState(false);
  const visible = filterTrajectories(
    groups,
    { query, run, version, status, selectedOnly },
    selectedIds,
  );
  const selected = reviews.filter((review) => selectedIds.includes(review.id));
  const selectedGroups = groupTrajectories(selected);
  const counts = exportLabelingSummary(selected);
  const visibleIds = new Set(
    visible.flatMap((group) => group.reviews.map((review) => review.id)),
  );
  const hiddenCount = selected.filter(
    (review) => !visibleIds.has(review.id),
  ).length;
  const runs = [...new Set(groups.map((group) => group.run))];
  const selectClass =
    'h-8 min-w-0 rounded-[4px] border bg-background px-2 text-sm';

  function toggle(ids: string[], checked: boolean) {
    setSelectedIds((current) =>
      checked
        ? [...new Set([...current, ...ids])]
        : current.filter((id) => !ids.includes(id)),
    );
    setDownloaded('');
  }

  function openReview(id: string) {
    if (unsaved) return;
    onOpenReview(id);
    onOpenChange(false);
  }

  async function download() {
    if (unsaved || pending || !selected.length || selected.length > 500) return;
    setPending(true);
    setError('');
    setDownloaded('');
    try {
      const response = await fetch('/api/reviews/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewIds: selected.map((review) => review.id),
          format,
        }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(result?.error || 'Export failed.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download =
        response.headers
          .get('content-disposition')
          ?.match(/filename="([^"]+)"/)?.[1] ?? `oxygen-reviews.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDownloaded(
        `Downloaded ${selectedGroups.length} trajectories (${selected.length} versions).`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <SheetContent
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-5xl"
        showCloseButton={!pending}
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Trajectories</SheetTitle>
          <SheetDescription>
            Choose trajectories, review their versions, and download your
            selection together. Redacted versions are selected by default;
            originals can be selected manually.
          </SheetDescription>
        </SheetHeader>
        <fieldset
          disabled={pending}
          className="grid min-h-0 flex-1 grid-rows-[auto_1fr]"
        >
          <div className="space-y-3 border-b bg-[color:var(--sidebar)] p-4">
            <Input
              aria-label="Search trajectories"
              placeholder="Search trajectory, title, or run…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select
                aria-label="Filter by run"
                className={selectClass}
                value={run}
                disabled={selectedOnly}
                onChange={(event) => setRun(event.target.value)}
              >
                {runs.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by version"
                className={selectClass}
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              >
                <option value="all">All versions</option>
                <option value="original">Original</option>
                <option value="redacted">Redacted</option>
              </select>
              <select
                aria-label="Filter by review status"
                className={selectClass}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">All review statuses</option>
                <option value="ready">Ready</option>
                <option value="in_review">In review</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => toggle([...visibleIds], true)}
              >
                Select all filtered
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const currentRun = filterTrajectories(
                    groups,
                    {
                      query: '',
                      run: activeRun,
                      version,
                      status: 'all',
                      selectedOnly: false,
                    },
                    [],
                  );
                  toggle(
                    currentRun.flatMap((group) =>
                      group.reviews.map((review) => review.id),
                    ),
                    true,
                  );
                }}
              >
                Select all in current run
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelectedIds([]);
                  setDownloaded('');
                }}
              >
                Clear selection
              </Button>
              <Button
                size="sm"
                variant={selectedOnly ? 'secondary' : 'ghost'}
                onClick={() => {
                  if (!selectedOnly) {
                    setVersion('all');
                    setStatus('all');
                    setQuery('');
                  }
                  setSelectedOnly(!selectedOnly);
                }}
              >
                {selectedOnly
                  ? 'Show all trajectories'
                  : `View selected (${selectedGroups.length})`}
              </Button>
            </div>
          </div>
          <div className="min-h-0 overflow-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Trajectories and their review versions
              </caption>
              <thead className="sticky top-0 z-10 border-b bg-background text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 p-3">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="p-3">Trajectory</th>
                  <th className="p-3">Versions and decisions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((group) => {
                  const ids = group.reviews.map((review) => review.id);
                  const checked = ids.filter((id) =>
                    selectedIds.includes(id),
                  ).length;
                  const name = group.number
                    ? `Trajectory ${group.number}`
                    : group.title;
                  return (
                    <tr
                      key={group.key}
                      className="border-b align-top hover:bg-muted/20"
                    >
                      <td className="p-3 pt-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${name} in ${group.run}`}
                          checked={checked === ids.length}
                          ref={(node) => {
                            if (node)
                              node.indeterminate =
                                checked > 0 && checked < ids.length;
                          }}
                          onChange={(event) =>
                            toggle(ids, event.target.checked)
                          }
                        />
                      </td>
                      <td className="max-w-64 p-3">
                        <button
                          type="button"
                          disabled={unsaved}
                          className="text-left font-semibold underline-offset-4 hover:underline disabled:opacity-50"
                          onClick={() => openReview(group.reviews[0].id)}
                        >
                          {name}
                        </button>
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {group.title}
                        </p>
                        <p className="mt-1 break-all text-[11px] text-muted-foreground">
                          {group.run}
                        </p>
                      </td>
                      <td className="p-3">
                        <div className="space-y-3">
                          {[...group.reviews]
                            .sort((a, b) =>
                              reviewVersion(a).localeCompare(reviewVersion(b)),
                            )
                            .map((review) => {
                              const totals = decisionCounts([review]);
                              const label = reviewVersion(review);
                              return (
                                <div
                                  key={review.id}
                                  className="flex items-start gap-2"
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-1"
                                    aria-label={`Select ${name} ${label} ${review.id}`}
                                    checked={selectedIds.includes(review.id)}
                                    onChange={(event) =>
                                      toggle([review.id], event.target.checked)
                                    }
                                  />
                                  <div>
                                    <button
                                      type="button"
                                      disabled={unsaved}
                                      className="font-medium underline-offset-4 hover:underline disabled:opacity-50"
                                      onClick={() => openReview(review.id)}
                                    >
                                      {label}
                                    </button>
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      {review.status === 'in_review'
                                        ? 'In review'
                                        : review.status === 'completed'
                                          ? 'Completed'
                                          : 'Ready'}
                                    </span>
                                    {group.reviews.filter(
                                      (item) => reviewVersion(item) === label,
                                    ).length > 1 && (
                                      <span className="ml-2 text-xs">
                                        {review.id}
                                      </span>
                                    )}
                                    <p className="mt-0.5 text-xs text-muted-foreground">
                                      {totals.accepted} accepted ·{' '}
                                      {totals.declined} declined ·{' '}
                                      {totals.pending} pending
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visible.length && (
              <p className="p-8 text-center text-muted-foreground">
                No trajectories match these filters.
              </p>
            )}
          </div>
        </fieldset>
        <SheetFooter className="border-t bg-background">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div aria-live="polite">
              <p className="font-semibold">
                {selectedGroups.length} trajectories · {selected.length}{' '}
                versions selected
              </p>
              <p className="text-sm text-muted-foreground">
                {counts.accepted} accepted · {counts.declined} declined insights
                to export
              </p>
              {hiddenCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {hiddenCount} selected versions are outside the current
                  filters.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                aria-label="Export format"
                className={selectClass}
                value={format}
                disabled={pending}
                onChange={(event) => setFormat(event.target.value)}
              >
                <option value="zip">ZIP — readable files</option>
                <option value="json">Combined JSON</option>
              </select>
              <Button
                disabled={
                  pending ||
                  unsaved ||
                  !selected.length ||
                  selected.length > 500
                }
                onClick={() => {
                  if (counts.incompleteReviews > 0) setLabelingWarning(true);
                  else void download();
                }}
              >
                <Download data-icon="inline-start" />
                {pending
                  ? 'Exporting…'
                  : `Export selected (${selectedGroups.length})`}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Includes only the latest saved summaries and accepted/declined
            insights. Pending insights count as accepted in the export; saved
            labels stay unchanged. Deleted insights are excluded.
          </p>
          {selected.length > 0 && counts.accepted + counts.declined === 0 && (
            <p className="text-xs text-muted-foreground">
              No exportable insights yet; this download will contain summaries
              only.
            </p>
          )}
          {selected.length > 500 && (
            <p role="alert">Select at most 500 review versions per download.</p>
          )}
          {counts.incompleteReviews > 0 && (
            <p
              role="status"
              className="text-sm text-amber-700 dark:text-amber-400"
            >
              Labeling incomplete: {counts.pending} pending insights will export
              as accepted.
              {counts.needsReview > 0 && (
                <>
                  {' '}
                  {counts.needsReview} with changed evidence will remain
                  excluded.
                </>
              )}
            </p>
          )}
          {unsaved && (
            <p role="status">
              Apply and save your edits before opening another review or
              exporting.
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {downloaded && <p role="status">{downloaded}</p>}
        </SheetFooter>
        <ExportLabelingWarning
          reviews={selected}
          open={labelingWarning}
          onOpenChange={setLabelingWarning}
          onConfirm={() => void download()}
        />
      </SheetContent>
    </Sheet>
  );
}
