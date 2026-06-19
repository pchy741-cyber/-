import { getCtxIsPaper } from '../../config/context.js';
import { isMemoryMode, queryWithRetry } from '../pool.js';
import { logger } from '../../utils/logger.js';

/** CEO 수동 매도 후 N시간 이내 재진입 금지 종목 반환 */
export async function getRecentManuallySoldStocks(hoursBack = 24): Promise<Set<string>> {
  if (isMemoryMode()) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND close_reason = 'CEO 수동 매도'
         AND is_paper = $1
         AND closed_at > NOW() - ($2 || ' hours')::interval`,
      [getCtxIsPaper(), hoursBack],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

/** 최근 매도(CLOSED) 종목 쿨다운 — v10.4: 모든 매도에 동일 쿨다운 적용 (churning 방지)
 *  기존 익절(+3%↑) 면제, 승률 70%+ 5분 단축 제거 → 반복 매매 = 적자 주범
 */
export async function getRecentlySoldStocks(hoursBack = 4): Promise<Set<string>> {
  if (isMemoryMode()) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code
       FROM transaction_chains
       WHERE status = 'CLOSED'
         AND is_paper = $1
         AND closed_at > NOW() - ($2 || ' hours')::interval`,
      [getCtxIsPaper(), hoursBack],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}

// 리스크 쿨다운 마지막 성공값 캐시 — DB 오류/메모리 모드 시 fail-closed
const _lossStocksCache = new Map<string, Set<string>>();
const _bigLossStocksCache = new Map<string, Set<string>>();

/** 최근 손절 종목 코드 반환 (졸업식 재진입 방지)
 *  - 일반 손실(>5000원): 7일 차단
 *  - 대손실(>50000원): 14일 차단
 *  - ATR/손절 사유 매도: 7일 차단 (같은 패턴 반복 방지)
 */
