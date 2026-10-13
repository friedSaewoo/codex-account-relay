import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readBusiness, saveBusiness, parseAuth, stateHome, isBusiness } from './credentials.mjs';

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
const writes = new Map();
export function writeJson(path, value) {
  if (path instanceof URL) path = fileURLToPath(path);
  const next = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
      await rename(tmp, path);
    } finally { await rm(tmp, { force: true }); }
  });
  writes.set(path, next);
  const cleanup = () => { if (writes.get(path) === next) writes.delete(path); };
  next.then(cleanup, cleanup);
  return next;
}
export function businessProvider(home = stateHome) {
  let pending;
  let cached;
  const provider = async () => {
    if (cached && cached.expires * 1000 > Date.now() + 90000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const auth = await readBusiness(home);
      if (!auth) return null;
      if (!isBusiness(auth)) throw new Error('Business workspace required.');
      if (auth.expires * 1000 > Date.now() + 90000) return cached = auth;
      const refresh = auth.raw.tokens.refresh_token;
      if (!refresh) throw new Error('Business login required.');
      const result = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
      });
      if (!result.ok) throw new Error('Business token refresh failed. Login again.');
      const token = await result.json();
      if (!token.access_token) throw new Error('Business token refresh returned no access token.');
      const next = parseAuth({ ...auth.raw, last_refresh: new Date().toISOString(), tokens: { ...auth.raw.tokens, access_token: token.access_token, refresh_token: token.refresh_token || refresh, id_token: token.id_token || auth.raw.tokens.id_token } });
      if (!isBusiness(next) || next.accountId !== auth.accountId) throw new Error('Business workspace changed during refresh.');
      await saveBusiness(next, home);
      return cached = next;
    })();
    try { return await pending; } finally { pending = null; }
  };
  provider.invalidate = () => { cached = null; };
  return provider;
}

export const quotaPath = join(stateHome, 'quota.json');
