/**
 * 롤링 Kelly 사이징 + EV 기반 포지션 사이징 배율
 * 연구 근거: Kelly criterion (QuantifiedStrategies)
 */

import { GATE, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import type { KellyResult } from './types.js';
import { ctxMode } from './utils.js';

export interface StockEVResult {
  evPct: number; // 기대값 % (winRate×avgWin - lossRate×avgLoss)
  evMultiplier: number; // 포지션 사이즈 배율 (0.5~1.5)
  winRate: number;
  sampleCount: number;
}

export async function calcRollingKelly(days: number = 30, isPaper?: boolean): Promise<KellyResult> {
  const defaultResult: KellyResult = {
    fullKelly: 0.2,
    halfKelly: 0.1,
    winRate: 0.5,
    avgWin: 5.0,
    avgLoss: 3.0,
    sampleCount: 0,
    profitFactor: 1.0,
    rMultiple: 1.67,
    evPerTrade: 0,
    breakevenWinRate: 0.5,
  };

  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT
        filled_price,
        avg_buy_price
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode IN ($2, CASE WHEN $2 = 'paper' THEN 'p_arch' ELSE $2 END)
        AND status = 'FILLED'
        AND avg_buy_price > 0
        AND filled_price > 0
        AND created_at >= NOW() - make_interval(days => $1)
      ORDER BY created_at DESC
    `,
      [days, mode],
    );

    if (rows.length < 10) return defaultResult; // 표본 부족 시 기본값

    let wins = 0,
      losses = 0;
    let totalWinPct = 0,
      totalLossPct = 0;

    for (const r of rows) {
      const sellPrice = Number(r.filled_price);
      const buyPrice = Number(r.avg_buy_price);
      // 왕복 수수료 차감 (실질 손익 기준 Kelly 계산)
      const pnlPct = ((sellPrice - buyPrice) / buyPrice) * 100 - OVERSEAS_FEE_PCT * 2 * 100;

      if (pnlPct > 0) {
        wins++;
        totalWinPct += pnlPct;
      } else {
        losses++;
        totalLossPct += Math.abs(pnlPct);
      }
    }

    const total = wins + losses;
    if (total < 5) return defaultResult;

    const winRate = wins / total;
    const avgWin = wins > 0 ? totalWinPct / wins : 3.0;
    const avgLoss = losses > 0 ? totalLossPct / losses : 3.0;

    // Kelly Criterion: f = (b×p - q) / b, where b=avgWin/avgLoss, p=winRate, q=1-p
    const b = avgLoss > 0 ? avgWin / avgLoss : 1.0;
    const q = 1 - winRate;
    const fullKelly = Math.max(0.05, Math.min(0.3, (b * winRate - q) / b));
    // 승률 기반 동적 Kelly 비율: 60%+→2/3 Kelly, 50%+→55%, 나머지→half Kelly
    const kellyRatio = winRate >= 0.6 ? 0.67 : winRate >= 0.5 ? 0.55 : 0.5;
    const halfKelly = fullKelly * kellyRatio;

    // ── 세이버메트릭스 지표 ──
    const profitFactor = totalLossPct > 0 ? totalWinPct / totalLossPct : totalWinPct > 0 ? 99 : 0;
    const rMultiple = b; // R배수 = avgWin / avgLoss
    const evPerTrade = winRate * avgWin - q * avgLoss;
    const breakevenWinRate = b > 0 ? 1 / (1 + b) : 0.5;

    logger.info(
      `📊 Rolling Kelly (${days}d, ${total}건): 승률 ${(winRate * 100).toFixed(0)}% | R ${rMultiple.toFixed(1)} | PF ${profitFactor.toFixed(2)} | EV ${evPerTrade >= 0 ? '+' : ''}${evPerTrade.toFixed(2)}% | BEP ${(breakevenWinRate * 100).toFixed(0)}% | Kelly ${(fullKelly * 100).toFixed(1)}%/${(halfKelly * 100).toFixed(1)}%`,
      { component: 'RISK_INTEL' },
    );

    return {
      fullKelly,
      halfKelly,
      winRate,
      avgWin,
      avgLoss,
      sampleCount: total,
      profitFactor,
      rMultiple,
      evPerTrade,
      breakevenWinRate,
    };
  } catch {
    return defaultResult;
  }
}

/**
 * 종목별 기대값(EV)을 계산하고 포지션 사이징 배율 반환
 * - EV > 3%: 1.3~1.5x (확실한 승자 집중)
 * - EV 1~3%: 1.0~1.3x (기본 사이즈)
 * - EV 0~1%: 0.8~1.0x (보수적)
 * - EV < 0%: 0.5~0.8x (축소)
 */
export async function calcStockEVMultipliers(codes: string[], isPaper?: boolean): Promise<Map<string, StockEVResult>> {
  const result = new Map<string, StockEVResult>();
  if (codes.length === 0) return result;

  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT stock_code,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE filled_price > avg_buy_price) AS wins,
             COALESCE(AVG(CASE WHEN filled_price > avg_buy_price
               THEN ((filled_price - avg_buy_price) / avg_buy_price * 100) END), 5.0) AS avg_win_pct,
             COALESCE(AVG(CASE WHEN filled_price <= avg_buy_price
               THEN ABS((filled_price - avg_buy_price) / avg_buy_price * 100) END), 3.0) AS avg_loss_pct
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND trading_mode IN ($2, CASE WHEN $2 = 'paper' THEN 'p_arch' ELSE $2 END)
        AND avg_buy_price > 0 AND filled_price > 0
        AND stock_code = ANY($1)
        AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY stock_code
    `,
      [codes, mode],
    );

    for (const r of rows) {
      const code = String(r.stock_code);
      const total = Number(r.total);
      const wins = Number(r.wins);
      const avgWin = Number(r.avg_win_pct);
      const avgLoss = Number(r.avg_loss_pct);
      const winRate = total > 0 ? wins / total : 0.5;
      // Gross EV에서 미국 왕복 마찰비용(0.70%) 차감 → Net EV 기준으로 사이징
      const evPct = winRate * avgWin - (1 - winRate) * avgLoss - GATE.US_SLIPPAGE_PCT;

      let evMultiplier: number;
      if (total < 3) {
        evMultiplier = 1.0; // 표본 부족 → 기본
      } else if (evPct >= 3.0) {
        evMultiplier = Math.min(1.5, 1.3 + (evPct - 3.0) * 0.05);
      } else if (evPct >= 1.0) {
        evMultiplier = 1.0 + (evPct - 1.0) * 0.15;
      } else if (evPct >= 0) {
        evMultiplier = 0.8 + evPct * 0.2;
      } else {
        evMultiplier = Math.max(0.5, 0.8 + evPct * 0.1);
      }

      result.set(code, { evPct, evMultiplier, winRate, sampleCount: total });
    }
  } catch {
    // DB 실패 시 빈 맵 반환 (기본 배율 1.0 사용)
  }

  return result;
}
