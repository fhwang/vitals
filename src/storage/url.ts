import * as path from 'node:path';

export type StorageConfig =
  | { driver: 'local'; root: string }
  | { driver: 's3'; bucket: string; region: string; endpoint?: string };

export function parseStorageUrl(input: string): StorageConfig {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`VITALS_STORAGE_URL is not a valid URL: ${input}`);
  }

  if (url.protocol === 'file:') {
    return parseFileUrl(url, input);
  }
  if (url.protocol === 's3:') {
    return parseS3Url(url, input);
  }
  throw new Error(`VITALS_STORAGE_URL must use file:// or s3://, got: ${url.protocol} (${input})`);
}

function parseFileUrl(url: URL, input: string): StorageConfig {
  const root = url.pathname;
  if (!path.isAbsolute(root)) {
    throw new Error(`VITALS_STORAGE_URL file:// path must be absolute: ${input}`);
  }
  return { driver: 'local', root };
}

function parseS3Url(url: URL, input: string): StorageConfig {
  const bucket = url.hostname;
  if (bucket === '') {
    throw new Error(`VITALS_STORAGE_URL s3:// requires a bucket: ${input}`);
  }
  const region = url.searchParams.get('region');
  if (region === null || region === '') {
    throw new Error(`VITALS_STORAGE_URL s3:// requires ?region=...: ${input}`);
  }
  const endpoint = readOptionalParam(url, 'endpoint');
  if (endpoint === undefined) {
    return { driver: 's3', bucket, region };
  }
  return { driver: 's3', bucket, region, endpoint };
}

function readOptionalParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value !== null && value !== '' ? value : undefined;
}
