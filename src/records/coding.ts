export const SYSTEM_LOINC = 'http://loinc.org';
export const SYSTEM_RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
export const SYSTEM_ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';
export const SYSTEM_SNOMED = 'http://snomed.info/sct';

// CCDA OIDs that map to FHIR system URIs. CCDAs identify code systems
// by OID; the records layer translates to FHIR canonical URIs at the
// boundary so everything above speaks one vocabulary.
export const OID_TO_FHIR_SYSTEM: Readonly<Record<string, string>> = {
  '2.16.840.1.113883.6.1': SYSTEM_LOINC,
  '2.16.840.1.113883.6.88': SYSTEM_RXNORM,
  '2.16.840.1.113883.6.90': SYSTEM_ICD10,
  '2.16.840.1.113883.6.96': SYSTEM_SNOMED,
};
