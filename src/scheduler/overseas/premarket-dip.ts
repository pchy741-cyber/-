import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getOverseasPrice } from '../../kis/overseas.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { getKSTNow } from '../../utils/time.js';
import { getOverseasWinRates } from './analytics.js';
import { executeOverseasOrder } from './executor.js';
import { getCash, getHoldings, updateTradeState } from './state.js';
import { getOverseasState, setOverseasState } from './utils.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';

// ── 설정 ──

// 우량주 = 시가총액 최상위 + 유동성 풍부한 종목만
const BLUE_CHIP_CODES = new Set([
  'NVDA',
  'AAPL',
  'MSFT',
  'GOOGL',
  'AMZN',
  'META',
  'AVGO',
  'TSM',
  'LLY',
  'V',
  'NFLX',
  'ORCL',
  'CRM',
  'AMD',
  'TSLA',
]);

// 딥바이 파라미터 (수수료 0.7% 커버 후 순익 확보)
const DIP_PCT = -2.0; // 프리마켓 종가 대비 -2% 진입
const TP_PCT = 4.0; // +4% 익절 (수수료 0.7% 후 순익 +3.3%)
const SL_PCT = 2.5; // -2.5% 손절 (RR비 1.6:1)
const MAX_POSITIONS = 3; // 딥바이 최대 동시 포지션
const MAX_BUDGET_PCT = 0.146; // 황금비율 단타 한도 = 14.6%

// ── Types ──

interface DipCandidate {
  code: string;
  exchange: string;
  preMarketClose: number;
  dipTarget: number; // 진입 목표가
  tpPrice: number;
  slPrice: number;
  winRate: number;
  score: number; // 우선순위 점수
}

interface DipBuyResult {
  placed: string[];
  skipped: string[];
  reason: string;
}

// ── Main ──

