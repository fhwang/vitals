import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { buildCore } from '../bootstrap.js';
import { ArchiveCache } from '../query/index.js';
import type { ObservationHistoryQuery } from '../query/index.js';
import {
  FileNotFoundError,
  KindSchema,
  PathOutsideRootsError,
  RecordParseError,
  UnsupportedKindError,
  ingestRecord,
} from '../records/index.js';
import type { IngestInput } from '../records/index.js';
import type { BlobStore } from '../storage/index.js';
import { RootsState } from './roots.js';

const IngestInputSchema = z.object({
  path: z.string().min(1),
  kind: KindSchema,
  source: z.string().min(1),
  original_filename: z.string().min(1).optional(),
});

const GetObservationHistoryInputSchema = z.object({
  codings: z
    .array(
      z.object({
        system: z.string().min(1),
        code: z.string().min(1),
      }),
    )
    .min(1),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
});

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

export function registerIngestRecordTool(
  mcp: McpServer,
  store: BlobStore,
  roots: RootsState,
): void {
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
        const result = await ingestRecord(store, (p) => roots.validatePath(p), ingestInput);
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

export function registerListDocumentsTool(mcp: McpServer, archive: ArchiveCache): void {
  mcp.registerTool(
    'list_documents',
    {
      description:
        'List all ingested documents in the vitals archive with metadata, document type, date range, observation count, and which patient-state concepts each document contributes to.',
      inputSchema: {},
    },
    async () => {
      const docs = await archive.listDocuments();
      return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
    },
  );
}

export function registerListMetricsTool(mcp: McpServer, archive: ArchiveCache): void {
  mcp.registerTool(
    'list_metrics',
    {
      description:
        'List all distinct observation metrics (FHIR Codings) in the vitals archive, with observation count, observation date span, and unit per metric.',
      inputSchema: {},
    },
    async () => {
      const metrics = await archive.listMetrics();
      return { content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }] };
    },
  );
}

export function registerGetObservationHistoryTool(mcp: McpServer, archive: ArchiveCache): void {
  mcp.registerTool(
    'get_observation_history',
    {
      description:
        'Return chronologically-sorted observations matching one or more FHIR Coding identifiers, optionally filtered by date range.',
      inputSchema: GetObservationHistoryInputSchema.shape,
    },
    async (input) => {
      const query: ObservationHistoryQuery = { codings: input.codings };
      if (input.since !== undefined) query.since = input.since;
      if (input.until !== undefined) query.until = input.until;
      const history = await archive.getObservationHistory(query);
      return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };
    },
  );
}

export function registerGetCurrentProblemsTool(mcp: McpServer, archive: ArchiveCache): void {
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

export function registerGetCurrentMedicationsTool(mcp: McpServer, archive: ArchiveCache): void {
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

function registerAllTools(mcp: McpServer, store: BlobStore, roots: RootsState): void {
  registerIngestRecordTool(mcp, store, roots);
  const archive = new ArchiveCache(store);
  registerListDocumentsTool(mcp, archive);
  registerListMetricsTool(mcp, archive);
  registerGetObservationHistoryTool(mcp, archive);
  registerGetCurrentProblemsTool(mcp, archive);
  registerGetCurrentMedicationsTool(mcp, archive);
}

export async function startMcpServer(): Promise<void> {
  const { logger, store } = buildCore(true);
  const mcp = new McpServer({ name: 'vitals', version: '0.0.0' });
  const roots = new RootsState();
  const cliDirs = parseAllowedDirs(process.argv.slice(2));

  async function refreshRoots(): Promise<void> {
    let protocolUris: readonly string[] = [];
    try {
      protocolUris = (await mcp.server.listRoots()).roots.map((r) => r.uri);
    } catch (err) {
      logger.warn({ err }, 'failed to refresh roots from client');
    }
    const cliUris = cliDirs.map((p) => `file://${p}`);
    await roots.setRoots([...cliUris, ...protocolUris]);
    logger.info({ cli: cliUris.length, protocol: protocolUris.length }, 'roots updated');
  }

  mcp.server.oninitialized = () => {
    void refreshRoots();
  };
  mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, refreshRoots);
  registerAllTools(mcp, store, roots);
  await mcp.connect(new StdioServerTransport());
  logger.info('mcp server connected over stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
