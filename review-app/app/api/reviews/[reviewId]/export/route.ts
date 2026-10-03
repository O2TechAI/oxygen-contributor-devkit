import { exportReview } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  try {
    const { reviewId } = await context.params;
    const exported = await exportReview(reviewId);
    return new Response(exported.body, {
      headers: {
        'content-type': exported.contentType,
        'content-disposition': `attachment; filename="${exported.filename}"`,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to export review.';
    return Response.json(
      { error: message },
      { status: message === 'Review not found.' ? 404 : 500 },
    );
  }
}
