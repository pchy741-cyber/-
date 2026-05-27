/**
 * KIS 실계좌 동기화 — 보유종목 & 현금 정합
 */
import { config } from '../../config/index.js';
import { getPool, insertOrder } from '../../db/client.js';
import { getOverseasBalance, getOverseasBuyableAmount, getOverseasPrice } from '../../kis/overseas.js';
import { getAccountBalance } from '../../kis/account.js';
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';
import { getCash, setCash, clearMaxPrice } from './state.js';
import { logSystem } from '../../db/client.js';

/**
 * KIS 실계좌 잔고와 DB 동기화 — 수동매매 간섭 방지 핵심 함수
 * 수동 매도/매수 시 orders 테이블에 기록 남겨 수익률 추적
 */
export async function syncHoldingsFromKIS(): Promise<void> {
  try {
    // is_paper = NULL 오염 레코드 정리 (KIS 앱 직접매수 등으로 누락된 케이스)
    // NULL 레코드 중 이미 is_paper=false 행이 있으면 중복 제거, 없으면 live(false)로 전환
    await getPool().query(`
      DELETE FROM overseas_holdings oh1
      WHERE oh1.is_paper IS NULL
        AND EXISTS (
          SELECT 1 FROM overseas_holdings oh2
          WHERE oh2.stock_code = oh1.stock_code AND oh2.exchange = oh1.exchange AND oh2.is_paper = false
        )
    `).catch(() => {});
    await getPool().query(
      'UPDATE overseas_holdings SET is_paper = false WHERE is_paper IS NULL AND quantity > 0'
    ).catch(() => {});

    const exchanges = ['NASDAQ', 'NYSE', 'AMEX', 'TSE', 'TWSE'];
    const allHoldings = new Map<string, { qty: number; avgPrice: number; exchange: string }>();
    const failedExchanges = new Set<string>();

    for (const exch of exchanges) {
      try {
        const items = await getOverseasBalance(exch);
        for (const item of items) {
          if (item.quantity > 0 && item.stockCode) {
            // 이미 다른 거래소에서 발견된 종목은 덮어쓰지 않음 (첫 발견 우선)
            // 단, GLOBAL_WATCHLIST에 정의된 거래소가 있으면 그것을 우선 사용
            const existing = allHoldings.get(item.stockCode);
            if (existing) continue; // 중복 방지: 첫 발견 거래소 유지
            const wlEntry = GLOBAL_WATCHLIST.find(w => w.code === item.stockCode);
            const resolvedExchange = wlEntry?.exchange ?? exch;
            allHoldings.set(item.stockCode, { qty: item.quantity, avgPrice: item.avgBuyPrice, exchange: resolvedExchange });
          }
        }
      } catch {
        failedExchanges.add(exch);
      }
    }

    const { rows: dbRows } = await getPool().query(
      'SELECT stock_code, exchange, quantity, avg_price FROM overseas_holdings WHERE is_paper = false',
    ).catch(() => ({ rows: [] as any[] }));

    for (const row of dbRows) {
      if (failedExchanges.has(String(row.exchange))) continue;
      const code = String(row.stock_code);
      const dbQty = Number(row.quantity);
      const dbAvgPrice = Number(row.avg_price ?? 0);
      const kisItem = allHoldings.get(code);

      if (!kisItem || kisItem.qty === 0) {
        // ── 전량 수동매도 감지 → SELL 기록 남기기 ──
        const sellPrice = await estimateSellPrice(code, row.exchange);
        const pnlPct = dbAvgPrice > 0 && sellPrice > 0
          ? ((sellPrice - dbAvgPrice) / dbAvgPrice * 100) : 0;

        await insertOrder({
          chain_id: null,
          stock_code: code,
          side: 'SELL',
          order_type: 'MARKET',
          quantity: dbQty,
          price: sellPrice,
          kis_order_no: `MANUAL_${Date.now()}`,
          kis_status: 'FILLED',
          filled_quantity: dbQty,
          filled_price: sellPrice,
          status: 'FILLED',
          trading_mode: 'live',
          trigger_source: 'OVERSEAS',
          ai_reasoning: `[수동매도] KIS 앱에서 직접 매도 | PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% [avgBuy:${dbAvgPrice.toFixed(4)}]`,
          avg_buy_price: dbAvgPrice,
        }).catch(() => {});

        await getPool().query(
          'DELETE FROM overseas_holdings WHERE exchange=$1 AND stock_code=$2 AND is_paper = false',
          [row.exchange, code],
        ).catch(() => {});
        clearMaxPrice(code, false).catch(() => {}); // live 모드 명시

        const emoji = pnlPct >= 0 ? '💰' : '📉';
        const msg = `🚪 수동매도 감지: ${code}\n${dbQty}주 @$${sellPrice.toFixed(2)}\n${emoji} PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\norders 기록 완료`;
        logger.info(`🔄 KIS동기화: ${code} 수동매도 → SELL 기록 (PnL ${pnlPct.toFixed(2)}%)`, { component: 'OVERSEAS' });
        sendTelegramMessage(msg).catch(() => {});

      } else if (Math.abs(kisItem.qty - dbQty) >= 1) {
        const soldQty = dbQty - kisItem.qty;

        if (soldQty > 0) {
          // ── 부분 수동매도 감지 → SELL 기록 ──
          const sellPrice = await estimateSellPrice(code, row.exchange);
          const pnlPct = dbAvgPrice > 0 && sellPrice > 0
            ? ((sellPrice - dbAvgPrice) / dbAvgPrice * 100) : 0;

          await insertOrder({
            chain_id: null,
            stock_code: code,
            side: 'SELL',
            order_type: 'MARKET',
            quantity: soldQty,
            price: sellPrice,
            kis_order_no: `MANUAL_${Date.now()}`,
            kis_status: 'FILLED',
            filled_quantity: soldQty,
            filled_price: sellPrice,
            status: 'FILLED',
            trading_mode: 'live',
            trigger_source: 'OVERSEAS',
            ai_reasoning: `[수동부분매도] ${dbQty}→${kisItem.qty}주 | PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% [avgBuy:${dbAvgPrice.toFixed(4)}]`,
            avg_buy_price: dbAvgPrice,
          }).catch(() => {});

          const emoji = pnlPct >= 0 ? '💰' : '📉';
          logger.info(`🔄 KIS동기화: ${code} 부분매도 ${soldQty}주 (PnL ${pnlPct.toFixed(2)}%)`, { component: 'OVERSEAS' });
          sendTelegramMessage(`🔄 수동부분매도: ${code} ${soldQty}주\n${emoji} PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`).catch(() => {});
        } else {
          // ── 수동 추가매수 감지 → BUY 기록 ──
          const addedQty = kisItem.qty - dbQty;
          await insertOrder({
            chain_id: null,
            stock_code: code,
            side: 'BUY',
            order_type: 'MARKET',
            quantity: addedQty,
            price: kisItem.avgPrice,
            kis_order_no: `MANUAL_${Date.now()}`,
            kis_status: 'FILLED',
            filled_quantity: addedQty,
            filled_price: kisItem.avgPrice,
            status: 'FILLED',
            trading_mode: 'live',
            trigger_source: 'OVERSEAS',
            ai_reasoning: `[수동추가매수] ${dbQty}→${kisItem.qty}주 @$${kisItem.avgPrice.toFixed(2)}`,
          }).catch(() => {});

          logger.info(`🔄 KIS동기화: ${code} 추가매수 ${addedQty}주`, { component: 'OVERSEAS' });
          sendTelegramMessage(`🛒 수동추가매수: ${code} +${addedQty}주 @$${kisItem.avgPrice.toFixed(2)}`).catch(() => {});
        }

        // exchange는 DB 기존값 유지 (watchlist 기준, KIS 쿼리 거래소와 다를 수 있음)
        await getPool().query(
          'UPDATE overseas_holdings SET quantity=$1, avg_price=$2 WHERE exchange=$3 AND stock_code=$4 AND is_paper = false',
          [kisItem.qty, kisItem.avgPrice, row.exchange, code],
        ).catch(() => {});
      }
      allHoldings.delete(code);
    }

    // ── 워치리스트에 있는 신규 수동매수 ──
    const watchCodes = new Set(GLOBAL_WATCHLIST.map(s => s.code));
    for (const [code, item] of allHoldings) {
      if (!watchCodes.has(code)) continue;

      await insertOrder({
        chain_id: null,
        stock_code: code,
        side: 'BUY',
        order_type: 'MARKET',
        quantity: item.qty,
        price: item.avgPrice,
        kis_order_no: `MANUAL_${Date.now()}`,
        kis_status: 'FILLED',
        filled_quantity: item.qty,
        filled_price: item.avgPrice,
        status: 'FILLED',
        trading_mode: 'live',
        trigger_source: 'OVERSEAS',
        ai_reasoning: `[수동매수] KIS 앱에서 직접 매수 ${item.qty}주 @$${item.avgPrice.toFixed(2)}`,
      }).catch(() => {});

      await getPool().query(
        `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
         VALUES ($1, $2, $3, $4, NOW(), false)
         ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity=$3, avg_price=$4`,
        [code, item.exchange, item.qty, item.avgPrice],
      ).catch(() => {});
      logger.info(`🔄 KIS동기화: ${code} 수동매수 감지 → BUY 기록 (${item.qty}주 @$${item.avgPrice})`, { component: 'OVERSEAS' });
      sendTelegramMessage(`🛒 수동매수 감지: ${code} ${item.qty}주 @$${item.avgPrice.toFixed(2)}\norders 기록 완료`).catch(() => {});
    }
  } catch (e) {
    logger.warn(`KIS 잔고 동기화 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

/** 매도가 추정 — 현재가 조회, 실패 시 0 */
async function estimateSellPrice(code: string, exchange: string): Promise<number> {
  try {
    const price = await getOverseasPrice(code, exchange);
    return price?.currentPrice ?? 0;
  } catch { return 0; }
}

/**
 * KIS 실계좌 현금과 DB 현금 동기화 — 입출금/수수료 차이 자동 보정
 */
export async function reconcileCashWithKIS(): Promise<void> {
  if (config.isPaper) return;
  try {
    let kisCash = await getOverseasBuyableAmount();
    // 통합증거금 폴백: 해외주문가능금액 API 실패 시 국내 계좌 잔고 ÷ 환율
    // ⚠️ 국내 잔고 전체를 해외 현금으로 잡으면 과다투입 위험 → 30% 상한
    if (kisCash === null || kisCash === undefined) {
      try {
        const balance = await getAccountBalance(true); // forceLive
        const fxRate = await fetchExchangeRate();
        if (balance.orderableCash > 0 && fxRate > 0) {
          const rawUsd = balance.orderableCash / fxRate;
          // 국내 원화 잔고의 30%만 해외 투자 가용으로 인정 (과다투입 방지)
          kisCash = rawUsd * 0.30;
          logger.info(`💱 통합증거금 폴백: ₩${balance.orderableCash.toLocaleString()} ÷ ${fxRate.toFixed(0)} = $${rawUsd.toFixed(2)} → 30% 적용 $${kisCash.toFixed(2)}`, { component: 'OVERSEAS' });
        }
      } catch { /* 국내 잔고 조회도 실패 시 무시 */ }
    }
    if (kisCash === null || kisCash === undefined) return;
    const dbCash = await getCash(false);

    // 🛡️ 안전 가드: KIS $0/$1 미만 반환 시 DB 현금 zeroing 차단
    // (KIS API 오류, 빈 계좌, 잘못된 인증 등으로 인한 의심값 보호)
    if (kisCash < 1 && dbCash > 100) {
      logger.warn(`💰 Cash zeroing 차단: KIS=$${kisCash.toFixed(2)} (의심값), DB=$${dbCash.toFixed(0)} 유지`, { component: 'OVERSEAS' });
      await logSystem('WARN', 'OVERSEAS', `Cash zeroing 차단: KIS=${kisCash.toFixed(2)}, DB=${dbCash.toFixed(0)}`).catch(() => {});
      sendTelegramMessage(`⚠️ 해외 현금 zeroing 차단\nKIS=$${kisCash.toFixed(2)} (의심) → DB=$${dbCash.toFixed(0)} 보존`).catch(() => {});
      return;
    }

    const diff = Math.abs(kisCash - dbCash);

    // 통합증거금: KIS API가 원화→USD 환산 주문가능금액 반환
    // DB와 $10 이상 또는 1% 이상 차이 시 보정 (첫 매매 전에도 동기화)
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
