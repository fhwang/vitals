import { describe, expect, it } from 'vitest';

import { parseEffectiveTime } from './ccda-helpers.js';

describe('parseEffectiveTime', () => {
  it('returns midnight when only YYYYMMDD is present', () => {
    expect(parseEffectiveTime('20240615')).toEqual({
      date: '2024-06-15',
      effective_start: '2024-06-15T00:00:00Z',
    });
  });

  it('preserves full HHMMSS precision', () => {
    expect(parseEffectiveTime('20240615103211-0500')).toEqual({
      date: '2024-06-15',
      effective_start: '2024-06-15T10:32:11Z',
    });
  });

  it('handles HHMM without seconds', () => {
    expect(parseEffectiveTime('202406151032-0500')).toEqual({
      date: '2024-06-15',
      effective_start: '2024-06-15T10:32:00Z',
    });
  });

  it('ignores the timezone offset (treats clock-time as naive)', () => {
    // 23:00 with -0500 stays on June 15 in local time, doesn't bleed into June 16
    expect(parseEffectiveTime('20240615230000-0500').date).toBe('2024-06-15');
    expect(parseEffectiveTime('20240615230000-0500').effective_start).toBe('2024-06-15T23:00:00Z');
  });

  it('falls back to midnight when the post-date portion is malformed', () => {
    expect(parseEffectiveTime('20240615garbage')).toEqual({
      date: '2024-06-15',
      effective_start: '2024-06-15T00:00:00Z',
    });
  });
});
