import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ccdaKind } from './ccda.js';

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
