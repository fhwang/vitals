import '../preflight.js';

import type { Logger } from 'pino';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import type { AdapterRegistry } from '#adapters';
import { buildConditionsInput, getDefaultHeartbeatPath } from '#daemon';
import type { Db } from '#db';
import {
  createMacOsNotificationChannel,
  evaluateAndNotify,
  type NotificationChannel,
} from '#notifications';
import {
  createSqliteArchive,
  type ObservationHistoryQuery,
  type PeriodDurationQuery,
  type SqliteArchive,
} from '#query';
import {
  FileNotFoundError,
  PathOutsideRootsError,
  RecordParseError,
  UnsupportedKindError,
  ingestRecord,
  type IngestInput,
} from '#records';
import type { BlobStore } from '#storage';
import { buildCore } from '../bootstrap.js';
import { registerAdapterTools } from './adapter-tools.js';
import { RootsState } from './roots.js';
import {
  GetObservationHistoryInputSchema,
  GetPeriodDurationInputSchema,
  IngestInputSchema,
} from './schemas.js';

function mapError(err: unknown): string {
  if (err instanceof PathOutsideRootsError) return 'path_outside_roots';
  if (err instanceof FileNotFoundError) return 'file_not_found';
  if (err instanceof UnsupportedKindError) return 'unsupported_kind';
  if (err instanceof RecordParseError) return 'parse_failed';
  return 'internal_error';
}

export function parseAllowedDirs(argv: readonly string[]): readonly string[] {
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--allowed-dir') continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error('--allowed-dir requires a path argument');
    }
    dirs.push(next);
    i++;
  }
  return dirs;
}

export interface IngestToolDeps {
  store: BlobStore;
  db: Db;
  roots: RootsState;
}

export interface ServerDeps {
  store: BlobStore;
  db: Db;
  roots: RootsState;
  registry: AdapterRegistry;
  logger: Logger;
}

export function registerIngestRecordTool(mcp: McpServer, deps: IngestToolDeps): void {
  mcp.registerTool(
    'ingest_record',
    {
      description:
        'Ingest a health-data record into the vitals archive. The path must be inside a directory advertised by the client as a root. Supported kinds: ccda.',
      inputSchema: IngestInputSchema.shape,
    },
    async (input) => {
      try {
        const ingestInput: IngestInput =
          input.original_filename === undefined
            ? { path: input.path, kind: input.kind, source: input.source }
            : {
                path: input.path,
                kind: input.kind,
                source: input.source,
                original_filename: input.original_filename,
              };
        const result = await ingestRecord(
          {
            store: deps.store,
            db: deps.db,
            validatePath: (p) => deps.roots.validatePath(p),
          },
          ingestInput,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const code = mapError(err);
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
        };
      }
    },
  );
}

export function registerListDocumentsTool(mcp: McpServer, archive: SqliteArchive): void {
  mcp.registerTool(
    'list_documents',
    {
      description:
        'List all ingested documents in the vitals archive with metadata, document type, date range, observation count, and which patient-state concepts each document contributes to.',
      inputSchema: {},
    },
    () => {
      const docs = archive.listDocuments();
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }],
      });
    },
  );
}

export function registerListMetricsTool(mcp: McpServer, archive: SqliteArchive): void {
  mcp.registerTool(
    'list_metrics',
    {
      description:
        'List all distinct observation metrics (FHIR Codings) in the vitals archive, with observation count, observation date span, and unit per metric.',
      inputSchema: {},
    },
    () => {
      const metrics = archive.listMetrics();
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }],
      });
    },
  );
}

export function registerGetObservationHistoryTool(mcp: McpServer, archive: SqliteArchive): void {
  mcp.registerTool(
    'get_observation_history',
    {
      description:
        'Return chronologically-sorted observations matching one or more FHIR Coding identifiers, optionally filtered by date range.',
      inputSchema: GetObservationHistoryInputSchema.shape,
    },
    (input) => {
      const query: ObservationHistoryQuery = { codings: input.codings };
      if (input.since !== undefined) query.since = input.since;
      if (input.until !== undefined) query.until = input.until;
      const history = archive.getObservationHistory(query);
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
      });
    },
  );
}

