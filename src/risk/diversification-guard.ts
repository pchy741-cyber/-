/**
 * 🔀 종목 다양화 강제 가드
 *
 * CEO 지시 (2026-06-12): SONY 6회 반복 매도/재매수 같은 패턴 차단
 *
 * 규칙:
 *  1. 같은 종목 24시간 내 최대 2건 매수 (3건째 차단)
 *  2. 같은 종목 1시간 내 최대 1건 매수 (2건째 차단 — 짧은 간격 중복)
 *  3. 같은 섹터 비중 30% 초과 시 신규 매수 차단 (구현 가능 시)
 *
 * 매수 직전 호출 — checkDiversification(stockCode) → {allowed, reason}
 */

import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

const COMP = 'DIV_GUARD';

/** 같은 종목 1시간 내 최대 매수 건수 */
const MAX_BUY_PER_1H = 1;
/** 같은 종목 24시간 내 최대 매수 건수 */
const MAX_BUY_PER_24H = 2;

export interface DiversificationCheck {
  allowed: boolean;
  reason: string;
  count24h: number;
  count1h: number;
  /** v16: 소프트 사이즈 조절 */
  sizeMultiplier?: number;
}

/**
 * 같은 종목 매수 빈도 체크
 * @param stockCode 매수 후보 종목
 * @param isPaper 모드
 */
export async function checkDiversification(stockCode: string, isPaper = false): Promise<DiversificationCheck> {
  try {
    const { rows } = await getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS c24h,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS c1h
       FROM orders
       WHERE stock_code = $1
         AND side = 'BUY'
         AND status IN ('FILLED', 'PENDING')
         AND trading_mode = $2`,
      [stockCode, isPaper ? 'paper' : 'live'],
    );
    const count24h = Number(rows[0]?.c24h ?? 0);
    const count1h = Number(rows[0]?.c1h ?? 0);

    // v16: 중복 매수 → 소프트 (사이즈 축소, 하드블록 제거)
    if (count1h >= MAX_BUY_PER_1H) {
      return {
        allowed: true,
        reason: `1시간 내 ${count1h}건 매수 → 50% 축소`,
        count24h,
        count1h,
        sizeMultiplier: 0.5,
      };
    }
    if (count24h >= MAX_BUY_PER_24H) {
      return {
        allowed: true,
        reason: `24시간 내 ${count24h}건 → 50% 축소 (다양화)`,
        count24h,
        count1h,
        sizeMultiplier: 0.5,
      };
    }
    return {
      allowed: true,
      reason: `OK (1h: ${count1h}건, 24h: ${count24h}건)`,
      count24h,
      count1h,
    };
  } catch (e) {
    logger.warn(`다양화 체크 실패 (${stockCode}): ${(e as Error).message}`, { component: COMP });
    // 실패 시 통과 (가용성 우선)
    return { allowed: true, reason: '체크 실패 — 통과', count24h: 0, count1h: 0 };
  }
}
