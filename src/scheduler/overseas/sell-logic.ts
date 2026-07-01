/**
 * 매도 판단 로직 — SL/TP/ATR트레일/부분익절/AI매도/기술적매도
 * overseas-job.ts에서 추출
 */

import { getOverride } from '../../ai/ai-overrides.js';
import { getOverseasDynamic, OVERSEAS_FEE_PCT, SECTOR_CLASS } from '../../config/constants.js';
import { getAllocRisk } from '../../db/alloc-risk-cache.js';
import type { OverseasPrice } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { executeOverseasOrder } from './executor.js';
import {
  calcDynamicTpSl,
  calcDynamicTrailDrop,
  getPartialTpStageNum,
  getPartialTpStages,
  isMomentumAccelerating,
  type MomentumContext,
  type RegimeAdjustment,
  setPartialTpStageNum,
} from './risk-intelligence.js';
import { checkHoldingPriceShock } from './session-strategy.js';
import { isUSMarketLastNMinutes } from './session.js';
import { cleanupPositionState, getMaxPrice, setMaxPrice, updateHoldingTpSl, updateTradeState } from './state.js';
import { getTunerOverrides } from './trade-tuner.js';
import { GLOBAL_WATCHLIST, WATCHLIST_BY_CODE } from './watchlist.js';

// ── 타입 ──

export interface TechResult {
  code: string;
  name: string;
  exchange: string;
  sector: string;
  price: OverseasPrice;
  signal: string;
  score: number;
  rsi: number;
  adx: number;
  trendStrength: string;
  dayRangePct: number;
  isMomentum: boolean;
  isBigMover: boolean;
  aboveMA20: boolean;
  aboveMA60: boolean;
  bollingerSqueeze: boolean;
  bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
  atrPct: number;
  vwapPosition?: 'ABOVE' | 'BELOW' | 'AT'; // 개선#4: VWAP 대비 위치
  prevLow5d?: number; // 최근 5일 저점 — Phase1 구조적 SL 판단용
}

export interface Holding {
  qty: number;
  avgPrice: number;
  boughtAt: string;
  exchange: string;
  tpPct: number | null;
  slPct: number | null;
  bucket?: string;
}

import type { AIDecision } from './types.js';

// ── Sell logic named constants ──
/** Default ATR% when tech data is missing */
const DEFAULT_ATR_PCT = 2.0;
/** Minimum AI confidence for sell signal (high-beta sectors) */
const MIN_AI_SELL_CONF_HIGH_BETA = 0.82;
/** Minimum AI confidence for sell signal (other sectors) */
const MIN_AI_SELL_CONF_DEFAULT = 0.78;
/** RSI threshold for BigMover overbought exit */
const RSI_BIGMOVER_OVERBOUGHT = 82;
/** Profit tightening thresholds (% from peak) — 근거 기반 5단계 래칫
 * arXiv:2604.27150 (8,960 config 백테스트): 최적 트레일 활성화 3%, 거리 5%
 * Snorrason & Yusupov (2009, Lund대): 15~20% 트레일이 11년 최고 누적수익
 * Decoding Markets (11,000주, 1990-2020): 20% 트레일 risk-adjusted 최고 (0.57)
 * 래칫 원칙 (업계 합의): 각 단계에서 누적 수익의 ~50% 잠금
 */
const PROFIT_TIGHTEN_THRESHOLDS = { HIGH: 25, MEDIUM: 20, LOW: 15, MID: 8, ENTRY: 3 } as const;
const PROFIT_TIGHTEN_VALUES = { HIGH: 1.5, MEDIUM: 1.0, LOW: 0.5, MID: 0.3, ENTRY: 0.15 } as const;
/** Milliseconds per day */
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface SellContext {
  holdings: Map<string, Holding>;
  pendingOrderStocks: Set<string>;
  techResults: TechResult[];
  aiMap: Map<string, AIDecision>;
  vixRegime: RegimeAdjustment;
  cash: number;
  isPaper?: boolean;
  portfolioValue?: number; // 동적 MAX_HOLD_DAYS 계산용
  fxRate?: number; // 사이클 환율 (동일 루프 내 일관성 보장)
  nasdaqChange1d?: number | null; // 나스닥 전일 등락률 — 급락 선제 청산용
}

export interface SellResult {
  sellOrders: string[];
  cash: number;
}

/**
 * 보유종목 매도 판단 + 실행
 * - 손절 / ATR 트레일 / 하드 익절 / AI 매도 / 기술적 매도 / 보유기한 초과
 * - 3단계 부분 익절
 */
