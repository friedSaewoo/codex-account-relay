import { readFile } from 'node:fs/promises';
import { writeJson } from '../src/store.mjs';
const initial = JSON.parse(await readFile(new URL('../reports/latency-benchmark.json', import.meta.url), 'utf8'));
const network = JSON.parse(await readFile(new URL('../reports/latency-network-check.json', import.meta.url), 'utf8'));
const all = [...initial.real, ...network.real];
function median(values) { const sorted = values.filter(Number.isFinite).sort((a,b) => a-b); return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : null; }
const rows = [];
for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) for (const role of ['business', 'pro']) {
  const direct = all.filter(row => row.model === model && row.role === role && row.route === 'direct');
  const relay = all.filter(row => row.model === model && row.role === role && row.route === 'relay');
  const row = { model, role, samplesEach: direct.length, directFirstTextMs: median(direct.map(row => row.firstTextMs)), relayFirstTextMs: median(relay.map(row => row.firstTextMs)), directTotalMs: median(direct.map(row => row.totalMs)), relayTotalMs: median(relay.map(row => row.totalMs)) };
  row.firstTextDifferenceMs = Math.round((row.relayFirstTextMs - row.directFirstTextMs) * 10) / 10;
  rows.push(row);
}
const report = {
  at: new Date().toISOString(), realRequests: all.length,
  allRealResponsesSucceeded: all.every(row => row.status === 200 && row.completed && row.markerReturned),
  installedCodeVerified: initial.codeMatchesSource && network.codeMatchesSource,
  unchangedAuthAndConfig: initial.desktopAuthUnchanged && initial.desktopConfigUnchanged && network.desktopAuthUnchanged && network.desktopConfigUnchanged,
  localOnly: initial.local,
  coldBusinessCredentialLoadMs: [initial.businessCredentialColdLoadMs, network.businessCredentialColdLoadMs],
  realFirstTextAndCompletionMedians: rows,
  exhaustedPro: { requestsThroughRelay: initial.exhaustedPro.relay.pro + network.exhaustedPro.relay.pro, businessAttempts: initial.exhaustedPro.relay.business + network.exhaustedPro.relay.business, businessCredentialCalls: initial.exhaustedPro.businessCredentialCalls + network.exhaustedPro.businessCredentialCalls },
  upstreamReuseObservedForRelay: network.real.some(row => row.route === 'relay' && row.upstreamConnectionReused === true),
  limits: ['Real measurements use short independent requests, low reasoning effort and HTTP/SSE on both paths, not desktop rendering or WebSocket comparison.', 'Only 3 or 5 live samples per model/account/path; upstream variation prevents estimating a fixed real-service latency penalty.', 'Local fixture compares 40 warmed sequential pairs per payload size with gzip and current desktop authentication-file reads, excluding the production audit writer.', 'Exhausted Business state is simulated on isolated relay ports, never by consuming the account quota.'],
};
await writeJson(new URL('../reports/latency-summary.json', import.meta.url), report);
console.log(JSON.stringify(report, null, 2));
