export {
  FileNotFoundError,
  PathOutsideRootsError,
  RecordParseError,
  UnsupportedKindError,
} from './errors.js';
export { ingestRecord } from './ingest.js';
export type { IngestInput } from './ingest.js';
export { KindSchema, kindRegistry } from './kind-registry.js';
export type { Kind, KindHandler } from './kind-registry.js';
