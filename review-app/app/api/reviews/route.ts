import { createReview, listReviews } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { isReviewCreatePayload } from '@/lib/review-import';

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  try {
    return Response.json({ reviews: await listReviews() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to load reviews.';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  try {
    const payload: unknown = await request.json();
    if (!isReviewCreatePayload(payload)) {
      return Response.json(
        {
          error: 'The review payload is incomplete.',
        },
        { status: 400 },
      );
    }
    return Response.json(
      { review: await createReview(payload) },
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to create review.';
    return Response.json({ error: message }, { status: 400 });
  }
}
