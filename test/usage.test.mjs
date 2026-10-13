import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, usageWindow, usageReader, usageProvesBusinessRecovery } from '../src/usage.mjs';
import { fingerprint } from '../src/credentials.mjs';

const now = 1791854000000;
const raw = { email: 'private@example.invalid', user_id: 'private-user', account_id: 'private-account', plan_type: 'team', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 1791868971 }, secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1792393411 } } };
const credential = { plan: 'team', token: 'synthetic-token', accountId: 'synthetic-business' };

test('usage keeps separate time windows, reset times and remaining percentages without identity data', () => {
  const result = normalizeUsage(raw, now);
  assert.deepEqual(result.windows.map(w => [w.durationSeconds, w.usedPercent, w.remainingPercent]), [[18000, 28, 72], [604800, 4, 96]]);
  assert.equal(result.windows[0].resetsAt, new Date(1791868971 * 1000).toISOString());
  assert(!JSON.stringify(result).includes('private'));
});

test('missing and null usage are unavailable, never shown as zero usage', () => {
  assert.equal(usageWindow({ used_percent: null }), null);
  assert.equal(usageWindow({ used_percent: '28' }), null);
  assert.deepEqual(normalizeUsage({ plan_type: 'prolite', rate_limit: { primary_window: null } }, now).windows, []);
  assert.equal(usageWindow({ used_percent: 110 }).remainingPercent, 0);
  assert.equal(usageWindow({ used_percent: -2 }).remainingPercent, 100);
});

test('concurrent refreshes and routine polling share one read without model requests', async () => {
  let clock = now, calls = 0, release;
  const reader = usageReader({ role: 'business', getCredential: async () => credential, now: () => clock, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers['chatgpt-account-id'], credential.accountId);
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => raw };
  } });
  const a = reader(), b = reader(true);
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.deepEqual(await a, await b); assert.equal(calls, 1);
  await reader(); await reader(true); assert.equal(calls, 1);
  clock += 300001;
  const next = reader(); await new Promise(resolve => setImmediate(resolve)); release(); await next;
  assert.equal(calls, 2);
});

test('failed usage refresh retains previous values marked stale without leaking errors', async () => {
  let clock = now, fail = false;
  const reader = usageReader({ role: 'business', getCredential: async () => credential, now: () => clock, fetchImpl: async () => {
    if (fail) throw new Error('synthetic-token private-account');
    return { ok: true, json: async () => raw };
  } });
  const first = await reader(); fail = true; clock += 300001;
  const failed = await reader();
  assert.equal(failed.stale, true); assert.equal(failed.updatedAt, first.updatedAt);
  assert.deepEqual(failed.windows, first.windows);
  assert(!JSON.stringify(failed).includes('synthetic-token'));
  assert(!JSON.stringify(failed).includes('private-account'));
});

test('wrong credential role does not query another workspace or silently label it Pro', async () => {
  let calls = 0;
  const reader = usageReader({ role: 'pro', getCredential: async () => credential, now: () => now, fetchImpl: async () => { calls++; } });
  const result = await reader(); assert.equal(calls, 0); assert.equal(result.stale, true);
  assert.deepEqual(result.windows, []); assert.match(result.error, /Pro/);
});

test('recovery requires a new successful Business query for the same account with every reported window available', () => {
  const key = fingerprint(credential.accountId), quota = { blockedAt: now - 1000, accountKey: key };
  const restored = { ...normalizeUsage(raw, now), queriedAt: new Date(now - 100).toISOString(), accountKey: key, stale: false, error: null };
  assert.equal(usageProvesBusinessRecovery(restored, quota, key, now), true);
  for (const changed of [
    { stale: true }, { error: 'failed' }, { allowed: null }, { allowed: false }, { limitReached: true }, { limitReached: null },
    { windows: [] }, { windows: [{ remainingPercent: 0 }] }, { windows: [{ remainingPercent: null }] },
    { windowsValid: false }, { queriedAt: null }, { queriedAt: new Date(now - 2000).toISOString() },
    { queriedAt: new Date(now + 100).toISOString() }, { queriedAt: new Date(now - 400000).toISOString() },
    { accountKey: fingerprint('another-business') }, { plan: 'pro' }, { plan: 'unknown' },
  ]) assert.equal(usageProvesBusinessRecovery({ ...restored, ...changed }, quota, key, now), false, JSON.stringify(changed));
  assert.equal(usageProvesBusinessRecovery(restored, { ...quota, accountKey: fingerprint('other') }, key, now), false);
  assert.equal(usageProvesBusinessRecovery(restored, { resetAt: now + 3600000 }, key, now), false);
});

test('usage query timestamp is its start, not completion; older in-flight queries cannot undo later exhaustion', async () => {
  let clock = now, release;
  const reader = usageReader({ role: 'business', getCredential: async () => credential, now: () => clock, fetchImpl: async () => {
    await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => raw };
  } });
  const pending = reader(); await new Promise(resolve => setImmediate(resolve));
  clock += 2000; const blockedAt = clock; clock += 1000; release();
  const result = await pending;
  assert.equal(Date.parse(result.queriedAt), now); assert.equal(Date.parse(result.updatedAt), clock);
  assert.equal(usageProvesBusinessRecovery(result, { blockedAt }, fingerprint(credential.accountId), clock), false);
});

test('malformed reported windows remain unsuitable for automatic recovery even when UI percentages are clamped', () => {
  for (const window of [{ used_percent: null }, { used_percent: -1 }, { used_percent: 110 }]) {
    const result = normalizeUsage({ ...raw, rate_limit: { ...raw.rate_limit, secondary_window: window } }, now);
    assert.equal(result.windowsValid, false);
  }
});
