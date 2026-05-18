import type { Coding } from '#records';

import type { ConfidenceProvider } from './confidence.js';

// Per-adapter declaration of which codings the adapter contributes to the
// observations table, which canonical taxonomies it maps into, and how
// confidence/freshness should be computed for queries that hit those codings.
//
// The query layer consults this registry to (a) route confidence/freshness
// requests to the right adapter, and (b) translate canonical-coding queries
// (e.g., AASM sleep-stage) into per-adapter native queries.

export interface NativeValueRange {
  min: number;
  max: number;
}

export interface CanonicalContribution {
  // The canonical coding the caller might query against (e.g., AASM sleep).
  canonical_coding: Coding;
  // The native coding this adapter actually stores observations under.
  native_coding: Coding;
  // Returns the native value-range(s) that conservatively match the
  // canonical range. Empty when no native codes qualify.
  translateValueRange: (canonical: NativeValueRange) => readonly NativeValueRange[];
}

export interface AdapterCodingRegistration {
  adapter_name: string;
  // Native codings this adapter writes to the observations table. Other
  // adapters may write to the same coding-system (e.g., both Fitbit and Oura
  // write LOINC observations) — uniqueness is at the (system, code) tuple.
  native_codings: readonly Coding[];
  // Canonical taxonomies this adapter participates in.
  canonical_contributions: readonly CanonicalContribution[];
  confidence_provider: ConfidenceProvider;
}

// One slot in the rewritten-query plan: which coding to actually query, and
// with what value range. For native-coding queries the plan is a single slot
// (coding + caller's value range, identity). For canonical-coding queries the
// plan fans out — one slot per contributing adapter, each with its native
// coding and translated range(s).
export interface QueryPlanSlot {
  adapter_name: string;
  native_coding: Coding;
  native_value_range: NativeValueRange;
}

export type CodingRegistry = ReturnType<typeof createCodingRegistry>;

export function createCodingRegistry() {
  const registrations: AdapterCodingRegistration[] = [];
  return {
    register(registration: AdapterCodingRegistration): void {
      registrations.push(registration);
    },
    planQuery: (coding: Coding, valueRange: NativeValueRange) =>
      planQuery(registrations, coding, valueRange),
    getConfidenceProvider: (coding: Coding) => getConfidenceProvider(registrations, coding),
  };
}

function findByNativeCoding(
  registrations: readonly AdapterCodingRegistration[],
  coding: Coding,
): AdapterCodingRegistration | null {
  for (const reg of registrations) {
    for (const native of reg.native_codings) {
      if (native.system === coding.system && native.code === coding.code) return reg;
    }
  }
  return null;
}

function findContributors(
  registrations: readonly AdapterCodingRegistration[],
  canonical: Coding,
): readonly AdapterCodingRegistration[] {
  return registrations.filter((reg) =>
    reg.canonical_contributions.some(
      (c) =>
        c.canonical_coding.system === canonical.system &&
        c.canonical_coding.code === canonical.code,
    ),
  );
}

function findContribution(
  reg: AdapterCodingRegistration,
  canonical: Coding,
): CanonicalContribution | undefined {
  return reg.canonical_contributions.find(
    (c) =>
      c.canonical_coding.system === canonical.system && c.canonical_coding.code === canonical.code,
  );
}

function planQuery(
  registrations: readonly AdapterCodingRegistration[],
  coding: Coding,
  valueRange: NativeValueRange,
): readonly QueryPlanSlot[] {
  const native = findByNativeCoding(registrations, coding);
  if (native !== null) {
    return [
      { adapter_name: native.adapter_name, native_coding: coding, native_value_range: valueRange },
    ];
  }
  const canonicalPlan = planCanonical(registrations, coding, valueRange);
  if (canonicalPlan.length > 0) return canonicalPlan;
  // Identity fallback: queries against unregistered codings pass through
  // directly. The registry adds *routing*, not gating — callers can still
  // query any (system, code) pair against the observations table even if no
  // adapter has registered ownership.
  return [{ adapter_name: '', native_coding: coding, native_value_range: valueRange }];
}

function planCanonical(
  registrations: readonly AdapterCodingRegistration[],
  canonical: Coding,
  valueRange: NativeValueRange,
): readonly QueryPlanSlot[] {
  const out: QueryPlanSlot[] = [];
  for (const reg of findContributors(registrations, canonical)) {
    const contribution = findContribution(reg, canonical);
    if (contribution === undefined) continue;
    out.push(...contributionSlots(reg, contribution, valueRange));
  }
  return out;
}

function contributionSlots(
  reg: AdapterCodingRegistration,
  contribution: CanonicalContribution,
  valueRange: NativeValueRange,
): readonly QueryPlanSlot[] {
  return contribution.translateValueRange(valueRange).map((native_value_range) => ({
    adapter_name: reg.adapter_name,
    native_coding: contribution.native_coding,
    native_value_range,
  }));
}

function getConfidenceProvider(
  registrations: readonly AdapterCodingRegistration[],
  coding: Coding,
): ConfidenceProvider | null {
  const native = findByNativeCoding(registrations, coding);
  if (native !== null) return native.confidence_provider;
  const contributors = findContributors(registrations, coding);
  if (contributors.length === 0) return null;
  if (contributors.length === 1) {
    const only = contributors[0];
    return only === undefined ? null : only.confidence_provider;
  }
  return buildCompositeProvider(contributors);
}

// Composite provider for canonical codings with multiple contributing
// adapters. Confidence is most-conservative across contributors (any
// provisional makes the date provisional). Freshness is the minimum across
// contributors, or null if any contributor returns null.
function buildCompositeProvider(
  contributors: readonly AdapterCodingRegistration[],
): ConfidenceProvider {
  return {
    buildConfidenceByDate: (now, dateRange) => {
      const perAdapter = contributors.map((c) =>
        c.confidence_provider.buildConfidenceByDate(now, dateRange),
      );
      return combineConfidence(perAdapter);
    },
    getFreshnessFrontier: () => {
      const frontiers = contributors.map((c) => c.confidence_provider.getFreshnessFrontier());
      if (frontiers.some((f) => f === null)) return null;
      const nonNull = frontiers.filter((f): f is string => f !== null);
      if (nonNull.length === 0) return null;
      return nonNull.reduce((min, cur) => (cur < min ? cur : min));
    },
  };
}

function combineConfidence(
  perAdapter: readonly { date: string; confidence: 'confirmed' | 'provisional' }[][],
): { date: string; confidence: 'confirmed' | 'provisional' }[] {
  if (perAdapter.length === 0) return [];
  const first = perAdapter[0];
  if (first === undefined) return [];
  return first.map((entry, i) => {
    const anyProvisional = perAdapter.some(
      (adapterDates) => adapterDates[i]?.confidence === 'provisional',
    );
    return { date: entry.date, confidence: anyProvisional ? 'provisional' : 'confirmed' };
  });
}
