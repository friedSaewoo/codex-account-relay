import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../src/credentials.mjs';
import { writeJson } from '../src/store.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('Manager state transition timed out.');
}
function syntheticAuth(plan) {
  const token = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url')}.signature`;
  return { auth_mode: 'chatgpt', tokens: { access_token: token, account_id: `synthetic-${plan}` } };
}

test('isolated manager restores normalized config on account change and reports rollback conflicts honestly', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'codex-relay-manager-test-'));
  const home = join(fixture, 'home'), state = join(fixture, 'state');
  await mkdir(home); await mkdir(state);
  const authPath = join(home, 'auth.json'), configPath = join(home, 'config.toml');
  const original = '# isolated fixture\r\nmodel = "fixture-only"\r\n';
  const pro = syntheticAuth('prolite'), team = syntheticAuth('team');
  await writeJson(authPath, pro); await writeFile(configPath, original);
  await writeJson(join(state, 'settings.json'), { mode: 'auto' });
  const source = fileURLToPath(new URL('../src/', import.meta.url));
  const protocol = fingerprint(Buffer.concat(await Promise.all(['relay.mjs', 'management.mjs', 'credentials.mjs', 'store.mjs', 'config.mjs', 'manager.mjs', 'usage.mjs', 'resets.mjs', 'account-rpc.mjs', '../scripts/probe.mjs'].map(file => readFile(join(source, file))))));
  const engineInfo = await stat(process.execPath);
  const signature = fingerprint(`${process.execPath}|${engineInfo.size}|${engineInfo.mtimeMs}|${protocol}`);
  // This fixture tests manager transitions only. It never sends a model request.
  await writeJson(join(state, 'compatibility.json'), { signature, result: 'passed', checkedAt: new Date().toISOString() });
  const holder = net.createServer(); await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port; await new Promise(resolve => holder.close(resolve));
  const child = spawn(process.execPath, [join(source, 'manager.mjs')], { env: { ...process.env, CODEX_HOME: home, CODEX_RELAY_HOME: state, CODEX_RELAY_PORT: String(port), CODEX_RELAY_CODEX: process.execPath, CODEX_RELAY_USAGE: '0' }, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await waitUntil(() => child.exitCode !== null).catch(() => {});
    await rm(fixture, { recursive: true, force: true });
  });
  const status = async () => { try { return JSON.parse(await readFile(join(state, 'manager-status.json'), 'utf8')); } catch { return {}; } };
  const command = async mode => writeJson(join(state, 'commands', `${randomUUID()}.json`), { action: 'mode', mode });
  const started = await waitUntil(async () => { const s = await status(); return s.compatibility === 'passed' && s.configActive && s.desktopReady && s; });
  assert.equal(started.pid, child.pid);
  const enabled = await readFile(configPath, 'utf8');
  const edited = enabled.replaceAll('\r\n', '\n') + '# later user edit\n';
  await writeFile(configPath, edited);
  await writeJson(authPath, team);
  const changed = await waitUntil(async () => { const s = await status(); return s.desktopReady === false && s.configActive === false && s; });
  assert.equal(changed.configError, false);
  assert.equal(changed.attention, 'desktop-login');
  const restored = original.replaceAll('\r\n', '\n') + '# later user edit\n';
  assert.equal(await readFile(configPath, 'utf8'), restored);
  const headers = { authorization: `Bearer ${team.tokens.access_token}`, 'chatgpt-account-id': team.tokens.account_id };
  const rejected = await fetch(`http://127.0.0.1:${port}/relay/health`, { headers });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.type, 'relay_desktop_pro_required');
  await command('off');
  await waitUntil(async () => (await status()).mode === 'off');
  const passThrough = await fetch(`http://127.0.0.1:${port}/relay/health`, { headers });
  assert.equal(passThrough.status, 200); await passThrough.text();
  await writeJson(authPath, pro);
  await waitUntil(async () => (await status()).desktopReady === true);
  await command('auto');
  await waitUntil(async () => (await status()).configActive === true);
  const owned = await readFile(configPath, 'utf8');
  const conflicting = owned.replace(`http://127.0.0.1:${port}/backend-api/codex`, 'http://127.0.0.1:65530/backend-api/codex');
  await writeFile(configPath, conflicting);
  await command('off');
  const conflict = await waitUntil(async () => { const s = await status(); return s.mode === 'off' && s.configError && s; });
  assert.equal(conflict.configActive, true);
  assert.equal(conflict.label, '기본 연결 복구 실패');
  assert.equal(conflict.attention, 'configuration');
  assert.equal(await readFile(configPath, 'utf8'), conflicting);
  await writeFile(configPath, owned);
  await command('off');
  await waitUntil(async () => { const s = await status(); return s.mode === 'off' && !s.configActive && !s.configError; });
  assert.equal(await readFile(configPath, 'utf8'), restored);
  await writeJson(join(state, 'commands', `${randomUUID()}.json`), { action: 'quit' });
  await waitUntil(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
  assert.equal(await readFile(configPath, 'utf8'), restored);
});
