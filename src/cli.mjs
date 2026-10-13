import { appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readDesktopAuth, readBusiness, isPro, privateDirectory, stateHome, loginBusiness } from './credentials.mjs';
import { businessProvider, readJson, writeJson, quotaPath } from './store.mjs';
import { createRelay } from './relay.mjs';
import { enableConfig, disableConfig } from './config.mjs';

const [command = 'status', option] = process.argv.slice(2);
const statusPath = join(stateHome, 'status.json');
let auditQueue = Promise.resolve();
const audit = entry => { auditQueue = auditQueue.then(() => appendFile(join(stateHome, 'audit.jsonl'), JSON.stringify(entry) + '\n')).catch(() => {}); };
async function main() {
  if (command === 'login-business') return loginBusiness({ device: option === '--device' });
  if (command === 'status') {
    const pro = await readDesktopAuth();
    const business = await readBusiness();
    const runtime = await readJson(statusPath);
    console.log(JSON.stringify({ desktopPlan: pro.plan, businessConfigured: !!business, businessPlan: business?.plan || null, runtime, stateHome }, null, 2));
    return;
  }
  if (command === 'disable') return console.log(JSON.stringify(await disableConfig()));
  if (command === 'enable') {
    const state = await readJson(statusPath);
    if (!state || Date.now() - Date.parse(state.updated) > 10000) throw new Error('Start the relay before activation.');
    // A real authenticated health probe protects against stale PID/status data.
    const pro = await readDesktopAuth();
    const health = await fetch(`http://127.0.0.1:${state.port}/backend-api/codex/models?client_version=0.162.0`, { headers: { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId }, signal: AbortSignal.timeout(15000) });
    await health.arrayBuffer();
    if (!health.ok) throw new Error('Relay model-list health probe failed.');
    return console.log(JSON.stringify(await enableConfig(state.port)));
  }
  if (command !== 'serve') throw new Error('Commands: status, login-business [--device], serve [port], enable, disable');
  await privateDirectory(stateHome);
  const pro = await readDesktopAuth();
  if (!isPro(pro)) throw new Error('Keep the desktop signed into Pro.');
  const port = Number(option || 19565);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
  const relay = createRelay({
    getPro: async () => { const a = await readDesktopAuth(); if (!isPro(a)) throw new Error('Desktop Pro account changed.'); return a; },
    getBusiness: businessProvider(), audit,
    initialQuota: await readJson(quotaPath), persistQuota: q => writeJson(quotaPath, q),
  });
  await relay.listen(port);
  const update = () => writeJson(statusPath, { pid: process.pid, port, updated: new Date().toISOString(), ...relay.getStatus() });
  await update();
  const timer = setInterval(() => update().catch(() => {}), 3000);
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, pid: process.pid, businessFirst: true }));
  const stop = async () => { clearInterval(timer); await relay.close(); await auditQueue; await rm(statusPath, { force: true }); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
