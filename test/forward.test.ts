import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { sendStored } from '../src/lib/replay.ts';
import { createBin, lastRequest, listen, rawRequest, testApp, type App } from './helpers.ts';

interface Seen {
  method: string;
  url: string;
  rawHeaders: string[];
  body: Buffer;
}

/** A local target that records what it got and answers per path. */
async function target(): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
      if (req.url === '/redirect') return void res.writeHead(302, { location: 'http://10.0.0.1/' }).end();
      if (req.url === '/big') return void res.end('x'.repeat(100_000));
      if (req.url === '/slow') return; // never answers
      res.writeHead(201, { 'x-reply': 'yes' }).end('created');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe('forward', () => {
  let app: App;
  let base: string;
  let bin: string;
  let dest: Awaited<ReturnType<typeof target>>;

  before(async () => {
    app = await testApp({}, { allowPrivateTargets: true });
    base = await listen(app);
    bin = await createBin(app);
    dest = await target();
  });
  after(async () => {
    await dest.close();
    await app.close();
  });

  const forward = async (url: string) => {
    const { id } = await lastRequest(app, bin);
    const res = await app.inject({ method: 'POST', url: `/api/bins/${bin}/requests/${id}/forward`, payload: { url } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  it('replays method, body bytes and headers, minus hop-by-hop ones', async () => {
    const body = Buffer.from([0x7b, 0x00, 0xff, 0x7d]);
    await rawRequest(`${base}/h/${bin}/ignored-path`, 'PATCH', [
      'X-Sig', 'abc',
      'Connection', 'keep-alive',
      'Keep-Alive', 'timeout=5',
      'X-Dup', '1',
      'X-Dup', '2',
    ], body);

    const result = await forward(`${dest.url}/hook?q=1`);
    assert.equal(result.outcome, 'response');
    assert.equal(result.status, 201);
    assert.equal(result.bodyText, 'created');
    assert.ok(result.headers.some(([k, v]: [string, string]) => k.toLowerCase() === 'x-reply' && v === 'yes'));

    const got = dest.seen.at(-1)!;
    assert.equal(got.method, 'PATCH');
    assert.equal(got.url, '/hook?q=1', 'the target URL is used as given');
    assert.deepEqual(got.body, body);
    const names = got.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
    assert.ok(!names.includes('keep-alive'), 'hop-by-hop header dropped');
    const dups = got.rawHeaders.flatMap((v, i, a) => (i % 2 === 0 && v === 'X-Dup' ? [a[i + 1]] : []));
    assert.deepEqual(dups, ['1', '2'], 'duplicates survive, in order');
    const host = got.rawHeaders[got.rawHeaders.findIndex((n) => n.toLowerCase() === 'host') + 1];
    assert.equal(host, new URL(dest.url).host, 'Host is the target, not the bin');
  });

  it('reports a redirect instead of following it', async () => {
    const result = await forward(`${dest.url}/redirect`);
    assert.equal(result.status, 302);
    assert.equal(dest.seen.at(-1)!.url, '/redirect');
  });

  it('truncates a big response', async () => {
    const result = await forward(`${dest.url}/big`);
    assert.equal(result.truncated, true);
    assert.equal(result.bodyText.length, 64 * 1024);
  });

  it('reports a refused connection as an outcome, not a failure', async () => {
    const result = await forward('http://127.0.0.1:1/');
    assert.equal(result.outcome, 'error');
    assert.equal(result.code, 'ECONNREFUSED');
  });

  it('gives up on a target that never answers', async () => {
    const result = await sendStored(
      { method: 'GET', headers: [], body: null },
      new URL(`${dest.url}/slow`),
      { timeoutMs: 200 },
    );
    assert.equal(result.outcome, 'error');
    assert.equal(result.code, 'ETIMEDOUT');
  });
});

describe('forward with the guard on', () => {
  it('refuses private targets, literal or by name', async () => {
    const app = await testApp();
    const bin = await createBin(app);
    await app.inject({ method: 'POST', url: `/h/${bin}`, payload: 'x' });
    const { id } = await lastRequest(app, bin);
    const forward = (url: string) =>
      app.inject({ method: 'POST', url: `/api/bins/${bin}/requests/${id}/forward`, payload: { url } });

    const literal = await forward('http://127.0.0.1:8080/');
    assert.equal(literal.statusCode, 400);

    const byName = await forward('http://localhost:8080/');
    assert.equal(byName.statusCode, 200);
    assert.equal(byName.json().outcome, 'error');
    assert.equal(byName.json().code, 'ESSRF');
    await app.close();
  });

  it('is gone entirely when forwarding is disabled', async () => {
    const app = await testApp({ HOOKTOPUS_FORWARD_ENABLED: 'false' });
    const bin = await createBin(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/bins/${bin}/requests/1/forward`,
      payload: { url: 'https://example.com' },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});
