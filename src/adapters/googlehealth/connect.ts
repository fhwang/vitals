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

export class GoogleHealthOAuthFlow {
  constructor(
    private readonly config: GoogleHealthAuthConfig,
    private readonly scopes: readonly string[],
    private readonly loginHint: string | undefined = undefined,
  ) {}

  async run(): Promise<TokenSet> {
    const port = DEFAULT_PORT;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const state = randomBytes(32).toString('base64url');
    const authUrl = this.buildAuthUrl(redirectUri, state);
    announceAuthUrl(authUrl, this.loginHint);
    const code = await captureCode(port, state, () => openBrowser(authUrl));
    return exchangeCodeForTokens(this.config, redirectUri, code);
  }

  buildAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    if (this.loginHint !== undefined) params.set('login_hint', this.loginHint);
    return `${AUTH_URL}?${params.toString()}`;
  }
}

function announceAuthUrl(url: string, loginHint: string | undefined): void {
  const lines = ['', 'Authorize Google Health access:', `  ${url}`, ''];
  if (loginHint !== undefined) {
    lines.push(`Sign in as ${loginHint} when prompted.`);
  } else {
    lines.push('If multiple Google accounts are signed in, pick the one connected to your Fitbit.');
  }
  lines.push(
    'Default browser will open this URL automatically.',
    'If the wrong browser/profile opens, copy the URL above into the right one.',
    '',
  );
  process.stderr.write(lines.join('\n'));
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

class CallbackHandler {
  constructor(
    private readonly expectedState: string,
    private readonly resolve: (code: string) => void,
    private readonly reject: (err: Error) => void,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const code = this.validate(req);
      this.respondSuccess(res);
      this.resolve(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.respondError(res, message);
      this.reject(err instanceof Error ? err : new Error(message));
    }
  }

  private validate(req: IncomingMessage): string {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const state = url.searchParams.get('state');
    if (state !== this.expectedState) {
      throw new Error('OAuth state mismatch — possible CSRF');
    }
    const code = url.searchParams.get('code');
    if (code === null) {
      const errParam = url.searchParams.get('error') ?? 'no code in callback';
      throw new Error(`OAuth error: ${errParam}`);
    }
    return code;
  }

  private respondSuccess(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><body><h1>Connected</h1><p>You can close this tab and return to your terminal.</p></body></html>',
    );
  }

  private respondError(res: ServerResponse, message: string): void {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OAuth error: ${message}\n`);
  }
}

function captureCode(
  port: number,
  expectedState: string,
  onListening: () => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const handler = new CallbackHandler(expectedState, resolve, reject);
    const server = createServer((req, res) => {
      handler.handle(req, res);
      server.close();
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

export function runGoogleHealthOAuthFlow(
  config: GoogleHealthAuthConfig,
  scopes: readonly string[],
  loginHint?: string,
): Promise<TokenSet> {
  return new GoogleHealthOAuthFlow(config, scopes, loginHint).run();
}
