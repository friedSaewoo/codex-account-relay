import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createRelay } from '../src/relay.mjs';
import { readDesktopAuth, desktopHome, stateHome, privateDirectory, fingerprint, findCodex, isPro, probeAuthSnapshot } from '../src/credentials.mjs';
import { businessProvider, writeJson } from '../src/store.mjs';
import { assistantSaidMarker } from '../src/management.mjs';

const mode = process.argv[2] || 'http';
const probeModel = process.env.CODEX_RELAY_PROBE_MODEL || 'gpt-6.1-sol';
if (!/^[a-zA-Z0-9._-]{1,80}$/.test(probeModel)) throw new Error('Invalid probe model.');
const pro = await readDesktopAuth();
if (!isPro(pro)) throw new Error('Compatibility probe requires the desktop Pro workspace.');
const getBusiness = businessProvider();
const business = await getBusiness();
if (!business) throw new Error('Run login-business first.');
const authBefore = await readFile(join(desktopHome, 'auth.json'));
const configBefore = await readFile(join(desktopHome, 'config.toml'));
const events = [];
let route = 'business';
const relay = createRelay({ getPro: () => readDesktopAuth(), getBusiness: async () => route === 'business' ? getBusiness() : null, passThroughCodexRoutes: true, audit: e => { events.push(e); console.log(JSON.stringify(e)); } });
const port = await relay.listen(0);
const report = { at: new Date().toISOString(), mode, model: probeModel, desktopPlan: pro.plan, businessPlan: business.plan, tests: [] };
const marker = `RELAY_${randomBytes(4).toString('hex')}`;
const scratchRoot = join(stateHome, 'probes');
await privateDirectory(stateHome);
await mkdir(scratchRoot, { recursive: true });
let isolated, toolWorkspace;

