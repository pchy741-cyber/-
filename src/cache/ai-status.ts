// AI 실행 엔진 상태 캐시 — executor에서 갱신, API/대시보드에서 읽기

export type AiEngineStatus = 'ok' | 'no_credit' | 'quota' | 'error' | 'unknown';

// 일반 에러는 30분 후 재시도, quota 초과는 24시간 대기 (무료 티어 일일 한도)
const ERROR_TTL_MS = 30 * 60 * 1000;
const QUOTA_TTL_MS = 24 * 60 * 60 * 1000;

interface AiStatus {
  claude: AiEngineStatus;
  gemini: AiEngineStatus;
  activeEngine: 'claude' | 'gemini' | 'technical' | 'none';
  lastUpdatedAt: number; // epoch ms
  claudeErrorAt?: number;
  geminiErrorAt?: number;
  claudeErrorMsg?: string;
  geminiErrorMsg?: string;
}

const _status: AiStatus = {
  claude: 'unknown',
  gemini: 'unknown',
  activeEngine: 'none',
  lastUpdatedAt: 0,
};

export function setClaudeStatus(status: AiEngineStatus, errorMsg?: string): void {
  _status.claude = status;
  _status.lastUpdatedAt = Date.now();
  if (status === 'error' || status === 'quota' || status === 'no_credit') {
    _status.claudeErrorAt = Date.now();
  } else {
    delete _status.claudeErrorAt;
  }
  if (errorMsg) _status.claudeErrorMsg = errorMsg;
  else delete _status.claudeErrorMsg;
}

export function setGeminiStatus(status: AiEngineStatus, errorMsg?: string): void {
  _status.gemini = status;
  _status.lastUpdatedAt = Date.now();
  if (status === 'error' || status === 'quota') {
    _status.geminiErrorAt = Date.now();
  } else {
    delete _status.geminiErrorAt;
  }
  if (errorMsg) _status.geminiErrorMsg = errorMsg;
  else delete _status.geminiErrorMsg;
}

export function setActiveEngine(engine: AiStatus['activeEngine']): void {
  _status.activeEngine = engine;
  _status.lastUpdatedAt = Date.now();
}

export function getAiStatus(): Readonly<AiStatus> {
  // quota/error 30분 경과 시 자동 만료 → 재시도 허용
  const now = Date.now();
  if (_status.gemini === 'quota' && _status.geminiErrorAt && now - _status.geminiErrorAt > QUOTA_TTL_MS) {
    _status.gemini = 'unknown';
    delete _status.geminiErrorAt;
    delete _status.geminiErrorMsg;
  }
  if (_status.gemini === 'error' && _status.geminiErrorAt && now - _status.geminiErrorAt > ERROR_TTL_MS) {
    _status.gemini = 'unknown';
    delete _status.geminiErrorAt;
    delete _status.geminiErrorMsg;
  }
  if (
    (_status.claude === 'error') &&
    _status.claudeErrorAt &&
    now - _status.claudeErrorAt > ERROR_TTL_MS
  ) {
    _status.claude = 'unknown';
    delete _status.claudeErrorAt;
    delete _status.claudeErrorMsg;
  }
  return _status;
}
