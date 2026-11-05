import { exportReviews, getReviewHistory, listReviews } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { callBridge, proxy } from '@/lib/bridge';
import { historyFiles } from '@/lib/history-export';
import type { SubmittedReview } from '@/lib/oxygen-api';
import {
  globalRows,
  MAX_SUBMISSION_REVIEWS,
  selectionProblem,
  submissionRows,
  suggestedAgent,
  type SubmissionRun,
} from '@/lib/submission';
import { collectionFiles } from '@/lib/zip-export';

export async function GET(request: Request) {
  return proxy(request, '/submissions');
}

/**
 * Freeze the chosen reviews as a submission. The selection is checked again
 * here against the saved reviews, and refused if any changed since the
 * contributor looked at them.
 */
export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  let body: {
    reviewIds?: unknown;
    globalReviewIds?: unknown;
    updatedAt?: unknown;
    includeHistory?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const { reviewIds, updatedAt, includeHistory } = body ?? {};
  const globalReviewIds = body?.globalReviewIds ?? [];
  if (
    !Array.isArray(reviewIds) ||
    reviewIds.length > MAX_SUBMISSION_REVIEWS ||
    reviewIds.some((id) => typeof id !== 'string') ||
    !Array.isArray(globalReviewIds) ||
    globalReviewIds.length > 50 ||
    globalReviewIds.some((id) => typeof id !== 'string') ||
    new Set(globalReviewIds).size !== globalReviewIds.length ||
    !updatedAt ||
    typeof updatedAt !== 'object' ||
    typeof includeHistory !== 'boolean'
  ) {
    return Response.json(
      { error: 'The submission request is not valid.' },
      { status: 400 },
    );
  }
  const ids = reviewIds as string[];
  const runs = await callBridge('/runs');
  if (runs.status !== 200)
    return Response.json(runs.data, { status: runs.status });
  const known = ((runs.data as { runs?: SubmissionRun[] }).runs ??
    []) as SubmissionRun[];
  const reviews = await listReviews();
  const rows = submissionRows(reviews, known);
  const problem = selectionProblem(rows, ids);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  const chosen = ids.map((id) => rows.find((row) => row.review.id === id)!);
  // Completed global insights reviews travel with the trajectories, apart from them.
  const globals = globalRows(reviews);
  const chosenGlobals = (globalReviewIds as string[]).map((id) =>
    globals.find((row) => row.review.id === id),
  );
  const missing = chosenGlobals.findIndex((row) => !row);
  if (missing >= 0)
    return Response.json(
      { error: 'A chosen global insights review is no longer available.' },
      { status: 400 },
    );
  const unready = chosenGlobals.find((row) => row!.reason);
  if (unready)
    return Response.json(
      { error: `Global insights: ${unready.reason}` },
      { status: 400 },
    );
  const seen = updatedAt as Record<string, unknown>;
  if (
    [...chosen, ...chosenGlobals.map((row) => row!)].some(
      (row) => seen[row.review.id] !== row.review.updatedAt,
    )
  ) {
    return Response.json(
      {
        error:
          'A review changed after this page loaded. Reload and check the list again.',
      },
      { status: 409 },
    );
  }

  try {
    const exported = await exportReviews(ids);
    const files = collectionFiles(JSON.parse(exported.body));
    const global: Record<string, string> = {};
    if (chosenGlobals.length) {
      const bundle = JSON.parse(
        (await exportReviews(chosenGlobals.map((row) => row!.review.id))).body,
      ) as { reviews: { reviewId: string; files: Record<string, string> }[] };
      for (const item of bundle.reviews)
        for (const [name, text] of Object.entries(item.files))
          global[`${item.reviewId}/${name}`] = text;
    }
    const history: Record<string, string> = {};
    if (includeHistory) {
      for (const id of [
        ...ids,
        ...chosenGlobals.map((row) => row!.review.id),
      ]) {
        for (const [name, text] of Object.entries(
          historyFiles(await getReviewHistory(id)),
        ))
          history[`${id}/${name}`] = text;
      }
    }
    const submitted: SubmittedReview[] = chosen.map((row) => ({
      reviewId: row.review.id,
      projectName: row.review.projectName,
      sourcePath: row.review.sourcePath,
      run: row.run,
      trajectory: row.number,
      // The Summary heading of the redacted review, not the session's first request.
      title: row.title,
      privacyStatus: row.review.privacyStatus,
      version: row.review.version,
      updatedAt: row.review.updatedAt,
      accepted: row.counts.accepted,
      declined: row.counts.declined,
    }));
    const result = await callBridge('/submissions', {
      method: 'POST',
      body: {
        metadata: {
          reviews: submitted,
          globalReviews: chosenGlobals.map((row) => ({
            reviewId: row!.review.id,
            sourcePath: row!.review.sourcePath,
            generatedFrom: row!.origin,
            version: row!.review.version,
            updatedAt: row!.review.updatedAt,
            accepted: row!.counts.accepted,
            declined: row!.counts.declined,
          })),
          projects: [...new Set(submitted.map((item) => item.projectName))],
          suggestedAgent: suggestedAgent(chosen, known),
        },
        files,
        ...(chosenGlobals.length ? { global } : {}),
        ...(includeHistory ? { history } : {}),
      },
    });
    return Response.json(result.data, { status: result.status });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to submit.' },
      { status: 500 },
    );
  }
}
