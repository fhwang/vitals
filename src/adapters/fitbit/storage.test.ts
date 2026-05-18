import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { observations, openDatabase, sourceDocuments } from '#db';
import type { Observation } from '#records';
import { MemoryBlobStore } from '#storage';

import { createFitbitStore } from './storage.js';

const HR_CODING = { system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' } as const;

function sample(date: string, hour: number, minute: number, bpm: number): Observation {
  const stamp = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  return {
    coding: { ...HR_CODING },
    date,
    effective_start: stamp,
    effective_end: null,
    value: bpm,
    unit: '/min',
    ref_range: null,
    interpretation: null,
    source_document_key: `fitbit/intraday-hr/${date}.json`,
  };
}

function buildStore() {
  return createFitbitStore(openDatabase(':memory:'), new MemoryBlobStore());
}

describe('createFitbitStore', () => {
  describe('insertDay', () => {
    it('returns the max sample timestamp across inserted observations', async () => {
      const store = buildStore();
      const insertion = await store.insertDay('2026-04-29', { raw: 'json' }, [
        sample('2026-04-29', 7, 0, 62),
        sample('2026-04-29', 18, 30, 88),
        sample('2026-04-29', 12, 15, 110),
      ]);
      expect(insertion.samples_added).toBe(3);
      expect(insertion.max_sample_at).toBe('2026-04-29T18:30:00Z');
    });

    it('returns null max_sample_at when no numeric observations land', async () => {
      const store = buildStore();
      const insertion = await store.insertDay('2026-04-29', { raw: 'json' }, []);
      expect(insertion.samples_added).toBe(0);
      expect(insertion.max_sample_at).toBeNull();
    });
  });

  describe('dropDay', () => {
    it('returns false when no row exists for the date', () => {
      const store = buildStore();
      expect(store.dropDay('2026-04-29')).toBe(false);
    });

    it('cascade-deletes observations along with the source_documents row', async () => {
      const db = openDatabase(':memory:');
      const store = createFitbitStore(db, new MemoryBlobStore());
      await store.insertDay('2026-04-29', { raw: 'json' }, [
        sample('2026-04-29', 7, 0, 62),
        sample('2026-04-29', 18, 30, 88),
      ]);
      expect(store.dropDay('2026-04-29')).toBe(true);
      const remainingDocs = db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.archive_key, store.archiveKey('2026-04-29')))
        .all();
      const remainingObs = db.select({ id: observations.id }).from(observations).all();
      expect(remainingDocs).toHaveLength(0);
      expect(remainingObs).toHaveLength(0);
    });
  });

  describe('writeDayState + readDayState', () => {
    it('reads null when no row exists for the date', () => {
      const store = buildStore();
      expect(store.readDayState('2026-04-29')).toBeNull();
    });

    it('writes initial state with samples_count_prev null', () => {
      const store = buildStore();
      store.writeDayState('2026-04-29', 1234);
      const state = store.readDayState('2026-04-29');
      expect(state?.samples_count).toBe(1234);
      expect(state?.samples_count_prev).toBeNull();
      expect(state?.last_pulled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('rotates samples_count into samples_count_prev on subsequent writes', () => {
      const store = buildStore();
      store.writeDayState('2026-04-29', 1000);
      store.writeDayState('2026-04-29', 1200);
      const state = store.readDayState('2026-04-29');
      expect(state?.samples_count).toBe(1200);
      expect(state?.samples_count_prev).toBe(1000);
    });

    it('does not affect day-state rows for other dates', () => {
      const store = buildStore();
      store.writeDayState('2026-04-29', 1000);
      store.writeDayState('2026-04-30', 2000);
      store.writeDayState('2026-04-29', 1100);
      expect(store.readDayState('2026-04-29')?.samples_count).toBe(1100);
      expect(store.readDayState('2026-04-29')?.samples_count_prev).toBe(1000);
      expect(store.readDayState('2026-04-30')?.samples_count).toBe(2000);
      expect(store.readDayState('2026-04-30')?.samples_count_prev).toBeNull();
    });
  });
});
