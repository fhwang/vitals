import { describe, expect, it } from 'vitest';

import { lastNDays } from './index.js';

describe('lastNDays', () => {
  it('returns the requested number of days ending today (UTC)', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    const days = lastNDays(today, 3);
    expect(days).toEqual(['2026-04-28', '2026-04-29', '2026-04-30']);
  });

  it('handles a window of 1', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    expect(lastNDays(today, 1)).toEqual(['2026-04-30']);
  });

  it('handles month boundaries', () => {
    const today = new Date('2026-05-01T12:00:00Z');
    expect(lastNDays(today, 3)).toEqual(['2026-04-29', '2026-04-30', '2026-05-01']);
  });
});
