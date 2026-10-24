import type { ZodType } from 'zod';

/** An error the error handler turns into { error } with this status. */
export const httpError = (statusCode: number, message: string): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode });

/** zod parse that fails as a 400 naming the first issue, rather than a 500. */
export function parseOr400<T>(schema: ZodType<T, any, any>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw httpError(400, issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input');
}

// Connection-level headers. They describe one hop, not the request, so a
// replay must not carry them over; host and content-length are recomputed for
// the new target and body.
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export type HeaderPairs = [name: string, value: string][];

/** Node's rawHeaders is a flat [name, value, name, value] list. */
export function pairs(raw: string[]): HeaderPairs {
  const out: HeaderPairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
}

export const forwardable = (headers: HeaderPairs): HeaderPairs =>
  headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()));

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The body as text when it is valid UTF-8, otherwise null (binary). */
export function asText(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}
