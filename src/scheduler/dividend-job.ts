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
  await checkTop5Rotation(); // 상위 5개 교체 감지
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

    // 배치 INSERT (N+1 → 1 쿼리)
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let i = 0; i < receipts.length; i++) {
      const r = receipts[i];
      const offset = i * 6;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, false)`);
      values.push(r.stockCode, r.amount, r.tax, r.netAmount, r.currency, r.date || null);
    }
    const { rowCount } = await getPool().query(
      `INSERT INTO dividend_history (stock_code, gross_amount_usd, tax_amount_usd, net_amount_usd, currency, pay_date, is_paper)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (stock_code, pay_date, is_paper) WHERE pay_date IS NOT NULL DO NOTHING`,
      values,
    );
    const synced = rowCount ?? 0;
    if (synced > 0) {
      logger.info(`배당 동기화: ${synced}건 신규 수령`, { component: COMP });
      await sendTelegramMessage(`💰 배당금 ${synced}건 자동 동기화 완료`).catch((e) => logger.debug(`배당 텔레그램 알림 실패: ${e}`, { component: COMP }));
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

/**
 * 상위 5개 교체 감지 — watchlist 순수익률 기준 상위 5개가 바뀌면 알림
 * 순수익률 = (배당수익률 - 운용보수) × (1 - 15.4%)
 * 매매 수수료(~0.25%) 이상이어야 편입 자격
 */
async function checkTop5Rotation(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const TAX_RATE = 0.154;
  const MIN_NET = 0.25; // %

  try {
    const pool = getPool();

    // 현재 보유 종목
    const { rows: holdings } = await pool.query(
      `SELECT stock_code FROM dividend_holdings WHERE is_paper = $1 AND quantity > 0`,
      [isPaper],
    );
    const currentCodes = new Set(holdings.map((h: any) => h.stock_code));
    if (currentCodes.size === 0) return;

    // watchlist에서 순수익률 상위 5개
    const { rows: watchlist } = await pool.query(
      `SELECT stock_code, exchange, COALESCE(dividend_yield, 0) AS yield,
              COALESCE(expense_ratio, 0) AS expense
       FROM dividend_watchlist
       WHERE dividend_yield IS NOT NULL AND dividend_yield > 0
       ORDER BY (dividend_yield - COALESCE(expense_ratio, 0)) * ${1 - TAX_RATE} DESC
       LIMIT 5`,
    );

    const top5Codes = watchlist
      .map((w: any) => ({
        code: w.stock_code as string,
        netYield: (Number(w.yield) - Number(w.expense)) * (1 - TAX_RATE),
      }))
      .filter((e) => e.netYield > MIN_NET);

    // 교체 감지: 상위 5개 중 현재 미보유 종목 = 신규 편입 후보
    const newEntries = top5Codes.filter((e) => !currentCodes.has(e.code));
    // 보유 중이지만 상위 5에서 탈락한 종목 = 퇴출 후보
    const top5Set = new Set(top5Codes.map((e) => e.code));
    const dropCandidates = [...currentCodes].filter((c) => !top5Set.has(c));

    if (newEntries.length > 0 || dropCandidates.length > 0) {
      const lines: string[] = ['📊 *배당 상위5 교체 감지*'];
      if (newEntries.length > 0) {
        lines.push(`편입 후보: ${newEntries.map((e) => `${e.code}(순${e.netYield.toFixed(1)}%)`).join(', ')}`);
      }
      if (dropCandidates.length > 0) {
        lines.push(`퇴출 후보: ${dropCandidates.join(', ')}`);
      }
      lines.push(`현재 상위5: ${top5Codes.map((e) => e.code).join(', ')}`);

      logger.info(lines.join(' | '), { component: COMP });
      await sendTelegramMessage(lines.join('\n')).catch(() => {});
    }
  } catch (e: any) {
    logger.warn(`상위5 교체 감지 실패: ${e.message}`, { component: COMP });
  }
}

/**
 * Smart DRIP v2: 크로스에셋 리밸런싱 DRIP
 * ─────────────────────────────────────────
 * 기존: 같은 ETF에 배당 재투자 → 비중 불균형 심화
 * 혁신: 전체 배당금 풀링 → 가장 비중 낮은 ETF에 집중 투자 → 자연 리밸런싱
 *
 * 매월 1일 실행:
 * 1) 각 ETF 월 배당금 계산 → dividend_history 기록
 * 2) 전체 배당금 합산 (pool)
 * 3) 현재 비중 vs 목표 비중 비교 → 가장 언더웨이트인 ETF 선정
 * 4) 풀링된 배당금으로 해당 ETF 집중 매수
 */
async function simulateDRIP(): Promise<void> {
  const today = getKSTNow();
  if (today.getDate() !== 1) return;
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

    // 1) 각 ETF 월 배당금 계산 + 기록 + 풀링
    let totalDivPool = 0;
    const holdingMap = new Map<string, { exchange: string; price: number; qty: number; value: number }>();

    for (const h of holdings) {
      const qty = Number(h.quantity);
      const price = Number(h.avg_price);
      const yieldPct = Number(h.dividend_yield) / 100;
      const monthlyDiv = (qty * price * yieldPct * 0.846) / 12;
      if (monthlyDiv < 0.01) continue;

      // 배당금 지급 기록
      await getPool().query(
        `INSERT INTO dividend_history (stock_code, exchange, quantity, dividend_per_share, gross_amount_usd, tax_amount_usd, net_amount_usd, pay_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          h.stock_code, h.exchange, qty,
          +((yieldPct * price) / 12).toFixed(4),
          +(monthlyDiv / 0.846).toFixed(2),
          +((monthlyDiv / 0.846) * 0.154).toFixed(2),
          +monthlyDiv.toFixed(2),
          today.toISOString().slice(0, 10),
        ],
      );

      // 누적 배당 업데이트
      await getPool().query(
        `UPDATE dividend_holdings SET total_dividends_received = total_dividends_received + $1
         WHERE stock_code = $2 AND exchange = $3 AND is_paper = $4`,
        [+monthlyDiv.toFixed(2), h.stock_code, h.exchange, isPaper],
      );

      totalDivPool += monthlyDiv;
      holdingMap.set(h.stock_code, { exchange: h.exchange, price, qty, value: qty * price });
    }

    if (totalDivPool < 1) return; // $1 미만이면 스킵

    // 2) 목표 비중 로드 (VIX 동적 or 튜닝된 비중)
    const { getOverseasState } = await import('./overseas/utils.js');
    let targetWeights: Record<string, number> = {};
    try {
      const tunedRaw = await getOverseasState(`dividend_alloc_tuned_${isPaper ? 'paper' : 'live'}`);
      if (tunedRaw) {
        const tuned = JSON.parse(tunedRaw);
        if (tuned.weights) targetWeights = tuned.weights;
      }
    } catch { /* ignore */ }

    // 폴백: 기본 비중
    if (Object.keys(targetWeights).length === 0) {
      targetWeights = {
        JEPQ: 0.25, SPYI: 0.20, SCHD: 0.15, QQQI: 0.15, JEPI: 0.15, O: 0.10,
      };
    }

    // 3) 현재 비중 vs 목표 → 가장 언더웨이트인 ETF 찾기
    const totalValue = Array.from(holdingMap.values()).reduce((s, v) => s + v.value, 0);
    let bestTarget: { code: string; gap: number; exchange: string; price: number } | null = null;

    for (const [code, targetPct] of Object.entries(targetWeights)) {
      const holding = holdingMap.get(code);
      const currentPct = holding && totalValue > 0 ? holding.value / totalValue : 0;
      const gap = targetPct - currentPct; // 양수 = 언더웨이트
      const exchange = holding?.exchange || getExchangeForDrip(code);
      const price = holding?.price || 0;

      if (gap > (bestTarget?.gap ?? -Infinity) && price > 0) {
        bestTarget = { code, gap, exchange, price };
      }
    }

    // 보유하지 않은 ETF 중 목표 비중이 있는 것도 후보
    if (!bestTarget || bestTarget.gap <= 0) {
      for (const [code, targetPct] of Object.entries(targetWeights)) {
        if (!holdingMap.has(code) && targetPct > 0) {
          bestTarget = { code, gap: targetPct, exchange: getExchangeForDrip(code), price: 0 };
          break;
        }
      }
    }

    if (!bestTarget || bestTarget.price <= 0) {
      // 가격 미확인 — 기존 방식 폴백 (가장 큰 포지션에 재투자)
      const largest = Array.from(holdingMap.entries()).sort((a, b) => b[1].value - a[1].value)[0];
      if (largest) bestTarget = { code: largest[0], gap: 0, exchange: largest[1].exchange, price: largest[1].price };
    }

    if (!bestTarget || bestTarget.price <= 0) return;

    // 4) 풀링된 배당금 → 선정 ETF 매수
    const sharesToBuy = Math.floor(totalDivPool / bestTarget.price);
    if (sharesToBuy <= 0) {
      logger.info(`[Smart DRIP] 배당 $${totalDivPool.toFixed(2)} → ${bestTarget.code} 매수 불가 (가격 $${bestTarget.price})`, { component: COMP });
      return;
    }

    if (!isPaper) {
      try {
        const { placeOverseasOrder } = await import('../kis/overseas.js');
        await placeOverseasOrder({
          stockCode: bestTarget.code,
          exchange: bestTarget.exchange,
          side: 'BUY',
          quantity: sharesToBuy,
        });
      } catch (e: any) {
        logger.warn(`[Smart DRIP] ${bestTarget.code} 실주문 실패: ${e.message}`, { component: COMP });
      }
    }

    await getPool().query(
      `INSERT INTO dividend_holdings (stock_code, exchange, quantity, avg_price, total_dividends_received, is_paper)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT (stock_code, exchange, is_paper) DO UPDATE SET
         avg_price = (dividend_holdings.avg_price * dividend_holdings.quantity + $4 * $3) / GREATEST(dividend_holdings.quantity + $3, 1),
         quantity = dividend_holdings.quantity + $3`,
      [bestTarget.code, bestTarget.exchange, sharesToBuy, bestTarget.price, isPaper],
    );

    const gapPct = (bestTarget.gap * 100).toFixed(1);
    logger.info(
      `[Smart DRIP] $${totalDivPool.toFixed(2)} → ${bestTarget.code} ${sharesToBuy}주 (언더웨이트 ${gapPct}%p)`,
      { component: COMP },
    );
    await sendTelegramMessage(
      `💰 [Smart DRIP] 배당 $${totalDivPool.toFixed(2)} → ${bestTarget.code} ${sharesToBuy}주 집중 재투자 (비중 부족 ${gapPct}%p)`,
    ).catch(() => {});
  } catch (e: any) {
    logger.warn(`Smart DRIP 실패: ${e.message}`, { component: COMP });
  }
}

