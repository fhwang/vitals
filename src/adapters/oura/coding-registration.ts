import type { Db } from '#db';

import type { AdapterCodingRegistration } from '../coding-registry.js';
import { OURA_AASM_CONTRIBUTION, OURA_NATIVE_CODINGS } from './aasm-contribution.js';
import { createOuraConfidenceProvider } from './confidence.js';
import { OURA_ADAPTER_NAME } from './credentials.js';

export function ouraCodingRegistration(db: Db): AdapterCodingRegistration {
  return {
    adapter_name: OURA_ADAPTER_NAME,
    native_codings: OURA_NATIVE_CODINGS,
    canonical_contributions: [OURA_AASM_CONTRIBUTION],
    confidence_provider: createOuraConfidenceProvider(db),
  };
}
