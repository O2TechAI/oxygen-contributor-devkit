import { env } from 'cloudflare:workers';

import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';

/** Where the local Oxygen service (bridge) listens, with its shared token. */
function target() {
  const token = env.OXYGEN_AGENT_BRIDGE_TOKEN;
  if (!token) return null;
  const url = (env.OXYGEN_AGENT_BRIDGE_URL || 'http://127.0.0.1:3777').replace(
    /\/$/,
    '',
  );
  return { url, headers: { authorization: `Bearer ${token}` } };
}

export type BridgeResult = { status: number; data: unknown };

/** Call the local service from the app's server; the browser never sees the token. */
export async function callBridge(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<BridgeResult> {
  const service = target();
  if (!service) {
    return {
      status: 503,
      data: {
        error: 'The Oxygen service is not configured.',
        reason: 'not-configured',
      },
    };
  }
  try {
    const response = await fetch(`${service.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...service.headers,
        ...(init.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      cache: 'no-store',
    });
    return { status: response.status, data: await response.json() };
  } catch {
    return {
      status: 503,
      data: {
        error: 'The Oxygen service is not running.',
        reason: 'unreachable',
      },
    };
  }
}

/** An authenticated pass-through of one bridge call. */
export async function proxy(
  request: Request,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const { status, data } = await callBridge(path, {
    ...init,
    signal: request.signal,
  });
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