async function modelRequest(input) {
  const r = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId, 'content-type': 'application/json', accept: 'text/event-stream', originator: 'Codex Desktop', version: '0.162.0' },
    body: JSON.stringify({ model: probeModel, instructions: 'This is a protocol compatibility check. Follow the short user instruction. Do not call any tools.', input, tools: [], store: false, stream: true, ...(mode === 'history' ? { reasoning: { effort: 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'] } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await r.text();
  let completed;
  const kinds = [];
  const items = new Map();
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const e = JSON.parse(line.slice(6));
      if (e.type && !kinds.includes(e.type)) kinds.push(e.type);
      if (e.type === 'response.output_item.done' && e.item) items.set(e.output_index ?? items.size, e.item);
      if (e.type === 'response.completed') completed = e.response;
    } catch {}
  }
  const output = completed?.output?.length ? completed.output : [...items.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const text = output.flatMap(i => i.content || []).map(c => c.text || '').join('');
  return { status: r.status, completed: !!completed, output, text, kinds, errorPreview: r.ok ? null : body.slice(0, 1200) };
}
function user(text) { return { role: 'user', content: [{ type: 'input_text', text }] }; }
try {
  if (mode === 'http' || mode === 'history') {
    const input = [user(`Remember this exact test code: ${marker}. ${mode === 'history' ? 'Work out 193 times 217 internally.' : ''} Reply only READY.`)];
    const first = await modelRequest(input);
    report.tests.push({ name: 'real_business_response', route, status: first.status, completed: first.completed, text: first.text, outputTypes: first.output.map(i => i.type), eventTypes: first.kinds, error: first.errorPreview });
    if (first.completed) {
      route = 'pro';
      const second = await modelRequest([...input, ...first.output, user('What was the exact test code? Reply with that code only.')]);
      report.tests.push({ name: 'business_to_pro_history', route, status: second.status, completed: second.completed, markerRetained: second.text.includes(marker), reasoningItemsIncluded: first.output.filter(i => i.type === 'reasoning').length, encryptedReasoningIncluded: first.output.some(i => !!i.encrypted_content), error: second.errorPreview });
    }
  } else if (mode === 'cli' || mode === 'cli-tools') {
    isolated = await mkdtemp(join(scratchRoot, 'cli-'));
    // Only an isolated client receives this copy. The original desktop auth/config/sessions stay untouched.
    await writeFile(join(isolated, 'auth.json'), JSON.stringify(probeAuthSnapshot(pro)), { flag: 'wx' });
    if (mode === 'cli-tools') {
      // Credentials stay private; sandboxed tool commands need a separate readable workspace.
      toolWorkspace = await mkdtemp(join(tmpdir(), 'codex-relay-tools-'));
      await writeFile(join(toolWorkspace, 'fixture.json'), JSON.stringify({ marker }), { flag: 'wx' });
    }
    const executable = await findCodex();
    for (const selected of (['business', 'pro'].includes(process.argv[3]) && mode === 'cli-tools' ? [process.argv[3]] : ['business', 'pro'])) {
      route = selected;
      const collected = [];
      const exit = await new Promise((resolve, reject) => {
        const prompt = mode === 'cli-tools'
          ? 'This is a tool transport test. Use a command tool to read only fixture.json in your current working directory and obtain its marker property. Then perform one live web search for site:learn.chatgpt.com/docs/auth Codex authentication. Do not write any files or read any other local files. Finally reply with only the exact marker read from fixture.json.'
          : `This is a transport test. Do not use any tools. Reply with exactly ${marker}.`;
        const toolConfig = mode === 'cli-tools' ? ['-c', 'windows.sandbox="unelevated"', '-c', `projects."${toolWorkspace.replaceAll('\\', '/')}".trust_level="trusted"`] : [];
        const child = spawn(executable, [...(mode === 'cli-tools' ? ['--search'] : []), 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json', '-m', probeModel, '-c', 'cli_auth_credentials_store="file"', ...toolConfig, '-c', `openai_base_url="http://127.0.0.1:${port}/backend-api/codex"`, '-c', 'model_reasoning_effort="low"', '-C', toolWorkspace || isolated, prompt], { env: { ...process.env, CODEX_HOME: isolated }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', c => collected.push(c)); child.stderr.on('data', c => collected.push(c));
        const timeout = setTimeout(() => child.kill(), 150000);
        child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolve(code); });
      });
      const output = Buffer.concat(collected).toString();
      const items = output.split(/\r?\n/).flatMap(line => { try { const event = JSON.parse(line); return event.type === 'item.completed' && event.item ? [event.item] : []; } catch { return []; } });
      const markerReturned = assistantSaidMarker(output, marker);
      const diagnostic = (mode === 'cli-tools' && exit === 0 ? items.filter(item => item.type === 'agent_message').map(item => item.text).join('\n').slice(-2000) : output.slice(-2000)).replaceAll(pro.token, '[redacted]').replaceAll(pro.accountId, '[redacted]').replaceAll(business.token, '[redacted]').replaceAll(business.accountId, '[redacted]');
      report.tests.push({ name: mode === 'cli-tools' ? 'bundled_cli_tools' : 'bundled_cli', route, exit, markerReturned, ...(mode === 'cli-tools' ? { itemTypes: [...new Set(items.map(item => item.type))], toolItems: items.filter(item => item.type !== 'agent_message').map(item => ({ type: item.type, keys: Object.keys(item), tool: item.tool, server: item.server, status: item.status, exitCode: item.exit_code, error: item.error ? String(item.error).slice(0,500) : null })), localCommandSucceeded: items.some(item => item.type === 'command_execution' && item.exit_code === 0), webSearchObserved: items.some(item => /web_search/.test(item.type) || (item.type === 'mcp_tool_call' && /web_run/.test(JSON.stringify(item)) && !item.error)) } : {}), errorPreview: exit === 0 && markerReturned ? null : diagnostic });
    }
  } else throw new Error('Probe modes: http or cli');
} finally {
  await relay.close();
  if (isolated && dirname(isolated) === scratchRoot) await rm(isolated, { recursive: true, force: true });
  if (toolWorkspace && dirname(toolWorkspace) === tmpdir()) await rm(toolWorkspace, { recursive: true, force: true });
  report.desktopAuthUnchanged = fingerprint(authBefore) === fingerprint(await readFile(join(desktopHome, 'auth.json')));
  report.desktopConfigUnchanged = fingerprint(configBefore) === fingerprint(await readFile(join(desktopHome, 'config.toml')));
  report.relay = relay.getStatus();
  await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
  await writeJson(new URL(`../reports/live-${mode}${probeModel === 'gpt-6.1-sol' ? '' : '-' + probeModel}.json`, import.meta.url), report);
  console.log(JSON.stringify(report, null, 2));
}
