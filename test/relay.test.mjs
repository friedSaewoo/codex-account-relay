import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { createRelay, quotaFailure, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/relay.mjs';
import { createDiagnostics } from '../src/diagnostics.mjs';
import { addConfig, removeConfig } from '../src/config.mjs';
import { fingerprint } from '../src/credentials.mjs';
import { usageReader } from '../src/usage.mjs';

const pro = { token: 'pro-secret', accountId: 'pro-workspace' };
const business = { token: 'business-secret', accountId: 'business-workspace' };
const basePath = '/backend-api/codex';
async function setup(t, handler, options = {}) {
  const seen = [], events = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url });
    handler(req, res, seen.length);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const relay = createRelay({ getPro: async () => pro, getBusiness: async () => business, upstream: `http://127.0.0.1:${upstream.address().port}`, allowTestUpstream: true, audit: x => events.push(x), ...options });
  const port = await relay.listen(0);
  t.after(async () => { await relay.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); });
  const call = (path = `${basePath}/responses`, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: '{"input":"test"}', ...init, headers: { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId, ...init.headers } });
  return { call, seen, events, relay, port };
}
const ok = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.completed"}\n\n'); };
const limit = res => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 3600 } })); };

test('Business first, raw body preserved, account headers replaced, no secrets in audit', async t => {
  const x = await setup(t, ok);
  const body = gzipSync(Buffer.from('{"input":"private prompt"}'));
  const r = await x.call(undefined, { body, headers: { 'content-encoding': 'gzip', cookie: 'session-private', 'x-openai-actor-authorization': 'actor-private' } });
  assert.equal(r.status, 200); await r.text();
  assert.equal(x.seen[0].headers.authorization, 'Bearer business-secret');
  assert.equal(x.seen[0].headers['chatgpt-account-id'], business.accountId);
  assert.equal(x.seen[0].headers.cookie, undefined);
  assert.equal(x.seen[0].headers['x-openai-actor-authorization'], undefined);
  assert.deepEqual(x.seen[0].body, body);
  assert(!/secret|private prompt|private/.test(JSON.stringify(x.events)));
});
test('exact quota failure switches once to Pro and blocks Business on later requests', async t => {
  let persisted;
  const x = await setup(t, (req, res) => req.headers.authorization.includes('business') ? limit(res) : ok(req, res), { persistQuota: async q => { persisted = q; } });
  assert.equal((await x.call()).status, 200);
  assert.equal((await x.call()).status, 200);
  assert.deepEqual(x.seen.map(x => x.headers.authorization), ['Bearer business-secret', 'Bearer pro-secret', 'Bearer pro-secret']);
  assert(persisted.resetAt > Date.now());
  assert.equal(x.relay.getStatus().fallbacks, 1);
});

const availableBusinessUsage = (queriedAt = Date.now()) => ({
  plan: 'team', allowed: true, limitReached: false, stale: false, error: null, windowsValid: true,
  queriedAt: new Date(queriedAt).toISOString(), accountKey: fingerprint(business.accountId), windows: [{ remainingPercent: 100 }],
});
test('fresh restored usage clears early exhaustion for the next request without a probe or reset-credit request', async t => {
  let exhausted = true, persisted;
  const x = await setup(t, (req, res) => exhausted && req.headers.authorization.includes('business') ? limit(res) : ok(req, res), { persistQuota: async q => { persisted = q; } });
  await (await x.call()).text(); assert.equal(x.relay.getStatus().businessBlocked, true);
  exhausted = false; await new Promise(resolve => setTimeout(resolve, 3));
  let usageCalls = 0;
  const reader = usageReader({ role: 'business', getCredential: async () => ({ ...business, plan: 'team' }), fetchImpl: async () => {
    usageCalls++; return { ok: true, json: async () => ({ plan_type: 'team', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 0, limit_window_seconds: 18000 } } }) };
  } });
  const before = x.seen.length;
  assert.equal(await x.relay.resumeBusinessFromUsage(await reader()), true);
  assert.equal(usageCalls, 1); assert.equal(x.seen.length, before); assert.equal(persisted, null);
  await (await x.call()).text();
  assert.deepEqual(x.seen.map(req => req.headers.authorization), ['Bearer business-secret', 'Bearer pro-secret', 'Bearer business-secret']);
});

