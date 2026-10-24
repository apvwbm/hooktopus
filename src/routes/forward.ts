import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertTarget, guardedLookup } from '../lib/guard.ts';
import { httpError, parseOr400, type HeaderPairs } from '../lib/http.ts';
import { createLimiter } from '../lib/ratelimit.ts';
import { sendStored } from '../lib/replay.ts';
import { RATE_FORWARD } from '../limits.ts';
import { storedRequest } from './bins.ts';

const forwardBody = z.object({ url: z.string().min(1).max(2048) });

export async function forwardRoutes(app: FastifyInstance): Promise<void> {
  const limiter = createLimiter(RATE_FORWARD.windowMs, RATE_FORWARD.max);

  // Only buildApp's caller can turn this on, and only tests do: there is
  // deliberately no environment variable that switches the SSRF guard off.
  const allowPrivate = app.deps.allowPrivateTargets === true;

  app.post('/api/bins/:id/requests/:rid/forward', async (request, reply) => {
    if (!app.config.HOOKTOPUS_FORWARD_ENABLED) throw httpError(404, 'Forwarding is disabled here');

    const wait = limiter.hit(request.ip);
    if (wait) {
      reply.header('retry-after', wait);
      throw httpError(429, 'Too many forwards from this address, try again later');
    }

    const row = storedRequest(app, request.params);
    const target = assertTarget(parseOr400(forwardBody, request.body).url, allowPrivate);

    // 200 whatever the target did: the forward itself worked, and its outcome
    // (a 500 from the target, a refused connection) is the payload.
    return sendStored(
      { method: row.method, headers: JSON.parse(row.headers) as HeaderPairs, body: row.body },
      target,
      { lookup: allowPrivate ? undefined : guardedLookup },
    );
  });
}
