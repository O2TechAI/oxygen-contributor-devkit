import { loginResponse } from '@/lib/auth';

export async function POST(request: Request) {
  let payload: { username?: unknown; password?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: 'Invalid login request.' }, { status: 400 });
  }
  if (
    typeof payload.username !== 'string' ||
    typeof payload.password !== 'string'
  ) {
    return Response.json(
      { error: 'Account and password are required.' },
      { status: 400 },
    );
  }
  return loginResponse(request, payload.username, payload.password);
}
