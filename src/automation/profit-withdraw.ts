import { getCtxIsPaper } from '../config/context.js';
import { getPool, logSystem } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const DINNER_MONEY_MONTHLY_CAP = 300_000;

/**
 * 🍚 용돈 자동 적립
 *
 * 조건: 오늘 실현손익 ≥ 100,000원
 * 금액: 오늘 실현손익의 10%
 *   예) 20만원 수익 → 2만원 적립
 *
 * 실행: 평일 18:10
 */
export async function checkDinnerMoneyWithdraw(): Promise<void> {
  const MIN_PROFIT = 100_000; // 10만원 이상일 때만 실행
  const RATIO = 0.1; // 10% 이관

  try {
    const pool = getPool();

    // 오늘 이미 적립했는지 확인 (KST 기준)
    const { rows: todayRows } = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM profit_withdrawals
      WHERE memo LIKE 'dinner_money%'
        AND created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul')
    `);
    if (Number(todayRows[0]?.cnt ?? 0) > 0) {
      logger.info('🍚 용돈 오늘 이미 적립됨 — 스킵', { component: 'PROFIT_WITHDRAW' });
      return;
    }

    // 오늘 실현손익 (국내 KRW 기준)
    const { rows: pnlRows } = await pool.query(
      `
      SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS today_pnl
      FROM transaction_chains
      WHERE status = 'CLOSED'
        AND stock_code ~ '^[0-9]{6}$'
        AND closed_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul')
        AND is_paper = $1
    `,
      [getCtxIsPaper()],
    );
    const todayPnl = Number(pnlRows[0]?.today_pnl ?? 0);

    if (todayPnl < MIN_PROFIT) {
      logger.info(`🍚 용돈: 오늘 실현수익 ${todayPnl.toLocaleString()}원 < ${MIN_PROFIT.toLocaleString()}원 — 스킵`, {
        component: 'PROFIT_WITHDRAW',
      });
      return;
    }

    let amount = Math.floor(todayPnl * RATIO);

    // ── 월간 한도 체크: DINNER_MONEY_MONTHLY_CAP 초과 방지 ──
    const { rows: monthlyRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS monthly_total
      FROM profit_withdrawals
      WHERE memo LIKE 'dinner_money%'
        AND created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
    `);
    const monthlyTotal = Number(monthlyRows[0]?.monthly_total ?? 0);
    if (monthlyTotal >= DINNER_MONEY_MONTHLY_CAP) {
      logger.info(
        `🍚 용돈: 이번달 누계 ${monthlyTotal.toLocaleString()}원 >= 월간 한도 ${DINNER_MONEY_MONTHLY_CAP.toLocaleString()}원 — 스킵`,
        { component: 'PROFIT_WITHDRAW' },
      );
      return;
    }
    // 월간 한도 초과분 절삭
    const remaining = DINNER_MONEY_MONTHLY_CAP - monthlyTotal;
    if (amount > remaining) {
      logger.info(
        `🍚 용돈: 한도 잔여 ${remaining.toLocaleString()}원 — ${amount.toLocaleString()}원 → ${remaining.toLocaleString()}원 절삭`,
        { component: 'PROFIT_WITHDRAW' },
      );
      amount = remaining;
    }

    await pool.query(
      `INSERT INTO profit_withdrawals (amount, profit_pct_at_trigger, total_value_at_trigger, status, memo)
       VALUES ($1, 0, $2, 'reserved', $3)`,
      [
        amount,
        todayPnl,
        `dinner_money: 오늘수익 ${todayPnl.toLocaleString()}원 × 10% = ${amount.toLocaleString()}원 내계좌 이관`,
      ],
    );

    await logSystem(
      'INFO',
      'PROFIT_WITHDRAW',
      `🍚 용돈 적립: ${amount.toLocaleString()}원 (오늘수익 ${todayPnl.toLocaleString()}원 × 10%)`,
    );

    await sendTelegramMessage(
      `🍚 *용돈 이관 완료*\n\n` +
        `오늘 수익: ${todayPnl.toLocaleString()}원\n` +
        `이관 금액: *${amount.toLocaleString()}원* (10%)\n\n` +
        `증권사 앱에서 출금 가능합니다 💰`,
    ).catch(() => {});

    logger.info(`✅ 용돈 적립: ${amount.toLocaleString()}원 (오늘수익 ${todayPnl.toLocaleString()}원)`, {
      component: 'PROFIT_WITHDRAW',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`용돈 적립 실패: ${msg}`, { component: 'PROFIT_WITHDRAW' });
  }
}

/** 용돈 적립 현황 조회 (오늘 여부 + 이번달 누계) */
export async function getDinnerMoneyStats(): Promise<{
  todayReserved: boolean;
  todayAmount: number;
  monthlyTotal: number;
  monthlyCap: number;
}> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount), 0)::numeric AS monthly_total,
        COALESCE(SUM(CASE WHEN created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul') THEN amount ELSE 0 END), 0)::numeric AS today_total,
        COUNT(CASE WHEN created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul') THEN 1 END) AS today_cnt
      FROM profit_withdrawals
      WHERE memo LIKE 'dinner_money%'
        AND created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
    `);
    return {
      todayReserved: Number(rows[0]?.today_cnt ?? 0) > 0,
      todayAmount: Number(rows[0]?.today_total ?? 0),
      monthlyTotal: Number(rows[0]?.monthly_total ?? 0),
      monthlyCap: DINNER_MONEY_MONTHLY_CAP,
    };
  } catch (err) {
    logger.debug(`용돈 현황 조회 실패: ${err}`, { component: 'PROFIT_WITHDRAW' });
    return { todayReserved: false, todayAmount: 0, monthlyTotal: 0, monthlyCap: DINNER_MONEY_MONTHLY_CAP };
  }
}