export async function evaluateSells(ctx: SellContext): Promise<SellResult> {
  const { holdings, pendingOrderStocks, techResults, aiMap, vixRegime } = ctx;
  const paperMode = ctx.isPaper;
  let { cash } = ctx;
  const sellOrders: string[] = [];
  // v10.11: O(1) lookup Map
  const techByCode = new Map(techResults.map((t) => [t.code, t]));
  // 동적 파라미터 1회 캐싱 (루프 밖)
  const _allocRisk = await getAllocRisk(ctx.isPaper ?? false).catch(() => ({ positionCapPct: 25 }));
  const dynP = getOverseasDynamic(ctx.portfolioValue ?? 5000, ctx.isPaper, _allocRisk.positionCapPct / 100);
  // Trade Tuner 오버라이드 로드 (1회)
  const tunerOverrides: Record<string, number> = await getTunerOverrides(paperMode).catch(() => ({}));
  const maxHoldDays = tunerOverrides.max_hold_days ?? dynP.maxHoldDays;

  // 이벤트 기반 AI 리프레시: 보유 종목 ±3% 급변 감지
  const priceMap = new Map<string, number>();
  for (const tech of techResults) {
    if (tech.price?.currentPrice > 0) priceMap.set(tech.code, tech.price.currentPrice);
  }
  checkHoldingPriceShock(priceMap);

  for (const [code, holding] of holdings) {
    if (pendingOrderStocks.has(code)) {
      logger.info(`⏳ 미체결 주문 존재 → ${code} 추가 주문 스킵`, { component: 'OVERSEAS' });
      continue;
    }
    // v10.11: O(1) Map 조회 (기존: O(n) find per holding)
    const tech = techByCode.get(code);
    if (!tech) {
      // 🚨 안전망: 가격 데이터 완전 실패 → 비상 시장가 매도 (절대 손실 방치 금지)
      // overseas-job.ts에서 재시도+fallback 후에도 여기 도달하면 = 심각한 장애
      logger.error(`🚨 비상매도: ${code} 가격 데이터 완전 누락 → 매입가 기준 청산 시도 (보유 ${holding.qty}주, 매입가 $${holding.avgPrice})`, { component: 'OVERSEAS' });
      try {
        // avgPrice를 fallback 가격으로 사용 (executor가 price<=0을 거부하므로)
        const emergencyPrice = holding.avgPrice > 0 ? holding.avgPrice : 1;
        const exec = await executeOverseasOrder(
          code, 'SELL', holding.qty, emergencyPrice, holding.exchange,
          `🚨 비상매도: 가격 데이터 완전 실패 — 손실 방지 긴급 청산 (매입가 $${holding.avgPrice})`,
          holding.qty, holding.avgPrice, { isPaper: paperMode },
        );
        if (exec.submitted && exec.filledQty > 0) {
          cash += exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
          sellOrders.push(`${code} 🚨비상매도 ${exec.filledQty}주`);
          if (exec.filledQty >= holding.qty) {
            await updateTradeState({ code, exchange: holding.exchange, qty: 0, avgPrice: 0, newCash: cash, isPaper: paperMode });
            await cleanupPositionState(code, paperMode);
          } else {
            const remainQty = holding.qty - exec.filledQty;
            await updateTradeState({ code, exchange: holding.exchange, qty: remainQty, avgPrice: holding.avgPrice, newCash: cash, isPaper: paperMode });
          }
        }
      } catch (emergErr) {
        logger.error(`🚨 비상매도 실행 실패: ${code} — ${emergErr}`, { component: 'OVERSEAS' });
      }
      continue;
    }

    const curPrice = tech.price.currentPrice;
    if (holding.avgPrice <= 0 || curPrice <= 0) continue; // 비정상 데이터 방어
    const pnlPct = ((curPrice - holding.avgPrice) / holding.avgPrice) * 100;
    const ai = aiMap.get(code);

    // AI Loop forceHold: Claude Code가 매도 보류 지시 (실적 발표 대기 등)
    const aiForceHold = getOverride<boolean>(`${code}_forceHold`);
    const nasdaqCrash = ctx.nasdaqChange1d != null && ctx.nasdaqChange1d <= -4;
    // v12.3: 동적 SL×1.0 (기존 1.2x → SL 그대로 적용, 추가 여유 불필요)
    // 기존: SL -5% × 1.2 = -6% 허용 → 소액 계좌에서 과도한 손실
    const forceHoldLimit = (holding.slPct ?? -5) * 1.0;
    if (aiForceHold && pnlPct > forceHoldLimit && !nasdaqCrash) {
      // 동적 SL 기반 한도 이상 + NASDAQ 급락(-4%+) 아닐 때만 AI 홀드 존중
      logger.info(`🤖 AI Loop forceHold(해외): ${code} 매도 보류 (pnl=${pnlPct.toFixed(1)}%)`, {
        component: 'AI_LOOP',
      });
      continue;
    }
    // AI Loop forceSell: Claude Code가 즉시 매도 지시
    const aiForceSell = getOverride<boolean>(`${code}_forceSell`);
    if (aiForceSell) {
      const reason = `🤖 AI Loop 강제매도 (pnl=${pnlPct.toFixed(1)}%)`;
      const exec = await executeOverseasOrder(
        code,
        'SELL',
        holding.qty,
        curPrice,
        holding.exchange,
        reason,
        holding.qty,
        holding.avgPrice,
        { isPaper: paperMode },
      );
      if (exec.submitted && exec.filledQty > 0) {
        cash += exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
        sellOrders.push(`${code} AI강제매도 ${exec.filledQty}주`);
        // 🔒 Force-sell 후 상태 업데이트 (이전: continue로 스킵 → 유령 포지션 + 현금 미반영)
        if (exec.filledQty >= holding.qty) {
          await updateTradeState({ code, exchange: holding.exchange, qty: 0, avgPrice: 0, newCash: cash, isPaper: paperMode });
          await cleanupPositionState(code, paperMode);
        } else {
          const remainQty = holding.qty - exec.filledQty;
          await updateTradeState({ code, exchange: holding.exchange, qty: remainQty, avgPrice: holding.avgPrice, newCash: cash, isPaper: paperMode });
        }
      }
      continue;
    }

    const prevMax = await getMaxPrice(code, paperMode);
    const newMax = Math.max(prevMax || holding.avgPrice, curPrice);
    if (newMax > prevMax) await setMaxPrice(code, newMax, paperMode);
    const maxPnlPct = ((newMax - holding.avgPrice) / holding.avgPrice) * 100;
    const drawdownFromPeak = ((curPrice - newMax) / newMax) * 100;

    let sellReason = '';

    const watchItem = WATCHLIST_BY_CODE.get(code);
    const sector = watchItem?.sector ?? '';
    const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
    const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
    const _isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

    // ATR 동적 트레일링 스톱 + VIX 레짐 타이트닝
    const atrPctValue = tech.atrPct ?? DEFAULT_ATR_PCT;
    // 🛡️ 과매도 바닥 판단 (Smart Hold) — 이후 손절 로직에서 참조
    const isOversoldBottom = tech.rsi < 30 && tech.adx < 20 && tech.trendStrength !== 'STRONG';
    // TP/SL: 매 사이클마다 현재 조건으로 재계산 (DB 저장값은 참고용)
    // 기존 문제: DB에 20~25% TP가 박혀서 사실상 익절 불가 → 항상 현재 조건 반영
    const dyn = calcDynamicTpSl({
      sector,
      adx: tech.adx ?? 20,
      rsi: tech.rsi ?? 50,
      aiConfidence: ai?.confidence,
      aiAction: ai?.action,
      vixRegime,
      isMomentum: tech.isMomentum,
      tunerOverrides,
      atrPct: atrPctValue,
    });
    // TP: 기존 DB TP가 동적 TP보다 낮으면(보수적) 유지 → 익절 기회 보호
    const hardTpPct = holding.tpPct != null && holding.tpPct > 0
      ? Math.min(holding.tpPct, dyn.tpPct)
      : dyn.tpPct;
    // SL: 매 사이클마다 현재 조건으로 재계산 (tuner 반영, 시장 변화 적응)
    // 단, 기존 DB값이 더 타이트(덜 음수)하면 보수적으로 유지
    const dynamicSl = -dyn.slPct;
    let stopLossPct = holding.slPct != null ? Math.max(holding.slPct, dynamicSl) : dynamicSl;
    // ── 브레이크이븐 스톱 프로그레션 (ATR 기반) ──
    // 고점 도달 → SL 자동 상향 (수익 보호, 손실 방지)
    // Phase A: maxPnl >= 2.5 ATR → SL을 0.5 ATR로 (수익 확보)
    // Phase B: maxPnl >= 1.5 ATR → SL을 본절(-0.3%)로 (수수료 감안)
    if (maxPnlPct >= atrPctValue * 2.5) {
      const lockPct = atrPctValue * 0.5;
      if (lockPct > stopLossPct) {
        logger.debug(`📈 SL프로그레션: ${code} 2.5ATR도달 → SL ${stopLossPct.toFixed(1)}%→+${lockPct.toFixed(1)}%`, { component: 'OVERSEAS' });
        stopLossPct = lockPct;
      }
    } else if (maxPnlPct >= atrPctValue * 1.5) {
      const breakeven = -0.3; // 수수료 감안 본절
      if (breakeven > stopLossPct) {
        logger.debug(`📈 SL프로그레션: ${code} 1.5ATR도달 → SL ${stopLossPct.toFixed(1)}%→본절`, { component: 'OVERSEAS' });
        stopLossPct = breakeven;
      }
    }
    // DB 동기화 (대시보드 표시용) — v10.8: 루프 밖 static import 사용
    updateHoldingTpSl(code, hardTpPct, stopLossPct, paperMode, holding.exchange).catch(() => {});
    const dynamicTrailDrop = calcDynamicTrailDrop({
      sector,
      atrPct: atrPctValue,
      maxPnlPct,
      adx: tech.adx,
      rsi: tech.rsi,
    });
    // 수익 크기 비례 5단계 래칫 타이트닝 (arXiv:2604.27150 + Snorrason & Yusupov)
    // 3%+: 0.15% | 8%+: 0.3% | 15%+: 0.5% | 20%+: 1.0% | 25%+: 1.5% 타이트
    const profitTighten = maxPnlPct >= PROFIT_TIGHTEN_THRESHOLDS.HIGH ? PROFIT_TIGHTEN_VALUES.HIGH
      : maxPnlPct >= PROFIT_TIGHTEN_THRESHOLDS.MEDIUM ? PROFIT_TIGHTEN_VALUES.MEDIUM
      : maxPnlPct >= PROFIT_TIGHTEN_THRESHOLDS.LOW ? PROFIT_TIGHTEN_VALUES.LOW
      : maxPnlPct >= PROFIT_TIGHTEN_THRESHOLDS.MID ? PROFIT_TIGHTEN_VALUES.MID
      : maxPnlPct >= PROFIT_TIGHTEN_THRESHOLDS.ENTRY ? PROFIT_TIGHTEN_VALUES.ENTRY : 0;
    // v10.10.5c: trailTighten/profitTighten은 양수값 — 음수 trail에 더해야 0에 가까워져 타이트해짐
    // 예: trail=-4.0 + tighten=2.0 → -2.0 (2%드롭에서 트리거 = 더 빨리 보호)
    // 기존 버그: 빼면 -6.0 → 6%드롭까지 허용 = VIX 위기 시 오히려 더 느슨해짐
    // v10.11: 클램핑 추가 — 양수 되면 트레일 비활성화 (VIX+고수익 동시 → 무방비)
    // v14: trail floor -0.5→-1.5% (기존: 고수익+VIX 시 -0.5% = 정상 변동성에도 매도 트리거)
    const effectiveTrailDropPct = Math.min(-1.5, dynamicTrailDrop + vixRegime.trailTighten + profitTighten);
    // v15: 모멘텀 가속 감지 → 트레일 넓히기 (위너 라이딩)
    const _momCtx: MomentumContext = { isMomentum: tech.isMomentum, rsi: tech.rsi, adx: tech.adx, vwapPosition: tech.vwapPosition };
    const _isAccel = isMomentumAccelerating(_momCtx);
    // v15 Smart Trail After Partial: 이미 부분익절 진행한 포지션은 트레일 즉시 활성화
    const partialTpDone = await getPartialTpStageNum(code, paperMode);
    // v10.9: 트레일 활성화 대폭 하향 (기존 5~10% → 2~4%) — 소액 계좌 수익 보호
    // v15: 모멘텀 가속 시 활성화 기준 +2% 상향 (너무 빨리 트레일 걸리면 위너 절단)
    // v15: 부분익절 1단계+ 완료 → 활성화 기준 = 0% (이미 수익 확정 시작, 잔여분 즉시 보호)
    const baseTrailActivate = isHighBeta ? 4.0 : isMediumBeta ? 3.0 : 2.0;
    const trailActivatePct = partialTpDone >= 1 ? 0 : (tunerOverrides.trail_activate_pct ?? baseTrailActivate) + (_isAccel ? 2.0 : 0);
    const minAiSellConf = isHighBeta ? MIN_AI_SELL_CONF_HIGH_BETA : MIN_AI_SELL_CONF_DEFAULT;
    const holdingDays = (Date.now() - new Date(holding.boughtAt).getTime()) / MS_PER_DAY;
    // 🔧 강한 매도 신호(score≤-30 + 과매수) → minHold 완화 (HIGH_BETA 3→1일)
    const strongSellSignal = tech.score <= -30 && (tech.signal === 'SELL' || tech.signal === 'STRONG_SELL');
    const minHoldForSell = strongSellSignal ? 1 : isHighBeta ? 3 : 2;

    // ── 개선#9: ADX/승률 기반 동적 보유기간 ──
    const effectiveMaxHold = calcDynamicHoldDays(maxHoldDays, tech, holdingDays);

    // ════════════════════════════════════════════════════════
    // 매도 판단 우선순위 (위에서부터 체크, 먼저 걸리면 매도)
    //  0. TACTICAL(스캘핑) 오버나이트 금지 / 갭 방어
    //  1. 긴급 손절/리스크 관리 (SL, 하락장, 약세)
    //  2. 트레일링 스톱 (ATR, 수익보호, 마이크로)
    //  3. 하드 익절 — TP% 도달하면 무조건 매도 (isWinnerRiding 무시)
    //  4. 시간 기반 익절 — 오래 들고 있는데 작은 수익 → 확정
    //  5. AI/기술적 매도
    //  6. 시간 손절/약세 정리
    // ════════════════════════════════════════════════════════

    // ── 0. TACTICAL 오버나이트 금지 — 미국장 마감 30분 전 강제청산 (갭 리스크 방지) ──
    if (holding.bucket === 'TACTICAL' && isUSMarketLastNMinutes(30)) {
      sellReason = `스캘핑 마감 강제청산 (오버나이트 갭 방지): ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

      // ── 0b. TACTICAL 갭 방어 하드플로어 — SL 뚫린 갭다운 즉시 탈출 ──
    } else if (holding.bucket === 'TACTICAL' && pnlPct <= -4.0) {
      sellReason = `TACTICAL 갭방어 손절(-4% 하드플로어): ${pnlPct.toFixed(1)}%`;

      // ── 0c. 시간 가중치 트레일링 스탑 (CEO 지시 #C, 2026-06-12) ──
      // Phase 1 (0~48h): 초기 휩소 방어 — 구조적 SL만 허용
      // Phase 2 (48~72h): 본절 이동
      // Phase 3 (72h+): 트레일링 강화
      // SWING bucket (장기 보유)만 적용 (TACTICAL/SCALPING은 위에서 처리)
    } else if (holding.bucket === 'SWING') {
      const { getTimeWeightedStop } = await import('../../risk/entry-timing-guard.js');
      const tws = getTimeWeightedStop({
        holdingHours: holdingDays * 24,
        pnlPct,
        baseSlPct: stopLossPct,
        belowMa20: !tech.aboveMA20,
        belowPrevLow: tech.prevLow5d != null && curPrice < tech.prevLow5d,
      });
      if (tws.action === 'EXECUTE_SL') {
        sellReason = `시간가중치 SL: ${tws.reason}`;
      } else if (tws.action === 'BREAK_EVEN' && pnlPct < 0) {
        // 본절 이동 후 손실 진입 → 손절 (본절 = 0%)
        sellReason = `본절 SL (Phase2): PnL ${pnlPct.toFixed(1)}% < 본절 0%`;
      } else if (tws.action === 'TRAIL_TIGHTEN' && maxPnlPct >= 2.0 && pnlPct < maxPnlPct - 2.0) {
        // v10.10.5c: 고점 2% 이상일 때만 발동 (기존: maxPnlPct<2 시 Math.max(0,...)=0 → 미세 손실도 매도)
        sellReason = `트레일링 SL (Phase3): PnL ${pnlPct.toFixed(1)}% < 트레일 +${(maxPnlPct - 2.0).toFixed(1)}%`;
      } else if (tws.action === 'HOLD') {
        // Phase 1 휩소 방어 중 — 구조적 SL만 허용, 일반 손절은 차단
        // v10.8: 단, 하드 TP/ATR 트레일링/수익 확정은 HOLD에서도 허용 (수익 실현 차단 방지)
        // 🛡️ 절대 하드플로어: HOLD 중에도 -6% 이상 손실은 절대 허용 안 함
        if (pnlPct <= -6.0) {
          sellReason = `HOLD 하드플로어 손절(-6%): ${pnlPct.toFixed(1)}% (Phase1 중에도 절대 한계 초과)`;
        } else if (pnlPct >= hardTpPct) {
          sellReason = `익절(${hardTpPct}%): +${pnlPct.toFixed(1)}% (HOLD 중 TP 도달)`;
        } else if (holdingDays >= 0.5 && maxPnlPct >= trailActivatePct && drawdownFromPeak <= effectiveTrailDropPct) {
          sellReason = `ATR트레일(HOLD중): 고점 +${maxPnlPct.toFixed(1)}% → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
        }
      }
      // sellReason 비어있으면: HOLD가 아닌 경우에만 손절 평가
      if (!sellReason && pnlPct <= stopLossPct && tws.action !== 'HOLD') {
        // 🛡️ 스마트 홀드: SWING도 과매도 바닥에서 SL 완화
        // v12.3: 1.5x→1.2x (기존: -5%SL→-7.5% 허용 = 대형 손실 트랩)
        if (isOversoldBottom && pnlPct > stopLossPct * 1.2) {
          logger.info(`🛡️ 스마트홀드(SWING): ${code} PnL=${pnlPct.toFixed(1)}% RSI=${tech.rsi.toFixed(0)} ADX=${tech.adx.toFixed(0)} → 과매도 반등 대기`, { component: 'OVERSEAS' });
        } else {
          sellReason = `손절(${stopLossPct}%): ${pnlPct.toFixed(1)}%`;
        }
      }

      // ── 1. 손절 (SWING 외) ──
    } else if (pnlPct <= stopLossPct) {
      // 🛡️ 스마트 홀드: 과매도 바닥(RSI<30 + ADX<20)에서 SL 1.2배까지 완화
      // v12.3: 1.5x→1.2x (기존: -5%SL→-7.5% 허용 = 소액 계좌에 치명적)
      if (isOversoldBottom && pnlPct > stopLossPct * 1.2) {
        logger.info(`🛡️ 스마트홀드: ${code} PnL=${pnlPct.toFixed(1)}% RSI=${tech.rsi.toFixed(0)} ADX=${tech.adx.toFixed(0)} → 과매도 반등 대기 (SL완화 ${stopLossPct}%→${(stopLossPct * 1.2).toFixed(1)}%)`, { component: 'OVERSEAS' });
      } else {
        sellReason = `손절(${stopLossPct}%): ${pnlPct.toFixed(1)}%`;
      }

      // ── 1b. 하락장 빠른 정리 ──
      // score<=-20 조건으로 강화 — 시장 전체 급락 시 전종목 동시 발동 방지
    // v10.11: -2.5% → -3.5% (기존: 너무 빨리 손절 → 일시 하락에도 청산)
    } else if (
      vixRegime.regime !== 'CALM' &&
      pnlPct < -3.5 &&
      pnlPct > stopLossPct &&
      tech.score <= -20 &&
      !tech.aboveMA20 &&
      holdingDays >= 1.0
    ) {
      sellReason = `하락장정리(${vixRegime.regime}/${pnlPct.toFixed(1)}%): score=${tech.score} MA20↓ → 현금확보`;

      // ── 1c. 약세 조기 탈출 ──
      // 시장 전체 하락과 개별 종목 약세를 구분하기 위해 임계값 강화
      // 🛡️ 스마트 홀드: 과매도 바닥(RSI<30, ADX<20)에서는 약세 탈출 안함 (반등 대기)
    } else if (
      pnlPct < -3.0 &&
      pnlPct > stopLossPct &&
      tech.score <= -25 &&
      !tech.aboveMA20 &&
      tech.rsi < 40 &&
      holdingDays >= 1 &&
      !isOversoldBottom
    ) {
      sellReason = `약세조기탈출(${pnlPct.toFixed(1)}%): score=${tech.score} RSI=${tech.rsi.toFixed(0)} MA20↓ → SL전 정리`;

      // ── 1d. 시장 급락 수익 선제 확정 ──
      // 근거: VIX>30 후 12개월 수익 중앙값 +22.4% (Bansal & Stivers 2023), 10일 내 반전 78.4% (iPresage)
      // 1% 청산은 반등 알파 파괴 → 레짐별 차등 임계: STRESS≥3%, CRISIS≥2%
      // VIX 스파이크 중 개별주 일일 변동 2~5% → 1% 수익은 노이즈 (Volatility Box 연구)
    } else if (
      (vixRegime.regime === 'STRESS' || vixRegime.regime === 'CRISIS') &&
      pnlPct >= (vixRegime.regime === 'CRISIS' ? 2.0 : 3.0) &&
      holdingDays >= 0.5 && // v11.1: 매수 직후 즉시청산 방지 (12h 가드)
      // CRISIS 진입 포지션(과매도반등/BigMover)은 조기 청산하지 않음 — 평균 +5~10% 목표
      !(vixRegime.regime === 'CRISIS' && pnlPct < 5.0 && holdingDays < 2)
    ) {
      sellReason = `VIX급락 수익선제확정(${vixRegime.regime}): +${pnlPct.toFixed(1)}% → 급락전 청산`;

      // ── 1e. 나스닥 급락 선제 청산 ──
      // 전일 나스닥 -2% 이하 + 수익 구간 → 당일 미국장 약세 선반영, 수익 잠금
      // 왕복 수수료 0.7% 커버 + 실질 수익 최소 1.3% 보장 → 2.0% 기준
    } else if (ctx.nasdaqChange1d != null && ctx.nasdaqChange1d <= -2.0 && pnlPct >= 1.5 && holdingDays >= 0.25) {
      // v10.9.4: 0.5% → 1.5% (왕복 수수료 0.7% 차감 후 순수익 0.8% 보장, 기존 0.5%는 수수료 후 순손실)
      sellReason = `나스닥급락 선제청산(${ctx.nasdaqChange1d.toFixed(1)}%): +${pnlPct.toFixed(1)}% → 미국장 하락 선반영 즉시 수익확정`;

      // ── 2. ATR 트레일링 스톱 ──
    } else if (maxPnlPct >= trailActivatePct && drawdownFromPeak <= effectiveTrailDropPct) {
      sellReason = `ATR트레일(${effectiveTrailDropPct.toFixed(1)}%/ATR${atrPctValue.toFixed(1)}%${vixRegime.trailTighten > 0 ? `/VIX${vixRegime.regime}` : ''}): 고점 +${maxPnlPct.toFixed(1)}% → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

      // ── 2b. 수익보호 50% retrace 제거 — ATR 트레일링이 담당, 정상 풀백에서 위너 조기 절단 방지 ──
      // (기존: maxPnlPct >= 3.0 && pnlPct < maxPnlPct * 0.50 → 매도 → 삭제)

      // ── 2c. 마이크로 트레일 — +2%~트레일활성화 구간 ──
      // 🛡️ 강화 (2026-06-12): pnlPct >= 0 추가. 현재 손실 중이면 "수익보호"가 아니라 손실확정 →
      //   손절 임계까지 보유하거나 시간기반 손절(섹션 6)이 처리하게 양보
      //   과거 SONY 케이스: maxPnlPct=2.0 잠깐 가고 -1.19%에서 매도 (7회 누적 -11.7%)
    } else if (
      maxPnlPct >= 3.5 && // v17: 2.0→3.5 (충분한 수익 확보 후 보호, COIN 같은 고변동 조기매도 방지)
      maxPnlPct < trailActivatePct &&
      pnlPct >= 0 && // 🛡️ 핵심 가드: 현재 수익 상태일 때만
      drawdownFromPeak <= -2.0 && // v17: -1.5→-2.0 (정상 풀백 허용)
      !tech.isMomentum &&
      !(tech.aboveMA20 && tech.adx >= 30)
    ) {
      sellReason = `마이크로트레일(+${maxPnlPct.toFixed(1)}%→+${pnlPct.toFixed(1)}%): 고점 대비 ${drawdownFromPeak.toFixed(1)}% 하락 → 수익보호`;

      // ── 3. 하드 익절 — TP% 도달하면 무조건 매도 (isWinnerRiding 무관) ──
    } else if (pnlPct >= hardTpPct) {
      sellReason = `익절(${hardTpPct}%): +${pnlPct.toFixed(1)}%`;

      // ── 4. 시간 기반 익절 — 8일+ 보유 & +3.0% 이상인데 모멘텀 없음 → 수익 확정 ──
      // v12.1: 5일→8일, 1.5%→3.0% (기존: 5일에 수수료 수준 +1.5%로 조기 청산 → 80% 연속 기회 상실)
    } else if (
      holdingDays >= 8 &&
      pnlPct >= 3.0 &&
      !tech.isMomentum &&
      !(tech.aboveMA20 && tech.adx >= 25) &&
      tech.rsi < 70
    ) {
      sellReason = `시간익절(${holdingDays.toFixed(0)}일/+${pnlPct.toFixed(1)}%): 모멘텀 없음 → 수익확정`;

      // ── 5. AI/기술적 매도 ──
    } else if (ai?.action === 'SELL' && ai.confidence >= 0.9) {
      sellReason = `AI 급매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
    } else if (ai?.action === 'SELL' && ai.confidence >= minAiSellConf && holdingDays >= minHoldForSell) {
      sellReason = `AI 매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
    } else if (
      (!ai || (ai.action === 'SELL' && ai.confidence < minAiSellConf)) &&
      tech.rsi > RSI_BIGMOVER_OVERBOUGHT &&
      pnlPct >= 1.5 &&
      holdingDays >= 0.25
    ) {
      // BigMover RSI 82-88 진입의 대칭 exit — 고 RSI 모멘텀 반전 빠른 청산
      sellReason = `BigMover 과매수 익절: RSI=${tech.rsi.toFixed(0)} +${pnlPct.toFixed(1)}% (모멘텀 반전 위험)`;
    } else if (
      (!ai || (ai.action === 'SELL' && ai.confidence < minAiSellConf)) &&
      tech.rsi > 78 &&
      tech.score < 10 &&
      pnlPct >= 3.0 &&
      holdingDays >= minHoldForSell
    ) {
      sellReason = `기술 익절(과매수): RSI=${tech.rsi.toFixed(0)} +${pnlPct.toFixed(1)}% ${ai ? `(AI=${(ai.confidence * 100).toFixed(0)}%보강)` : ''}`;
    } else if (
      (!ai || (ai.action === 'SELL' && ai.confidence < minAiSellConf)) &&
      tech.score <= -30 &&
      (tech.signal === 'SELL' || tech.signal === 'STRONG_SELL') &&
      holdingDays >= minHoldForSell
    ) {
      sellReason = `기술적 매도: score=${tech.score} RSI=${tech.rsi.toFixed(0)} ${ai ? `(AI SELL ${(ai.confidence * 100).toFixed(0)}%보강)` : ''}`;

      // ── 6. 시간 손절/약세 정리 ──
    } else if (holdingDays >= 3 && pnlPct <= -5.5 && !tech.isMomentum) {
      sellReason = `시간SL(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): 반등 없이 하락 → 조기손절`;
    } else if (holdingDays >= 5 && pnlPct <= -3.0 && tech.score < 0 && !tech.aboveMA20) {
      sellReason = `시간손절(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): score=${tech.score} MA20↓ → 조기정리`;
    } else if (holdingDays >= 7 && pnlPct <= -2.0 && pnlPct > -5.5 && tech.adx < 18) {
      sellReason = `횡보손절(${holdingDays.toFixed(0)}일/${pnlPct.toFixed(1)}%): ADX=${tech.adx.toFixed(0)} 추세없음 → 정리`;
    // v10.11: 보유기한 초과 — 손실 포지션은 추가 20% 유예 (기존: 모든 <3% 즉시 청산 → 반등 기회 없이 손실 확정)
    } else if (holdingDays > effectiveMaxHold && pnlPct < 3.0 && pnlPct >= 0) {
      sellReason = `보유기한 초과(${holdingDays.toFixed(0)}일/미미한 수익): ${pnlPct.toFixed(1)}% → 청산`;
    } else if (holdingDays > effectiveMaxHold * 1.2 && pnlPct < 0) {
      // 손실 포지션: 20% 추가 유예 후에도 마이너스면 손절 (반등 기회 부여)
      sellReason = `보유기한 초과(${holdingDays.toFixed(0)}일/손실): ${pnlPct.toFixed(1)}% → 유예 후 청산`;
    } else if (isWeakStock(tech, holdingDays, pnlPct)) {
      sellReason = `약세종목 정리: ADX=${tech.adx.toFixed(0)} 횡보${holdingDays.toFixed(0)}일 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
    }

    // ── 부분 익절 — isWinnerRiding 무관하게 항상 실행 ──
    // 수익 있을 때 조금씩 확정하는 게 핵심 (승자 라이딩은 잔여 수량으로 충분)
    // ATR 급확장(ADX 35+ & ATR 3%+)일 때만 보류
    const atrExpanding = atrPctValue > 3.0 && tech.adx >= 35;
    if (!sellReason && holding.qty >= 2 && !atrExpanding) {
      // v15: 모멘텀 컨텍스트 전달 → 가속 중이면 Stage 1 트리거 유지, 아니면 낮춤 (Quick Win)
      const momentumCtx: MomentumContext = {
        isMomentum: tech.isMomentum,
        rsi: tech.rsi,
        adx: tech.adx,
        volumeRatio: tech.price.volume > 0 ? undefined : undefined, // 평균거래량 없으면 undefined
        vwapPosition: tech.vwapPosition,
      };
      const tpStages = getPartialTpStages(sector, holding.bucket, momentumCtx);
      // v15 Self-Learning Turbo: tuner가 학습한 최적 Stage 1 트리거 적용
      const tunerStage1 = tunerOverrides[`partial_tp_stage1_${sector}`] ?? tunerOverrides.partial_tp_stage1_pct;
      if (tunerStage1 != null && tpStages.length > 0 && tpStages[0].stage === 1) {
        tpStages[0].triggerPct = tunerStage1;
      }
      const currentStage = await getPartialTpStageNum(code);
      // 수수료 반영: 왕복 수수료(0.7%) 를 트리거에 가산하여 실질 수익 보장
      const roundTripFee = OVERSEAS_FEE_PCT * 2 * 100; // 0.7%
      const nextStage = tpStages.find((st) => st.stage > currentStage && pnlPct >= st.triggerPct + roundTripFee);
      if (nextStage) {
        const partialQty = Math.max(1, Math.floor(holding.qty * nextStage.sellRatio));
        const partialReason = `부분익절${nextStage.stage}단계(+${nextStage.triggerPct}%) +${pnlPct.toFixed(1)}% → ${(nextStage.sellRatio * 100).toFixed(0)}% 실현`;
        logger.info(
          `[PartialTP-${nextStage.stage}] ${code} ${partialQty}주 @ $${curPrice.toFixed(2)} (${partialReason})`,
          { component: 'OVERSEAS' },
        );
        const exec = await executeOverseasOrder(
          code,
          'SELL',
          partialQty,
          curPrice,
          tech.exchange,
          partialReason,
          holding.qty,
          holding.avgPrice,
          { isPaper: paperMode },
        );
        if (exec.submitted && exec.filledQty > 0) {
          const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
          cash += proceeds;
          await updateTradeState({
            code,
            exchange: tech.exchange,
            qty: exec.finalQty,
            avgPrice: exec.finalAvgPrice,
            newCash: cash,
            isPaper: paperMode,
            fxRate: ctx.fxRate,
          });
          await setPartialTpStageNum(code, nextStage.stage, paperMode);
          sellOrders.push(
            `부분익절${nextStage.stage} ${code} x${partialQty} @$${exec.filledPrice.toFixed(2)} (${partialReason})`,
          );
        }
        continue;
      }
    }

    if (sellReason) {
      const exec = await executeOverseasOrder(
        code,
        'SELL',
        holding.qty,
        curPrice,
        tech.exchange,
        sellReason,
        holding.qty,
        holding.avgPrice,
        { isPaper: paperMode },
      );
      if (!exec.submitted) continue;
      if (exec.filledQty <= 0) {
        pendingOrderStocks.add(code);
        sellOrders.push(`매도 접수 ${code} x${holding.qty} (체결 대기)`);
        continue;
      }
      const proceeds = exec.filledPrice * exec.filledQty * (1 - OVERSEAS_FEE_PCT);
      cash += proceeds;
      await updateTradeState({
        code,
        exchange: tech.exchange,
        qty: exec.finalQty,
        avgPrice: exec.finalAvgPrice,
        newCash: cash,
        isPaper: paperMode,
        fxRate: ctx.fxRate,
      });
      if (exec.finalQty <= 0) {
        await cleanupPositionState(code, paperMode);
      }
      sellOrders.push(
        `매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason}) [수수료 $${(exec.filledPrice * exec.filledQty * OVERSEAS_FEE_PCT).toFixed(2)}]`,
      );
    }
  }

  return { sellOrders, cash };
}

