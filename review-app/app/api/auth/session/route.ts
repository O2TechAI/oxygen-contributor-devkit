import { isAuthConfigured, isAuthenticated } from '@/lib/auth';

export async function GET(request: Request) {
  return Response.json({
    authenticated: await isAuthenticated(request),
    configured: isAuthConfigured(),
  });
}
