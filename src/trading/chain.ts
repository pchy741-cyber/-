import type { StrategyMode } from '../config/constants.js';
import { createChain, getOpenChains, getOrdersByChain, updateChain } from '../db/client.js';
import type { TransactionChain } from '../db/models.js';
import { logger } from '../utils/logger.js';

/**
 * 트랜잭션 체인 매니저
 * 1차 매수 → 2차 물타기 → 3차 물타기 → 부분 익절 → 전량 청산
 * 을 하나의 체인으로 관리
 */
export class ChainManager {
  /**
   * 새로운 체인 생성 (1차 매수 시)
   */
  async openChain(params: {
    stockCode: string;
    mode: StrategyMode;
    buyPrice: number;
    quantity: number;
    targetProfitPct: number;
    stopLossPct: number;
    maxAveragingCount: number;
  }): Promise<string> {
    const COMMISSION_RATE = 0.00015;
    const rawInvested = params.buyPrice * params.quantity;
    const invested = rawInvested + Math.round(rawInvested * COMMISSION_RATE);
    const avgBuyPrice = Math.round(invested / params.quantity);

    const chainId = await createChain({
      stock_code: params.stockCode,
      status: 'OPEN',
      strategy_mode: params.mode,
      avg_buy_price: avgBuyPrice,
      total_quantity: params.quantity,
      total_invested: invested,
      realized_pnl: 0,
      target_profit_pct: params.targetProfitPct,
      stop_loss_pct: params.stopLossPct,
      max_averaging_count: params.maxAveragingCount,
      current_averaging_count: 0,
    });

    logger.info(`📦 체인 생성: ${params.stockCode} | ${params.quantity}주 @${params.buyPrice} | 모드: ${params.mode}`, {
      component: 'CHAIN',
    });

    return chainId;
  }

  /**
   * 물타기 추가 매수
   */
  async addAveraging(chainId: string, buyPrice: number, quantity: number): Promise<void> {
    const orders = await getOrdersByChain(chainId);
    const buyOrders = orders.filter((o) => o.side === 'BUY' && o.status === 'FILLED');

    // 평단가 재계산 (수수료 0.015% 반영)
    const COMMISSION_RATE = 0.00015;
    let totalCost = buyOrders.reduce((sum, o) => {
      const cost = Number(o.filled_price) * o.filled_quantity;
      return sum + cost + Math.round(cost * COMMISSION_RATE);
    }, 0);
    let totalQty = buyOrders.reduce((sum, o) => sum + o.filled_quantity, 0);

    const newCost = buyPrice * quantity;
    totalCost += newCost + Math.round(newCost * COMMISSION_RATE);
    totalQty += quantity;

    const newAvgPrice = Math.round(totalCost / totalQty);

    // 물타기 횟수 = 전체 매수 - 1차 매수 (초기 매수는 물타기 아님)
    // buyOrders에는 이미 이번 체결분이 포함되어 있으므로 -1
    const averagingCount = buyOrders.length - 1;

    await updateChain(chainId, {
      status: 'AVERAGING',
      avg_buy_price: newAvgPrice,
      total_quantity: totalQty,
      total_invested: totalCost,
      current_averaging_count: averagingCount,
    });

    logger.info(
      `📊 물타기: 체인 ${chainId.slice(0, 8)} | +${quantity}주 @${buyPrice} | 새 평단: ${newAvgPrice.toFixed(0)}`,
      { component: 'CHAIN' },
    );
  }

  /**
   * 부분 익절
   */
  async partialProfit(chainId: string, sellQty: number, sellPrice: number, chain: TransactionChain): Promise<void> {
    const avgBuy = Number(chain.avg_buy_price);
    const sellValue = sellPrice * sellQty;
    const SELL_FEE_PCT = 0.00245;
    const profit = sellValue - Math.round(sellValue * SELL_FEE_PCT) - (avgBuy * sellQty);
    const remainingQty = chain.total_quantity - sellQty;

    await updateChain(chainId, {
      status: remainingQty > 0 ? 'PROFIT_TAKING' : 'CLOSED',
      total_quantity: remainingQty,
      realized_pnl: Number(chain.realized_pnl) + profit,
      ...(remainingQty === 0 && {
        closed_at: new Date().toISOString(),
        close_reason: `익절: +${((sellPrice / avgBuy - 1) * 100).toFixed(1)}%`,
      }),
    });

    logger.info(
      `💰 ${remainingQty > 0 ? '부분 익절' : '전량 익절'}: 체인 ${chainId.slice(0, 8)} | ${sellQty}주 @${sellPrice} | 실현수익: ${profit.toLocaleString()}원`,
      { component: 'CHAIN' },
    );
  }

  /**
   * 전량 청산 (손절 또는 강제 청산)
   */
  async closeChain(chainId: string, sellPrice: number, chain: TransactionChain, reason: string): Promise<void> {
    const avgBuy = Number(chain.avg_buy_price);
    const sellValue = sellPrice * chain.total_quantity;
    const SELL_FEE_PCT = 0.00245;
    const profit = sellValue - Math.round(sellValue * SELL_FEE_PCT) - (avgBuy * chain.total_quantity);

    await updateChain(chainId, {
      status: 'CLOSED',
      total_quantity: 0,
      realized_pnl: Number(chain.realized_pnl) + profit,
      closed_at: new Date().toISOString(),
      close_reason: reason,
    });

    const pnlPct = ((sellPrice / avgBuy - 1) * 100).toFixed(1);
    const emoji = profit >= 0 ? '💰' : '💸';

    logger.info(
      `${emoji} 체인 종료: ${chain.stock_code} | ${reason} | 실현손익: ${profit.toLocaleString()}원 (${pnlPct}%)`,
      { component: 'CHAIN' },
    );
  }

  /**
   * 특정 종목의 열린 체인 찾기
   */
  async findOpenChain(stockCode: string): Promise<TransactionChain | null> {
    const chains = await getOpenChains();
    return chains.find((c) => c.stock_code === stockCode) ?? null;
  }
}

export const chainManager = new ChainManager();
