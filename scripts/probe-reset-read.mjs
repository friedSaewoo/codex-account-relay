import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDesktopAuth, readBusiness, desktopHome, fingerprint } from '../src/credentials.mjs';
import { accountRpc } from '../src/account-rpc.mjs';
const before = await readFile(join(desktopHome, 'auth.json'));
for (const role of ['business', 'pro']) {
  const credential = await (role === 'pro' ? readDesktopAuth() : readBusiness());
  const data = await accountRpc(credential, 'account/rateLimits/read');
  const credits = data?.rateLimitResetCredits;
  console.log(JSON.stringify({ role, responseKeys: Object.keys(data || {}), availableCount: credits?.availableCount ?? null, detailsKnown: Array.isArray(credits?.credits), details: (credits?.credits || []).map(row => ({ resetType: row.resetType, status: row.status, expiresAt: row.expiresAt, grantedAt: row.grantedAt })) }));
}
console.log(JSON.stringify({ desktopAuthUnchanged: fingerprint(before) === fingerprint(await readFile(join(desktopHome, 'auth.json'))), resetConsumed: false }));