export function registerGetPeriodDurationTool(mcp: McpServer, archive: SqliteArchive): void {
  mcp.registerTool(
    'get_period_duration_in_value_range',
    {
      description:
        'Sum the time spent in a numeric value range for a single FHIR coding over a date window, optionally bucketed by day. Only period-shaped observations (with both effective_start and effective_end) contribute; instant observations are ignored. Returns total_minutes (bucket="none") or per_bucket: [{bucket_start, minutes}] (bucket="day"). value_range bounds are inclusive. Every response also includes confidence_by_date (per-date "confirmed" | "provisional" tags covering the full window — provisional means data may still be arriving and the number could grow) and freshness_frontier_at (ISO timestamp of the most recent sample observed across syncing adapters, or null if no adapter has synced).',
      inputSchema: GetPeriodDurationInputSchema.shape,
    },
    (input) => {
      const query: PeriodDurationQuery = {
        coding: input.coding,
        start_date: input.date_range.start,
        end_date: input.date_range.end,
        min_value: input.value_range.min,
        max_value: input.value_range.max,
        bucket: input.bucket,
      };
      const result = archive.getPeriodDurationInValueRange(query);
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    },
  );
}

export function registerGetCurrentProblemsTool(mcp: McpServer, archive: SqliteArchive): void {
  mcp.registerTool(
    'get_current_problems',
    {
      description:
        'Return the active problem list from the most recent CCD-shaped document in the archive, with its source document key and date.',
      inputSchema: {},
    },
    async () => {
      const result = await archive.getCurrentProblems();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

export function registerGetCurrentMedicationsTool(mcp: McpServer, archive: SqliteArchive): void {
  mcp.registerTool(
    'get_current_medications',
    {
      description:
        'Return the active medication list from the most recent CCD-shaped document in the archive, with its source document key and date.',
      inputSchema: {},
    },
    async () => {
      const result = await archive.getCurrentMedications();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

function ingestToolDepsFrom(deps: ServerDeps): IngestToolDeps {
  return { store: deps.store, db: deps.db, roots: deps.roots };
}

function registerAllTools(mcp: McpServer, deps: ServerDeps): void {
  registerIngestRecordTool(mcp, ingestToolDepsFrom(deps));
  const archive = createSqliteArchive(deps.db, deps.store);
  registerListDocumentsTool(mcp, archive);
  registerListMetricsTool(mcp, archive);
  registerGetObservationHistoryTool(mcp, archive);
  registerGetPeriodDurationTool(mcp, archive);
  registerGetCurrentProblemsTool(mcp, archive);
  registerGetCurrentMedicationsTool(mcp, archive);
  registerAdapterTools(mcp, {
    registry: deps.registry,
    ctx: { db: deps.db, store: deps.store, logger: deps.logger },
    heartbeatPath: getDefaultHeartbeatPath(),
  });
}

// Called once at MCP-server startup. Reads the daemon heartbeat (touched at
// the end of each successful daemon tick) and dispatches the full condition
// evaluator. If the daemon has been silent for >24h, the
// daemon-heartbeat-stale notification fires here — that's the path by which
// a dead daemon eventually surfaces to the user, since the daemon itself
// can't notify when it's not running.
//
// Other notifications (auth, sync failures) can also fire here if the daemon
// got stuck before reaching its own evaluateAndNotify call. Dedup means a
// user-facing notification fires once per re-fire window regardless of
// which actor pushes it.
export async function checkDaemonHealth(
  db: Db,
  channel: NotificationChannel,
  heartbeatPath: string,
): Promise<void> {
  const input = buildConditionsInput(db, heartbeatPath, new Date());
  await evaluateAndNotify({ db, channel }, input);
}

async function runHealthCheckBestEffort(db: Db, logger: Logger): Promise<void> {
  try {
    await checkDaemonHealth(db, createMacOsNotificationChannel(), getDefaultHeartbeatPath());
  } catch (err) {
    // Never let a notification-side failure block tool serving — this is a
    // best-effort health check, not load-bearing.
    logger.warn({ err }, 'daemon health check failed');
  }
}

export async function startMcpServer(): Promise<void> {
  const { logger, store, db, adapters } = buildCore(true);
  const mcp = new McpServer({ name: 'vitals', version: '0.0.0' });
  const roots = new RootsState();
  await runHealthCheckBestEffort(db, logger);

  async function refreshRoots(): Promise<void> {
    const cliUris = parseAllowedDirs(process.argv.slice(2)).map((p) => `file://${p}`);
    let protocolUris: readonly string[] = [];
    try {
      protocolUris = (await mcp.server.listRoots()).roots.map((r) => r.uri);
    } catch (err) {
      logger.warn({ err }, 'failed to refresh roots from client');
    }
    await roots.setRoots([...cliUris, ...protocolUris]);
    logger.info({ cli: cliUris.length, protocol: protocolUris.length }, 'roots updated');
  }

  mcp.server.oninitialized = () => {
    void refreshRoots();
  };
  mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, refreshRoots);
  registerAllTools(mcp, { store, db, roots, registry: adapters, logger });
  await mcp.connect(new StdioServerTransport());
  logger.info('mcp server connected over stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
