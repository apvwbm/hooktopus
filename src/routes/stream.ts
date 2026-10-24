import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../lib/http.ts';
import { sseFrame } from '../lib/hub.ts';
import { SSE_MAX_SUBSCRIBERS_PER_BIN, SSE_REPLAY_MAX } from '../limits.ts';
import { liveBin, parseBinId, summary, SUMMARY_COLUMNS, type RequestRow } from './bins.ts';

const cursor = z.coerce.number().int().nonnegative();

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  const missed = app.db.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM requests WHERE bin_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
  );

  app.get('/api/bins/:id/stream', async (request, reply) => {
    const id = parseBinId(request.params);
    liveBin(app, id);
    if (app.hub.count(id) >= SSE_MAX_SUBSCRIBERS_PER_BIN) {
      throw httpError(429, 'Too many open streams on this bin');
    }

    // Last-Event-ID is what a browser's EventSource sends on reconnect; ?since=
    // is for the first connection, which has no way to set that header.
    const raw = request.headers['last-event-id'] ?? (request.query as { since?: string }).since;
    const parsed = raw === undefined ? undefined : cursor.safeParse(raw);
    if (parsed && !parsed.success) throw httpError(400, 'since: must be a request id');
    const since = parsed?.data;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // nginx buffers proxied responses by default, which would hold events back.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // From the query below to subscribe() nothing awaits, so this all runs in
    // one tick. Captures insert and publish in one tick too (better-sqlite3 is
    // synchronous), so no request can land between "what did they miss" and
    // "send them what's new": it is either in the replay or in the live feed,
    // never in neither.
    if (since !== undefined) {
      for (const row of missed.all(id, since, SSE_REPLAY_MAX) as RequestRow[]) {
        res.write(sseFrame({ id: row.id, event: 'request', data: summary(row) }));
      }
    }
    const unsubscribe = app.hub.subscribe(id, {
      write: (chunk) => res.write(chunk),
      end: () => res.end(),
    });
    request.raw.on('close', unsubscribe);
  });
}
