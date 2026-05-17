import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SyncError,
  createAdapterRegistry,
  writeStateError,
  writeStateSuccess,
  type Adapter,
  type AdapterContext,
  type AdapterRegistry,
  type SyncResult,
} from '#adapters';
import { writeHeartbeat } from '#daemon';
import { openDatabase, type Db } from '#db';
import { MemoryBlobStore } from '#storage';
import type { AdapterHealthResponse } from './adapter-tools.js';
import { registerAdapterTools } from './adapter-tools.js';

interface ToolTextResponse {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

function extractText(res: unknown): string {
  const typed = res as ToolTextResponse;
  const first = typed.content[0];
  if (first === undefined) throw new Error('no content');
  return first.text;
}

function isError(res: unknown): boolean {
  return (res as ToolTextResponse).isError === true;
}

interface AdapterHarness {
  client: Client;
  registry: AdapterRegistry;
  db: Db;
  ctx: AdapterContext;
  heartbeatPath: string;
  dispose: () => Promise<void>;
}

async function buildHarness(): Promise<AdapterHarness> {
  const registry = createAdapterRegistry();
  const db = openDatabase(':memory:');
  const ctx: AdapterContext = {
    db,
    store: new MemoryBlobStore(),
    logger: pino({ level: 'silent' }),
  };
  const tmp = mkdtempSync(join(tmpdir(), 'vitals-adapter-tools-'));
  const heartbeatPath = join(tmp, 'heartbeat');
  const mcp = new McpServer({ name: 'vitals', version: 'test' });
  registerAdapterTools(mcp, { registry, ctx, heartbeatPath });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: 'test' }, { capabilities: {} });
  await Promise.all([mcp.connect(serverT), client.connect(clientT)]);
  return {
    client,
    registry,
    db,
    ctx,
    heartbeatPath,
    dispose: async () => {
      await client.close();
      await mcp.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function makeAdapter(name: string, sync: Adapter['sync']): Adapter {
  return {
    name,
    description: `${name} adapter`,
    parameter_schema: z.object({}),
    requires_auth: false,
    sync,
  };
}

describe('list_adapters tool', () => {
  it('returns the registered adapters with their parameter schemas', async () => {
    const h = await buildHarness();
    try {
      h.registry.register(
        makeAdapter('alpha', () =>
          Promise.resolve({
            adapter: 'alpha',
            days_pulled: 0,
            samples_added: 0,
            samples_existing: 0,
            last_synced_at: '2026-04-30T00:00:00Z',
          }),
        ),
      );
      const res = await h.client.callTool({ name: 'list_adapters', arguments: {} });
      const body = JSON.parse(extractText(res)) as {
        name: string;
        description: string;
        requires_auth: boolean;
      }[];
      expect(body).toHaveLength(1);
      expect(body[0]?.name).toBe('alpha');
      expect(body[0]?.requires_auth).toBe(false);
    } finally {
      await h.dispose();
    }
  });
});

describe('sync tool', () => {
  it('dispatches to the named adapter and returns its SyncResult', async () => {
    const h = await buildHarness();
    try {
      const expected: SyncResult = {
        adapter: 'alpha',
        days_pulled: 1,
        samples_added: 1440,
        samples_existing: 0,
        last_synced_at: '2026-04-30T00:00:00Z',
      };
      h.registry.register(makeAdapter('alpha', () => Promise.resolve(expected)));

      const res = await h.client.callTool({
        name: 'sync',
        arguments: { adapter: 'alpha', params: {} },
      });
      const body = JSON.parse(extractText(res)) as SyncResult;
      expect(body).toEqual(expected);
    } finally {
      await h.dispose();
    }
  });

  it('returns an error when the adapter is not registered', async () => {
    const h = await buildHarness();
    try {
      const res = await h.client.callTool({
        name: 'sync',
        arguments: { adapter: 'missing', params: {} },
      });
      expect(isError(res)).toBe(true);
      const body = JSON.parse(extractText(res)) as { reason: string; message: string };
      expect(body.reason).toBe('parse_error');
      expect(body.message).toMatch(/unknown adapter/);
    } finally {
      await h.dispose();
    }
  });

  it('treats omitted params as {}', async () => {
    const h = await buildHarness();
    try {
      let received: unknown = '__unset__';
      h.registry.register(
        makeAdapter('alpha', (params) => {
          received = params;
          return Promise.resolve({
            adapter: 'alpha',
            days_pulled: 0,
            samples_added: 0,
            samples_existing: 0,
            last_synced_at: '2026-04-30T00:00:00Z',
          });
        }),
      );
      const res = await h.client.callTool({
        name: 'sync',
        arguments: { adapter: 'alpha' },
      });
      expect(isError(res)).toBe(false);
      expect(received).toEqual({});
    } finally {
      await h.dispose();
    }
  });

  it('surfaces SyncError reasons (reauth_required, transient, etc.)', async () => {
    const h = await buildHarness();
    try {
      h.registry.register(
        makeAdapter('alpha', () =>
          Promise.reject(new SyncError('reauth_required', 'token revoked')),
        ),
      );
      const res = await h.client.callTool({
        name: 'sync',
        arguments: { adapter: 'alpha', params: {} },
      });
      expect(isError(res)).toBe(true);
      const body = JSON.parse(extractText(res)) as { reason: string };
      expect(body.reason).toBe('reauth_required');
    } finally {
      await h.dispose();
    }
  });
});

describe('get_adapter_health tool', () => {
  it('returns empty arrays and null heartbeat on a fresh server', async () => {
    const h = await buildHarness();
    try {
      const res = await h.client.callTool({ name: 'get_adapter_health', arguments: {} });
      const body = JSON.parse(extractText(res)) as AdapterHealthResponse;
      expect(body.adapters).toEqual([]);
      expect(body.daemon_heartbeat_at).toBeNull();
      expect(body.recent_notifications).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it('surfaces adapter state, heartbeat timestamp, and notifications when present', async () => {
    const h = await buildHarness();
    try {
      h.registry.register(
        makeAdapter('alpha', () =>
          Promise.resolve({
            adapter: 'alpha',
            days_pulled: 0,
            samples_added: 0,
            samples_existing: 0,
            last_synced_at: '2026-05-16T00:00:00Z',
          }),
        ),
      );
      writeStateSuccess(h.db, 'alpha', '2026-05-15T23:59:59Z');
      h.registry.register(
        makeAdapter('beta', () =>
          Promise.reject(new SyncError('reauth_required', 'token revoked')),
        ),
      );
      writeStateError(h.db, 'beta', { message: 'token revoked', reason: 'reauth_required' });
      writeHeartbeat(h.heartbeatPath);

      const res = await h.client.callTool({ name: 'get_adapter_health', arguments: {} });
      const body = JSON.parse(extractText(res)) as AdapterHealthResponse;

      const alpha = body.adapters.find((a) => a.adapter_name === 'alpha');
      if (alpha?.status !== 'success') throw new Error('expected alpha to be success');
      expect(alpha.last_synced_window_end).toBe('2026-05-15T23:59:59Z');
      expect(alpha.consecutive_sync_failures).toBe(0);

      const beta = body.adapters.find((a) => a.adapter_name === 'beta');
      if (beta?.status !== 'error') throw new Error('expected beta to be error');
      expect(beta.last_error_reason).toBe('reauth_required');
      expect(beta.consecutive_sync_failures).toBe(1);

      expect(body.daemon_heartbeat_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await h.dispose();
    }
  });
});
