import { z } from 'zod';

import { KindSchema } from '#records';

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const IngestInputSchema = z.object({
  path: z.string().min(1),
  kind: KindSchema,
  source: z.string().min(1),
  original_filename: z.string().min(1).optional(),
});

export const GetObservationHistoryInputSchema = z.object({
  codings: z
    .array(
      z.object({
        system: z.string().min(1),
        code: z.string().min(1),
      }),
    )
    .min(1),
  since: DateOnlySchema.optional(),
  until: DateOnlySchema.optional(),
});

export const GetPeriodDurationInputSchema = z.object({
  coding: z.object({
    system: z.string().min(1),
    code: z.string().min(1),
  }),
  date_range: z.object({
    start: DateOnlySchema,
    end: DateOnlySchema,
  }),
  value_range: z.object({
    min: z.number(),
    max: z.number(),
  }),
  bucket: z.enum(['none', 'day']),
});
