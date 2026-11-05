import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import { callBridge } from '@/lib/bridge';
import { zipFiles } from '@/lib/zip-export';

/** The contribution package: the frozen files exactly as submitted. */
export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const { submissionId } = await context.params;
  const result = await callBridge(
    `/submissions/${encodeURIComponent(submissionId)}/files`,
  );
  if (result.status !== 200)
    return Response.json(result.data, { status: result.status });
  const files = (result.data as { files: Record<string, string> }).files;
  const name = `oxygen-submission-${submissionId.replace(/[^0-9A-Za-z-]/g, '')}.zip`;
  return new Response(zipFiles(files), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}
