import { readFile, writeFile, mkdir, rename, rm, mkdtemp, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const desktopHome = process.env.CODEX_HOME || join(homedir(), '.codex');
// USERPROFILE avoids Microsoft Store AppData virtualization and remains usable at Windows logon.
export const stateHome = process.env.CODEX_RELAY_HOME || join(homedir(), '.codex-account-relay');
const dpapiScript = fileURLToPath(new URL('../scripts/dpapi.ps1', import.meta.url));
export const fingerprint = x => createHash('sha256').update(x).digest('hex');

export function decodeClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { return {}; }
}
export function parseAuth(raw) {
  const auth = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const t = auth.tokens;
  if (auth.auth_mode !== 'chatgpt' || !t?.access_token || !t?.account_id) throw new Error('ChatGPT OAuth credentials required.');
  const claims = decodeClaims(t.access_token);
  const idClaims = decodeClaims(t.id_token || '');
  const meta = claims['https://api.openai.com/auth'] || idClaims['https://api.openai.com/auth'] || {};
  return { raw: auth, token: t.access_token, accountId: t.account_id, plan: meta.chatgpt_plan_type || 'unknown', expires: claims.exp || 0 };
}
export async function readDesktopAuth(home = desktopHome) {
  return parseAuth(await readFile(join(home, 'auth.json'), 'utf8'));
}
export function isPro(auth) { return /^pro/i.test(auth.plan); }
export function isBusiness(auth) { return /^(business|team|enterprise)$/i.test(auth.plan); }

export function probeAuthSnapshot(auth, now = Date.now()) {
  if (!isPro(auth)) throw new Error('Compatibility probe requires the desktop Pro workspace.');
  if (auth.expires * 1000 <= now + 10 * 60000) throw new Error('Desktop access token is too close to expiry for an isolated probe.');
  // Test clients may use the current access token but must never rotate the desktop refresh token.
  return { ...auth.raw, last_refresh: new Date(now).toISOString(), tokens: { ...auth.raw.tokens, refresh_token: '' } };
}

function run(program, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    // Windows PowerShell must not inherit PowerShell 7's incompatible module path.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    const child = spawn(program, args, { windowsHide: true, ...options, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.resume(); // Never propagate credential-bearing subprocess output.
    child.on('error', () => reject(new Error('Credential helper could not start.')));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Credential helper failed.')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true });
  if (process.platform !== 'win32') throw new Error('This credential store requires Windows DPAPI.');
  const script = "$ErrorActionPreference='Stop'; $p=$env:RELAY_PRIVATE_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.IO.Directory]::GetAccessControl($p,[System.Security.AccessControl.AccessControlSections]::Access); $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($r)}; $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$acl)";
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], '', { env: { ...process.env, RELAY_PRIVATE_DIR: path } });
}
export async function crypt(mode, input) {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI required.');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', dpapiScript, '-Mode', mode], Buffer.from(input).toString('base64'));
  return Buffer.from(result.toString().trim(), 'base64');
}
export async function saveBusiness(auth, home = stateHome) {
  if (!isBusiness(auth)) throw new Error('Selected account is not a Business/team/Enterprise workspace. Select the Business workspace during login.');
  await privateDirectory(home);
  const path = join(home, 'business.dpapi');
  const encrypted = await crypt('protect', Buffer.from(JSON.stringify(auth.raw)));
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, encrypted, { flag: 'wx' });
  await rename(temp, path);
}
export async function readBusiness(home = stateHome) {
  try {
    const blob = await readFile(join(home, 'business.dpapi'));
    return parseAuth((await crypt('unprotect', blob)).toString());
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function findCodex() {
  if (process.env.CODEX_RELAY_CODEX) return process.env.CODEX_RELAY_CODEX;
  const install = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'], '')).toString().trim();
  if (!install) throw new Error('Set CODEX_RELAY_CODEX to your Codex desktop bundled codex.exe path.');
  return join(install, 'app', 'resources', 'codex.exe');
}

export async function loginBusiness({ device = false } = {}) {
  const before = await readFile(join(desktopHome, 'auth.json'));
  const desktop = parseAuth(before.toString());
  if (!isPro(desktop)) throw new Error('Desktop must remain signed in to Pro.');
  await privateDirectory(stateHome);
  const isolated = await mkdtemp(join(stateHome, 'login-'));
  try {
    const executable = await findCodex();
    console.log('Business login uses a separate CODEX_HOME. Choose your Business workspace in the browser.');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['login', ...(device ? ['--device-auth'] : []), '-c', 'cli_auth_credentials_store="file"'], {
        env: { ...process.env, CODEX_HOME: isolated }, stdio: 'inherit', windowsHide: true,
      });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (result !== 0) throw new Error('Business login did not complete.');
    const business = await readDesktopAuth(isolated);
    if (business.accountId === desktop.accountId) throw new Error('The selected workspace is the current Pro workspace. Please choose Business.');
    await saveBusiness(business);
    console.log(JSON.stringify({ businessSaved: true, plan: business.plan, desktopAuthUnchanged: fingerprint(before) === fingerprint(await readFile(join(desktopHome, 'auth.json'))) }));
  } finally {
    // mkdtemp created this exact child directory; never remove the parent or the real CODEX_HOME.
    if (dirname(isolated) === stateHome) await rm(isolated, { recursive: true, force: true });
  }
}
