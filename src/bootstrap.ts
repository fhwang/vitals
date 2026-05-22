import pino from 'pino';

import {
  buildFitbitAdapter,
  buildOuraAdapter,
  createAdapterRegistry,
  createCodingRegistry,
  fitbitCodingRegistration,
  loadGoogleHealthAuthConfig,
  ouraCodingRegistration,
  readOuraCredentials,
} from '#adapters';
import { openDatabase } from '#db';
import { createBlobStore } from '#storage';
import { loadConfig } from './config.js';

export function buildCore(logToStderr = false) {
  const config = loadConfig();
  const logger = buildLogger(config.LOG_LEVEL, logToStderr);
  const store = createBlobStore(config.storage);
  const db = openDatabase(config.dbPath);
  const [adapters, codings] = buildRegistries(db, config.storage);
  return { config, logger, store, db, adapters, codings };
}

function buildLogger(level: string, toStderr: boolean): pino.Logger {
  const destination = toStderr ? pino.destination(2) : undefined;
  return destination ? pino({ level }, destination) : pino({ level });
}

function buildRegistries(
  db: ReturnType<typeof openDatabase>,
  storage: Parameters<typeof loadGoogleHealthAuthConfig>[0],
): readonly [ReturnType<typeof createAdapterRegistry>, ReturnType<typeof createCodingRegistry>] {
  const adapters = createAdapterRegistry();
  const codings = createCodingRegistry();
  const auth = loadGoogleHealthAuthConfig(storage);
  if (auth !== null) {
    adapters.register(buildFitbitAdapter(auth));
    codings.register(fitbitCodingRegistration(db));
  }
  if (readOuraCredentials(db) !== null) {
    adapters.register(buildOuraAdapter());
    codings.register(ouraCodingRegistration(db));
  }
  return [adapters, codings];
}
