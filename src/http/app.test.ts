import { describe, it, expect } from 'vitest';
import { createApp } from './app.js';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
