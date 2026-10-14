import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseObserver } from '../src/sse-diagnostics.mjs';

test('split UTF-8 and CRLF frames record only allowlisted upstream terminal metadata', () => {
  const events = [], observer = createSseObserver(e => events.push(e));
  const bytes = Buffer.from('data: {"type":"response.output_text.delta","delta":"비밀 Selected model is at capacity"}\r\n\r\ndata: {"type":"response.failed","response":{"id":"private-id","error":{"code":"server_overloaded","message":"Selected model is at capacity. PRIVATE_SECRET"}}}\r\n\r\n');
  for (const byte of bytes) observer.write(Buffer.from([byte]));
  assert.deepEqual(events, [{ type: 'response.failed', errorCode: 'server_overloaded', capacityMessage: true }]);
  assert(!/private|PRIVATE|비밀|Selected/.test(JSON.stringify(events)));
});

test('oversized / invalid events cannot spoof a terminal event and parsing resumes after a real blank line', () => {
  const events = [], observer = createSseObserver(e => events.push(e), 128);
  observer.write(Buffer.from('data: '+ 'x'.repeat(200)));
  observer.write(Buffer.from('\ndata: {"type":"response.failed","error":{"code":"server_overloaded"}}\n\n'));
  assert.equal(events.length, 0);
  observer.write(Buffer.from('data: invalid json\n\ndata: {"type":"response.completed"}\n\n'));
  assert.deepEqual(events, [{ type: 'response.completed', errorCode: null, capacityMessage: false }]);
});

test('multiline events and observer failures never propagate or disclose arbitrary error codes', () => {
  const events=[], observer=createSseObserver(e=>events.push(e));
  observer.write(Buffer.from('data: {"type":"error",\ndata: "code":"PRIVATE_TOKEN", "message":"secret"}\n\n'));
  assert.deepEqual(events,[{type:'error',errorCode:null,capacityMessage:false}]);
  assert.doesNotThrow(()=>createSseObserver(()=>{throw new Error('failure');}).write(Buffer.from('data: {"type":"response.completed"}\n\n')));
});
