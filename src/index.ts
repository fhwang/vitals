import { serve } from '@hono/node-server';
import pino from 'pino';

import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createBlobStore } from './storage/index.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const storage = createBlobStore(config.storage);
logger.info({ driver: config.storage.driver }, 'storage backend initialized');

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info(
    { port: info.port, storageDriver: config.storage.driver },
    'vitals service listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

void storage;