test('recovery leaves accepted Pro output running and applies only to a later Business request', async t => {
  let finish;
  const x = await setup(t, (req, res) => {
    if(req.headers.authorization.includes('pro')) { res.writeHead(200); res.write('first'); finish = () => res.end('complete'); }
    else ok(req,res);
  }, { initialQuota: { resetAt: Date.now()+3600000, blockedAt: Date.now()-1000, accountKey: fingerprint(business.accountId) } });
  const response = await x.call();
  assert.equal(await x.relay.resumeBusinessFromUsage(availableBusinessUsage(Date.now()-100)), true);
  assert.equal(x.seen.length, 1); finish(); assert.equal(await response.text(), 'firstcomplete');
  await (await x.call()).text(); assert.equal(x.seen[1].headers.authorization, 'Bearer business-secret');
});

test('new exhaustion during recovery persistence stays blocked instead of being erased by the older recovery', async t => {
  let releaseWrite;
  const x = await setup(t, (req,res) => req.headers.authorization.includes('business') ? limit(res) : ok(req,res), {
    initialQuota: { resetAt: Date.now()+3600000, blockedAt: Date.now()-1000, accountKey: fingerprint(business.accountId) },
    persistQuota: async value => { if(value===null) await new Promise(resolve => { releaseWrite=resolve; }); },
  });
  const recovering = x.relay.resumeBusinessFromUsage(availableBusinessUsage(Date.now()-100));
  await new Promise(resolve => setImmediate(resolve));
  await (await x.call()).text(); assert.equal(x.relay.getStatus().businessBlocked, true);
  releaseWrite(); await recovering; assert.equal(x.relay.getStatus().businessBlocked, true);
  await (await x.call()).text(); assert.equal(x.seen.at(-1).headers.authorization, 'Bearer pro-secret');
});

test('legacy cache needs a query after restart and failed persistence retains its wait', async t => {
  const x = await setup(t, ok, { initialQuota: { resetAt: Date.now()+3600000 }, persistQuota: async () => { throw new Error('disk unavailable'); } });
  assert.equal(await x.relay.resumeBusinessFromUsage(availableBusinessUsage(Date.now()-100)), false);
  await new Promise(resolve => setTimeout(resolve,3));
  await assert.rejects(x.relay.resumeBusinessFromUsage(availableBusinessUsage()), /disk unavailable/);
  assert.equal(x.relay.getStatus().businessBlocked,true);
});
for (const [status, type] of [[429, 'rate_limit_exceeded'], [401, 'invalid_token'], [403, 'workspace_policy'], [500, 'usage_limit_reached']]) {
  test(`${status} ${type} does not switch accounts`, async t => {
    const x = await setup(t, (_req, res) => { res.writeHead(status); res.end(JSON.stringify({ error: { type } })); });
    const r = await x.call(); assert.equal(r.status, status); await r.text(); assert.equal(x.seen.length, 1);
  });
}
test('both accounts exhausted gives final Pro 429 without loop', async t => {
  const x = await setup(t, (_req, res) => limit(res));
  assert.equal((await x.call()).status, 429); assert.equal(x.seen.length, 2);
});
test('concurrent quota rejections each retry at most once without duplicating successful requests', async t => {
  const x = await setup(t, (req, res) => req.headers.authorization.includes('business') ? limit(res) : ok(req, res));
  const replies = await Promise.all(Array.from({ length: 10 }, () => x.call().then(r => r.text())));
  assert.equal(replies.length, 10);
  assert.equal(x.seen.filter(x => x.headers.authorization === 'Bearer pro-secret').length, 10);
  assert(x.seen.length <= 20);
});
test('quota error after successful stream has begun never replays', async t => {
  const x = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"tool_call","id":"unique"}\n\n');
    setTimeout(() => res.end('data: {"error":{"type":"usage_limit_reached"}}\n\n'), 25);
  });
  const r = await x.call(); const text = await r.text();
  assert(text.includes('unique')); assert.equal(x.seen.length, 1);
});

