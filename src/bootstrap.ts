import pino from 'pino';

import { loadConfig } from './config.js';
import { createBlobStore } from './storage/index.js';

export function buildCore(logToStderr = false) {
  const config = loadConfig();
  const destination = logToStderr ? pino.destination(2) : undefined;
  const logger = destination
    ? pino({ level: config.LOG_LEVEL }, destination)
    : pino({ level: config.LOG_LEVEL });
  const store = createBlobStore(config.storage);
  return { config, logger, store };
}
