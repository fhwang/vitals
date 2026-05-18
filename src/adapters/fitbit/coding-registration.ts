import { SYSTEM_LOINC, type Coding } from '#records';

import type { AdapterCodingRegistration } from '../coding-registry.js';
import type { Db } from '#db';
import { createFitbitConfidenceProvider } from './confidence.js';

const FITBIT_NATIVE_CODINGS: readonly Coding[] = [
  { system: SYSTEM_LOINC, code: '8867-4' }, // Heart rate (intraday samples)
];

export function fitbitCodingRegistration(db: Db): AdapterCodingRegistration {
  return {
    adapter_name: 'fitbit',
    native_codings: FITBIT_NATIVE_CODINGS,
    canonical_contributions: [],
    confidence_provider: createFitbitConfidenceProvider(db),
  };
}
