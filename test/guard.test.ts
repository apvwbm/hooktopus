import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertTarget, guardedLookup, isBlocked } from '../src/lib/guard.ts';

describe('isBlocked', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped, caught by the IPv4 rules
    '::ffff:7f00:1', // the same, in hex
    '::ffff:10.1.2.3',
    'fd00::1',
    'fe80::1',
    '64:ff9b::7f00:1',
    'not an ip',
  ]) {
    it(`blocks ${ip}`, () => assert.equal(isBlocked(ip), true));
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '::ffff:8.8.8.8', '2606:4700::1111']) {
    it(`allows ${ip}`, () => assert.equal(isBlocked(ip), false));
  }
});

describe('assertTarget', () => {
  it('refuses IP literals that lookup would never see', () => {
    for (const url of ['http://127.0.0.1:8080/', 'http://[::1]/', 'https://169.254.169.254/latest/meta-data']) {
      assert.throws(() => assertTarget(url), /private or reserved/, url);
    }
  });

  it('refuses schemes other than http and https', () => {
    for (const url of ['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com']) {
      assert.throws(() => assertTarget(url), /only http and https/, url);
    }
  });

  it('refuses garbage', () => assert.throws(() => assertTarget('not a url'), /not a valid URL/));

  it('lets public targets and hostnames through (lookup checks those)', () => {
    assert.equal(assertTarget('https://example.com/hook').hostname, 'example.com');
    assert.equal(assertTarget('http://1.1.1.1/').hostname, '1.1.1.1');
  });

  it('lets private literals through only when explicitly allowed', () => {
    assert.equal(assertTarget('http://127.0.0.1/', true).hostname, '127.0.0.1');
  });
});

describe('guardedLookup', () => {
  const resolve = (host: string, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((done) =>
      guardedLookup(host, { all }, (err, address) => done({ err, address })),
    );

  it('refuses a name that resolves to loopback', async () => {
    for (const all of [false, true]) {
      const { err } = await resolve('localhost', all);
      assert.equal(err?.code, 'ESSRF');
    }
  });
});
