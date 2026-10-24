import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { buildApp, type Deps } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { runMigrations } from '../src/db/migrate.ts';

export type App = Awaited<ReturnType<typeof buildApp>>;

/** The real app on an in-memory database, migrated like the real one. */
export async function testApp(env: Record<string, string> = {}, deps: Deps = {}): Promise<App> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return buildApp(loadConfig({ HOOKTOPUS_DATA_DIR: 'unused', ...env }), db, deps, false);
}

export async function createBin(app: App): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/bins' });
  if (res.statusCode !== 201) throw new Error(`createBin: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/** Listens on a free port; for tests that need real sockets rather than inject. */
export async function listen(app: App): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/**
 * A raw HTTP request with headers as a flat [name, value, ...] list, so tests
 * can send duplicates and control their order, which fetch and inject cannot.
 */
export function rawRequest(
  url: string,
  method: string,
  headers: string[],
  body?: Buffer,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    // With headers as an array Node adds no Host, and its server rejects
    // HTTP/1.1 without one.
    const all = ['Host', new URL(url).host, ...headers];
    const req = http.request(url, { method, headers: all }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

export interface Detail {
  id: number;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  bodyText: string | null;
  bodySize: number;
  contentType: string | null;
}

export async function lastRequest(app: App, binId: string): Promise<Detail> {
  const list = (await app.inject(`/api/bins/${binId}/requests?limit=1`)).json() as { requests: { id: number }[] };
  const id = list.requests[0]?.id;
  if (id === undefined) throw new Error('bin is empty');
  return (await app.inject(`/api/bins/${binId}/requests/${id}`)).json() as Detail;
}
