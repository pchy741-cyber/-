import { Telegraf } from 'telegraf';
import { config } from '../config/index.js';
import { getAccountBalance } from '../kis/account.js';
import { deactivateKillSwitchAll, getKillSwitchStatusAll } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { sendSlackMessage } from './slack.js';

let bot: Telegraf | null = null;

export function initTelegram(): void {
  if (!config.telegram.botToken || config.telegram.botToken.startsWith('your_')) {
    logger.info('Telegram 토큰 미설정 → 알림 비활성', { component: 'TELEGRAM' });
    return;
  }
  bot = new Telegraf(config.telegram.botToken);

  // 명령어 인증 헬퍼 — TELEGRAM_CHAT_ID와 정확히 일치하는 사용자만 허용
  const isAuthorized = (ctx: any): boolean => {
    const allowedId = String(config.telegram.chatId ?? '');
    const fromId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? '');
    // 🔒 엄격한 동등 비교 (endsWith 취약점 차단)
    return !!(allowedId && (fromId === allowedId || chatId === allowedId));
  };

  // /status 명령어 — 시스템 상태 확인 (🔒 인증 필수)
  bot.command('status', async (ctx) => {
    if (!isAuthorized(ctx)) {
      logger.warn(`🚨 Telegram /status 미인증 시도: userId=${ctx.from?.id}, chatId=${ctx.chat?.id}`, {
        component: 'TELEGRAM',
      });
      return; // 무응답 (봇 존재 자체를 숨김)
    }
    try {
      const balance = await getAccountBalance();
      const ks = getKillSwitchStatusAll();

      const msg = [
        `🤖 *시스템 상태*`,
        ``,
        `💰 총 자산: ${(balance.totalDeposit + balance.totalEvalAmount).toLocaleString()}원`,
        `💵 예수금: ${balance.orderableCash.toLocaleString()}원`,
        `📈 투자금: ${balance.totalEvalAmount.toLocaleString()}원`,
        `${balance.totalProfitLoss >= 0 ? '🟢' : '🔴'} 손익: ${balance.totalProfitLoss.toLocaleString()}원`,
        ``,
        `🛡️ Kill Switch [국내]: ${ks.kr.active ? '🛑 활성' : '✅ 비활성'}`,
        ks.kr.active ? `  사유: ${ks.kr.reason}` : '',
        `🛡️ Kill Switch [해외]: ${ks.overseas.active ? '🛑 활성' : '✅ 비활성'}`,
        ks.overseas.active ? `  사유: ${ks.overseas.reason}` : '',
        `📊 모드: ${config.tradingMode}`,
        `🔧 보유 종목: ${balance.positions.length}개`,
      ]
        .filter(Boolean)
        .join('\n');

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ 상태 조회 실패: ${err}`);
    }
  });

  // /kill 명령어 — Kill Switch 수동 발동 (인증된 사용자만)
  bot.command('kill', async (ctx) => {
    if (!isAuthorized(ctx)) {
      logger.warn(`Telegram /kill 미인증 시도: userId=${ctx.from?.id}`, { component: 'TELEGRAM' });
      return;
    }
    const { activateKillSwitchAll } = await import('../risk/kill-switch.js');
    await activateKillSwitchAll('CEO 수동 발동 (Telegram)', true);
    await ctx.reply('🛑 Kill Switch 발동 — 국내+해외 모든 매매 즉시 차단');
  });

  // /resume 명령어 — Kill Switch 해제 (인증된 사용자만)
  bot.command('resume', async (ctx) => {
    if (!isAuthorized(ctx)) {
      logger.warn(`Telegram /resume 미인증 시도: userId=${ctx.from?.id}`, { component: 'TELEGRAM' });
      return;
    }
    await deactivateKillSwitchAll(true); // CEO 수동 명령 → 강제 해제
    await ctx.reply('✅ Kill Switch 강제 해제 — 국내+해외 매매 재개');
  });

  // /positions 명령어 — 보유 종목 상세 (🔒 인증 필수)
  bot.command('positions', async (ctx) => {
    if (!isAuthorized(ctx)) {
      logger.warn(`🚨 Telegram /positions 미인증 시도: userId=${ctx.from?.id}, chatId=${ctx.chat?.id}`, {
        component: 'TELEGRAM',
      });
      return;
    }
    try {
      const balance = await getAccountBalance();
      if (balance.positions.length === 0) {
        await ctx.reply('📭 보유 종목 없음');
        return;
      }

      const lines = balance.positions.map((p) => {
        const emoji = p.profitLoss >= 0 ? '🟢' : '🔴';
        return `${emoji} ${p.stockName}(${p.stockCode})\n  ${p.quantity}주 @${p.avgBuyPrice.toLocaleString()} → ${p.currentPrice.toLocaleString()} (${p.profitLossPct > 0 ? '+' : ''}${p.profitLossPct.toFixed(1)}%)`;
      });

      await ctx.reply(`📊 *보유 종목*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ 조회 실패: ${err}`);
    }
  });

  bot
    .launch()
    .then(() => {
      logger.info('📱 Telegram 봇 시작', { component: 'TELEGRAM' });
    })
    .catch((err) => {
      logger.error(`Telegram 봇 시작 실패: ${err}`, { component: 'TELEGRAM' });
      bot = null;
    });

  // Graceful shutdown
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

/**
 * 텔레그램 메시지 전송 (알림용)
 */
export async function sendTelegramMessage(message: string): Promise<void> {
  if (!bot) {
    logger.warn('Telegram 봇 미초기화 — 메시지 스킵', { component: 'TELEGRAM' });
    return;
  }

  try {
    await bot.telegram.sendMessage(config.telegram.chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error(`Telegram 전송 실패: ${error}`, { component: 'TELEGRAM' });
  }
  // Slack 동시 발송 (webhook 미설정 시 자동 스킵)
  const level = /🚨|⛔|❌|🛑/.test(message) ? 'error' : /⚠️/.test(message) ? 'warn' : 'info';
  await sendSlackMessage(message, level).catch(() => {});
}
