// Local diagnostics only. Generated reports are excluded from Git.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readDesktopAuth, stateHome } from '../src/credentials.mjs';
import { readJson, writeJson } from '../src/store.mjs';
const auth = await readDesktopAuth();
const runtime = await readJson(join(stateHome, 'manager-status.json'));
const report = {
  at: new Date().toISOString(), implementation: 'Windows tray with local HTTP/SSE relay',
  desktopPlan: auth.plan, mode: runtime?.mode ?? null,
  compatibility: runtime?.compatibility ?? null, configActive: runtime?.configActive ?? null,
  modelRequests: { business: runtime?.modelBusiness ?? null, pro: runtime?.modelPro ?? null },
  auxiliaryProRequests: runtime?.auxiliaryPro ?? null,
  note: 'Status is diagnostic metadata, not proof of model completion or a new dot PC test.',
};
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeJson(new URL('../reports/verification.json', import.meta.url), report);
console.log(JSON.stringify(report, null, 2));
