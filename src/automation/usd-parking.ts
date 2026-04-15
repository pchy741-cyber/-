/**
 * 🇺🇸 장기 USD 파킹 모듈 (SPY Long-term Parking)
 *
 * 철학: "현금은 가치가 가만히 두면 떨어진다.
 *        유한하고 필수적인 것에 투자해야 한다."
 *
 * DEFENSE 모드가 10일 이상 지속 → 유휴 현금 50%를 SPY(S&P500)로 달러 전환 파킹
 * SWING 복귀 후 3일 이상 → SPY 전량 매도 (한국 시장 재진입 자금 확보)
 *
 * 왜 SPY인가:
 * - S&P500 = 세계 경제의 가장 필수적이고 유한한 생산력의 집합
 * - 달러 자산이므로 KRW 약세 시 환차익 추가
 * - MMF보다 장기 기대수익 높음, 개별 종목보다 리스크 낮음
 * - 한국 시장 DEFENSE → 미국 시장도 일반적으로 약세지만 회복 속도 빠름
 *
 * 파라미터 근거:
 * - DEFENSE_TRIGGER_DAYS=10: 2주 미만이면 단기 조정일 가능성, 10일 넘으면 구조적 약세
 * - SWING_RETURN_DAYS=3: SWING 복귀 첫날은 확인 필요, 3일이면 추세 전환 확인
 * - PARK_RATIO=0.50: 절반은 한국 기회 포착용으로 유지
 * - MIN_IDLE_PCT=25: 현금 비중이 낮으면 파킹할 자금 자체가 없음
 * - MAX_PORT_PCT=20: SPY가 포트폴리오의 1/5 초과 시 집중 위험
 */

import { getActiveStrategy, logSystem } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { getOverseasBalance, getOverseasPrice, placeOverseasOrder } from '../kis/overseas.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

// ── 파라미터 ──

/** SPY ETF (S&P500, NASDAQ 상장) */
const SPY_CODE = 'SPY';
const SPY_EXCHANGE = 'NASDAQ';

/** DEFENSE 모드 N일 이상 지속 시 SPY 매수 */
const DEFENSE_TRIGGER_DAYS = 10;

/** SWING 복귀 후 N일 이상 지속 시 SPY 매도 */
const SWING_RETURN_DAYS = 3;

/** 유휴 현금의 이 비율만큼 SPY 매수 (나머지는 한국 기회용) */
const PARK_RATIO = 0.50;

/** 현금 비중이 포트폴리오의 이 % 이상일 때만 파킹 실행 */
const MIN_IDLE_PCT = 25;

/** SPY 평가금액이 포트폴리오의 이 % 초과 시 추가 매수 금지 */
const MAX_PORT_PCT = 20;

/** KRW/USD 환율 폴백 (실시간 조회 실패 시) */
const FX_RATE_FALLBACK = 1380;

/** 최소 매수 수량 (1주 미만이면 스킵) */
const MIN_SPY_QTY = 1;

// ── 내부 유틸 ──

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * KRW/USD 환율 조회 (SPY 가격으로 역산)
 * - KIS API에 환율 전용 엔드포인트가 없으므로
 *   getOverseasBalance의 evalAmount(KRW) / currentPrice(USD)로 추정
 * - 잔고가 없을 경우 폴백 사용
 */
async function getFxRate(): Promise<number> {
  try {
    const holdings = await getOverseasBalance(SPY_EXCHANGE);
    const spy = holdings.find((h) => h.stockCode === SPY_CODE);
    if (spy && spy.currentPrice > 0 && spy.evalAmount > 0) {
      // evalAmount는 KRW 환산, currentPrice는 USD
      // quantity * usdPrice * fxRate = evalAmount
      const impliedFx = spy.evalAmount / (spy.quantity * spy.currentPrice);
      if (impliedFx > 500 && impliedFx < 3000) return impliedFx;
    }
  } catch { /* ignore */ }
  return FX_RATE_FALLBACK;
}

// ── 메인 함수 ──

/**
 * 매일 09:05 실행 — DEFENSE 지속 기간 체크 → SPY 매수/매도 결정
 */
