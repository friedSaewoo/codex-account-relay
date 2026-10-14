import { appendFileSync, statSync, renameSync, rmSync } from 'node:fs';

const CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EADDRINUSE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_INVALID_ARG_TYPE', 'ERR_HTTP_HEADERS_SENT', 'ERR_UNHANDLED_ERROR']);
const MODULES = new Set(['manager', 'relay', 'store', 'diagnostics', 'credentials', 'management', 'config', 'usage', 'resets', 'account-rpc', 'probe']);
const TASKS = new Set(['compatibility', 'login', 'usage', 'shutdown', 'relay_request']);

// Never persist error messages, arbitrary properties, absolute paths or raw stacks.
export function safeError(error) {
  const result = { errorCode: null, causeCode: null, frames: [] };
  try {
    if (CODES.has(error?.code)) result.errorCode = error.code;
    if (CODES.has(error?.cause?.code)) result.causeCode = error.cause.code;
    for (const line of String(error?.stack || '').split('\n').slice(1)) {
      const local = line.match(/[/\\]([a-z-]+)\.mjs:(\d+):(\d+)\)?$/);
      const internal = line.match(/(node:[a-z_./-]+):(\d+):(\d+)\)?$/);
      if (local && MODULES.has(local[1])) result.frames.push({ module: `${local[1]}.mjs`, line: Number(local[2]), column: Number(local[3]) });
      else if (internal) result.frames.push({ module: internal[1], line: Number(internal[2]), column: Number(internal[3]) });
      if (result.frames.length >= 8) break;
    }
  } catch {} // Even hostile / unusual exception objects cannot break the logger.
  return result;
}

export function createDiagnostics(path, context = () => ({})) {
  function record(event, error, task = null, origin = null) {
    try {
      let active = null;
      try { const value = context().modelInFlight; if (Number.isSafeInteger(value) && value >= 0) active = value; } catch {}
      const entry = { at: new Date().toISOString(), event, pid: process.pid, ...safeError(error), modelInFlight: active };
      if (TASKS.has(task)) entry.task = task;
      if (['uncaughtException', 'unhandledRejection'].includes(origin)) entry.origin = origin;
      try { if (statSync(path).size > 2 * 1024 * 1024) { rmSync(`${path}.1`, { force: true }); renameSync(path, `${path}.1`); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
      appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch {} // Logging failure must not stop a stream or replace the original fatal error.
  }
  const monitor = (error, origin) => record('manager_fatal', error, null, origin);
  return {
    record,
    run(task, operation) {
      return Promise.resolve().then(operation).catch(error => { record('background_task_failed', error, task); });
    },
    install() {
      // Observe fatal exceptions without suppressing Node's exit / pretending recovery is safe.
      process.on('uncaughtExceptionMonitor', monitor);
      return () => process.removeListener('uncaughtExceptionMonitor', monitor);
    },
  };
}

export async function retryFileOperation(operation, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const delays = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
