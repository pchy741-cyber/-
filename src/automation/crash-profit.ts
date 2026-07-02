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

// v10.11.4: PARK_STOCK_CODE 인라인 — defense-park.ts와의 순환참조 해소
// (crash-profit → defense-park → crash-profit 순환 import 제거)
const PARK_STOCK_CODE = '449170'; // KODEX 미국달러SOFR금리액티브
import { getCtxIsPaper } from '../config/context.js';
import { getPool, isMemoryMode } from '../db/client.js';
import { getLossStreakMultiplier } from '../risk/loss-streak.js';
import { logger } from '../utils/logger.js';
import type { TradeDecision, TransactionChain } from '../db/models.js';
import type { CurrentPrice } from '../kis/market.js';

// ── 인버스 ETF 목록 ───────────────────────────────────────────────────

/** @deprecated v10.11.4: 레거시 — INVERSE_ETFS 사용 권장 */
const INVERSE_ETF = { code: '114800', name: 'KODEX 인버스' } as const;

interface InverseETFConfig {
  code: string;
  name: string;
  leverage: number; // 배율 (1=1x, 2=2x)
  alloc: { CAUTION: number; CRASH: number; PANIC: number }; // 총자산 대비 배분 비율
}

// v18: 파킹 단순화 — 2x 레버리지(252670)는 며칠 이상 보유 시 변동성 감가(decay) 누적,
// 코스닥 인버스(251340)는 배분 0~8%로 사실상 미미한 보조 역할 → 여러 갈래 로직이 버그 표면적만 키움 판단.
// KODEX 인버스(114800, 1x) 단일 종목으로 통합. 기존 "보조" 배분율 그대로 유지 (과도한 노출 확대 방지).
export const INVERSE_ETFS: InverseETFConfig[] = [
  { code: '114800', name: 'KODEX 인버스', leverage: 1, alloc: { CAUTION: 0.22, CRASH: 0.32, PANIC: 0.38 } }, // KOSPI200 -1x 단일 파킹
];

export const INVERSE_ETF_CODES = new Set(INVERSE_ETFS.map((e) => e.code));

// ── 신호 강도 기준 ──────────────────────────────────────────────────────

export interface CrashSignal {
  level: 'NONE' | 'CAUTION' | 'CRASH' | 'PANIC';
  score: number; // 0-100 (높을수록 심각)
  reasons: string[];
}

interface CrashContext {
  kospiPenalty: number; // 0/1/2 (MA 기반)
  todayDown: boolean;
  flashCrash: boolean;
  dailyPnlPct: number; // 당일 포트폴리오 P&L %
  vkospi?: number; // 한국 VIX
  kospiChangePct?: number; // KOSPI 당일 변동 %
  fearGreedIndex?: number; // 0-100
  nasdaqChange1d?: number | null; // 나스닥 전일 등락률 — 선행 지표
  inverseEtfChangePct?: number; // 인버스 ETF 당일 등락률 (직접 시장붕괴 신호)
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
  if (ctx.kospiPenalty >= 2) {
    score += 30;
    reasons.push('KOSPI<MA60(약세장)');
  } else if (ctx.kospiPenalty >= 1) {
    score += 15;
    reasons.push('KOSPI<MA20(조정)');
  }

  // 당일 하락
  if (ctx.todayDown) {
    score += 10;
    reasons.push('당일하락');
  }

  // Flash Crash
  if (ctx.flashCrash) {
    score += 25;
    reasons.push('Flash Crash(-1%/5분)');
  }

  // 포트폴리오 당일 손실
  if (ctx.dailyPnlPct <= -3.0) {
    score += 20;
    reasons.push(`P&L ${ctx.dailyPnlPct.toFixed(1)}%`);
  } else if (ctx.dailyPnlPct <= -1.5) {
    score += 10;
    reasons.push(`P&L ${ctx.dailyPnlPct.toFixed(1)}%`);
  }

  // VKOSPI (한국 VIX)
  if (ctx.vkospi != null) {
    if (ctx.vkospi >= 35) {
      score += 20;
      reasons.push(`VKOSPI=${ctx.vkospi.toFixed(0)}(극공포)`);
    } else if (ctx.vkospi >= 25) {
      score += 10;
      reasons.push(`VKOSPI=${ctx.vkospi.toFixed(0)}(공포)`);
    }
  }

