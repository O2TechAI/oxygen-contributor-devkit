import { createReview } from '@/db/reviews';
import { callBridge } from '@/lib/bridge';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { isReviewCreatePayload } from '@/lib/review-import';

type Imported = { redaction: string; humanize: string };

// Two clicks on the same trajectory must not create the reviews twice.
const inFlight = new Map<string, Promise<Imported>>();

async function importTrajectory(runId: string, index: number) {
  const base = `/runs/${encodeURIComponent(runId)}`;
  const state = await callBridge(base);
  if (state.status !== 200) {
    throw new Error(
      (state.data as { error?: string }).error ?? 'The run was not found.',
    );
  }
  const existing = (state.data as { imports?: Record<string, Imported> })
    .imports?.[String(index)];
  if (existing) return existing;

  const prepared = await callBridge(`${base}/trajectories/${index}/payloads`);
  if (prepared.status !== 200) {
    throw new Error(
      (prepared.data as { error?: string }).error ??
        'The trajectory is not ready.',
    );
  }
  const payloads = prepared.data as Record<string, unknown>;
  if (
    !isReviewCreatePayload(payloads.humanize) ||
    !isReviewCreatePayload(payloads.redaction)
  ) {
    throw new Error('The generated review is incomplete.');
  }
  // Same order as the publisher: the redacted review is the newest.
  const humanize = await createReview(payloads.humanize);
  const redaction = await createReview(payloads.redaction);
  const imported = { redaction: redaction.id, humanize: humanize.id };
  await callBridge(`${base}/trajectories/${index}/imported`, {
    method: 'POST',
    body: imported,
  });
  return imported;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const { runId } = await context.params;
  let index: unknown;
  try {
    ({ index } = (await request.json()) as { index?: unknown });
  } catch {
    index = undefined;
  }
  if (!Number.isInteger(index) || (index as number) < 1) {
    return Response.json(
      { error: 'A trajectory is required.' },
      { status: 400 },
    );
  }
  const key = `${runId}:${String(index)}`;
  let work = inFlight.get(key);
  if (!work) {
    work = importTrajectory(runId, index as number).finally(() =>
      inFlight.delete(key),
    );
    inFlight.set(key, work);
  }
  try {
    return Response.json({ reviews: await work });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Unable to open the review.',
      },
      { status: 502 },
    );
  }
}
