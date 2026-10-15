import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { usageProvesBusinessRecovery } from './usage.mjs';
import { safeError } from './diagnostics.mjs';
import { createSseObserver } from './sse-diagnostics.mjs';

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;

const PREFIX = '/backend-api/codex';
const MODEL_ROUTES = new Set([`${PREFIX}/responses`, `${PREFIX}/responses/compact`]);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'set-cookie', 'x-openai-actor-authorization']);
const digest = value => createHash('sha256').update(value || '').digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));

export function cleanHeaders(headers, business = false) {
  const hop = new Set([...HOP, ...(headers.connection || '').toLowerCase().split(',').map(x => x.trim())]);
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    if (hop.has(key.toLowerCase()) || value === undefined) continue;
    if (business && ['openai-organization', 'openai-project'].includes(key.toLowerCase())) continue;
    clean[key] = value;
  }
  return clean;
}
function decodedError(body, encoding) {
  const options = { maxOutputLength: 65536 };
  if (encoding === 'gzip') body = gunzipSync(body, options);
  else if (encoding === 'deflate') body = inflateSync(body, options);
  else if (encoding === 'br') body = brotliDecompressSync(body, options);
  else if (encoding === 'zstd') body = zstdDecompressSync(body, options);
  else if (encoding && encoding !== 'identity') return null;
  if (body.length > 65536) return null;
  try { return JSON.parse(body.toString()).error || null; } catch { return null; }
}
export function quotaFailure(body, headers) {
  try {
    const error = decodedError(body, headers['content-encoding']);
    if (!error || ![error.type, error.code].includes('usage_limit_reached')) return null;
    const at = Number(error.resets_at);
    return { resetAt: Number.isFinite(at) && at * 1000 > Date.now() ? at * 1000 : null };
  } catch { return null; }
}
async function readBounded(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large.'), { code: 'BODY_LIMIT' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function response(res, status, code) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: code, message: code } }));
}

