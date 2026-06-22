/**
 * Paper→Live 시그널 브릿지 — 연습모드 해외 매수 후보를 실전모드에 전달
 *
 * runOverseasDual()에서 paper 먼저 실행 → buyTargets 저장 → live에서 score 부스트
 * 인메모리 단발성 — 매 사이클 덮어쓰기 (TTL 30분)
 */

import { logger } from '../../utils/logger.js';

interface PaperSignal {
  code: string;
  score: number;
  aiConfidence: number;
  sector: string;
}

let _paperSignals: PaperSignal[] = [];
let _signalTimestamp = 0;
const SIGNAL_TTL_MS = 30 * 60_000; // 30분

/** Paper 사이클 완료 후 매수 후보 저장 */
export function setPaperBuySignals(
  signals: Array<{ code: string; score: number; ai?: { confidence?: number }; sector: string }>,
): void {
  _paperSignals = signals.map((s) => ({
    code: s.code,
    score: s.score,
    aiConfidence: s.ai?.confidence ?? 0,
    sector: s.sector,
  }));
  _signalTimestamp = Date.now();
  if (_paperSignals.length > 0) {
    logger.info(
      `📡 Paper→Live 브릿지: ${_paperSignals.length}종목 저장 — ${_paperSignals.slice(0, 5).map((s) => `${s.code}(${s.score}점)`).join(', ')}`,
      { component: 'PAPER_BRIDGE' },
    );
  }
}

/** Live 사이클에서 Paper 검증 종목 코드 Set 조회 (TTL 만료 시 빈 Set) */
export function getPaperValidatedCodes(): Set<string> {
  if (Date.now() - _signalTimestamp > SIGNAL_TTL_MS) return new Set();
  return new Set(_paperSignals.map((s) => s.code));
}

/** Live 사이클에서 특정 종목의 Paper 시그널 점수 조회 (없으면 0) */
export function getPaperSignalScore(code: string): number {
  if (Date.now() - _signalTimestamp > SIGNAL_TTL_MS) return 0;
  return _paperSignals.find((s) => s.code === code)?.score ?? 0;
}
