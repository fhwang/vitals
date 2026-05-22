// Oura's native sleep-stage vocabulary. Used as `value_quantity` on each
// per-stage-run observation row stored under the Oura native coding URI.
// The query layer translates between Oura's native vocabulary and the
// canonical AASM taxonomy via OURA_TO_AASM in sleep-stage-mapping.ts; nothing
// outside this directory should reference these constants.

export const OURA_SLEEP_STAGE = {
  deep: 1,
  light: 2,
  rem: 3,
  awake: 4,
} as const;

export type OuraSleepStage = (typeof OURA_SLEEP_STAGE)[keyof typeof OURA_SLEEP_STAGE];

// FHIR `system` URI for Oura's native sleep-stage coding. Adapter-internal —
// the canonical AASM URI is what cross-module queries should target.
export const OURA_SLEEP_STAGE_SYSTEM = 'https://vitals.fhwang.net/coding/oura/sleep-stage';
export const OURA_SLEEP_STAGE_CODE = 'oura-sleep-stage';

// Oura's `sleep_phase_5_min` epoch character → numeric stage. Each character
// in the string represents one 5-minute (300s) epoch. Used by the parser to
// convert Oura's compact format into observation rows.
export const OURA_STAGE_CHAR_TO_VALUE: Readonly<Record<string, OuraSleepStage>> = {
  '1': OURA_SLEEP_STAGE.deep,
  '2': OURA_SLEEP_STAGE.light,
  '3': OURA_SLEEP_STAGE.rem,
  '4': OURA_SLEEP_STAGE.awake,
};

export const OURA_EPOCH_SECONDS = 300;
