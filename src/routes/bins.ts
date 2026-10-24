import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BIN_ID_RE, newBinId } from '../lib/ids.ts';
import { asText, httpError, parseOr400, type HeaderPairs } from '../lib/http.ts';
import { createLimiter } from '../lib/ratelimit.ts';
import { LIST_PAGE, MAX_ACTIVE_BINS, RATE_CREATE_BIN } from '../limits.ts';

export interface RequestRow {
  id: number;
  bin_id: string;
  received_at: number;
  method: string;
  url: string;
  headers: string;
  content_type: string | null;
  body: Buffer | null;
  body_size: number;
  ip: string;
}

export const SUMMARY_COLUMNS = 'id, received_at, method, url, content_type, body_size, ip';

/** What the list, the stream and the CLI see: everything but headers and body. */
export const summary = (row: Omit<RequestRow, 'bin_id' | 'headers' | 'body'>) => ({
  id: row.id,
  receivedAt: new Date(row.received_at).toISOString(),
  method: row.method,
  url: row.url,
  contentType: row.content_type,
  bodySize: row.body_size,
  ip: row.ip,
});

const binParams = z.object({ id: z.string().regex(BIN_ID_RE, 'not a bin id') });
const requestParams = binParams.extend({ rid: z.coerce.number().int().positive() });

export const parseBinId = (params: unknown): string => parseOr400(binParams, params).id;

/**
 * The bin, if it exists and has not expired. An expired bin the janitor has not
 * swept yet answers 410 like a swept one would after it, never as if alive.
 */
export function liveBin(app: FastifyInstance, id: string, now = Date.now()) {
  const bin = app.db
    .prepare('SELECT id, expires_at FROM bins WHERE id = ?')
    .get(id) as { id: string; expires_at: number } | undefined;
  if (!bin) throw httpError(404, 'No such bin');
  if (bin.expires_at <= now) throw httpError(410, 'This bin has expired');
  return bin;
}

export function storedRequest(app: FastifyInstance, params: unknown): RequestRow {
  const { id, rid } = parseOr400(requestParams, params);
  liveBin(app, id);
  const row = app.db.prepare('SELECT * FROM requests WHERE bin_id = ? AND id = ?').get(id, rid) as
    | RequestRow
    | undefined;
  if (!row) throw httpError(404, 'No such request in this bin');
  return row;
}

export async function binsRoutes(app: FastifyInstance): Promise<void> {
  const limiter = createLimiter(RATE_CREATE_BIN.windowMs, RATE_CREATE_BIN.max);

  const publicUrl = app.config.HOOKTOPUS_PUBLIC_URL;
  const ttlMs = app.config.HOOKTOPUS_BIN_TTL_HOURS * 3_600_000;

  app.post('/api/bins', async (request, reply) => {
    const wait = limiter.hit(request.ip);
    if (wait) {
      reply.header('retry-after', wait);
      throw httpError(429, 'Too many bins created from this address, try again later');
    }

    const now = Date.now();
    const active = app.db.prepare('SELECT COUNT(*) FROM bins WHERE expires_at > ?').pluck().get(now) as number;
    if (active >= MAX_ACTIVE_BINS) {
      throw httpError(503, 'Too many active bins right now, try again later');
    }

    const id = newBinId();
    const expiresAt = now + ttlMs;
    app.db.prepare('INSERT INTO bins (id, created_at, expires_at) VALUES (?, ?, ?)').run(id, now, expiresAt);

    return reply.code(201).send({
      id,
      captureUrl: `${publicUrl}/h/${id}`,
      viewUrl: `${publicUrl}/b/${id}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  app.get('/api/bins/:id', async (request) => {
    const bin = liveBin(app, parseBinId(request.params));
    return {
      id: bin.id,
      captureUrl: `${publicUrl}/h/${bin.id}`,
      expiresAt: new Date(bin.expires_at).toISOString(),
    };
  });

  const listQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(LIST_PAGE).default(LIST_PAGE),
  });

  app.get('/api/bins/:id/requests', async (request) => {
    const id = parseBinId(request.params);
    liveBin(app, id);
    const { before, limit } = parseOr400(listQuery, request.query);
    const rows = app.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM requests
         WHERE bin_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(id, before ?? Number.MAX_SAFE_INTEGER, limit) as RequestRow[];
    return { requests: rows.map(summary) };
  });

  app.get('/api/bins/:id/requests/:rid', async (request) => {
    const row = storedRequest(app, request.params);
    const body = row.body ?? Buffer.alloc(0);
    return {
      ...summary(row),
      headers: JSON.parse(row.headers) as HeaderPairs,
      body: body.toString('base64'),
      bodyText: asText(body),
    };
  });

  // A download, never a page: served inline with the sender's content type,
  // anyone could post HTML to a bin and link people to a phishing page on
  // this domain.
  app.get('/api/bins/:id/requests/:rid/raw', async (request, reply) => {
    const row = storedRequest(app, request.params);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="request-${row.id}.bin"`)
      .send(row.body ?? Buffer.alloc(0));
  });
}
