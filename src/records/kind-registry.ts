import { z } from 'zod';

import { ccdaKind } from './ccda.js';

export interface KindHandler {
  readonly kind: string;
  readonly extension: string;
  readonly contentType: string;
  validateBytes(bytes: Uint8Array): void;
}

export const kindRegistry = {
  ccda: ccdaKind,
} as const satisfies Record<string, KindHandler>;

export type Kind = keyof typeof kindRegistry;

const kindKeys = Object.keys(kindRegistry) as [Kind, ...Kind[]];

export const KindSchema = z.enum(kindKeys);
