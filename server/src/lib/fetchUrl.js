/**
 * SSRF guard for admin-supplied URLs.
 *
 * SECURITY-CRITICAL. An admin pastes a provider's pricing page and *the server*
 * fetches it, which makes this the classic server-side request forgery sink: the
 * request originates from inside the network, with the box's own routing table and
 * no user firewall in the way. On this deployment that reach includes the cloud
 * metadata endpoint (169.254.169.254), MongoDB on localhost, and the WordPress
 * sites that share the machine — none of which are reachable from the internet.
 * A single admin account compromise (or a merely careless admin) must not become
 * "read the instance credentials".
 *
 * The rules, all enforced here and nowhere else:
 *   - http/https only, no embedded credentials, only ordinary web ports;
 *   - every hostname is resolved and every A/AAAA record checked against the
 *     private/reserved ranges before we connect;
 *   - the same two checks run again on every redirect hop, because a perfectly
 *     public host is free to answer 302 Location: http://169.254.169.254/;
 *   - responses are streamed with a hard byte cap and a text-only content-type
 *     allowlist, so a hostile page can't exhaust the 1GB box.
 *
 * Known residual risk: DNS rebinding. We resolve the name, approve the addresses,
 * then fetch() resolves it again — a TTL-0 record can answer differently the second
 * time. Closing that needs connect-time pinning (a custom undici dispatcher), which
 * is more machinery than this admin-only feature warrants. Documented, not fixed.
 */
import dns from 'node:dns/promises';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// '' means the scheme's default port. Beyond 80/443 we allow only the two common
// alt-HTTP ports; everything else is how you reach a database, a cache or an admin
// daemon that happens to answer to a GET.
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const TEXTISH_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/xhtml+xml',
  'application/json',
  'text/markdown',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Suffixes that mean "somewhere on this machine or this network" by convention
// (mDNS, container/orchestrator service discovery, cloud metadata aliases). These
// never resolve to something an admin legitimately wants to read.
const PRIVATE_SUFFIXES = ['.localhost', '.internal', '.local'];

const USER_AGENT = 'PromptMux-Admin/1.0 (pricing fetcher)';

/**
 * Localhost-development-only escape hatch, so the flow can be exercised against a
 * fixture served on 127.0.0.1. It disables the entire private-address defence, so in
 * production it must stay unset: with it on, one crafted pricing URL reads the cloud
 * metadata service. It is deliberately read per call rather than cached at import,
 * so nothing can be flipped on later in a long-lived process without being visible.
 */
function allowPrivateAddresses() {
  return process.env.ADMIN_FETCH_ALLOW_PRIVATE === '1';
}

/** IPv6 hostnames arrive from `URL#hostname` wrapped in brackets; DNS wants them bare. */
function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Strict dotted-quad parse. Anything clever — octal `0177.0.0.1`, decimal
 * `2130706433`, short `127.1` — returns null and is therefore treated as private,
 * because those alternate spellings exist mostly to slip past filters like this one.
 */
function parseIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Returns the 16 bytes of an IPv6 address, or null. Handles `::` and a trailing dotted quad. */
function parseIPv6(text) {
  const zone = text.indexOf('%'); // fe80::1%en0 — the scope id is not part of the address
  const address = zone === -1 ? text : text.slice(0, zone);
  if (!address || /[^0-9a-fA-F:.]/.test(address)) return null;

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const readGroups = (chunk) => {
    if (!chunk) return [];
    const groups = [];
    const pieces = chunk.split(':');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.includes('.')) {
        if (i !== pieces.length - 1) return null; // an embedded IPv4 tail must be last
        const quad = parseIPv4(piece);
        if (!quad) return null;
        groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = readGroups(halves[0]);
  const tail = halves.length === 2 ? readGroups(halves[1]) : [];
  if (!head || !tail) return null;

  let groups;
  if (halves.length === 2) {
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null; // `::` must stand for at least one zero group
    groups = [...head, ...new Array(gap).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function isPrivateIPv4(b) {
  const [a, second] = b;
  if (a === 0) return true; // 0.0.0.0/8 — "this host", and 0.0.0.0 routes to localhost
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && second === 254) return true; // link-local, i.e. cloud metadata
  if (a === 172 && second >= 16 && second <= 31) return true; // 172.16/12 private
  if (a === 192 && second === 168) return true; // 192.168/16 private
  if (a === 100 && second >= 64 && second <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && second === 0 && b[2] === 0) return true; // 192.0.0/24 protocol assignments
  if (a === 192 && second === 0 && b[2] === 2) return true; // 192.0.2/24 documentation
  if (a === 198 && (second === 18 || second === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && second === 51 && b[2] === 100) return true; // 198.51.100/24 documentation
  if (a === 203 && second === 0 && b[2] === 113) return true; // 203.0.113/24 documentation
  if (a >= 224) return true; // multicast, reserved, and 255.255.255.255 broadcast
  return false;
}

/**
 * True when `ip` is loopback, private, link-local or otherwise not a public host.
 * Fails closed: anything this function cannot parse with certainty is "private".
 */
export function isPrivateAddress(ip) {
  if (typeof ip !== 'string') return true;
  const text = stripBrackets(ip.trim());
  if (!text) return true;

  const v4 = parseIPv4(text);
  if (v4) return isPrivateIPv4(v4);

  const v6 = parseIPv6(text);
  if (!v6) return true;

  // IPv4-mapped (::ffff:a9fe:a9fe) and the deprecated IPv4-compatible (::7f00:1) forms
  // reach the v4 address they wrap, so judge them as that address — not as "some IPv6".
  // This also covers :: and ::1, which unwrap to 0.0.0.0/8 and are private either way.
  if (v6.subarray(0, 10).every((byte) => byte === 0)) {
    const marker = (v6[10] << 8) | v6[11];
    if (marker === 0xffff || marker === 0) return isPrivateIPv4(v6.subarray(12));
  }

  if (v6[0] === 0xfc || v6[0] === 0xfd) return true; // fc00::/7 unique local
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (v6[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** Names that are private by convention, decided before we ask a resolver anything. */
function isPrivateHostname(host) {
  if (host === 'localhost') return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Parses and vets an admin-supplied URL string. Returns the parsed URL or the reason
 * it was refused — the caller decides whether that reason reaches the UI.
 */
export function validateFetchUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'Enter a URL to fetch.' };
  }
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: `Not a valid URL: ${rawUrl.trim().slice(0, 120)}` };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, error: `Only http and https URLs are allowed (got "${url.protocol}").` };
  }
  // Credentials in the URL would be sent to whatever the host turns out to be, and
  // they also smuggle a fake authority past humans reading the string (`user@evil`).
  if (url.username || url.password) {
    return { ok: false, error: 'URLs with an embedded username or password are not allowed.' };
  }
  if (!url.hostname || !stripBrackets(url.hostname)) {
    return { ok: false, error: 'The URL has no hostname.' };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, error: `Port ${url.port} is not allowed (only 80, 443, 8080, 8443).` };
  }
  return { ok: true, url };
}

/**
 * Resolves `hostname` and throws unless every address it answers with is public.
 * Checking *every* record matters: a host with one public A and one 127.0.0.1 A would
 * otherwise be a coin flip, and the OS picks the order.
 * @returns {Promise<string[]>} the resolved addresses
 */
export async function assertPublicHost(hostname) {
  const host = stripBrackets(String(hostname ?? '').trim())
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) throw new Error('The URL has no hostname.');

  const allowPrivate = allowPrivateAddresses();
  if (!allowPrivate && isPrivateHostname(host)) {
    throw new Error(`Blocked: "${host}" is an internal hostname.`);
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`Could not resolve "${host}" (${err.code || err.message}).`);
  }
  const addresses = records.map((record) => record.address);
  if (!addresses.length) throw new Error(`Could not resolve "${host}".`);
  if (allowPrivate) return addresses;

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Blocked: "${host}" resolves to the private address ${address}.`);
    }
  }
  return addresses;
}

/** Reads a redirect's target, resolved against the hop it came from. */
function nextHop(response, current) {
  const location = response.headers.get('location');
  if (!location) throw new Error(`Redirect from ${current.href} had no Location header.`);
  let target;
  try {
    target = new URL(location, current);
  } catch {
    throw new Error(`Redirect from ${current.href} pointed at an unusable URL.`);
  }
  const checked = validateFetchUrl(target.href);
  if (!checked.ok) throw new Error(`Redirect blocked. ${checked.error}`);
  return checked.url;
}

/**
 * Fetches a text page for the price extractor.
 *
 * Every hop is validated and DNS-checked, the body is capped at `maxBytes` while
 * streaming, and no cookie, auth header or referrer is ever sent — this request must
 * carry none of the server's own authority.
 *
 * @returns {Promise<{url: string, finalUrl: string, status: number, contentType: string,
 *   body: string, bytes: number, truncated: boolean, redirects: string[]}>}
 */
export async function fetchTextUrl(
  rawUrl,
  { maxBytes = 2_000_000, timeoutMs = 15_000, maxRedirects = 3, signal } = {}
) {
  const validated = validateFetchUrl(rawUrl);
  if (!validated.ok) throw new Error(validated.error);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let current = validated.url;
  const redirects = [];

  try {
    for (;;) {
      await assertPublicHost(current.hostname);

      let response;
      try {
        response = await fetch(current, {
          method: 'GET',
          redirect: 'manual', // we follow by hand so each hop gets re-validated
          signal: controller.signal,
          referrerPolicy: 'no-referrer',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,text/plain',
            // Ask for English explicitly. Without this, CDNs serve the caller's
            // geolocated locale — Google's pricing page came back in French,
            // where "1,50 $" uses a comma decimal separator and an extractor
            // reading it as 150 would be off by a hundredfold.
            'accept-language': 'en-US,en;q=0.9',
          },
        });
      } catch (err) {
        if (timedOut) throw new Error(`Timed out after ${timeoutMs}ms fetching ${current.href}`);
        if (controller.signal.aborted) throw err; // caller cancelled
        throw new Error(`Could not fetch ${current.href}: ${err.cause?.code || err.message}`);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await discard(response);
        if (redirects.length >= maxRedirects) {
          throw new Error(`Too many redirects (more than ${maxRedirects}) from ${validated.url.href}`);
        }
        current = nextHop(response, current);
        redirects.push(current.href);
        continue;
      }

      if (!response.ok) {
        await discard(response);
        throw new Error(`HTTP ${response.status} ${response.statusText} from ${current.href}`);
      }

      const contentType = (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      // A missing content-type is tolerated (plenty of pricing pages omit it); a
      // declared binary type is refused before we spend bytes on it.
      if (contentType && !TEXTISH_TYPES.has(contentType)) {
        await discard(response);
        throw new Error(`Refusing to read "${contentType}" from ${current.href} — text pages only.`);
      }

      const { body, bytes, truncated } = await readCapped(response, maxBytes);
      return {
        url: validated.url.href,
        finalUrl: current.href,
        status: response.status,
        contentType,
        body,
        bytes,
        truncated,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Frees the socket for a response we are not going to read. */
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // already closed — nothing to release
  }
}

/**
 * Streams the response, stopping the moment it would pass `maxBytes`. Never
 * `response.text()`: on a 1GB box an unbounded (or deliberately endless) body is a
 * one-request OOM for the whole app.
 */
async function readCapped(response, maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  const reader = response.body?.getReader();

  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (bytes + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      bytes += value.length;
    }
  }

  // Cutting at a byte boundary can split a multi-byte character; the decoder emits one
  // replacement char at the very end, which is harmless for price extraction.
  return { body: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), bytes, truncated };
}
