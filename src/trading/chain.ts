import { KR_FEE, type StrategyMode } from '../config/constants.js';
import { config } from '../config/index.js';
import { createChain, getOpenChains, getOrdersByChain, updateChain, getPool, withTransaction, isMemoryMode } from '../db/client.js';
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
    isPaper?: boolean;
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
      is_paper: params.isPaper,
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
    const COMMISSION_RATE = 0.00015;
    let finalAvgPrice = 0;

    // 주의: 이 함수 호출 시점에 새 매수 주문은 이미 DB에 INSERT된 상태 (executor.ts → confirmFill 후 호출)
    // buyOrders에 새 주문이 포함되어 있으므로 별도 추가하면 이중 계산됨
    const calcFromOrders = (buyOrders: Array<{ filled_price: string | number | null; filled_quantity: number }>) => {
      const totalCost = buyOrders.reduce((sum, o) => {
        const cost = Number(o.filled_price ?? 0) * o.filled_quantity;
        return sum + cost + Math.round(cost * COMMISSION_RATE);
      }, 0);
      const totalQty = buyOrders.reduce((sum, o) => sum + o.filled_quantity, 0);
      return { totalCost, totalQty, newAvgPrice: totalQty > 0 ? Math.round(totalCost / totalQty) : 0, averagingCount: buyOrders.length - 1 };
    };

    if (isMemoryMode()) {
      const orders = await getOrdersByChain(chainId);
      const buyOrders = orders.filter((o) => o.side === 'BUY' && o.status === 'FILLED');
      const { totalCost, totalQty, newAvgPrice, averagingCount } = calcFromOrders(buyOrders);
      finalAvgPrice = newAvgPrice;
      await updateChain(chainId, {
        status: 'AVERAGING',
        avg_buy_price: newAvgPrice,
        total_quantity: totalQty,
        total_invested: totalCost,
        current_averaging_count: averagingCount,
      });
    } else {
      // SELECT FOR UPDATE — 동시 물타기 방지 (동일 체인 동시 접근 시 후발 요청은 대기)
      await withTransaction(async (client) => {
        await client.query('SELECT id FROM transaction_chains WHERE id = $1 FOR UPDATE', [chainId]);
        const { rows } = await client.query(
          `SELECT side, status, filled_price, filled_quantity FROM orders WHERE chain_id = $1 ORDER BY created_at ASC`,
          [chainId],
        );
        const buyOrders = rows.filter((o: { side: string; status: string }) => o.side === 'BUY' && o.status === 'FILLED');
        const { totalCost, totalQty, newAvgPrice, averagingCount } = calcFromOrders(buyOrders);
        finalAvgPrice = newAvgPrice;
        await client.query(
          `UPDATE transaction_chains SET status='AVERAGING', avg_buy_price=$1, total_quantity=$2, total_invested=$3, current_averaging_count=$4 WHERE id=$5`,
          [newAvgPrice, totalQty, totalCost, averagingCount, chainId],
        );
      });
    }

    logger.info(
      `📊 물타기: 체인 ${chainId.slice(0, 8)} | +${quantity}주 @${buyPrice} | 새 평단: ${finalAvgPrice.toFixed(0)}`,
      { component: 'CHAIN' },
    );
  }

  /**
   * 부분 익절
   */
  async partialProfit(chainId: string, sellQty: number, sellPrice: number, chain: TransactionChain): Promise<void> {
    const avgBuy = Number(chain.avg_buy_price);
    const sellValue = sellPrice * sellQty;
    const SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;
    const profit = sellValue - Math.round(sellValue * SELL_FEE_PCT) - (avgBuy * sellQty);
    const remainingQty = chain.total_quantity - sellQty;

    await updateChain(chainId, {
      status: remainingQty > 0 ? 'PROFIT_TAKING' : 'CLOSED',
      total_quantity: remainingQty,
      realized_pnl: Number(chain.realized_pnl) + profit,
      // peak_price: 부분 익절 시점 현재가 기록 → 트레일링 스톱 기준점
      ...(remainingQty > 0 && { peak_price: sellPrice }),
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
    const SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;
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

    // 스코어 정확도 기록 — 비동기 fire-and-forget
    this.recordScoreAccuracy(chainId, chain, Number(pnlPct), reason).catch(() => {});
  }

  /** 체인 종료 후 진입 당시 AI 스코어 vs 결과를 score_accuracy에 기록 */
  private async recordScoreAccuracy(chainId: string, chain: TransactionChain, pnlPct: number, reason: string): Promise<void> {
    try {
      const pool = getPool();
      // 진입 당시 가장 가까운 ai_scores 조회
      const { rows: scoreRows } = await pool.query(
        `SELECT composite_score, signal, confidence
           FROM ai_scores
          WHERE stock_code = $1
            AND created_at <= COALESCE($2::timestamptz, NOW())
          ORDER BY created_at DESC
          LIMIT 1`,
        [chain.stock_code, (chain as any).opened_at ?? null],
      );
      const score = scoreRows[0];
      const holdingDays = (chain as any).opened_at
        ? Math.round((Date.now() - new Date((chain as any).opened_at).getTime()) / 86400000)
        : null;
      const outcome = pnlPct > 0.1 ? 'WIN' : pnlPct < -0.1 ? 'LOSS' : 'BREAK_EVEN';

      await pool.query(
        `INSERT INTO score_accuracy
           (stock_code, chain_id, entry_score, entry_signal, entry_confidence,
            realized_pnl_pct, outcome, holding_days, close_reason, strategy_mode, is_paper)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (chain_id) DO NOTHING`,
        [
          chain.stock_code,
          chainId,
          score?.composite_score ?? null,
          score?.signal ?? null,
          score?.confidence ?? null,
          pnlPct,
          outcome,
          holdingDays,
          reason,
          (chain as any).strategy_mode ?? null,
          (chain as any).is_paper ?? config.isPaper,
        ],
      );
      logger.info(`📝 스코어 정확도 기록: ${chain.stock_code} ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`, { component: 'CHAIN' });
    } catch (err) {
      logger.warn(`스코어 정확도 기록 실패: ${err}`, { component: 'CHAIN' });
    }
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
