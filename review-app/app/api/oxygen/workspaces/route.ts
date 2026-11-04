import { proxy } from '@/lib/bridge';

export async function GET(request: Request) {
  return proxy(request, '/workspaces');
}
