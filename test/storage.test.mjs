import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { crypt, privateDirectory, probeAuthSnapshot } from '../src/credentials.mjs';
import { writeJson, readJson } from '../src/store.mjs';
import { enableConfig, disableConfig } from '../src/config.mjs';

async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'codex-relay-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test('DPAPI encrypts credentials and decrypts only through the Windows helper', { skip: process.platform !== 'win32' }, async t => {
  const path = await temp(t); await privateDirectory(path);
  const plaintext = Buffer.from('synthetic-test-credential-not-a-real-token');
  const encrypted = await crypt('protect', plaintext);
  assert(!encrypted.includes(plaintext));
  assert.deepEqual(await crypt('unprotect', encrypted), plaintext);
});
test('JSON file URL and concurrent atomic quota writes produce complete valid data', async t => {
  const root = await temp(t), path = join(root, 'state.json');
  await Promise.all(Array.from({ length: 20 }, (_, index) => writeJson(pathToFileURL(path), { index })));
  const result = await readJson(path); assert.equal(typeof result.index, 'number');
});
test('real filesystem activation backs up exact config and rollback preserves later user edits', async t => {
  const root = await temp(t), home = join(root, 'home'), state = join(root, 'state');
  await mkdir(home); await mkdir(state);
  const original = Buffer.from('# original\r\nmodel = "test"\r\n[features]\r\nx = true\r\n');
  const path = join(home, 'config.toml'); await writeFile(path, original);
  const enabled = await enableConfig(19565, home, state);
  assert.deepEqual(await readFile(enabled.backup), original);
  const changed = Buffer.concat([await readFile(path), Buffer.from('# later edit\r\n')]);
  await writeFile(path, changed);
  const disabled = await disableConfig(home, state);
  assert.equal(disabled.originalBytesRestored, false);
  assert.deepEqual(await readFile(path), Buffer.concat([original, Buffer.from('# later edit\r\n')]));
});

test('rollback tolerates editor newline normalization while preserving later edits', async t => {
  const root = await temp(t), home = join(root, 'home'), state = join(root, 'state');
  await mkdir(home); await mkdir(state);
  const path = join(home, 'config.toml');
  await writeFile(path, '# original\r\nmodel = "test"\r\n');
  await enableConfig(19565, home, state);
  const edited = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n') + '# later edit\n';
  await writeFile(path, edited);
  await disableConfig(home, state);
  assert.equal(await readFile(path, 'utf8'), '# original\nmodel = "test"\n# later edit\n');
});

test('isolated probes cannot rotate desktop refresh credentials or accept Business as Pro', () => {
  const now = Date.now();
  const auth = { plan: 'prolite', expires: Math.floor(now / 1000) + 3600, raw: { tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } } };
  const snapshot = probeAuthSnapshot(auth, now);
  assert.equal(snapshot.tokens.refresh_token, '');
  assert.equal(auth.raw.tokens.refresh_token, 'synthetic-refresh');
  assert.equal(snapshot.tokens.access_token, auth.raw.tokens.access_token);
  assert.throws(() => probeAuthSnapshot({ ...auth, plan: 'team' }, now), /Pro workspace/);
  assert.throws(() => probeAuthSnapshot({ ...auth, expires: Math.floor(now / 1000) + 60 }, now), /expiry/);
});
