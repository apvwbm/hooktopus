<p align="center">
  <img src="public/favicon.svg" width="96" alt="HOOKtopus" />
</p>

<h1 align="center">HOOKtopus</h1>

<p align="center">
  <strong>A webhook catcher that keeps every byte.</strong><br />
  Get a URL, watch what it receives live, and forward it wherever you need it.
</p>

---

Point a webhook at a HOOKtopus bin and every request lands in a live view:
method, path, query, headers, body. Forward any of them to a public URL from
the browser, or to your own machine with `npx hooktopus`.

> **Status:** 0.1.0. Works end to end and is tested; the Docker image has not
> been built yet and there is no public demo until the homelab is back up.

## What it gets right

**The exact bytes.** Bodies are stored as received, never parsed. A payload
that claims to be JSON and is not is shown exactly as it arrived, which is
when you most need to see it. Whitespace and key order survive too, so a
signature computed over the raw body still checks out.

**Headers as sent.** Order, case and duplicates are kept, from Node's
`rawHeaders` rather than the parsed object that lowercases and merges them.

**A live view that does not drop requests.** The browser and the CLI follow a
Server-Sent Events stream and resume from the last id they saw. The replay
query and the subscription happen in the same synchronous tick, and so does a
capture's insert and publish, so a request is always either in the replay or
in the live feed, never in neither.

**Forwarding that is not an SSRF proxy.** Forwards from the server refuse
loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved
addresses. The check lives in the `lookup` of the connection actually being
made, so DNS rebinding does not get past it; IP literals, which never reach
`lookup`, are checked up front; redirects are reported, never followed.

**Built for the open internet.** Everything has a ceiling (see [Limits](#limits)),
bins expire, and raw bodies download as `application/octet-stream`, so nobody
can host a phishing page on the domain by posting HTML to a bin.

## Quick start

Node 22.18 or newer runs the TypeScript directly.

```sh
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:8080, create a bin, and send it something:

```sh
curl -X POST "http://localhost:8080/h/<bin>/stripe?x=1" \
  -H "Content-Type: application/json" \
  -H "X-Dup: a" -H "X-Dup: b" \
  --data '{"broken":'
```

## Forwarding to localhost

A forward made by the server cannot reach your laptop. The CLI can: it follows
the bin's live stream and replays each request against your local server, in
order, reconnecting and catching up if the connection drops.

```sh
npx hooktopus forward http://localhost:3000
npx hooktopus forward http://localhost:3000/api --bin <id> --server http://localhost:8080
```

The captured path and query are appended to the target: a request to
`/h/<bin>/stripe?x=1` reaches `http://localhost:3000/api/stripe?x=1`.

Duplicate headers reach the target joined into one (`fetch` combines them);
the server-side forward keeps them separate.

## API

Errors always come back as `{ "error": "..." }`.

| Route | |
|---|---|
| `POST /api/bins` | Create a bin → `201 { id, captureUrl, viewUrl, expiresAt }` |
| `GET /api/bins/:id` | Bin metadata and request count |
| `GET /api/bins/:id/requests?before=&limit=` | Summaries, newest first, 50 per page |
| `GET /api/bins/:id/requests/:rid` | Full request: headers as `[name, value]` pairs, body in base64, `bodyText` when it is valid UTF-8 |
| `GET /api/bins/:id/requests/:rid/raw` | The body's bytes, as a download |
| `GET /api/bins/:id/stream` | Server-Sent Events. `?since=<id>` or `Last-Event-ID` replays what came after; events are `request` and `expired` |
| `POST /api/bins/:id/requests/:rid/forward` | `{ url }` → what the target answered, or why it could not be reached |
| `ANY /h/:id` and `/h/:id/*` | Capture |
| `GET /api/health` | `{ status, version }` |

An unknown bin is 404; an expired one is 410 until it is swept, then 404.

## Limits

| | |
|---|---|
| Body size | 512 KB, larger is refused with 413 and not stored |
| Requests per bin | 200, the newest are kept |
| Bin lifetime | 24 hours (`HOOKTOPUS_BIN_TTL_HOURS`) |
| Active bins | 1,000, then 503 |
| Total storage | 1 GB (`HOOKTOPUS_MAX_STORAGE_MB`), then 507 until expired bins free space |
| Captures | 120 per minute per IP |
| New bins | 20 per hour per IP |
| Forwards | 10 per minute per IP, 10 s timeout, 64 KB of the response kept |
| Live streams | 20 per bin |

## Configuration

| Variable | Default | |
|---|---|---|
| `HOOKTOPUS_PORT` | `8080` | |
| `HOOKTOPUS_DATA_DIR` | `/data` | SQLite lives here |
| `HOOKTOPUS_PUBLIC_URL` | `http://localhost:8080` | Base of the URLs the API hands out |
| `HOOKTOPUS_TRUST_PROXY` | `false` | `true` behind a reverse proxy, so limits see real client IPs |
| `HOOKTOPUS_BIN_TTL_HOURS` | `24` | Fractions work |
| `HOOKTOPUS_MAX_STORAGE_MB` | `1024` | |
| `HOOKTOPUS_FORWARD_ENABLED` | `true` | Kill switch for server-side forwarding |

There is deliberately no setting that turns the SSRF guard off.

## Self-hosting

With Docker (see the note at the top of the `Dockerfile`):

```sh
docker build -t hooktopus .
docker run -d -p 8080:8080 -v hooktopus-data:/data \
  -e HOOKTOPUS_PUBLIC_URL=https://hooks.example.com \
  -e HOOKTOPUS_TRUST_PROXY=true hooktopus
```

Or with systemd from a checkout: `deploy/hooktopus.service` has the steps.

Behind a reverse proxy, check three things: it must not buffer the event
stream (nginx: `proxy_buffering off`, though the `X-Accel-Buffering: no`
header already asks it), its read timeout must be longer than the 25 s
heartbeat, and it must accept bodies of at least 512 KB.

## What it deliberately is not

- **Not private.** Anyone with a bin's URL can read it. The id is 96 random
  bits and the URL is the credential, as with any paste service.
- **Not a tunnel.** Requests are stored and replayed, not proxied: the sender
  gets `200 {"ok":true}`, never your local server's answer.
- **Not multi-instance.** Rate limits and the live fan-out are in memory, and
  that is a decision, not an oversight: one process and one SQLite file is all
  this needs.

Signature verification, scheduled retries and custom responses are the next
things on the list.

## Development

```sh
npm test            # typecheck + node:test, server
cd cli && npm test  # the CLI's own tests
npm run build       # dist/ for production
```

## License

Not chosen yet. Until a `LICENSE` file exists, default copyright applies.
