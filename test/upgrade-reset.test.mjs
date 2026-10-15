import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const inject of [true, false]) test(`WebSocket ${inject ? 'injected socket reset' : 'real TCP reset'} leaves the process and an accepted SSE response alive`, { timeout: 15000 }, async t => {
  let finish;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = () => res.end('data: completed\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const fixture = fileURLToPath(new URL('./fixtures/upgrade-reset.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture, String(upstream.address().port), inject ? 'inject-reset' : 'real-reset'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  const events = [];
  child.on('message', message => events.push(message));
  let socket;
  t.after(async () => {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const port = await new Promise((resolve, reject) => {
    child.once('message', message => resolve(message.port));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Fixture stopped before ready: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: 'Bearer fixture-pro', 'chatgpt-account-id': 'fixture-account' };
  const response = await fetch(`${base}/backend-api/codex/responses`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: first\n\n');
  const reply = await new Promise((resolve, reject) => {
    socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true }, () => {
      socket.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer fixture-pro\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    socket.on('error', reject);
    socket.once('data', data => { resolve(data.toString()); if (!inject) socket.resetAndDestroy(); });
  });
  assert.match(reply, /426/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, 'One upgraded socket error must not terminate the manager');
  assert.equal(child.signalCode, null);
  assert(events.some(event => event.event === 'upgrade_socket_error' && event.errorCode === 'ECONNRESET'));
  finish();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: completed\n\n');
  assert.equal((await reader.read()).done, true);
  const health = await fetch(`${base}/relay/health`, { headers });
  assert.equal(health.status, 200); await health.text();
});
