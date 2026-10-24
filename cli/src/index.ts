#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { follow } from './sse.ts';

const DEFAULT_SERVER = 'https://hooktopus.apvwbm.com';

// ponytail: duplicated from the server's src/lib/http.ts on purpose, so this
// package ships without depending on the server. Keep the two in step.
const HOP_BY_HOP = new Set([
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

const USAGE = `Usage: hooktopus forward <target> [--bin <id>] [--server <url>]

Replays every request a HOOKtopus bin receives against <target>, typically
your local server. Without --bin, a new bin is created and its URL printed.

  <target>         Base URL to forward to, e.g. http://localhost:3000
                   The captured path and query are appended to it.
  --bin <id>       Follow an existing bin instead of creating one
  --server <url>   HOOKtopus server (default: ${DEFAULT_SERVER})
`;

interface Detail {
  id: number;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
}

const dim = (s: string) => styleText('dim', s);
const fail = (message: string): never => {
  console.error(styleText('red', message));
  process.exit(1);
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      bin: { type: 'string' },
      server: { type: 'string', default: DEFAULT_SERVER },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command, rawTarget] = positionals;
  if (values.help || command !== 'forward' || !rawTarget) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return fail(`Not a URL: ${rawTarget}`);
  }
  const targetBase = target.href.replace(/\/+$/, '');
  const server = values.server.replace(/\/+$/, '');

  let binId = values.bin;
  let captureUrl: string;
  try {
    if (binId) {
      ({ captureUrl } = await getJson<{ captureUrl: string }>(`${server}/api/bins/${binId}`));
    } else {
      const bin = await getJson<{ id: string; captureUrl: string }>(`${server}/api/bins`, { method: 'POST' });
      binId = bin.id;
      captureUrl = bin.captureUrl;
    }
  } catch (err) {
    return fail(`Could not ${values.bin ? 'open that bin' : 'create a bin'} on ${server}: ${(err as Error).message}`);
  }

  console.log(`${styleText('bold', 'HOOKtopus')} forwarding to ${styleText('cyan', targetBase)}\n`);
  console.log(`  Send webhooks to  ${styleText('bold', captureUrl)}`);
  console.log(`  Watch them at     ${server}/b/${binId}\n`);

  // One at a time, in arrival order: a target that sees "created" after
  // "updated" is debugging something that never happened.
  let queue = Promise.resolve();
  const replay = async (id: number) => {
    const started = performance.now();
    let label = `#${id}`;
    try {
      const req = await getJson<Detail>(`${server}/api/bins/${binId}/requests/${id}`);
      label = `${req.method} ${req.url}`;
      const headers = new Headers();
      for (const [name, value] of req.headers) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== '';
      const res = await fetch(targetBase + req.url, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.from(req.body, 'base64') : null,
        redirect: 'manual',
      });
      await res.arrayBuffer();
      const ms = Math.round(performance.now() - started);
      const status = styleText(res.status < 400 ? 'green' : 'red', String(res.status));
      console.log(`${dim(new Date().toLocaleTimeString())}  ${label} → ${status} ${dim(`· ${ms} ms`)}`);
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
      console.log(`${dim(new Date().toLocaleTimeString())}  ${label} → ${styleText('red', cause)}`);
    }
  };

  await follow(`${server}/api/bins/${binId}/stream`, {
    onEvent: (event) => {
      if (event.event !== 'request') return;
      const { id } = JSON.parse(event.data) as { id: number };
      queue = queue.then(() => replay(id));
    },
    onStatus: (status) => console.log(dim(`  stream ${status}`)),
    fatal: (status) =>
      status === 404 ? 'That bin does not exist.' : status === 410 ? 'That bin has expired.' : undefined,
  });

  await queue;
  fail('The bin expired. Run the command again for a fresh one.');
}

main().catch((err: unknown) => fail((err as Error).message));
