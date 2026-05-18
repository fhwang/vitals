// Canonical AASM sleep-stage taxonomy. The vocabulary follows the AASM Manual
// for the Scoring of Sleep and Associated Events
// (https://aasm.org/clinical-resources/scoring-manual/). The coding URI below
// is vitals-hosted because AASM does not run a terminology service the way
// LOINC does — but the vocabulary IS AASM, and any adapter producing sleep
// stage data is expected to map into these five canonical stages.
//
// Stable contract for queries: 0 = wake; any positive integer = some flavor
// of asleep. New stages added later are positive integers and never break
// existing "any asleep" range queries.

export const AASM_SLEEP_STAGE = {
  wake: 0,
  n1: 1,
  n2: 2,
  n3: 3,
  rem: 4,
} as const;

export type AasmSleepStage = (typeof AASM_SLEEP_STAGE)[keyof typeof AASM_SLEEP_STAGE];

// FHIR `system` URI for the canonical AASM sleep-stage coding. Query callers
// can ask for AASM stages via this system; the query layer translates to
// per-adapter native queries using each adapter's registered AASM mapping.
export const AASM_SLEEP_STAGE_SYSTEM = 'https://vitals.fhwang.net/coding/aasm/sleep-stage';
export const AASM_SLEEP_STAGE_CODE = 'aasm-sleep-stage';
