import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { httpError } from './http.ts';

// Everything a forward must never reach: loopback, private networks, link
// local (169.254.169.254 is the cloud metadata endpoint), CGNAT, multicast,
// reserved, and NAT64, which smuggles an IPv4 address inside an IPv6 one.
//
// No ::ffff:0:0/96 rule for IPv4-mapped addresses: BlockList already checks
// ::ffff:127.0.0.1 against the IPv4 rules, and an IPv6 rule for that range
// would also match every plain IPv4 address, public ones included.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlocked(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * A dns.lookup that refuses private addresses, for http.request's `lookup`.
 *
 * Checking here rather than resolving up front is the point: this runs for the
 * connection actually being made, so a name that resolves to a public address
 * when checked and a private one when connecting (DNS rebinding) is caught.
 * One blocked address fails the whole name, not just that address.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);

    const bad = addresses.find((a) => isBlocked(a.address));
    if (bad) {
      const refused = Object.assign(
        new Error(`${hostname} resolves to ${bad.address}, a private or reserved address`),
        { code: 'ESSRF' },
      );
      return callback(refused, '', 0);
    }

    const first = addresses[0]!;
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

/**
 * Validates a forward target, failing as a 400.
 *
 * IP literals are checked here because Node never calls `lookup` for them:
 * http://127.0.0.1 would sail past guardedLookup untouched.
 */
export function assertTarget(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'url: not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'url: only http and https targets are allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && isBlocked(host)) {
    throw httpError(400, `url: ${host} is a private or reserved address`);
  }

  return url;
}
