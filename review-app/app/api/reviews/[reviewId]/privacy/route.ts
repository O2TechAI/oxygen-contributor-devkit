import { ReviewWriteError, sanitizeReviewHistory } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';

export async function POST(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const { reviewId } = await context.params;
    return Response.json(
      await sanitizeReviewHistory(reviewId, await request.json()),
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ReviewWriteError
            ? error.message
            : 'Unable to reset review history.',
      },
      {
        status: error instanceof ReviewWriteError ? error.status : 500,
        headers,
      },
    );
  }
}
