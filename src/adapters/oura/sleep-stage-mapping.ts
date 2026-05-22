import { AASM_SLEEP_STAGE } from '#records';

import { OURA_SLEEP_STAGE } from './sleep-stage.js';

// Per-adapter mapping from Oura's native stage values to the *set* of AASM
// stages each native code could represent. Sets express ambiguity honestly:
// Oura's "light" maps to {N1, N2} because Oura has no EEG and physically
// cannot distinguish those substages. The query layer uses these sets under
// the conservative-inclusion rule (a native code matches an AASM stage set
// `R` iff its mapping ⊆ R).
//
// The exported map is `ReadonlyMap<number, ReadonlySet<number>>` so callers
// can iterate or look up entries but never mutate.

export const OURA_TO_AASM: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [OURA_SLEEP_STAGE.deep, new Set<number>([AASM_SLEEP_STAGE.n3])],
  [OURA_SLEEP_STAGE.light, new Set<number>([AASM_SLEEP_STAGE.n1, AASM_SLEEP_STAGE.n2])],
  [OURA_SLEEP_STAGE.rem, new Set<number>([AASM_SLEEP_STAGE.rem])],
  [OURA_SLEEP_STAGE.awake, new Set<number>([AASM_SLEEP_STAGE.wake])],
]);
