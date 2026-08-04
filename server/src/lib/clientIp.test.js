import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIp, clientIp } from './clientIp.js';

// --- normalizeIp ---

test('IPv4-mapped IPv6 collapses to plain IPv4', () => {
  // Node reports IPv4 clients on a dual-stack socket this way. Without collapsing,
  // one visitor is recorded as two different addresses and per-IP grouping lies.
  assert.equal(normalizeIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(normalizeIp('::FFFF:8.8.8.8'), '8.8.8.8');
});

test('IPv6 loopback is recorded as the IPv4 loopback', () => {
  assert.equal(normalizeIp('::1'), '127.0.0.1');
});

test('a real IPv6 address is preserved', () => {
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
});

test('a plain IPv4 address passes through', () => {
  assert.equal(normalizeIp('192.168.1.10'), '192.168.1.10');
});

test('a forwarded list keeps only the originating client', () => {
  assert.equal(normalizeIp('203.0.113.5, 70.41.3.18, 150.172.238.178'), '203.0.113.5');
});

test('surrounding whitespace is trimmed', () => {
  assert.equal(normalizeIp('  203.0.113.5  '), '203.0.113.5');
});

test('empty and non-string input give null, never a stored empty string', () => {
  for (const value of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(normalizeIp(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test('an absurdly long value is capped rather than stored whole', () => {
  const out = normalizeIp('a'.repeat(500));
  assert.equal(out.length, 45, 'capped at the longest possible textual IPv6 address');
});

// --- clientIp ---

test('clientIp prefers req.ip and normalizes it', () => {
  assert.equal(clientIp({ ip: '::ffff:10.0.0.7' }), '10.0.0.7');
});

test('clientIp falls back to the socket address when req.ip is absent', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '::1' } }), '127.0.0.1');
});

test('clientIp returns null when there is nothing to read', () => {
  assert.equal(clientIp({}), null);
  assert.equal(clientIp(undefined), null);
});
