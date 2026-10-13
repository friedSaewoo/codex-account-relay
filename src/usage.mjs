import { isPro, isBusiness } from './credentials.mjs';

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
export function usageWindow(value) {
  if (!value || !finite(value.used_percent)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, value.used_percent)),
    remainingPercent: Math.max(0, Math.min(100, 100 - value.used_percent)),
    durationSeconds: finite(value.limit_window_seconds) && value.limit_window_seconds > 0 ? value.limit_window_seconds : null,
    resetsAt: finite(value.reset_at) && value.reset_at > 0 ? new Date(value.reset_at * 1000).toISOString() : null,
  };
}
export function normalizeUsage(raw, now = Date.now()) {
  const limits = raw?.rate_limit;
  return {
    updatedAt: new Date(now).toISOString(),
    plan: typeof raw?.plan_type === 'string' ? raw.plan_type : 'unknown',
    allowed: typeof limits?.allowed === 'boolean' ? limits.allowed : null,
    limitReached: typeof limits?.limit_reached === 'boolean' ? limits.limit_reached : null,
    windows: [usageWindow(limits?.primary_window), usageWindow(limits?.secondary_window)].filter(Boolean),
  };
}
export function usageReader({ getCredential, role, fetchImpl = fetch, now = Date.now, minIntervalMs = 30000 }) {
  let pending, lastAttempt = 0, snapshot = null;
  const read = async function read(force = false) {
    if (pending) return pending;
    if (lastAttempt && now() - lastAttempt < (force ? minIntervalMs : 300000)) return snapshot;
    lastAttempt = now();
    pending = (async () => {
      let error = '사용량 조회 실패 · 다시 새로고침해주세요.';
      try {
        const credential = await getCredential();
        if (!credential || (role === 'pro' ? !isPro(credential) : !isBusiness(credential))) {
          error = `${role === 'pro' ? 'Pro' : 'Business'} 로그인 확인 필요`;
          throw new Error('Credential role unavailable.');
        }
        const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
          headers: { authorization: `Bearer ${credential.token}`, 'chatgpt-account-id': credential.accountId },
          redirect: 'error', signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
          if (response.status === 401) error = '로그인 갱신 필요 · 앱 또는 Business 로그인을 확인해주세요.';
          throw new Error('Usage unavailable.');
        }
        const data = await response.json();
        if (data?.plan_type && (role === 'pro' ? !isPro({ plan: data.plan_type }) : !isBusiness({ plan: data.plan_type }))) {
          error = '선택된 작업공간 확인 필요';
          snapshot = null;
          throw new Error('Usage workspace mismatch.');
        }
        snapshot = { ...normalizeUsage(data, now()), lastAttemptAt: new Date(now()).toISOString(), stale: false, error: null };
      } catch {
        snapshot = { ...(snapshot || { windows: [], updatedAt: null }), lastAttemptAt: new Date(now()).toISOString(), stale: true, error };
      }
      return snapshot;
    })();
    try { return await pending; } finally { pending = null; }
  };
  read.invalidate = () => { lastAttempt = 0; };
  return read;
}