  // KOSPI 당일 변동
  if (ctx.kospiChangePct != null) {
    if (ctx.kospiChangePct <= -3.0) {
      score += 15;
      reasons.push(`KOSPI${ctx.kospiChangePct.toFixed(1)}%`);
    } else if (ctx.kospiChangePct <= -2.0) {
      score += 10;
      reasons.push(`KOSPI${ctx.kospiChangePct.toFixed(1)}%`);
    } else if (ctx.kospiChangePct <= -1.0) {
      score += 5;
      reasons.push(`KOSPI${ctx.kospiChangePct.toFixed(1)}%`);
    }
  }

  // Fear & Greed
  if (ctx.fearGreedIndex != null && ctx.fearGreedIndex < 20) {
    score += 10;
    reasons.push(`F&G=${ctx.fearGreedIndex.toFixed(0)}(극공포)`);
  }

  // 나스닥 전일 등락 (선행 지표 — 한국장 개장 전 미국 상황 반영)
  if (ctx.nasdaqChange1d != null) {
    if (ctx.nasdaqChange1d <= -3.0) {
      score += 25;
      reasons.push(`나스닥${ctx.nasdaqChange1d.toFixed(1)}%(폭락)`);
    } else if (ctx.nasdaqChange1d <= -2.0) {
      score += 15;
      reasons.push(`나스닥${ctx.nasdaqChange1d.toFixed(1)}%(급락)`);
    } else if (ctx.nasdaqChange1d <= -1.0) {
      score += 8;
      reasons.push(`나스닥${ctx.nasdaqChange1d.toFixed(1)}%(하락)`);
    }
  }

  // 인버스 ETF 급등 — 시장붕괴 직접 신호 (돈이 인버스로 몰릴 때)
  // 252670(KOSPI200선물2X인버스) 또는 114800(KODEX인버스) 기준
  if (ctx.inverseEtfChangePct != null && ctx.inverseEtfChangePct > 0) {
    if (ctx.inverseEtfChangePct >= 5.0) {
      score += 20;
      reasons.push(`인버스ETF+${ctx.inverseEtfChangePct.toFixed(1)}%(시장붕괴)`);
    } else if (ctx.inverseEtfChangePct >= 3.0) {
      score += 12;
      reasons.push(`인버스ETF+${ctx.inverseEtfChangePct.toFixed(1)}%(급락)`);
    } else if (ctx.inverseEtfChangePct >= 1.5) {
      score += 6;
      reasons.push(`인버스ETF+${ctx.inverseEtfChangePct.toFixed(1)}%(하락)`);
    }
  }

  const level: CrashSignal['level'] =
    score >= 70
      ? 'PANIC'
      : score >= 35
        ? 'CRASH'
        : // v2: 45→35 (일반 하락일에도 인버스 진입)
          score >= 20
          ? 'CAUTION'
          : // v2: 25→20 (조기 감지)
            'NONE';

  return { level, score, reasons };
}

// ── 레벨 서열 (뉴스/가격 신호 병합 시 다운그레이드 방지용) ─────────────
export const CRASH_LEVEL_RANK: Record<CrashSignal['level'], number> = {
  NONE: 0,
  CAUTION: 1,
  CRASH: 2,
  PANIC: 3,
};

// ── 매크로 뉴스 헤드라인 → 시스템 리스크 조기경보 ──────────────────────
// 가격이 아직 안 움직였어도, "국민연금 리밸런싱" 류의 대형 자금이탈/시스템리스크
// 뉴스가 확산 중이면 선제적으로 CAUTION 이상 부여 (찌라시 가능성 있어 PANIC까지는 안 감).
const SYSTEMIC_SHOCK_KEYWORDS = [
  '국민연금', '연기금', '리밸런싱', '대량매도', '매도폭탄', '오버행',
  '금융위기', '시스템리스크', '신용경색', '뱅크런', '자금이탈',
  '프로그램매매', '서킷브레이커', '사이드카', '패닉셀', '투매',
];

export interface NewsShockSignal {
  level: 'NONE' | 'CAUTION' | 'CRASH';
  score: number;
  matchedHeadlines: string[];
}

