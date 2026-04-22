/**
 * 현금 파킹 모듈
 *
 * 철학: 돈은 생명체 — 가만히 두면 썩는다.
 * 유휴 현금은 TIGER 고배당(배당 ~4.5%/년)에 자동 매수해 굴리고,
 * 매매 기회 발생 시 전량 매도 → 다시 매수.
 *
 * 실행 흐름:
 *  1. 장중 09:30/12:00/15:10 — 잉여 현금 → 배당 ETF 매수
 *  2. 장 시작 전 (08:45) — 오늘 매매 예상 현금 부족 시 → ETF 전량 매도
 */

import { getAccountBalance } from '../kis/account.js';
import { getCurrentPrice } from '../kis/market.js';
import { config } from '../config/index.js';
import { logSystem } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { IDLE_PARK_CODE, IDLE_PARK_NAME } from '../ai/track-b/trading-rules.js';

/**
 * 파킹 ETF: Track B와 동일 코드 사용 (기본 333940)
 * 환경변수로 오버라이드 가능하되, 미설정 시 Track B 기본 파킹 코드에 맞춘다.
 */
const BASE_ASSET_CODE = process.env.BASE_ASSET_CODE || IDLE_PARK_CODE;
const BASE_ASSET_NAME = process.env.BASE_ASSET_NAME || IDLE_PARK_NAME;

/** 최소 파킹 금액 — 이 이상이면 즉시 파킹 */
const MIN_PARK_KRW = 50_000; // 5만원 이상이면 즉시 파킹 (공격적)

/** 항상 유지할 최소 현금 — 수수료/슬리피지 대비 최소한만 */
const MIN_LIQUID_KRW = 100_000; // 10만원만 현금 유보, 나머지 100% ETF 파킹

/**
 * 장 마감 후 현금 파킹
 * - 잉여 현금(min_liquid 초과분)을 기저자산 ETF에 자동 매수
 */
export async function parkIdleCash(): Promise<void> {
  try {
    const balance = await getAccountBalance();
    const cash = balance.orderableCash ?? 0;

    // 현금이 최소 유동성 + 파킹 기준보다 적으면 스킵
    if (cash <= MIN_LIQUID_KRW + MIN_PARK_KRW) {
      logger.info(
        `💤 현금 파킹 스킵: 현금 ${cash.toLocaleString()}원 (최소 유동성 ${MIN_LIQUID_KRW.toLocaleString()} + 파킹기준 ${MIN_PARK_KRW.toLocaleString()})`,
        { component: 'CASH_PARK' },
      );
      return;
    }

    // 파킹할 금액 = 전체 현금 - 최소 유동성 확보
    const parkAmount = cash - MIN_LIQUID_KRW;

    // ETF 현재가 조회
    const etfPrice = await getCurrentPrice(BASE_ASSET_CODE);
    if (etfPrice.currentPrice <= 0) {
      logger.warn(`⚠️ ${BASE_ASSET_NAME} 현재가 조회 실패 → 파킹 스킵`, { component: 'CASH_PARK' });
      return;
    }

    const quantity = Math.floor(parkAmount / etfPrice.currentPrice);
    if (quantity <= 0) {
      logger.info(`💤 현금 파킹 스킵: 수량 0 (파킹금액 ${parkAmount.toLocaleString()}원 < ETF가격 ${etfPrice.currentPrice.toLocaleString()}원)`, { component: 'CASH_PARK' });
      return;
    }

    const investKrw = quantity * etfPrice.currentPrice;
    logger.info(
      `💰 현금 파킹: ${BASE_ASSET_NAME} ${quantity}주 매수 (${investKrw.toLocaleString()}원, 현금 ${cash.toLocaleString()}원 → ${(cash - investKrw).toLocaleString()}원)`,
      { component: 'CASH_PARK' },
    );

    await tradeExecutor.processDecisions([
      {
        action: 'BUY',
        stock_code: BASE_ASSET_CODE,
        quantity,
        price_type: 'MARKET',
        limit_price: etfPrice.currentPrice,
        reasoning: `현금 파킹: 유휴 현금 ${investKrw.toLocaleString()}원 → ${BASE_ASSET_NAME} (돈은 굴려야 산다)`,
        confidence: 1.0,
      },
    ], 'SWING');

    await logSystem('INFO', 'CASH_PARK', `현금 파킹 완료: ${BASE_ASSET_NAME} ${quantity}주 (${investKrw.toLocaleString()}원)`);
    await sendTelegramMessage(
      `💰 현금 파킹\n${BASE_ASSET_NAME} ${quantity}주 매수\n투자금: ${investKrw.toLocaleString()}원\n잔여현금: ${(cash - investKrw).toLocaleString()}원`,
    ).catch(() => {});
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn(`현금 파킹 실패: ${msg}`, { component: 'CASH_PARK' });
    await logSystem('WARN', 'CASH_PARK', `현금 파킹 실패: ${msg}`);
  }
}

