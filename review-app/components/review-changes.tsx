'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { reviewDiff } from '@/lib/review-diff';
import type { ReviewHistorySnapshot } from '@/lib/review-types';
import { cn } from '@/lib/utils';

function subscribeToLocation(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

function requestedChanges() {
  return new URL(window.location.href).searchParams.get('changes');
}

export function ReviewChanges({
  reviewId,
  version,
}: {
  reviewId: string;
  version: number;
}) {
  const requested = useSyncExternalStore(
    subscribeToLocation,
    requestedChanges,
    () => null,
  );
  const [openOverride, setOpen] = useState<boolean>();
  const open = openOverride ?? requested !== null;
  const [selectedVersion, setSelectedVersion] = useState<number | null>();
  const [loaded, setLoaded] = useState<{
    key: string;
    snapshots: ReviewHistorySnapshot[];
    error?: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const loadKey = `${reviewId}:${version}:${refresh}`;
  // A different request or hidden panel can never display a previous cached history.
  const current = open && loaded?.key === loadKey ? loaded : undefined;
  const snapshots = current?.snapshots ?? [];
  const loading = open && !current;
  const error = current?.error;
  const targetVersion =
    selectedVersion === undefined
      ? requested && /^\d+$/.test(requested)
        ? Number(requested)
        : undefined
      : (selectedVersion ?? undefined);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    fetch(`/api/reviews/${encodeURIComponent(reviewId)}/revisions`, {
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load saved changes.');
        return response.json() as Promise<{
          snapshots: ReviewHistorySnapshot[];
        }>;
      })
      .then(({ snapshots: saved }) => {
        if (!abort.signal.aborted)
          setLoaded({
            key: loadKey,
            snapshots: [...saved].sort((a, b) => a.version - b.version),
          });
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setLoaded({
            key: loadKey,
            snapshots: [],
            error:
              reason instanceof Error
                ? reason.message
                : 'Unable to load saved changes.',
          });
      });
    return () => abort.abort();
  }, [open, reviewId, loadKey]);

  useEffect(() => {
    if (!open) return;
    const refreshHistory = () => setRefresh((value) => value + 1);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setLoaded(undefined);
      else refreshHistory();
    };
    window.addEventListener('focus', refreshHistory);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refreshHistory);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open]);

  const selected =
    snapshots.find((item) => item.version === targetVersion) ??
    snapshots.at(-1);
  const selectedIndex = selected ? snapshots.indexOf(selected) : -1;
  const previous = snapshots[selectedIndex - 1];
  const hunks =
    selected && previous ? reviewDiff(previous.state, selected.state) : [];

  useEffect(() => {
    if (!open || !selected) return;
    const url = new URL(window.location.href);
    url.searchParams.set('changes', String(selected.version));
    window.history.replaceState(null, '', url);
  }, [open, selected]);

  function changeOpen(next: boolean) {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('changes', String(version));
    else url.searchParams.delete('changes');
    window.history.replaceState(null, '', url);
    setOpen(next);
    if (!next) setLoaded(undefined);
  }

  function chooseVersion(next: number) {
    setSelectedVersion(next);
    const url = new URL(window.location.href);
    url.searchParams.set('changes', String(next));
    window.history.replaceState(null, '', url);
    // Fetch on each selection so a privacy rewrite cannot expose stale cached versions.
    setRefresh((value) => value + 1);
  }

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setSelectedVersion(null);
          changeOpen(true);
        }}
      >
        <History data-icon="inline-start" />
        Changes
      </Button>
      <Sheet open={open} onOpenChange={changeOpen}>
        <SheetContent className="gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader className="shrink-0 border-b px-5 py-5 pr-12">
            <SheetTitle>Saved changes</SheetTitle>
            <SheetDescription>
              Compare a saved request with the preceding version. Additions
              start with +; removals start with −.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {loading && <output>Loading saved changes…</output>}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {!loading && !error && selected && (
              <>
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  Saved version
                  <select
                    aria-label="Compare saved version"
                    value={selected.version}
                    onChange={(event) =>
                      chooseVersion(Number(event.target.value))
                    }
                    className="max-w-full rounded border bg-background p-2"
                  >
                    {snapshots.map((snapshot) => (
                      <option key={snapshot.version} value={snapshot.version}>
                        Version {snapshot.version}
                        {snapshot.kind === 'initial'
                          ? ' · Initial'
                          : snapshot.kind === 'privacy'
                            ? ' · Privacy cleanup'
                            : ''}{' '}
                        · {new Date(snapshot.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                {selected.note && (
                  <p className="whitespace-pre-wrap break-words rounded border bg-muted/40 p-3 text-sm leading-6">
                    {selected.note}
                  </p>
                )}
                {selected.kind === 'privacy' && (
                  <p className="text-sm text-muted-foreground">
                    History has been sanitized. Removed sensitive text is not
                    shown in this comparison.
                  </p>
                )}
                {!previous ? (
                  <p className="text-sm text-muted-foreground">
                    Initial state. No earlier comparison is available.
                  </p>
                ) : !hunks.length ? (
                  <p className="text-sm text-muted-foreground">
                    No insight changes.
                  </p>
                ) : (
                  <div
                    aria-label="Unified review diff"
                    className="overflow-hidden rounded border font-mono text-sm leading-6"
                  >
                    {hunks.map((hunk, hunkIndex) => (
                      <div key={hunkIndex}>
                        <div className="break-words border-y bg-muted px-3 py-1 text-muted-foreground">
                          {hunk.heading}
                        </div>
                        {hunk.lines.map((line, index) => (
                          <div
                            key={index}
                            className={cn(
                              'flex whitespace-pre-wrap break-words px-3',
                              line.kind === 'added' &&
                                'bg-green-50 text-green-950 dark:bg-green-950 dark:text-green-100',
                              line.kind === 'removed' &&
                                'bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-100',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className="mr-2 w-3 shrink-0 select-none"
                            >
                              {line.kind === 'added'
                                ? '+'
                                : line.kind === 'removed'
                                  ? '−'
                                  : ' '}
                            </span>
                            {line.kind !== 'context' && (
                              <span className="sr-only">
                                {line.kind === 'added'
                                  ? 'Added: '
                                  : 'Removed: '}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              {line.text || ' '}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
