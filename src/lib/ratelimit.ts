export interface Limiter {
  /** Counts one hit. Returns the seconds to wait, or 0 if the hit is allowed. */
  hit(key: string, now?: number): number;
}

// ponytail: fixed window in memory, one process. Bursts at a window edge can
// reach twice the limit; shared state (Redis) once there is more than one
// instance or real traffic.
export function createLimiter(windowMs: number, max: number): Limiter {
  const windows = new Map<string, { n: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    hit(key, now = Date.now()) {
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { n: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.n += 1;
      return w.n > max ? Math.ceil((w.resetAt - now) / 1000) : 0;
    },
  };
}
