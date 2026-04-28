import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

import { RecordParseError } from './errors.js';
import type { KindHandler } from './kind-registry.js';

const CCDA_NAMESPACE = 'urn:hl7-org:v3';

const ClinicalDocumentSchema = z.object({
  ClinicalDocument: z.object({
    '@_xmlns': z.string(),
  }),
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function parseXml(bytes: Uint8Array): unknown {
  const xml = new TextDecoder().decode(bytes);
  try {
    return parser.parse(xml);
  } catch (err) {
    throw new RecordParseError('ccda', 'malformed XML', { cause: err });
  }
}

export const ccdaKind: KindHandler = {
  kind: 'ccda',
  extension: 'xml',
  contentType: 'application/xml',
  validateBytes(bytes: Uint8Array): void {
    const parsed = parseXml(bytes);
    const result = ClinicalDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new RecordParseError('ccda', 'root element is not ClinicalDocument');
    }
    if (result.data.ClinicalDocument['@_xmlns'] !== CCDA_NAMESPACE) {
      throw new RecordParseError(
        'ccda',
        `expected xmlns="${CCDA_NAMESPACE}", got "${result.data.ClinicalDocument['@_xmlns']}"`,
      );
    }
  },
};