/**
 * 매크로 뉴스 헤드라인 목록에서 시스템 리스크 키워드 매칭 → 조기경보 레벨 산정
 * 뉴스 단독으로는 최대 CRASH까지만 (PANIC은 실제 가격/VKOSPI 확인 필요 — 찌라시 방어)
 */
export function assessNewsShockLevel(headlines: string[]): NewsShockSignal {
  const matched: string[] = [];
  let hits = 0;
  for (const h of headlines) {
    const hitKeywords = SYSTEMIC_SHOCK_KEYWORDS.filter((kw) => h.includes(kw));
    if (hitKeywords.length > 0) {
      hits += hitKeywords.length;
      matched.push(h);
    }
  }
  // 조 단위 금액 언급 시 가산 (예: "50조") — 자금 규모가 클수록 파급효과 큼
  const bigAmount = headlines.some((h) => /\d+\s*조/.test(h));
  let score = Math.min(60, hits * 15 + (bigAmount ? 15 : 0));
  const level: NewsShockSignal['level'] = score >= 35 ? 'CRASH' : score >= 15 ? 'CAUTION' : 'NONE';
  return { level, score, matchedHeadlines: matched.slice(0, 3) };
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
 * 인버스 ETF 매수/매도 결정 생성 (다중 ETF 지원)
 *
 * - NONE:           보유 인버스 전량 청산 (시장 회복)
 * - CAUTION:        보유분 +3% 익절; 252670 소규모 헤지 진입
 * - CRASH:          3종 진입; 목표 = 총자산의 배분비율 (현금 한도 내)
 * - PANIC:          3종 최대 진입; panicSell로 확보한 현금 + 기존 현금 활용
 * - 배분 기준: totalAssets (포트폴리오 대비 충분한 헤지 확보), 실행은 orderableCash 한도 내
 */
export async function generateInverseDecisions(params: InverseDecisionParams): Promise<TradeDecision[]> {
  const { signal, openChains, livePrices, orderableCash, totalAssets } = params;
  const decisions: TradeDecision[] = [];
  let remainingCash = orderableCash;
  // 배분 기준: 총자산 기반 (포트폴리오 대비 충분한 헤지), 실행은 가용현금 한도 내
  const allocationBase = totalAssets > 0 ? totalAssets : orderableCash;
  // CEO 지적(2026-07-02): 인버스 ETF 배분(22~38%)이 승률/연속손실과 무관한 flat 비율 —
  // Paper 모드에서 KODEX 인버스 -837,768원 손실이 바로 이 사이징 때문. 다른 전략과
  // 동일한 연속손실 배율을 적용해 연패 중엔 배분도 함께 줄어들게 함.
  const inverseLossStreakMult = await getLossStreakMultiplier(getCtxIsPaper());
  if (inverseLossStreakMult < 1.0) {
    logger.info(`🔻 인버스ETF 사이징 축소: 연속손실 배율 ×${inverseLossStreakMult}`, { component: 'CRASH_PROFIT' });
  }

  for (const etf of INVERSE_ETFS) {
    const holding = openChains.find((c) => c.stock_code === etf.code && c.total_quantity > 0);
    const price = livePrices.get(etf.code);

    // ── 매도: 시장 회복 (NONE) → 전량 청산 ──
    if (holding && signal.level === 'NONE') {
      decisions.push({
        action: 'SELL',
        stock_code: etf.code,
        quantity: holding.total_quantity,
        price_type: 'MARKET',
        reasoning: `📈 ${etf.name} 청산: 시장 정상화 (score=${signal.score})`,
        confidence: 0.9,
        strategy_mode: 'DEFENSE',
        trigger_source: 'CRASH_PROFIT_EXIT',
      });
      continue;
    }

    // ── 익절/손절: 보유분 정리 (모든 레벨 공통 손절 + CAUTION 익절) ──
    if (holding) {
      const avgBuy = Number(holding.avg_buy_price ?? 0);
      const currentPx = price?.currentPrice ?? 0;
      if (avgBuy > 0 && currentPx > 0) {
        const pnlPct = ((currentPx - avgBuy) / avgBuy) * 100;

        // 🛡️ V반등 방어: CRASH/PANIC 인버스도 -8% 손절 (시장 급반등 시 손실 무한확대 방지)
        const slPct = signal.level === 'PANIC' ? -10.0 : signal.level === 'CRASH' ? -8.0 : -5.0;
        if (pnlPct <= slPct) {
          decisions.push({
            action: 'SELL',
            stock_code: etf.code,
            quantity: holding.total_quantity,
            price_type: 'MARKET',
            reasoning: `🔴 ${etf.name} 손절: ${pnlPct.toFixed(1)}% (${signal.level} SL=${slPct}% — V반등 방어)`,
            confidence: 0.95,
            strategy_mode: 'DEFENSE',
            trigger_source: 'CRASH_PROFIT_SL',
          });
          continue;
        }

        // CAUTION 전환 시 익절
        if (signal.level === 'CAUTION' && pnlPct >= 3.0) {
          decisions.push({
            action: 'SELL',
            stock_code: etf.code,
            quantity: holding.total_quantity,
            price_type: 'MARKET',
            reasoning: `📈 ${etf.name} 익절: +${pnlPct.toFixed(1)}% (시장 안정화 조짐)`,
            confidence: 0.85,
            strategy_mode: 'DEFENSE',
            trigger_source: 'CRASH_PROFIT_TP',
          });
          continue;
        }
      }
    }

    // ── 매수/추가매수: 목표 배분 대비 부족분 top-up ──
    if (signal.level === 'NONE') continue;

    // CAUTION 시 1x(114800)만 사용 — 완만한 하락일에 2x 레버리지 과도 (개장 하락장 기본 대응)
    if (signal.level === 'CAUTION' && etf.code !== '114800') continue;

    const allocPct = etf.alloc[signal.level] * inverseLossStreakMult;
    if (allocPct <= 0) continue;

    if (!price || price.currentPrice <= 0) continue;

    // 목표 금액 대비 현재 보유 평가액 → 부족분만 추가매수 (top-up 지원)
    const currentValue = holding ? price.currentPrice * Number(holding.total_quantity ?? 0) : 0;
    const targetKrw = Math.round(allocationBase * allocPct); // 총자산 기준 목표 (포트폴리오 대비 헤지)
    // 목표의 80% 이상 이미 보유 → 추가 불필요
    if (currentValue >= targetKrw * 0.8) continue;

    const shortfallKrw = targetKrw - currentValue;
    const investAmount = Math.min(shortfallKrw, Math.round(remainingCash * 0.9));
    if (investAmount < 50_000) continue;

    const qty = Math.floor(investAmount / price.currentPrice);
    if (qty <= 0) continue;

    const actualCost = qty * price.currentPrice;
    remainingCash = Math.max(0, remainingCash - actualCost);
    const label = holding
      ? `TOP-UP(현재${Math.round(currentValue / 10000)}만→목표${Math.round(targetKrw / 10000)}만)`
      : '신규';

    decisions.push({
      action: 'BUY',
      stock_code: etf.code,
      quantity: qty,
      price_type: 'MARKET',
      limit_price: price.currentPrice,
      reasoning: `🔻 ${etf.name}(${etf.leverage}x) [${signal.level}] ${label}: ${signal.reasons.join(', ')} (score=${signal.score}, ${(allocPct * 100).toFixed(0)}%=${Math.round(investAmount / 10000)}만원)`,
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
    if (INVERSE_ETF_CODES.has(chain.stock_code)) continue; // 인버스는 유지
    if (chain.stock_code === PARK_STOCK_CODE) continue; // SOFR ETF — 잔여분 보존 (pipeline에서 별도 정리)

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
    const codes = INVERSE_ETFS.map((e) => e.code);
    const { rows } = await getPool().query(
      `
      SELECT stock_code, total_quantity, avg_buy_price
      FROM transaction_chains
      WHERE stock_code = ANY($1) AND status != 'CLOSED' AND total_quantity > 0
        AND is_paper = $2
    `,
      [codes, getCtxIsPaper()],
    );

    if (rows.length === 0) return { holding: false, quantity: 0, pnlPct: 0, crashLevel: 'NONE' };

    const totalQty = rows.reduce((s: number, r: { total_quantity: string }) => s + Number(r.total_quantity), 0);
    return {
      holding: true,
      quantity: totalQty,
      pnlPct: 0,
      crashLevel: 'UNKNOWN',
    };
  } catch (err) {
    logger.debug(`인버스 보유상태 조회 실패: ${err}`, { component: 'CRASH_PROFIT' });
    return null;
  }
}
