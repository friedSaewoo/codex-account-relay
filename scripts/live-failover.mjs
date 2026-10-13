// Test-only boundary: synthetic Business quota rejection, then a genuine Pro backend request.
// This server is never used by `serve`; production has no injected-error route or header.
import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRelay, cleanHeaders } from '../src/relay.mjs';
import { readDesktopAuth, readBusiness, desktopHome, fingerprint } from '../src/credentials.mjs';
import { writeJson } from '../src/store.mjs';
const pro = await readDesktopAuth(), business = await readBusiness();
if (!business) throw new Error('Business login required.');
const before = await readFile(join(desktopHome, 'auth.json'));
let realProRequests = 0, syntheticBusinessRejections = 0;
const boundary = http.createServer((req, res) => {
  if (req.headers.authorization === `Bearer ${business.token}`) {
    syntheticBusinessRejections++;
    req.resume(); res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"usage_limit_reached"}}'); return;
  }
  if (req.headers.authorization !== `Bearer ${pro.token}`) { req.resume(); res.writeHead(403); res.end(); return; }
  realProRequests++;
  const out = https.request(new URL(req.url, 'https://chatgpt.com'), { method: req.method, headers: cleanHeaders(req.headers) }, incoming => { res.writeHead(incoming.statusCode, cleanHeaders(incoming.headers)); incoming.pipe(res); });
  out.on('error', () => { res.destroy(); }); res.on('close', () => out.destroy()); req.pipe(out);
});
await new Promise(r => boundary.listen(0, '127.0.0.1', r));
const relay = createRelay({ getPro: async () => pro, getBusiness: async () => business, upstream: `http://127.0.0.1:${boundary.address().port}`, allowTestUpstream: true });
const port = await relay.listen(0);
let report;
try {
  const r = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: 'POST', headers: { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId, 'content-type': 'application/json', originator: 'Codex Desktop' }, body: JSON.stringify({ model: 'gpt-6.1-sol', instructions: 'Reply to the user with the requested literal text. Do not use tools.', input: [{ role: 'user', content: 'Reply with exactly FALLBACK_OK.' }], store: false, stream: true }), signal: AbortSignal.timeout(120000) });
  const body = await r.text();
  report = { at: new Date().toISOString(), syntheticBusinessRejections, realProRequests, status: r.status, completed: body.includes('response.completed'), markerReturned: body.includes('FALLBACK_OK'), realBusinessQuotaExhausted: false, note: 'Business quota rejection is simulated. Pro response uses the real account.', relay: relay.getStatus() };
} finally {
  await relay.close(); boundary.closeAllConnections(); await new Promise(r => boundary.close(r));
}
report.desktopAuthUnchanged = fingerprint(before) === fingerprint(await readFile(join(desktopHome, 'auth.json')));
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeJson(new URL('../reports/live-failover.json', import.meta.url), report);
console.log(JSON.stringify(report, null, 2));
