import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.onError((_err, c) =>
    c.json({ error: { code: 'internal', message: 'Internal Server Error' } }, 500),
  );

  return app;
}