export async function getRecentLossStocks(_daysBack = 14): Promise<Set<string>> {
  const cacheKey = String(getCtxIsPaper());
  if (isMemoryMode()) {
    // 메모리 모드: 마지막 DB 조회 캐시 사용 (fail-closed). 캐시 없으면 빈 Set.
    return _lossStocksCache.get(cacheKey) ?? new Set();
  }
  try {
    // 1) 일반 손실 7일 + 대손실 14일 졸업식 차단
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND is_paper = $1
         AND (
           (realized_pnl < -5000  AND closed_at > NOW() - INTERVAL '7 days')
           OR
           (realized_pnl < -50000 AND closed_at > NOW() - INTERVAL '14 days')
         )`,
      [getCtxIsPaper()],
    );
    const blocked = new Set(rows.map((r: { stock_code: string }) => r.stock_code));

    // 2) ATR/손절 사유로 매도된 종목 7일 추가 차단
    const { rows: slRows } = await queryWithRetry(
      `SELECT DISTINCT o.stock_code FROM orders o
       WHERE o.side = 'SELL' AND o.status = 'FILLED'
         AND o.is_paper = $1
         AND o.created_at > NOW() - INTERVAL '7 days'
         AND (o.ai_reasoning LIKE '%손절%' OR o.ai_reasoning LIKE '%ATR트레일%'
              OR o.ai_reasoning LIKE '%FORCE_CLOSE%' OR o.ai_reasoning LIKE '%시간 손절%')`,
      [getCtxIsPaper()],
    );
    for (const r of slRows) blocked.add(r.stock_code);

    _lossStocksCache.set(cacheKey, blocked);
    return blocked;
  } catch (e) {
    const cached = _lossStocksCache.get(cacheKey);
    if (cached) {
      logger.warn(`getRecentLossStocks DB 오류 — 캐시된 쿨다운 ${cached.size}개 반환 (fail-closed)`, { component: 'DB' });
      return cached;
    }
    logger.error(`getRecentLossStocks DB 오류 — 캐시 없음, 예외 전파: ${e}`, { component: 'DB' });
    throw e;
  }
}

/**
 * 5% 초과 손실 매도 종목 — 30일 절대 차단 (CEO allowRebuy override 없이 재매수 불가)
 * AI 점수와 무관하게 차단. 손해보고 판 걸 또 사는 건 금지.
 */
export async function getBigLossBlockedStocks(): Promise<Set<string>> {
  const cacheKey = String(getCtxIsPaper());
  if (isMemoryMode()) {
    return _bigLossStocksCache.get(cacheKey) ?? new Set();
  }
  try {
    const { rows } = await queryWithRetry(
      `SELECT DISTINCT stock_code FROM transaction_chains
       WHERE status = 'CLOSED'
         AND is_paper = $1
         AND pnl_pct < -5.0
         AND closed_at > NOW() - INTERVAL '30 days'`,
      [getCtxIsPaper()],
    );
    const blocked = new Set(rows.map((r: { stock_code: string }) => r.stock_code));
    _bigLossStocksCache.set(cacheKey, blocked);
    return blocked;
  } catch (e) {
    const cached = _bigLossStocksCache.get(cacheKey);
    if (cached) {
      logger.warn(`getBigLossBlockedStocks DB 오류 — 캐시된 차단 ${cached.size}개 반환 (fail-closed)`, { component: 'DB' });
      return cached;
    }
    logger.error(`getBigLossBlockedStocks DB 오류 — 캐시 없음, 예외 전파: ${e}`, { component: 'DB' });
    throw e;
  }
}

/** 손실 이력 레코드 (smart re-entry 판단용) */
export interface LossRecord {
  lossAmt: number;
  lossPct: number;
  closedAt: string;
  slReason: string;
  lastPrice: number;
}

const _lossHistoryCache = new Map<string, Map<string, LossRecord>>();

/**
 * 90일 이내 -3% 이상 손실 체인 통합 조회 (스마트 재진입용)
 * getBigLossBlockedStocks + getRecentLossStocks 대체하는 통합 함수
 */
export async function getLossHistory(): Promise<Map<string, LossRecord>> {
  const cacheKey = String(getCtxIsPaper());
  if (isMemoryMode()) {
    return _lossHistoryCache.get(cacheKey) ?? new Map();
  }
  try {
    const { rows } = await queryWithRetry(
      `SELECT stock_code, realized_pnl, pnl_pct, closed_at,
              COALESCE(sell_reason, '') AS sl_reason,
              COALESCE(avg_buy_price, 0) AS last_price
         FROM transaction_chains
        WHERE status = 'CLOSED'
          AND is_paper = $1
          AND pnl_pct < -3.0
          AND closed_at > NOW() - INTERVAL '90 days'
        ORDER BY closed_at DESC`,
      [getCtxIsPaper()],
    );
    const map = new Map<string, LossRecord>();
    for (const r of rows) {
      // 종목당 가장 최근 손실만 유지 (ORDER BY DESC → 첫 row가 최신)
      if (map.has(r.stock_code)) continue;
      map.set(r.stock_code, {
        lossAmt: Number(r.realized_pnl),
        lossPct: Number(r.pnl_pct),
        closedAt: String(r.closed_at),
        slReason: String(r.sl_reason),
        lastPrice: Number(r.last_price),
      });
    }
    _lossHistoryCache.set(cacheKey, map);
    return map;
  } catch {
    const cached = _lossHistoryCache.get(cacheKey);
    return cached ?? new Map();
  }
}

/**
 * 당일 손절 2회 이상 종목 — 재진입 금지 (당일 한정)
 */
export async function getTodayRepeatStopCodes(minStops = 2): Promise<Set<string>> {
  if (isMemoryMode()) return new Set();
  try {
    const { rows } = await queryWithRetry(
      `SELECT stock_code, COUNT(*) AS stop_count
         FROM transaction_chains
        WHERE status = 'CLOSED'
          AND realized_pnl < 0
          AND is_paper = $1
          AND closed_at >= CURRENT_DATE AT TIME ZONE 'Asia/Seoul'
        GROUP BY stock_code
       HAVING COUNT(*) >= $2`,
      [getCtxIsPaper(), minStops],
    );
    return new Set(rows.map((r: { stock_code: string }) => r.stock_code));
  } catch {
    return new Set();
  }
}
