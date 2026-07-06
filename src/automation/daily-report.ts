import { getCtxIsPaper } from '../config/context.js';
import { getOpenChains, getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { callClaudeCli, isClaudeCliEnabled } from '../utils/claude-cli.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { getDinnerMoneyStats } from './profit-withdraw.js';

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
    const { fetchBalance } = await import('../risk/account-balance.js');
    const isPaper = getCtxIsPaper();
    const balance = await fetchBalance(isPaper);
    const chains = await getOpenChains(isPaper);
    const today = getKSTNow().toISOString().split('T')[0];
    const { todayAmount: reserved } = await getDinnerMoneyStats();
    const weekStart = getWeekStart(today);
    const monthStart = `${today.slice(0, 7)}-01`;

    const [{ rows: todayOrders }, { rows: closedToday }, { rows: weekData }, { rows: monthData }] = await Promise.all([
      getPool().query(
        `SELECT * FROM orders WHERE created_at >= $1 AND status = $2 AND is_paper = $3 AND (trading_mode = $4::text OR ($4::text = 'paper' AND trading_mode = 'p_arch')) ORDER BY created_at ASC`,
        [`${today}T00:00:00+09:00`, 'FILLED', isPaper, isPaper ? 'paper' : 'live'],
      ),
      getPool().query(
        'SELECT * FROM transaction_chains WHERE status = $1 AND closed_at >= $2 AND is_paper = $3',
        ['CLOSED', `${today}T00:00:00+09:00`, isPaper],
      ),
      getPool().query(
        'SELECT realized_pnl FROM transaction_chains WHERE status = $1 AND closed_at >= $2 AND is_paper = $3',
        ['CLOSED', `${weekStart}T00:00:00+09:00`, isPaper],
      ),
      getPool().query(
        'SELECT realized_pnl FROM transaction_chains WHERE status = $1 AND closed_at >= $2 AND is_paper = $3',
        ['CLOSED', `${monthStart}T00:00:00+09:00`, isPaper],
      ),
    ]);

    const buyOrders = todayOrders.filter((o: Record<string, unknown>) => o.side === 'BUY');
    const sellOrders = todayOrders.filter((o: Record<string, unknown>) => o.side === 'SELL');
    const realizedPnl = closedToday.reduce((sum: number, c: Record<string, unknown>) => sum + Number(c.realized_pnl ?? 0), 0);

    // 보유 종목별 수익률
    const positionLines = balance.positions.map((p) => {
      const emoji = p.profitLoss >= 0 ? '🟢' : '🔴';
      return `  ${emoji} ${p.stockName}: ${p.profitLossPct > 0 ? '+' : ''}${p.profitLossPct.toFixed(1)}% (${p.profitLoss.toLocaleString()}원)`;
    });

    // 체인 보유 종목
    const chainLines = chains.map((ch: Record<string, unknown>) => {
      const pnl = Number(ch.realized_pnl ?? 0);
      const emoji = pnl >= 0 ? '🟡' : '🔴';
      return `  ${emoji} ${ch.stock_code} (${ch.strategy_mode}): ${ch.total_quantity}주 · 평단 ${Number(ch.avg_buy_price).toLocaleString()}원`;
    });

    // 이번 주 성과
    const weekPnl = weekData.reduce((s: number, c: Record<string, unknown>) => s + Number(c.realized_pnl ?? 0), 0);
    const weekWins = weekData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) > 0).length;
    const weekLosses = weekData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) <= 0).length;

    // 이번 달 성과
    const monthPnl = monthData.reduce((s: number, c: Record<string, unknown>) => s + Number(c.realized_pnl ?? 0), 0);
    const monthWins = monthData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) > 0).length;
    const monthLosses = monthData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) <= 0).length;
    const monthWinRate = monthData.length > 0 ? ((monthWins / monthData.length) * 100).toFixed(0) : '-';

    // 오늘 매매 근거 요약 (최근 3건)
    const reasonLines = todayOrders.slice(-3).map((o: Record<string, unknown>) => {
      const side = o.side === 'BUY' ? '매수' : '매도';
      const reason = o.ai_reasoning ? String(o.ai_reasoning).slice(0, 50) : '근거 없음';
      return `  ${side} ${o.stock_code}: ${reason}`;
    });

    const totalValue = balance.orderableCash + balance.totalEvalAmount;
    // Paper 모드: totalProfitLoss는 누적 실현PnL → 미실현은 포지션에서 직접 계산
    const unrealizedPnl = balance.positions.reduce((sum, p) => sum + p.profitLoss, 0);
    const dailyEmoji = unrealizedPnl >= 0 ? '📈' : '📉';

    const report = [
      `📊 *일일 리포트* [${getCtxIsPaper() ? '연습' : '실전'}]`,
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
      `  미실현: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toLocaleString()}원`,
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
    ]
      .filter(Boolean)
      .join('\n');

    // Claude 자연어 분석 추가 (CLI 활성 시)
    let claudeAnalysis = '';
    if (isClaudeCliEnabled() && (buyOrders.length > 0 || sellOrders.length > 0 || closedToday.length > 0)) {
      try {
        claudeAnalysis = await generateClaudeAnalysis({
          totalValue,
          cash: balance.orderableCash,
          realizedPnl,
          unrealizedPnl,
          buyCount: buyOrders.length,
          sellCount: sellOrders.length,
          closedCount: closedToday.length,
          weekPnl,
          weekWinRate: weekData.length > 0 ? ((weekWins / weekData.length) * 100) : 0,
          monthPnl,
          monthWinRate: monthData.length > 0 ? ((monthWins / monthData.length) * 100) : 0,
          positions: balance.positions.map((p) => `${p.stockName} ${p.profitLossPct > 0 ? '+' : ''}${p.profitLossPct.toFixed(1)}%`),
          reasons: todayOrders.slice(-5).map((o: Record<string, unknown>) =>
            `${o.side === 'BUY' ? '매수' : '매도'} ${o.stock_code}: ${String(o.ai_reasoning ?? '').slice(0, 80)}`
          ),
        });
      } catch (e) {
        logger.warn(`Claude 리포트 분석 실패: ${e}`, { component: 'REPORT' });
      }
    }

    const finalReport = claudeAnalysis
      ? `${report}\n\n🤖 *Claude AI 분석*\n${claudeAnalysis}`
      : report;

    await sendTelegramMessage(finalReport).catch(() => {});
    logger.info('📊 일일 리포트 발송 완료' + (claudeAnalysis ? ' (Claude 분석 포함)' : ''), { component: 'REPORT' });
  } catch (error) {
    logger.error(`일일 리포트 생성 실패: ${error}`, { component: 'REPORT' });
  }
}

