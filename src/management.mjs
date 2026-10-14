export const MODES = new Set(['auto', 'pro', 'off']);
export function validSettings(value) {
  return { mode: MODES.has(value?.mode) ? value.mode : 'auto' };
}
export function businessAllowed({ mode, compatibility, businessRetryAt = 0, loginInProgress = false }, now = Date.now()) {
  return mode === 'auto' && compatibility === 'passed' && !loginInProgress && businessRetryAt <= now;
}
export function compatibilityPassed(report) {
  return report?.mode === 'cli' && report.desktopAuthUnchanged === true && report.desktopConfigUnchanged === true &&
    ['business', 'pro'].every(route => report.tests?.some(t => t.name === 'bundled_cli' && t.route === route && t.exit === 0 && t.markerReturned === true));
}
export function needsCompatibilityCheck(cached, signature, now = Date.now()) {
  if (!cached || cached.signature !== signature) return true;
  return cached.result !== 'passed' && now >= (cached.retryAt || 0);
}
export function compatibilityRetryDelay(failures) {
  return failures <= 1 ? 120000 : failures === 2 ? 600000 : 3600000;
}
export function userStatus({ mode, compatibility, configActive, configError = false, desktopReady = true, needsLogin, loginInProgress, businessBlocked, lastRoute }) {
  if (configError) return { label: '기본 연결 복구 실패', detail: '중계 설정이 남아 있습니다. 복구를 완료할 때까지 기본 연결로 돌아갔다고 볼 수 없습니다.', attention: 'configuration' };
  if (mode === 'off') return { label: '기본 Pro 연결', detail: '중계 설정을 복구했습니다. 이미 열린 대화는 앱을 다음에 시작할 때 반영될 수 있습니다.', attention: null };
  if (!desktopReady) return { label: 'Codex Pro 로그인 확인 필요', detail: '앱의 Pro 인증을 확인할 수 없어 계정 중계를 중지했습니다. 기본 연결로 복구하며 앱에서 로그인 상태를 확인해주세요.', attention: 'desktop-login' };
  if (loginInProgress) return { label: 'Business 로그인 중', detail: '브라우저에서 로그인을 완료해주세요. 모델 요청은 Pro로 처리합니다.', attention: null };
  if (compatibility === 'checking') return { label: '업데이트 호환성 확인 중', detail: '짧은 테스트가 끝나면 자동으로 연결합니다.', attention: null };
  if (compatibility !== 'passed') return { label: 'Pro 연결 · 자동 재검사 대기', detail: '호환성 확인을 다시 시도합니다. 기본 경로 복구는 다음 앱 실행에 반영될 수 있습니다.', attention: 'compatibility' };
  if (!configActive) return { label: '설정 확인 필요', detail: '사용자 설정과 충돌하여 자동 적용하지 않았습니다.', attention: 'configuration' };
  if (needsLogin) return { label: 'Pro 사용 · Business 재연결 필요', detail: '계속 작업할 수 있습니다. 메뉴에서 Business 다시 로그인을 선택하세요.', attention: 'business-login' };
  if (mode === 'pro') return { label: 'Pro 사용', detail: '수동으로 Pro만 사용하도록 설정했습니다.', attention: null };
  if (businessBlocked) return { label: 'Pro 사용 · Business 한도 대기', detail: '한도 복구 시 Business를 자동으로 다시 시도합니다.', attention: null };
  return { label: lastRoute === 'business' ? 'Business 사용 중' : 'Business 우선 · 자동 관리 중', detail: '평소처럼 Codex를 사용하세요. 한도 소진 시 Pro로 전환합니다.', attention: null };
}
export function assistantSaidMarker(output, marker) {
  return output.split(/\r?\n/).some(line => {
    try { const event = JSON.parse(line); return event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.trim() === marker; }
    catch { return false; }
  });
}
