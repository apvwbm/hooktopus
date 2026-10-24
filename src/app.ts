import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyError, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { sweep } from './lib/cleanup.ts';
import { createHub, type Hub } from './lib/hub.ts';
import { JANITOR_INTERVAL_MS, SSE_HEARTBEAT_MS } from './limits.ts';
import { binsRoutes, parseBinId } from './routes/bins.ts';
import { captureRoutes } from './routes/capture.ts';
import { forwardRoutes } from './routes/forward.ts';
import { healthRoutes } from './routes/health.ts';
import { streamRoutes } from './routes/stream.ts';

export interface Deps {
  /** Lets forwards reach private addresses. Tests only: never set from config. */
  allowPrivateTargets?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: Hub;
    status: { storageFull: boolean };
    deps: Deps;
  }
}

// Resolved against the module, so it is the same from src/ and from dist/.
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

/** The whole app, not listening yet: main() listens, tests inject. */
export async function buildApp(
  config: Config,
  db: Db,
  deps: Deps = {},
  logger: FastifyServerOptions['logger'] = true,
) {
  // The default 1 MiB body limit only matters for /api, whose bodies are tiny;
  // captures set their own limit inside their plugin.
  const app = Fastify({ logger, trustProxy: config.HOOKTOPUS_TRUST_PROXY, bodyLimit: 16 * 1024 });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('hub', createHub());
  app.decorate('status', { storageFull: false });
  app.decorate('deps', deps);

  // Every error leaves as { "error": "message" }.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500 && status !== 503 && status !== 507) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Internal error' });
    }
    return reply.code(status).send({ error: error.message });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `No route for ${request.method} ${request.url}` });
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
  });

  await app.register(healthRoutes);
  await app.register(binsRoutes);
  await app.register(streamRoutes);
  await app.register(forwardRoutes);
  await app.register(captureRoutes, { prefix: '/h' });

  // wildcard: false registers one route per file instead of a catch-all, so an
  // unknown path still gets the JSON 404 rather than a file lookup.
  await app.register(fastifyStatic, { root: PUBLIC_DIR, wildcard: false });
  app.get('/b/:id', async (request, reply) => {
    parseBinId(request.params);
    return reply.sendFile('bin.html');
  });

  // Keeps idle streams alive through proxies that drop silent connections.
  const heartbeat = setInterval(() => app.hub.broadcast(': ping\n\n'), SSE_HEARTBEAT_MS);
  heartbeat.unref();

  sweep(app);
  const janitor = setInterval(() => {
    const { expired } = sweep(app);
    if (expired > 0) app.log.info({ expired }, 'expired bins deleted');
  }, JANITOR_INTERVAL_MS);
  janitor.unref();

  // Open streams never go idle, so close() would wait on them forever.
  app.addHook('preClose', async () => app.hub.closeAll());
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    clearInterval(janitor);
  });

  return app;
}
