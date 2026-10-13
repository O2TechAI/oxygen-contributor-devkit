import {
  getReviewHistory,
  ReviewWriteError,
  saveReviewRevision,
  validWriteIdentity,
} from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { isValidPayload } from '@/lib/review-validation';

const headers = { 'Cache-Control': 'no-store' };

function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof ReviewWriteError
          ? error.message
          : 'Unable to access the review revision.',
    },
    { status: error instanceof ReviewWriteError ? error.status : 500, headers },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  try {
    const { reviewId } = await context.params;
    return Response.json(await getReviewHistory(reviewId), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  try {
    const payload: unknown = await request.json();
    if (!isValidPayload(payload) || !validWriteIdentity(payload)) {
      return Response.json(
        {
          error:
            'Invalid review revision: a saved version and unique request ID are required.',
        },
        { status: 400, headers },
      );
    }
    const { reviewId } = await context.params;
    return Response.json(await saveReviewRevision(reviewId, payload), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
