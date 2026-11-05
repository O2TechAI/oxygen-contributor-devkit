'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  api,
  postJson,
  type InsightJob,
  type Submission,
} from '@/lib/oxygen-api';
import { isActivePhase } from '@/lib/run-progress';

const POLL_MS = 4000;
const DISMISSED_KEY = 'oxygen-dismissed-insight-jobs';
/** A finished job is announced for a day unless dismissed. */
const ANNOUNCE_MS = 24 * 60 * 60 * 1000;

/** A finished job whose result still has to become a Global insights review. */
export function needsImport(job: InsightJob) {
  return job.phase === 'done' && !!job.candidateCount && !job.imported;
}

function readDismissed(): string[] {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(DISMISSED_KEY) ?? '[]',
    ) as unknown;
    return Array.isArray(saved)
      ? saved.filter((item) => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export type InsightJobs = {
  /** null until the first load; empty when the service is unavailable. */
  submissions: Submission[] | null;
  refresh: () => Promise<void>;
  /** Imported results to announce. */
  ready: { job: InsightJob; reviewId: string }[];
  dismiss: (jobId: string) => void;
  importing: string[];
};

export const InsightJobsContext = createContext<InsightJobs | null>(null);

export function useInsightJobsContext() {
  return useContext(InsightJobsContext);
}

/**
 * Submissions and their cross-session jobs. While a job runs, poll; when one
 * finishes, import its result as a Global insights review (the server makes
 * this idempotent, so several open pages may try).
 */
export function useInsightJobs(enabled: boolean): InsightJobs {
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [importing, setImporting] = useState<string[]>([]);
  const attempted = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ submissions: Submission[] }>(
        '/api/oxygen/submissions',
      );
      setSubmissions(result.submissions);
    } catch {
      setSubmissions((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const jobs = (submissions ?? []).flatMap((item) => item.jobs);
  const busy = jobs.some((job) => isActivePhase(job.phase) || needsImport(job));

  useEffect(() => {
    if (!enabled || !busy) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, busy, refresh]);

  useEffect(() => {
    if (!enabled) return;
    for (const job of jobs) {
      const key = `${job.submissionId}:${job.id}`;
      if (!needsImport(job) || attempted.current.has(key)) continue;
      attempted.current.add(key);
      setImporting((current) => [...current, job.id]);
      postJson(
        `/api/oxygen/submissions/${job.submissionId}/generations/${job.id}/import`,
        {},
      )
        .catch(() => {
          // Allow another attempt on the next poll.
          attempted.current.delete(key);
        })
        .finally(() => {
          setImporting((current) => current.filter((id) => id !== job.id));
          void refresh();
        });
    }
  });

  const dismiss = useCallback((jobId: string) => {
    setDismissed((current) => {
      const next = [...new Set([...current, jobId])].slice(-100);
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        // Not remembering the dismissal is harmless.
      }
      return next;
    });
  }, []);

  const now = Date.now();
  const ready = jobs
    .filter(
      (job) =>
        job.imported?.reviewId &&
        !dismissed.includes(job.id) &&
        now - Date.parse(job.imported.importedAt) < ANNOUNCE_MS,
    )
    .map((job) => ({ job, reviewId: job.imported!.reviewId! }));

  return { submissions, refresh, ready, dismiss, importing };
}