test('capacity error inside HTTP 200 is logged as upstream terminal metadata and forwarded byte-for-byte once', async t => {
  const body = 'data: {"type":"response.output_text.delta","delta":"private text"}\n\ndata: {"type":"response.failed","response":{"id":"private-id","error":{"code":"server_overloaded","message":"Selected model is at capacity. private metadata"}}}\n\n';
  const x = await setup(t, (_req, res) => { res.writeHead(200, {'content-type':'text/event-stream'}); res.end(body); });
  const response = await x.call(); assert.equal(response.status, 200); assert.equal(await response.text(), body);
  const terminal = x.events.find(e => e.event==='sse_terminal');
  assert.equal(terminal.type,'response.failed'); assert.equal(terminal.errorCode,'server_overloaded'); assert.equal(terminal.capacityMessage,true);
  assert.equal(x.seen.length,1); assert(!/private|Selected/.test(JSON.stringify(x.events)));
});
test('abrupt stream disconnect never replays', async t => {
  const x = await setup(t, (_req, res) => { res.writeHead(200); res.write('partial'); setTimeout(() => res.destroy(), 30); });
  const r = await x.call(); await assert.rejects(r.text()); assert.equal(x.seen.length, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  const failure = x.events.find(event => event.event === 'upstream_error');
  assert.equal(failure.origin, 'upstream_stream'); assert.equal(failure.upstreamHttpComplete, false);
  assert.equal(failure.upstreamBytes, Buffer.byteLength('partial'));
});

test('client cancellation stays distinct from upstream failure even when cancellation destroys the upstream too', async t => {
  const x = await setup(t, (_req, res) => { res.writeHead(200); res.write('first'); });
  const r = await x.call(); const reader = r.body.getReader(); await reader.read(); await reader.cancel();
  const deadline = Date.now() + 1000;
  while (!x.events.some(event => event.event === 'client_closed') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,10));
  const failure = x.events.find(event => event.event === 'client_closed');
  assert.equal(failure.origin, 'client_close'); assert.equal(x.seen.length, 1);
  assert.equal(x.events.some(event => event.event === 'upstream_error'), false);
});

test('upstream idle timeout is recorded separately without replay or exposing payload', async t => {
  const x = await setup(t, (_req,res) => { res.writeHead(200); res.write('private answer'); }, { timeoutMs: 60 });
  const r = await x.call(); await assert.rejects(r.text());
  await new Promise(resolve => setTimeout(resolve,10));
  const failure = x.events.find(event => event.event === 'upstream_error');
  assert.equal(failure.origin,'upstream_timeout'); assert.equal(failure.transportCode,'ETIMEDOUT');
  assert.equal(x.seen.length,1); assert(!JSON.stringify(x.events).includes('private answer'));
});

test('background write failure and another broken upstream stream leave the accepted response intact', async t => {
  let finish;
  const x = await setup(t, (_req, res, number) => {
    res.writeHead(200);
    if (number === 1) { res.write('active-first'); finish = () => res.end('active-completed'); }
    else if (number === 2) { res.write('broken'); setTimeout(() => res.destroy(), 20); }
    else res.end('healthy-next');
  });
  const accepted = await x.call();
  const diagnostic = createDiagnostics(new URL('../reports/nonexistent/subdir/errors.jsonl', import.meta.url));
  await diagnostic.run('compatibility', () => Promise.reject(Object.assign(new Error('locked'), { code: 'EPERM' })));
  const broken = await x.call(); await assert.rejects(broken.text());
  finish(); assert.equal(await accepted.text(), 'active-firstactive-completed');
  assert.equal(await (await x.call()).text(), 'healthy-next');
  assert.equal(x.seen.length, 3); // No replay of the broken accepted output.
});

