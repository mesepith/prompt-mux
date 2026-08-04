/**
 * Unit tests for the auth rate limiter and the registration allowlist.
 * Run: npm --prefix server test
 *
 * These are the friction that makes online guessing impractical, so the exact
 * boundaries matter: off by one in the wrong direction and a limit does nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hitLimit, clearLimit, canSendOtp, recordOtpSent, clearOtpRateLimit } from './rateLimit.js';
import { isRegistrationAllowed, registrationIsOpen } from '../config/access.js';

const unique = (name) => `${name}:${process.hrtime.bigint()}`;

test('allows exactly max attempts, then blocks', () => {
  const key = unique('login');
  const limit = { max: 3, windowMs: 60_000 };
  assert.deepEqual(
    [1, 2, 3].map(() => hitLimit(key, limit).ok),
    [true, true, true]
  );
  const blocked = hitLimit(key, limit);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
});

test('reports how many attempts are left', () => {
  const key = unique('remaining');
  const limit = { max: 3, windowMs: 60_000 };
  assert.equal(hitLimit(key, limit).remaining, 2);
  assert.equal(hitLimit(key, limit).remaining, 1);
  assert.equal(hitLimit(key, limit).remaining, 0);
});

test('keys are independent — one account being throttled does not affect another', () => {
  const limit = { max: 1, windowMs: 60_000 };
  const a = unique('a');
  const b = unique('b');
  assert.equal(hitLimit(a, limit).ok, true);
  assert.equal(hitLimit(a, limit).ok, false);
  assert.equal(hitLimit(b, limit).ok, true, 'b still has its own allowance');
});

test('clearLimit forgets a key, so a successful login un-throttles the account', () => {
  const key = unique('clear');
  const limit = { max: 1, windowMs: 60_000 };
  hitLimit(key, limit);
  assert.equal(hitLimit(key, limit).ok, false);
  clearLimit(key);
  assert.equal(hitLimit(key, limit).ok, true);
});

test('the window slides: attempts outside it no longer count', async () => {
  const key = unique('window');
  const limit = { max: 2, windowMs: 120 };
  assert.equal(hitLimit(key, limit).ok, true);
  assert.equal(hitLimit(key, limit).ok, true);
  assert.equal(hitLimit(key, limit).ok, false);
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(hitLimit(key, limit).ok, true, 'allowance returns after the window');
});

// --- cost: a batch reserves every slot it will use, up front
test('a cost of 3 consumes three slots in one call', () => {
  const key = unique('cost');
  const limit = { max: 10, windowMs: 60_000 };
  const first = hitLimit(key, limit, 3);
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 7);
  assert.equal(hitLimit(key, limit, 3).remaining, 4, 'the second batch charges three more');
});

test('a batch that exactly fills the allowance is allowed', () => {
  const key = unique('cost-exact');
  const limit = { max: 3, windowMs: 60_000 };
  const filled = hitLimit(key, limit, 3);
  assert.equal(filled.ok, true);
  assert.equal(filled.remaining, 0);
  assert.equal(hitLimit(key, limit).ok, false, 'and nothing is left after it');
});

test('a batch too big for the remaining allowance is refused whole', () => {
  const key = unique('cost-over');
  const limit = { max: 5, windowMs: 60_000 };
  assert.equal(hitLimit(key, limit, 3).remaining, 2);
  const refused = hitLimit(key, limit, 4);
  assert.equal(refused.ok, false, 'four pages will not fit in two slots');
  assert.equal(refused.remaining, 0, 'remaining never goes negative');
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 60_000);
  // The refused reservation still counted its slots, which is the point: an
  // oversized batch must not leave room for a later small call to slip through
  // on an allowance the batch had already claimed.
  const after = hitLimit(key, limit, 1);
  assert.equal(after.ok, false);
  assert.equal(after.remaining, 0);
});

test('cost defaults to 1, and 0 or negative is one slot rather than a free call', () => {
  const key = unique('cost-default');
  const limit = { max: 4, windowMs: 60_000 };
  assert.equal(hitLimit(key, limit).remaining, 3, 'no cost given');
  assert.equal(hitLimit(key, limit, 1).remaining, 2, 'cost 1 is the same charge');
  assert.equal(hitLimit(key, limit, 0).remaining, 1, 'cost 0 is not free');
  assert.equal(hitLimit(key, limit, -5).remaining, 0, 'nor is a negative cost');
  assert.equal(hitLimit(key, limit, 0).ok, false, 'so cost-0 calls do exhaust the allowance');
});

test('OTP sends are limited to one per minute per email', () => {
  const email = `${unique('otp')}@example.com`;
  assert.equal(canSendOtp(email).ok, true);
  recordOtpSent(email);
  const second = canSendOtp(email);
  assert.equal(second.ok, false);
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 60_000);
  clearOtpRateLimit(email);
  assert.equal(canSendOtp(email).ok, true);
});

test('the OTP send limit is per address, and case/space insensitive', () => {
  const email = `${unique('case')}@example.com`;
  recordOtpSent(email);
  assert.equal(canSendOtp(`  ${email.toUpperCase()}  `).ok, false, 'same address, however typed');
  assert.equal(canSendOtp(`other-${email}`).ok, true);
});

// --- registration allowlist
test('registration is open when ALLOWED_EMAILS is unset or blank', () => {
  const previous = process.env.ALLOWED_EMAILS;
  try {
    delete process.env.ALLOWED_EMAILS;
    assert.equal(registrationIsOpen(), true);
    assert.equal(isRegistrationAllowed('anyone@example.com'), true);
    process.env.ALLOWED_EMAILS = '   ';
    assert.equal(isRegistrationAllowed('anyone@example.com'), true);
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = previous;
  }
});

test('an allowlist admits only listed addresses and domains', () => {
  const previous = process.env.ALLOWED_EMAILS;
  try {
    process.env.ALLOWED_EMAILS = 'me@example.com, @mycompany.com';
    assert.equal(registrationIsOpen(), false);
    assert.equal(isRegistrationAllowed('me@example.com'), true);
    assert.equal(isRegistrationAllowed('  ME@Example.com '), true, 'normalized');
    assert.equal(isRegistrationAllowed('someone@mycompany.com'), true, 'domain rule');
    assert.equal(isRegistrationAllowed('stranger@example.com'), false);
    assert.equal(isRegistrationAllowed('me@example.com.evil.com'), false, 'no partial match');
    assert.equal(isRegistrationAllowed('evil@notmycompany.com'), false);
    assert.equal(isRegistrationAllowed(''), false);
    assert.equal(isRegistrationAllowed(undefined), false);
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = previous;
  }
});
