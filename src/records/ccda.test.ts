import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ccdaKind } from './ccda.js';
import { SYSTEM_ICD10, SYSTEM_LOINC, SYSTEM_RXNORM } from './coding.js';
import { RecordParseError } from './errors.js';

async function loadFixture(name: string): Promise<Uint8Array> {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  return readFile(fileURLToPath(url));
}

describe('ccdaKind', () => {
  it('declares kind, extension, and contentType', () => {
    expect(ccdaKind.kind).toBe('ccda');
    expect(ccdaKind.extension).toBe('xml');
    expect(ccdaKind.contentType).toBe('application/xml');
  });

  it('accepts a valid CCDA document', async () => {
    const bytes = await loadFixture('ccda-valid.xml');
    expect(() => {
      ccdaKind.validateBytes(bytes);
    }).not.toThrow();
  });

  it('throws RecordParseError for malformed XML', () => {
    const bytes = new TextEncoder().encode('<not really valid');
    expect(() => {
      ccdaKind.validateBytes(bytes);
    }).toThrow(/malformed XML/);
  });

  it('throws RecordParseError when root element is not ClinicalDocument', async () => {
    const bytes = await loadFixture('not-ccda.xml');
    expect(() => {
      ccdaKind.validateBytes(bytes);
    }).toThrow(/root element is not ClinicalDocument/);
  });

  it('throws RecordParseError when xmlns is not the HL7 V3 namespace', () => {
    const bytes = new TextEncoder().encode(
      '<?xml version="1.0"?><ClinicalDocument xmlns="urn:other"/>',
    );
    expect(() => {
      ccdaKind.validateBytes(bytes);
    }).toThrow(/expected xmlns="urn:hl7-org:v3"/);
  });
});

