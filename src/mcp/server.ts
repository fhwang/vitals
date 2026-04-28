import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { buildCore } from '../bootstrap.js';
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
  registerIngestRecordTool(mcp, store, roots);
  await mcp.connect(new StdioServerTransport());
  logger.info('mcp server connected over stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
