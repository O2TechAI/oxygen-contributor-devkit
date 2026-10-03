import { listReviews, saveRevision } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { isValidPayload, isValidV5Review } from '@/lib/review-validation';

export async function POST(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  try {
    const payload: unknown = await request.json();
    if (!isValidPayload(payload)) {
      return Response.json(
        { error: 'Invalid review revision.' },
        { status: 400 },
      );
    }
    const { reviewId } = await context.params;
    const review = (await listReviews()).find((item) => item.id === reviewId);
    if (!review) {
      return Response.json({ error: 'Review not found.' }, { status: 404 });
    }
    if (!isValidV5Review(review, payload)) {
      return Response.json(
        {
          error:
            'The v5 revision has invalid fields, evidence, line IDs, or completion state.',
        },
        { status: 400 },
      );
    }
    return Response.json({ review: await saveRevision(reviewId, payload) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to save review.';
    return Response.json(
      { error: message },
      { status: message === 'Review not found.' ? 404 : 500 },
    );
  }
}
