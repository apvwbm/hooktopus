import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createSseParser, type SseEvent } from '../src/sse.ts';

const parse = (chunks: string[]): SseEvent[] => {
  const events: SseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  for (const chunk of chunks) parser.push(chunk);
  return events;
};

it('parses id, event and data, skipping comments and retry', () => {
  const events = parse(['retry: 3000\n\n: ping\n\nid: 7\nevent: request\ndata: {"id":7}\n\n']);
  assert.deepEqual(events, [{ id: '7', event: 'request', data: '{"id":7}' }]);
});

it('survives chunks cut anywhere, even inside a line or a CRLF', () => {
  const whole = 'id: 1\r\nevent: request\r\ndata: {"a":1}\r\n\r\nid: 2\r\nevent: request\r\ndata: {"a":2}\r\n\r\n';
  for (let cut = 1; cut < whole.length; cut++) {
    const events = parse([whole.slice(0, cut), whole.slice(cut)]);
    assert.deepEqual(events.map((e) => e.data), ['{"a":1}', '{"a":2}'], `cut at ${cut}`);
  }
});

it('joins multi-line data with newlines', () => {
  assert.equal(parse(['data: one\ndata: two\n\n'])[0]!.data, 'one\ntwo');
});

it('defaults the event name to message, and keeps the last id', () => {
  const events = parse(['id: 3\ndata: a\n\ndata: b\n\n']);
  assert.deepEqual(events, [
    { id: '3', event: 'message', data: 'a' },
    { id: '3', event: 'message', data: 'b' },
  ]);
});

it('ignores an event with no data, like a bare comment block', () => {
  assert.deepEqual(parse(['event: nothing\n\n']), []);
});
