import { getOpenChains, getPool } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { getTotalReserved } from './profit-withdraw.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 일일 자동 리포트 (장 마감 후 15:40 KST 자동 발송)
 *
 * CEO가 묻지 않아도 매일 텔레그램으로:
 * - 오늘 수익/손실 요약
 * - 체결된 매매 건수 + 판단 근거
 * - 보유 종목 현황
 * - AI 성과 추적
 * - 인출 예약금 현황
 * - 주간/월간 누적 수익
 */
export async function generateDailyReport(): Promise<void> {
  try {
    const balance = await getAccountBalance();
    const chains = await getOpenChains();
    const today = new Date().toISOString().split('T')[0];
    const reserved = await getTotalReserved();

    // 오늘 체결된 주문
    const { rows: todayOrders } = await getPool().query(
      'SELECT * FROM orders WHERE created_at >= $1 AND status = $2 ORDER BY created_at ASC',
      [`${today}T00:00:00`, 'FILLED'],
    );

    const buyOrders = todayOrders.filter((o: any) => o.side === 'BUY');
    const sellOrders = todayOrders.filter((o: any) => o.side === 'SELL');

    // 오늘 닫힌 체인 (실현 손익)
    const { rows: closedToday } = await getPool().query(
      'SELECT * FROM transaction_chains WHERE status = $1 AND closed_at >= $2',
      ['CLOSED', `${today}T00:00:00`],
    );
    const realizedPnl = closedToday.reduce((sum: number, c: any) => sum + Number(c.realized_pnl ?? 0), 0);

    // 보유 종목별 수익률
    const positionLines = balance.positions.map((p) => {
      const emoji = p.profitLoss >= 0 ? '🟢' : '🔴';
      return `  ${emoji} ${p.stockName}: ${p.profitLossPct > 0 ? '+' : ''}${p.profitLossPct.toFixed(1)}% (${p.profitLoss.toLocaleString()}원)`;
    });

    // 체인 보유 종목
    const chainLines = chains.map((ch: any) => {
      const pnl = Number(ch.realized_pnl ?? 0);
      const emoji = pnl >= 0 ? '🟡' : '🔴';
      return `  ${emoji} ${ch.stock_code} (${ch.strategy_mode}): ${ch.total_quantity}주 · 평단 ${Number(ch.avg_buy_price).toLocaleString()}원`;
    });

    // 이번 주 성과
    const weekStart = getWeekStart(today);
    const { rows: weekData } = await getPool().query(
      'SELECT realized_pnl FROM transaction_chains WHERE status = $1 AND closed_at >= $2',
      ['CLOSED', `${weekStart}T00:00:00`],
    );
    const weekPnl = weekData.reduce((s: number, c: any) => s + Number(c.realized_pnl ?? 0), 0);
    const weekWins = weekData.filter((c: any) => Number(c.realized_pnl) > 0).length;
    const weekLosses = weekData.filter((c: any) => Number(c.realized_pnl) <= 0).length;

    // 이번 달 성과
    const monthStart = `${today.slice(0, 7)}-01`;
    const { rows: monthData } = await getPool().query(
      'SELECT realized_pnl FROM transaction_chains WHERE status = $1 AND closed_at >= $2',
      ['CLOSED', `${monthStart}T00:00:00`],
    );
    const monthPnl = monthData.reduce((s: number, c: any) => s + Number(c.realized_pnl ?? 0), 0);
    const monthWins = monthData.filter((c: any) => Number(c.realized_pnl) > 0).length;
    const monthLosses = monthData.filter((c: any) => Number(c.realized_pnl) <= 0).length;
    const monthWinRate = monthData.length > 0 ? ((monthWins / monthData.length) * 100).toFixed(0) : '-';

    // 오늘 매매 근거 요약 (최근 3건)
    const reasonLines = todayOrders.slice(-3).map((o: any) => {
      const side = o.side === 'BUY' ? '매수' : '매도';
      const reason = o.ai_reasoning ? o.ai_reasoning.slice(0, 50) : '근거 없음';
      return `  ${side} ${o.stock_code}: ${reason}`;
    });

    const totalValue = balance.totalDeposit + balance.totalEvalAmount;
    const dailyEmoji = balance.totalProfitLoss >= 0 ? '📈' : '📉';

    const report = [
      `📊 *QUANTOPS 일일 리포트*`,
      `━━━━━━━━━━━━━━━━━`,
      `📅 ${today}`,
      ``,
      `💰 *자산 현황*`,
      `  총 자산: *${totalValue.toLocaleString()}원*`,
      `  현금: ${balance.orderableCash.toLocaleString()}원`,
      `  투자금: ${balance.totalEvalAmount.toLocaleString()}원`,
      reserved > 0 ? `  💵 인출 예약금: ${reserved.toLocaleString()}원` : '',
      ``,
      `${dailyEmoji} *오늘 손익*`,
      `  미실현: ${balance.totalProfitLoss >= 0 ? '+' : ''}${balance.totalProfitLoss.toLocaleString()}원`,
      `  실현: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toLocaleString()}원`,
      ``,
      `🤖 *오늘 AI 활동*`,
      `  매수 ${buyOrders.length}건 · 매도 ${sellOrders.length}건 · 청산 ${closedToday.length}건`,
      reasonLines.length > 0 ? `\n📝 *판단 근거 (최근)*\n${reasonLines.join('\n')}` : '',
      ``,
      positionLines.length > 0 || chainLines.length > 0
        ? `📋 *보유 종목 (${positionLines.length + chainLines.length}개)*\n${[...positionLines, ...chainLines].join('\n')}`
        : `📭 보유 종목 없음`,
      ``,
      `📊 *성과 요약*`,
      `  이번 주: ${weekPnl >= 0 ? '+' : ''}${weekPnl.toLocaleString()}원 (${weekWins}승 ${weekLosses}패)`,
      `  이번 달: ${monthPnl >= 0 ? '+' : ''}${monthPnl.toLocaleString()}원 (승률 ${monthWinRate}%, ${monthWins}승 ${monthLosses}패)`,
      `  열린 체인: ${chains.length}개`,
    ].filter(Boolean).join('\n');

    await sendTelegramMessage(report);
    logger.info('📊 일일 리포트 발송 완료', { component: 'REPORT' });
  } catch (error) {
    logger.error(`일일 리포트 생성 실패: ${error}`, { component: 'REPORT' });
  }
}

/** 이번 주 월요일 날짜 */
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}