/**
 * 장 시작 전 현금 확보 (ETF 일부 매도)
 * - 오늘 매매 가능 현금이 부족하면 기저자산 ETF 일부 매도
 * - 목표 유동성: maxPositionKrw * 2 (종목 2개 풀매수 가능 수준)
 */
export async function unparkForTrading(): Promise<void> {
  try {
    const balance = await getAccountBalance();
    const cash = balance.orderableCash ?? 0;
    const targetLiquid = config.risk.maxPositionKrw * 2;

    if (cash >= targetLiquid) {
      logger.info(
        `✅ 현금 충분: ${cash.toLocaleString()}원 (목표 ${targetLiquid.toLocaleString()}원) → ETF 매도 불필요`,
        { component: 'CASH_PARK' },
      );
      return;
    }

    const shortfall = targetLiquid - cash;

    // ETF 보유량 확인 (포지션 목록에서)
    const etfPosition = balance.positions?.find((p: any) => p.stockCode === BASE_ASSET_CODE);
    if (!etfPosition || etfPosition.quantity <= 0) {
      logger.info(`💤 ${BASE_ASSET_NAME} 미보유 → 언파킹 스킵`, { component: 'CASH_PARK' });
      return;
    }

    const etfPrice = await getCurrentPrice(BASE_ASSET_CODE);
    if (etfPrice.currentPrice <= 0) return;

    // 부족분만큼 매도 (최대 전량 — 매매 기회가 생기면 ETF 다 팔아서 현금 확보)
    const sellQty = Math.min(
      Math.ceil(shortfall / etfPrice.currentPrice),
      etfPosition.quantity, // 전량 매도 허용
    );

    if (sellQty <= 0) return;

    const recoverKrw = sellQty * etfPrice.currentPrice;
    logger.info(
      `🔓 현금 확보: ${BASE_ASSET_NAME} ${sellQty}주 매도 (${recoverKrw.toLocaleString()}원 확보, 현금 ${cash.toLocaleString()}원 → ${(cash + recoverKrw).toLocaleString()}원)`,
      { component: 'CASH_PARK' },
    );

    await tradeExecutor.processDecisions([
      {
        action: 'SELL',
        stock_code: BASE_ASSET_CODE,
        quantity: sellQty,
        price_type: 'MARKET',
        reasoning: `현금 확보: 오늘 매매 유동성 ${shortfall.toLocaleString()}원 부족 → ${BASE_ASSET_NAME} 매도`,
        confidence: 1.0,
      },
    ], 'SWING');

    await logSystem('INFO', 'CASH_PARK', `현금 확보: ${BASE_ASSET_NAME} ${sellQty}주 매도 (${recoverKrw.toLocaleString()}원)`);
    await sendTelegramMessage(
      `🔓 현금 확보\n${BASE_ASSET_NAME} ${sellQty}주 매도\n확보금: ${recoverKrw.toLocaleString()}원\n현금잔고: ${(cash + recoverKrw).toLocaleString()}원`,
    ).catch(() => {});
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn(`현금 확보 실패: ${msg}`, { component: 'CASH_PARK' });
  }
}
