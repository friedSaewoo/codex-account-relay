import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
test('watchdog does not kill a healthy long-running manager after one missed status read', {skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-watchdog-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const output=join(root,'WatchdogCheck.exe');
  const source=fileURLToPath(new URL('./watchdog-check.cs',import.meta.url));
  const app=fileURLToPath(new URL('../CodexAccountRelay.exe',import.meta.url));
  const compiler=join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  await run(compiler,['/nologo','/target:exe','/out:'+output,source],{windowsHide:true});
  const result=await run(output,[app],{windowsHide:true}); assert.match(result.stdout,/tolerates transient reads/);
});
