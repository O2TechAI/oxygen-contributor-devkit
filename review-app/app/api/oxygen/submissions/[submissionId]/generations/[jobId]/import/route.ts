import { createReview, listReviews } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { callBridge } from '@/lib/bridge';
import { globalImportPayload } from '@/lib/global-review';
import type { Submission } from '@/lib/oxygen-api';

type Imported = { reviewId: string | null };

// Every open page imports a finished job; only one may create the review.
const inFlight = new Map<string, Promise<Imported>>();

async function importJob(
  submissionId: string,
  jobId: string,
): Promise<Imported> {
  const base = `/submissions/${encodeURIComponent(submissionId)}`;
  const detail = await callBridge(base);
  if (detail.status !== 200) {
    throw new Error(
      (detail.data as { error?: string }).error ??
        'The submission was not found.',
    );
  }
  const job = (detail.data as Submission).jobs.find(
    (item) => item.id === jobId,
  );
  if (!job || job.phase !== 'done')
    throw new Error('The insights are not ready.');
  if (job.imported?.reviewId) return { reviewId: job.imported.reviewId };
  if (!job.candidateCount) return { reviewId: null };

  // Imported before the bridge recorded it (e.g. the app stopped in between).
  const sourcePath = `submission-${submissionId}-insights-${jobId}`;
  const existing = (await listReviews()).find(
    (review) =>
      review.reviewLevel === 'global' && review.sourcePath === sourcePath,
  );
  let reviewId = existing?.id;
  if (!reviewId) {
    const result = await callBridge(
      `${base}/generations/${encodeURIComponent(jobId)}/result`,
    );
    if (result.status !== 200) {
      throw new Error(
        (result.data as { error?: string }).error ??
          'The insights cannot be read.',
      );
    }
    reviewId = (
      await createReview(globalImportPayload(result.data, { sourcePath }))
    ).id;
  }
  await callBridge(
    `${base}/generations/${encodeURIComponent(jobId)}/imported`,
    {
      method: 'POST',
      body: { reviewId },
    },
  );
  return { reviewId };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ submissionId: string; jobId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const { submissionId, jobId } = await context.params;
  const key = `${submissionId}:${jobId}`;
  let work = inFlight.get(key);
  if (!work) {
    work = importJob(submissionId, jobId).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
  }
  try {
    return Response.json(await work);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to import the insights.',
      },
      { status: 502 },
    );
  }
}
