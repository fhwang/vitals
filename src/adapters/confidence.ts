// Adapter-agnostic confidence types and provider interface.
//
// Each adapter that produces time-series observations is expected to expose a
// `ConfidenceProvider` describing (a) which dates are settled vs still
// arriving, and (b) the most-recent observation timestamp it has seen. The
// query layer routes per-coding queries to the right provider based on the
// taxonomy/coding-system registry.

export type DayConfidence = 'confirmed' | 'provisional';

export interface ConfidenceByDate {
  date: string;
  confidence: DayConfidence;
}

export interface ConfidenceProvider {
  buildConfidenceByDate(now: Date, dateRange: readonly [string, string]): ConfidenceByDate[];
  getFreshnessFrontier(): string | null;
}

// Enumerate every YYYY-MM-DD date in the inclusive range. Lives here (not in a
// per-adapter file) because every ConfidenceProvider implementation builds
// per-date results over the same date enumeration.
export function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
