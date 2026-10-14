import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createDiagnostics, safeError, retryFileOperation } from '../src/diagnostics.mjs';

test('diagnostics excludes messages, identities, arbitrary codes and raw stack paths', () => {
  const error = { code: 'SECRET_ACCOUNT', cause: { code: 'ECONNRESET' }, stack: 'Error: SECRET_TOKEN\n    at privateFunction (file:///C:/private/user/src/manager.mjs:12:3)\n    at tokenFunction (file:///C:/private/SECRET_TOKEN.mjs:1:2)\n    at fn (node:internal/process/task_queues:105:5)' };
  const result = safeError(error);
  assert.equal(result.errorCode, null); assert.equal(result.causeCode, 'ECONNRESET');
  assert.deepEqual(result.frames[0], { module: 'manager.mjs', line: 12, column: 3 });
  assert.equal(result.frames.length, 2);
  assert(!/SECRET|private|tokenFunction/.test(JSON.stringify(result)));
});

test('background rejection and synchronous throw are contained even when logging fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-diag-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'errors.jsonl'); const diag = createDiagnostics(path, () => ({ modelInFlight: 2, token: 'secret' }));
  await diag.run('compatibility', () => { throw Object.assign(new Error('private authentication'), { code: 'EPERM' }); });
  await diag.run('usage', () => Promise.reject(new Error('private response')));
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[0].errorCode, 'EPERM'); assert.equal(rows[0].modelInFlight, 2);
  assert.equal(rows[0].task, 'compatibility'); assert(!/secret|private authentication|private response/.test(JSON.stringify(rows)));
  await createDiagnostics(join(root, 'missing', 'errors')).run('login', () => Promise.reject(new Error('failure')));
});

for (const rejection of [false, true]) test(`fatal ${rejection ? 'rejection' : 'exception'} records metadata before the child exits`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-fatal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'errors.jsonl'), module = new URL('../src/diagnostics.mjs', import.meta.url).href;
  const failure = "Object.assign(new Error('SECRET_AUTH_PROMPT'), {code:'EPIPE'})";
  const script = `import {createDiagnostics} from ${JSON.stringify(module)}; createDiagnostics(process.argv[1],()=>({modelInFlight:3})).install(); ${rejection ? `Promise.reject(${failure});` : `setImmediate(() => { throw ${failure}; });`}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: 'ignore', windowsHide: true });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(exit, 1);
  const raw = await readFile(path, 'utf8'), row = JSON.parse(raw.trim());
  assert.equal(row.event, 'manager_fatal'); assert.equal(row.origin, rejection ? 'unhandledRejection' : 'uncaughtException');
  assert.equal(row.errorCode, 'EPIPE'); assert.equal(row.modelInFlight, 3); assert(!raw.includes('SECRET'));
});

test('transient Windows file locks retry briefly; permanent errors stop and remain visible', async () => {
  let attempts = 0; const waits = [];
  const result = await retryFileOperation(async () => { if (++attempts < 4) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return 'saved'; }, async ms => waits.push(ms));
  assert.equal(result, 'saved'); assert.equal(attempts, 4); assert.deepEqual(waits, [10, 25, 50]);
  attempts = 0;
  await assert.rejects(retryFileOperation(async () => { attempts++; throw Object.assign(new Error('full'), { code: 'ENOSPC' }); }, async () => {}), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(retryFileOperation(async () => { attempts++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, async () => {}), { code: 'EACCES' });
  assert.equal(attempts, 6);
});

test('diagnostic log rotation remains bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-log-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'errors.jsonl'); await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
  createDiagnostics(path).record('manager_fatal', Object.assign(new Error('secret'), { code: 'EIO' }));
  assert.equal(JSON.parse((await readFile(path, 'utf8')).trim()).errorCode, 'EIO');
  assert.equal((await readFile(`${path}.1`)).length, 2 * 1024 * 1024 + 1);
});
