/**
 * 유휴 현금 파킹 관리자
 *
 * 전략:
 *   - 현금 비중 60%+ + 매수 후보 없음 → KOSPI 시총 대형주 중 당일 상승 종목에 파킹
 *   - 파킹 종목이 이미 OPEN 상태면 유지 (재매수 없음)
 *   - 파킹 포지션 청산 조건: 좋은 매수 후보 등장 OR 현금 필요 OR SL/TP 백엔드 처리
 *
 * DEFENSE 모드는 defense-park.ts가 담당
 */

import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import type { StrategyMode } from '../../config/constants.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import { logger } from '../../utils/logger.js';

// 총자산 대비 최소 현금 보유 비율 (defense-park.ts도 임포트)
export const CASH_RESERVE_RATIO = 0.25;

// 파킹 시작 기준 — 현금 이 비율 초과 시 파킹 검토 (적극적: 30%)
// CEO 지시: "20~30% 현금 놀리면 손해" → 30% 이상이면 즉시 파킹
const PARK_TRIGGER_RATIO = 0.30;

// 파킹 매수 최소 금액 (소액 계좌도 파킹 가능)
const MIN_PARK_AMOUNT = 100_000;

// 파킹 매수 최대 비중 (총자산 대비) — 파워풀: 35%까지 파킹
const MAX_PARK_RATIO = 0.35;

// KOSPI 시가총액 Top 10 파킹 후보 (시총 순, 2026년 기준)
// CEO 지시: "잘 모르겠으면 대형주에 파킹, 더 좋은 기회 오면 풀고 나와서 매매"
// 당일 상승 중인 종목 우선 선택, -3~+5% 범위 필터
export const MEGA_CAP_PARK_CANDIDATES: Array<{ code: string; name: string }> = [
  // ── 반도체 ──
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '042700', name: '한미반도체' },
  // ── 자동차/현대 ──
  { code: '005380', name: '현대차' },
  { code: '000270', name: '기아' },
  { code: '012330', name: '현대모비스' },
  // ── 방산/한화 ──
  { code: '012450', name: '한화에어로스페이스' },
  { code: '272210', name: '한화시스템' },
  { code: '042660', name: '한화오션' },
  // ── 방산/기타 ──
  { code: '064350', name: '현대로템' },
  // ── 플랫폼 ──
  { code: '035420', name: 'NAVER' },
];

// 레거시 호환 (pipeline.ts에서 참조)
export const IDLE_PARK_STOCK_CODE = MEGA_CAP_PARK_CANDIDATES[0].code;

export interface CashManagerParams {
  orderableCash: number;
  totalAssets: number;
  hasBuyCandidates: boolean;
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  chartData?: Map<string, DailyCandle[]>;
  mode: StrategyMode;
  blockNewBuys: boolean;
}

/**
 * 유휴 현금 파킹 결정 생성
 * 반환값: SELL(파킹 해제) 결정은 decisions 앞에, BUY(파킹) 결정은 뒤에 추가할 것
 */
