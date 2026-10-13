import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { readDesktopAuth, desktopHome, stateHome, fingerprint, isPro } from '../src/credentials.mjs';
import { businessProvider, writeJson } from '../src/store.mjs';

// No changes to production mode, quota files, authentication or existing chats.
const installed = join(stateHome, 'app', 'src', 'relay.mjs');
const { createRelay } = await import(pathToFileURL(installed));
const beforeAuth = await readFile(join(desktopHome, 'auth.json'));
const beforeConfig = await readFile(join(desktopHome, 'config.toml'));
const pro = await readDesktopAuth();
if (!isPro(pro)) throw new Error('Pro desktop sign-in required.');
const provider = businessProvider();
const coldAt = performance.now();
const business = await provider();
const businessCredentialColdLoadMs = performance.now() - coldAt;
if (!business) throw new Error('Business sign-in required.');
const report = {
  at: new Date().toISOString(),
  codeMatchesSource: fingerprint(await readFile(installed)) === fingerprint(await readFile(new URL('../src/relay.mjs', import.meta.url))),
  businessCredentialColdLoadMs: Math.round(businessCredentialColdLoadMs * 10) / 10,
  real: [], local: [],
  scope: 'Same HTTP/SSE client, body, model and reasoning effort; direct versus installed relay code on isolated loopback ports. Desktop UI and WebSocket transport comparison are not included.',
};
const models = process.env.CODEX_RELAY_BENCH_ASTRA_ONLY === '1' ? ['gpt-6-astra'] : ['gpt-6.1-sol', 'gpt-6-astra'];
const rounds = process.env.CODEX_RELAY_BENCH_NETWORK_CHECK === '1' ? 2 : 3;
let activeNetworkMeasurement;
const originalHttpsRequest = https.request;
https.request = function (...args) {
  const measurement = activeNetworkMeasurement;
  const issued = performance.now();
  const request = originalHttpsRequest.apply(this, args);
  if (measurement) {
    request.once('socket', socket => {
      measurement.tlsConnectMs = socket.connecting ? null : 0;
      if (socket.connecting) socket.once('secureConnect', () => { measurement.tlsConnectMs = performance.now() - issued; });
    });
    request.once('response', () => {
      measurement.upstreamConnectionReused = !!request.reusedSocket;
      measurement.upstreamHeadersMs = performance.now() - issued;
    });
  }
  return request;
};
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] * 10) / 10;
}
function summary(rows, field) {
  const values = rows.map(row => row[field]).filter(value => typeof value === 'number');
  return values.length ? { medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), minMs: Math.round(Math.min(...values) * 10) / 10, maxMs: Math.round(Math.max(...values) * 10) / 10 } : null;
}
async function send(url, headers, body, expected) {
  const started = performance.now();
  return new Promise(resolve => {
    let result = { headerMs: null, firstEventMs: null, firstTextMs: null, totalMs: null, completed: false, markerReturned: false }, text = '';
    const request = (url.startsWith('https:') ? https : http).request(url, { method: 'POST', headers: { ...headers, 'content-length': String(body.length) } }, incoming => {
      result.status = incoming.statusCode; result.headerMs = performance.now() - started;
      result.connectionReused = !!request.reusedSocket;
      let buffered = '';
      incoming.on('data', chunk => {
        buffered += chunk.toString();
        let at;
        while ((at = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, at).trimEnd(); buffered = buffered.slice(at + 1);
          if (!line.startsWith('data: ')) continue;
          let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
          result.firstEventMs ??= performance.now() - started;
          if (event.type === 'response.output_text.delta') { result.firstTextMs ??= performance.now() - started; text += event.delta || ''; }
          if (event.type === 'response.completed') {
            result.completed = true;
            const output = (event.response?.output || []).flatMap(item => item.content || []).map(content => content.text || '').join('');
            result.markerReturned = (output || text).includes(expected);
          }
          if (event.type === 'response.failed' || event.type === 'error') result.failedEvent = true;
        }
      });
      incoming.on('end', () => { result.totalMs = performance.now() - started; resolve(result); });
      incoming.on('error', () => resolve({ ...result, error: 'response_transport' }));
    });
    request.setTimeout(90000, () => request.destroy(new Error('Timeout.')));
    request.on('error', () => resolve({ ...result, error: 'request_transport' }));
    request.end(body);
  });
}
const proHeaders = { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId, 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity', originator: 'Codex Desktop', version: '0.162.0' };
let businessCallsForExhaustedPro = 0, activeMeasurement;
const relays = {};
try {
  for (const role of ['business', 'pro']) {
    const relay = createRelay({
      getPro: async () => readDesktopAuth(),
      getBusiness: async () => { if (role === 'pro') businessCallsForExhaustedPro++; return provider(); },
      ...(role === 'pro' ? { initialQuota: { resetAt: Date.now() + 3600000 } } : {}),
      audit: event => { if (event.event === 'attempt' && activeMeasurement) { activeMeasurement.preflightMs = performance.now() - activeMeasurement.started; activeMeasurement.route = event.route; } },
    });
    relays[role] = { relay, port: await relay.listen(0) };
  }
  for (const model of models) {
    for (const role of ['business', 'pro']) {
      const credential = role === 'business' ? business : pro;
      for (let pair = 0; pair < rounds; pair++) {
        const marker = `LATENCY_${randomBytes(4).toString('hex')}`;
        const body = Buffer.from(JSON.stringify({ model, instructions: 'This is a latency test. Reply only with the exact user-specified text. Do not use tools.', input: [{ role: 'user', content: [{ type: 'input_text', text: `Reply only with ${marker}.` }] }], tools: [], reasoning: { effort: 'low' }, stream: true, store: false }));
        for (const route of pair % 2 ? ['relay', 'direct'] : ['direct', 'relay']) {
          const timing = { started: performance.now(), route: null, preflightMs: null };
          activeMeasurement = route === 'relay' ? timing : null;
          activeNetworkMeasurement = timing;
          const url = route === 'direct' ? 'https://chatgpt.com/backend-api/codex/responses' : `http://127.0.0.1:${relays[role].port}/backend-api/codex/responses`;
          const headers = route === 'direct' ? { ...proHeaders, authorization: `Bearer ${credential.token}`, 'chatgpt-account-id': credential.accountId } : proHeaders;
          const result = await send(url, headers, body, marker);
          activeMeasurement = null;
          activeNetworkMeasurement = null;
          const row = { model, role, route, pair, ...result, tlsConnectMs: timing.tlsConnectMs, upstreamConnectionReused: timing.upstreamConnectionReused, upstreamHeadersMs: timing.upstreamHeadersMs, ...(route === 'relay' ? { actualAccount: timing.route, localPreflightMs: timing.preflightMs } : {}) };
          report.real.push(row);
          console.log(JSON.stringify({ model, role, route, pair, status: row.status, completed: row.completed, firstTextMs: Math.round(row.firstTextMs || 0), totalMs: Math.round(row.totalMs || 0), tlsConnectMs: Math.round(row.tlsConnectMs || 0), upstreamConnectionReused: row.upstreamConnectionReused, ...(route === 'relay' ? { actualAccount: row.actualAccount, localPreflightMs: Math.round(row.localPreflightMs * 10) / 10 } : {}) }));
          if (row.status !== 200 || !row.completed || !row.markerReturned) throw new Error('Real request did not complete.');
        }
      }
    }
  }
  report.exhaustedPro = { businessCredentialCalls: businessCallsForExhaustedPro, relay: relays.pro.relay.getStatus(), note: 'Business exhaustion state is simulated in this isolated relay. All resulting Pro responses are genuine.' };
  // Isolate local forwarding overhead from upstream scheduling and generation variability.
  if (process.env.CODEX_RELAY_BENCH_NETWORK_CHECK !== '1') {
  const syntheticPro = { token: 'synthetic-pro-token', accountId: 'synthetic-pro-account' };
  const fixture = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"output":[{"content":[{"text":"OK"}]}]}}\n\n');
    });
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fakeRelay = createRelay({ getPro: async () => { await readDesktopAuth(); return syntheticPro; }, getBusiness: async () => null, initialQuota: { resetAt: Date.now() + 3600000 }, upstream: `http://127.0.0.1:${fixture.address().port}`, allowTestUpstream: true });
  const fakePort = await fakeRelay.listen(0);
  try {
    for (const size of [2048, 2 * 1024 * 1024]) {
      const plain = Buffer.from(JSON.stringify({ model: 'gpt-6-astra', input: 'x'.repeat(size) }));
      const body = gzipSync(plain);
      const headers = { authorization: `Bearer ${syntheticPro.token}`, 'chatgpt-account-id': syntheticPro.accountId, 'content-type': 'application/json', 'content-encoding': 'gzip' };
      const rows = [];
      for (let pair = -2; pair < 40; pair++) {
        for (const route of pair % 2 ? ['relay', 'direct'] : ['direct', 'relay']) {
          const port = route === 'direct' ? fixture.address().port : fakePort;
          const result = await send(`http://127.0.0.1:${port}/backend-api/codex/responses`, headers, body, 'OK');
          if (!result.completed || !result.markerReturned) throw new Error('Local fixture failed.');
          if (pair >= 0) rows.push({ pair, route, ...result });
        }
      }
      const differences = Array.from({ length: 40 }, (_, pair) => ({ totalMs: rows.find(row => row.pair === pair && row.route === 'relay').totalMs - rows.find(row => row.pair === pair && row.route === 'direct').totalMs }));
      report.local.push({ decodedRequestBytes: plain.length, encodedRequestBytes: body.length, pairs: 40, direct: summary(rows.filter(row => row.route === 'direct'), 'totalMs'), relay: summary(rows.filter(row => row.route === 'relay'), 'totalMs'), additional: summary(differences, 'totalMs') });
    }
  } finally { await fakeRelay.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
  }
} catch (error) {
  report.error = 'Benchmark did not complete; inspect safe result status fields.';
} finally {
  for (const { relay } of Object.values(relays)) await relay.close();
  https.request = originalHttpsRequest;
  report.desktopAuthUnchanged = fingerprint(beforeAuth) === fingerprint(await readFile(join(desktopHome, 'auth.json')));
  report.desktopConfigUnchanged = fingerprint(beforeConfig) === fingerprint(await readFile(join(desktopHome, 'config.toml')));
  report.summaries = [];
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) for (const role of ['business', 'pro']) {
    const rows = report.real.filter(row => row.model === model && row.role === role);
    if (!rows.length) continue;
    const direct = rows.filter(row => row.route === 'direct'), relay = rows.filter(row => row.route === 'relay');
    report.summaries.push({ model, role, samplesEach: direct.length, directFirstText: summary(direct, 'firstTextMs'), relayFirstText: summary(relay, 'firstTextMs'), directTotal: summary(direct, 'totalMs'), relayTotal: summary(relay, 'totalMs'), relayLocalPreflight: summary(relay, 'localPreflightMs') });
  }
  await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
  await writeJson(new URL(`../reports/${process.env.CODEX_RELAY_BENCH_NETWORK_CHECK === '1' ? 'latency-network-check' : 'latency-benchmark'}.json`, import.meta.url), report);
  console.log(JSON.stringify({ done: !report.error, authUnchanged: report.desktopAuthUnchanged, configUnchanged: report.desktopConfigUnchanged, businessCredentialColdLoadMs: report.businessCredentialColdLoadMs, summaries: report.summaries, local: report.local, exhaustedPro: report.exhaustedPro }, null, 2));
}
if (report.error) process.exitCode = 1;
