import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import type { TokenSet } from '../credentials.js';
import type { GoogleHealthAuthConfig } from './auth-config.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_PORT = 8765;
const CALLBACK_PATH = '/callback';
const TIMEOUT_MS = 5 * 60 * 1000;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

export interface OAuthAuthorizeRequest {
  redirect_uri: string;
  scopes: readonly string[];
  state: string;
  login_hint?: string;
}

export function buildAuthUrl(
  client: GoogleHealthAuthConfig,
  request: OAuthAuthorizeRequest,
): string {
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: request.redirect_uri,
    response_type: 'code',
    scope: request.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: request.state,
  });
  if (request.login_hint !== undefined) params.set('login_hint', request.login_hint);
  return `${AUTH_URL}?${params.toString()}`;
}

function describeAuthRequest(request: OAuthAuthorizeRequest): string {
  if (request.login_hint !== undefined) {
    return `Sign in as ${request.login_hint} when prompted.`;
  }
  return 'If multiple Google accounts are signed in, pick the one connected to your Fitbit.';
}

function announceAuthUrl(authUrl: string, instruction: string): void {
  process.stderr.write(
    [
      '',
      'Authorize Google Health access:',
      `  ${authUrl}`,
      '',
      instruction,
      'Default browser will open this URL automatically.',
      'If the wrong browser/profile opens, copy the URL above into the right one.',
      '',
    ].join('\n'),
  );
}

async function postCodeExchange(
  config: GoogleHealthAuthConfig,
  redirectUri: string,
  code: string,
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.client_id,
    client_secret: config.client_secret,
    redirect_uri: redirectUri,
  });
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export async function exchangeCodeForTokens(
  config: GoogleHealthAuthConfig,
  redirectUri: string,
  code: string,
): Promise<TokenSet> {
  const response = await postCodeExchange(config, redirectUri, code);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }
  const json: unknown = await response.json();
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Token exchange response unexpected: ${parsed.error.message}`);
  }
  return {
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
    expires_at: new Date(Date.now() + parsed.data.expires_in * 1000).toISOString(),
  };
}

function parseCallback(req: IncomingMessage, expectedState: string): string {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('OAuth state mismatch — possible CSRF');
  }
  const code = url.searchParams.get('code');
  if (code === null) {
    const errParam = url.searchParams.get('error') ?? 'no code in callback';
    throw new Error(`OAuth error: ${errParam}`);
  }
  return code;
}

function respondSuccess(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<html><body><h1>Connected</h1><p>You can close this tab and return to your terminal.</p></body></html>',
  );
}

function respondError(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`OAuth error: ${message}\n`);
}

function captureCode(
  port: number,
  expectedState: string,
  onListening: () => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const code = parseCallback(req, expectedState);
        respondSuccess(res);
        resolve(code);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respondError(res, message);
        reject(err instanceof Error ? err : new Error(message));
      } finally {
        server.close();
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    server.on('close', () => clearTimeout(timer));
    server.on('error', (err) =>
      reject(new Error(`Could not bind to port ${port}: ${err.message}`)),
    );
    server.listen(port, '127.0.0.1', onListening);
  });
}

function openBrowser(url: string): void {
  exec(`open ${JSON.stringify(url)}`, (err) => {
    if (err !== null) {
      process.stderr.write(`Could not open browser. Visit this URL manually:\n${url}\n`);
    }
  });
}

export async function runGoogleHealthOAuthFlow(
  config: GoogleHealthAuthConfig,
  scopes: readonly string[],
  loginHint?: string,
): Promise<TokenSet> {
  const port = DEFAULT_PORT;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const state = randomBytes(32).toString('base64url');
  const request: OAuthAuthorizeRequest =
    loginHint === undefined
      ? { redirect_uri: redirectUri, scopes, state }
      : { redirect_uri: redirectUri, scopes, state, login_hint: loginHint };
  const authUrl = buildAuthUrl(config, request);
  announceAuthUrl(authUrl, describeAuthRequest(request));
  const code = await captureCode(port, state, () => openBrowser(authUrl));
  return exchangeCodeForTokens(config, redirectUri, code);
}
