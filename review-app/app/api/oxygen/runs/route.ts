import { proxy } from '@/lib/bridge';

const MAX_BODY = 64 * 1024;

export async function GET(request: Request) {
  return proxy(request, '/runs');
}

export async function POST(request: Request) {
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
  return proxy(request, '/runs', { method: 'POST', body });
}
