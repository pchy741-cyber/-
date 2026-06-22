/**
 * 🔒 매수 의도 레지스트리 (Buy Intent Registry)
 *
 * 전 전략(Track B, Sniper, Opening Bell, After-hours, Cash Parking)에서
 * 매수 주문 전에 등록 → 다른 전략이 같은 종목 중복 매수 방지
 *
 * 프로세스 내 싱글턴 — 모든 전략이 같은 Node.js 프로세스에서 실행되므로
 * DB 없이 메모리 Map으로 충분
 */

import { getCtxIsPaper } from '../config/context.js';
import { logger } from '../utils/logger.js';

interface BuyIntent {
  stockCode: string;
  source: string; // 'TRACK_B' | 'SNIPER' | 'OPENING_BELL' | 'AFTER_HOURS' | 'CASH_PARKING' | 'EOD_BLUECHIP'
  registeredAt: number; // Date.now()
}

/** 매수 의도 TTL (5분) — 파이프라인 3분 간격보다 길되 과도하게 오래 잠기지 않도록 */
const TTL_MS = 5 * 60 * 1000;

// paper/live 모드별 분리 — runDomesticDual() paper→live 순차실행 시 크로스오염 방지
const _intents = new Map<string, Map<string, BuyIntent>>();

function modeIntents(): Map<string, BuyIntent> {
  const mode = getCtxIsPaper() ? 'paper' : 'live';
  if (!_intents.has(mode)) _intents.set(mode, new Map());
  return _intents.get(mode)!;
}

/** 매수 의도 등록 시도. 성공하면 true, 이미 다른 전략이 등록했으면 false */
export function registerBuyIntent(stockCode: string, source: string): boolean {
  cleanup();
  const existing = modeIntents().get(stockCode);
  if (existing) {
    logger.info(
      `🔒 매수의도 충돌: ${stockCode} — ${source} 차단 (이미 ${existing.source}가 ${Math.round((Date.now() - existing.registeredAt) / 1000)}초 전 등록) [${getCtxIsPaper() ? 'paper' : 'live'}]`,
      { component: 'BUY_INTENT' },
    );
    return false;
  }
  modeIntents().set(stockCode, { stockCode, source, registeredAt: Date.now() });
  return true;
}

/** 매수 의도 해제 (주문 실패 또는 취소 시) */
export function releaseBuyIntent(stockCode: string): void {
  modeIntents().delete(stockCode);
}

/** 해당 종목에 이미 매수 의도가 있는지 확인 (읽기 전용) */
export function hasBuyIntent(stockCode: string): boolean {
  cleanup();
  return modeIntents().has(stockCode);
}

/** 현재 등록된 모든 매수 의도 코드 */
export function getAllBuyIntentCodes(): Set<string> {
  cleanup();
  return new Set(modeIntents().keys());
}

/** TTL 만료된 항목 정리 */
function cleanup(): void {
  const now = Date.now();
  for (const [code, intent] of modeIntents()) {
    if (now - intent.registeredAt > TTL_MS) {
      modeIntents().delete(code);
    }
  }
}

/** 테스트/디버그용: 전체 초기화 */
export function clearAllBuyIntents(): void {
  _intents.clear();
}
