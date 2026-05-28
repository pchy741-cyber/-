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
import { getCash, getCashKrw, setCash, clearMaxPrice } from './state.js';
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

        // 가격 0 = 시장 마감 / API 오류 → 스킵 (phantom $0 레코드 방지)
        if (sellPrice <= 0) {
          logger.warn(`⚠️ KIS동기화: ${code} 가격조회 실패(0) → SELL 기록 스킵`, { component: 'OVERSEAS' });
          allHoldings.delete(code);
          continue;
        }

        // 디바운스: KIS API 플래핑 방지 — 2회 연속 감지 시에만 SELL 처리
        const debounceKey = `sync_sell_pending_${code}`;
        const { rows: debounceRows } = await getPool().query(
          'SELECT value FROM overseas_state WHERE key = $1',
          [debounceKey],
        ).catch(() => ({ rows: [] as any[] }));

        if (debounceRows.length === 0) {
          // 첫 감지: 상태 저장, 이번 사이클은 스킵
          await getPool().query(
            `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
            [debounceKey, String(sellPrice)],
          ).catch(() => {});
          logger.info(`⏳ KIS동기화: ${code} 잔고 0 첫 감지($${sellPrice.toFixed(2)}) → 다음 확인 시 처리`, { component: 'OVERSEAS' });
          allHoldings.delete(code);
          continue;
        }

        // 2회 이상 감지: 진짜 수동매도 → 기록 생성 후 debounce 상태 제거
        await getPool().query('DELETE FROM overseas_state WHERE key = $1', [debounceKey]).catch(() => {});

        const pnlPct = dbAvgPrice > 0
          ? ((sellPrice - dbAvgPrice) / dbAvgPrice * 100) : 0;

        const manualOrderId = await insertOrder({
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
        }).catch(() => '');

        // score_accuracy 기록
        if (manualOrderId && dbAvgPrice > 0 && sellPrice > 0) {
          const outcome = pnlPct > 0.1 ? 'WIN' : pnlPct < -0.1 ? 'LOSS' : 'BREAK_EVEN';
          getPool().query(
            `INSERT INTO score_accuracy (stock_code, order_id, market, realized_pnl_pct, outcome, close_reason, is_paper)
             VALUES ($1, $2, 'US', $3, $4, $5, false)
             ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING`,
            [code, manualOrderId, pnlPct, outcome, '수동매도'],
          ).catch(() => {});
        }

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
        // 포지션 확인됨 → 잔여 debounce 상태 제거
        getPool().query('DELETE FROM overseas_state WHERE key = $1', [`sync_sell_pending_${code}`]).catch(() => {});

        const soldQty = dbQty - kisItem.qty;

        if (soldQty > 0) {
          // ── 부분 수동매도 감지 → SELL 기록 ──
          const sellPrice = await estimateSellPrice(code, row.exchange);

          // 가격 0 = 시장 마감 / API 오류 → 스킵
          if (sellPrice <= 0) {
            logger.warn(`⚠️ KIS동기화: ${code} 부분매도 가격조회 실패(0) → 스킵`, { component: 'OVERSEAS' });
          } else {
            const pnlPct = dbAvgPrice > 0
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
          }
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
      } else {
        // 포지션 수량 일치 (안정) → 잔여 debounce 상태 제거
        getPool().query('DELETE FROM overseas_state WHERE key = $1', [`sync_sell_pending_${code}`]).catch(() => {});
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
 * KIS 실계좌 현금과 DB 현금 동기화 — 원화(KRW) 기준
 * 통합증거금: 원화 단일 풀로 국내+해외 운용. KIS psamount API에서 KRW 직접 추출.
 */
export async function reconcileCashWithKIS(): Promise<void> {
  if (config.isPaper) return;
  try {
    let kisKrw: number | null = null;

    // 1차: psamount API — KRW 필드 직접 사용 (FX 변환 없이 정확)
    const buyable = await getOverseasBuyableAmount();
    if (buyable?.krw != null && buyable.krw > 0) {
      kisKrw = buyable.krw;
      logger.info(`💱 통합증거금: psamount KRW 직접 사용 ₩${kisKrw.toLocaleString()}`, { component: 'OVERSEAS' });
    }

    // 2차: psamount USD → KRW 변환 (KRW 필드 없는 경우)
    if (kisKrw === null && buyable?.usd != null && buyable.usd > 0) {
      const fxRate = await fetchExchangeRate();
      if (fxRate > 0) {
        kisKrw = buyable.usd * fxRate;
        logger.info(`💱 psamount USD→KRW 변환: $${buyable.usd.toFixed(2)} × ${fxRate.toFixed(0)} = ₩${kisKrw.toFixed(0)}`, { component: 'OVERSEAS' });
      }
    }

    // 3차 폴백: 국내 계좌잔고 API — 통합증거금이므로 100% 사용
    if (kisKrw === null) {
      try {
        const balance = await getAccountBalance(true);
        // 통합증거금: orderableCash = 전체 주문가능원화 (국내+해외 공용)
        // netAsset - 국내투자 = 해외+현금 가용액
        const netAsset = (balance as any).netAsset ?? 0;
        const domesticEval = balance.totalEvalAmount ?? 0;
        if (netAsset > 0) {
          kisKrw = Math.max(0, netAsset - domesticEval);
          logger.info(`💱 통합증거금 폴백: netAsset=₩${netAsset.toLocaleString()} - domesticEval=₩${domesticEval.toLocaleString()} = ₩${kisKrw.toLocaleString()}`, { component: 'OVERSEAS' });
        }
      } catch { /* 국내 잔고 조회 실패 시 무시 */ }
    }
    if (kisKrw === null) return;

    const dbKrw = await getCashKrw();

    // 안전 가드: KIS ₩1,000 미만인데 DB ₩100,000 이상 → zeroing 차단
    if (kisKrw < 1000 && dbKrw > 100_000) {
      logger.warn(`💰 Cash zeroing 차단: KIS=₩${kisKrw.toFixed(0)} (의심), DB=₩${dbKrw.toFixed(0)} 유지`, { component: 'OVERSEAS' });
      return;
    }

    const diff = Math.abs(kisKrw - dbKrw);
    // ₩5,000 이상 또는 1% 이상 차이 시 보정
    if (diff < 5000 || (dbKrw > 0 && diff / dbKrw < 0.01)) return;

    const fxRate = await fetchExchangeRate();
    const dbUsd = fxRate > 0 ? dbKrw / fxRate : 0;
    const kisUsdDisp = fxRate > 0 ? kisKrw / fxRate : 0;
    logger.warn(`💰 Cash 정합: DB=₩${dbKrw.toFixed(0)}($${dbUsd.toFixed(0)}) → KIS=₩${kisKrw.toFixed(0)}($${kisUsdDisp.toFixed(0)})`, { component: 'OVERSEAS' });
    await setCash(kisKrw, false);
    if (diff >= 50_000) {
      sendTelegramMessage(
        `💰 현금 정합성 보정\nDB: ₩${dbKrw.toLocaleString()} → KIS: ₩${kisKrw.toLocaleString()}\n차이: ₩${(kisKrw - dbKrw).toLocaleString()}`
      ).catch(() => {});
    }
  } catch (e) {
    logger.warn(`Cash 정합 체크 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}
