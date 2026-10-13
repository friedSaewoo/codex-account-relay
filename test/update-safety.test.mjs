import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const run = promisify(execFile);

test('installer guard rejects busy, stale and unverifiable state before shutdown', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'relay-update-guard-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const script = join(fixture, 'guard.ps1'), status = join(fixture, 'status.json');
  const helper = fileURLToPath(new URL('../scripts/update-safety.ps1', import.meta.url));
  await writeFile(script, `param([string]$Helper,[string]$Status)\n$ErrorActionPreference='Stop'\n. $Helper\ntry { Assert-RelayIdle $Status; Write-Output 'allowed' } catch { Write-Output 'deferred' }\n`);
  const verify = async (value, expected) => {
    if (value !== null) await writeFile(status, JSON.stringify(value));
    else await rm(status, { force: true });
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Helper', helper, '-Status', status], { windowsHide: true });
    assert.equal(result.stdout.trim(), expected);
  };
  await verify({ modelInFlight: 1, updated: new Date().toISOString() }, 'deferred');
  await verify({ modelInFlight: 0, updated: new Date(Date.now() - 60000).toISOString() }, 'deferred');
  await verify({ updated: new Date().toISOString() }, 'deferred');
  await verify({ modelInFlight: 0, updated: new Date().toISOString(), shuttingDown: true }, 'deferred');
  await verify({ modelInFlight: 0, updated: new Date().toISOString(), resetCredits: { business: { busy: true } } }, 'deferred');
  await verify({ modelInFlight: 0, updated: new Date().toISOString(), loginInProgress: true }, 'deferred');
  await verify(null, 'deferred');
  await verify({ modelInFlight: 0, updated: new Date().toISOString() }, 'allowed');
});
