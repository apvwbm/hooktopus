export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser: feed it chunks as they arrive, cut
 * anywhere, and it calls `onEvent` once per complete event. Comments (the
 * server's `: ping`) and `retry:` are ignored. Node 22's own EventSource is
 * still behind a flag, hence this.
 */
export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = '';
  let id: string | undefined;
  let event = '';
  let data: string[] = [];

  const line = (text: string) => {
    if (text === '') {
      if (data.length > 0) onEvent({ ...(id === undefined ? {} : { id }), event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value; // sticks until changed, per the spec
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A lone \r at the very end may be half of a \r\n still in flight.
        if (buffer[nl] === '\r' && nl === buffer.length - 1) break;
        const sep = buffer.startsWith('\r\n', nl) ? 2 : 1;
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + sep);
      }
    },
  };
}

export interface FollowOptions {
  onEvent: (event: SseEvent) => void;
  onStatus: (status: string) => void;
  /** Stop for good on these statuses instead of reconnecting. */
  fatal?: (status: number) => string | undefined;
}

/**
 * Follows a stream forever, reconnecting with backoff (1 s doubling to 30 s)
 * and resuming from the last event id, so a dropped connection loses nothing.
 * Returns when an `expired` event arrives; throws on a fatal status.
 */
export async function follow(url: string, opts: FollowOptions): Promise<void> {
  let lastId: string | undefined;
  let delay = 1000;
  let expired = false;

  for (;;) {
    try {
      const res = await fetch(url, { headers: lastId === undefined ? {} : { 'last-event-id': lastId } });
      const reason = opts.fatal?.(res.status);
      if (reason) throw Object.assign(new Error(reason), { fatal: true });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      opts.onStatus('connected');
      delay = 1000;
      const decoder = new TextDecoder();
      const parser = createSseParser((event) => {
        if (event.id !== undefined) lastId = event.id;
        if (event.event === 'expired') expired = true;
        opts.onEvent(event);
      });
      for await (const chunk of res.body) {
        parser.push(decoder.decode(chunk, { stream: true }));
        if (expired) return;
      }
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
    }
    opts.onStatus(`disconnected, retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}
