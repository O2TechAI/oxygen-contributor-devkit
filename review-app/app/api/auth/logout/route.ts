import { logoutResponse } from '@/lib/auth';

export async function POST(request: Request) {
  return logoutResponse(request);
}
