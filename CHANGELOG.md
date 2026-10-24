# Changelog

## 0.1.0 — unreleased

First version.

- Bins with an unguessable id that expire after 24 hours.
- Capture of any method on `/h/<bin>` and below, keeping the body's exact bytes and the headers' order, case and duplicates.
- Live view over Server-Sent Events that resumes from `Last-Event-ID` without gaps or duplicates.
- Server-side forwarding of any captured request, guarded against SSRF.
- `npx hooktopus forward <target>` to replay a bin against a local server.
- Limits for running in the open: body size, requests per bin, active bins, total storage and per-IP rate limits.