export async function manageUsdParking(): Promise<void> {
  try {
    const strategy = await getActiveStrategy();
    if (!strategy) {
      logger.info('USD 파킹: 전략 없음 → 스킵', { component: 'USD_PARK' });
      return;
    }

    const now = new Date();
    const modeChangedAt = strategy.updated_at ? new Date(strategy.updated_at) : now;
    const modeAgeDays = daysBetween(modeChangedAt, now);
    const mode = strategy.mode as string;

    logger.info(
      `USD 파킹 체크: 모드=${mode}, 지속=${modeAgeDays}일 (변경: ${modeChangedAt.toISOString().split('T')[0]})`,
      { component: 'USD_PARK' },
    );

    if (mode === 'DEFENSE' && modeAgeDays >= DEFENSE_TRIGGER_DAYS) {
      await _buySpyIfNeeded(modeAgeDays);
    } else if (mode !== 'DEFENSE' && modeAgeDays >= SWING_RETURN_DAYS) {
      await _sellSpyIfHeld(mode, modeAgeDays);
    } else {
      logger.info(
        `USD 파킹 대기: ${mode} ${modeAgeDays}일 (매수 트리거: DEFENSE ${DEFENSE_TRIGGER_DAYS}일, 매도 트리거: 비DEFENSE ${SWING_RETURN_DAYS}일)`,
        { component: 'USD_PARK' },
      );
    }
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn(`USD 파킹 오류: ${msg}`, { component: 'USD_PARK' });
    await logSystem('WARN', 'USD_PARK', `USD 파킹 오류: ${msg}`);
  }
}

// ── 매수 ──

async function _buySpyIfNeeded(defenseDays: number): Promise<void> {
  // 1. 현재 SPY 보유량 확인
  const holdings = await getOverseasBalance(SPY_EXCHANGE);
  const spyHeld = holdings.find((h) => h.stockCode === SPY_CODE);

  // 2. 잔고 조회
  const balance = await getAccountBalance();
  const cash = balance.orderableCash ?? 0;
  const totalEval = balance.totalEvalAmount ?? cash;

  // 3. 현금 비중 체크
  const idlePct = totalEval > 0 ? (cash / totalEval) * 100 : 0;
  if (idlePct < MIN_IDLE_PCT) {
    logger.info(
      `USD 파킹 매수 스킵: 현금 비중 ${idlePct.toFixed(1)}% < ${MIN_IDLE_PCT}% (현금 ${cash.toLocaleString()}원)`,
      { component: 'USD_PARK' },
    );
    return;
  }

  // 4. SPY 비중 체크 (이미 MAX_PORT_PCT 초과 시 추가 매수 금지)
  if (spyHeld && spyHeld.evalAmount > 0) {
    const spyKrwEval = spyHeld.evalAmount; // getOverseasBalance가 KRW 환산값 반환
    const spyPct = totalEval > 0 ? (spyKrwEval / totalEval) * 100 : 0;
    if (spyPct >= MAX_PORT_PCT) {
      logger.info(
        `USD 파킹 매수 스킵: SPY 비중 ${spyPct.toFixed(1)}% ≥ ${MAX_PORT_PCT}% → 한도 도달`,
        { component: 'USD_PARK' },
      );
      return;
    }
  }

  // 5. SPY 현재가 조회
  const spyPrice = await getOverseasPrice(SPY_CODE, SPY_EXCHANGE);
  if (spyPrice.currentPrice <= 0) {
    logger.warn('USD 파킹: SPY 현재가 조회 실패 → 스킵', { component: 'USD_PARK' });
    return;
  }

  // 6. 환율 조회 (KRW → USD 변환)
  const fxRate = await getFxRate();

  // 7. 매수 금액 계산
  const parkKrw = cash * PARK_RATIO;
  const parkUsd = parkKrw / fxRate;
  const quantity = Math.floor(parkUsd / spyPrice.currentPrice);

  if (quantity < MIN_SPY_QTY) {
    logger.info(
      `USD 파킹 매수 스킵: 수량 ${quantity} < ${MIN_SPY_QTY} (파킹예산 ${parkKrw.toLocaleString()}원 / 환율 ${fxRate} = $${parkUsd.toFixed(0)} / SPY $${spyPrice.currentPrice})`,
      { component: 'USD_PARK' },
    );
    return;
  }

  const investUsd = quantity * spyPrice.currentPrice;
  const investKrw = Math.round(investUsd * fxRate);

  logger.info(
    `🇺🇸 USD 파킹 매수: SPY ${quantity}주 × $${spyPrice.currentPrice} = $${investUsd.toFixed(2)} (≈${investKrw.toLocaleString()}원) | DEFENSE ${defenseDays}일째 | 환율 ${fxRate}`,
    { component: 'USD_PARK' },
  );

  const result = await placeOverseasOrder({
    stockCode: SPY_CODE,
    exchange: SPY_EXCHANGE,
    side: 'BUY',
    quantity,
    // 시장가 주문 (price 미설정)
  });

  if (result.success) {
    await logSystem('TRADE', 'USD_PARK', `SPY 매수: ${quantity}주 ($${investUsd.toFixed(2)} ≈ ${investKrw.toLocaleString()}원) — DEFENSE ${defenseDays}일 파킹`, {
      quantity, investUsd, investKrw, fxRate, defenseDays, orderNo: result.orderNo,
    });
    await sendTelegramMessage(
      `🇺🇸 USD 장기파킹 매수\nSPY ${quantity}주 × $${spyPrice.currentPrice}\n투자금: $${investUsd.toFixed(2)} (≈${investKrw.toLocaleString()}원)\nDEFENSE ${defenseDays}일째 → 달러 전환`,
    ).catch(() => {});
  } else {
    logger.warn(`USD 파킹 매수 실패: ${result.message}`, { component: 'USD_PARK' });
    await logSystem('WARN', 'USD_PARK', `SPY 매수 실패: ${result.message}`);
  }
}

