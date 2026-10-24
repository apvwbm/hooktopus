// Limits that are part of how the service behaves rather than how it is
// deployed. They are constants, not environment variables, on purpose: nobody
// tunes them per install, and a knob nobody turns is just one more thing to
// document.

export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_REQUESTS_PER_BIN = 200; // the newest are kept
export const MAX_ACTIVE_BINS = 1000;

export const RATE_CAPTURE = { windowMs: 60_000, max: 120 };
export const RATE_CREATE_BIN = { windowMs: 3_600_000, max: 20 };
export const RATE_FORWARD = { windowMs: 60_000, max: 10 };

export const SSE_MAX_SUBSCRIBERS_PER_BIN = 20;
export const SSE_HEARTBEAT_MS = 25_000;
export const SSE_REPLAY_MAX = 200;

export const FORWARD_TIMEOUT_MS = 10_000;
export const FORWARD_MAX_RESPONSE_BYTES = 64 * 1024;

export const JANITOR_INTERVAL_MS = 60_000;
export const LIST_PAGE = 50;
