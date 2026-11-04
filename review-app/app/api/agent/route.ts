import { env } from 'cloudflare:workers';

import { isAuthenticated, unauthorizedResponse } from '@/lib/auth';
import {
  agentSchema,
  buildPrompt,
  editSupported,
  MAX_MESSAGE_LENGTH,
  parseAgentOutput,
  type AgentContext,
  type AgentMode,
  type AgentScope,
} from '@/lib/agent-prompt';

const MAX_CONTEXT_CHARS = 2_000_000;

function bridge() {
  const token = env.OXYGEN_AGENT_BRIDGE_TOKEN;
  if (!token) return null;
  const url = (env.OXYGEN_AGENT_BRIDGE_URL || 'http://127.0.0.1:3777').replace(
    /\/$/,
    '',
  );
  return { url, headers: { authorization: `Bearer ${token}` } };
}

function isContext(value: unknown): value is AgentContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Partial<AgentContext>;
  return (
    typeof context.protocolVersion === 'number' &&
    Array.isArray(context.summaryLines) &&
    context.summaryLines.every(
      (line) =>
        line && typeof line.id === 'string' && typeof line.text === 'string',
    ) &&
    Array.isArray(context.insights) &&
    context.insights.every(
      (insight) =>
        insight &&
        typeof insight.id === 'string' &&
        typeof insight.title === 'string' &&
        Array.isArray(insight.evidence),
    )
  );
}

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const target = bridge();
  if (!target) {
    return Response.json({ available: false, reason: 'not-configured' });
  }
  try {
    const response = await fetch(`${target.url}/capabilities`, {
      headers: target.headers,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('The agent bridge refused the request.');
    const { providers } = (await response.json()) as { providers: unknown };
    return Response.json(
      { available: true, providers },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json({ available: false, reason: 'unreachable' });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) return unauthorizedResponse();
  const target = bridge();
  if (!target) {
    return Response.json(
      { error: 'The agent bridge is not configured.' },
      { status: 503 },
    );
  }
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_CONTEXT_CHARS) throw new Error('Too large.');
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: 'The request is not valid.' },
      { status: 400 },
    );
  }
  const { provider, model, effort, message, mode, scope, context } = body;
  if (
    (provider !== 'codex' && provider !== 'claude') ||
    typeof model !== 'string' ||
    typeof effort !== 'string' ||
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > MAX_MESSAGE_LENGTH ||
    (mode !== 'ask' && mode !== 'edit') ||
    (scope !== 'card' && scope !== 'review') ||
    !isContext(context)
  ) {
    return Response.json(
      { error: 'The request is incomplete.' },
      { status: 400 },
    );
  }
  if (mode === 'edit' && !editSupported(context.protocolVersion)) {
    return Response.json(
      { error: 'Editing is available for skill-candidate (v9) reviews.' },
      { status: 400 },
    );
  }
  const kind: AgentMode = mode;
  const reach: AgentScope = scope;
  try {
    const response = await fetch(`${target.url}/run`, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        effort,
        prompt: buildPrompt({ mode: kind, scope: reach, message, context }),
        schema: agentSchema(kind),
      }),
      signal: request.signal,
    });
    const result = (await response.json()) as {
      output?: unknown;
      error?: string;
    };
    if (!response.ok) {
      return Response.json(
        { error: result.error || 'The agent request failed.' },
        { status: response.status === 429 ? 429 : 502 },
      );
    }
    return Response.json(parseAgentOutput(kind, result.output, reach, context));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'The agent request failed.',
      },
      { status: 502 },
    );
  }
}
