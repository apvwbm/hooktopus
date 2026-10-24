import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sweep } from '../src/lib/cleanup.ts';
import { SSE_MAX_SUBSCRIBERS_PER_BIN } from '../src/limits.ts';
import { createBin, listen, testApp, type App } from './helpers.ts';

interface Received {
  id?: string;
  event?: string;
  data?: string;
}

/** Opens a stream and collects parsed events until `until` is satisfied. */
async function readEvents(
  url: string,
  headers: Record<string, string>,
  until: (events: Received[]) => boolean,
  onOpen?: () => Promise<unknown>,
): Promise<Received[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  const res = await fetch(url, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200);
  await onOpen?.();

  const events: Received[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const ev: Received = {};
        for (const line of block.split('\n')) {
          const [field, ...rest] = line.split(': ');
          if (field === 'id' || field === 'event' || field === 'data') ev[field] = rest.join(': ');
        }
        if (ev.event) events.push(ev);
      }
      if (until(events)) break;
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return events;
}

describe('stream', () => {
  let app: App;
  let base: string;
  let bin: string;
  const post = (body: string) => app.inject({ method: 'POST', url: `/h/${bin}`, payload: body });

  before(async () => {
    app = await testApp();
    base = await listen(app);
    bin = await createBin(app);
    await post('one');
    await post('two');
    await post('three');
  });
  after(() => app.close());

  it('replays what came after ?since=, then streams new captures live', async () => {
    const ids = (app.db.prepare('SELECT id FROM requests WHERE bin_id = ? ORDER BY id').pluck().all(bin) as number[]);
    const events = await readEvents(
      `${base}/api/bins/${bin}/stream?since=${ids[0]}`,
      {},
      (evs) => evs.length >= 3,
      () => post('four'),
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['request', 'request', 'request'],
    );
    const got = events.map((e) => Number(e.id));
    assert.deepEqual(got.slice(0, 2), [ids[1], ids[2]], 'the two it missed, in order');
    assert.ok(got[2]! > ids[2]!, 'then the live one');
    assert.equal(new Set(got).size, got.length, 'no duplicates');
  });

  it('treats Last-Event-ID like since, and it wins over the query', async () => {
    const last = app.db.prepare('SELECT MAX(id) FROM requests WHERE bin_id = ?').pluck().get(bin) as number;
    const events = await readEvents(
      `${base}/api/bins/${bin}/stream?since=0`,
      { 'Last-Event-ID': String(last - 1) },
      (evs) => evs.length >= 1,
    );
    assert.equal(Number(events[0]!.id), last);
  });

  it('sends only live events when there is no cursor', async () => {
    const events = await readEvents(`${base}/api/bins/${bin}/stream`, {}, (evs) => evs.length >= 1, () => post('live'));
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0]!.data!).bodySize, 4);
  });

  it('says goodbye with `expired` when the bin is swept', async () => {
    const other = await createBin(app);
    const events = await readEvents(`${base}/api/bins/${other}/stream`, {}, (evs) => evs.length >= 1, async () => {
      app.db.prepare('UPDATE bins SET expires_at = 1 WHERE id = ?').run(other);
      sweep(app);
    });
    assert.equal(events[0]!.event, 'expired');
  });

  it(`refuses the ${SSE_MAX_SUBSCRIBERS_PER_BIN + 1}th stream on a bin with 429`, async () => {
    const ctrl = new AbortController();
    const open = await Promise.all(
      Array.from({ length: SSE_MAX_SUBSCRIBERS_PER_BIN }, () =>
        fetch(`${base}/api/bins/${bin}/stream`, { signal: ctrl.signal }),
      ),
    );
    assert.ok(open.every((r) => r.status === 200));
    const extra = await fetch(`${base}/api/bins/${bin}/stream`);
    assert.equal(extra.status, 429);
    ctrl.abort();
  });
});