describe('ccdaKind.parseDocument', () => {
  it('extracts CCD document_type and document_date from header', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.document_type).toBe('ccd');
    expect(parsed.document_date).toBe('2024-06-15');
  });

  it('extracts LDL-C, HbA1c, triglycerides observations from Results section', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    const ldl = parsed.observations.find((o) => o.coding.code === '13457-7');
    expect(ldl).toBeDefined();
    expect(ldl?.coding.system).toBe(SYSTEM_LOINC);
    expect(ldl?.coding.display).toBe('LDL-CHOLESTEROL');
    expect(ldl?.date).toBe('2024-06-15');
    expect(ldl?.effective_start).toBe('2024-06-15T00:00:00Z');
    expect(ldl?.effective_end).toBeNull();
    expect(ldl?.value).toBe(118);
    expect(ldl?.unit).toBe('mg/dL');
    expect(ldl?.interpretation).toBe('N');
    expect(ldl?.ref_range).toBe('0-99 mg/dL');
  });

  it('extracts HbA1c with percent unit', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    const a1c = parsed.observations.find((o) => o.coding.code === '4548-4');
    expect(a1c?.value).toBe(5.6);
    expect(a1c?.unit).toBe('%');
  });

  it('extracts triglycerides', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    const trig = parsed.observations.find((o) => o.coding.code === '2571-8');
    expect(trig?.value).toBe(140);
    expect(trig?.unit).toBe('mg/dL');
  });

  it('extracts vital signs (BP, weight) as uniform observations', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    const sysBP = parsed.observations.find((o) => o.coding.code === '8480-6');
    expect(sysBP?.value).toBe(118);
    expect(sysBP?.unit).toBe('mm[Hg]');
    expect(sysBP?.date).toBe('2024-06-15');
    const weight = parsed.observations.find((o) => o.coding.code === '29463-7');
    expect(weight?.value).toBe(178);
  });

  it('reports document_date_range spanning observation dates', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.document_date_range).toEqual({ from: '2024-06-15', to: '2024-06-15' });
  });

  it('falls through to translation when outer value is nullFlavor=OTH', async () => {
    const bytes = await loadFixture('ccda-quest-translation.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    const ldl = parsed.observations.find((o) => o.coding.code === '13457-7');
    expect(ldl?.value).toBe(92);
    expect(ldl?.unit).toBe('mg/dL');
  });

  it('extracts structured problems from Problems section', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.problems).toHaveLength(1);
    const [p] = parsed.problems;
    expect(p?.name).toBe('Hyperlipidemia, unspecified');
    expect(p?.coding.system).toBe(SYSTEM_ICD10);
    expect(p?.coding.code).toBe('E78.5');
    expect(p?.status).toBe('completed');
    expect(p?.onset_date).toBe('2018-03-12');
  });

  it('extracts structured medications from Medications section', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.medications).toHaveLength(1);
    const [m] = parsed.medications;
    expect(m?.name).toBe('atorvastatin 20 MG Oral Tablet');
    expect(m?.coding.system).toBe(SYSTEM_RXNORM);
    expect(m?.coding.code).toBe('617314');
    expect(m?.dose).toBe('20 mg');
    expect(m?.route).toBe('ORAL');
    expect(m?.status).toBe('active');
    expect(m?.start_date).toBe('2021-06-01');
    expect(m?.end_date).toBeNull();
  });

  it('returns empty arrays when CCDA has no body sections', async () => {
    const bytes = await loadFixture('ccda-valid.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.observations).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.medications).toEqual([]);
    expect(parsed.document_date_range).toBeNull();
  });

  it('throws RecordParseError when narrative says a number but structured value is empty (whitelisted metric)', async () => {
    const bytes = await loadFixture('ccda-self-check-fail.xml');
    expect(() => ccdaKind.parseDocument(bytes)).toThrow(RecordParseError);
    expect(() => ccdaKind.parseDocument(bytes)).toThrow(/LDL-CHOLESTEROL/);
  });

  it('passes self-check when narrative and structured agree (rich fixture)', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    expect(() => ccdaKind.parseDocument(bytes)).not.toThrow();
  });

  it('walks nested narrative content (e.g., <td><content>5.6</content></td>) for self-check', async () => {
    // Matching narrative+structured — passes self-check, value extracted correctly
    const bytes = await loadFixture('ccda-nested-narrative.xml');
    expect(() => ccdaKind.parseDocument(bytes)).not.toThrow();
    const parsed = ccdaKind.parseDocument(bytes);
    const a1c = parsed.observations.find((o) => o.coding.code === '4548-4');
    expect(a1c?.value).toBe(5.6);
  });

  it('catches structured-empty mismatch when narrative is wrapped in nested elements', async () => {
    // Mismatch: narrative=156 wrapped in <content>, structured empty — self-check MUST fire
    const bytes = await loadFixture('ccda-self-check-nested-fail.xml');
    expect(() => ccdaKind.parseDocument(bytes)).toThrow(RecordParseError);
    expect(() => ccdaKind.parseDocument(bytes)).toThrow(/LDL-CHOLESTEROL/);
  });

  it('extracts conforming observations from a Results battery containing nullFlavor and missing-code siblings', async () => {
    // Real eClinicalWorks pattern: a single BATTERY organizer mixes labs that
    // have proper LOINC codes with calculated metrics like EGFR that the lab
    // emits as <code nullFlavor="UNK"/>, plus observations with no <code> at
    // all. Pre-fix, one such sibling caused atomic safeParse to drop the whole
    // section, hiding all 4 valid labs.
    const bytes = await loadFixture('ccda-ecw-mixed-codes.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.observations).toHaveLength(4);
    const codes = parsed.observations.map((o) => o.coding.code).sort();
    expect(codes).toEqual(['13457-7', '2085-9', '2571-8', '3016-3']);
    const ldl = parsed.observations.find((o) => o.coding.code === '13457-7');
    expect(ldl?.value).toBe(63);
    expect(ldl?.unit).toBe('mg/dL');
    const trig = parsed.observations.find((o) => o.coding.code === '2571-8');
    // Quest nullFlavor pattern still resolves via translation
    expect(trig?.value).toBe(65);
    expect(trig?.unit).toBe('mg/dL');
  });

  it('detects encounter document_type from templateId', async () => {
    const bytes = await loadFixture('ccda-encounter.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.document_type).toBe('encounter');
    expect(parsed.observations).toHaveLength(1);
  });

  it('returns unknown for templateIds we do not recognize', () => {
    const bytes = new TextEncoder().encode(
      `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3">
       <templateId root="9.9.9.9"/>
       <effectiveTime value="20240101"/>
     </ClinicalDocument>`,
    );
    expect(ccdaKind.parseDocument(bytes).document_type).toBe('unknown');
  });
});
