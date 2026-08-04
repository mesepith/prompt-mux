/**
 * Unit tests for the admin URL fetch guard.
 * Run: npm --prefix server test   (or: node --test src/lib/fetchUrl.test.js)
 *
 * Network-free by design — only the pure decision functions are exercised, plus the
 * name/literal branches of assertPublicHost that reject before any resolver call.
 * These assertions ARE the SSRF boundary: a single "false" leaking into the private
 * table below is an open door to the cloud metadata endpoint, so every range gets a
 * case rather than a representative sample.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFetchUrl, isPrivateAddress, assertPublicHost } from './fetchUrl.js';

const PRIVATE = [
  // IPv4, one per blocked range
  ['0.0.0.0', 'unspecified / routes to localhost'],
  ['0.1.2.3', '0/8'],
  ['10.0.0.1', '10/8 private'],
  ['10.255.255.254', '10/8 upper end'],
  ['127.0.0.1', 'loopback'],
  ['127.1.2.3', '127/8, not just .0.0.1'],
  ['169.254.169.254', 'cloud metadata — the one that matters most'],
  ['169.254.0.1', 'link local'],
  ['172.16.0.1', '172.16/12 lower edge'],
  ['172.31.255.255', '172.16/12 upper edge'],
  ['192.168.1.1', '192.168/16'],
  ['100.64.0.1', 'CGNAT lower edge'],
  ['100.127.255.255', 'CGNAT upper edge'],
  ['192.0.0.1', '192.0.0/24 protocol assignments'],
  ['192.0.2.5', '192.0.2/24 documentation'],
  ['198.18.0.1', '198.18/15 lower half'],
  ['198.19.255.1', '198.18/15 upper half'],
  ['198.51.100.7', '198.51.100/24 documentation'],
  ['203.0.113.7', '203.0.113/24 documentation'],
  ['224.0.0.1', 'multicast'],
  ['239.1.1.1', 'multicast upper'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],

  // IPv6
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback, uncompressed'],
  ['fc00::1', 'unique local, fc'],
  ['fd12:3456:789a::1', 'unique local, fd'],
  ['fe80::1', 'link local'],
  ['feba::1', 'fe80::/10 upper edge (0xfeb0 still link local)'],
  ['ff02::1', 'multicast'],
  ['ff00::', 'multicast base'],

  // IPv4-mapped / IPv4-compatible must be unwrapped, not waved through as "IPv6"
  ['::ffff:127.0.0.1', 'mapped loopback, dotted'],
  ['::ffff:7f00:1', 'mapped loopback, hex'],
  ['::ffff:169.254.169.254', 'mapped metadata, dotted'],
  ['::ffff:a9fe:a9fe', 'mapped metadata, hex'],
  ['::ffff:10.0.0.1', 'mapped private'],
  ['::127.0.0.1', 'deprecated IPv4-compatible loopback'],
  ['[::1]', 'bracketed form as URL#hostname yields it'],

  // Fail closed: anything we cannot parse with certainty counts as private
  ['', 'empty'],
  ['   ', 'blank'],
  ['not-an-ip', 'a hostname, not an address'],
  ['2130706433', 'decimal 127.0.0.1'],
  ['0177.0.0.1', 'octal-looking 127.0.0.1'],
  ['127.1', 'short form of 127.0.0.1'],
  ['127.0.0.256', 'out of range octet'],
  ['1.2.3.4.5', 'five octets'],
  ['::ffff:127.0.0.1.5', 'garbage IPv4 tail'],
  ['1:2:3:4:5:6:7', 'too few IPv6 groups'],
  ['1:2:3:4:5:6:7:8:9', 'too many IPv6 groups'],
  ['1::2::3', 'two :: compressions'],
  ['1:2:3:4:5:6:7:8::', ':: standing for zero groups'],
  ['fe80::gggg', 'non-hex group'],
  ['::ffff:127.0.0.1 ', 'trailing space is trimmed, still private'],
];

const PUBLIC = [
  ['8.8.8.8', 'Google DNS'],
  ['1.1.1.1', 'Cloudflare DNS'],
  ['104.18.32.7', 'ordinary CDN address'],
  ['172.15.255.255', 'just below 172.16/12'],
  ['172.32.0.1', 'just above 172.16/12'],
  ['100.63.255.255', 'just below CGNAT'],
  ['100.128.0.1', 'just above CGNAT'],
  ['192.0.1.1', 'between 192.0.0/24 and 192.0.2/24'],
  ['198.17.255.255', 'just below 198.18/15'],
  ['198.20.0.1', 'just above 198.18/15'],
  ['169.253.0.1', 'just below link local'],
  ['169.255.0.1', 'just above link local'],
  ['223.255.255.255', 'just below multicast'],
  ['2606:4700::1111', 'public IPv6'],
  ['fbff::1', 'just below fc00::/7'],
  ['fec0::1', 'site local — deprecated, outside fe80::/10'],
  ['::ffff:8.8.8.8', 'mapped public address stays public'],
];

test('isPrivateAddress blocks every private, reserved and unparseable form', () => {
  for (const [ip, why] of PRIVATE) {
    assert.equal(isPrivateAddress(ip), true, `${JSON.stringify(ip)} must be private (${why})`);
  }
});

test('isPrivateAddress allows real public addresses', () => {
  for (const [ip, why] of PUBLIC) {
    assert.equal(isPrivateAddress(ip), false, `${JSON.stringify(ip)} must be public (${why})`);
  }
});

test('isPrivateAddress fails closed on non-string input', () => {
  for (const value of [undefined, null, 0, 2130706433, {}, [], NaN]) {
    assert.equal(isPrivateAddress(value), true, `${String(value)} must fail closed`);
  }
});

// --- validateFetchUrl
test('validateFetchUrl accepts ordinary pricing-page URLs', () => {
  const accepted = [
    'https://openai.com/api/pricing/',
    'http://example.com/prices?tier=pro#table',
    'https://example.com:443/pricing', // default port, normalized away
    'http://example.com:80/pricing',
    'https://example.com:8443/pricing',
    'http://example.com:8080/pricing',
    '  https://example.com/pricing  ', // admins paste with whitespace
  ];
  for (const raw of accepted) {
    const result = validateFetchUrl(raw);
    assert.equal(result.ok, true, `${raw} should be accepted, got: ${result.error}`);
    assert.ok(result.url instanceof URL);
  }
});

test('validateFetchUrl keeps the parsed URL, not the raw string', () => {
  const { url } = validateFetchUrl('https://Example.COM/a/b?x=1');
  assert.equal(url.hostname, 'example.com');
  assert.equal(url.href, 'https://example.com/a/b?x=1');
});

test('validateFetchUrl rejects non-http schemes', () => {
  for (const raw of [
    'file:///etc/passwd',
    'ftp://example.com/pricing',
    'gopher://example.com/1',
    'data:text/html,<b>hi</b>',
    'javascript:alert(1)',
    'redis://127.0.0.1:6379',
    'HTTPS+unix://example.com/',
  ]) {
    const result = validateFetchUrl(raw);
    assert.equal(result.ok, false, `${raw} must be rejected`);
    assert.match(result.error, /http|valid URL/i);
  }
});

test('validateFetchUrl rejects credentials embedded in the URL', () => {
  for (const raw of [
    'http://user:pass@example.com/pricing',
    'https://user@example.com/pricing',
    'https://:pass@example.com/pricing',
    'https://admin:admin@169.254.169.254/',
  ]) {
    const result = validateFetchUrl(raw);
    assert.equal(result.ok, false, `${raw} must be rejected`);
    assert.match(result.error, /username or password/i);
  }
});

test('validateFetchUrl rejects ports that are not ordinary web ports', () => {
  for (const [raw, port] of [
    ['http://example.com:22/', '22'],
    ['http://example.com:27017/', '27017'],
    ['http://example.com:6379/', '6379'],
    ['http://example.com:5050/', '5050'],
    ['http://example.com:3306/', '3306'],
    ['https://example.com:8081/', '8081'],
  ]) {
    const result = validateFetchUrl(raw);
    assert.equal(result.ok, false, `${raw} must be rejected`);
    assert.match(result.error, new RegExp(`Port ${port} is not allowed`));
  }
});

test('validateFetchUrl rejects garbage and empty input', () => {
  for (const raw of ['', '   ', 'not a url', 'example.com/pricing', '//example.com/x', 'http://', 'http://:80/']) {
    assert.equal(validateFetchUrl(raw).ok, false, `${JSON.stringify(raw)} must be rejected`);
  }
  for (const raw of [undefined, null, 42, {}, ['https://example.com']]) {
    const result = validateFetchUrl(raw);
    assert.equal(result.ok, false, `${String(raw)} must be rejected`);
    assert.match(result.error, /Enter a URL/);
  }
});

test('validateFetchUrl does not judge the host — that is assertPublicHost s job', () => {
  // Deliberate: an IP literal passes syntax validation and is stopped at resolve time.
  // Keeping the two concerns separate is what makes the redirect re-check possible.
  assert.equal(validateFetchUrl('http://169.254.169.254/latest/meta-data/').ok, true);
  assert.equal(validateFetchUrl('http://localhost:8080/').ok, true);
});

// --- assertPublicHost: only cases that resolve with no resolver traffic
test('assertPublicHost rejects internal names before any DNS lookup', async () => {
  const previous = process.env.ADMIN_FETCH_ALLOW_PRIVATE;
  delete process.env.ADMIN_FETCH_ALLOW_PRIVATE;
  try {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'api.localhost',
      'metadata.internal',
      'db.cluster.local',
      'printer.local.', // trailing dot is a legal FQDN spelling
    ]) {
      await assert.rejects(assertPublicHost(host), /internal hostname/i, host);
    }
    await assert.rejects(assertPublicHost(''), /no hostname/i);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_FETCH_ALLOW_PRIVATE;
    else process.env.ADMIN_FETCH_ALLOW_PRIVATE = previous;
  }
});

test('assertPublicHost rejects private IP literals (dns.lookup answers these locally)', async () => {
  const previous = process.env.ADMIN_FETCH_ALLOW_PRIVATE;
  delete process.env.ADMIN_FETCH_ALLOW_PRIVATE;
  try {
    for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '[::1]', '::ffff:169.254.169.254']) {
      await assert.rejects(assertPublicHost(host), /private address/i, host);
    }
  } finally {
    if (previous === undefined) delete process.env.ADMIN_FETCH_ALLOW_PRIVATE;
    else process.env.ADMIN_FETCH_ALLOW_PRIVATE = previous;
  }
});

test('ADMIN_FETCH_ALLOW_PRIVATE=1 opens the door — it must never be set in production', async () => {
  const previous = process.env.ADMIN_FETCH_ALLOW_PRIVATE;
  process.env.ADMIN_FETCH_ALLOW_PRIVATE = '1';
  try {
    assert.deepEqual(await assertPublicHost('127.0.0.1'), ['127.0.0.1']);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_FETCH_ALLOW_PRIVATE;
    else process.env.ADMIN_FETCH_ALLOW_PRIVATE = previous;
  }
});
