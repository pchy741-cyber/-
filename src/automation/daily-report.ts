import { getOpenChains, getPool } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 일일 자동 리포트 (장 마감 후 15:40 KST 자동 발송)
 *
 * CEO가 묻지 않아도 매일 텔레그램으로:
 * - 오늘 수익/손실 요약
 * - 체결된 매매 건수
 * - 보유 종목 현황
 * - AI 성과 추적
 */
export async function generateDailyReport(): Promise<void> {
  try {
    const balance = await getAccountBalance();
    const chains = await getOpenChains();
    const today = new Date().toISOString().split('T')[0];

    // 오늘 체결된 주문 수
    const { rows: todayOrders } = await getPool().query(
      'SELECT * FROM orders WHERE created_at >= $1 ORDER BY created_at ASC',
      [`${today}T00:00:00`],
    );

    const orders = todayOrders;
    const buyOrders = orders.filter((o) => o.side === 'BUY' && o.status === 'FILLED');
    const sellOrders = orders.filter((o) => o.side === 'SELL' && o.status === 'FILLED');

    // 오늘 닫힌 체인 (실현 손익)
    const { rows: closedChains } = await getPool().query(
      'SELECT * FROM transaction_chains WHERE status = $1 AND closed_at >= $2',
      ['CLOSED', `${today}T00:00:00`],
    );

    const realizedPnl = closedChains.reduce((sum: number, c: any) => sum + Number(c.realized_pnl ?? 0), 0);

    // 보유 종목별 수익률
    const positionLines = balance.positions.map((p) => {
      const pnlEmoji = p.profitLoss >= 0 ? '🟢' : '🔴';
      return `${pnlEmoji} ${p.stockName}: ${p.profitLossPct > 0 ? '+' : ''}${p.profitLossPct.toFixed(1)}% (${p.profitLoss.toLocaleString()}원)`;
    });

    // 승률 계산 (이번 달)
    const monthStart = `${today.slice(0, 7)}-01`;
    const { rows: monthData } = await getPool().query(
      'SELECT realized_pnl FROM transaction_chains WHERE status = $1 AND closed_at >= $2',
      ['CLOSED', `${monthStart}T00:00:00`],
    );
    const wins = monthData.filter((c) => Number(c.realized_pnl) > 0).length;
    const losses = monthData.filter((c) => Number(c.realized_pnl) <= 0).length;
    const winRate = monthData.length > 0 ? ((wins / monthData.length) * 100).toFixed(0) : '-';

    const totalValue = balance.totalDeposit + balance.totalEvalAmount;
    const dailyPnlEmoji = balance.totalProfitLoss >= 0 ? '📈' : '📉';

    const report = [
      `📊 *QUANTOPS 일일 리포트*`,
      `${today}`,
      ``,
      `💰 *총 자산: ${totalValue.toLocaleString()}원*`,
      `${dailyPnlEmoji} 오늘 손익: ${balance.totalProfitLoss >= 0 ? '+' : ''}${balance.totalProfitLoss.toLocaleString()}원`,
      `💵 실현 손익: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toLocaleString()}원`,
      ``,
      `🤖 *오늘 로봇 활동*`,
      `  매수: ${buyOrders.length}건`,
      `  매도: ${sellOrders.length}건`,
      `  청산: ${closedChains.length}건`,
      ``,
      positionLines.length > 0
        ? `📋 *보유 종목 (${positionLines.length}개)*\n${positionLines.join('\n')}`
        : `📭 보유 종목 없음`,
      ``,
      `📊 *이달 성과*`,
      `  승률: ${winRate}% (${wins}승 ${losses}패)`,
      `  열린 체인: ${chains.length}개`,
    ].join('\n');

    await sendTelegramMessage(report);

    logger.info('📊 일일 리포트 발송 완료', { component: 'REPORT' });
  } catch (error) {
    logger.error(`일일 리포트 생성 실패: ${error}`, { component: 'REPORT' });
  }
}
