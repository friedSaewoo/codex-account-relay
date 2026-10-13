import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { desktopHome, stateHome, readDesktopAuth, fingerprint, isPro } from '../src/credentials.mjs';
import { writeJson } from '../src/store.mjs';

// Test the running manager without changing account, app configuration or chat history.
const model = 'gpt-6-astra';
const authBefore = await readFile(join(desktopHome, 'auth.json'));
const configBefore = await readFile(join(desktopHome, 'config.toml'));
const pro = await readDesktopAuth();
const status = JSON.parse(await readFile(join(stateHome, 'manager-status.json'), 'utf8'));
if (!isPro(pro) || status.mode !== 'auto' || status.compatibility !== 'passed' || !status.configActive || status.businessBlocked) {
  throw new Error('Requires the installed, verified Business-first relay and unchanged Pro sign-in.');
}
const base = `http://127.0.0.1:${status.port}/backend-api/codex`;
const marker = `ASTRA_COMPACT_${randomBytes(6).toString('hex')}`;
const instructions = 'Remember the user test code. Follow the latest user instruction. Do not call tools.';
const headers = { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId, 'content-type': 'application/json', originator: 'Codex Desktop', version: '0.162.0' };
const report = { at: new Date().toISOString(), model, throughInstalledRelay: true, expectedRoute: 'business', tests: [] };
try {
  const started = Date.now();
  const compact = await fetch(`${base}/responses/compact`, {
    method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, instructions, input: [
      { role: 'user', content: [{ type: 'input_text', text: `Remember this exact code: ${marker}.` }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'I have remembered the code.' }] },
    ] }),
  });
  let compacted;
  try { compacted = await compact.json(); } catch { compacted = {}; }
  const output = Array.isArray(compacted.output) ? compacted.output : [];
  report.tests.push({ name: 'astra_compact', status: compact.status, elapsedMs: Date.now() - started, outputTypes: output.map(item => item.type), encryptedCompactionReturned: output.some(item => item.type === 'compaction' && typeof item.encrypted_content === 'string'), errorCode: typeof compacted.error?.code === 'string' ? compacted.error.code : null });
  if (compact.ok && output.length) {
    const resumedAt = Date.now();
    const resumed = await fetch(`${base}/responses`, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model, instructions, input: [...output, { role: 'user', content: [{ type: 'input_text', text: 'What was the exact code? Reply only with that code.' }] }], store: false, stream: true, tools: [], reasoning: { effort: 'low' } }),
    });
    const body = await resumed.text();
    let completed, failed = false;
    for (const line of body.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try { const event = JSON.parse(line.slice(6)); if (event.type === 'response.completed') completed = event.response; if (event.type === 'response.failed' || event.type === 'error') failed = true; } catch {}
    }
    const text = (completed?.output || []).flatMap(item => item.content || []).map(content => content.text || '').join('');
    report.tests.push({ name: 'astra_resume_after_compact', status: resumed.status, elapsedMs: Date.now() - resumedAt, completed: !!completed, markerRetained: text.includes(marker), failed });
  }
} catch (error) {
  report.error = { name: error.name, message: 'Installed compaction probe did not complete.' };
} finally {
  report.desktopAuthUnchanged = fingerprint(authBefore) === fingerprint(await readFile(join(desktopHome, 'auth.json')));
  report.desktopConfigUnchanged = fingerprint(configBefore) === fingerprint(await readFile(join(desktopHome, 'config.toml')));
  report.passed = report.tests.length === 2 && report.tests[0].status === 200 && report.tests[0].encryptedCompactionReturned && report.tests[1].status === 200 && report.tests[1].completed && report.tests[1].markerRetained && !report.tests[1].failed && report.desktopAuthUnchanged && report.desktopConfigUnchanged;
  await writeJson(new URL('../reports/live-installed-astra-compact.json', import.meta.url), report);
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
