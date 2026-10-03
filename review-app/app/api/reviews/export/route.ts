import { exportReviews } from '@/db/reviews';
import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { collectionZip } from '@/lib/zip-export';

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const reviewIds = (payload as { reviewIds?: unknown } | null)?.reviewIds;
  const format = (payload as { format?: unknown } | null)?.format ?? 'json';
  if (format !== 'json' && format !== 'zip') {
    return Response.json({ error: 'Choose ZIP or JSON.' }, { status: 400 });
  }
  if (
    !Array.isArray(reviewIds) ||
    !reviewIds.length ||
    reviewIds.length > 500 ||
    reviewIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(reviewIds).size !== reviewIds.length
  ) {
    return Response.json(
      { error: 'Select between 1 and 500 distinct reviews.' },
      { status: 400 },
    );
  }
  try {
    const exported = await exportReviews(reviewIds);
    const body =
      format === 'zip'
        ? collectionZip(JSON.parse(exported.body))
        : exported.body;
    const filename =
      format === 'zip'
        ? exported.filename.replace(/\.json$/, '.zip')
        : exported.filename;
    return new Response(body, {
      headers: {
        'content-type':
          format === 'zip' ? 'application/zip' : exported.contentType,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to export reviews.';
    return Response.json(
      { error: message },
      {
        status: message === 'Review not found.' ? 404 : 500,
      },
    );
  }
}