test('regular incoming chunks reset the idle timer even during a long stream', async t => {
  const x = await setup(t, (_req, res) => {
    res.writeHead(200); res.write('start');
    let count = 0;
    const interval = setInterval(() => { if (++count === 8) { clearInterval(interval); res.end('done'); } else res.write('.'); }, 25);
    res.on('close', () => clearInterval(interval));
  }, { timeoutMs: 100 });
  assert.equal(await (await x.call()).text(), 'start.......done');
  assert.equal(x.events.some(event => event.event === 'upstream_error'), false);
  assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 300000);
});
test('graceful shutdown preserves an active response through completion without replay', async t => {
  let finish;
  const x = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
    finish = () => res.end('data: {"type":"response.completed"}\n\n');
  });
  const response = await x.call(); assert.equal(x.relay.getStatus().modelInFlight, 1);
  let stopped = false;
  const shutdown = x.relay.close({ force: false }).then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(stopped, false);
  finish(); const body = await response.text(); await shutdown;
  assert(body.includes('first')); assert(body.includes('response.completed')); assert.equal(x.seen.length, 1);
  assert.equal(x.relay.getStatus().modelInFlight, 0);
});
test('first stream chunk arrives before upstream completes', async t => {
  let finish;
  const x = await setup(t, (_req, res) => { res.writeHead(200); res.write('first'); finish = () => res.end('second'); });
  const r = await x.call(); const reader = r.body.getReader();
  const initial = await reader.read(); assert.equal(Buffer.from(initial.value).toString(), 'first');
  finish(); assert.equal(Buffer.from((await reader.read()).value).toString(), 'second');
});
test('models discovery uses Pro, compaction follows Business', async t => {
  const x = await setup(t, ok);
  await (await x.call(`${basePath}/models?client_version=test`, { method: 'GET', body: undefined })).text();
  await (await x.call(`${basePath}/responses/compact`)).text();
  assert.deepEqual(x.seen.map(x => x.headers.authorization), ['Bearer pro-secret', 'Bearer business-secret']);
  const stats = x.relay.getStatus();
  assert.equal(stats.modelBusiness, 1); assert.equal(stats.modelPro, 0);
  assert.equal(stats.auxiliaryPro, 1); assert.equal(stats.compactBusiness, 1);
  assert.equal(stats.lastModelRoute, 'business');
});

test('compressed Astra metadata and active model counts are independent of auxiliary requests', async t => {
  let finish;
  const x = await setup(t, (_req, res, number) => {
    if (number === 1) { res.writeHead(200); res.write('first'); finish = () => res.end('done'); }
    else ok(_req, res);
  });
  const r = await x.call(undefined, { body: gzipSync(Buffer.from('{"model":"gpt-6-astra","input":"private prompt"}')), headers: { 'content-encoding': 'gzip' } });
  assert.equal(x.relay.getStatus().modelInFlight, 1);
  await (await x.call(`${basePath}/models`, { method: 'GET', body: undefined })).text();
  assert.equal(x.relay.getStatus().lastModel, 'gpt-6-astra');
  assert.equal(x.relay.getStatus().lastModelRoute, 'business');
  assert.equal(x.relay.getStatus().modelPro, 0);
  assert.equal(x.relay.getStatus().auxiliaryPro, 1);
  finish(); await r.text();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(x.relay.getStatus().modelInFlight, 0);
  assert(!JSON.stringify(x.events).includes('private prompt'));
});
test('missing Business credentials passes requests through Pro', async t => {
  const x = await setup(t, ok, { getBusiness: async () => null });
  await (await x.call()).text(); assert.equal(x.seen[0].headers.authorization, 'Bearer pro-secret');
});
test('credential failures stop instead of silently spending Pro', async t => {
  const x = await setup(t, ok, { getBusiness: async () => { throw new Error('refresh failed'); } });
  assert.equal((await x.call()).status, 502); assert.equal(x.seen.length, 0);
});

