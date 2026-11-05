import { proxy } from '@/lib/bridge';

export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
) {
  const { submissionId } = await context.params;
  return proxy(request, `/submissions/${encodeURIComponent(submissionId)}`);
}
