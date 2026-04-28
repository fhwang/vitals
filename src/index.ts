import { serve } from '@hono/node-server';

import { buildCore } from './bootstrap.js';
import { createApp } from './http/app.js';

const { config, logger, store } = buildCore();
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

void store;
