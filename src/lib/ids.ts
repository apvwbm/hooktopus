import { randomBytes } from 'node:crypto';

/** 12 random bytes, 16 base64url characters. Unguessable, so it is the access control. */
export const newBinId = (): string => randomBytes(12).toString('base64url');

export const BIN_ID_RE = /^[A-Za-z0-9_-]{16}$/;
