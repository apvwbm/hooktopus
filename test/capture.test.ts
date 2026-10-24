import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_BODY_BYTES } from '../src/limits.ts';
import { createBin, lastRequest, listen, rawRequest, testApp, type App } from './helpers.ts';

describe('capture', () => {
  let app: App;
  let base: string;
  let bin: string;

  before(async () => {
    app = await testApp();
    base = await listen(app);
    bin = await createBin(app);
  });
  after(() => app.close());

  it('keeps a body that is not valid JSON, even when it says it is', async () => {
    const res = await rawRequest(`${base}/h/${bin}`, 'POST', ['Content-Type', 'application/json'], Buffer.from('{"broken":'));
    assert.equal(res.status, 200);
    const got = await lastRequest(app, bin);
    assert.equal(got.bodyText, '{"broken":');
    assert.equal(got.contentType, 'application/json');
  });

  it('keeps binary bytes exactly, NULs included', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0xc3]);
    await rawRequest(`${base}/h/${bin}`, 'PUT', ['Content-Type', 'application/octet-stream'], bytes);
    const got = await lastRequest(app, bin);
    assert.deepEqual(Buffer.from(got.body, 'base64'), bytes);
    assert.equal(got.bodyText, null);
    assert.equal(got.bodySize, 5);
  });

  it('captures a POST with no Content-Type at all', async () => {
    const res = await rawRequest(`${base}/h/${bin}`, 'POST', ['Content-Length', '5'], Buffer.from('hello'));
    assert.equal(res.status, 200, res.body);
    const got = await lastRequest(app, bin);
    assert.equal(got.bodyText, 'hello');
    assert.equal(got.contentType, null);
  });

  it('stores an empty body as no body', async () => {
    await rawRequest(`${base}/h/${bin}`, 'POST', ['Content-Type', 'text/plain', 'Content-Length', '0']);
    const got = await lastRequest(app, bin);
    assert.equal(got.bodySize, 0);
    assert.equal(got.body, '');
  });

  it('keeps header order, case and duplicates', async () => {
    await rawRequest(`${base}/h/${bin}`, 'GET', ['X-Second', '2', 'x-dup', 'a', 'X-Dup', 'b', 'X-First', '1']);
    const got = await lastRequest(app, bin);
    const custom = got.headers.filter(([name]) => name.toLowerCase().startsWith('x-'));
    assert.deepEqual(custom, [
      ['X-Second', '2'],
      ['x-dup', 'a'],
      ['X-Dup', 'b'],
      ['X-First', '1'],
    ]);
  });

  it('keeps the subpath and the raw query', async () => {
    await rawRequest(`${base}/h/${bin}/stripe/events?x=1&x=2&y=%20`, 'POST', []);
    assert.equal((await lastRequest(app, bin)).url, '/stripe/events?x=1&x=2&y=%20');

    await rawRequest(`${base}/h/${bin}?only=query`, 'GET', []);
    assert.equal((await lastRequest(app, bin)).url, '/?only=query');
  });

  it('refuses a body over the limit with 413 and stores nothing', async () => {
    const before = (await lastRequest(app, bin)).id;
    const res = await rawRequest(`${base}/h/${bin}`, 'POST', ['Content-Type', 'text/plain'], Buffer.alloc(MAX_BODY_BYTES + 1, 'a'));
    assert.equal(res.status, 413);
    assert.equal((await lastRequest(app, bin)).id, before);
  });

  it('answers 404 for an unknown bin and 400 for a malformed id', async () => {
    assert.equal((await rawRequest(`${base}/h/AAAAAAAAAAAAAAAA`, 'POST', [])).status, 404);
    assert.equal((await rawRequest(`${base}/h/nope`, 'POST', [])).status, 400);
  });

  it('answers a preflight with permissive CORS, and records it', async () => {
    const res = await rawRequest(`${base}/h/${bin}`, 'OPTIONS', [
      'Origin', 'https://example.com',
      'Access-Control-Request-Method', 'POST',
      'Access-Control-Request-Headers', 'x-signature',
    ]);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-methods'], 'POST');
    assert.equal(res.headers['access-control-allow-headers'], 'x-signature');
    assert.equal((await lastRequest(app, bin)).method, 'OPTIONS');
  });

  it('still parses JSON on /api: the raw parser stays inside /h', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/bins/${bin}/requests/1/forward`,
      payload: { url: 'not a url' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /not a valid URL/);
  });
});

describe('capture into an expired bin', () => {
  it('answers 410', async () => {
    const app = await testApp();
    const bin = await createBin(app);
    app.db.prepare('UPDATE bins SET expires_at = 0 WHERE id = ?').run(bin);
    const res = await app.inject({ method: 'POST', url: `/h/${bin}`, payload: 'x' });
    assert.equal(res.statusCode, 410);
    await app.close();
  });
});
