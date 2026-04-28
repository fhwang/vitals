import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryBlobStore } from '../storage/index.js';
import { RootsState } from './roots.js';
import { parseAllowedDirs, registerIngestRecordTool } from './server.js';

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20201015143211-0500"/>
</ClinicalDocument>`;

interface ToolTextResponse {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

interface Harness {
  client: Client;
  store: MemoryBlobStore;
  dispose: () => Promise<void>;
}

async function buildHarness(rootsToAdvertise: readonly string[]): Promise<Harness> {
  const store = new MemoryBlobStore();
  const mcp = new McpServer({ name: 'vitals', version: 'test' });
  const roots = new RootsState();
  await roots.setRoots(rootsToAdvertise);

  registerIngestRecordTool(mcp, store, roots);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-client', version: 'test' },
    { capabilities: { roots: { listChanged: true } } },
  );

  await Promise.all([mcp.connect(serverT), client.connect(clientT)]);

  return {
    client,
    store,
    dispose: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

function extractText(res: unknown): string {
  const typed = res as ToolTextResponse;
  const first = typed.content[0];
  if (first === undefined) throw new Error('tool response has no content');
  return first.text;
}

function isError(res: unknown): boolean {
  return (res as ToolTextResponse).isError === true;
}

describe('parseAllowedDirs', () => {
  it('returns empty when no flag is given', () => {
    expect(parseAllowedDirs([])).toEqual([]);
    expect(parseAllowedDirs(['unrelated', 'args'])).toEqual([]);
  });

  it('parses a single --allowed-dir', () => {
    expect(parseAllowedDirs(['--allowed-dir', '/foo'])).toEqual(['/foo']);
  });

  it('parses multiple --allowed-dir occurrences', () => {
    expect(parseAllowedDirs(['--allowed-dir', '/foo', '--allowed-dir', '/bar'])).toEqual([
      '/foo',
      '/bar',
    ]);
  });

  it('throws when --allowed-dir has no value', () => {
    expect(() => parseAllowedDirs(['--allowed-dir'])).toThrow(/requires a path argument/);
  });

  it('throws when --allowed-dir is followed by another flag', () => {
    expect(() => parseAllowedDirs(['--allowed-dir', '--other'])).toThrow(
      /requires a path argument/,
    );
  });
});

describe('MCP ingest_record', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-mcp-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a record and returns a content-hashed key', async () => {
    const root = join(tmpDir, 'allowed');
    await mkdir(root);
    const filePath = join(root, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');

    const { client, store, dispose } = await buildHarness([`file://${root}`]);
    try {
      const res = await client.callTool({
        name: 'ingest_record',
        arguments: { path: filePath, kind: 'ccda', source: 'portal-export' },
      });
      const result = JSON.parse(extractText(res)) as { key: string; kind: string };
      expect(result.key).toMatch(/^ccda\/[0-9a-f]{64}\.xml$/);
      expect(result.kind).toBe('ccda');
      expect(await store.head(result.key)).not.toBeNull();
    } finally {
      await dispose();
    }
  });

  it('returns path_outside_roots when path is not inside an advertised root', async () => {
    const filePath = join(tmpDir, 'leak.xml');
    await writeFile(filePath, fixture, 'utf8');

    const otherRoot = join(tmpDir, 'allowed');
    await mkdir(otherRoot);

    const { client, dispose } = await buildHarness([`file://${otherRoot}`]);
    try {
      const res = await client.callTool({
        name: 'ingest_record',
        arguments: { path: filePath, kind: 'ccda', source: 'x' },
      });
      expect(isError(res)).toBe(true);
      expect(JSON.parse(extractText(res))).toMatchObject({ code: 'path_outside_roots' });
    } finally {
      await dispose();
    }
  });

  it('returns parse_failed when the bytes are not a valid CCDA', async () => {
    const root = join(tmpDir, 'allowed');
    await mkdir(root);
    const filePath = join(root, 'bogus.xml');
    await writeFile(filePath, '<NotCCDA/>', 'utf8');

    const { client, dispose } = await buildHarness([`file://${root}`]);
    try {
      const res = await client.callTool({
        name: 'ingest_record',
        arguments: { path: filePath, kind: 'ccda', source: 'x' },
      });
      expect(isError(res)).toBe(true);
      expect(JSON.parse(extractText(res))).toMatchObject({ code: 'parse_failed' });
    } finally {
      await dispose();
    }
  });
});
