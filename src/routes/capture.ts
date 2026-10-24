import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpError, pairs } from '../lib/http.ts';
import { sseFrame } from '../lib/hub.ts';
import { createLimiter } from '../lib/ratelimit.ts';
import { MAX_BODY_BYTES, MAX_REQUESTS_PER_BIN, RATE_CAPTURE } from '../limits.ts';
import { liveBin, parseBinId, summary } from './bins.ts';

/**
 * ALL /h/:id and everything below it. Registered with prefix '/h' and NOT
 * wrapped in fastify-plugin: the parser swap below must stay inside this
 * plugin, or /api would stop parsing JSON.
 */
export async function captureRoutes(app: FastifyInstance): Promise<void> {
  // Every body arrives as the exact bytes, whatever it claims to be. A JSON
  // parser would reject the broken payload you most need to see, and would
  // throw away whitespace and key order a signature was computed over.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  const limiter = createLimiter(RATE_CAPTURE.windowMs, RATE_CAPTURE.max);
  app.addHook('onClose', async () => limiter.stop());

  const insert = app.db.prepare(
    `INSERT INTO requests (bin_id, received_at, method, url, headers, content_type, body, body_size, ip)
     VALUES (@bin_id, @received_at, @method, @url, @headers, @content_type, @body, @body_size, @ip)`,
  );
  // Keeps the newest MAX_REQUESTS_PER_BIN: deletes everything at or below the
  // id that sits just past them. No-op while the bin is under the cap.
  const trim = app.db.prepare(
    `DELETE FROM requests WHERE bin_id = ? AND id <= (
       SELECT id FROM requests WHERE bin_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
  );
  const store = app.db.transaction((row: Parameters<typeof insert.run>[0] & { bin_id: string }) => {
    const id = Number(insert.run(row).lastInsertRowid);
    trim.run(row.bin_id, row.bin_id, MAX_REQUESTS_PER_BIN);
    return id;
  });

  const capture = async (request: FastifyRequest, reply: FastifyReply) => {
    // Permissive CORS, preflight included, so a webhook sent from a browser
    // is captured instead of dying in the preflight.
    reply.header('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', request.headers['access-control-request-method'] ?? '*')
        .header('access-control-allow-headers', request.headers['access-control-request-headers'] ?? '*')
        .header('access-control-max-age', '600');
    }

    const wait = limiter.hit(request.ip);
    if (wait) {
      reply.header('retry-after', wait);
      throw httpError(429, 'Too many requests from this address');
    }

    const binId = parseBinId(request.params);
    const now = Date.now();
    liveBin(app, binId, now);
    if (app.status.storageFull) throw httpError(507, 'Storage is full, try again later');

    // The URL as it arrived, path and query untouched, minus the /h/<bin> prefix.
    const rest = (request.raw.url ?? '').slice(`/h/${binId}`.length);
    const url = rest.startsWith('/') ? rest : `/${rest}`;

    const body = Buffer.isBuffer(request.body) && request.body.length > 0 ? request.body : null;
    const row = {
      bin_id: binId,
      received_at: now,
      method: request.method,
      url,
      // rawHeaders, not request.headers: the parsed object lowercases names,
      // merges duplicates and forgets the order they came in.
      headers: JSON.stringify(pairs(request.raw.rawHeaders)),
      content_type: request.headers['content-type'] ?? null,
      body,
      body_size: body?.length ?? 0,
      ip: request.ip,
    };

    const id = store(row);
    app.hub.publish(binId, sseFrame({ id, event: 'request', data: summary({ ...row, id }) }));

    return { ok: true };
  };

  app.all('/:id', capture);
  app.all('/:id/*', capture);
}
