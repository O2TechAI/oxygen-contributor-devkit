'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AppShell } from '@/components/oxygen/app-shell';
import { ServiceNotice } from '@/components/oxygen/service-notice';
import { SubmitForm } from '@/components/submit-form';
import { useInsightJobsContext } from '@/hooks/use-insight-jobs';
import { api, ApiError, type RunListItem } from '@/lib/oxygen-api';
import type { Review } from '@/lib/review-types';

export default function SubmitPage() {
  return (
    <AppShell active="submit">
      <Submit />
    </AppShell>
  );
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function Submit() {
  const jobs = useInsightJobsContext();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api<{ reviews: Review[] }>('/api/reviews')
      .then((result) => !cancelled && setReviews(result.reviews))
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof ApiError && failure.status === 401)
          window.location.reload();
        else
          setError(
            failure instanceof Error ? failure.message : 'Unable to load.',
          );
      });
    api<{ runs: RunListItem[] }>('/api/oxygen/runs')
      .then((result) => !cancelled && setRuns(result.runs))
      .catch((failure: unknown) => {
        if (cancelled) return;
        setRuns([]);
        if (failure instanceof ApiError && failure.reason)
          setUnavailable(failure.reason);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const past = jobs?.submissions?.length ?? 0;

  return (
    <main className="mx-auto w-full max-w-[760px] px-4 py-8 pb-16 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Submit trajectories</h1>
        {past > 0 && (
          <Link
            href="/submissions"
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {plural(past, 'earlier submission')}
          </Link>
        )}
      </div>
      <p className="mt-1 mb-6 text-sm leading-6 text-muted-foreground">
        Choose which labeled trajectories to hand in. Every completed trajectory
        is checked (its redacted version when both were completed), and so are
        completed global insights; uncheck any you want to keep out.
      </p>
      {unavailable ? (
        <ServiceNotice reason={unavailable} />
      ) : reviews === null || runs === null ? (
        <p className="mt-10 text-sm text-muted-foreground">
          {error || 'Loading reviews…'}
        </p>
      ) : (
        <SubmitForm
          reviews={reviews}
          runs={runs}
          submissions={jobs?.submissions ?? []}
          onSubmitted={(id) => {
            void jobs?.refresh();
            window.location.assign(`/submissions?id=${id}`);
          }}
        />
      )}
    </main>
  );
}
