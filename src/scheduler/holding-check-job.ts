import { STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { getActiveStrategy, getOpenChains } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { calcPnlPct } from '../utils/money.js';

/**
 * 보유일 초과 자동 손절 체크
 * - 매수 후 N영업일(기본 3일) 경과 시 수익이 안 나면 전량 손절
 * - CEO 매뉴얼: "매수 후 3영업일이 지나도 수익이 안 나면 미련 없이 전량 시장가로 손절"
 *
 * 실행 시점: 장중 매 10분마다 Track B와 함께
 */
export async function runHoldingCheckJob(): Promise<void> {
  try {
    const chains = await getOpenChains();
    if (chains.length === 0) return;

    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
    const params = STRATEGY_PARAMS[mode];

    // 단타 모드는 별도 강제청산 로직(15:20)이 있으므로 스킵
    if (mode === 'SCALPING') return;

    const maxDays = params.maxHoldingDays;
    if (maxDays <= 0) return;

    const now = new Date();
    const forceCloseDecisions: TradeDecision[] = [];

    for (const chain of chains) {
      if (chain.total_quantity <= 0) continue;

      // 영업일 계산 (주말 제외)
      const openedAt = new Date(chain.opened_at);
      const businessDays = countBusinessDays(openedAt, now);

      if (businessDays < maxDays) continue;

      // 현재가 확인
      try {
        const price = await getCurrentPrice(chain.stock_code);
        const pnlPct = calcPnlPct(Number(chain.avg_buy_price), price.currentPrice);

        // 수익이 나고 있으면 유지 (보유일 초과여도 수익 중이면 안 팔음)
        if (pnlPct > 1.0) {
          logger.info(`⏰ ${chain.stock_code}: ${businessDays}일 보유, 수익 ${pnlPct}% → 유지`, {
            component: 'HOLDING_CHECK',
          });
          continue;
        }

        // 수익 없음 → 손절 대상
        logger.warn(`⏰ ${chain.stock_code}: ${businessDays}일 보유, 수익 ${pnlPct}% → 시간 손절 대상`, {
          component: 'HOLDING_CHECK',
        });

        forceCloseDecisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `보유 ${businessDays}영업일 초과 (한도 ${maxDays}일), 수익률 ${pnlPct}% → 시간 손절`,
          confidence: 1.0,
        });
      } catch {
        logger.warn(`${chain.stock_code} 현재가 조회 실패 → 손절 판단 보류`, {
          component: 'HOLDING_CHECK',
        });
      }
    }

    if (forceCloseDecisions.length > 0) {
      await tradeExecutor.processDecisions(forceCloseDecisions, mode);

      const summary = forceCloseDecisions.map((d) => `${d.stock_code} x${d.quantity} (${d.reasoning})`).join('\n');
      await sendTelegramMessage(`⏰ 시간 손절 실행:\n${summary}`);
    }
  } catch (error) {
    logger.error(`보유일 체크 실패: ${error}`, { component: 'HOLDING_CHECK' });
  }
}

/** 두 날짜 사이의 영업일 수 (주말 제외) */
function countBusinessDays(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current < endDate) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
  }

  return count;
}
