/**
 * 유휴 현금 파킹 관리자 v2 — 퍼센트 기반 동적 파킹
 *
 * v1 문제:
 *   - 30분 최소보유 → 삼성 3회 회전 발생, 매번 손실
 *   - 손실 상태에서 무조건 해제 → 한화오션 -5.5% 확정
 *   - 고정 50% 파킹 → 현금잔고/시장 상황 무시
 *
 * v2 혁신:
 *   - 100% 퍼센트 기반: 고정형 금액 0개, 총자산×동적비율
 *   - 현금잔고 연동: 현금 많을수록 파킹 비율 ↑, 적으면 ↓
 *   - 타이밍 품질 반영: 기술점수 높으면 더 큰 포지션
 *   - 손실 보호: -1.5% 이하면 해제 금지 (회복 대기)
 *   - 2시간 최소 보유: 단타 회전 원천 차단
 *   - 1종목 집중: 2종목 분산 폐지 (회전 줄이고 관리 단순화)
 *   - 수익 자동실현: +2% 이상이면 매수신호 없어도 익절
 *   - Paper 최적화: 연습모드는 쿨다운 짧게 (학습 가속)
 *
 * DEFENSE 모드는 defense-park.ts가 담당
 */

import { analyzeTechnicals } from '../../analysis/indicators.js';
import type { StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import { THEME_CLUSTERS } from '../../automation/sector-themes.js';
import { logger } from '../../utils/logger.js';

// ── 총자산 대비 최소 현금 보유 비율 (defense-park.ts도 임포트) ──
export const CASH_RESERVE_RATIO = 0.2;

/** 모드별 현금 보유 비율: Paper 3% / Live 20% */
export function getCashReserveRatio(isPaper?: boolean): number {
  return isPaper ? config.paperRisk.cashReserveRatio : CASH_RESERVE_RATIO;
}

// ── v2 핵심 상수: 전부 비율(%) 기반, 고정 금액 없음 ──

/** 파킹 검토 시작 현금 비율 — 40% 이상 (v-tune: 놀고 있는 현금 최소화, 하락장 가드는 별도) */
const PARK_TRIGGER_RATIO = 0.4;

/** 파킹 최소 금액: 총자산의 2% (절대 최소 1만원은 소자산 폴백) */
const MIN_PARK_RATIO = 0.02;

/** 파킹 최대 비중: 총자산의 30% live / 40% paper (positionCapRatio와 정렬) */
const MAX_PARK_RATIO_LIVE = 0.3;
const MAX_PARK_RATIO_PAPER = 0.4;

/** 최소 보유 시간 (ms) — 1시간 (v1: 30분→v2: 2시간→v3: 1시간, 시장 반전 대응력 개선) */
const MIN_PARK_HOLD_MS = 1 * 60 * 60_000; // 1 hour

/** Paper 모드 최소 보유 — 1시간 (실전과 유사하게 테스트) */
const MIN_PARK_HOLD_MS_PAPER = 60 * 60_000; // 1 hour

/** 파킹 손절: -2% 도달 시 즉시 해제 (파킹=원금보전, 손실 고착 방지) */
const PARK_STOP_LOSS_PCT = -2.0;

/** 해제 손실 보호: -2% 이상 손실이 아니면 해제 허용 (기존: 무조건 본전→회복 대기 → 손실 고착) */
const UNPARK_MAX_LOSS_PCT = PARK_STOP_LOSS_PCT;

/** 해제 강제 타임아웃: 3시간 넘으면 손실이어도 해제 (v-tune: 6h→3h, 묶임 방지) */
const UNPARK_FORCE_TIMEOUT_MS = 3 * 60 * 60_000; // 3 hours

/** 수익 자동실현: +2% 이상이면 매수신호 없어도 익절 (v-tune: 5%→2%, 대형주 현실적 목표) */
const PARK_PROFIT_TAKE_PCT = 2.0;

/** 최대 파킹 종목 수 — v2는 1종목 집중 (회전 방지) */
const MAX_PARK_POSITIONS = 1;

// ── 파킹 후보 v-tune: 국내 고배당/안정 ETF 우선 + 메가캡 폴백 ──
// 배당 ETF: 원금보전 + 배당수익 (변동성 낮음, 수수료 이상 수익 목표)
export const DIVIDEND_ETF_PARK_CANDIDATES: Array<{ code: string; name: string; priority: number }> = [
  { code: '161510', name: 'KODEX 고배당', priority: 1 },
  { code: '211560', name: 'TIGER 배당성장', priority: 2 },
  { code: '278530', name: 'KODEX 고배당가치', priority: 3 },
  { code: '404780', name: 'KODEX CD금리액티브', priority: 4 },  // 초안정 (금리형)
  { code: '069500', name: 'KODEX 200', priority: 5 },
  { code: '148020', name: 'KBSTAR 200', priority: 6 },
];

// 메가캡 폴백 (ETF 거래 불가 시)
export const MEGA_CAP_PARK_CANDIDATES: Array<{ code: string; name: string }> = [
  { code: '005930', name: '삼성전자' },
  { code: '005380', name: '현대차' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '005935', name: '삼성전자우' },
];

/**
 * 배당 ETF 1등 선정 — 가격 데이터 기반 안정성 순위
 * 기준: 당일 변동률이 가장 안정적(0% 근처) + 양수인 종목 우선
 */
function getBestDividendETF(
  livePrices: Map<string, CurrentPrice>,
): { code: string; name: string } | null {
  const scored = DIVIDEND_ETF_PARK_CANDIDATES
    .map((etf) => {
      const p = livePrices.get(etf.code);
      if (!p || p.currentPrice <= 0) return null;
      // 안정성 점수: |변동률|이 작을수록 좋고, 양수이면 보너스
      const stability = 100 - Math.abs(p.changePct) * 20 + (p.changePct > 0 ? 10 : 0);
      return { ...etf, price: p, stability };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.stability - a.stability);

  return scored[0] ?? null;
}

// 레거시 호환 (pipeline.ts에서 참조)
export const IDLE_PARK_STOCK_CODE = MEGA_CAP_PARK_CANDIDATES[0].code;

// ── 테마 기반 대형주 + 배당 ETF — 파킹 대상 인식용 ──
const THEME_LARGE_CAPS = new Set([
  '005930', '000660', '005380', '012450', '005935', // 기본 메가캡
  '161510', '211560', '278530', '404780', '069500', '148020', // 배당 ETF
  '373220', '006400', '051910',     // 배터리: LG에너지솔루션, 삼성SDI, LG화학
  '034020', '298040', '015760',     // 전력/원전: 두산에너빌리티, 효성중공업, 한전
  '009540', '042660',               // 조선: HD현대중공업, 한화오션
  '207940', '068270', '128940',     // 바이오: 삼성바이오, 셀트리온, 한미약품
  '000270', '012330',               // 자동차: 기아, 현대모비스
  '005490', '004020',               // 철강: POSCO홀딩스, 현대제철
  '064350', '079550',               // 방산: 현대로템, LIG넥스원
  '010120', '267260',               // 전력장비: LS일렉트릭, 현대일렉트릭
  '086520', '247540',               // 에코프로 (대형)
]);

/**
 * 오늘의 테마 파킹 후보 — 뉴스/가격 기반 동적 선택
 * 1. 테마 클러스터별 평균 등락률 산출
 * 2. 최고 테마(+1.5%↑)에서 대형주 후보 추출
 * 3. 기본 5종목 + 테마 후보 병합 반환
 */
function getThemeParkCandidates(
  livePrices: Map<string, CurrentPrice>,
): { candidates: Array<{ code: string; name: string }>; hotTheme: string | null } {
  let bestTheme: { id: string; name: string; avgChange: number } | null = null;

  for (const cluster of THEME_CLUSTERS) {
    let total = 0;
    let count = 0;
    for (const s of cluster.stocks) {
      const p = livePrices.get(s.code);
      if (p) { total += p.changePct; count++; }
    }
    if (count < 2) continue;
    const avg = total / count;
    if (avg >= 1.5 && (!bestTheme || avg > bestTheme.avgChange)) {
      bestTheme = { id: cluster.id, name: cluster.name, avgChange: avg };
    }
  }

  // v29: 파킹은 개별주를 '의무적으로' 강제매수하지 않는다 — 메가캡(삼성전자 등)·테마주 제거.
  //   근거(CEO): "의무적으로 주식 사는 파킹은 말이 안됨". 파킹=원금보전 목적 → 개별주(변동성) 부적합.
  //   → 안정 ETF(고배당/CD금리/지수)만 후보. 하락장 인버스는 호출부(effectiveParkPool)에서 최우선 추가.
  //   안정 ETF마저 하락(-0.5%↓) 필터로 다 걸러지면 후보 0 → 파킹 안 함(현금 보유). 강제매수 없음.
  return { candidates: [...DIVIDEND_ETF_PARK_CANDIDATES], hotTheme: bestTheme?.id ?? null };
}

export interface CashManagerParams {
  orderableCash: number;
  totalAssets: number;
  hasBuyCandidates: boolean;
  /** 실제 BUY 액션이 존재하는 결정 수 (trade-gate 통과한 것만) */
  confirmedBuyCount?: number;
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  chartData?: Map<string, DailyCandle[]>;
  mode: StrategyMode;
  blockNewBuys: boolean;
  /** RISK_OFF 조정장 — 대형주 파킹 중단, 현금 유지 */
  macroRiskOff?: boolean;
  /** Paper 모드 여부 (쿨다운/파라미터 분리) — 필수: undefined 허용 안 함 */
  isPaper: boolean;
  /** 해외 목표 비중 (0~100, 예: 70 = 총자산의 70% 해외 예약) — 국내 파킹 예산 제한용 */
  overseasTargetPct?: number;
}

// ── 동적 파킹 비율 산출: 현금잔고 + 타이밍 품질 → 총자산 대비 % ──
// Paper: 황금비율 — 유휴현금 적극 배치 (학습 가속, 모의자금이므로 리스크 허용 상향)
// Live: 보수적 — 실자금 보호 우선
function getDynamicParkPct(cashRatio: number, timingScore: number, isPaper: boolean): number {
  let basePct: number;
  if (isPaper) {
    // Paper 황금비율: 현금 많을수록 공격적으로 배치
    if (cashRatio >= 0.8)
      basePct = 0.35; // 80%+ → 35%
    else if (cashRatio >= 0.65)
      basePct = 0.28; // 65-80% → 28%
    else if (cashRatio >= 0.5)
      basePct = 0.2; // 50-65% → 20%
    else if (cashRatio >= 0.4)
      basePct = 0.13; // 40-50% → 13%
    else if (cashRatio >= PARK_TRIGGER_RATIO)
      basePct = 0.08; // 30-40% → 8%
    else return 0;
  } else {
    // Live (v-tune: 적극 배치하되 손절로 보호, 현금 놀림 최소화)
    if (cashRatio >= 0.8) basePct = 0.18;        // 22→18% (현금 80%면 적극 배치)
    else if (cashRatio >= 0.65) basePct = 0.12;   // 16→12%
    else if (cashRatio >= 0.5) basePct = 0.08;    // 12→8%
    else if (cashRatio >= PARK_TRIGGER_RATIO) basePct = 0.05; // 40~50% → 5%
    else return 0;
  }

  // 타이밍 품질 승수 (0.7x ~ 1.2x) — v-tune: 범위 축소 (파킹=보수적, 큰 포지션 방지)
  const timingMult =
    timingScore >= 35 ? 1.2 : timingScore >= 20 ? 1.1 : timingScore >= 10 ? 1.0 : timingScore >= 0 ? 0.8 : 0.7;

  const maxRatio = isPaper ? MAX_PARK_RATIO_PAPER : MAX_PARK_RATIO_LIVE;
  const rawPct = basePct * timingMult;
  return Math.min(rawPct, maxRatio);
}

/**
 * 유휴 현금 파킹 결정 생성 v2
 * 반환값: SELL(파킹 해제) 결정은 decisions 앞에, BUY(파킹) 결정은 뒤에 추가할 것
 */
export function manageCashParking(params: CashManagerParams): TradeDecision[] {
  const {
    orderableCash,
    totalAssets,
    hasBuyCandidates,
    confirmedBuyCount,
    openChains,
    livePrices,
    chartData,
    mode,
    blockNewBuys,
    macroRiskOff,
    isPaper,
  } = params;

  if (mode === 'DEFENSE') return [];

  const decisions: TradeDecision[] = [];
  const minHoldMs = isPaper ? MIN_PARK_HOLD_MS_PAPER : MIN_PARK_HOLD_MS;

  // 현재 파킹 중인 대형주 체인 확인 (기본 메가캡 + 테마 대형주 모두 포함)
  const parkingCodes = new Set([...MEGA_CAP_PARK_CANDIDATES.map((c) => c.code), ...THEME_LARGE_CAPS]);
  const parkChains = openChains.filter((c) => parkingCodes.has(c.stock_code));

  // ── 파킹 해제 로직 v2 ──
  if (parkChains.length > 0) {
    for (const parkChain of parkChains) {
      const qty = Number(parkChain.total_quantity ?? 0);
      if (qty <= 0) continue;

      const holdMs = parkChain.opened_at ? Date.now() - new Date(parkChain.opened_at).getTime() : 0;
      const avgPrice = Number(parkChain.avg_buy_price ?? 0);
      const currentPrice = livePrices.get(parkChain.stock_code)?.currentPrice ?? 0;
      const pnlPct = avgPrice > 0 && currentPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
      const name = MEGA_CAP_PARK_CANDIDATES.find((c) => c.code === parkChain.stock_code)?.name
        ?? THEME_CLUSTERS.flatMap((cl) => cl.stocks).find((s) => s.code === parkChain.stock_code)?.name
        ?? parkChain.stock_code;

      // ── 파킹 손절: -2% 도달 시 즉시 해제 (파킹=원금보전, 손실 고착 방지) ──
      if (pnlPct <= PARK_STOP_LOSS_PCT && holdMs >= 30 * 60_000) { // 30분 최소 보유 후 손절
        logger.info(`🚫 파킹 손절: ${name} ${pnlPct.toFixed(1)}% (${qty}주) — 원금보전 실패, 즉시 해제`, {
          component: 'CASH_MANAGER',
        });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: `🚫 파킹 손절: ${name} ${pnlPct.toFixed(1)}% — 손절선(${PARK_STOP_LOSS_PCT}%) 도달`,
          confidence: 0.95,
        });
        continue;
      }

      // ── 수익 자동실현: +2% 이상이면 매수신호 없어도 익절 ──
      if (pnlPct >= PARK_PROFIT_TAKE_PCT && holdMs >= minHoldMs) {
        logger.info(`🎉 파킹 익절: ${name} +${pnlPct.toFixed(1)}% (${qty}주) — 수익 자동실현`, {
          component: 'CASH_MANAGER',
        });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: `🎉 파킹 익절: ${name} +${pnlPct.toFixed(1)}% — 수익 자동실현 (목표 ${PARK_PROFIT_TAKE_PCT}%+)`,
          confidence: 0.92,
        });
        continue;
      }

      // ── 타임아웃 강제 해제: confirmedBuyCount 관계없이 묶임 방지 ──
      const forceTimeout = holdMs >= UNPARK_FORCE_TIMEOUT_MS;
      if (forceTimeout) {
        const reason = `⏰ 파킹 타임아웃 해제: ${name} ${pnlPct.toFixed(1)}% (${Math.round(holdMs / 3600_000)}h 초과) — 묶임 방지`;
        logger.info(reason, { component: 'CASH_MANAGER' });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: reason,
          confidence: 0.9,
        });
        continue;
      }

      // ── 확정 매수 신호에 의한 해제 ──
      if ((confirmedBuyCount ?? 0) > 0) {
        // 최소 보유 시간 체크
        if (holdMs < minHoldMs) {
          const remainMin = Math.ceil((minHoldMs - holdMs) / 60_000);
          logger.info(
            `⏳ 파킹 유지: ${name} ${remainMin}분 남음 (PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
            { component: 'CASH_MANAGER' },
          );
          continue;
        }

        // ── 손실 보호: 큰 손실이면 해제 금지 (회복 대기) ──
        if (pnlPct < UNPARK_MAX_LOSS_PCT) {
          logger.info(
            `🛡️ 파킹 손실보호: ${name} ${pnlPct.toFixed(1)}% — 손실 중 해제 금지, 본전 이상 대기 (${Math.round(holdMs / 60_000)}분 보유)`,
            { component: 'CASH_MANAGER' },
          );
          continue;
        }

        // 해제 승인
        const reason = `🔄 파킹 해제: ${name} +${pnlPct.toFixed(1)}% — 확정 매수 ${confirmedBuyCount}건 (본전↑ 확인)`;
        logger.info(reason, { component: 'CASH_MANAGER' });
        decisions.push({
          action: 'SELL',
          stock_code: parkChain.stock_code,
          quantity: qty,
          price_type: 'MARKET',
          reasoning: reason,
          confidence: 0.9,
        });
      }
    }
    if (decisions.length > 0) return decisions;
  }

  // ── 파킹 매수 조건 v2 ──
  // v28: 파킹 매수는 연습모드 전용 — 실전에서 파킹으로 사면 손실만 남 (CEO 지시)
  if (!isPaper) {
    logger.debug(`💤 파킹 매수 스킵 — 실전모드 파킹 비활성화`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  // RISK_OFF: 조정장 파킹 전면 중단
  if (macroRiskOff) {
    logger.info(`💤 파킹 중단 — 조정장(RISK_OFF) 현금 유지`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  // 이미 최대 파킹 포지션 보유
  if (parkChains.length >= MAX_PARK_POSITIONS) return decisions;

  const cashRatio = totalAssets > 0 ? orderableCash / totalAssets : 0;
  if (cashRatio < PARK_TRIGGER_RATIO) return decisions;

  // 매수 후보 있으면 현금 확보 (단, 현금 60% 이상이면 일부 파킹)
  if (hasBuyCandidates && cashRatio < 0.6) return decisions;

  // 최소 파킹 금액: 총자산의 2%
  const minParkAmount = Math.max(totalAssets * MIN_PARK_RATIO, 10_000);
  if (orderableCash < minParkAmount) return decisions;

  // 이미 파킹 중인 종목 + 보유 중인 종목 제외
  const alreadyHeld = new Set(openChains.map((c) => c.stock_code));

  // ── 오늘의 테마 + 대형주 선택: 뉴스/가격 + 기술분석 타이밍 ──
  const { candidates: parkPool, hotTheme } = getThemeParkCandidates(livePrices);

  // v29: 하락장 인버스 파킹 우선 — KODEX 인버스(114800) 상승 중(=시장 하락)이면 파킹 차량 최우선.
  //   기존: 인버스가 후보에 없어 삼성전자 등 대형주만 파킹 → 하락장에 동반 하락(삼성전자 -4.9% 손절 사례).
  const _invParkP = livePrices.get('114800');
  const _invDownMarket = !!_invParkP && _invParkP.changePct >= 0.5 && !alreadyHeld.has('114800');
  const effectiveParkPool = _invDownMarket ? [{ code: '114800', name: 'KODEX 인버스' }, ...parkPool] : parkPool;

  const scored = effectiveParkPool.filter((c) => !alreadyHeld.has(c.code))
    .map((c) => {
      const price = livePrices.get(c.code);
      const candles = chartData?.get(c.code);
      const tech = candles && candles.length >= 30 ? analyzeTechnicals(candles) : null;
      let timingScore = 0;
      if (tech) {
        // RSI 눌림목
        if (tech.rsi14 < 30) timingScore += 10;
        else if (tech.rsi14 < 50) timingScore += 15;
        else if (tech.rsi14 < 60) timingScore += 5;
        else if (tech.rsi14 > 70) timingScore -= 5;
        // MACD
        if (tech.macdCrossover === 'BULLISH') timingScore += 12;
        else if (tech.macdHistogram > 0) timingScore += 5;
        else if (tech.macdCrossover === 'BEARISH') timingScore -= 8;
        // 볼린저
        if (tech.bollingerBreakout === 'DOWN') timingScore += 8;
        if (tech.bollingerSqueeze) timingScore += 5;
        // VWAP
        if (tech.vwapPullback) timingScore += 8;
        if (tech.vwapCross === 'JUST_ABOVE') timingScore += 6;
        // 캔들 패턴
        if (tech.candlePatterns.some((p) => p.bullish && p.strength === 'STRONG')) timingScore += 10;
        else if (tech.candlePatterns.some((p) => p.bullish)) timingScore += 4;
      }
      // 🎯 배당 ETF 보너스: 안정성 최우선 — 파킹의 본래 목적에 부합
      const isDividendETF = DIVIDEND_ETF_PARK_CANDIDATES.some((e) => e.code === c.code);
      if (isDividendETF) timingScore += 20; // 배당 ETF는 항상 우선 (안정성 보장)
      // 테마 보너스: 핫 테마 종목이면 +8점 (배당 ETF보다 낮게)
      const isThemeStock = hotTheme && !MEGA_CAP_PARK_CANDIDATES.some((m) => m.code === c.code) && !isDividendETF;
      if (isThemeStock) timingScore += 8;
      // v29: 하락장 인버스 최우선 (+40 — 배당ETF보너스 +20보다 높게)
      if (c.code === '114800' && _invDownMarket) timingScore += 40;
      return { ...c, price, tech, timingScore };
    })
    // 당일 하락 종목 제외 (v-tune: 칼잡이 원천 차단)
    // Live: 당일 -0.5% 이하면 파킹 대상 제외 (파킹=원금보전, 하락중 매수 금지)
    // Paper: -2% 허용 (학습 기회). v29: 인버스는 상승 중이면 상한캡(5%) 면제.
    .filter((c) =>
      c.code === '114800'
        ? !!c.price && c.price.changePct >= 0.5
        : !!c.price && c.price.changePct >= (isPaper ? -2.0 : -0.5) && c.price.changePct <= 5.0,
    );

  // 타이밍 점수 정렬
  const candidates = scored.sort((a, b) => b.timingScore - a.timingScore);

  if (candidates.length === 0) {
    logger.info(`💤 파킹 후보 없음 (현금 ${(cashRatio * 100).toFixed(0)}%)`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  const best = candidates[0];

  // 타이밍 점수 하한: live=10, paper=5 (v-tune: 기술적 확인 없는 파킹 차단)
  const timingFloor = isPaper ? 5 : 10;
  if (best.timingScore < timingFloor) {
    logger.info(`💤 파킹 보류 — 타이밍 부적합 (최고=${best.timingScore}점, 기준=${timingFloor})`, {
      component: 'CASH_MANAGER',
    });
    return decisions;
  }

  // ── 동적 파킹 비율 산출 (황금비율) ──
  const parkPct = getDynamicParkPct(cashRatio, best.timingScore, isPaper);
  if (parkPct <= 0) return decisions;

  const targetBudget = totalAssets * parkPct;
  // 현금 사용 한도: paper=60% (유휴현금 적극 배치), live=40% (나머지 자동매매용)
  const cashCeilRatio = isPaper ? 0.6 : 0.4;
  let effectiveCash = orderableCash;

  // ── 해외 현금 예약: us_pct만큼 현금을 해외용으로 보존 ──
  // 국내 파킹은 국내 몫(kr_pct) 내에서만 허용, 해외 예산 침범 방지
  const osPct = params.overseasTargetPct ?? 0;
  if (osPct > 0) {
    const domesticInvested = openChains.reduce((sum, c) => sum + Number(c.total_invested ?? 0), 0);
    const domesticBudgetCeil = totalAssets * ((100 - osPct) / 100);
    const remainingDomesticBudget = Math.max(0, domesticBudgetCeil - domesticInvested);
    effectiveCash = Math.min(effectiveCash, remainingDomesticBudget);
    if (effectiveCash < minParkAmount) {
      logger.info(
        `💤 파킹 보류 — 국내 예산 소진 (국내투자 ${Math.round(domesticInvested / 10000)}만 / 한도 ${Math.round(domesticBudgetCeil / 10000)}만, 해외예약 ${osPct}%)`,
        { component: 'CASH_MANAGER' },
      );
      return decisions;
    }
  }

  const parkBudget = Math.min(targetBudget, effectiveCash * cashCeilRatio);
  if (parkBudget < minParkAmount) return decisions;

  const targetPrice = best.price!.currentPrice;
  const quantity = Math.floor(parkBudget / targetPrice);
  if (quantity < 1) return decisions;

  const actualAmount = quantity * targetPrice;
  const actualPctOfAssets = totalAssets > 0 ? ((actualAmount / totalAssets) * 100).toFixed(1) : '?';

  logger.info(
    `💰 파킹 v2 [${isPaper ? 'PAPER' : 'LIVE'}]: ${best.name}(${best.code}) ${quantity}주 @${targetPrice.toLocaleString()} ` +
      `totalAssets=${Math.round(totalAssets / 10000)}만 | 총자산비중 ${actualPctOfAssets}% | 현금 ${(cashRatio * 100).toFixed(0)}% | ` +
      `타이밍 ${best.timingScore}점 | 당일 ${best.price!.changePct >= 0 ? '+' : ''}${best.price!.changePct.toFixed(2)}%`,
    { component: 'CASH_MANAGER', isPaper },
  );

  decisions.push({
    action: 'BUY',
    stock_code: best.code,
    quantity,
    limit_price: targetPrice,
    price_type: 'MARKET',
    reasoning: `💰 파킹 v2: ${best.name} — 총자산 ${actualPctOfAssets}% | 현금 ${(cashRatio * 100).toFixed(0)}% | 타이밍 ${best.timingScore}점`,
    confidence: 0.7,
    ai_score: 75,
    trigger_source: 'CASH_PARKING',
    // v29: 파킹은 PARKING 모드로 명시 라벨 — 기존엔 파이프라인 mode(paper=SCALPING) 상속돼
    //   전략랩에서 파킹 트레이드가 SCALPING으로 잡히던 불일치(셀트리온 짧은 매매 등) 정확히 구분.
    strategy_mode: 'PARKING',
  });

  return decisions;
}
