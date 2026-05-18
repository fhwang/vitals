import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LongestContinuousQuery, SqliteArchive } from '#query';

import { GetLongestContinuousPeriodInputSchema } from './schemas.js';

const TOOL_DESCRIPTION =
  'Return the longest contiguous span (in minutes) where a single FHIR coding\'s value stays within a numeric range over a date window. Sibling of get_period_duration_in_value_range; same input shape plus optional gap_seconds. Two adjacent period observations belong to the same run if next.effective_start − prev.effective_end ≤ gap_seconds (default 0, strict adjacency — appropriate for run-length-encoded epoch data like sleep stages). bucket="none" returns {longest_minutes, longest_start, longest_end}; bucket="day" returns per_bucket: [{bucket_start, longest_minutes, longest_start, longest_end}]. Each entry is attributed to the UTC calendar date of the run\'s end. Response also includes confidence_by_date and freshness_frontier_at, routed per coding through the registered adapter for that coding. The canonical AASM sleep-stage coding (system="https://vitals.fhwang.net/coding/aasm/sleep-stage", code="aasm-sleep-stage") is recognized — caller passes AASM stage numbers in value_range (0=wake, 1=N1, 2=N2, 3=N3, 4=REM; "any asleep" = min:1, max:4) and the query layer translates to per-adapter native observations under the conservative-inclusion rule.';

export function registerGetLongestContinuousPeriodTool(
  mcp: McpServer,
  archive: SqliteArchive,
): void {
  mcp.registerTool(
    'get_longest_continuous_period_in_value_range',
    { description: TOOL_DESCRIPTION, inputSchema: GetLongestContinuousPeriodInputSchema.shape },
    (input) => {
      const query: LongestContinuousQuery = {
        coding: input.coding,
        start_date: input.date_range.start,
        end_date: input.date_range.end,
        min_value: input.value_range.min,
        max_value: input.value_range.max,
        bucket: input.bucket,
        gap_seconds: input.gap_seconds,
      };
      const result = archive.getLongestContinuousPeriodInValueRange(query);
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    },
  );
}
