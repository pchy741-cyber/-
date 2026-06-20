/**
 * KIS 실계좌 동기화 — 보유종목 & 현금 정합
 */

import { fetchExchangeRate } from '../../automation/macro-data.js';
import { hardInvalidateDashboardCache } from '../../cache/dashboard-cache.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool, insertOrder } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getOverseasBalance, getOverseasBuyableAmount, getOverseasPrice } from '../../kis/overseas.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { cleanupPositionState, getCashKrw, getTimeSinceLastTrade, setCash } from './state.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';

// ── In-memory debounce for manual sell detection (race condition prevention) ──
// Tracks first-detection timestamps per stock code to prevent concurrent sync cycles
// from both inserting SELL records for the same stock.
const _sellDebounceMap = new Map<string, number>();
const SELL_DEBOUNCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * KIS 실계좌 잔고와 DB 동기화 — 수동매매 간섭 방지 핵심 함수
 * 수동 매도/매수 시 orders 테이블에 기록 남겨 수익률 추적
 */
export async function syncHoldingsFromKIS(): Promise<void> {
  try {
    // is_paper = NULL 오염 레코드 정리 (KIS 앱 직접매수 등으로 누락된 케이스)
    // NULL 레코드 중 이미 is_paper=false 행이 있으면 중복 제거, 없으면 live(false)로 전환
    await getPool()
      .query(`
      DELETE FROM overseas_holdings oh1
      WHERE oh1.is_paper IS NULL
        AND EXISTS (
          SELECT 1 FROM overseas_holdings oh2
          WHERE oh2.stock_code = oh1.stock_code AND oh2.exchange = oh1.exchange AND oh2.is_paper = false
        )
    `)
      .catch(() => {});
    await getPool()
      .query('UPDATE overseas_holdings SET is_paper = false WHERE is_paper IS NULL AND quantity > 0')
      .catch(() => {});

    const exchanges = ['NASDAQ', 'NYSE', 'AMEX', 'TSE', 'TWSE'];
    const allHoldings = new Map<string, { qty: number; avgPrice: number; exchange: string }>();
    const kisPriceMap = new Map<string, number>(); // 현재가 수집 (last_price 업데이트용)
    const successExchanges = new Set<string>(); // API 성공한 거래소만 추적
    let syncChanged = false; // 매매 변동 감지 시 캐시 무효화

    for (const exch of exchanges) {
      try {
        const items = await getOverseasBalance(exch);
        successExchanges.add(exch); // 성공한 거래소만 기록
        for (const item of items) {
          if (item.quantity > 0 && item.stockCode) {
            if (item.currentPrice > 0) kisPriceMap.set(item.stockCode, item.currentPrice);
            const existing = allHoldings.get(item.stockCode);
            if (existing) continue;
            const wlEntry = GLOBAL_WATCHLIST.find((w) => w.code === item.stockCode);
            const resolvedExchange = wlEntry?.exchange ?? exch;
            allHoldings.set(item.stockCode, {
              qty: item.quantity,
              avgPrice: item.avgBuyPrice,
              exchange: resolvedExchange,
            });
          }
        }
      } catch {
        // API 실패 = 시장 마감 또는 일시 오류 → 해당 거래소는 "확인 불가"로 처리
        // failedExchanges에 넣으면 ghost 포지션이 영원히 안 지워지는 버그 발생
        logger.info(`⏭️ KIS잔고조회 실패 (${exch}) — 시장 마감 또는 오류, 이번 사이클 스킵`, { component: 'OVERSEAS' });
      }
    }

    const { rows: dbRows } = await getPool()
      .query('SELECT stock_code, exchange, quantity, avg_price FROM overseas_holdings WHERE is_paper = false')
      .catch(() => ({
        rows: [] as Array<{ stock_code: string; exchange: string; quantity: string; avg_price: string }>,
      }));

    for (const row of dbRows) {
      // API 성공한 거래소만 처리 — 실패한 거래소(마감/오류)는 스킵 (ghost 방지)
      if (!successExchanges.has(String(row.exchange))) continue;
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
        // In-memory + DB double-check to prevent race condition between concurrent sync cycles
        const debounceKey = `sync_sell_pending_${code}`;
        const now = Date.now();

        // Clean up stale in-memory debounce entries
        for (const [k, ts] of _sellDebounceMap) {
          if (now - ts > SELL_DEBOUNCE_TTL_MS) _sellDebounceMap.delete(k);
        }

        const inMemoryFirstSeen = _sellDebounceMap.get(code);
        const { rows: debounceRows } = await getPool()
          .query('SELECT value FROM overseas_state WHERE key = $1', [debounceKey])
          .catch(() => ({ rows: [] as Array<{ value: string }> }));

        if (debounceRows.length === 0 && !inMemoryFirstSeen) {
          // 첫 감지: debounce 상태 저장 (in-memory + DB) + 즉시 재매수 쿨다운 설정
          // (2회 확인 전이라도 이번 사이클에서 재매수 금지 — 예약매도 후 재매수 버그 방지)
          _sellDebounceMap.set(code, now);
          await getPool()
            .query(
              `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
              [debounceKey, String(sellPrice)],
            )
            .catch(() => {});
          getPool()
            .query(
              `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
              [`manual_sell_cd_${code}`, JSON.stringify({ at: new Date().toISOString(), pnlPct: 0 })],
            )
            .catch(() => {});
          logger.info(`⏳ KIS동기화: ${code} 잔고 0 첫 감지($${sellPrice.toFixed(2)}) → 재매수 쿨다운 선제 설정`, {
            component: 'OVERSEAS',
          });
          allHoldings.delete(code);
          continue;
        }

        // 2회 이상 감지: 진짜 수동매도 → 기록 생성 후 debounce 상태 제거
        _sellDebounceMap.delete(code);
        await getPool()
          .query('DELETE FROM overseas_state WHERE key = $1', [debounceKey])
          .catch(() => {});

        const pnlPct = dbAvgPrice > 0 ? ((sellPrice - dbAvgPrice) / dbAvgPrice) * 100 : 0;

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
          getPool()
            .query(
              `INSERT INTO score_accuracy (stock_code, order_id, market, realized_pnl_pct, outcome, close_reason, is_paper)
             VALUES ($1, $2, 'US', $3, $4, $5, false)
             ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING`,
              [code, manualOrderId, pnlPct, outcome, '수동매도'],
            )
            .catch(() => {});
        }

        await getPool()
          .query('DELETE FROM overseas_holdings WHERE exchange=$1 AND stock_code=$2 AND is_paper = false', [
            row.exchange,
            code,
          ])
          .catch(() => {});
        cleanupPositionState(code, false).catch(() => {}); // live 모드 명시

        // 수동매도 쿨다운: 2시간 재매수 금지 (사용자 의도 매도 보호)
        getPool()
          .query(`INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [
            `manual_sell_cd_${code}`,
            JSON.stringify({ at: new Date().toISOString(), pnlPct }),
          ])
          .catch(() => {});

        const emoji = pnlPct >= 0 ? '💰' : '📉';
        const msg = `🚪 수동매도 감지: ${code}\n${dbQty}주 @$${sellPrice.toFixed(2)}\n${emoji} PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\norders 기록 완료`;
        logger.info(`🔄 KIS동기화: ${code} 수동매도 → SELL 기록 (PnL ${pnlPct.toFixed(2)}%) → 2h 재매수 쿨다운 설정`, {
          component: 'OVERSEAS',
        });
        sendTelegramMessage(msg).catch(() => {});
        syncChanged = true;
      } else if (Math.abs(kisItem.qty - dbQty) >= 1) {
        // 포지션 확인됨 → 잔여 debounce 상태 제거
        getPool()
          .query('DELETE FROM overseas_state WHERE key = $1', [`sync_sell_pending_${code}`])
          .catch(() => {});

        const soldQty = dbQty - kisItem.qty;

        if (soldQty > 0) {
          // ── 부분 수동매도 감지 → SELL 기록 ──
          const sellPrice = await estimateSellPrice(code, row.exchange);

          // 가격 0 = 시장 마감 / API 오류 → 스킵
          if (sellPrice <= 0) {
            logger.warn(`⚠️ KIS동기화: ${code} 부분매도 가격조회 실패(0) → 스킵`, { component: 'OVERSEAS' });
          } else {
            const pnlPct = dbAvgPrice > 0 ? ((sellPrice - dbAvgPrice) / dbAvgPrice) * 100 : 0;

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
            logger.info(`🔄 KIS동기화: ${code} 부분매도 ${soldQty}주 (PnL ${pnlPct.toFixed(2)}%)`, {
              component: 'OVERSEAS',
            });
            sendTelegramMessage(
              `🔄 수동부분매도: ${code} ${soldQty}주\n${emoji} PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
            ).catch(() => {});
            syncChanged = true;
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
          sendTelegramMessage(`🛒 수동추가매수: ${code} +${addedQty}주 @$${kisItem.avgPrice.toFixed(2)}`).catch(
            () => {},
          );
          syncChanged = true;
        }

        // exchange는 DB 기존값 유지 (watchlist 기준, KIS 쿼리 거래소와 다를 수 있음)
        await getPool()
          .query(
            'UPDATE overseas_holdings SET quantity=$1, avg_price=$2 WHERE exchange=$3 AND stock_code=$4 AND is_paper = false',
            [kisItem.qty, kisItem.avgPrice, row.exchange, code],
          )
          .catch(() => {});
      } else {
        // 포지션 수량 일치 (안정) → 잔여 debounce 상태 제거
        getPool()
          .query('DELETE FROM overseas_state WHERE key = $1', [`sync_sell_pending_${code}`])
          .catch(() => {});
      }
      allHoldings.delete(code);
    }

    // ── 워치리스트에 있는 신규 수동매수 ──
    const watchCodes = new Set(GLOBAL_WATCHLIST.map((s) => s.code));
    for (const [code, item] of allHoldings) {
      if (!watchCodes.has(code)) continue;

      // 수동매도 쿨다운 중이면 재삽입 스킵 (T+1 결제: KIS API가 매도 종목을 아직 반환)
      const { rows: cdRows } = await getPool()
        .query('SELECT value FROM overseas_state WHERE key = $1', [`manual_sell_cd_${code}`])
        .catch(() => ({ rows: [] as Array<{ value: string }> }));
      if (cdRows.length > 0) {
        logger.info(`⏭️ KIS동기화: ${code} 수동매도 쿨다운 중 → 재매수 감지 스킵 (T+1 결제 대기)`, {
          component: 'OVERSEAS',
        });
        continue;
      }

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

      await getPool()
        .query(
          `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
         VALUES ($1, $2, $3, $4, NOW(), false)
         ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity=$3, avg_price=$4`,
          [code, item.exchange, item.qty, item.avgPrice],
        )
        .catch(() => {});
      logger.info(`🔄 KIS동기화: ${code} 수동매수 감지 → BUY 기록 (${item.qty}주 @$${item.avgPrice})`, {
        component: 'OVERSEAS',
      });
      sendTelegramMessage(
        `🛒 수동매수 감지: ${code} ${item.qty}주 @$${item.avgPrice.toFixed(2)}\norders 기록 완료`,
      ).catch(() => {});
      syncChanged = true;
    }

    // 매매 변동 감지 시 대시보드 캐시 무효화
    if (syncChanged) hardInvalidateDashboardCache();

    // ── KIS 현재가 → DB last_price 업데이트 (대시보드 정합성) ──
    // kisPriceMap은 초기 balance API 호출 시 수집한 현재가 (추가 API 호출 없음)
    for (const [code, price] of kisPriceMap) {
      if (price > 0) {
        getPool()
          .query(
            'UPDATE overseas_holdings SET last_price = $1, last_price_at = NOW() WHERE stock_code = $2 AND is_paper = false',
            [price, code],
          )
          .catch(() => {});
      }
    }
    if (kisPriceMap.size > 0) {
      logger.info(`📊 KIS동기화: ${kisPriceMap.size}종목 현재가 업데이트 완료`, { component: 'OVERSEAS' });
    }
  } catch (e) {
    logger.warn(`KIS 잔고 동기화 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

/** 매도가 추정 — 현재가 조회, 실패 시 0 */
async function estimateSellPrice(code: string, exchange: string): Promise<number> {
  try {
    const price = await getOverseasPrice(code, exchange);
    const val = price?.currentPrice ?? 0;
    return Number.isFinite(val) ? val : 0;
  } catch (e) {
    logger.warn(`매도가 추정 실패 (${code}): ${(e as Error).message}`, { component: 'OVERSEAS' });
    return 0;
  }
}

/**
 * KIS 실계좌 현금과 DB 현금 동기화 — 원화(KRW) 기준
 * 통합증거금: 원화 단일 풀로 국내+해외 운용. KIS psamount API에서 KRW 직접 추출.
 */
export async function reconcileCashWithKIS(): Promise<void> {
  if (getCtxIsPaper()) return;
  // 매매 직후 3분간 KIS 동기화 스킵 — T+1 미결제로 KIS가 매수 전 잔고 반환하여 현금 복원 버그 방지
  const cooldownMs = 3 * 60 * 1000;
  if (getTimeSinceLastTrade() < cooldownMs) {
    logger.info('💱 매매 후 쿨다운 중 — KIS 현금 동기화 스킵', { component: 'OVERSEAS' });
    return;
  }
  try {
    let kisKrw: number | null = null;

    // 1차: psamount API — frcr_ord_psbl_amt1(통합증거금 전체) 우선 사용
    // 통합증거금: 원화+외화 전체 주문가능금액 (KIS 앱 "주문가능원화"/환율)
    // ord_psbl_frcr_amt는 외화 풀만 → 통합증거금 환경에서 과소 평가
    const buyable = await getOverseasBuyableAmount();
    if (buyable != null) {
      const rate = buyable.exrt > 0 ? buyable.exrt : await fetchExchangeRate();
      // 통합증거금: maxUsd(원화+외화 전체) 우선, 폴백으로 usd(외화만)
      const effectiveUsd = buyable.maxUsd > 0 ? buyable.maxUsd : buyable.usd;
      if (rate > 0 && effectiveUsd > 0) {
        kisKrw = effectiveUsd * rate;
        logger.info(
          `💱 해외현금(통합증거금): $${effectiveUsd.toFixed(2)} × ${rate.toFixed(0)} = ₩${kisKrw.toFixed(0)} (usd=$${buyable.usd.toFixed(2)}, maxUsd=$${buyable.maxUsd.toFixed(2)})`,
          { component: 'OVERSEAS' },
        );
      }
    }

    // 3차 폴백: 국내 계좌잔고 API — 통합증거금이므로 100% 사용
    if (kisKrw === null) {
      try {
        const balance = await getAccountBalance(true);
        // 통합증거금: orderableCash = 전체 주문가능원화 (국내+해외 공용)
        // netAsset - 국내투자 = 해외+현금 가용액
        const netAsset = balance.netAsset ?? 0;
        const domesticEval = balance.totalEvalAmount ?? 0;
        if (netAsset > 0) {
          kisKrw = Math.max(0, netAsset - domesticEval);
          logger.info(
            `💱 통합증거금 폴백: netAsset=₩${netAsset.toLocaleString()} - domesticEval=₩${domesticEval.toLocaleString()} = ₩${kisKrw.toLocaleString()}`,
            { component: 'OVERSEAS' },
          );
        }
      } catch (e) {
        logger.warn(`국내 잔고 조회 실패 (폴백 스킵): ${(e as Error).message}`, { component: 'OVERSEAS' });
      }
    }
    if (kisKrw === null) return;

    const dbKrw = await getCashKrw();

    // 안전 가드: KIS ₩1,000 미만인데 DB ₩100,000 이상 → zeroing 차단
    if (kisKrw < 1000 && dbKrw > 100_000) {
      logger.warn(`💰 Cash zeroing 차단: KIS=₩${kisKrw.toFixed(0)} (의심), DB=₩${dbKrw.toFixed(0)} 유지`, {
        component: 'OVERSEAS',
      });
      return;
    }

    // 실제 주문가능 USD 항상 저장 (대시보드 표시용)
    if (buyable != null) {
      const usdVal = buyable.usd >= 0 ? buyable.usd : 0;
      const maxUsdVal = buyable.maxUsd >= 0 ? buyable.maxUsd : 0;
      await getPool()
        .query(
          // 외화 풀 USD (ord_psbl_frcr_amt) + 통합증거금 전체 USD (frcr_ord_psbl_amt1) 저장
          `INSERT INTO overseas_state (key, value, updated_at)
           VALUES ('cash_live_usd', $1, NOW()), ('cash_max_usd', $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [String(usdVal), String(maxUsdVal)],
        )
        .catch(() => {});
    }

    // 통합증거금 전체 계좌 가치 저장 (해외/국내 비중 동적 할당용)
    // 3차 폴백에서 이미 getAccountBalance(true) 호출했으면 재사용 (API 중복 방지)
    try {
      const bal = kisKrw !== null && (buyable != null)
        ? await getAccountBalance(true) // 캐시 히트 확률 높음 (30초 이내)
        : null; // psamount 성공 시 별도 조회 불필요할 수 있으나, total_account_krw는 항상 필요
      const balForTotal = bal ?? await getAccountBalance(true);
      const nass = balForTotal.netAsset ?? 0;
      const domEval = balForTotal.totalEvalAmount ?? 0;
      const totalAccountKrw = Math.max(nass, (balForTotal.orderableCash ?? 0) + domEval);
      if (totalAccountKrw > 0) {
        await getPool()
          .query(
            `INSERT INTO overseas_state (key, value, updated_at) VALUES ('total_account_krw', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [String(totalAccountKrw)],
          )
          .catch(() => {});
      }
    } catch (e) {
      logger.warn(`통합증거금 폴백: 국내 잔고 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
    }

    const diff = Math.abs(kisKrw - dbKrw);
    // ₩5,000 이상 또는 1% 이상 차이 시 보정
    if (diff < 5000 || (dbKrw > 0 && diff / dbKrw < 0.01)) return;

    const fxRate = await fetchExchangeRate();
    const dbUsd = fxRate > 0 ? dbKrw / fxRate : 0;
    const kisUsdDisp = fxRate > 0 ? kisKrw / fxRate : 0;
    logger.warn(
      `💰 Cash 정합: DB=₩${dbKrw.toFixed(0)}($${dbUsd.toFixed(0)}) → KIS=₩${kisKrw.toFixed(0)}($${kisUsdDisp.toFixed(0)})`,
      { component: 'OVERSEAS' },
    );
    await setCash(kisKrw, false);
    if (diff >= 50_000) {
      sendTelegramMessage(
        `💰 현금 정합성 보정\nDB: ₩${dbKrw.toLocaleString()} → KIS: ₩${kisKrw.toLocaleString()}\n차이: ₩${(kisKrw - dbKrw).toLocaleString()}`,
      ).catch(() => {});
    }
  } catch (e) {
    logger.warn(`Cash 정합 체크 실패 (무시): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}
