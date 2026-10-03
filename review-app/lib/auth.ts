import { env } from 'cloudflare:workers';

const COOKIE_NAME = 'oxygen_review_session';
const SESSION_SECONDS = 24 * 60 * 60;

function credentials() {
  const username = env.OXYGEN_REVIEW_USERNAME?.trim();
  const password = env.OXYGEN_REVIEW_PASSWORD;
  return username && password ? { username, password } : null;
}

function encode(value: Uint8Array | string) {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decode(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function signingKey(password: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function cookieValue(request: Request) {
  const cookies = request.headers.get('cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return null;
}

export function isAuthConfigured() {
  return Boolean(credentials());
}

export async function isAuthenticated(request: Request) {
  const configured = credentials();
  if (!configured) return true;
  const token = cookieValue(request);
  if (!token) return false;

  const [payloadPart, signaturePart, ...extra] = token.split('.');
  if (!payloadPart || !signaturePart || extra.length) return false;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(decode(payloadPart)),
    ) as { username?: string; expires?: number };
    if (
      payload.username !== configured.username ||
      typeof payload.expires !== 'number' ||
      payload.expires <= Date.now()
    )
      return false;
    return crypto.subtle.verify(
      'HMAC',
      await signingKey(configured.password),
      decode(signaturePart),
      new TextEncoder().encode(payloadPart),
    );
  } catch {
    return false;
  }
}

export async function loginResponse(
  request: Request,
  username: string,
  password: string,
) {
  const configured = credentials();
  if (!configured) {
    return Response.json(
      { error: 'Application login is not configured.' },
      { status: 503 },
    );
  }
  if (username !== configured.username || password !== configured.password) {
    return Response.json(
      { error: 'Invalid account or password.' },
      { status: 401 },
    );
  }

  const payloadPart = encode(
    JSON.stringify({
      username: configured.username,
      expires: Date.now() + SESSION_SECONDS * 1000,
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await signingKey(configured.password),
      new TextEncoder().encode(payloadPart),
    ),
  );
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return Response.json(
    { authenticated: true },
    {
      headers: {
        'set-cookie': `${COOKIE_NAME}=${payloadPart}.${encode(signature)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`,
      },
    },
  );
}

export function logoutResponse(request: Request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return Response.json(
    { authenticated: false },
    {
      headers: {
        'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
      },
    },
  );
}

export function unauthorizedResponse() {
  return Response.json({ error: 'Authentication required.' }, { status: 401 });
}
