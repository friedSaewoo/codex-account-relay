import { readFile, mkdir, readdir, rm, stat, appendFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRelay } from './relay.mjs';
import { desktopHome, stateHome, privateDirectory, readDesktopAuth, readBusiness, isPro, findCodex, fingerprint, loginBusiness } from './credentials.mjs';
import { businessProvider, readJson, writeJson, quotaPath } from './store.mjs';
import { enableConfig, disableConfig, removeConfig } from './config.mjs';
import { validSettings, businessAllowed, compatibilityPassed, needsCompatibilityCheck, compatibilityRetryDelay, userStatus } from './management.mjs';
import { usageReader } from './usage.mjs';
import { resetManager } from './resets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const statusPath = join(stateHome, 'manager-status.json');
const settingsPath = join(stateHome, 'settings.json');
const compatibilityPath = join(stateHome, 'compatibility.json');
const commandsPath = join(stateHome, 'commands');
const port = Number(process.env.CODEX_RELAY_PORT || 19565);
const protocolSignature = fingerprint(Buffer.concat(await Promise.all(['relay.mjs', 'management.mjs', 'credentials.mjs', 'store.mjs', 'config.mjs', 'manager.mjs', 'usage.mjs', 'resets.mjs', 'account-rpc.mjs', '../scripts/probe.mjs'].map(f => readFile(new URL(f, import.meta.url))))));
let settings, compatibility = 'checking', cachedCompatibility, configActive = false, configError = false, desktopReady = false;
let businessRetryAt = 0, needsLogin = false, loginInProgress = false, shuttingDown = false;
let checkedAt = 0, lastEngine = null, checkInProgress = false, tickInProgress = false;
let auditQueue = Promise.resolve();
let usage = { pro: null, business: null }, usagePending = null, usageNextAt = 0;
const readProUsage = usageReader({ role: 'pro', getCredential: readDesktopAuth });
const readBusinessUsage = usageReader({ role: 'business', getCredential: () => provider() });
const resets = {
  pro: resetManager({ role: 'pro', getCredential: readDesktopAuth }),
  business: resetManager({ role: 'business', getCredential: () => provider() }),
};
async function refreshUsage(force = false) {
  if (process.env.CODEX_RELAY_USAGE === '0' || (!force && Date.now() < usageNextAt)) return;
  if (usagePending) return usagePending;
  usageNextAt = Date.now() + 300000;
  usagePending = (async () => {
    const results = await Promise.all([readProUsage(force), readBusinessUsage(force), resets.pro.read(force), resets.business.read(force)]);
    usage = { pro: results[0], business: results[1] };
    if (!shuttingDown && desktopReady && businessAllowed({ mode: settings.mode, compatibility, businessRetryAt, loginInProgress })) {
      try { await relay.resumeBusinessFromUsage(usage.business); }
      catch { audit({ event: 'business_quota_recovery_check_failed' }); }
    }
    if (!shuttingDown) await publish();
  })();
  try { await usagePending; } catch { audit({ event: 'usage_refresh_failed' }); } finally { usagePending = null; }
}
const provider = businessProvider();
const auditPath = join(stateHome, 'audit.jsonl');
function audit(entry) {
  if (entry.event === 'business_auth_fallback') { needsLogin = true; businessRetryAt = Date.now() + 15 * 60000; provider.invalidate(); }
  auditQueue = auditQueue.then(async () => {
    try { if ((await stat(auditPath)).size > 2 * 1024 * 1024) { await rm(`${auditPath}.1`, { force: true }); await rename(auditPath, `${auditPath}.1`); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await appendFile(auditPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }).catch(() => {});
}
function childRun(executable, args, timeoutMs = 360000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => {
      // Only this directly spawned test process tree is terminated.
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
}
async function managedConfigPresent() {
  const current = await readFile(join(desktopHome, 'config.toml'));
  if (!current.toString().includes('# CodexAccountRelay compatibility prototype')) return false;
  const receipt = await readJson(join(stateHome, 'config-receipt.json'));
  if (!receipt || receipt.port !== port) throw new Error('Managed configuration differs.');
  removeConfig(current, receipt); // Validate ownership before changing anything.
  return true;
}
async function reconcileConfig() {
  try {
    configError = false;
    configActive = await managedConfigPresent();
    if (settings.mode !== 'off' && compatibility === 'passed' && desktopReady) {
      if (!configActive) { await enableConfig(port); configActive = true; audit({ event: 'config_enabled' }); }
    } else if (configActive && (compatibility !== 'checking' || !desktopReady)) {
      await disableConfig(); configActive = false; audit({ event: 'config_restored' });
    } else if (settings.mode === 'off' && configActive) {
      await disableConfig(); configActive = false;
    }
  } catch {
    configError = true;
    try { configActive = (await readFile(join(desktopHome, 'config.toml'), 'utf8')).includes('# CodexAccountRelay compatibility prototype'); } catch { configActive = null; }
    audit({ event: 'config_conflict' });
  }
}
async function checkCompatibility(force = false) {
  if (checkInProgress || loginInProgress || settings.mode === 'off' || !desktopReady) return;
  checkInProgress = true;
  let signature;
  try {
    const executable = await findCodex();
    const info = await stat(executable);
    signature = fingerprint(`${executable}|${info.size}|${info.mtimeMs}|${protocolSignature}`);
    lastEngine = { path: executable, signature };
    if (!force && !needsCompatibilityCheck(cachedCompatibility, signature)) {
      compatibility = cachedCompatibility.result;
      return;
    }
    compatibility = 'checking';
    await publish();
    audit({ event: 'compatibility_started' });
    const started = Date.now();
    const exit = await childRun(process.execPath, [join(root, 'scripts', 'probe.mjs'), 'cli']);
    const report = await readJson(join(root, 'reports', 'live-cli.json'));
    const fresh = report && Date.parse(report.at) >= started - 1000;
    compatibility = exit === 0 && fresh && compatibilityPassed(report) ? 'passed' : 'failed';
    const failures = compatibility === 'passed' ? 0 : cachedCompatibility?.signature === signature ? (cachedCompatibility.failures || 0) + 1 : 1;
    cachedCompatibility = { signature, result: compatibility, failures, checkedAt: new Date().toISOString(), retryAt: compatibility === 'passed' ? null : Date.now() + compatibilityRetryDelay(failures) };
    await writeJson(compatibilityPath, cachedCompatibility);
    audit({ event: `compatibility_${compatibility}` });
  } catch {
    compatibility = 'failed';
    // Throttle discovery/auth/network failures too, not just a completed failed probe.
    checkedAt = Date.now();
    if (signature) {
      const failures = cachedCompatibility?.signature === signature ? (cachedCompatibility.failures || 0) + 1 : 1;
      cachedCompatibility = { signature, result: 'failed', failures, checkedAt: new Date().toISOString(), retryAt: Date.now() + compatibilityRetryDelay(failures) };
      try { await writeJson(compatibilityPath, cachedCompatibility); } catch { }
    }
    audit({ event: 'compatibility_unavailable' });
  } finally {
    checkInProgress = false;
    if (!shuttingDown) { await reconcileConfig(); await publish(); }
  }
}
const relay = createRelay({
  getPro: async () => {
    let pro;
    try { pro = await readDesktopAuth(); }
    catch { throw Object.assign(new Error('Desktop login unavailable.'), { code: 'DESKTOP_AUTH_UNAVAILABLE' }); }
    if (settings.mode === 'auto' && !isPro(pro)) throw Object.assign(new Error('Desktop Pro login required.'), { code: 'DESKTOP_PRO_REQUIRED' });
    // A loaded client still using the relay after rollback may pass through its own current account.
    return pro;
  },
  getBusiness: async () => {
    if (!businessAllowed({ mode: settings.mode, compatibility, businessRetryAt, loginInProgress })) return null;
    const business = await provider();
    if (!business) throw new Error('Business login required.');
    needsLogin = false; businessRetryAt = 0;
    return business;
  },
  audit, initialQuota: await readJson(quotaPath), persistQuota: q => writeJson(quotaPath, q),
  fallbackOnBusinessAuthError: true, unknownQuotaRetryMs: 15 * 60000, passThroughCodexRoutes: true,
});
async function publish() {
  const runtime = relay.getStatus();
  const display = userStatus({ mode: settings.mode, compatibility, configActive, configError, desktopReady, needsLogin, loginInProgress, ...runtime, lastRoute: runtime.lastModelRoute });
  await writeJson(statusPath, { pid: process.pid, port, updated: new Date().toISOString(), mode: settings.mode, compatibility, compatibilityCheckedAt: cachedCompatibility?.checkedAt || null, configActive, configError, desktopReady, needsLogin, loginInProgress, shuttingDown, usage, resetCredits: { pro: resets.pro.status(), business: resets.business.status() }, usageRefreshing: !!usagePending, ...display, ...runtime });
  await writeJson(join(stateHome, 'status.json'), { pid: process.pid, port, updated: new Date().toISOString(), managed: true, ...runtime });
}
async function startLogin() {
  if (loginInProgress || checkInProgress) return;
  loginInProgress = true; await publish();
  try {
    await loginBusiness(); provider.invalidate(); needsLogin = false; businessRetryAt = 0;
    await relay.resetQuota();
    cachedCompatibility = null;
    audit({ event: 'business_login_completed' });
  } catch { needsLogin = true; businessRetryAt = Date.now() + 15 * 60000; audit({ event: 'business_login_incomplete' }); }
  finally { loginInProgress = false; await publish(); }
}
async function consumeCommands() {
  for (const file of await readdir(commandsPath)) {
    if (!/^[a-f0-9-]+\.json$/i.test(file)) continue;
    const path = join(commandsPath, file);
    let command;
    try { command = await readJson(path); } catch { continue; }
    await rm(path, { force: true });
    if (command.action === 'mode' && ['auto', 'pro', 'off'].includes(command.mode)) {
      settings = validSettings({ mode: command.mode }); await writeJson(settingsPath, settings);
      if (settings.mode === 'auto') { businessRetryAt = 0; provider.invalidate(); }
      await reconcileConfig();
      if (settings.mode !== 'off') void checkCompatibility();
    } else if (command.action === 'check') {
      void checkCompatibility(true);
    } else if (command.action === 'login') {
      void startLogin();
    } else if (command.action === 'usage') {
      void refreshUsage(true);
    } else if (command.action === 'reset' && command.confirmed === true && ['business', 'pro'].includes(command.role) && /^[a-f0-9]{64}$/.test(command.accountKey || '')) {
      void (async () => {
        const result = await resets[command.role].consume(command.accountKey);
        if (['reset', 'alreadyRedeemed'].includes(result.outcome)) {
          if (command.role === 'business') { await relay.resetQuota(); businessRetryAt = 0; provider.invalidate(); }
          if (usagePending) await usagePending;
          readProUsage.invalidate(); readBusinessUsage.invalidate();
          await refreshUsage(true);
        }
        await publish();
      })().catch(() => audit({ event: 'reset_result_publish_failed' }));
    } else if (command.action === 'quit') {
      await shutdown(); return;
    }
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(timer);
  await publish();
  // Keep the tray heartbeat alive while accepted streams finish; never truncate a model response.
  const drainHeartbeat = setInterval(() => { void publish().catch(() => audit({ event: 'drain_status_write_failed' })); }, 2000);
  try { await relay.close({ force: false }); }
  finally { clearInterval(drainHeartbeat); }
  settings.mode = 'off'; await reconcileConfig(); await auditQueue;
  await rm(join(stateHome, 'status.json'), { force: true });
  await writeJson(statusPath, { pid: process.pid, updated: new Date().toISOString(), stopped: true, label: '종료됨', detail: '기본 연결 설정으로 복구했습니다.' });
  process.exit(0);
}
await privateDirectory(stateHome);
await mkdir(commandsPath, { recursive: true });
settings = validSettings(await readJson(settingsPath));
await writeJson(settingsPath, settings);
cachedCompatibility = await readJson(compatibilityPath);
try { desktopReady = isPro(await readDesktopAuth()); } catch { desktopReady = false; }
await relay.listen(port);
const timer = setInterval(async () => {
  if (tickInProgress || shuttingDown) return;
  tickInProgress = true;
  try {
    let ready;
    try { ready = isPro(await readDesktopAuth()); } catch { ready = false; }
    if (ready !== desktopReady) { desktopReady = ready; await reconcileConfig(); }
    await consumeCommands();
    if (Date.now() - checkedAt > 120000 && !checkInProgress && !loginInProgress) {
      checkedAt = Date.now(); void checkCompatibility();
    }
    await publish();
    void refreshUsage();
  } catch { audit({ event: 'manager_tick_failed' }); }
  finally { tickInProgress = false; }
}, 2000);
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await reconcileConfig();
await publish();
checkedAt = Date.now();
void checkCompatibility();
void refreshUsage();
