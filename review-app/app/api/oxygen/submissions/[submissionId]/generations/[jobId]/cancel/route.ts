import { proxy } from '@/lib/bridge';

export async function POST(
  request: Request,
  context: { params: Promise<{ submissionId: string; jobId: string }> },
) {
  const { submissionId, jobId } = await context.params;
  return proxy(
    request,
    `/submissions/${encodeURIComponent(submissionId)}/generations/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' },
  );
}
