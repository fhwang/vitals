import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SYSTEM_LOINC, ingestRecord } from '../records/index.js';
import { ArchiveCache } from '../query/index.js';
import { MemoryBlobStore } from '../storage/index.js';
import { RootsState } from './roots.js';
import {
  parseAllowedDirs,
  registerGetCurrentMedicationsTool,
  registerGetCurrentProblemsTool,
  registerGetObservationHistoryTool,
  registerIngestRecordTool,
  registerListDocumentsTool,
  registerListMetricsTool,
} from './server.js';

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

interface QueryHarness {
  client: Client;
  store: MemoryBlobStore;
  dispose: () => Promise<void>;
}

async function buildQueryHarness(): Promise<QueryHarness> {
  const store = new MemoryBlobStore();
  const archive = new ArchiveCache(store);
  const mcp = new McpServer({ name: 'vitals', version: 'test' });

  registerListDocumentsTool(mcp, archive);
  registerListMetricsTool(mcp, archive);
  registerGetObservationHistoryTool(mcp, archive);
  registerGetCurrentProblemsTool(mcp, archive);
  registerGetCurrentMedicationsTool(mcp, archive);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: 'test' }, { capabilities: {} });

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

async function ingestFixture(store: MemoryBlobStore, name: string): Promise<void> {
  const path = fileURLToPath(new URL(`../records/__fixtures__/${name}`, import.meta.url));
  await ingestRecord(store, (p) => Promise.resolve(p), {
    path,
    kind: 'ccda',
    source: 'test',
  });
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

describe('list_documents tool', () => {
  it('returns ingested CCDAs with metadata', async () => {
    const h = await buildQueryHarness();
    try {
      await ingestFixture(h.store, 'ccda-rich-ccd.xml');
      const res = await h.client.callTool({ name: 'list_documents', arguments: {} });
      const body = JSON.parse(extractText(res)) as {
        document_type: string;
        observation_count: number;
      }[];
      expect(body).toHaveLength(1);
      expect(body[0]?.document_type).toBe('ccd');
      expect(body[0]?.observation_count).toBeGreaterThan(0);
    } finally {
      await h.dispose();
    }
  });
});

describe('list_metrics tool', () => {
  it('returns aggregated LOINC catalog', async () => {
    const h = await buildQueryHarness();
    try {
      await ingestFixture(h.store, 'ccda-rich-ccd.xml');
      const res = await h.client.callTool({ name: 'list_metrics', arguments: {} });
      const body = JSON.parse(extractText(res)) as {
        coding: { system: string; code: string; display?: string };
      }[];
      const ldl = body.find((m) => m.coding.code === '13457-7');
      expect(ldl).toBeDefined();
      expect(ldl?.coding.system).toBe(SYSTEM_LOINC);
      expect(ldl?.coding.display).toBe('LDL-CHOLESTEROL');
    } finally {
      await h.dispose();
    }
  });
});

describe('get_observation_history tool', () => {
  it('returns LDL-C history for a single LOINC', async () => {
    const h = await buildQueryHarness();
    try {
      await ingestFixture(h.store, 'ccda-rich-ccd.xml');
      const res = await h.client.callTool({
        name: 'get_observation_history',
        arguments: {
          codings: [{ system: SYSTEM_LOINC, code: '13457-7' }],
        },
      });
      const body = JSON.parse(extractText(res)) as {
        coding: { code: string };
        value: number;
      }[];
      expect(body).toHaveLength(1);
      expect(body[0]?.coding.code).toBe('13457-7');
      expect(body[0]?.value).toBe(118);
    } finally {
      await h.dispose();
    }
  });
});

describe('get_current_problems tool', () => {
  it('returns problems from the most recent CCD', async () => {
    const h = await buildQueryHarness();
    try {
      await ingestFixture(h.store, 'ccda-rich-ccd.xml');
      const res = await h.client.callTool({ name: 'get_current_problems', arguments: {} });
      const body = JSON.parse(extractText(res)) as {
        problems: { coding: { code: string } }[];
      };
      expect(body.problems).toHaveLength(1);
      expect(body.problems[0]?.coding.code).toBe('E78.5');
    } finally {
      await h.dispose();
    }
  });
});

describe('get_current_medications tool', () => {
  it('returns medications from the most recent CCD', async () => {
    const h = await buildQueryHarness();
    try {
      await ingestFixture(h.store, 'ccda-rich-ccd.xml');
      const res = await h.client.callTool({ name: 'get_current_medications', arguments: {} });
      const body = JSON.parse(extractText(res)) as {
        medications: { coding: { code: string } }[];
      };
      expect(body.medications).toHaveLength(1);
      expect(body.medications[0]?.coding.code).toBe('617314');
    } finally {
      await h.dispose();
    }
  });
});