/** DRIP용 거래소 매핑 */
function getExchangeForDrip(code: string): string {
  const map: Record<string, string> = {
    JEPQ: 'NASDAQ', JEPI: 'NYSE', SCHD: 'NYSE', SPYI: 'NYSE',
    QQQI: 'NASDAQ', O: 'NYSE', QYLD: 'NASDAQ', XYLD: 'NYSE',
  };
  return map[code] ?? 'NASDAQ';
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
 * 배당 배분 자동 튜닝 v2 — VIX 레짐 + 실적 기반 하이브리드
 * ──────────────────────────────────────────────────────────
 * 1단계: VIX 레짐별 기본 비중 로드 (CALM/STRESS/CRISIS)
 * 2단계: 실적 점수로 미세 조정 (±5%p)
 * 3단계: 최소 5%, 최대 35% 클램핑 → 정규화
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
    if (holdings.length < 2) return;

    // 1단계: watchlist에서 순수익률 기준 상위 5개 동적 비중
    let regime = 'CALM';
    const baseWeights: Record<string, number> = {};
    {
      const { rows: wl } = await getPool().query(
        `SELECT stock_code, COALESCE(dividend_yield, 0) AS yield, COALESCE(expense_ratio, 0) AS expense
         FROM dividend_watchlist WHERE dividend_yield > 0
         ORDER BY (dividend_yield - COALESCE(expense_ratio, 0)) * 0.846 DESC LIMIT 5`,
      );
      if (wl.length >= 3) {
        const totalNet = wl.reduce((s: number, w: any) => s + (Number(w.yield) - Number(w.expense)) * 0.846, 0);
        for (const w of wl) {
          const net = (Number(w.yield) - Number(w.expense)) * 0.846;
          baseWeights[w.stock_code] = totalNet > 0 ? +(net / totalNet).toFixed(3) : 1 / wl.length;
        }
      } else {
        // 폴백: 기본 6개
        Object.assign(baseWeights, { JEPQ: 0.25, SPYI: 0.20, SCHD: 0.15, QQQI: 0.15, JEPI: 0.15, O: 0.10 });
      }
    }
    try {
      const { getFearGreedIndex } = await import('../market/external-signals.js');
      const fg = await getFearGreedIndex().catch(() => null);
      const vix = fg?.vix ?? 0;
      if (vix > 0) {
        const { getVixRegime } = await import('./overseas/vix-regime.js');
        const vr = getVixRegime(vix, isPaper);
        regime = vr.regime;
        // VIX 레짐별 비중 오버라이드
        const regimeMap: Record<string, Record<string, number>> = {
          CALM: { JEPQ: 0.28, SPYI: 0.15, SCHD: 0.22, QQQI: 0.12, JEPI: 0.13, O: 0.10 },
          STRESS: { JEPQ: 0.22, SPYI: 0.25, SCHD: 0.10, QQQI: 0.20, JEPI: 0.13, O: 0.10 },
          CRISIS: { JEPQ: 0.15, SPYI: 0.15, SCHD: 0.25, QQQI: 0.10, JEPI: 0.15, O: 0.20 },
        };
        if (regimeMap[regime]) Object.assign(baseWeights, regimeMap[regime]);
      }
    } catch { /* VIX 조회 실패 시 기본값 유지 */ }

    // 2단계: 실적 점수로 ±5%p 미세 조정
    const scores: Record<string, number> = {};
    let totalValue = 0;
    for (const h of holdings) {
      const value = Number(h.quantity) * Number(h.avg_price);
      const divYield = Number(h.dividend_yield ?? 0);
      const divReceived = Number(h.total_dividends_received ?? 0);
      const divContribution = value > 0 ? (divReceived / value) * 100 : 0;
      scores[h.stock_code] = divYield * 2 + divContribution;
      totalValue += value;
    }
    const totalScore = Object.values(scores).reduce((s, v) => s + v, 0);

    // 점수 기반 미세 조정 (기본 비중 ±5%p)
    const weights: Record<string, number> = { ...baseWeights };
    if (totalScore > 0) {
      const avgScore = totalScore / Object.keys(scores).length;
      for (const [code, score] of Object.entries(scores)) {
        if (weights[code] != null) {
          const adjustment = ((score - avgScore) / avgScore) * 0.05; // ±5%p
          weights[code] = Math.min(0.35, Math.max(0.05, weights[code] + adjustment));
        }
      }
    }

    // 3단계: 정규화 (합계 = 1)
    const sum = Object.values(weights).reduce((s, v) => s + v, 0);
    for (const code of Object.keys(weights)) {
      weights[code] = +(weights[code] / sum).toFixed(3);
    }

    await setOverseasState(
      key,
      JSON.stringify({
        weights,
        regime,
        updatedAt: new Date().toISOString(),
        holdingsCount: holdings.length,
      }),
    );
    logger.info(
      `[배당 튜닝] VIX=${regime} 비중: ${Object.entries(weights)
        .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
        .join(' ')}`,
      { component: COMP },
    );
  } catch (e: any) {
    logger.warn(`배당 배분 튜닝 실패: ${e.message}`, { component: COMP });
  }
}
