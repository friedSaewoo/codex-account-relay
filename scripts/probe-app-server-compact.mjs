import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { desktopHome, stateHome, readDesktopAuth, fingerprint, findCodex, probeAuthSnapshot } from '../src/credentials.mjs';
import { writeJson } from '../src/store.mjs';

// Exercise the installed engine's actual compaction protocol, not the legacy unary API.
const beforeAuth = await readFile(join(desktopHome, 'auth.json'));
const beforeConfig = await readFile(join(desktopHome, 'config.toml'));
const status = JSON.parse(await readFile(join(stateHome, 'manager-status.json'), 'utf8'));
if (status.mode !== 'auto' || status.compatibility !== 'passed' || !status.configActive || status.businessBlocked) throw new Error('Requires verified Business-first mode.');
const root = join(stateHome, 'probes');
await mkdir(root, { recursive: true });
const isolated = await mkdtemp(join(root, 'compact-'));
const marker = `COMPACT_${randomBytes(6).toString('hex')}`;
const report = { at: new Date().toISOString(), model: 'gpt-6-astra', throughInstalledRelay: true, tests: [] };
let child, phase = 'initialize', sequence = 0, nextId = 1;
const requests = new Map(), notifications = [], waiters = new Set();
function waitFor(predicate, since, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    const found = notifications.find(event => event.seq > since && predicate(event.message));
    if (found) return resolve(found.message);
    const waiter = { predicate, since, resolve: value => { clearTimeout(waiter.timer); waiters.delete(waiter); resolve(value); } };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Notification timeout.')); }, timeoutMs);
    waiters.add(waiter);
  });
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('RPC timeout.')); }, 30000);
    requests.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function completedTurn(threadId, method, params) {
  const since = sequence, started = Date.now();
  await request(method, params);
  const result = await waitFor(event => event.method === 'turn/completed' && event.params?.threadId === threadId, since);
  const items = notifications.filter(event => event.seq > since && event.message.method === 'item/completed').map(event => event.message.params?.item).filter(Boolean);
  return { result, items, elapsedMs: Date.now() - started };
}
try {
  await writeFile(join(isolated, 'auth.json'), JSON.stringify(probeAuthSnapshot(await readDesktopAuth())), { flag: 'wx' });
  child = spawn(await findCodex(), ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"', '-c', `openai_base_url="http://127.0.0.1:${status.port}/backend-api/codex"`, '-c', 'model_reasoning_effort="low"'], { env: { ...process.env, CODEX_HOME: isolated }, cwd: isolated, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && requests.has(message.id)) {
      const pending = requests.get(message.id); requests.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error('App-server RPC failed.'), { code: message.error.code }));
      else pending.resolve(message.result);
    } else if (message.id != null && message.method) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Probe does not execute tools or approvals.' } }) + '\n');
    } else {
      notifications.push({ seq: ++sequence, message });
      for (const waiter of waiters) if (sequence > waiter.since && waiter.predicate(message)) waiter.resolve(message);
    }
  });
  await request('initialize', { clientInfo: { name: 'codex_relay_probe', version: '0.3.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  phase = 'thread';
  const started = await request('thread/start', { model: report.model, cwd: isolated, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, baseInstructions: 'This is a protocol test. Remember test codes and answer briefly. Do not use tools, read files or access the network.' });
  const threadId = started.thread.id;
  phase = 'first_response';
  const first = await completedTurn(threadId, 'turn/start', { threadId, input: [{ type: 'text', text: `Remember this exact code: ${marker}. Reply only READY.` }] });
  report.tests.push({ name: phase, status: first.result.params.turn.status, elapsedMs: first.elapsedMs });
  if (first.result.params.turn.status !== 'completed') throw new Error('Initial turn failed.');
  phase = 'compaction';
  const compact = await completedTurn(threadId, 'thread/compact/start', { threadId });
  report.tests.push({ name: phase, status: compact.result.params.turn.status, elapsedMs: compact.elapsedMs, compactionItemCompleted: compact.items.some(item => item.type === 'contextCompaction') });
  if (compact.result.params.turn.status !== 'completed') throw new Error('Compaction failed.');
  phase = 'resume';
  const resumed = await completedTurn(threadId, 'turn/start', { threadId, input: [{ type: 'text', text: 'What was the exact code? Reply only with that code.' }] });
  report.tests.push({ name: phase, status: resumed.result.params.turn.status, elapsedMs: resumed.elapsedMs, markerRetained: resumed.items.some(item => item.type === 'agentMessage' && item.text?.includes(marker)) });
} catch (error) {
  report.error = { phase, name: error.name, ...(error.code != null ? { code: error.code } : {}) };
} finally {
  if (child && child.exitCode == null) { child.kill(); await new Promise(resolve => { if (child.exitCode != null) resolve(); else { child.once('close', resolve); setTimeout(resolve, 3000).unref(); } }); }
  for (const pending of requests.values()) pending.reject(new Error('Probe ended.'));
  for (const waiter of waiters) clearTimeout(waiter.timer);
  if (dirname(isolated) === root) await rm(isolated, { recursive: true, force: true });
  report.desktopAuthUnchanged = fingerprint(beforeAuth) === fingerprint(await readFile(join(desktopHome, 'auth.json')));
  report.desktopConfigUnchanged = fingerprint(beforeConfig) === fingerprint(await readFile(join(desktopHome, 'config.toml')));
  report.passed = report.tests.length === 3 && report.tests.every(test => test.status === 'completed') && report.tests[1].compactionItemCompleted && report.tests[2].markerRetained && report.desktopAuthUnchanged && report.desktopConfigUnchanged;
  await writeJson(new URL('../reports/live-app-server-astra-compact.json', import.meta.url), report);
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
