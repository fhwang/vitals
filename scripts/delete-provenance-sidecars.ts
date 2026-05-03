import type { BlobStore } from '../src/storage/index.js';
import { LocalFsBlobStore } from '../src/storage/local-fs.js';

interface CleanupArgs {
  archiveRoot: string;
  dryRun: boolean;
}

function takeNext(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function flagPairs(argv: readonly string[]): { flag: string; value: string | undefined }[] {
  const out: { flag: string; value: string | undefined }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    if (flag === '--dry-run') {
      out.push({ flag, value: undefined });
    } else if (flag === '--archive-root') {
      out.push({ flag, value: takeNext(argv, i, flag) });
      i++;
    } else {
      throw new Error(`unknown arg: ${flag}`);
    }
  }
  return out;
}

function parseArgs(argv: readonly string[]): CleanupArgs {
  const pairs = flagPairs(argv);
  const archiveRoot = pairs.find((p) => p.flag === '--archive-root')?.value;
  const dryRun = pairs.some((p) => p.flag === '--dry-run');
  if (archiveRoot === undefined) throw new Error('--archive-root is required');
  return { archiveRoot, dryRun };
}

async function* iterateSidecars(store: BlobStore): AsyncIterable<string> {
  for await (const entry of store.list('')) {
    if (entry.key.endsWith('.provenance.json')) yield entry.key;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new LocalFsBlobStore(args.archiveRoot);
  let count = 0;
  for await (const key of iterateSidecars(store)) {
    if (args.dryRun) {
      process.stdout.write(`[dry-run] would delete ${key}\n`);
    } else {
      await store.delete(key);
      process.stdout.write(`deleted ${key}\n`);
    }
    count += 1;
  }
  process.stdout.write(`${JSON.stringify({ count, dry_run: args.dryRun }, null, 2)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
