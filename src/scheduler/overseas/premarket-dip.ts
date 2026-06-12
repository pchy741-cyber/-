import { getOverseasPrice } from '../../kis/overseas.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { getOverseasWinRates } from './analytics.js';
import { getCash, getHoldings } from './state.js';
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
  'AAPL',
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
    const today = new Date().toISOString().slice(0, 10);
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
      const qty = Math.max(1, Math.floor(budgetPerPosition / (c.dipTarget * 1.0025)));
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
    const { withTransaction } = await import('../../db/client.js');

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
          const totalCost = order.qty * fillPrice * 1.0025;

          // 현금 확인
          const cash = await getCash(isPaper);
          if (cash < totalCost) {
            logger.info(`💰 딥바이 ${order.code} 현금 부족 ($${cash.toFixed(0)} < $${totalCost.toFixed(0)})`, {
              component: 'DIP_BUY',
            });
            remaining.push(order);
            continue;
          }

          // 체결 처리
          // scalp TP/SL 절대가격 계산 (vision-scalp에서 모니터링)
          const scalpTpPrice = +(fillPrice * (1 + TP_PCT / 100)).toFixed(2);
          const scalpSlPrice = +(fillPrice * (1 - SL_PCT / 100)).toFixed(2);

          await withTransaction(async (tx) => {
            await tx.query(
              `
              INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper, tp_pct, sl_pct, is_scalp, scalp_tp, scalp_sl)
              VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, TRUE, $8, $9)
              ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE
                SET quantity = overseas_holdings.quantity + $3,
                    avg_price = (overseas_holdings.avg_price * overseas_holdings.quantity + $4 * $3) / (overseas_holdings.quantity + $3),
                    tp_pct = $6, sl_pct = $7, is_scalp = TRUE, scalp_tp = $8, scalp_sl = $9
            `,
              [order.code, order.exchange, order.qty, fillPrice, isPaper, TP_PCT, -SL_PCT, scalpTpPrice, scalpSlPrice],
            );

            await tx.query(
              `INSERT INTO orders (stock_code, side, order_type, quantity, price, filled_quantity, filled_price,
                kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
               VALUES ($1, 'BUY', 'LIMIT', $2, $3, $2, $3, $4, 'FILLED', $5, 'OVERSEAS', $6)`,
              [
                order.code,
                order.qty,
                fillPrice,
                `DIP${Date.now().toString(36)}`,
                isPaper ? 'paper' : 'live',
                `프리마켓딥바이 -2%진입 @$${fillPrice.toFixed(2)} (목표$${order.targetPrice}) TP+${TP_PCT}%:$${order.tpPrice} SL-${SL_PCT}%:$${order.slPrice} [avgBuy:${fillPrice.toFixed(4)}]`,
              ],
            );

            // Live 현금: KIS 동기화로 반영 (USD→KRW 단위 오염 방지). Paper는 computed.
          });

          // Live: KIS 동기화로 현금 갱신
          if (!isPaper) {
            const { reconcileCashWithKIS } = await import('./kis-sync.js');
            const { runWithMode } = await import('../../config/context.js');
            await runWithMode(false, () => reconcileCashWithKIS()).catch((e: any) =>
              logger.warn(`딥바이 후 현금 동기화 실패 (무시): ${e.message}`, { component: 'DIP_BUY' }),
            );
          }

          fills.push(
            `🎯 딥바이 체결! ${order.code} x${order.qty} @$${fillPrice.toFixed(2)} (목표$${order.targetPrice})`,
          );
          logger.info(fills[fills.length - 1], { component: 'DIP_BUY' });
          await sendTelegramMessage(fills[fills.length - 1]).catch(() => {});
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
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 6 && hour < 22) {
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
