/**
 * Shadow Tracker — AI 점수 상위 종목 가상매매 추적 (OOS 검증용)
 *
 * 이 모듈은 절대 증권사 API로 실제 매수/매도 주문을 실행하지 않습니다.
 * AI 점수 → 실제 수익 예측력을 검증하기 위한 순수 DB 기록 모듈입니다.
 *
 * 파라미터:
 *   TP  +5.0% / SL -2.5%
 *   KR friction 0.25% (수수료 0.03% + 세금 0.18% + 슬리피지 0.04%)
 *   US friction 0.03% (수수료 0.015% × 2)
 */

import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

const TP_PCT = 0.05;   // +5%
const SL_PCT = 0.025;  // -2.5% (손절, 양수로 저장)

const FRICTION_PCT: Record<'KR' | 'US', number> = {
  KR: 0.25,  // %
  US: 0.03,  // %
};

// 시장별 마지막 Shadow 진입 시각 (메모리 캐시)
const lastPickAt = new Map<'KR' | 'US', number>();
const COOLDOWN_MS = 9 * 60 * 1000; // 9분 쿨다운 (Track B 3분 간격 × 3)

export interface ShadowPick {
  stockCode: string;
  score: number;
  entryPrice: number;
}

/**
 * AI 점수 상위 1-3종목을 가상 진입으로 기록 (9분 쿨다운)
 * Shadow Tracker 핵심 함수 — 실제 주문 없음
 */
export async function recordShadowEntries(market: 'KR' | 'US', picks: ShadowPick[]): Promise<void> {
  if (picks.length === 0) return;

  const now = Date.now();
  if ((lastPickAt.get(market) ?? 0) > now - COOLDOWN_MS) return;
  lastPickAt.set(market, now);

  const friction = FRICTION_PCT[market];
  const validPicks = picks.slice(0, 3).filter((p) => p.entryPrice > 0);
  if (validPicks.length === 0) return;

  try {
    const pool = getPool();
    for (const p of validPicks) {
      const tpPrice = p.entryPrice * (1 + TP_PCT);
      const slPrice = p.entryPrice * (1 - SL_PCT);
      await pool.query(
        `INSERT INTO shadow_trades (market, stock_code, ai_score, entry_price, tp_price, sl_price, friction_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [market, p.stockCode, p.score, p.entryPrice, tpPrice, slPrice, friction],
      );
    }
    logger.info(
      `👻 Shadow[${market}] 가상진입 ${validPicks.length}종목: ${validPicks.map((p) => `${p.stockCode}(${p.score.toFixed(0)}점 @${p.entryPrice}`).join(', ')}`,
      { component: 'SHADOW' },
    );
  } catch (e) {
    logger.warn(`Shadow 진입 기록 실패[${market}]: ${e}`, { component: 'SHADOW' });
  }
}

/**
 * 열린 Shadow 포지션의 TP/SL 체크 후 자동 청산
 * 매 거래 사이클(3-10분)마다 호출
 */
export async function updateShadowPositions(market: 'KR' | 'US', priceMap: Map<string, number>): Promise<void> {
  if (priceMap.size === 0) return;
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      stock_code: string;
      entry_price: string;
      tp_price: string;
      sl_price: string;
      friction_pct: string;
    }>(
      `SELECT id, stock_code, entry_price, tp_price, sl_price, friction_pct
       FROM shadow_trades WHERE market = $1 AND is_closed = FALSE`,
      [market],
    );
    if (rows.length === 0) return;

    for (const row of rows) {
      const price = priceMap.get(row.stock_code);
      if (!price || price <= 0) continue;

      const tp = parseFloat(row.tp_price);
      const sl = parseFloat(row.sl_price);

      let exitReason: string | null = null;
      if (price >= tp) exitReason = 'TP';
      else if (price <= sl) exitReason = 'SL';
      if (!exitReason) continue;

      const entry = parseFloat(row.entry_price);
      const friction = parseFloat(row.friction_pct);
      const grossPnl = ((price - entry) / entry) * 100;
      const netPnl = grossPnl - friction;

      await pool.query(
        `UPDATE shadow_trades
         SET is_closed=TRUE, exit_price=$1, exit_reason=$2, gross_pnl_pct=$3, net_pnl_pct=$4, exited_at=NOW()
         WHERE id=$5`,
        [price, exitReason, grossPnl.toFixed(4), netPnl.toFixed(4), row.id],
      );
      logger.info(
        `👻 Shadow[${market}] ${exitReason} ${row.stock_code} gross${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(2)}% net${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}%`,
        { component: 'SHADOW' },
      );
    }
  } catch (e) {
    logger.warn(`Shadow 포지션 업데이트 실패[${market}]: ${e}`, { component: 'SHADOW' });
  }
}

/**
 * 장 마감 시 미청산 Shadow 포지션 전량 강제청산 (EOD)
 */
export async function closeShadowMarketEnd(market: 'KR' | 'US', priceMap: Map<string, number>): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      stock_code: string;
      entry_price: string;
      friction_pct: string;
    }>(
      `SELECT id, stock_code, entry_price, friction_pct
       FROM shadow_trades WHERE market = $1 AND is_closed = FALSE`,
      [market],
    );
    if (rows.length === 0) return;

    for (const row of rows) {
      const price = priceMap.get(row.stock_code) ?? 0;
      const entry = parseFloat(row.entry_price);
      const friction = parseFloat(row.friction_pct);
      const grossPnl = price > 0 ? ((price - entry) / entry) * 100 : 0;
      const netPnl = grossPnl - friction;

      await pool.query(
        `UPDATE shadow_trades
         SET is_closed=TRUE, exit_price=$1, exit_reason='EOD', gross_pnl_pct=$2, net_pnl_pct=$3, exited_at=NOW()
         WHERE id=$4`,
        [price > 0 ? price : null, grossPnl.toFixed(4), netPnl.toFixed(4), row.id],
      );
    }

    logger.info(`👻 Shadow[${market}] EOD 강제청산 ${rows.length}건`, { component: 'SHADOW' });
  } catch (e) {
    logger.warn(`Shadow EOD 청산 실패[${market}]: ${e}`, { component: 'SHADOW' });
  }
}

/**
 * 당일 Shadow 통계 로그 출력
 */
export async function logShadowStats(market: 'KR' | 'US'): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ cnt: string; avg_net: string; wins: string }>(
      `SELECT COUNT(*) cnt,
              AVG(net_pnl_pct) avg_net,
              SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) wins
       FROM shadow_trades
       WHERE market = $1 AND is_closed = TRUE AND entered_at >= CURRENT_DATE`,
      [market],
    );
    const r = rows[0];
    if (!r || parseInt(r.cnt) === 0) return;

    const cnt = parseInt(r.cnt);
    const avgNet = parseFloat(r.avg_net ?? '0');
    const wins = parseInt(r.wins ?? '0');
    const winRate = cnt > 0 ? ((wins / cnt) * 100).toFixed(0) : '0';
    logger.info(
      `👻 Shadow[${market}] 일간: ${cnt}건 평균 net ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(2)}%, 승률 ${winRate}% (${wins}/${cnt})`,
      { component: 'SHADOW' },
    );
  } catch (e) {
    logger.warn(`Shadow 통계 조회 실패[${market}]: ${e}`, { component: 'SHADOW' });
  }
}
