import { describe, expect, it } from 'vitest';

import { translateAasmRangeToOura } from './aasm-contribution.js';

describe('translateAasmRangeToOura (conservative-inclusion rule)', () => {
  it('translates AASM {N1, N2, N3, REM} (any asleep) to Oura {deep, light, rem}', () => {
    // AASM 1..4 = {N1, N2, N3, REM}. Oura "deep"(=1) maps to {N3} ⊆ {N1..REM};
    // "light"(=2) → {N1,N2} ⊆ {N1..REM}; "rem"(=3) → {REM} ⊆ {N1..REM};
    // "awake"(=4) → {W} ⊄ {N1..REM}. So matching native = {1, 2, 3}.
    expect(translateAasmRangeToOura({ min: 1, max: 4 })).toEqual([{ min: 1, max: 3 }]);
  });

  it('returns no match for AASM {N1} alone (Oura cannot prove N1-only)', () => {
    // Oura "light" → {N1, N2}, not a subset of {N1}. So nothing matches.
    expect(translateAasmRangeToOura({ min: 1, max: 1 })).toEqual([]);
  });

  it('translates AASM {N1, N2} to Oura {light}', () => {
    // Oura "light" → {N1, N2} ⊆ {N1, N2}. Match.
    expect(translateAasmRangeToOura({ min: 1, max: 2 })).toEqual([{ min: 2, max: 2 }]);
  });

  it('translates AASM {N3} to Oura {deep}', () => {
    // Oura "deep" → {N3} ⊆ {N3}.
    expect(translateAasmRangeToOura({ min: 3, max: 3 })).toEqual([{ min: 1, max: 1 }]);
  });

  it('translates AASM {REM} to Oura {rem}', () => {
    expect(translateAasmRangeToOura({ min: 4, max: 4 })).toEqual([{ min: 3, max: 3 }]);
  });

  it('translates AASM {W} (= wake) to Oura {awake}', () => {
    expect(translateAasmRangeToOura({ min: 0, max: 0 })).toEqual([{ min: 4, max: 4 }]);
  });

  it('groups contiguous matching codes into a single range', () => {
    // AASM {N1, N2, N3} (no REM, no W). Matches Oura "light"(=2) and "deep"(=1).
    // Both fall in the matching set. Result should be a contiguous Oura range.
    expect(translateAasmRangeToOura({ min: 1, max: 3 })).toEqual([{ min: 1, max: 2 }]);
  });
});
