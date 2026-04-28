import { getPool, logSystem } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 💸 자동 수익 인출 (Profit Harvesting)
 *
 * CEO 설정에 따라 수익률이 목표에 도달하면:
 * 1. 수익분의 일정 비율을 "인출 예약금"으로 잠금
 * 2. 해당 금액은 재투자에 사용되지 않음
 * 3. CEO가 실제 증권사 앱에서 인출
 *
 * 실행 시점: 장 마감 후 15:50 (일간) 또는 금요일 (주간)
 */

interface WithdrawConfig {
  id: string;
  is_active: boolean;
  target_profit_pct: number;
  withdraw_ratio_pct: number;
  min_withdraw_amount: number;
  check_frequency: string;
}

export async function getWithdrawConfig(): Promise<WithdrawConfig | null> {
  try {
    const { rows } = await getPool().query('SELECT * FROM profit_withdraw_config LIMIT 1');
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getWithdrawals(): Promise<any[]> {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM profit_withdrawals ORDER BY created_at DESC LIMIT 50',
    );
    return rows;
  } catch {
    return [];
  }
}

export async function getTotalReserved(): Promise<number> {
  try {
    const { rows } = await getPool().query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM profit_withdrawals WHERE status = 'reserved'",
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 수익 인출 체크 & 실행
 * - 총 자산 대비 원금 기준 수익률 계산
 * - 목표 도달 시 수익분 × 인출비율 만큼 예약
 */
export async function checkAndReserveProfit(): Promise<void> {
  const config = await getWithdrawConfig();
  if (!config?.is_active) return;

  try {
    const balance = await getAccountBalance();
    const totalValue = balance.totalDeposit + (balance.totalEvalAmount ?? 0);

    // 실현 손익 기준으로 계산 (미실현 제외 — 아직 팔지 않은 주식의 수익은 확정이 아님)
    // DB에서 체인 실현손익 합산
    let realizedPnl = 0;
    try {
      const { rows } = await getPool().query(
        `SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS total FROM transaction_chains WHERE status = 'CLOSED'`,
      );
      realizedPnl = Number(rows[0]?.total ?? 0);
    } catch {
      // 실현손익 조회 실패 시 미실현 사용 (안전 fallback)
      realizedPnl = balance.totalProfitLoss ?? 0;
    }

    // 이미 예약된 금액 조회
    const reserved = await getTotalReserved();

    // 예약금 제외 순 실현수익
    const netProfit = realizedPnl - reserved;
    if (netProfit <= 0) return;

    // 원금 추정
    const principal = totalValue - (balance.totalProfitLoss ?? 0);
    if (principal <= 0) return;

    const currentProfitPct = (netProfit / principal) * 100;

    logger.info(
      `수익 인출 체크: 수익률 ${currentProfitPct.toFixed(1)}% (목표 ${config.target_profit_pct}%), 순수익 ${netProfit.toLocaleString()}원, 기예약 ${reserved.toLocaleString()}원`,
      { component: 'PROFIT_WITHDRAW' },
    );

    if (currentProfitPct < config.target_profit_pct) return;

    // 인출 금액 계산
    const withdrawAmount = Math.floor(netProfit * (config.withdraw_ratio_pct / 100));
    if (withdrawAmount < config.min_withdraw_amount) {
      logger.info(`인출 금액 ${withdrawAmount.toLocaleString()}원 < 최소 ${config.min_withdraw_amount.toLocaleString()}원 → 스킵`, {
        component: 'PROFIT_WITHDRAW',
      });
      return;
    }

    // 인출 예약 등록
    await getPool().query(
      `INSERT INTO profit_withdrawals (amount, profit_pct_at_trigger, total_value_at_trigger, status, memo)
       VALUES ($1, $2, $3, 'reserved', $4)`,
      [
        withdrawAmount,
        currentProfitPct,
        totalValue,
        `수익률 ${currentProfitPct.toFixed(1)}% 도달 → ${config.withdraw_ratio_pct}% 인출 예약`,
      ],
    );

    await logSystem(
      'INFO',
      'PROFIT_WITHDRAW',
      `💰 수익 인출 예약: ${withdrawAmount.toLocaleString()}원 (수익률 ${currentProfitPct.toFixed(1)}%)`,
    );

    // Telegram 알림
    await sendTelegramMessage(
      `💰 *수익 인출 예약 완료*\n\n` +
      `수익률: ${currentProfitPct.toFixed(1)}% (목표 ${config.target_profit_pct}%)\n` +
      `인출 예약: ${withdrawAmount.toLocaleString()}원\n` +
      `누적 예약: ${(reserved + withdrawAmount).toLocaleString()}원\n\n` +
      `증권사 앱에서 인출해 주세요.`,
    ).catch(() => {});

    logger.info(`✅ 수익 인출 예약 완료: ${withdrawAmount.toLocaleString()}원`, {
      component: 'PROFIT_WITHDRAW',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`수익 인출 실패: ${msg}`, { component: 'PROFIT_WITHDRAW' });
  }
}

/**
 * 🍚 저녁 용돈 자동 적립
 *
 * 퇴근 후(18시 이후) 매일 1만원씩, 월 최대 30만원까지
 * 수익금에서만 — 원금은 절대 건드리지 않음
 *
 * 조건:
 *   1. 오늘 실현손익 합계 ≥ 10,000원
 *   2. 오늘 아직 용돈 적립 안 함
 *   3. 이번달 누적 용돈 < 300,000원
 */
export async function checkDinnerMoneyWithdraw(): Promise<void> {
  const DAILY_AMOUNT = 10_000;   // 1만원/일
  const MONTHLY_CAP = 300_000;  // 30만원/월

  try {
    const pool = getPool();

    // 이번 달 용돈 누적
    const { rows: monthRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total
      FROM profit_withdrawals
      WHERE memo LIKE 'dinner_money%'
        AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
    `);
    const monthlyTotal = Number(monthRows[0]?.total ?? 0);
    if (monthlyTotal >= MONTHLY_CAP) {
      logger.info(`🍚 저녁용돈 월 한도 도달 (${monthlyTotal.toLocaleString()}원/${MONTHLY_CAP.toLocaleString()}원) — 스킵`, {
        component: 'PROFIT_WITHDRAW',
      });
      return;
    }

    // 오늘 이미 적립했는지 확인 (KST 기준 오늘)
    const { rows: todayRows } = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM profit_withdrawals
      WHERE memo LIKE 'dinner_money%'
        AND created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul')
    `);
    if (Number(todayRows[0]?.cnt ?? 0) > 0) {
      logger.info('🍚 저녁용돈 오늘 이미 적립됨 — 스킵', { component: 'PROFIT_WITHDRAW' });
      return;
    }

    // 오늘 실현손익 (국내 KRW 기준)
    const { rows: pnlRows } = await pool.query(`
      SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS today_pnl
      FROM transaction_chains
      WHERE status = 'CLOSED'
        AND stock_code ~ '^[0-9]{6}$'
        AND closed_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul')
    `);
    const todayPnl = Number(pnlRows[0]?.today_pnl ?? 0);

    if (todayPnl < DAILY_AMOUNT) {
      logger.info(`🍚 저녁용돈: 오늘 실현수익 ${todayPnl.toLocaleString()}원 < ${DAILY_AMOUNT.toLocaleString()}원 — 스킵`, {
        component: 'PROFIT_WITHDRAW',
      });
      return;
    }

    const remaining = MONTHLY_CAP - monthlyTotal;
    const amount = Math.min(DAILY_AMOUNT, remaining);

    await pool.query(
      `INSERT INTO profit_withdrawals (amount, profit_pct_at_trigger, total_value_at_trigger, status, memo)
       VALUES ($1, 0, $2, 'reserved', $3)`,
      [amount, todayPnl, `dinner_money: 오늘수익 ${todayPnl.toLocaleString()}원 → 저녁용돈 ${amount.toLocaleString()}원 적립`],
    );

    const newMonthlyTotal = monthlyTotal + amount;

    await logSystem(
      'INFO',
      'PROFIT_WITHDRAW',
      `🍚 저녁용돈 적립: ${amount.toLocaleString()}원 (이번달 ${newMonthlyTotal.toLocaleString()}/${MONTHLY_CAP.toLocaleString()}원)`,
    );

    await sendTelegramMessage(
      `🍚 *저녁용돈 적립 완료*\n\n` +
      `오늘 수익: ${todayPnl.toLocaleString()}원\n` +
      `적립금액: ${amount.toLocaleString()}원\n` +
      `이번달: ${newMonthlyTotal.toLocaleString()}/${MONTHLY_CAP.toLocaleString()}원\n\n` +
      `증권사 앱에서 인출 가능합니다 🍜`,
    ).catch(() => {});

    logger.info(`✅ 저녁용돈 적립: ${amount.toLocaleString()}원 (이번달 ${newMonthlyTotal.toLocaleString()}원)`, {
      component: 'PROFIT_WITHDRAW',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`저녁용돈 적립 실패: ${msg}`, { component: 'PROFIT_WITHDRAW' });
  }
}

/** 이번달 저녁용돈 적립 현황 조회 */
export async function getDinnerMoneyStats(): Promise<{ monthlyTotal: number; monthlyCap: number; todayReserved: boolean }> {
  try {
    const pool = getPool();
    const [monthRows, todayRows] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(amount), 0)::numeric AS total
        FROM profit_withdrawals
        WHERE memo LIKE 'dinner_money%'
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')
      `),
      pool.query(`
        SELECT COUNT(*) AS cnt
        FROM profit_withdrawals
        WHERE memo LIKE 'dinner_money%'
          AND created_at AT TIME ZONE 'Asia/Seoul' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul')
      `),
    ]);
    return {
      monthlyTotal: Number(monthRows.rows[0]?.total ?? 0),
      monthlyCap: 300_000,
      todayReserved: Number(todayRows.rows[0]?.cnt ?? 0) > 0,
    };
  } catch {
    return { monthlyTotal: 0, monthlyCap: 300_000, todayReserved: false };
  }
}
