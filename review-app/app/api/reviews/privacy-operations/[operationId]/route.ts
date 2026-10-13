import { getPrivacyResetResult, ReviewWriteError } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';

export async function GET(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const { operationId } = await context.params;
    return Response.json(await getPrivacyResetResult(operationId), { headers });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ReviewWriteError
            ? error.message
            : 'Unable to recover the saved baseline.',
      },
      {
        status: error instanceof ReviewWriteError ? error.status : 500,
        headers,
      },
    );
  }
}
