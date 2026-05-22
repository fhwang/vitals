import {
  AASM_SLEEP_STAGE_CODE,
  AASM_SLEEP_STAGE_SYSTEM,
  SYSTEM_LOINC,
  type Coding,
} from '#records';

import type { CanonicalContribution, NativeValueRange } from '../coding-registry.js';
import { OURA_SLEEP_STAGE_CODE, OURA_SLEEP_STAGE_SYSTEM } from './sleep-stage.js';
import { OURA_TO_AASM } from './sleep-stage-mapping.js';

const CANONICAL_AASM_CODING: Coding = {
  system: AASM_SLEEP_STAGE_SYSTEM,
  code: AASM_SLEEP_STAGE_CODE,
};

const OURA_NATIVE_CODING: Coding = {
  system: OURA_SLEEP_STAGE_SYSTEM,
  code: OURA_SLEEP_STAGE_CODE,
};

// Conservative-inclusion translation: a native Oura code matches an AASM
// range R iff its AASM mapping ⊆ R. Returns the native value-range(s)
// covering the matching native codes. The output is a *list* because the
// matching native codes might not form a contiguous integer range — though
// for Oura's encoding (deep=1, light=2, rem=3, awake=4) any "any asleep"-
// shaped query against the AASM range maps to a single contiguous Oura
// range, since deep/light/rem are 1..3.
export function translateAasmRangeToOura(canonical: NativeValueRange): readonly NativeValueRange[] {
  const aasmStages = stageSetFromRange(canonical);
  const matchingNative: number[] = [];
  for (const [nativeCode, aasmSet] of OURA_TO_AASM) {
    if (isSubset(aasmSet, aasmStages)) matchingNative.push(nativeCode);
  }
  if (matchingNative.length === 0) return [];
  matchingNative.sort((a, b) => a - b);
  return groupContiguous(matchingNative);
}

function stageSetFromRange(range: NativeValueRange): ReadonlySet<number> {
  const stages = new Set<number>();
  for (let s = range.min; s <= range.max; s++) stages.add(s);
  return stages;
}

function isSubset(subset: ReadonlySet<number>, superset: ReadonlySet<number>): boolean {
  for (const x of subset) {
    if (!superset.has(x)) return false;
  }
  return true;
}

function groupContiguous(sorted: readonly number[]): NativeValueRange[] {
  const out: NativeValueRange[] = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last?.max === n - 1) {
      last.max = n;
      continue;
    }
    out.push({ min: n, max: n });
  }
  return out;
}

export const OURA_AASM_CONTRIBUTION: CanonicalContribution = {
  canonical_coding: CANONICAL_AASM_CODING,
  native_coding: OURA_NATIVE_CODING,
  translateValueRange: translateAasmRangeToOura,
};

// LOINC codings that Oura writes per session (TST, REM/Light/Deep durations,
// WASO). Exported so the coding registry can route confidence/freshness
// queries against these codes to Oura's provider. SE and SOL deferred to V2.
export const OURA_LOINC_CODES: readonly Coding[] = [
  { system: SYSTEM_LOINC, code: '93832-4' },
  { system: SYSTEM_LOINC, code: '93829-0' },
  { system: SYSTEM_LOINC, code: '93830-8' },
  { system: SYSTEM_LOINC, code: '93831-6' },
  { system: SYSTEM_LOINC, code: '103215-0' },
];

export const OURA_NATIVE_CODINGS: readonly Coding[] = [OURA_NATIVE_CODING, ...OURA_LOINC_CODES];
