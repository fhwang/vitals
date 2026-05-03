import pino from 'pino';

import { AdapterRegistry } from './adapters/index.js';
import { buildFitbitAdapter } from './adapters/fitbit/index.js';
import { loadGoogleHealthAuthConfig } from './adapters/googlehealth/auth-config.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createBlobStore } from './storage/index.js';

export function buildCore(logToStderr = false) {
  const config = loadConfig();
  const destination = logToStderr ? pino.destination(2) : undefined;
  const logger = destination
    ? pino({ level: config.LOG_LEVEL }, destination)
    : pino({ level: config.LOG_LEVEL });
  const store = createBlobStore(config.storage);
  const db = openDatabase(config.dbPath);
  const adapters = new AdapterRegistry();
  const auth = loadGoogleHealthAuthConfig(config.storage);
  if (auth !== null) adapters.register(buildFitbitAdapter(auth));
  return { config, logger, store, db, adapters };
}
