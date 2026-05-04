import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuthUrl, exchangeCodeForTokens } from './connect.js';

interface MockResponse {
  status: number;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): MockResponse {
  return { status, body };
}

type FetchInput = string | URL;
type MockFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface CapturedCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function buildResponse(m: MockResponse): Response {
  return {
    ok: m.status < 400,
    status: m.status,
    json: () => Promise.resolve(m.body),
    text: () => Promise.resolve(JSON.stringify(m.body)),
  } as unknown as Response;
}

function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return '';
}

function setFetch(handler: (call: CapturedCall) => MockResponse): void {
  const mock: MockFetch = (input, init) => {
    const url = input instanceof URL ? input.toString() : input;
    const body = bodyToString(init?.body);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return Promise.resolve(buildResponse(handler({ url, body, headers })));
  };
  globalThis.fetch = vi.fn(mock) as typeof globalThis.fetch;
}

const AUTH_CONFIG = { client_id: 'cid', client_secret: 'csecret' };

describe('buildAuthUrl', () => {
  it('encodes all required OAuth parameters', () => {
    const url = buildAuthUrl(AUTH_CONFIG, {
      redirect_uri: 'http://127.0.0.1:8765/callback',
      scopes: ['scope.a', 'scope.b'],
      state: 'random-state',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('scope.a scope.b');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('state')).toBe('random-state');
  });

  it('joins multiple scopes with a single space', () => {
    const url = buildAuthUrl(AUTH_CONFIG, {
      redirect_uri: 'http://x',
      scopes: ['a', 'b', 'c'],
      state: 's',
    });
    expect(new URL(url).searchParams.get('scope')).toBe('a b c');
  });

  it('omits login_hint when none was supplied', () => {
    const url = buildAuthUrl(AUTH_CONFIG, {
      redirect_uri: 'http://x',
      scopes: ['scope.a'],
      state: 's',
    });
    expect(new URL(url).searchParams.get('login_hint')).toBeNull();
  });

  it('encodes login_hint when supplied', () => {
    const url = buildAuthUrl(AUTH_CONFIG, {
      redirect_uri: 'http://x',
      scopes: ['scope.a'],
      state: 's',
      login_hint: 'user@example.com',
    });
    expect(new URL(url).searchParams.get('login_hint')).toBe('user@example.com');
  });
});

describe('exchangeCodeForTokens', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts the authorization-code grant body and parses the TokenSet', async () => {
    let capturedBody = '';
    setFetch((call) => {
      capturedBody = call.body;
      return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3599 });
    });
    const tokens = await exchangeCodeForTokens(
      AUTH_CONFIG,
      'http://127.0.0.1:8765/callback',
      'CODE',
    );
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('CODE');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('csecret');
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(tokens.access_token).toBe('AT');
    expect(tokens.refresh_token).toBe('RT');
    expect(Date.parse(tokens.expires_at)).toBeGreaterThan(Date.now());
  });

  it('throws a clear error when the token endpoint returns non-200', async () => {
    setFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(
      exchangeCodeForTokens(AUTH_CONFIG, 'http://127.0.0.1:8765/callback', 'BAD'),
    ).rejects.toThrow(/Token exchange failed \(400\)/);
  });

  it('throws when the response body is missing required fields', async () => {
    setFetch(() => jsonResponse({ access_token: 'AT' }));
    await expect(
      exchangeCodeForTokens(AUTH_CONFIG, 'http://127.0.0.1:8765/callback', 'CODE'),
    ).rejects.toThrow(/Token exchange response unexpected/);
  });
});
