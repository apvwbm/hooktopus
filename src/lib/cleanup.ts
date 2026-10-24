import type { FastifyInstance } from 'fastify';
import { sseFrame } from './hub.ts';

/**
 * Deletes expired bins (their requests go with them, ON DELETE CASCADE) after
 * telling whoever is watching, and recomputes whether storage is full.
 */
export function sweep(app: FastifyInstance, now = Date.now()): { expired: number; bytes: number } {
  const { db, hub } = app;

  const expired = db.prepare('SELECT id FROM bins WHERE expires_at <= ?').pluck().all(now) as string[];
  const goodbye = sseFrame({ event: 'expired', data: {} });
  for (const id of expired) hub.closeBin(id, goodbye);
  db.prepare('DELETE FROM bins WHERE expires_at <= ?').run(now);

  // ponytail: recomputed once per sweep, so captures can overshoot the cap by
  // up to a minute's worth. An incremental counter if that ever matters.
  const bytes = db
    .prepare('SELECT COALESCE(SUM(body_size + length(headers)), 0) FROM requests')
    .pluck()
    .get() as number;
  app.status.storageFull = bytes > app.config.HOOKTOPUS_MAX_STORAGE_MB * 1024 * 1024;

  return { expired: expired.length, bytes };
}