/** 개선#9: ADX 기반 동적 보유기간 — 강한 추세는 오래, 횡보는 빨리 */
function calcDynamicHoldDays(baseMaxHold: number, tech: TechResult, _holdingDays: number): number {
  let mult = 1.0;
  // 강한 추세 (ADX ≥ 35) → 1.5배 보유 (러너 홀딩)
  if (tech.adx >= 35 && tech.rsi >= 45 && tech.rsi <= 75) mult = 1.5;
  // 보통 추세 (ADX 20~35) → 기본
  else if (tech.adx >= 20) mult = 1.0;
  // 약한 추세 (ADX < 20) → 60% 보유 (자본 회전 가속)
  else mult = 0.6;
  // 모멘텀/빅무버 → 최소 1.2배 보유
  if (tech.isMomentum || tech.isBigMover) mult = Math.max(mult, 1.2);
  return Math.max(1, Math.round(baseMaxHold * mult)); // 최소 1일 보장 (음수/0 방어)
}

/** 약세 종목 조기 정리 — ADX < 15 + 7일 이상 횡보 + 수익 미미 */
function isWeakStock(tech: TechResult, holdingDays: number, pnlPct: number): boolean {
  // v10.11: 5→7일 (기존: 너무 일찍 정리 → 손실 빈도 증가)
  if (holdingDays < 7) return false;
  // v10.11: 손실 범위 -3%까지만 (기존 -5%: 깊은 손실까지 약세로 분류 → 반등전 정리)
  if (pnlPct > 5 || pnlPct < -3) return false;
  // ADX < 15 = 추세 없음 + 횡보 + 미미한 수익/손실
  return tech.adx < 15 && Math.abs(tech.price.changePct) < 1.5;
}
