/**
 * 하락장 수익화 엔진 — 인버스 ETF 자동 매매
 *
 * 기존 시스템은 하락장 "방어"만 12단계 (DEFENSE → Park → Kill Switch)
 * 이 모듈은 하락장에서 "수익"을 내는 공격적 엔진:
 *
 * 1. KOSPI 하락 신호 감지 → KODEX 인버스(114800) 자동 매수
 * 2. 반등 감지 → 인버스 매도 + BOTTOM_FISHING 연계
 * 3. Defense Park과 통합: 기존 KODEX200 파킹 대신 인버스 전환 옵션
 *
 * 우선순위 체계 (하락장 시나리오):
 *   ① 인버스 ETF 매수 (하락 수익화) — penalty≥2 + 추가 확인
 *   ② 손실 포지션 빠른 청산 (출혈 차단)
 *   ③ BOTTOM_FISHING 대기 (반등 포착)
 *   ④ EOD 블루칩 줍줍 (갭 수익)
 */

import { getPool, isMemoryMode } from '../db/client.js';
import { getCtxIsPaper } from '../config/context.js';
import { logger } from '../utils/logger.js';
import type { TradeDecision, TransactionChain } from '../db/models.js';
import type { CurrentPrice } from '../kis/market.js';

// ── 인버스 ETF 코드 ────────────────────────────────────────────────────

export const INVERSE_ETF = {
  code: '114800',
  name: 'KODEX 인버스',        // KOSPI200 -1x
} as const;

// ── 신호 강도 기준 ──────────────────────────────────────────────────────

export interface CrashSignal {
  level: 'NONE' | 'CAUTION' | 'CRASH' | 'PANIC';
  score: number;             // 0-100 (높을수록 심각)
  reasons: string[];
}

interface CrashContext {
  kospiPenalty: number;       // 0/1/2 (MA 기반)
  todayDown: boolean;
  flashCrash: boolean;
  dailyPnlPct: number;       // 당일 포트폴리오 P&L %
  vkospi?: number;           // 한국 VIX
  kospiChangePct?: number;   // KOSPI 당일 변동 %
  fearGreedIndex?: number;   // 0-100
}

/**
 * 하락장 신호 강도 판정
 *
 * NONE:    정상 — 인버스 불필요
 * CAUTION: 주의 — 신규 매수 축소, 인버스 관심
 * CRASH:   하락장 — 인버스 매수 실행
 * PANIC:   패닉 — 인버스 대량 매수 + 전 포지션 긴급 청산
 */
export function assessCrashLevel(ctx: CrashContext): CrashSignal {
  let score = 0;
  const reasons: string[] = [];

  // KOSPI MA 위치
  if (ctx.kospiPenalty >= 2) { score += 30; reasons.push('KOSPI<MA60(약세장)'); }
  else if (ctx.kospiPenalty >= 1) { score += 15; reasons.push('KOSPI<MA20(조정)'); }

  // 당일 하락
  if (ctx.todayDown) { score += 10; reasons.push('당일하락'); }

  // Flash Crash
  if (ctx.flashCrash) { score += 25; reasons.push('Flash Crash(-1%/5분)'); }

  // 포트폴리오 당일 손실
  if (ctx.dailyPnlPct <= -3.0) { score += 20; reasons.push(`P&L ${ctx.dailyPnlPct.toFixed(1)}%`); }
  else if (ctx.dailyPnlPct <= -1.5) { score += 10; reasons.push(`P&L ${ctx.dailyPnlPct.toFixed(1)}%`); }

  // VKOSPI (한국 VIX)
  if (ctx.vkospi != null) {
    if (ctx.vkospi >= 35) { score += 20; reasons.push(`VKOSPI=${ctx.vkospi.toFixed(0)}(극공포)`); }
    else if (ctx.vkospi >= 25) { score += 10; reasons.push(`VKOSPI=${ctx.vkospi.toFixed(0)}(공포)`); }
  }

  // KOSPI 당일 변동
  if (ctx.kospiChangePct != null) {
    if (ctx.kospiChangePct <= -3.0) { score += 15; reasons.push(`KOSPI${ctx.kospiChangePct.toFixed(1)}%`); }
    else if (ctx.kospiChangePct <= -2.0) { score += 10; reasons.push(`KOSPI${ctx.kospiChangePct.toFixed(1)}%`); }
  }

  // Fear & Greed
  if (ctx.fearGreedIndex != null && ctx.fearGreedIndex < 20) {
    score += 10; reasons.push(`F&G=${ctx.fearGreedIndex.toFixed(0)}(극공포)`);
  }

  const level: CrashSignal['level'] =
    score >= 70 ? 'PANIC' :
    score >= 45 ? 'CRASH' :
    score >= 25 ? 'CAUTION' :
    'NONE';

  return { level, score, reasons };
}

// ── 인버스 매매 결정 ────────────────────────────────────────────────────

interface InverseDecisionParams {
  signal: CrashSignal;
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  orderableCash: number;
  totalAssets: number;
}

/**
 * 인버스 ETF 매수/매도 결정 생성
 *
 * 매수: CRASH 이상 → 총자산의 15-25% 인버스 매수
 * 매도: 시장 회복(penalty=0) → 인버스 전량 매도
 * 이미 보유 시 중복 매수 안 함
 */
