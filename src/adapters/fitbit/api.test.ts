import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncError } from '../types.js';
import { fetchIntradayHeartRate, refreshGoogleHealthToken } from './api.js';

interface MockResponse {
  status: number;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): MockResponse {
  return { status, body };
}

type FetchInput = string | URL;
type MockFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

function inputToUrl(input: FetchInput): string {
  return input instanceof URL ? input.toString() : input;
}

function buildResponse(m: MockResponse): Response {
  return {
    ok: m.status < 400,
    status: m.status,
    json: () => Promise.resolve(m.body),
    text: () => Promise.resolve(JSON.stringify(m.body)),
  } as unknown as Response;
}

function setFetch(handler: (url: string) => MockResponse): void {
  const mock: MockFetch = (input) => Promise.resolve(buildResponse(handler(inputToUrl(input))));
  globalThis.fetch = vi.fn(mock) as typeof globalThis.fetch;
}

function setFetchNetworkError(err: Error): void {
  const mock: MockFetch = () => Promise.reject(err);
  globalThis.fetch = vi.fn(mock) as typeof globalThis.fetch;
}

const AUTH_CONFIG = { client_id: 'cid', client_secret: 'csecret' };

describe('refreshGoogleHealthToken', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a TokenSet preserving the input refresh_token', async () => {
    setFetch(() => jsonResponse({ access_token: 'new-access', expires_in: 3600 }));
    const tokens = await refreshGoogleHealthToken(AUTH_CONFIG, 'rt-stable');
    expect(tokens.access_token).toBe('new-access');
    expect(tokens.refresh_token).toBe('rt-stable');
    expect(typeof tokens.expires_at).toBe('string');
    expect(Date.parse(tokens.expires_at)).toBeGreaterThan(Date.now());
  });

  it('classifies 401 as reauth_required', async () => {
    setFetch(() => jsonResponse({ error: 'invalid_grant' }, 401));
    await expect(refreshGoogleHealthToken(AUTH_CONFIG, 'rt')).rejects.toMatchObject({
      reason: 'reauth_required',
    });
  });

  it('classifies 5xx as transient', async () => {
    setFetch(() => jsonResponse({ error: 'oops' }, 503));
    await expect(refreshGoogleHealthToken(AUTH_CONFIG, 'rt')).rejects.toMatchObject({
      reason: 'transient',
    });
  });

  it('classifies 429 as transient', async () => {
    setFetch(() => jsonResponse({ error: 'rate' }, 429));
    await expect(refreshGoogleHealthToken(AUTH_CONFIG, 'rt')).rejects.toMatchObject({
      reason: 'transient',
    });
  });

  it('wraps fetch network errors as transient', async () => {
    setFetchNetworkError(new Error('ENOTFOUND'));
    await expect(refreshGoogleHealthToken(AUTH_CONFIG, 'rt')).rejects.toMatchObject({
      reason: 'transient',
    });
  });

  it('classifies a malformed response body as parse_error', async () => {
    setFetch(() => jsonResponse({ no_access_token: 'oops' }));
    await expect(refreshGoogleHealthToken(AUTH_CONFIG, 'rt')).rejects.toMatchObject({
      reason: 'parse_error',
    });
  });
});

function dataPoint(physicalTime: string, bpm: string | number): unknown {
  return {
    heartRate: {
      sampleTime: { physicalTime },
      beatsPerMinute: bpm,
    },
  };
}

describe('fetchIntradayHeartRate', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches one page when no nextPageToken is present', async () => {
    setFetch(() =>
      jsonResponse({
        dataPoints: [
          dataPoint('2026-05-02T10:00:00Z', '72'),
          dataPoint('2026-05-02T10:00:15Z', 75),
        ],
      }),
    );
    const result = await fetchIntradayHeartRate('access-token', '2026-05-02');
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]).toEqual({
      physical_time: '2026-05-02T10:00:00Z',
      beats_per_minute: 72,
    });
    expect(result.samples[1]?.beats_per_minute).toBe(75);
    expect(result.raw).toHaveLength(1);
  });

  it('paginates until nextPageToken is empty/missing', async () => {
    let call = 0;
    setFetch((url) => {
      call += 1;
      if (call === 1) {
        expect(url).not.toContain('pageToken=');
        return jsonResponse({
          dataPoints: [dataPoint('2026-05-02T10:00:00Z', '70')],
          nextPageToken: 'page2',
        });
      }
      expect(url).toContain('pageToken=page2');
      return jsonResponse({ dataPoints: [dataPoint('2026-05-02T10:00:30Z', '72')] });
    });
    const result = await fetchIntradayHeartRate('access-token', '2026-05-02');
    expect(result.samples).toHaveLength(2);
    expect(result.raw).toHaveLength(2);
    expect(call).toBe(2);
  });

  it('returns empty samples when dataPoints is omitted', async () => {
    setFetch(() => jsonResponse({}));
    const result = await fetchIntradayHeartRate('access-token', '2026-05-02');
    expect(result.samples).toEqual([]);
  });

  it('drops samples whose beatsPerMinute does not parse as an integer', async () => {
    setFetch(() =>
      jsonResponse({
        dataPoints: [
          dataPoint('2026-05-02T10:00:00Z', 'not-a-number'),
          dataPoint('2026-05-02T10:00:30Z', '88'),
        ],
      }),
    );
    const result = await fetchIntradayHeartRate('access-token', '2026-05-02');
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.beats_per_minute).toBe(88);
  });

  it('classifies a malformed dataPoints response as parse_error', async () => {
    setFetch(() => jsonResponse({ dataPoints: [{ wrongShape: true }] }));
    await expect(fetchIntradayHeartRate('access-token', '2026-05-02')).rejects.toBeInstanceOf(
      SyncError,
    );
  });

  it('classifies 401 as reauth_required', async () => {
    setFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(fetchIntradayHeartRate('access-token', '2026-05-02')).rejects.toMatchObject({
      reason: 'reauth_required',
    });
  });
});
