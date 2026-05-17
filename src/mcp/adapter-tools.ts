import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  readState,
  SyncError,
  type AdapterContext,
  type AdapterRegistry,
  type AdapterState,
} from '#adapters';
import { readHeartbeatMtime } from '#daemon';
import type { Db } from '#db';
import { listNotificationLog, type NotificationLogEntry } from '#notifications';

const SyncInputSchema = z.object({
  adapter: z.string().min(1),
  params: z.looseObject({}).optional(),
});

export interface AdapterToolDeps {
  registry: AdapterRegistry;
  ctx: AdapterContext;
  heartbeatPath: string;
}

export interface AdapterHealthDeps {
  registry: AdapterRegistry;
  db: Db;
  heartbeatPath: string;
}

export function registerAdapterTools(mcp: McpServer, deps: AdapterToolDeps): void {
  registerListAdaptersTool(mcp, deps);
  registerSyncTool(mcp, deps);
  registerGetAdapterHealthTool(mcp, {
    registry: deps.registry,
    db: deps.ctx.db,
    heartbeatPath: deps.heartbeatPath,
  });
}

export function registerListAdaptersTool(mcp: McpServer, deps: AdapterToolDeps): void {
  mcp.registerTool(
    'list_adapters',
    {
      description:
        'List adapters available for sync. Each entry includes name, description, requires_auth, and parameter_schema (JSON-Schema-shaped) so the caller knows what to pass to sync.',
      inputSchema: {},
    },
    () => {
      const summary = deps.registry.list().map((a) => ({
        name: a.name,
        description: a.description,
        requires_auth: a.requires_auth,
        parameter_schema: z.toJSONSchema(a.parameter_schema),
      }));
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      });
    },
  );
}

export function registerSyncTool(mcp: McpServer, deps: AdapterToolDeps): void {
  mcp.registerTool(
    'sync',
    {
      description:
        'Run a named adapter to pull fresh data into the vitals archive. On success returns {adapter, days_pulled, samples_added, samples_existing, last_synced_at}. On failure returns isError with {reason, message}; reason is one of: reauth_required, parse_error, transient, no_credentials.',
      inputSchema: SyncInputSchema.shape,
    },
    async (input) => {
      const adapter = deps.registry.get(input.adapter);
      if (adapter === undefined) {
        return errorResponse('parse_error', `unknown adapter: ${input.adapter}`);
      }
      try {
        const result = await adapter.sync(input.params ?? {}, deps.ctx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return buildSyncErrorResponse(err);
      }
    },
  );
}

// Mirrors AdapterState's discriminated-union shape directly so callers get a
// minimal, status-correlated view rather than a flat record with half the
// fields nullable. AdapterState is the source of truth — this type just
// re-exports it under the response field name.
export interface AdapterHealthResponse {
  adapters: AdapterState[];
  daemon_heartbeat_at: string | null;
  recent_notifications: NotificationLogEntry[];
}

export function registerGetAdapterHealthTool(mcp: McpServer, deps: AdapterHealthDeps): void {
  mcp.registerTool(
    'get_adapter_health',
    {
      description:
        'Inspect the operational health of each registered adapter: last sync time, freshness frontier, ticks since the frontier advanced, consecutive failure count, last error (if any), the daemon heartbeat timestamp, and the most recent user-facing notifications vitals has fired. Useful to include a "Data Health" section in periodic reports or to debug sync gaps. Read-only.',
      inputSchema: {},
    },
    () => {
      const response = buildAdapterHealthResponse(deps);
      return Promise.resolve({
        content: [{ type: 'text', text: serializeAdapterHealthResponse(response) }],
      });
    },
  );
}

function buildAdapterHealthResponse(deps: AdapterHealthDeps): AdapterHealthResponse {
  const adapters = deps.registry.list().map((a) => readState(deps.db, a.name));
  const heartbeat = readHeartbeatMtime(deps.heartbeatPath);
  return {
    adapters,
    daemon_heartbeat_at: heartbeat?.toISOString() ?? null,
    recent_notifications: listNotificationLog(deps.db, 20),
  };
}

function serializeAdapterHealthResponse(response: AdapterHealthResponse): string {
  return JSON.stringify(response, null, 2);
}

function errorResponse(
  reason: string,
  message: string,
): { isError: true; content: { type: 'text'; text: string }[] } {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ reason, message }) }],
  };
}

function buildSyncErrorResponse(err: unknown): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  if (err instanceof SyncError) {
    return errorResponse(err.reason, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse('parse_error', message);
}
