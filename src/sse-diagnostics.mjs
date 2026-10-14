import { StringDecoder } from 'node:string_decoder';

const TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const CODES = new Set(['server_overloaded', 'model_capacity_exceeded', 'model_at_capacity', 'rate_limit_exceeded', 'usage_limit_reached', 'server_error', 'internal_server_error', 'invalid_request_error', 'invalid_encrypted_content', 'context_length_exceeded', 'content_policy_violation', 'insufficient_quota']);

// Passive, bounded observation only. Original bytes remain owned by the existing pipeline.
// Never emit response text, error messages, IDs or unrecognized error codes.
export function createSseObserver(record, maxBytes = 65536) {
  const decoder = new StringDecoder('utf8');
  let line = '', lineBytes = 0, lineDropped = false, lines = [], bytes = 0, discarded = false, terminalRecorded = false;
  function finishLine() {
    if (lineDropped) { line = ''; lineBytes = 0; lineDropped = false; return; }
    const current = line.endsWith('\r') ? line.slice(0, -1) : line;
    line = ''; lineBytes = 0;
    if (current === '') {
      if (!discarded && lines.length && !terminalRecorded) {
        try {
          const value = JSON.parse(lines.join('\n'));
          if (TYPES.has(value.type)) {
            const error = value.response?.error || value.error || value;
            const code = CODES.has(error.code) ? error.code : CODES.has(error.type) ? error.type : null;
            const capacity = typeof error.message === 'string' && /selected model is at capacity/i.test(error.message);
            terminalRecorded = true;
            record({ type: value.type, errorCode: code, capacityMessage: capacity });
          }
        } catch {} // Invalid / oversized / diagnostic failures never change forwarding.
      }
      lines = []; bytes = 0; discarded = false;
    } else if (!discarded && current.startsWith('data:')) {
      const data = current.slice(5).replace(/^ /, '');
      bytes += Buffer.byteLength(data, 'utf8');
      if (bytes > maxBytes) { discarded = true; lines = []; }
      else lines.push(data);
    }
  }
  return {
    write(chunk) {
      try {
        const text = decoder.write(chunk);
        for (let start = 0; start < text.length;) {
          const end = text.indexOf('\n', start), stop = end < 0 ? text.length : end;
          if (!lineDropped) {
            const piece = text.slice(start, stop);
            lineBytes += Buffer.byteLength(piece, 'utf8');
            if (lineBytes > maxBytes) { discarded = true; lineDropped = true; line = ''; lines = []; }
            else line += piece;
          }
          if (end < 0) break;
          finishLine(); start = end + 1;
        }
      } catch {}
    },
  };
}
