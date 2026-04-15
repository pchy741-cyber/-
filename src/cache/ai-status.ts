// AI 실행 엔진 상태 캐시 — executor에서 갱신, API/대시보드에서 읽기

export type AiEngineStatus = 'ok' | 'no_credit' | 'quota' | 'error' | 'unknown';

interface AiStatus {
  claude: AiEngineStatus;
  gemini: AiEngineStatus;
  activeEngine: 'claude' | 'gemini' | 'technical' | 'none';
  lastUpdatedAt: number; // epoch ms
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
  if (errorMsg) _status.claudeErrorMsg = errorMsg;
  else delete _status.claudeErrorMsg;
}

export function setGeminiStatus(status: AiEngineStatus, errorMsg?: string): void {
  _status.gemini = status;
  _status.lastUpdatedAt = Date.now();
  if (errorMsg) _status.geminiErrorMsg = errorMsg;
  else delete _status.geminiErrorMsg;
}

export function setActiveEngine(engine: AiStatus['activeEngine']): void {
  _status.activeEngine = engine;
  _status.lastUpdatedAt = Date.now();
}

export function getAiStatus(): Readonly<AiStatus> {
  return _status;
}
