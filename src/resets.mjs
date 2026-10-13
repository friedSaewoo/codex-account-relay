import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isPro, isBusiness, fingerprint, stateHome } from './credentials.mjs';
import { readJson, writeJson } from './store.mjs';
import { accountRpc } from './account-rpc.mjs';

export function normalizeResets(data, now = Date.now()) {
  const value = data?.rateLimitResetCredits;
  const availableCount = Number.isInteger(value?.availableCount) && value.availableCount >= 0 ? value.availableCount : null;
  const detailsKnown = Array.isArray(value?.credits);
  const expiries = new Map();
  for (const row of value?.credits || []) {
    if (row.status !== 'available' || row.resetType !== 'codexRateLimits') continue;
    const seconds = row.expiresAt;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds * 1000 <= now) continue;
    const at = new Date(seconds * 1000).toISOString();
    expiries.set(at, (expiries.get(at) || 0) + 1);
  }
  return { availableCount, detailsKnown, expiries: [...expiries].sort(([a], [b]) => a.localeCompare(b)).map(([expiresAt, count]) => ({ expiresAt, count })), updatedAt: new Date(now).toISOString() };
}
const outcomes = { reset: '초기화 1회 사용 완료', alreadyRedeemed: '초기화 사용 완료 확인', nothingToReset: '지금 초기화할 수 있는 한도가 없습니다.', noCredit: '사용 가능한 초기화권이 없습니다.' };

export function resetManager({ role, getCredential, rpc = accountRpc, directory = stateHome, now = Date.now }) {
  if (!['business', 'pro'].includes(role)) throw new Error('Unknown reset role.');
  const path = join(directory, `reset-${role}.pending.json`);
  let snapshot = null, credits = [], pending = null, reading = null, lastAttempt = 0, busy = false, message = null;
  function status() { return { ...(snapshot || { availableCount: null, expiries: [], updatedAt: null, stale: true }), pending: !!pending, busy, message, canUse: !busy && (!!pending || (snapshot?.stale === false && snapshot.availableCount > 0 && now() - Date.parse(snapshot.updatedAt) < 360000)) }; }
  async function credential() {
    const value = await getCredential();
    if (!value || !(role === 'pro' ? isPro(value) : isBusiness(value))) throw new Error('Account role changed.');
    return value;
  }
  async function refresh(force = false, bypassThrottle = false) {
    if (reading) return reading;
    if (!bypassThrottle && lastAttempt && now() - lastAttempt < (force ? 30000 : 300000)) return status();
    lastAttempt = now();
    reading = (async () => {
      try {
        pending = await readJson(path);
        if (force && !busy && !pending) message = null;
        const auth = await credential();
        const accountKey = fingerprint(`${role}|${auth.accountId}`);
        const data = await rpc(auth, 'account/rateLimits/read');
        if (data.accountId && data.accountId !== auth.accountId) throw new Error('Account mismatch.');
        credits = (data?.rateLimitResetCredits?.credits || []).filter(row => row.status === 'available' && row.resetType === 'codexRateLimits' && typeof row.id === 'string' && (row.expiresAt == null || row.expiresAt * 1000 > now())).sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
        snapshot = { ...normalizeResets(data, now()), accountKey, stale: false, error: null };
        if (pending && pending.accountKey !== accountKey) { snapshot.stale = true; snapshot.error = '이전 초기화 결과 확인이 필요합니다. 원래 계정으로 연결해주세요.'; }
      } catch {
        credits = [];
        snapshot = { ...(snapshot || { availableCount: null, expiries: [], updatedAt: null }), stale: true, error: '초기화 정보 조회 실패 · 다시 새로고침해주세요.' };
      }
      return status();
    })();
    try { return await reading; } finally { reading = null; }
  }
  async function consume(accountKey) {
    if (busy) return { outcome: 'busy' };
    busy = true; message = '초기화 처리 중…';
    try {
      const auth = await credential();
      if (fingerprint(`${role}|${auth.accountId}`) !== accountKey) { message = '계정이 바뀌었습니다. 다시 조회해주세요.'; return { outcome: 'accountChanged' }; }
      await refresh(true, true);
      if (snapshot?.stale || snapshot.accountKey !== accountKey || (pending && pending.accountKey !== accountKey)) { message = '초기화 정보 확인 후 다시 시도해주세요.'; return { outcome: 'unavailable' }; }
      if (!pending && !(snapshot.availableCount > 0)) { message = '사용 가능한 초기화권이 없습니다.'; return { outcome: 'noCredit' }; }
      if (!pending) {
        pending = { accountKey, idempotencyKey: randomUUID(), ...(credits[0] ? { creditId: credits[0].id } : {}) };
        // Persist before spending; retries after disconnect/restart reuse this exact logical attempt.
        await writeJson(path, pending);
      }
      const result = await rpc(auth, 'account/rateLimitResetCredit/consume', { idempotencyKey: pending.idempotencyKey, ...(pending.creditId ? { creditId: pending.creditId } : {}) });
      if (!Object.hasOwn(outcomes, result?.outcome)) throw new Error('Unknown reset outcome.');
      message = outcomes[result.outcome];
      await rm(path, { force: true }); pending = null;
      await refresh(true, true);
      return { outcome: result.outcome };
    } catch {
      message = pending ? '결과가 확인되지 않았습니다. ‘결과 확인’으로 같은 요청을 확인해주세요.' : '초기화 실행 실패 · 다시 조회해주세요.';
      return { outcome: pending ? 'uncertain' : 'unavailable' };
    } finally { busy = false; }
  }
  return { read: refresh, consume, status };
}