export function generateInverseDecisions(params: InverseDecisionParams): TradeDecision[] {
  const { signal, openChains, livePrices, orderableCash, totalAssets } = params;
  const decisions: TradeDecision[] = [];

  const existingInverse = openChains.find(c => c.stock_code === INVERSE_ETF.code && c.total_quantity > 0);
  const inversePrice = livePrices.get(INVERSE_ETF.code);

  // ── 매도: 시장 회복 시 인버스 청산 ──
  if (existingInverse && signal.level === 'NONE') {
    decisions.push({
      action: 'SELL',
      stock_code: INVERSE_ETF.code,
      quantity: existingInverse.total_quantity,
      price_type: 'MARKET',
      reasoning: `📈 인버스 청산: 시장 정상화 (score=${signal.score})`,
      confidence: 0.9,
      strategy_mode: 'DEFENSE',
      trigger_source: 'CRASH_PROFIT_EXIT',
    });
    return decisions;
  }

  // CAUTION에서도 인버스 보유 중이면 익절 확인
  if (existingInverse && signal.level === 'CAUTION') {
    const avgBuy = Number(existingInverse.avg_buy_price ?? 0);
    const currentPx = inversePrice?.currentPrice ?? 0;
    if (avgBuy > 0 && currentPx > 0) {
      const pnlPct = ((currentPx - avgBuy) / avgBuy) * 100;
      // +3% 이상 수익이면 익절
      if (pnlPct >= 3.0) {
        decisions.push({
          action: 'SELL',
          stock_code: INVERSE_ETF.code,
          quantity: existingInverse.total_quantity,
          price_type: 'MARKET',
          reasoning: `📈 인버스 익절: +${pnlPct.toFixed(1)}% (시장 안정화 조짐)`,
          confidence: 0.85,
          strategy_mode: 'DEFENSE',
          trigger_source: 'CRASH_PROFIT_TP',
        });
        return decisions;
      }
    }
  }

  // ── 매수: CRASH/PANIC → 인버스 진입 ──
  if ((signal.level === 'CRASH' || signal.level === 'PANIC') && !existingInverse) {
    if (!inversePrice || inversePrice.currentPrice <= 0) return decisions;

    // PANIC: 25%, CRASH: 15% 배분
    const allocPct = signal.level === 'PANIC' ? 0.25 : 0.15;
    const targetKrw = Math.round(totalAssets * allocPct);
    const investAmount = Math.min(targetKrw, Math.round(orderableCash * 0.90));

    if (investAmount < 50_000) return decisions; // 최소 5만원

    const qty = Math.floor(investAmount / inversePrice.currentPrice);
    if (qty <= 0) return decisions;

    decisions.push({
      action: 'BUY',
      stock_code: INVERSE_ETF.code,
      quantity: qty,
      price_type: 'MARKET',
      limit_price: inversePrice.currentPrice,
      reasoning: `🔻 인버스 매수 [${signal.level}]: ${signal.reasons.join(', ')} (score=${signal.score}, ${(allocPct*100).toFixed(0)}%=${Math.round(investAmount/10000)}만원)`,
      confidence: Math.min(0.95, 0.6 + signal.score / 200),
      strategy_mode: 'DEFENSE',
      trigger_source: `CRASH_PROFIT_${signal.level}`,
    });
  }

  return decisions;
}

// ── 하락장 분할매도 강화 ────────────────────────────────────────────────

/**
 * 하락장 포지션 긴급 축소 — PANIC 시 손실 포지션 즉시 50% 청산
 */
export function generatePanicSellDecisions(
  signal: CrashSignal,
  openChains: TransactionChain[],
  livePrices: Map<string, CurrentPrice>,
): TradeDecision[] {
  if (signal.level !== 'PANIC') return [];

  const decisions: TradeDecision[] = [];

  for (const chain of openChains) {
    if (chain.total_quantity <= 0) continue;
    if (chain.stock_code === INVERSE_ETF.code) continue; // 인버스는 유지
    if (chain.stock_code === '069500') continue; // KODEX200 파킹 유지

    const price = livePrices.get(chain.stock_code);
    const avgBuy = Number(chain.avg_buy_price ?? 0);
    if (!price || avgBuy <= 0) continue;

    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 손실 중인 포지션만 50% 긴급 축소
    if (pnlPct < -1.0) {
      const sellQty = Math.ceil(chain.total_quantity * 0.5);
      if (sellQty <= 0) continue;

      decisions.push({
        action: 'PARTIAL_SELL',
        stock_code: chain.stock_code,
        quantity: Math.min(sellQty, chain.total_quantity),
        price_type: 'MARKET',
        reasoning: `🚨 PANIC 긴급축소: ${chain.stock_code} ${pnlPct.toFixed(1)}% → 50% 매도 (score=${signal.score})`,
        confidence: 0.95,
      });
    }
  }

  return decisions;
}

// ── 인버스 보유 상태 조회 (SSE/대시보드용) ──────────────────────────────

export async function getInverseHoldingStatus(): Promise<{
  holding: boolean;
  quantity: number;
  pnlPct: number;
  crashLevel: string;
} | null> {
  if (isMemoryMode()) return null;

  try {
    const { rows } = await getPool().query(`
      SELECT total_quantity, avg_buy_price
      FROM transaction_chains
      WHERE stock_code = $1 AND status != 'CLOSED' AND total_quantity > 0
        AND is_paper = $2
      LIMIT 1
    `, [INVERSE_ETF.code, getCtxIsPaper()]);

    if (rows.length === 0) return { holding: false, quantity: 0, pnlPct: 0, crashLevel: 'NONE' };

    return {
      holding: true,
      quantity: Number(rows[0].total_quantity),
      pnlPct: 0, // 실시간 가격은 호출측에서 계산
      crashLevel: 'UNKNOWN',
    };
  } catch {
    return null;
  }
}
