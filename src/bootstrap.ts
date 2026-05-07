import pino from 'pino';

import { buildFitbitAdapter, createAdapterRegistry, loadGoogleHealthAuthConfig } from '#adapters';
import { openDatabase } from '#db';
import { createBlobStore } from '#storage';
import { loadConfig } from './config.js';

export function buildCore(logToStderr = false) {
  const config = loadConfig();
  const destination = logToStderr ? pino.destination(2) : undefined;
  const logger = destination
    ? pino({ level: config.LOG_LEVEL }, destination)
    : pino({ level: config.LOG_LEVEL });
  const store = createBlobStore(config.storage);
  const db = openDatabase(config.dbPath);
  const adapters = createAdapterRegistry();
  const auth = loadGoogleHealthAuthConfig(config.storage);
  if (auth !== null) adapters.register(buildFitbitAdapter(auth));
  return { config, logger, store, db, adapters };
}
