import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); }
  throw new Error('Timed out waiting for tray integration.');
}
test('Windows tray restarts a crashed manager, retains direct mode, and exits with config preserved', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-tray-test-'));
  const state = join(root, 'state'), home = join(root, 'home');
  await mkdir(state); await mkdir(home);
  const original = '# isolated test profile\r\nmodel = "test"\r\n';
  await writeFile(join(home, 'config.toml'), original);
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })).toString('base64url')}.signature`;
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: 'isolated-test-only' } }));
  await writeFile(join(state, 'settings.json'), '{"mode":"off"}');
  const holder = net.createServer(); await new Promise(r => holder.listen(0, '127.0.0.1', r));
  const port = holder.address().port; await new Promise(r => holder.close(r));
  const appRoot = fileURLToPath(new URL('../', import.meta.url));
  await writeFile(join(appRoot, 'runtime.json'), JSON.stringify({ node: process.execPath }));
  const trayEnv = { ...process.env, CODEX_RELAY_HOME: state, CODEX_HOME: home, CODEX_RELAY_PORT: String(port), CODEX_RELAY_USAGE: '0' };
  let app = spawn(join(appRoot, 'CodexAccountRelay.exe'), [], { windowsHide: true, env: trayEnv, stdio: 'ignore' });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) await new Promise(r => execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], () => r()));
    await rm(root, { recursive: true, force: true });
  });
  const status = async () => JSON.parse(await readFile(join(state, 'manager-status.json'), 'utf8'));
  const first = await waitUntil(async () => { const s = await status(); return s.mode === 'off' && s.pid ? s : null; });
  const healthy = await fetch(`http://127.0.0.1:${port}/relay/health`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(healthy.status, 200); await healthy.text();
  // UI-only replacement must adopt the existing manager without restarting its server.
  app.kill(); await waitUntil(() => app.exitCode !== null || app.signalCode !== null);
  const previousUpdated = (await status()).updated;
  app = spawn(join(appRoot, 'CodexAccountRelay.exe'), [`--attach-manager=${first.pid}`], { windowsHide: true, env: trayEnv, stdio: 'ignore' });
  const attached = await waitUntil(async () => { const s = await status(); return s.updated !== previousUpdated && s.pid === first.pid && s; });
  assert.equal(app.exitCode, null); assert.equal(app.signalCode, null); assert.equal(attached.pid, first.pid);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), original);
  // Kill only the PID the isolated fixture launched; the tray must recreate it.
  process.kill(first.pid);
  const second = await waitUntil(async () => { const s = await status(); return s.pid !== first.pid && s.mode === 'off' ? s : null; });
  assert.notEqual(second.pid, first.pid);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), original);
  const cmd = join(state, 'commands', `${randomUUID()}.json`);
  await writeFile(cmd, '{"action":"quit"}');
  await waitUntil(() => app.exitCode !== null);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), original);
  assert.equal((await status()).stopped, true);
});