/** Claude CLI 기반 일일 매매 분석 — 자연어 해석 + 내일 액션 아이템 */
async function generateClaudeAnalysis(data: {
  totalValue: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  buyCount: number;
  sellCount: number;
  closedCount: number;
  weekPnl: number;
  weekWinRate: number;
  monthPnl: number;
  monthWinRate: number;
  positions: string[];
  reasons: string[];
}): Promise<string> {
  const systemPrompt = `당신은 주식 포트폴리오 매니저입니다. 오늘 매매 결과를 간결하게 분석하고, 내일 전략을 제안하세요.
- 3~5줄 이내로 핵심만
- 감정 없이 객관적으로
- 구체적 액션 아이템 1~2개`;

  const userPrompt = `오늘 매매 결과:
- 총자산: ${data.totalValue.toLocaleString()}원 (현금: ${data.cash.toLocaleString()}원)
- 실현손익: ${data.realizedPnl >= 0 ? '+' : ''}${data.realizedPnl.toLocaleString()}원
- 미실현: ${data.unrealizedPnl >= 0 ? '+' : ''}${data.unrealizedPnl.toLocaleString()}원
- 활동: 매수 ${data.buyCount}건, 매도 ${data.sellCount}건, 청산 ${data.closedCount}건
- 주간: ${data.weekPnl >= 0 ? '+' : ''}${data.weekPnl.toLocaleString()}원 (승률 ${data.weekWinRate.toFixed(0)}%)
- 월간: ${data.monthPnl >= 0 ? '+' : ''}${data.monthPnl.toLocaleString()}원 (승률 ${data.monthWinRate.toFixed(0)}%)
${data.positions.length > 0 ? `- 보유: ${data.positions.join(', ')}` : '- 보유 종목 없음'}
${data.reasons.length > 0 ? `- 최근 판단: ${data.reasons.join(' | ')}` : ''}

간결한 분석 + 내일 액션 아이템:`;

  const text = await callClaudeCli({ systemPrompt, userPrompt, model: 'haiku', timeoutMs: 30_000 });
  // 텔레그램 메시지 길이 제한
  return text.slice(0, 500);
}

/** 이번 주 월요일 날짜 (UTC 안전 — getDay()→getUTCDay() 타임존 버그 수정) */
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return d.toISOString().split('T')[0];
}
