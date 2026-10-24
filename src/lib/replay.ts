import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { FORWARD_MAX_RESPONSE_BYTES, FORWARD_TIMEOUT_MS } from '../limits.ts';
import { asText, forwardable, pairs, type HeaderPairs } from './http.ts';

export interface Stored {
  method: string;
  headers: HeaderPairs;
  body: Buffer | null;
}

export type ReplayResult =
  | {
      outcome: 'response';
      status: number;
      headers: HeaderPairs;
      bodyText: string | null;
      bodyBase64: string | null;
      truncated: boolean;
      durationMs: number;
    }
  | { outcome: 'error'; code: string; message: string; durationMs: number };

export interface ReplayOptions {
  /** guardedLookup in production; left out only by tests aiming at localhost. */
  lookup?: LookupFunction | undefined;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Sends a captured request to `target`, byte for byte, and reports what came back.
 *
 * Plain http.request rather than fetch: fetch takes no custom `lookup`, which is
 * where the SSRF check lives. Redirects are reported, never followed, since a
 * public URL answering 302 to http://10.0.0.1 is the oldest SSRF trick there is.
 */
export function sendStored(stored: Stored, target: URL, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const { lookup, timeoutMs = FORWARD_TIMEOUT_MS, maxBytes = FORWARD_MAX_RESPONSE_BYTES } = opts;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  // Same flat [name, value, ...] shape as rawHeaders, which keeps order and
  // duplicates. Given an array, Node adds no Host of its own, so it goes first.
  const headers = ['Host', target.host, ...forwardable(stored.headers).flat()];
  if (stored.body) headers.push('Content-Length', String(stored.body.length));

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ReplayResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      {
        method: stored.method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(lookup ? { lookup } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        const done = () => {
          const body = Buffer.concat(chunks);
          const text = asText(body);
          settle({
            outcome: 'response',
            status: res.statusCode ?? 0,
            headers: pairs(res.rawHeaders),
            bodyText: text,
            bodyBase64: text === null ? body.toString('base64') : null,
            truncated,
            durationMs: elapsed(),
          });
        };

        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            truncated = true;
            done();
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', done);
        res.on('error', done);
      },
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
      settle({
        outcome: 'error',
        code: timedOut ? 'ETIMEDOUT' : (err.code ?? 'ERROR'),
        message: timedOut ? `No response within ${timeoutMs} ms` : err.message,
        durationMs: elapsed(),
      });
    });

    req.end(stored.body ?? undefined);
  });
}
