import test from 'node:test';
import assert from 'node:assert/strict';
import { businessAllowed, compatibilityPassed, needsCompatibilityCheck, validSettings, userStatus, assistantSaidMarker } from '../src/management.mjs';
test('unverified/new versions and authentication cooldown never send Business traffic', () => {
  assert(businessAllowed({ mode: 'auto', compatibility: 'passed' }));
  for (const change of [{ mode: 'off' }, { mode: 'pro' }, { compatibility: 'checking' }, { compatibility: 'failed' }, { loginInProgress: true }, { businessRetryAt: Date.now() + 60000 }]) {
    assert(!businessAllowed({ mode: 'auto', compatibility: 'passed', ...change }));
  }
});
test('compatibility success requires both account responses and unchanged desktop files', () => {
  const report = { mode: 'cli', desktopAuthUnchanged: true, desktopConfigUnchanged: true, tests: ['business', 'pro'].map(route => ({ name: 'bundled_cli', route, exit: 0, markerReturned: true })) };
  assert(compatibilityPassed(report));
  assert(!compatibilityPassed({ ...report, desktopAuthUnchanged: false }));
  assert(!compatibilityPassed({ ...report, tests: report.tests.slice(0, 1) }));
  assert(!compatibilityPassed({ ...report, tests: report.tests.map(t => ({ ...t, markerReturned: false })) }));
});
test('same verified version does not repeatedly spend model quota; changed version rechecks', () => {
  const cached = { signature: 'version-a', result: 'passed' };
  assert(!needsCompatibilityCheck(cached, 'version-a'));
  assert(needsCompatibilityCheck(cached, 'version-b'));
  assert(!needsCompatibilityCheck({ ...cached, result: 'failed', retryAt: Date.now() + 60000 }, 'version-a'));
  assert(needsCompatibilityCheck({ ...cached, result: 'failed', retryAt: Date.now() - 1 }, 'version-a'));
});
test('a marker in echoed input is not counted as a model response', () => {
  assert(!assistantSaidMarker('User: reply MARKER', 'MARKER'));
  assert(!assistantSaidMarker(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'MARKER' } }), 'MARKER'));
  assert(assistantSaidMarker(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'MARKER' } }), 'MARKER'));
});
test('routine quota fallback stays quiet and actionable failures carry a notification key', () => {
  const state = { mode: 'auto', compatibility: 'passed', configActive: true };
  assert.equal(userStatus({ ...state, businessBlocked: true }).attention, null);
  assert.equal(userStatus({ ...state, needsLogin: true }).attention, 'business-login');
  assert.equal(userStatus({ ...state, compatibility: 'failed' }).attention, 'compatibility');
  assert.equal(userStatus({ ...state, mode: 'off' }).attention, null);
  assert.equal(validSettings({ mode: 'arbitrary' }).mode, 'auto');
});

test('configuration rollback failure overrides success labels in off and failed modes', () => {
  for (const mode of ['off', 'auto']) {
    const display = userStatus({ mode, compatibility: 'failed', configActive: true, configError: true });
    assert.equal(display.label, '기본 연결 복구 실패');
    assert.equal(display.attention, 'configuration');
  }
  assert.equal(userStatus({ mode: 'auto', compatibility: 'passed', configActive: false, desktopReady: false }).attention, 'desktop-login');
});