export function manageCashParking(params: CashManagerParams): TradeDecision[] {
  const { orderableCash, totalAssets, hasBuyCandidates, openChains, livePrices, chartData, mode, blockNewBuys } = params;

  if (mode === 'DEFENSE') return []; // defense-park.ts가 처리
  if (blockNewBuys) return [];

  const decisions: TradeDecision[] = [];

  // 현재 파킹 중인 대형주 체인 확인
  const parkingCodes = new Set(MEGA_CAP_PARK_CANDIDATES.map(c => c.code));
  const parkChains = openChains.filter(c => parkingCodes.has(c.stock_code));

  // ── 파킹 자동 해제: 좋은 매수 신호 등장 시 파킹 청산 → 더 큰 수익 기회에 재투자 ──
  if (hasBuyCandidates && parkChains.length > 0) {
    for (const parkChain of parkChains) {
      const qty = Number(parkChain.total_quantity ?? 0);
      if (qty <= 0) continue;
      const name = MEGA_CAP_PARK_CANDIDATES.find(c => c.code === parkChain.stock_code)?.name ?? parkChain.stock_code;
      logger.info(
        `🔄 파킹 해제: ${name}(${parkChain.stock_code}) ${qty}주 → 더 큰 수익 기회로 현금 재배치`,
        { component: 'CASH_MANAGER' },
      );
      decisions.push({
        action: 'SELL',
        stock_code: parkChain.stock_code,
        quantity: qty,
        price_type: 'MARKET',
        reasoning: `🔄 파킹 해제 — 고확신 매수 신호 등장, 현금 재투입`,
        confidence: 0.90,
      });
    }
    return decisions; // 해제 결정만 반환, 신규 파킹 매수 없음
  }

  // ── 파킹 매수 조건 ──
  const cashRatio = totalAssets > 0 ? orderableCash / totalAssets : 0;
  if (cashRatio < PARK_TRIGGER_RATIO) return decisions; // 현금 30% 미만 → 파킹 불필요
  // 현금 60%+ 초과: 기술 조건 실패로 실제 매수 안 될 때도 파킹 강행
  if (hasBuyCandidates && cashRatio < 0.60) return decisions;
  if (orderableCash < MIN_PARK_AMOUNT) return decisions;

  // 이미 파킹 중인 종목 제외
  const alreadyParked = new Set(openChains.map(c => c.stock_code));

  // 대형주 선택: 기술분석 타이밍 기반 (RSI 눌림목, MACD, 지지선 등)
  const scored = MEGA_CAP_PARK_CANDIDATES
    .filter(c => !alreadyParked.has(c.code))
    .map(c => {
      const price = livePrices.get(c.code);
      const candles = chartData?.get(c.code);
      const tech = candles && candles.length >= 30 ? analyzeTechnicals(candles) : null;
      // 타이밍 점수: RSI 눌림목 + MACD 상승 + 볼린저 반등 등
      let timingScore = 0;
      if (tech) {
        // RSI 30-50: 눌림목 최적 구간 (+15), 50-60: 양호 (+5), 60+: 감점
        if (tech.rsi14 < 30) timingScore += 10;
        else if (tech.rsi14 < 50) timingScore += 15;
        else if (tech.rsi14 < 60) timingScore += 5;
        else if (tech.rsi14 > 70) timingScore -= 10;
        // MACD 골든크로스/상승 전환
        if (tech.macdCrossover === 'BULLISH') timingScore += 12;
        else if (tech.macdHistogram > 0) timingScore += 5;
        else if (tech.macdCrossover === 'BEARISH') timingScore -= 8;
        // 볼린저 하단 반등
        if (tech.bollingerBreakout === 'DOWN') timingScore += 8;
        if (tech.bollingerSqueeze) timingScore += 5;
        // VWAP 근처
        if (tech.vwapPullback) timingScore += 8;
        if (tech.vwapCross === 'JUST_ABOVE') timingScore += 6;
        // 캔들 패턴
        if (tech.candlePatterns.some(p => p.bullish && p.strength === 'STRONG')) timingScore += 10;
        else if (tech.candlePatterns.some(p => p.bullish)) timingScore += 4;
      }
      return { ...c, price, tech, timingScore };
    })
    .filter(c => c.price && c.price.changePct >= -3.0 && c.price.changePct <= 5.0);

  // 타이밍 점수 기준 정렬 (최고 타이밍 우선)
  const candidates = scored.sort((a, b) => b.timingScore - a.timingScore);

  if (candidates.length === 0) {
    logger.info(`💤 유휴현금 파킹 후보 없음 (현금 ${(cashRatio * 100).toFixed(0)}%)`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  const best = candidates[0];
  logger.info(`🎯 파킹 타이밍: ${best.name} 점수=${best.timingScore} RSI=${best.tech?.rsi14.toFixed(0) ?? '?'} MACD=${best.tech?.macdCrossover ?? '?'}`, { component: 'CASH_MANAGER' });

  // 타이밍 점수 음수면 파킹 안 함 (전부 안 좋은 타이밍)
  if (best.timingScore < 0) {
    logger.info(`💤 파킹 보류 — 대형주 전체 타이밍 부적합 (최고=${best.timingScore}점)`, { component: 'CASH_MANAGER' });
    return decisions;
  }

  // ── 파킹 분산: 1종목에 전량 투입 방지, 최대 2종목 분산 파킹 ──
  // 파킹 총액: 현금의 50% (나머지 50%는 자동매매용 확보)
  const totalParkBudget = Math.min(orderableCash * 0.50, totalAssets * MAX_PARK_RATIO);
  const maxPerStock = totalParkBudget * 0.60; // 1종목 최대 60% (2종목이면 60/40 분배)
  const parkCount = Math.min(2, candidates.length);

  for (let i = 0; i < parkCount; i++) {
    const target = candidates[i];
    const targetPrice = target.price!.currentPrice;
    const stockBudget = i === 0 ? Math.min(maxPerStock, totalParkBudget) : totalParkBudget - maxPerStock;
    if (stockBudget < MIN_PARK_AMOUNT) continue;
    const quantity = Math.floor(stockBudget / targetPrice);
    if (quantity < 1) continue;

    logger.info(
      `💰 유휴현금 파킹 매수: ${target.name}(${target.code}) ${quantity}주 @${targetPrice.toLocaleString()}원 (현금비중 ${(cashRatio * 100).toFixed(0)}%, 당일 ${target.price!.changePct >= 0 ? '+' : ''}${target.price!.changePct.toFixed(2)}%)`,
      { component: 'CASH_MANAGER' },
    );

    decisions.push({
      action: 'BUY',
      stock_code: target.code,
      quantity,
      limit_price: targetPrice,
      price_type: 'MARKET',
      reasoning: `💰 유휴현금 대형주 파킹: ${target.name} 당일 ${target.price!.changePct >= 0 ? '+' : ''}${target.price!.changePct.toFixed(2)}% — 현금 ${(cashRatio * 100).toFixed(0)}% 유휴`,
      confidence: 0.70,
      ai_score: 75,
    });
  }

  return decisions;
}
