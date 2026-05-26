/**
 * KIS 실계좌 동기화 — 보유종목 & 현금 정합
 */
import { config } from '../../config/index.js';
import { getPool } from '../../db/client.js';
import { getOverseasBalance, getOverseasBuyableAmount } from '../../kis/overseas.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';
import { getCash, setCash } from './state.js';
import { logSystem } from '../../db/client.js';

/**
 * KIS 실계좌 잔고와 DB 동기화 — 수동매매 간섭 방지 핵심 함수
 */
export async function syncHoldingsFromKIS(): Promise<void> {
  try {
    const exchanges = ['NASDAQ', 'NYSE', 'AMEX', 'TSE', 'TWSE'];
    const allHoldings = new Map<string, { qty: number; avgPrice: number; exchange: string }>();
    const failedExchanges = new Set<string>();

    for (const exch of exchanges) {
      try {
        const items = await getOverseasBalance(exch);
        for (const item of items) {
          if (item.quantity > 0 && item.stockCode) {
            allHoldings.set(item.stockCode, { qty: item.quantity, avgPrice: item.avgBuyPrice, exchange: exch });
          }
        }
      } catch {
        failedExchanges.add(exch);
      }
    }

    const { rows: dbRows } = await getPool().query('SELECT stock_code, exchange, quantity FROM overseas_holdings WHERE is_paper = false').catch(() => ({ rows: [] as any[] }));

    for (const row of dbRows) {
      if (failedExchanges.has(String(row.exchange))) continue;
      const kisItem = allHoldings.get(String(row.stock_code));
      if (!kisItem || kisItem.qty === 0) {
        await getPool().query('DELETE FROM overseas_holdings WHERE exchange=$1 AND stock_code=$2 AND is_paper = false', [row.exchange, row.stock_code]).catch(() => {});
        logger.info(`🔄 KIS동기화: ${row.stock_code} 수동매도 감지 → DB 제거`, { component: 'OVERSEAS' });
        sendTelegramMessage(`🚪 수동매도 감지: ${row.stock_code}\nDB에서 제거됨 (KIS 앱에서 매도)`).catch(() => {});
      } else if (Math.abs(kisItem.qty - Number(row.quantity)) >= 1) {
        await getPool().query(
          'UPDATE overseas_holdings SET quantity=$1, avg_price=$2 WHERE exchange=$3 AND stock_code=$4 AND is_paper = false',
          [kisItem.qty, kisItem.avgPrice, kisItem.exchange, row.stock_code],
        ).catch(() => {});
        logger.info(`🔄 KIS동기화: ${row.stock_code} 수량 조정 ${row.quantity}→${kisItem.qty}`, { component: 'OVERSEAS' });
        sendTelegramMessage(`🔄 포지션 수동조정: ${row.stock_code} ${row.quantity}→${kisItem.qty}주 (KIS 앱)`).catch(() => {});
      }
      allHoldings.delete(String(row.stock_code));
    }

    const watchCodes = new Set(GLOBAL_WATCHLIST.map(s => s.code));
    for (const [code, item] of allHoldings) {
      if (!watchCodes.has(code)) continue;
      await getPool().query(
        `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
         VALUES ($1, $2, $3, $4, NOW(), false)
         ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity=$3, avg_price=$4`,
        [code, item.exchange, item.qty, item.avgPrice],
      ).catch(() => {});
      logger.info(`🔄 KIS동기화: ${code} 수동매수 감지 → DB 추가 (${item.qty}주 @$${item.avgPrice})`, { component: 'OVERSEAS' });
      sendTelegramMessage(`🛒 수동매수 감지: ${code} ${item.qty}주 @$${item.avgPrice.toFixed(2)}\nDB 추적 추가 (KIS 앱)`).catch(() => {});
    }
  } catch (e) {
    logger.warn(`KIS 잔고 동기화 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

/**
 * KIS 실계좌 현금과 DB 현금 동기화 — 입출금/수수료 차이 자동 보정
 */
export async function reconcileCashWithKIS(): Promise<void> {
  if (config.isPaper) return;
  try {
    // 해외매매 이력 없으면 동기화 불필요 (KRW→USD 환산값 오염 방지)
    const { rows: orderCheck } = await getPool().query(
      "SELECT COUNT(*) as cnt FROM orders WHERE trading_mode = 'live' AND status = 'FILLED' AND trigger_source = 'OVERSEAS'");
    if (Number(orderCheck[0]?.cnt ?? 0) === 0) return;

    const kisCash = await getOverseasBuyableAmount();
    if (kisCash === null || kisCash === undefined) return;
    const dbCash = await getCash(false);
    const diff = Math.abs(kisCash - dbCash);
    if (diff < 10 || (dbCash > 0 && diff / dbCash < 0.01)) return;

    logger.warn(`💰 Cash 정합: DB=$${dbCash.toFixed(0)} vs KIS=$${kisCash.toFixed(0)} (차이: $${diff.toFixed(0)})`, { component: 'OVERSEAS' });
    await logSystem('WARN', 'OVERSEAS', `Cash 정합 보정: DB=$${dbCash.toFixed(0)} → KIS=$${kisCash.toFixed(0)}`);
    await setCash(kisCash, false);
    if (diff >= 50) {
      sendTelegramMessage(
        `💰 현금 정합성 보정\nDB: $${dbCash.toFixed(0)} → KIS: $${kisCash.toFixed(0)}\n차이: $${(kisCash - dbCash).toFixed(0)} (${kisCash > dbCash ? '입금/배당?' : '출금/수수료?'})`
      ).catch(() => {});
    }
  } catch (e) {
    logger.warn(`Cash 정합 체크 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}