// ── 매도 ──

async function _sellSpyIfHeld(currentMode: string, modeAgeDays: number): Promise<void> {
  // 보유 SPY 확인
  const holdings = await getOverseasBalance(SPY_EXCHANGE);
  const spyHeld = holdings.find((h) => h.stockCode === SPY_CODE);

  if (!spyHeld || spyHeld.quantity <= 0) {
    logger.info('USD 파킹 매도 스킵: SPY 미보유', { component: 'USD_PARK' });
    return;
  }

  const quantity = spyHeld.quantity;
  const avgBuy = spyHeld.avgBuyPrice;

  // 현재가 조회
  const spyPrice = await getOverseasPrice(SPY_CODE, SPY_EXCHANGE);
  const currentPrice = spyPrice.currentPrice > 0 ? spyPrice.currentPrice : spyHeld.currentPrice;

  const pnlPct = avgBuy > 0 ? ((currentPrice - avgBuy) / avgBuy) * 100 : 0;
  const fxRate = await getFxRate();
  const sellKrw = Math.round(quantity * currentPrice * fxRate);

  logger.info(
    `🇺🇸 USD 파킹 매도: SPY ${quantity}주 × $${currentPrice} = $${(quantity * currentPrice).toFixed(2)} (≈${sellKrw.toLocaleString()}원) | 수익률 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | ${currentMode} ${modeAgeDays}일째`,
    { component: 'USD_PARK' },
  );

  const result = await placeOverseasOrder({
    stockCode: SPY_CODE,
    exchange: SPY_EXCHANGE,
    side: 'SELL',
    quantity,
  });

  if (result.success) {
    await logSystem('TRADE', 'USD_PARK', `SPY 매도: ${quantity}주 ($${(quantity * currentPrice).toFixed(2)} ≈ ${sellKrw.toLocaleString()}원) — ${currentMode} 전환 ${modeAgeDays}일, 수익률 ${pnlPct.toFixed(2)}%`, {
      quantity, currentPrice, sellKrw, pnlPct, fxRate, currentMode, modeAgeDays, orderNo: result.orderNo,
    });
    await sendTelegramMessage(
      `🇺🇸 USD 파킹 매도\nSPY ${quantity}주 × $${currentPrice}\n회수금: $${(quantity * currentPrice).toFixed(2)} (≈${sellKrw.toLocaleString()}원)\n수익률: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\n${currentMode} 전환 → 한국시장 재진입`,
    ).catch(() => {});
  } else {
    logger.warn(`USD 파킹 매도 실패: ${result.message}`, { component: 'USD_PARK' });
    await logSystem('WARN', 'USD_PARK', `SPY 매도 실패: ${result.message}`);
  }
}
