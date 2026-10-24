export interface Subscriber {
  write(chunk: string): void;
  end(): void;
}

export interface SseEvent {
  id?: number;
  event: string;
  data: unknown;
}

export const sseFrame = ({ id, event, data }: SseEvent): string =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export type Hub = ReturnType<typeof createHub>;

// ponytail: fan-out in memory, so one process. More than one instance needs a
// shared channel (Redis pub/sub, Postgres LISTEN/NOTIFY) between capture and stream.
export function createHub() {
  const bins = new Map<string, Set<Subscriber>>();

  const closeBin = (binId: string, lastChunk?: string): void => {
    for (const sub of bins.get(binId) ?? []) {
      if (lastChunk) sub.write(lastChunk);
      sub.end();
    }
    bins.delete(binId);
  };

  return {
    subscribe(binId: string, sub: Subscriber): () => void {
      let subs = bins.get(binId);
      if (!subs) bins.set(binId, (subs = new Set()));
      const mine = subs;
      mine.add(sub);
      return () => {
        mine.delete(sub);
        if (mine.size === 0 && bins.get(binId) === mine) bins.delete(binId);
      };
    },

    publish(binId: string, chunk: string): void {
      for (const sub of bins.get(binId) ?? []) sub.write(chunk);
    },

    /** Sends a last chunk to everyone on the bin, then hangs up on them. */
    closeBin,

    count: (binId: string): number => bins.get(binId)?.size ?? 0,

    broadcast(chunk: string): void {
      for (const subs of bins.values()) for (const sub of subs) sub.write(chunk);
    },

    closeAll(): void {
      for (const id of [...bins.keys()]) closeBin(id);
    },
  };
}
