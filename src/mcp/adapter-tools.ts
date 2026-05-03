import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AdapterContext, AdapterRegistry } from '../adapters/index.js';
import { SyncError } from '../adapters/index.js';

const SyncInputSchema = z.object({
  adapter: z.string().min(1),
  params: z.unknown().optional(),
});

export interface AdapterToolDeps {
  registry: AdapterRegistry;
  ctx: AdapterContext;
}

export function registerAdapterTools(mcp: McpServer, deps: AdapterToolDeps): void {
  registerListAdaptersTool(mcp, deps);
  registerSyncTool(mcp, deps);
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
        const result = await adapter.sync(input.params, deps.ctx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return buildSyncErrorResponse(err);
      }
    },
  );
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
