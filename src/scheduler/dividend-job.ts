/**
 * 배당 자동화 스케줄러 잡
 * - 배당금 수령 자동 동기화 (KIS API → DB)
 * - 배석일 모니터링 → Telegram 경보
 * - 보유종목 배당 누적 업데이트
 * 기능 플래그: dividend_investing (OFF by default)
 * 스케줄: 16:00 KST 매일 (장 마감 후)
 */

import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { setOverseasState } from './overseas/utils.js';

const COMP = 'DIVIDEND';

async function isDividendEnabled(): Promise<boolean> {
  if (getCtxIsPaper()) return true; // Paper: 항상 실행 (트랙레코드 축적)
  try {
    const { rows } = await getPool().query("SELECT enabled FROM feature_flags WHERE key = 'dividend_investing'");
    return rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

export async function runDividendJob(): Promise<void> {
  if (!(await isDividendEnabled())) return;

  logger.info('💰 배당 자동화 잡 시작', { component: COMP });

  await syncDividendReceipts();
  await monitorExDates();
  await updateHoldingDividendTotals();
  await simulateDRIP();
  await tuneDividendAllocation();

  logger.info('💰 배당 자동화 잡 완료', { component: COMP });
}

/** KIS 배당금 수령내역 자동 동기화 (중복 방지: ON CONFLICT DO NOTHING) */
async function syncDividendReceipts(): Promise<void> {
  try {
    const { getDividendReceipts } = await import('../kis/dividend.js');
    const receipts = await getDividendReceipts({
      startDate: getDateNDaysAgo(30),
    });
    if (receipts.length === 0) return;

    let synced = 0;
    for (const r of receipts) {
      const { rowCount } = await getPool().query(
        `INSERT INTO dividend_history (stock_code, gross_amount_usd, tax_amount_usd, net_amount_usd, currency, pay_date, is_paper)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (stock_code, pay_date, is_paper) WHERE pay_date IS NOT NULL DO NOTHING`,
        [r.stockCode, r.amount, r.tax, r.netAmount, r.currency, r.date || null],
      );
      if ((rowCount ?? 0) > 0) synced++;
    }
    if (synced > 0) {
      logger.info(`배당 동기화: ${synced}건 신규 수령`, { component: COMP });
      await sendTelegramMessage(`💰 배당금 ${synced}건 자동 동기화 완료`).catch(() => {});
    }
  } catch (e: any) {
    logger.warn(`배당 동기화 실패: ${e.message}`, { component: COMP });
  }
}

/** 보유 배당주의 배당일(ex-date) 모니터링 → 3일 전 Telegram 경보 */
async function monitorExDates(): Promise<void> {
  try {
    const { getDividendSchedule } = await import('../kis/dividend.js');
    const isPaper = getCtxIsPaper();
    const { rows: holdings } = await getPool().query(
      'SELECT stock_code, exchange, quantity FROM dividend_holdings WHERE quantity > 0 AND is_paper = $1',
      [isPaper],
    );
    if (holdings.length === 0) return;

    const alerts: string[] = [];
    for (const h of holdings) {
      try {
        const events = await getDividendSchedule({ stockCode: h.stock_code });
        for (const ev of events) {
          const daysUntilEx = daysBetween(getKSTNow(), parseDate(ev.exDate));
          if (daysUntilEx >= 0 && daysUntilEx <= 3) {
            alerts.push(
              `📅 ${h.stock_code}: 배석일 ${ev.exDate} (${daysUntilEx}일 후) — $${ev.dividendPerShare}/주 × ${h.quantity}주`,
            );
          }
        }
      } catch {
        /* 개별 종목 실패 시 스킵 */
      }
    }
    if (alerts.length > 0) {
      await sendTelegramMessage(`💰 *배석일 경보*\n${alerts.join('\n')}`).catch(() => {});
      logger.info(`배석일 경보: ${alerts.length}건`, { component: COMP });
    }
  } catch (e: any) {
    logger.warn(`배석일 모니터링 실패: ${e.message}`, { component: COMP });
  }
}

/** dividend_history → dividend_holdings.total_dividends_received 누적 동기화 */
async function updateHoldingDividendTotals(): Promise<void> {
  const isPaper = getCtxIsPaper();
  try {
    await getPool().query(
      `
      UPDATE dividend_holdings dh
      SET total_dividends_received = sub.total
      FROM (
        SELECT stock_code, exchange, COALESCE(SUM(net_amount_usd), 0) AS total
        FROM dividend_history GROUP BY stock_code, exchange
      ) sub
      WHERE dh.stock_code = sub.stock_code
        AND dh.exchange = sub.exchange
        AND dh.is_paper = $1
    `,
      [isPaper],
    );
  } catch (e: any) {
    logger.warn(`배당 누적 업데이트 실패: ${e.message}`, { component: COMP });
  }
}

/** 매월 1일: 배당 DRIP — 누적 배당금으로 자동 재매수 (paper/live 모드별 실행) */
async function simulateDRIP(): Promise<void> {
  const today = getKSTNow();
  if (today.getDate() !== 1) return; // 매월 1일만 실행
  const isPaper = getCtxIsPaper();

  try {
    const { rows: holdings } = await getPool().query(
      `SELECT dh.stock_code, dh.exchange, dh.quantity, dh.avg_price, dw.dividend_yield
       FROM dividend_holdings dh
       LEFT JOIN dividend_watchlist dw ON dh.stock_code = dw.stock_code AND dh.exchange = dw.exchange
       WHERE dh.is_paper = $1 AND dh.quantity > 0 AND COALESCE(dw.dividend_yield, 0) > 0`,
      [isPaper],
    );
    if (holdings.length === 0) return;

    let totalDrip = 0;
    for (const h of holdings) {
      const qty = Number(h.quantity);
      const price = Number(h.avg_price);
      const yieldPct = Number(h.dividend_yield) / 100;
      // 월 배당 (세후 15.4%)
      const monthlyDiv = (qty * price * yieldPct * 0.846) / 12;
      if (monthlyDiv < 0.01) continue;

      // 배당금 지급 기록
      await getPool().query(
        `INSERT INTO dividend_history (stock_code, exchange, quantity, dividend_per_share, gross_amount_usd, tax_amount_usd, net_amount_usd, pay_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          h.stock_code,
          h.exchange,
          qty,
          +((yieldPct * price) / 12).toFixed(4),
          +(monthlyDiv / 0.846).toFixed(2),
          +((monthlyDiv / 0.846) * 0.154).toFixed(2),
          +monthlyDiv.toFixed(2),
          today.toISOString().slice(0, 10),
        ],
      );

      // DRIP: 배당금으로 재매수 (live: 실제 KIS 주문)
      const newShares = Math.floor(monthlyDiv / price);
      if (newShares > 0) {
        if (!isPaper) {
          try {
            const { placeOverseasOrder } = await import('../kis/overseas.js');
            await placeOverseasOrder({
              stockCode: h.stock_code,
              exchange: h.exchange,
              side: 'BUY',
              quantity: newShares,
            });
          } catch (e: any) {
            logger.warn(`[DRIP] ${h.stock_code} 실주문 실패: ${e.message}`, { component: COMP });
          }
        }
        await getPool().query(
          `UPDATE dividend_holdings SET quantity = quantity + $1, total_dividends_received = total_dividends_received + $2
           WHERE stock_code = $3 AND exchange = $4 AND is_paper = $5`,
          [newShares, +monthlyDiv.toFixed(2), h.stock_code, h.exchange, isPaper],
        );
        totalDrip += newShares;
      } else {
        await getPool().query(
          `UPDATE dividend_holdings SET total_dividends_received = total_dividends_received + $1
           WHERE stock_code = $2 AND exchange = $3 AND is_paper = $4`,
          [+monthlyDiv.toFixed(2), h.stock_code, h.exchange, isPaper],
        );
      }
    }

    if (totalDrip > 0) {
      logger.info(`[DRIP] ${totalDrip}주 자동 재투자 완료`, { component: COMP });
      await sendTelegramMessage(`💰 [DRIP] 배당금 자동 재투자: ${totalDrip}주 추가 매수`).catch(() => {});
    }
  } catch (e: any) {
    logger.warn(`DRIP 시뮬레이션 실패: ${e.message}`, { component: COMP });
  }
}

// ── 유틸 ──
function getDateNDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function parseDate(s: string): Date {
  if (s.length === 8) return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  return new Date(s);
}

/**
 * 배당 배분 자동 튜닝 — 실제 수익률 기반 ETF 비중 조정
 * 고성과 ETF 비중 UP, 저성과 DOWN (최소 5%, 최대 40%)
 */
async function tuneDividendAllocation(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const key = `dividend_alloc_tuned_${isPaper ? 'paper' : 'live'}`;
  try {
    const { rows: holdings } = await getPool().query(
      `SELECT dh.stock_code, dh.quantity, dh.avg_price, dh.total_dividends_received,
              dw.dividend_yield
       FROM dividend_holdings dh
       LEFT JOIN dividend_watchlist dw ON dh.stock_code = dw.stock_code
       WHERE dh.is_paper = $1 AND dh.quantity > 0`,
      [isPaper],
    );
    if (holdings.length < 2) return; // 2종목 미만 시 튜닝 불필요

    // 종목별 성과 점수: 배당수익률(2배 가중) + 배당금 누적 기여도
    const scores: Record<string, number> = {};
    let _totalValue = 0;
    for (const h of holdings) {
      const value = Number(h.quantity) * Number(h.avg_price);
      const divYield = Number(h.dividend_yield ?? 0);
      const divReceived = Number(h.total_dividends_received ?? 0);
      const divContribution = value > 0 ? (divReceived / value) * 100 : 0;
      scores[h.stock_code] = divYield * 2 + divContribution; // 수익률 2배 가중 → 고배당 집중
      _totalValue += value;
    }

    // 점수 → 비중 (정규화, 최소 5% 최대 35%)
    const totalScore = Object.values(scores).reduce((s, v) => s + v, 0);
    if (totalScore <= 0) return;

    const weights: Record<string, number> = {};
    for (const [code, score] of Object.entries(scores)) {
      const raw = score / totalScore;
      weights[code] = Math.min(0.35, Math.max(0.05, raw));
    }
    // 재정규화 (합계 = 1)
    const sum = Object.values(weights).reduce((s, v) => s + v, 0);
    for (const code of Object.keys(weights)) {
      weights[code] = +(weights[code] / sum).toFixed(3);
    }

    await setOverseasState(
      key,
      JSON.stringify({
        weights,
        updatedAt: new Date().toISOString(),
        holdingsCount: holdings.length,
      }),
    );
    logger.info(
      `[배당 튜닝] 비중 조정: ${Object.entries(weights)
        .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
        .join(' ')}`,
      { component: COMP },
    );
  } catch (e: any) {
    logger.warn(`배당 배분 튜닝 실패: ${e.message}`, { component: COMP });
  }
}
