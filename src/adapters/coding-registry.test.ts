import { describe, expect, it } from 'vitest';

import {
  AASM_SLEEP_STAGE_CODE,
  AASM_SLEEP_STAGE_SYSTEM,
  SYSTEM_LOINC,
  type Coding,
} from '#records';

import { createCodingRegistry, type AdapterCodingRegistration } from './coding-registry.js';
import type { ConfidenceProvider } from './confidence.js';

const STUB_PROVIDER: ConfidenceProvider = {
  buildConfidenceByDate: () => [],
  getFreshnessFrontier: () => null,
};

function reg(overrides: Partial<AdapterCodingRegistration>): AdapterCodingRegistration {
  return {
    adapter_name: 'stub',
    native_codings: [],
    canonical_contributions: [],
    confidence_provider: STUB_PROVIDER,
    ...overrides,
  };
}

describe('createCodingRegistry', () => {
  it('planQuery returns the native query identity for a registered native coding', () => {
    const registry = createCodingRegistry();
    const heartRate: Coding = { system: SYSTEM_LOINC, code: '8867-4' };
    registry.register(reg({ adapter_name: 'fitbit', native_codings: [heartRate] }));
    const plan = registry.planQuery(heartRate, { min: 60, max: 100 });
    expect(plan).toEqual([
      {
        adapter_name: 'fitbit',
        native_coding: heartRate,
        native_value_range: { min: 60, max: 100 },
      },
    ]);
  });

  it('planQuery translates a canonical coding via the contributor', () => {
    const registry = createCodingRegistry();
    const canonical: Coding = { system: AASM_SLEEP_STAGE_SYSTEM, code: AASM_SLEEP_STAGE_CODE };
    const native: Coding = { system: 'urn:test:native', code: 'native' };
    registry.register(
      reg({
        adapter_name: 'fake',
        native_codings: [native],
        canonical_contributions: [
          {
            canonical_coding: canonical,
            native_coding: native,
            translateValueRange: (r) => [{ min: r.min + 10, max: r.max + 10 }],
          },
        ],
      }),
    );
    const plan = registry.planQuery(canonical, { min: 1, max: 4 });
    expect(plan).toEqual([
      { adapter_name: 'fake', native_coding: native, native_value_range: { min: 11, max: 14 } },
    ]);
  });

  it('planQuery falls back to identity (single passthrough slot) for unregistered codings', () => {
    const registry = createCodingRegistry();
    const orphan: Coding = { system: 'urn:test:nowhere', code: 'x' };
    expect(registry.planQuery(orphan, { min: 0, max: 1 })).toEqual([
      { adapter_name: '', native_coding: orphan, native_value_range: { min: 0, max: 1 } },
    ]);
  });

  it('getConfidenceProvider routes native codings to the adapter that produces them', () => {
    const registry = createCodingRegistry();
    const oneProvider: ConfidenceProvider = {
      buildConfidenceByDate: () => [{ date: '2026-05-17', confidence: 'confirmed' }],
      getFreshnessFrontier: () => '2026-05-17T00:00:00Z',
    };
    const coding: Coding = { system: SYSTEM_LOINC, code: '8867-4' };
    registry.register(
      reg({
        adapter_name: 'fitbit',
        native_codings: [coding],
        confidence_provider: oneProvider,
      }),
    );
    const got = registry.getConfidenceProvider(coding);
    expect(got?.getFreshnessFrontier()).toBe('2026-05-17T00:00:00Z');
  });

  it('getConfidenceProvider returns the single contributor for a canonical coding', () => {
    const registry = createCodingRegistry();
    const canonical: Coding = { system: AASM_SLEEP_STAGE_SYSTEM, code: AASM_SLEEP_STAGE_CODE };
    const native: Coding = { system: 'urn:test:native', code: 'native' };
    const ouraProvider: ConfidenceProvider = {
      buildConfidenceByDate: () => [],
      getFreshnessFrontier: () => '2026-05-17T07:30:00Z',
    };
    registry.register(
      reg({
        adapter_name: 'oura',
        native_codings: [native],
        canonical_contributions: [
          { canonical_coding: canonical, native_coding: native, translateValueRange: () => [] },
        ],
        confidence_provider: ouraProvider,
      }),
    );
    const got = registry.getConfidenceProvider(canonical);
    expect(got?.getFreshnessFrontier()).toBe('2026-05-17T07:30:00Z');
  });

  it('getConfidenceProvider composes multiple contributors (most-provisional / min frontier)', () => {
    const registry = createCodingRegistry();
    const canonical: Coding = { system: AASM_SLEEP_STAGE_SYSTEM, code: AASM_SLEEP_STAGE_CODE };
    const earlyProvider: ConfidenceProvider = {
      buildConfidenceByDate: () => [{ date: '2026-05-17', confidence: 'confirmed' }],
      getFreshnessFrontier: () => '2026-05-17T05:00:00Z',
    };
    const lateProvider: ConfidenceProvider = {
      buildConfidenceByDate: () => [{ date: '2026-05-17', confidence: 'provisional' }],
      getFreshnessFrontier: () => '2026-05-17T10:00:00Z',
    };
    const nA: Coding = { system: 'urn:a', code: 'a' };
    const nB: Coding = { system: 'urn:b', code: 'b' };
    registry.register(
      reg({
        adapter_name: 'a',
        native_codings: [nA],
        canonical_contributions: [
          { canonical_coding: canonical, native_coding: nA, translateValueRange: () => [] },
        ],
        confidence_provider: earlyProvider,
      }),
    );
    registry.register(
      reg({
        adapter_name: 'b',
        native_codings: [nB],
        canonical_contributions: [
          { canonical_coding: canonical, native_coding: nB, translateValueRange: () => [] },
        ],
        confidence_provider: lateProvider,
      }),
    );
    const got = registry.getConfidenceProvider(canonical);
    // Min frontier: 05:00 wins (earlier)
    expect(got?.getFreshnessFrontier()).toBe('2026-05-17T05:00:00Z');
    // Combine confidence: provisional wins
    expect(got?.buildConfidenceByDate(new Date(), ['2026-05-17', '2026-05-17'])).toEqual([
      { date: '2026-05-17', confidence: 'provisional' },
    ]);
  });
});