export function createRelay({ getPro, getBusiness, audit = () => {}, initialQuota = null, persistQuota = async () => {}, upstream = 'https://chatgpt.com', allowTestUpstream = false, maxBody = 64 * 1024 * 1024, timeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS, fallbackOnBusinessAuthError = false, unknownQuotaRetryMs = 0, passThroughCodexRoutes = false }) {
  const base = new URL(upstream);
  if (base.origin !== 'https://chatgpt.com' && !(allowTestUpstream && base.hostname === '127.0.0.1' && base.protocol === 'http:')) throw new Error('Untrusted upstream.');
  // Old state without a rejection timestamp requires a new query after this startup.
  let quota = initialQuota ? { ...initialQuota, blockedAt: Number.isFinite(initialQuota.blockedAt) ? initialQuota.blockedAt : Date.now() } : null;
  let completed = 0;
  const stats = { requests: 0, business: 0, pro: 0, modelBusiness: 0, modelPro: 0, auxiliaryPro: 0, compactBusiness: 0, compactPro: 0, modelInFlight: 0, lastModelRoute: null, lastModel: null, fallbacks: 0, upgradesRejected: 0, lastRoute: null, lastStatus: null };
  const emit = entry => { try { audit({ at: new Date().toISOString(), ...entry }); } catch {} };
  const getStatus = () => ({ ...stats, businessBlocked: !!quota && (!quota.resetAt || quota.resetAt > Date.now()), quotaResetAt: quota?.resetAt || null, completed });

  async function authorize(req) {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return null;
    if (req.headers.origin || req.headers['sec-fetch-site']) return null;
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expectedHost) return null;
    const pro = await getPro();
    if (!equal(req.headers.authorization, `Bearer ${pro.token}`)) return null;
    if (req.headers['chatgpt-account-id'] && !equal(req.headers['chatgpt-account-id'], pro.accountId)) return null;
    return pro;
  }

  async function handleRequest(req, res) {
    let upstreamRequest;
    let upstreamResponse;
    let aborted = false;
    let countedModel = false;
    const startedAt = Date.now();
    let disconnectOrigin = null, transportCode = null, upstreamBytes = 0, forwardedRoute = null;
    const noteDisconnect = (origin, error) => {
      if (!disconnectOrigin) disconnectOrigin = origin;
      if (!transportCode && typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code)) transportCode = error.code;
    };
    res.once('error', error => noteDisconnect('client_write', error));
    res.on('close', () => {
      if (res.writableFinished) return;
      noteDisconnect('client_close');
      aborted = true;
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
    });
    const id = randomUUID();
    try {
      const pro = await authorize(req);
      if (!pro) { req.resume(); return response(res, 403, 'relay_forbidden'); }
      const url = new URL(req.url, 'http://relay.invalid');
      if (req.method === 'GET' && req.url === '/relay/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ kind: 'codex-account-relay', ...getStatus() }));
      }
      // Exact raw paths prevent traversal, encoded path tricks, and absolute-form proxy requests.
      const rawPath = req.url.split('?')[0];
      if (!req.url.startsWith('/') || req.url.startsWith('//') || url.origin !== 'http://relay.invalid' || rawPath.includes('%') || rawPath.includes('..') || rawPath.includes('\\')) return response(res, 404, 'relay_route_not_supported');
      const model = MODEL_ROUTES.has(url.pathname) && req.method === 'POST';
      const models = url.pathname === `${PREFIX}/models` && req.method === 'GET';
      const auxiliary = passThroughCodexRoutes && url.pathname.startsWith(`${PREFIX}/`) && ['GET', 'POST'].includes(req.method);
      if (!model && !models && !auxiliary) { req.resume(); emit({ event: 'route_rejected', id }); return response(res, 404, 'relay_route_not_supported'); }
      if (model) { stats.modelInFlight++; countedModel = true; }
      const body = await readBounded(req, maxBody);
      let modelName = null;
      if (model) {
        try {
          let decoded = body;
          const options = { maxOutputLength: maxBody };
          const encoding = req.headers['content-encoding'];
          if (encoding === 'gzip') decoded = gunzipSync(body, options);
          else if (encoding === 'deflate') decoded = inflateSync(body, options);
          else if (encoding === 'br') decoded = brotliDecompressSync(body, options);
          else if (encoding === 'zstd') decoded = zstdDecompressSync(body, options);
          const value = JSON.parse(decoded.toString()).model;
          if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value)) modelName = value;
        } catch {} // Metadata must never change forwarding of the original body.
      }
      if (aborted) return;
      stats.requests++;
      let business = null;
      if (model && (!quota || (quota.resetAt && quota.resetAt <= Date.now()))) {
        try { business = await getBusiness(); }
        catch (error) {
          if (!fallbackOnBusinessAuthError) throw error;
          emit({ event: 'business_auth_fallback', id, route: 'pro' });
        }
      }
      if (business && business.accountId === pro.accountId) throw new Error('Business and Pro workspace must differ.');
      let chosen = business ? 'business' : 'pro';
      let credentials = business || pro;
      // Only a rejected quota request or opt-in authentication rejection unlocks attempt 2.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (aborted) return;
        forwardedRoute = chosen;
        stats[chosen]++;
        stats.lastRoute = chosen;
        if (model) {
          stats[chosen === 'business' ? 'modelBusiness' : 'modelPro']++;
          if (url.pathname.endsWith('/compact')) stats[chosen === 'business' ? 'compactBusiness' : 'compactPro']++;
          stats.lastModelRoute = chosen;
          stats.lastModel = modelName;
        } else { stats.auxiliaryPro++; }
        const headers = cleanHeaders(req.headers, chosen === 'business');
        headers.authorization = `Bearer ${credentials.token}`;
        headers['chatgpt-account-id'] = credentials.accountId;
        headers['content-length'] = String(body.length);
        headers['accept-encoding'] = 'identity';
        emit({ event: 'attempt', id, route: chosen, path: url.pathname, kind: model ? 'model' : 'auxiliary', ...(modelName ? { model: modelName } : {}), attempt: attempt + 1 });
        const transport = base.protocol === 'https:' ? https : http;
        upstreamResponse = await new Promise((resolve, reject) => {
          // Destination stays fixed even if a client submits an unusual request target.
          const outgoing = transport.request(new URL(url.pathname + url.search, base), { method: req.method, headers }, incoming => {
            // Subscribe in the response callback, before any await resumes / cancellation can destroy it.
            incoming.once('error', error => noteDisconnect('upstream_stream', error));
            resolve(incoming);
          });
          upstreamRequest = outgoing;
          outgoing.setTimeout(timeoutMs, () => {
            noteDisconnect('upstream_timeout', { code: 'ETIMEDOUT' });
            // A previous Business attempt must never destroy a later Pro request.
            outgoing.destroy(new Error('Upstream timeout.'));
          });
          outgoing.on('error', error => { noteDisconnect('upstream_connection', error); reject(error); });
          outgoing.end(body);
        });
        const status = upstreamResponse.statusCode;
        stats.lastStatus = status;
        emit({ event: 'response', id, route: chosen, status });
        if (chosen === 'business' && status === 401 && fallbackOnBusinessAuthError) {
          upstreamResponse.destroy();
          emit({ event: 'business_auth_fallback', id, route: 'pro' });
          chosen = 'pro'; credentials = await getPro();
          continue;
        }
        if (chosen === 'business' && status === 429) {
          const errorBody = await readBounded(upstreamResponse, 65536);
          const failure = quotaFailure(errorBody, upstreamResponse.headers);
          if (failure) {
            quota = { ...failure, blockedAt: Date.now(), accountKey: digest(credentials.accountId).toString('hex') };
            if (!quota.resetAt && unknownQuotaRetryMs > 0) quota.resetAt = Date.now() + unknownQuotaRetryMs;
            await persistQuota(quota);
            stats.fallbacks++;
            emit({ event: 'quota_fallback', id, route: 'pro', resetAt: quota.resetAt });
            chosen = 'pro';
            // Get current Pro access token; never rotate Pro refresh tokens in the relay.
            credentials = await getPro();
            continue;
          }
          res.writeHead(status, cleanHeaders(upstreamResponse.headers));
          res.end(errorBody);
        } else {
          // Record which side first interrupted the stream. pipeline may then close both sides.
          // Terminal metadata only; no error messages, text, IDs or unknown codes are logged.
          // The live Codex endpoint can omit Content-Type on otherwise valid SSE output.
          const contentType = String(upstreamResponse.headers['content-type'] || '').toLowerCase();
          const observableSse = (contentType.includes('text/event-stream') || (!contentType && model && url.pathname === `${PREFIX}/responses`)) &&
            ['identity', undefined].includes(upstreamResponse.headers['content-encoding']);
          const observer = observableSse ? createSseObserver(terminal => emit({ event: 'sse_terminal', id, route: chosen, ...terminal })) : null;
          upstreamResponse.once('aborted', () => noteDisconnect('upstream_stream'));
          upstreamResponse.on('data', chunk => { upstreamBytes += chunk.length; observer?.write(chunk); });
          res.writeHead(status, cleanHeaders(upstreamResponse.headers));
          res.flushHeaders();
          // Original bytes / backpressure / cancellation unchanged; accepted output stays single-shot.
          await pipeline(upstreamResponse, res);
        }
        completed++;
        return;
      }
    } catch (error) {
      const desktopError = ['DESKTOP_PRO_REQUIRED', 'DESKTOP_AUTH_UNAVAILABLE'].includes(error.code);
      const upstreamFailure = disconnectOrigin?.startsWith('upstream');
      const encoding = upstreamResponse?.headers['content-encoding'] || 'identity';
      emit({ event: upstreamFailure ? 'upstream_error' : aborted ? 'client_closed' : 'relay_error', id,
        code: error.code === 'BODY_LIMIT' ? 'body_limit' : upstreamFailure ? 'upstream_transport_error' : aborted ? 'client_disconnected' : desktopError ? error.code.toLowerCase() : 'transport_or_credential_error',
        origin: disconnectOrigin || 'relay', transportCode, route: forwardedRoute, durationMs: Date.now() - startedAt,
        upstreamBytes, upstreamHttpComplete: upstreamResponse?.complete === true,
        upstreamEncoding: ['identity', 'gzip', 'br', 'deflate', 'zstd'].includes(encoding) ? encoding : 'other' });
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
      response(res, error.code === 'BODY_LIMIT' ? 413 : desktopError ? 409 : 502, error.code === 'BODY_LIMIT' ? 'relay_body_limit' : desktopError ? `relay_${error.code.toLowerCase()}` : 'relay_upstream_failed');
    } finally {
      if (countedModel) stats.modelInFlight--;
    }
  }
  const server = http.createServer((req, res) => {
    // EventEmitter does not await an async request listener. Contain even cleanup failures
    // to this one connection so other accepted model streams can keep running.
    void handleRequest(req, res).catch(error => {
      emit({ event: 'relay_handler_failed', ...safeError(error) });
      res.destroy();
    });
  });
  server.on('upgrade', async (req, socket) => {
    // HTTP relinquishes the raw socket on upgrade. A reset after the 426 reply
    // is an EventEmitter error, not a rejected promise caught by the try below.
    // Register before authorization yields so it cannot terminate other SSE streams.
    socket.on('error', error => {
      emit({ event: 'upgrade_socket_error', ...safeError(error) });
      socket.destroy();
    });
    try {
      if (!await authorize(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      stats.upgradesRejected++;
      emit({ event: 'websocket_rejected' });
      socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch { socket.destroy(); }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  async function resumeBusinessFromUsage(usage) {
    const observed = quota;
    if (!getStatus().businessBlocked) return false;
    const business = await getBusiness();
    if (!business || quota !== observed || !usageProvesBusinessRecovery(usage, observed, digest(business.accountId).toString('hex'))) return false;
    quota = null;
    try { await persistQuota(null); }
    catch (error) { if (quota === null) quota = observed; throw error; }
    emit({ event: 'business_quota_recovered', source: 'usage_query' });
    return true;
  }
  return { server, getStatus, resumeBusinessFromUsage, resetQuota: async () => { quota = null; await persistQuota(null); }, listen: (port = 19565) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  }), close: ({ force = true } = {}) => new Promise(resolve => { if (force) server.closeAllConnections(); server.close(resolve); }) };
}
