import { Hono } from 'hono';
import { getOpenChains, getPool } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getPaperBalance } from '../../../risk/engine.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { getKnownStockName } from '../dashboard.js';

export const manualTriggersRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── Track B 즉시 수동 실행 ──
manualTriggersRoutes.post('/run-track-b', async (c) => {
  try {
    const { runTrackBJob } = await import('../../../scheduler/track-b-job.js');
    runTrackBJob().catch((e: Error) => logger.error(`수동 Track B 실패: ${e.message}`, { component: 'MANUAL' }));
    logger.info('수동 Track B 실행 요청됨', { component: 'MANUAL' });
    return c.json({ ok: true, message: 'Track B 실행 시작됨 (10~30초 소요)' });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── Track A 즉시 수동 실행 (AI 점수 강제 갱신) ──
manualTriggersRoutes.post('/run-track-a', async (c) => {
  try {
    const { runTrackAJob } = await import('../../../scheduler/track-a-job.js');
    runTrackAJob().catch((e: Error) => logger.error(`수동 Track A 실패: ${e.message}`, { component: 'MANUAL' }));
    logger.info('수동 Track A 실행 요청됨', { component: 'MANUAL' });
    return c.json({ ok: true, message: 'Track A 실행 시작됨 (2~5분 소요)' });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 방어 파킹 수동 강제 해제 + SOFR ETF 즉시 시장가 매도 ──
manualTriggersRoutes.post('/release-defense-park', async (c) => {
  try {
    const { deactivateDefensePark, PARK_STOCK_CODE: parkCode, PARK_STOCK_NAME: parkName } = await import('../../../ai/track-b/defense-park.js');
    const { getPositionForStock } = await import('../../../kis/account.js');
    const { placeOrder } = await import('../../../kis/order.js');

    await deactivateDefensePark('CEO 수동 해제');
    logger.info('방어 파킹 수동 강제 해제됨', { component: 'MANUAL' });

    // strategy_config도 SWING으로 복원 (현재 모드만)
    try {
      const isPaper = resolveViewIsPaper(c);
      await getPool().query(
        `UPDATE strategy_config SET mode='SWING', buy_threshold=70, updated_at=NOW() WHERE is_active=true AND is_paper=$1`,
        [isPaper],
      );
    } catch {
      /* 실패해도 계속 */
    }

    const position = await getPositionForStock(parkCode);
    let sellMsg = '';
    if (position && position.quantity > 0) {
      const result = await placeOrder({ stockCode: parkCode, side: 'SELL', quantity: position.quantity });
      logger.info(
        `🛡️ ${parkName} 즉시 매도: ${position.quantity}주 → ${result.success ? '성공' : '실패'} (${result.message})`,
        { component: 'MANUAL' },
      );
      sellMsg = `${parkName} ${position.quantity}주 매도 완료. `;
    }

    let syncMsg = '';
    try {
      const isPaper = resolveRequestMode(c);
      const [balance, openChains] = await Promise.all([
        isPaper ? getPaperBalance() : getAccountBalance(true),
        getOpenChains(isPaper),
      ]);
      const chainedCodes = new Set(openChains.map((ch: any) => ch.stock_code));
      const orphans = (balance.positions ?? [])
        .map((p: any) => ({
          stockCode: String(p.stockCode ?? ''),
          quantity: Number(p.quantity ?? p.holdingQuantity ?? 0),
          avgBuyPrice: Number(p.avgBuyPrice ?? p.purchasePrice ?? 0),
          stockName: p.stockName ?? undefined,
        }))
        .filter(
          (p) => p.stockCode.length === 6 && p.quantity > 0 && p.avgBuyPrice > 0 && !chainedCodes.has(p.stockCode),
        );

      if (orphans.length > 0) {
        const { createChain, insertOrder } = await import('../../../db/client.js');
        const synced: string[] = [];
        for (const pos of orphans) {
          try {
            const knownName = getKnownStockName(pos.stockCode) ?? pos.stockName ?? pos.stockCode;
            await getPool().query(
              `INSERT INTO watchlist (stock_code, stock_name, market, source) VALUES ($1, $2, 'KOSPI', 'KIS_SYNC') ON CONFLICT (stock_code) DO NOTHING`,
              [pos.stockCode, knownName],
            );
            const chainId = await createChain({
              stock_code: pos.stockCode,
              status: 'OPEN',
              strategy_mode: 'SWING',
              avg_buy_price: pos.avgBuyPrice,
              total_quantity: pos.quantity,
              total_invested: pos.avgBuyPrice * pos.quantity,
              realized_pnl: 0,
              target_profit_pct: 2.5,
              stop_loss_pct: -1.5,
              max_averaging_count: 1,
              current_averaging_count: 0,
            });
            await insertOrder({
              chain_id: chainId,
              stock_code: pos.stockCode,
              side: 'BUY',
              order_type: '01',
              quantity: pos.quantity,
              price: pos.avgBuyPrice,
              kis_order_no: `SYNC_${pos.stockCode}`,
              kis_status: null,
              filled_quantity: pos.quantity,
              filled_price: pos.avgBuyPrice,
              status: 'FILLED',
              trading_mode: isPaper ? 'paper' : 'live',
              trigger_source: 'SYNC',
              ai_reasoning: 'KIS 잔고 동기화 — 파킹 해제 시 자동 복구',
            });
            synced.push(pos.stockCode);
          } catch {
            /* skip individual failure */
          }
        }
        syncMsg = `보유종목 ${synced.length}개 대시보드 복구 완료.`;
        logger.info(`🔄 파킹 해제 후 포지션 자동 복구: ${synced.join(', ')}`, { component: 'MANUAL' });
      }
    } catch (syncErr: any) {
      logger.warn(`포지션 자동 복구 실패: ${syncErr.message}`, { component: 'MANUAL' });
    }

    const { invalidateCurrentModeCache } = await import('../dashboard/helpers.js');
    invalidateCurrentModeCache();
    return c.json({ ok: true, message: `파킹 해제 완료. ${sellMsg}${syncMsg}자동매매 재개`.trim() });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});
