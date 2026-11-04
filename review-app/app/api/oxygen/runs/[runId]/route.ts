import { proxy } from '@/lib/bridge';

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return proxy(request, `/runs/${encodeURIComponent(runId)}`);
}
