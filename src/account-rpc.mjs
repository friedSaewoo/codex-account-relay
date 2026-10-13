import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findCodex, stateHome } from './credentials.mjs';

// Official account RPCs only; never start a model turn or change desktop authentication.
export async function accountRpc(credential, method, params = {}) {
  if (!['account/rateLimits/read', 'account/rateLimitResetCredit/consume'].includes(method)) throw new Error('Account RPC not allowed.');
  if (method.endsWith('/consume') && !/^[0-9a-f-]{36}$/i.test(params.idempotencyKey || '')) throw new Error('Reset idempotency key required.');
  const root = join(stateHome, 'account-rpc');
  await mkdir(root, { recursive: true });
  const isolated = await mkdtemp(join(root, 'request-'));
  let child, lines, nextId = 1;
  const pending = new Map();
  function rejectAll() { for (const request of pending.values()) request.reject(new Error('Account service stopped.')); pending.clear(); }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Account service timeout.')); }, 25000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    child = spawn(await findCodex(), ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"', '-c', 'analytics.enabled=false'], { cwd: isolated, env: { ...process.env, CODEX_HOME: isolated }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); child.stdin.on('error', rejectAll); child.on('error', rejectAll); child.on('close', rejectAll);
    lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        // Refresh belongs to the existing app / Business credential provider, never this helper.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Refresh in the original account manager.' } }) + '\n');
      } else if (pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request.reject(Object.assign(new Error('Account service rejected request.'), { code: message.error.code }));
        else request.resolve(message.result);
      }
    });
    await request('initialize', { clientInfo: { name: 'codex_account_relay', version: '0.4.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    await request('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.token, chatgptAccountId: credential.accountId, chatgptPlanType: credential.plan });
    return await request(method, params);
  } finally {
    lines?.close();
    if (child && child.exitCode == null) { child.kill(); await new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 3000).unref(); }); }
    rejectAll();
    // Only this freshly created private child directory is removed.
    if (dirname(isolated) === root) await rm(isolated, { recursive: true, force: true });
  }
}
