import { readFile, stat } from 'node:fs/promises';
import { writeJson } from '../src/store.mjs';
const challenge = JSON.parse(await readFile(new URL('../dot-probe/challenge.json', import.meta.url), 'utf8'));
const results = {};
for (const phase of ['before', 'after']) {
  const path = new URL(`../dot-probe/${phase}.json`, import.meta.url);
  try {
    const actual = JSON.parse(await readFile(path, 'utf8'));
    results[phase] = { exists: true, nonceMatches: actual.nonce === challenge.nonce, phaseMatches: actual.phase === phase, modified: (await stat(path)).mtime.toISOString() };
  } catch (error) {
    results[phase] = { exists: error.code !== 'ENOENT', valid: false };
  }
}
const report = { at: new Date().toISOString(), phases: results, passed: ['before', 'after'].every(p => results[p].nonceMatches && results[p].phaseMatches) };
await writeJson(new URL('../reports/dot-files.json', import.meta.url), report);
console.log(JSON.stringify(report, null, 2));