test('desktop workspace mismatch reports the local authentication cause without contacting upstream', async t => {
  const x = await setup(t, ok, { getPro: async () => { throw Object.assign(new Error('private metadata'), { code: 'DESKTOP_PRO_REQUIRED' }); } });
  const response = await x.call();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, 'relay_desktop_pro_required');
  assert.equal(x.seen.length, 0);
  assert(x.events.some(event => event.code === 'desktop_pro_required'));
  assert(!JSON.stringify(x.events).includes('private metadata'));
});
test('automatic manager can continue with Pro when Business credentials require login', async t => {
  const x = await setup(t, ok, { fallbackOnBusinessAuthError: true, getBusiness: async () => { throw new Error('refresh failed'); } });
  const r = await x.call(); assert.equal(r.status, 200); await r.text();
  assert.equal(x.seen[0].headers.authorization, 'Bearer pro-secret');
  assert(x.events.some(e => e.event === 'business_auth_fallback'));
});
test('automatic mode retries an explicit Business 401 once through Pro', async t => {
  const x = await setup(t, (req, res) => {
    if (req.headers.authorization.includes('business')) { res.writeHead(401); res.end('{"error":"invalid_token"}'); }
    else ok(req, res);
  }, { fallbackOnBusinessAuthError: true });
  const r = await x.call(); assert.equal(r.status, 200); await r.text(); assert.equal(x.seen.length, 2);
});
test('automatic mode never changes accounts to bypass a workspace policy rejection', async t => {
  const x = await setup(t, (_req, res) => { res.writeHead(403); res.end('workspace policy'); }, { fallbackOnBusinessAuthError: true });
  assert.equal((await x.call()).status, 403); assert.equal(x.seen.length, 1);
});
test('unknown quota reset gets a bounded retry time in automatic mode', async t => {
  const x = await setup(t, (req, res) => {
    if (req.headers.authorization.includes('business')) { res.writeHead(429); res.end('{"error":{"code":"usage_limit_reached"}}'); }
    else ok(req, res);
  }, { unknownQuotaRetryMs: 900000 });
  await (await x.call()).text();
  assert(x.relay.getStatus().quotaResetAt > Date.now());
  await x.relay.resetQuota(); assert.equal(x.relay.getStatus().businessBlocked, false);
});
test('authenticated health check stays entirely local', async t => {
  const x = await setup(t, ok);
  const r = await x.call('/relay/health', { method: 'GET', body: undefined });
  assert.equal((await r.json()).kind, 'codex-account-relay'); assert.equal(x.seen.length, 0);
});
for (const headers of [{ authorization: 'Bearer stranger' }, { origin: 'https://evil.test' }, { 'chatgpt-account-id': 'another-workspace' }]) {
  test(`reject unauthorized local request ${Object.keys(headers)[0]}`, async t => {
    const x = await setup(t, ok); assert.equal((await x.call(undefined, { headers })).status, 403); assert.equal(x.seen.length, 0);
  });
}
test('reject forged Host header at the wire level', async t => {
  const x = await setup(t, ok);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: x.port, path: `${basePath}/responses`, method: 'POST', headers: { host: 'evil.test', authorization: `Bearer ${pro.token}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(status, 403); assert.equal(x.seen.length, 0);
});
test('unknown route rejected without upstream request', async t => {
  const x = await setup(t, ok); assert.equal((await x.call('/arbitrary')).status, 404); assert.equal(x.seen.length, 0);
});

test('managed Codex auxiliary routes use Pro and preserve encoded query values', async t => {
  const x = await setup(t, ok, { passThroughCodexRoutes: true });
  const path = `${basePath}/tools/test?cursor=abc%2Fdef`;
  const r = await x.call(path);
  assert.equal(r.status, 200); await r.text();
  assert.equal(x.seen[0].headers.authorization, 'Bearer pro-secret');
  assert.equal(x.seen[0].url, path);
  assert.equal(x.relay.getStatus().business, 0);
});

test('protocol-relative and encoded path targets cannot redirect the destination', async t => {
  const x = await setup(t, ok, { passThroughCodexRoutes: true });
  for (const path of ['//attacker.invalid/backend-api/codex/responses', '/backend-api/codex/%2e%2e/responses', '/backend-api/codex/tools/../responses']) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: x.port, path, method: 'POST', headers: { authorization: `Bearer ${pro.token}`, 'chatgpt-account-id': pro.accountId } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(status, 404);
  }
  assert.equal(x.seen.length, 0);
});
test('body limit rejects before upstream sees data', async t => {
  const x = await setup(t, ok, { maxBody: 8 });
  // Streaming-limit failures can close the input socket; both fail closed without forwarding.
  try { assert.equal((await x.call()).status, 413); } catch (e) { assert.equal(e.message, 'fetch failed'); }
  assert.equal(x.seen.length, 0);
});
test('stored exhausted state survives relay restart and expired state retries Business', async t => {
  const x = await setup(t, ok, { initialQuota: { resetAt: null } });
  await (await x.call()).text(); assert.equal(x.seen[0].headers.authorization, 'Bearer pro-secret');
  const y = await setup(t, ok, { initialQuota: { resetAt: Date.now() - 1 } });
  await (await y.call()).text(); assert.equal(y.seen[0].headers.authorization, 'Bearer business-secret');
});
test('WebSocket handshake rejects with 426 so clients can use HTTP streaming', async t => {
  const x = await setup(t, ok);
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(x.port, '127.0.0.1', () => socket.write(`GET ${basePath}/responses HTTP/1.1\r\nHost: 127.0.0.1:${x.port}\r\nAuthorization: Bearer ${pro.token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.once('data', data => { resolve(data.toString()); socket.destroy(); }); socket.on('error', reject);
  });
  assert.match(reply, /426/); assert.equal(x.seen.length, 0);
});
test('compressed quota envelope understood, oversized/ambiguous errors do not switch', () => {
  assert(quotaFailure(gzipSync(Buffer.from('{"error":{"code":"usage_limit_reached"}}')), { 'content-encoding': 'gzip' }));
  assert.equal(quotaFailure(Buffer.from('usage_limit_reached'), {}), null);
  assert.equal(quotaFailure(gzipSync(Buffer.from(' '.repeat(70000))), { 'content-encoding': 'gzip' }), null);
});
test('non-OpenAI upstream denied outside explicit loopback tests', () => {
  assert.throws(() => createRelay({ upstream: 'https://attacker.test' }));
});
test('config activation and rollback preserve BOM, CRLF, comments and edits', () => {
  const original = Buffer.from('\ufeff# hello\r\nmodel = "gpt-6.1-sol"\r\n[features]\r\nx = true\r\n');
  const { patched, ...receipt } = addConfig(original, 19565);
  assert.deepEqual(removeConfig(patched, receipt), original);
  const edited = Buffer.concat([patched, Buffer.from('# user edit\r\n')]);
  assert.deepEqual(removeConfig(edited, receipt), Buffer.concat([original, Buffer.from('# user edit\r\n')]));
  assert.throws(() => addConfig(patched, 19565));
  assert.throws(() => addConfig(Buffer.from('openai_base_url="elsewhere"'), 19565));
  assert.throws(() => removeConfig(Buffer.from('unrelated'), receipt));
});