export async function runPremarketDipBuy(isPaper = true): Promise<DipBuyResult> {
  const result: DipBuyResult = { placed: [], skipped: [], reason: '' };

  try {
    logger.info('🎯 프리마켓 딥바이 스캔 시작', { component: 'DIP_BUY' });

    // 1. 현재 보유 종목 확인 (이미 가진 종목은 제외)
    const holdings = await getHoldings(isPaper);
    const heldCodes = new Set(holdings.keys());

    // 2. 현금 확인
    const cash = await getCash(isPaper);
    const holdVal = Array.from(holdings.values()).reduce((s, h) => s + h.avgPrice * h.qty, 0);
    const portfolio = cash + holdVal;
    const maxBudget = portfolio * MAX_BUDGET_PCT;

    if (cash < 50) {
      result.reason = '현금 부족 ($50 미만)';
      logger.info(`⏭️ 딥바이 스킵: ${result.reason}`, { component: 'DIP_BUY' });
      return result;
    }

    // 3. 오늘 이미 딥바이 실행했는지 체크
    const today = getKSTNow().toISOString().slice(0, 10);
    const lastRun = await getOverseasState(isPaper ? 'dip_buy_last_run' : 'dip_buy_last_run_live');
    if (lastRun === today) {
      result.reason = '오늘 이미 실행됨';
      logger.info(`⏭️ 딥바이 스킵: ${result.reason}`, { component: 'DIP_BUY' });
      return result;
    }

    // 4. 블랙리스트 + 종목별 승률 조회
    const { getUserBlacklist } = await import('./utils.js');
    const userBlacklist = await getUserBlacklist();
    const blueChipList = GLOBAL_WATCHLIST.filter((w) => BLUE_CHIP_CODES.has(w.code) && !userBlacklist.has(w.code));
    const codes = blueChipList.map((w) => w.code);
    const winRates = await getOverseasWinRates(codes, isPaper);

    // 5. 프리마켓 종가 조회 + 딥 타겟 계산
    const candidates: DipCandidate[] = [];

    for (const stock of blueChipList) {
      if (heldCodes.has(stock.code)) continue; // 이미 보유

      try {
        const price = await getOverseasPrice(stock.code, stock.exchange);
        if (!price.currentPrice || price.currentPrice <= 0) continue;

        // 프리마켓 종가 = 현재가 (장 오픈 직후이므로)
        const preMarketClose = price.currentPrice;
        const dipTarget = +(preMarketClose * (1 + DIP_PCT / 100)).toFixed(2);
        const tpPrice = +(dipTarget * (1 + TP_PCT / 100)).toFixed(2);
        const slPrice = +(dipTarget * (1 - SL_PCT / 100)).toFixed(2);

        // 승률 기반 필터: 과거 승률 35% 이하면 제외
        const wr = winRates.get(stock.code);
        const winRate = wr?.winRate ?? 0.5;
        if (wr && wr.sampleCount >= 5 && winRate <= 0.35) {
          result.skipped.push(`${stock.code}(승률${(winRate * 100).toFixed(0)}%)`);
          continue;
        }

        // 당일 변동률 체크: 이미 -3% 이상 하락 → 하락 추세 위험
        if (price.changePct <= -3.0) {
          result.skipped.push(`${stock.code}(급락${price.changePct.toFixed(1)}%)`);
          continue;
        }

        // 이미 +2% 이상 상승 → 딥 올 확률 낮음
        if (price.changePct >= 2.0) {
          result.skipped.push(`${stock.code}(급등${price.changePct.toFixed(1)}%)`);
          continue;
        }

        // 우선순위: 고승률 + 안정적 종목 우선
        const wrBonus = wr && wr.sampleCount >= 5 ? (winRate - 0.5) * 50 : 0;
        const score = wrBonus + (preMarketClose > 100 ? 5 : 0); // 고가주 우선 (유동성)

        candidates.push({
          code: stock.code,
          exchange: stock.exchange,
          preMarketClose,
          dipTarget,
          tpPrice,
          slPrice,
          winRate,
          score,
        });
      } catch {
        // 시세 조회 실패 → 스킵
      }
    }

    // 6. 점수순 정렬 → 상위 MAX_POSITIONS개 선택
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, MAX_POSITIONS);

    if (selected.length === 0) {
      result.reason = '딥바이 후보 없음';
      logger.info(`⏭️ 딥바이 스킵: ${result.reason}`, { component: 'DIP_BUY' });
      return result;
    }

    // 7. 포지션당 예산 배분
    const budgetPerPosition = Math.min(
      Math.floor(maxBudget / selected.length),
      Math.floor(cash * 0.3), // 현금의 30%까지
    );

    // 8. 딥바이 주문 기록 (overseas_state에 저장 → 루프에서 감시)
    const dipOrders: Array<{
      code: string;
      exchange: string;
      targetPrice: number;
      tpPrice: number;
      slPrice: number;
      budget: number;
      qty: number;
    }> = [];

    for (const c of selected) {
      const qty = Math.max(1, Math.floor(budgetPerPosition / (c.dipTarget * (1 + OVERSEAS_FEE_PCT))));
      if (qty <= 0) continue;

      dipOrders.push({
        code: c.code,
        exchange: c.exchange,
        targetPrice: c.dipTarget,
        tpPrice: c.tpPrice,
        slPrice: c.slPrice,
        budget: budgetPerPosition,
        qty,
      });

      result.placed.push(
        `${c.code} @$${c.dipTarget.toFixed(2)} (프리${c.preMarketClose.toFixed(2)}→딥-2%) TP$${c.tpPrice.toFixed(2)} SL$${c.slPrice.toFixed(2)} x${qty}`,
      );
    }

    if (dipOrders.length > 0) {
      // 딥바이 대기 주문 overseas_state에 저장
      await setOverseasState(isPaper ? 'dip_buy_pending' : 'dip_buy_pending_live', JSON.stringify(dipOrders));
      await setOverseasState(isPaper ? 'dip_buy_last_run' : 'dip_buy_last_run_live', today);

      const msg = [
        `🎯 프리마켓 딥바이 ${dipOrders.length}건 대기`,
        ...result.placed.map((p) => `  • ${p}`),
        result.skipped.length > 0 ? `⏭️ 제외: ${result.skipped.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      logger.info(msg, { component: 'DIP_BUY' });
      await sendTelegramMessage(msg).catch(() => {});
    }

    result.reason = `${dipOrders.length}건 대기 등록`;
    return result;
  } catch (e: any) {
    logger.error(`딥바이 실패: ${e.message}`, { component: 'DIP_BUY' });
    result.reason = e.message;
    return result;
  }
}

/**
 * 딥바이 체결 감시 — 매 사이클(5분)마다 호출
 * 대기 중인 딥바이 주문의 목표가 터치 여부 확인 → 체결 처리
 */
export async function checkDipBuyFills(isPaper = true): Promise<string[]> {
  const fills: string[] = [];
  try {
    const key = isPaper ? 'dip_buy_pending' : 'dip_buy_pending_live';
    const raw = await getOverseasState(key);
    if (!raw) return fills;

    const orders = JSON.parse(raw) as Array<{
      code: string;
      exchange: string;
      targetPrice: number;
      tpPrice: number;
      slPrice: number;
      budget: number;
      qty: number;
    }>;
    if (orders.length === 0) return fills;

    const remaining = [];
    const holdings = await getHoldings(isPaper);
    // 🛡️ 현금을 로컬 추적 (매 체결마다 getCash 재조회 → 이전 체결 반영 안 됨 방지)
    let localCash = await getCash(isPaper);
    let localCashInitialized = true;

    for (const order of orders) {
      try {
        const price = await getOverseasPrice(order.code, order.exchange);
        if (!price.currentPrice) {
          remaining.push(order);
          continue;
        }

        // 목표가 터치 확인: 현재가 ≤ 딥 목표가
        if (price.currentPrice <= order.targetPrice) {
          const fillPrice = price.currentPrice;
          const totalCost = order.qty * fillPrice * (1 + OVERSEAS_FEE_PCT);

          // 현금 확인 (로컬 추적 — 다중 체결 시 이전 차감 반영)
          if (localCash < totalCost) {
            logger.info(`💰 딥바이 ${order.code} 현금 부족 ($${localCash.toFixed(0)} < $${totalCost.toFixed(0)})`, {
              component: 'DIP_BUY',
            });
            remaining.push(order);
            continue;
          }

          // 기존 보유수량 조회 (executeOverseasOrder에 필요)
          const existingHolding = holdings.get(order.code);
          const prevQty = existingHolding?.qty ?? 0;
          const prevAvgPrice = existingHolding?.avgPrice ?? 0;

          const reasoning = `프리마켓딥바이 -2%진입 @$${fillPrice.toFixed(2)} (목표$${order.targetPrice}) TP+${TP_PCT}%/$${order.tpPrice} SL-${SL_PCT}%/$${order.slPrice}`;

          // 실제 주문 실행 (paper=시뮬레이션, live=KIS API 호출)
          const { runWithMode } = await import('../../config/context.js');
          const exec = await runWithMode(isPaper, () =>
            executeOverseasOrder(
              order.code, 'BUY', order.qty, fillPrice,
              order.exchange, reasoning, prevQty, prevAvgPrice, { isPaper },
            ),
          );

          if (exec.submitted && exec.filledQty > 0) {
            // scalp TP/SL 설정 (vision-scalp에서 모니터링)
            const scalpTpPrice = +(exec.filledPrice * (1 + TP_PCT / 100)).toFixed(2);
            const scalpSlPrice = +(exec.filledPrice * (1 - SL_PCT / 100)).toFixed(2);

            localCash -= exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
            await updateTradeState({
              code: order.code, exchange: order.exchange,
              qty: exec.finalQty, avgPrice: exec.finalAvgPrice,
              newCash: localCash,
              isPaper,
            });

            // scalp 플래그 설정
            const { withTransaction } = await import('../../db/client.js');
            await withTransaction(async (tx) => {
              await tx.query(
                `UPDATE overseas_holdings SET tp_pct = $1, sl_pct = $2, is_scalp = TRUE, scalp_tp = $3, scalp_sl = $4
                 WHERE stock_code = $5 AND exchange = $6 AND is_paper = $7`,
                [TP_PCT, -SL_PCT, scalpTpPrice, scalpSlPrice, order.code, order.exchange, isPaper],
              );
            });

            fills.push(
              `🎯 딥바이 체결! ${order.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (목표$${order.targetPrice})${isPaper ? '' : ' [LIVE]'}`,
            );
            logger.info(fills[fills.length - 1], { component: 'DIP_BUY' });
            await sendTelegramMessage(fills[fills.length - 1]).catch(() => {});
          } else {
            // 주문 실패 → 다음 사이클에 재시도
            remaining.push(order);
            logger.warn(`딥바이 주문 실패: ${order.code} — 다음 사이클 재시도`, { component: 'DIP_BUY' });
          }
        } else {
          remaining.push(order);
        }
      } catch {
        remaining.push(order);
      }
    }

    // 미체결 주문 업데이트
    if (remaining.length > 0) {
      await setOverseasState(key, JSON.stringify(remaining));
    } else {
      await setOverseasState(key, '');
    }

    // 장 종료 시(06:00 KST) 미체결 자동 취소
    // v10.8: UTC+9 KST 기준으로 수정 (서버 타임존 의존 제거)
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    if (kstHour >= 6 && kstHour < 22) {
      // 미장 종료 후 → 미체결 딥바이 전부 취소
      if (remaining.length > 0) {
        await setOverseasState(key, '');
        logger.info(`🧹 딥바이 미체결 ${remaining.length}건 자동 취소 (장 종료)`, { component: 'DIP_BUY' });
      }
    }
  } catch (e: any) {
    logger.error(`딥바이 체결 감시 실패: ${e.message}`, { component: 'DIP_BUY' });
  }
  return fills;
}
