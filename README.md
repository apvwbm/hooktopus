<p align="center">
  <img src="public/favicon.svg" width="96" alt="HOOKtopus" />
</p>

<h1 align="center">HOOKtopus</h1>

<p align="center">
  <strong>A webhook catcher that keeps every byte.</strong><br />
  Get a URL, watch what it receives live, and forward it wherever you need it.
</p>

---

> **Status:** 0.1.0, tested end to end. No public demo yet.

## Why it's different

- **Exact bytes.** Bodies are stored as received, never parsed, so broken JSON and signed payloads arrive intact. Headers keep their order, case and duplicates.
- **A live view that doesn't drop requests.** Server-Sent Events resume from the last id seen, with no gaps and no duplicates.
- **Forwarding that isn't an SSRF proxy.** Private, loopback and metadata addresses are refused at connection time, so DNS rebinding and redirects don't get through.
- **Built for the open internet.** Size limits, rate limits, a storage cap, and bins that expire after 24 hours.

## Quick start

Requires Node 22.18+.

```sh
npm install
cp .env.example .env
npm run dev   # http://localhost:8080
```

## Forward to localhost

```sh
npx hooktopus forward http://localhost:3000
```

Creates a bin, prints its URL, and replays every request it receives against your local server, in order, catching up after a dropped connection.

## Self-hosting

```sh
docker build -t hooktopus .
docker run -d -p 8080:8080 -v hooktopus-data:/data \
  -e HOOKTOPUS_PUBLIC_URL=https://hooks.example.com hooktopus
```

Every setting is listed in [`.env.example`](.env.example). For systemd, see [`deploy/hooktopus.service`](deploy/hooktopus.service).

## Stack

Node 22 · TypeScript · Fastify · SQLite · no-build frontend · `node:test`

## License

Not chosen yet.
