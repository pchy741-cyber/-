import { KR_FEE, type StrategyMode } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import {
  createChain,
  getOpenChains,
  getOrdersByChain,
  getPool,
  isMemoryMode,
  updateChain,
  withTransaction,
} from '../db/client.js';
import type { TransactionChain } from '../db/models.js';
import { recordTradeOutcome } from '../risk/loss-streak.js';
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
    const rawInvested = params.buyPrice * params.quantity;
    const invested = rawInvested + Math.round(rawInvested * KR_FEE.BUY_FEE_PCT);
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
    let finalAvgPrice = 0;

    // 주의: 이 함수 호출 시점에 새 매수 주문은 이미 DB에 INSERT된 상태 (executor.ts → confirmFill 후 호출)
    // buyOrders에 새 주문이 포함되어 있으므로 별도 추가하면 이중 계산됨
    const calcFromOrders = (buyOrders: Array<{ filled_price: string | number | null; filled_quantity: number }>) => {
      const totalCost = buyOrders.reduce((sum, o) => {
        const cost = Number(o.filled_price ?? 0) * o.filled_quantity;
        return sum + cost + Math.round(cost * KR_FEE.BUY_FEE_PCT);
      }, 0);
      const totalQty = buyOrders.reduce((sum, o) => sum + o.filled_quantity, 0);
      return {
        totalCost,
        totalQty,
        newAvgPrice: totalQty > 0 ? Math.round(totalCost / totalQty) : 0,
        averagingCount: buyOrders.length - 1,
      };
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
      // SELECT FOR UPDATE + SERIALIZABLE — 동시 물타기 방지 (동일 체인 동시 접근 시 후발 요청은 대기)
      await withTransaction(async (client) => {
        const { rows: chainRows } = await client.query(
          'SELECT id, current_averaging_count, max_averaging_count FROM transaction_chains WHERE id = $1 FOR UPDATE',
          [chainId],
        );
        const chainRow = chainRows[0];
        if (!chainRow) return;
        // CAS: 물타기 횟수 초과 방지
        if (chainRow.max_averaging_count != null && Number(chainRow.current_averaging_count) >= Number(chainRow.max_averaging_count)) {
          logger.warn(`⚠️ 물타기 횟수 초과: 체인 ${chainId.slice(0, 8)} ${chainRow.current_averaging_count}/${chainRow.max_averaging_count} — 스킵`, { component: 'CHAIN' });
          return;
        }
        const { rows } = await client.query(
          `SELECT side, status, filled_price, filled_quantity FROM orders WHERE chain_id = $1 ORDER BY created_at ASC`,
          [chainId],
        );
        const buyOrders = rows.filter(
          (o: { side: string; status: string }) => o.side === 'BUY' && o.status === 'FILLED',
        );
        const { totalCost, totalQty, newAvgPrice, averagingCount } = calcFromOrders(buyOrders);
        finalAvgPrice = newAvgPrice;
        await client.query(
          `UPDATE transaction_chains SET status='AVERAGING', avg_buy_price=$1, total_quantity=$2, total_invested=$3, current_averaging_count=$4 WHERE id=$5`,
          [newAvgPrice, totalQty, totalCost, averagingCount, chainId],
        );
      }, 'SERIALIZABLE');
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
    const SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;
    const sellValue = sellPrice * sellQty;

    // profit 계산 헬퍼 — fresh avg_buy_price 사용
    const calcProfit = (freshAvgBuy: number) =>
      sellValue - Math.round(sellValue * SELL_FEE_PCT) - freshAvgBuy * sellQty;

    let logProfit = 0;
    let logRemainingQty = 0;

    // 🔒 트랜잭션 + FOR UPDATE: 동시 매도(대시보드 수동 + AI) 경합 방지
    if (isMemoryMode()) {
      const avgBuy = Number(chain.avg_buy_price);
      const profit = calcProfit(avgBuy);
      logProfit = profit;
      const remainingQty = chain.total_quantity - sellQty;
      logRemainingQty = remainingQty;
      await updateChain(chainId, {
        status: remainingQty > 0 ? 'PROFIT_TAKING' : 'CLOSED',
        total_quantity: remainingQty,
        realized_pnl: Number(chain.realized_pnl) + profit,
        ...(remainingQty > 0 && { peak_price: sellPrice }),
        ...(remainingQty === 0 && {
          closed_at: new Date().toISOString(),
          close_reason: `익절: +${((sellPrice / avgBuy - 1) * 100).toFixed(1)}%`,
        }),
      });
    } else {
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          'SELECT total_quantity, realized_pnl, avg_buy_price FROM transaction_chains WHERE id = $1 FOR UPDATE',
          [chainId],
        );
        const freshChain = rows[0];
        if (!freshChain) return;
        const freshQty = Number(freshChain.total_quantity);
        const freshAvgBuy = Number(freshChain.avg_buy_price);
        if (freshQty <= 0 || freshQty < sellQty) {
          logger.warn(`⚠️ 부분익절 수량 부족: 체인 ${chainId.slice(0, 8)} 보유 ${freshQty}주 < 요청 ${sellQty}주 — 스킵`, { component: 'CHAIN' });
          return;
        }
        const freshPnl = Number(freshChain.realized_pnl);
        const profit = calcProfit(freshAvgBuy);
        logProfit = profit;
        const remQty = freshQty - sellQty;
        logRemainingQty = remQty;
        if (remQty > 0) {
          await client.query(
            `UPDATE transaction_chains SET status='PROFIT_TAKING', total_quantity=$1, realized_pnl=$2, peak_price=$3 WHERE id=$4`,
            [remQty, freshPnl + profit, sellPrice, chainId],
          );
        } else {
          await client.query(
            `UPDATE transaction_chains SET status='CLOSED', total_quantity=0, realized_pnl=$1, closed_at=$2, close_reason=$3,
             pnl_pct = CASE WHEN $5 > 0 AND $6 > 0 THEN ROUND(((($5 - $6) / $6) * 100)::numeric, 2) ELSE pnl_pct END
             WHERE id=$4`,
            [freshPnl + profit, new Date().toISOString(), `익절: +${((sellPrice / freshAvgBuy - 1) * 100).toFixed(1)}%`, chainId, sellPrice, freshAvgBuy],
          );
        }
      }, 'SERIALIZABLE');
    }

    logger.info(
      `💰 ${logRemainingQty > 0 ? '부분 익절' : '전량 익절'}: 체인 ${chainId.slice(0, 8)} | ${sellQty}주 @${sellPrice} | 실현수익: ${logProfit.toLocaleString()}원`,
      { component: 'CHAIN' },
    );
  }

  /**
   * 전량 청산 (손절 또는 강제 청산)
   */
  async closeChain(chainId: string, sellPrice: number, chain: TransactionChain, reason: string): Promise<void> {
    const SELL_FEE_PCT = KR_FEE.SELL_FEE_PCT;

    // profit/pnlPct 계산 헬퍼 — fresh 데이터 사용
    const calcProfitAndPct = (freshAvgBuy: number, freshQty: number) => {
      const sellValue = sellPrice * freshQty;
      const profit = sellValue - Math.round(sellValue * SELL_FEE_PCT) - freshAvgBuy * freshQty;
      const pnlPctNum = freshAvgBuy > 0 ? (sellPrice / freshAvgBuy - 1) * 100 : 0;
      return { profit, pnlPctNum };
    };

    let logProfit = 0;
    let logPnlPctNum = 0;

    // 🔒 트랜잭션 + FOR UPDATE: 동시 청산(대시보드 수동 + AI) 경합 방지
    if (isMemoryMode()) {
      const avgBuy = Number(chain.avg_buy_price);
      const { profit, pnlPctNum } = calcProfitAndPct(avgBuy, chain.total_quantity);
      logProfit = profit;
      logPnlPctNum = pnlPctNum;
      await updateChain(chainId, {
        status: 'CLOSED',
        total_quantity: 0,
        realized_pnl: Number(chain.realized_pnl) + profit,
        pnl_pct: Math.round(pnlPctNum * 100) / 100,
        closed_at: new Date().toISOString(),
        close_reason: reason,
      });
    } else {
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          'SELECT realized_pnl, total_quantity, avg_buy_price FROM transaction_chains WHERE id = $1 FOR UPDATE',
          [chainId],
        );
        if (!rows[0]) return;
        const freshQty = Number(rows[0].total_quantity);
        if (freshQty <= 0) {
          logger.warn(`⚠️ 체인 이미 청산됨: ${chainId.slice(0, 8)} — 중복 청산 스킵`, { component: 'CHAIN' });
          return;
        }
        const freshAvgBuy = Number(rows[0].avg_buy_price);
        const freshPnl = Number(rows[0].realized_pnl);
        const { profit, pnlPctNum } = calcProfitAndPct(freshAvgBuy, freshQty);
        logProfit = profit;
        logPnlPctNum = pnlPctNum;
        await client.query(
          `UPDATE transaction_chains SET status='CLOSED', total_quantity=0, realized_pnl=$1, pnl_pct=$2, closed_at=$3, close_reason=$4 WHERE id=$5`,
          [freshPnl + profit, Math.round(pnlPctNum * 100) / 100, new Date().toISOString(), reason, chainId],
        );
      }, 'SERIALIZABLE');
    }

    const pnlPct = logPnlPctNum.toFixed(1);
    const emoji = logProfit >= 0 ? '💰' : '💸';

    logger.info(
      `${emoji} 체인 종료: ${chain.stock_code} | ${reason} | 실현손익: ${logProfit.toLocaleString()}원 (${pnlPct}%)`,
      { component: 'CHAIN' },
    );

    // 스코어 정확도 기록 — 비동기 fire-and-forget
    this.recordScoreAccuracy(chainId, chain, Number(pnlPct), reason).catch(() => {});

    // 연속손실 트래커 업데이트 — 포지션 사이징 배율 자동 조정
    const isWin = Number(pnlPct) > 0.1;
    recordTradeOutcome(isWin, chain.is_paper ?? false).catch(() => {});
  }

  /** 체인 종료 후 진입 당시 AI 스코어 vs 결과를 score_accuracy에 기록 */
  private async recordScoreAccuracy(
    chainId: string,
    chain: TransactionChain,
    pnlPct: number,
    reason: string,
  ): Promise<void> {
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
        [chain.stock_code, chain.opened_at ?? null],
      );
      const score = scoreRows[0];
      const holdingDays = chain.opened_at
        ? Math.round((Date.now() - new Date(chain.opened_at).getTime()) / 86400000)
        : null;
      const outcome = pnlPct > 0.1 ? 'WIN' : pnlPct < -0.1 ? 'LOSS' : 'BREAK_EVEN';

      // 진입 핑거프린트 추출 — 첫 BUY 주문의 ai_reasoning에서 fp= 태그 또는 RSI/vol 파싱
      let entryFingerprint: string | null = null;
      let buyOrderReasoning: string | null = null; // 🔒 재사용 (중복 쿼리 제거)
      try {
        const { rows: buyOrders } = await pool.query(
          `SELECT ai_reasoning FROM orders WHERE chain_id = $1 AND side = 'BUY' ORDER BY created_at ASC LIMIT 1`,
          [chainId],
        );
        if (buyOrders[0]?.ai_reasoning) {
          buyOrderReasoning = String(buyOrders[0].ai_reasoning);
          const r = buyOrderReasoning;
          // 1차: fp= 태그에서 직접 추출 (buy-execution에서 생성)
          const fpTag = r.match(/fp=([a-z_]+\|[a-z_]+\|[a-z_]+\|[a-z_]+\|[a-z_]+)/);
          if (fpTag) {
            entryFingerprint = fpTag[1];
          } else {
            // 2차: 레거시 — RSI/vol 파싱으로 재계산
            const rsiMatch = r.match(/RSI=(\d+)/);
            const volMatch = r.match(/vol=([0-9.]+)x/);
            const rsi = rsiMatch ? Number(rsiMatch[1]) : 50;
            const vol = volMatch ? Number(volMatch[1]) : 1.0;
            const smaMatch = r.match(/SMA=([a-z_]+)/);
            const hasSMA = smaMatch
              ? smaMatch[1]
              : r.includes('SMA5>SMA20')
                ? 'bull'
                : r.includes('SMA5<SMA20')
                  ? 'bear'
                  : 'neutral';
            const macdMatch = r.match(/MACD=([A-Z]+)/);
            const adxMatch = r.match(/ADX=\d+\(([A-Z]+)\)/);
            const { computeFingerprint, fingerprintKey } = await import('../analysis/entry-fingerprint.js');
            const fp = computeFingerprint({
              rsi,
              volumeRatio: vol,
              smaAlignment: hasSMA,
              macdState: macdMatch?.[1],
              adxStrength: adxMatch?.[1],
            });
            entryFingerprint = fingerprintKey(fp);
          }
        }
      } catch {
        /* 핑거프린트 추출 실패 시 null — 무시 */
      }

      // 2026-06: 보정된 점수(adjusted score)를 우선 사용 — raw composite_score는 피드백 왜곡 유발
      // 매수 주문의 ai_reasoning에서 blend=XX 추출 → 실제 진입 시 사용한 점수 기록
      // 🔒 중복 쿼리 제거: 위에서 이미 가져온 buyOrderReasoning 재사용
      let adjustedScore: number | null = null;
      try {
        if (buyOrderReasoning) {
          const blendMatch = buyOrderReasoning.match(/blend=(\d+)/);
          if (blendMatch) adjustedScore = Number(blendMatch[1]);
        }
      } catch {
        /* 추출 실패 → raw score 사용 */
      }

      const entryScore =
        adjustedScore != null
          ? Math.round(adjustedScore)
          : score?.composite_score != null
            ? Math.round(Number(score.composite_score))
            : null;

      const insertResult = await pool.query(
        `INSERT INTO score_accuracy
           (stock_code, chain_id, entry_score, entry_signal, entry_confidence,
            realized_pnl_pct, outcome, holding_days, close_reason, strategy_mode, is_paper, entry_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (chain_id) DO NOTHING`,
        [
          chain.stock_code,
          chainId,
          entryScore,
          score?.signal ?? null,
          score?.confidence ?? null,
          pnlPct,
          outcome,
          holdingDays,
          reason,
          chain.strategy_mode ?? null,
          chain.is_paper ?? getCtxIsPaper(),
          entryFingerprint,
        ],
      );
      if ((insertResult as any).rowCount === 0) {
        logger.info(`📝 스코어 정확도: ${chain.stock_code} 이미 기록됨 (중복 체인 종료)`, { component: 'CHAIN' });
      } else {
        logger.info(
          `📝 스코어 정확도 기록: ${chain.stock_code} ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)${entryFingerprint ? ` [${entryFingerprint}]` : ''}`,
          { component: 'CHAIN' },
        );
      }
    } catch (err) {
      logger.warn(`스코어 정확도 기록 실패: ${err}`, { component: 'CHAIN' });
    }
  }

  /**
   * 특정 종목의 열린 체인 찾기
   * @param isPaper 명시적 모드 지정 (미지정 시 ALS 컨텍스트 사용)
   */
  async findOpenChain(stockCode: string, isPaper?: boolean): Promise<TransactionChain | null> {
    const chains = await getOpenChains(isPaper ?? getCtxIsPaper());
    return chains.find((c) => c.stock_code === stockCode) ?? null;
  }
}

export const chainManager = new ChainManager();
