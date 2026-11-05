import { proxy } from '@/lib/bridge';

const MAX_BODY = 4 * 1024;

export async function POST(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
) {
  const { submissionId } = await context.params;
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('Too large.');
    body = JSON.parse(text);
  } catch {
    return Response.json(
      { error: 'The request is not valid.' },
      { status: 400 },
    );
  }
  return proxy(
    request,
    `/submissions/${encodeURIComponent(submissionId)}/generations`,
    {
      method: 'POST',
      body,
    },
  );
}
