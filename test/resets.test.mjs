import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeResets, resetManager } from '../src/resets.mjs';
const clock = 1791856000000;
const auth = { plan: 'team', accountId: 'synthetic-business', token: 'synthetic-secret' };
function data(count = 2) { return { accountId: auth.accountId, rateLimitResetCredits: { availableCount: count, credits: [{ id: 'late', status: 'available', resetType: 'codexRateLimits', expiresAt: clock / 1000 + 864000 }, { id: 'early', status: 'available', resetType: 'codexRateLimits', expiresAt: clock / 1000 + 86400 }] } }; }
async function root(t) { const path = await mkdtemp(join(tmpdir(), 'codex-reset-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('default system clock can read reset availability without injected test dependencies', async t => {
  const manager = resetManager({ role: 'business', directory: await root(t), getCredential: async () => auth, rpc: async () => ({ accountId: auth.accountId, rateLimitResetCredits: { availableCount: 0, credits: [] } }) });
  const status = await manager.read(); assert.equal(status.availableCount, 0); assert.equal(status.stale, false); assert(Number.isFinite(Date.parse(status.updatedAt)));
});
test('reset count is authoritative, unknown stays unknown and expiry metadata excludes private IDs', () => {
  const source = data(7); source.rateLimitResetCredits.credits.push({ id: 'expired', status: 'available', resetType: 'codexRateLimits', expiresAt: clock / 1000 - 1 });
  const result = normalizeResets(source, clock);
  assert.equal(result.availableCount, 7); assert.equal(result.expiries.length, 2);
  assert.equal(result.expiries[0].expiresAt, new Date(clock + 86400000).toISOString());
  assert(!JSON.stringify(result).includes('early')); assert.equal(normalizeResets({}, clock).availableCount, null);
});
test('reading reset credits never spends them and stale reads disable spending', async t => {
  let fail = false, calls = [];
  const manager = resetManager({ role: 'business', directory: await root(t), getCredential: async () => auth, now: () => clock, rpc: async (_auth, method) => { calls.push(method); if (fail) throw new Error(auth.token); return data(); } });
  const status = await manager.read(); assert.equal(status.availableCount, 2); assert(status.canUse);
  fail = true; await manager.read(true, true); assert.equal(manager.status().canUse, false);
  assert(calls.every(method => method === 'account/rateLimits/read')); assert(!JSON.stringify(manager.status()).includes(auth.token));
});
test('consume selects earliest expiry, persists idempotency first and rereads server state', async t => {
  const directory = await root(t); let spent = false, consumeCalls = 0;
  const manager = resetManager({ role: 'business', directory, getCredential: async () => auth, now: () => clock, rpc: async (_auth, method, params) => {
    if (method.endsWith('/read')) return data(spent ? 1 : 2);
    consumeCalls++; const saved = JSON.parse(await readFile(join(directory, 'reset-business.pending.json'), 'utf8'));
    assert.equal(saved.idempotencyKey, params.idempotencyKey); assert.equal(params.creditId, 'early'); spent = true;
    return { outcome: 'reset' };
  } });
  const status = await manager.read(); assert.equal((await manager.consume(status.accountKey)).outcome, 'reset');
  assert.equal(consumeCalls, 1); assert.equal(manager.status().availableCount, 1); assert.equal(manager.status().pending, false);
});
test('ambiguous spend survives restart, retries same ID even at zero remaining and is never automatically retried', async t => {
  const directory = await root(t); let calls = 0, key, spent = false;
  const rpc = async (_auth, method, params) => {
    if (method.endsWith('/read')) return data(spent ? 0 : 2);
    calls++;
    if (!key) { key = params.idempotencyKey; spent = true; throw new Error('Connection lost after acceptance.'); }
    assert.equal(params.idempotencyKey, key); assert.equal(params.creditId, 'early'); return { outcome: 'alreadyRedeemed' };
  };
  const options = { role: 'business', directory, getCredential: async () => auth, now: () => clock, rpc };
  const first = resetManager(options), initial = await first.read();
  assert.equal((await first.consume(initial.accountKey)).outcome, 'uncertain');
  const restarted = resetManager(options), status = await restarted.read();
  assert.equal(calls, 1); assert(status.pending); assert(status.canUse); assert.equal(status.availableCount, 0);
  assert.equal((await restarted.consume(status.accountKey)).outcome, 'alreadyRedeemed'); assert.equal(calls, 2);
});
test('changed account or incorrect role cannot consume a reset', async t => {
  let selected = auth, calls = 0;
  const manager = resetManager({ role: 'business', directory: await root(t), getCredential: async () => selected, now: () => clock, rpc: async (_auth, method) => { if (method.endsWith('/consume')) calls++; return data(); } });
  const before = await manager.read(); selected = { ...auth, accountId: 'different-account' };
  assert.equal((await manager.consume(before.accountKey)).outcome, 'accountChanged');
  selected = { ...auth, plan: 'prolite' }; assert.equal((await manager.consume(before.accountKey)).outcome, 'unavailable'); assert.equal(calls, 0);
});
test('duplicate submissions share one in-flight redemption', async t => {
  let release, calls = 0;
  const manager = resetManager({ role: 'business', directory: await root(t), getCredential: async () => auth, now: () => clock, rpc: async (_auth, method) => {
    if (method.endsWith('/read')) return data(); calls++; await new Promise(resolve => { release = resolve; }); return { outcome: 'nothingToReset' };
  } });
  const before = await manager.read(), first = manager.consume(before.accountKey);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.consume(before.accountKey)).outcome, 'busy'); release();
  assert.equal((await first).outcome, 'nothingToReset'); assert.equal(calls, 1); assert.equal(manager.status().pending, false);
});
