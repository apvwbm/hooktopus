import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sweep } from '../src/lib/cleanup.ts';
import { MAX_ACTIVE_BINS, MAX_REQUESTS_PER_BIN } from '../src/limits.ts';
import { createBin, testApp } from './helpers.ts';

const count = (app: Awaited<ReturnType<typeof testApp>>, sql: string, ...args: unknown[]) =>
  app.db.prepare(sql).pluck().get(...args) as number;

describe('retention', () => {
  it(`keeps only the newest ${MAX_REQUESTS_PER_BIN} requests per bin`, async () => {
    const app = await testApp();
    const bin = await createBin(app);
    // Direct inserts for the bulk (the capture rate limit would stop us), then
    // one real capture, which is what trims.
    const insert = app.db.prepare(
      `INSERT INTO requests (bin_id, received_at, method, url, headers, body_size, ip)
       VALUES (?, 0, 'POST', '/', '[]', 0, '127.0.0.1')`,
    );
    for (let i = 0; i < MAX_REQUESTS_PER_BIN + 10; i++) insert.run(bin);
    const res = await app.inject({ method: 'POST', url: `/h/${bin}`, payload: 'newest' });
    assert.equal(res.statusCode, 200);

    assert.equal(count(app, 'SELECT COUNT(*) FROM requests WHERE bin_id = ?', bin), MAX_REQUESTS_PER_BIN);
    const newest = count(app, 'SELECT MAX(id) FROM requests WHERE bin_id = ?', bin);
    const oldest = count(app, 'SELECT MIN(id) FROM requests WHERE bin_id = ?', bin);
    assert.equal(newest - oldest + 1, MAX_REQUESTS_PER_BIN, 'the survivors are the newest, contiguous');
    await app.close();
  });

  it('sweeps expired bins and their requests, and leaves live ones alone', async () => {
    const app = await testApp({ HOOKTOPUS_BIN_TTL_HOURS: '1' });
    const doomed = await createBin(app);
    const alive = await createBin(app);
    await app.inject({ method: 'POST', url: `/h/${doomed}`, payload: 'x' });
    await app.inject({ method: 'POST', url: `/h/${alive}`, payload: 'x' });
    app.db.prepare('UPDATE bins SET expires_at = 1 WHERE id = ?').run(doomed);

    assert.equal((await app.inject(`/api/bins/${doomed}`)).statusCode, 410, 'expired before the sweep');
    assert.equal(sweep(app).expired, 1);
    assert.equal((await app.inject(`/api/bins/${doomed}`)).statusCode, 404, 'gone after it');
    assert.equal(count(app, 'SELECT COUNT(*) FROM requests WHERE bin_id = ?', doomed), 0);
    assert.equal(count(app, 'SELECT COUNT(*) FROM requests WHERE bin_id = ?', alive), 1);
    await app.close();
  });

  it('refuses captures with 507 once storage is over the cap', async () => {
    const app = await testApp({ HOOKTOPUS_MAX_STORAGE_MB: '0.0001' }); // ~100 bytes
    const bin = await createBin(app);
    await app.inject({ method: 'POST', url: `/h/${bin}`, payload: 'x'.repeat(500) });
    assert.ok(sweep(app).bytes > 100);
    const res = await app.inject({ method: 'POST', url: `/h/${bin}`, payload: 'more' });
    assert.equal(res.statusCode, 507);
    await app.close();
  });

  it('refuses new bins with 503 at the active bin cap', async () => {
    const app = await testApp();
    const insert = app.db.prepare('INSERT INTO bins (id, created_at, expires_at) VALUES (?, 0, ?)');
    const far = Date.now() + 3_600_000;
    app.db.transaction(() => {
      for (let i = 0; i < MAX_ACTIVE_BINS; i++) insert.run(`bin${String(i).padStart(13, '0')}`, far);
    })();
    const res = await app.inject({ method: 'POST', url: '/api/bins' });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});
