import { proxy } from '@/lib/bridge';

export async function GET(request: Request) {
  const workspace = new URL(request.url).searchParams.get('workspace') ?? '';
  return proxy(request, `/sessions?workspace=${encodeURIComponent(workspace)}`);
}
