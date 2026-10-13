import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopHome, stateHome, fingerprint } from './credentials.mjs';
import { readJson, writeJson } from './store.mjs';

const MARK = '# CodexAccountRelay compatibility prototype';
export function addConfig(original, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid relay port.');
  const text = original.toString('utf8');
  if (text.includes(MARK)) throw new Error('Relay configuration already installed.');
  const active = text.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
  if (/\bopenai_base_url\b/.test(active)) throw new Error('An existing openai_base_url needs manual review.');
  if (/^\s*model_provider\s*=\s*["'](?!openai["'])/m.test(active) || /^\s*\[model_providers\.openai\]/m.test(active)) throw new Error('Custom model provider configuration needs manual review.');
  const prefix = Buffer.from(`${MARK}\r\nopenai_base_url = "http://127.0.0.1:${port}/backend-api/codex"\r\n# End CodexAccountRelay\r\n\r\n`);
  const bom = original.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  return { patched: Buffer.concat([bom ? original.subarray(0, 3) : Buffer.alloc(0), prefix, bom ? original.subarray(3) : original]), prefix: prefix.toString(), bom };
}
export function removeConfig(current, receipt) {
  const text = current.toString('utf8');
  // Editors may normalize CRLF to LF without changing the owned settings.
  // Match only the exact owned lines; preserve all remaining bytes and edits.
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const content = text.slice(bom.length);
  const escaped = receipt.prefix.split(/\r?\n/).map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n');
  const match = new RegExp(`^${escaped}`).exec(content);
  if (!match) throw new Error('Managed config block changed. Refusing to overwrite user edits.');
  return Buffer.from(bom + content.slice(match[0].length));
}
export async function enableConfig(port, home = desktopHome, state = stateHome) {
  const path = join(home, 'config.toml');
  const original = await readFile(path);
  const { patched, ...receipt } = addConfig(original, port);
  const backup = join(state, `config-before-${Date.now()}.toml`);
  await writeFile(backup, original, { flag: 'wx' });
  await writeJson(join(state, 'config-receipt.json'), { ...receipt, backup, originalHash: fingerprint(original), port, enabledAt: new Date().toISOString() });
  // Refuse a concurrent edit between initial read and commit.
  if (fingerprint(await readFile(path)) !== fingerprint(original)) throw new Error('Configuration changed during activation.');
  const temp = `${path}.relay-${process.pid}.tmp`;
  await writeFile(temp, patched, { flag: 'wx' });
  await rename(temp, path);
  return { enabled: true, port, backup };
}
export async function disableConfig(home = desktopHome, state = stateHome) {
  const path = join(home, 'config.toml');
  const receipt = await readJson(join(state, 'config-receipt.json'));
  if (!receipt) throw new Error('No activation receipt found.');
  const current = await readFile(path);
  const restored = removeConfig(current, receipt);
  const temp = `${path}.relay-${process.pid}.tmp`;
  await writeFile(temp, restored, { flag: 'wx' });
  if (fingerprint(await readFile(path)) !== fingerprint(current)) throw new Error('Configuration changed during rollback.');
  await rename(temp, path);
  return { disabled: true, originalBytesRestored: fingerprint(restored) === receipt.originalHash };
}
