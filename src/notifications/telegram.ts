import { Telegraf } from 'telegraf';
import { config } from '../config/index.js';
import { getAccountBalance } from '../kis/account.js';
import { deactivateKillSwitch, getKillSwitchStatus } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';

let bot: Telegraf | null = null;

export function initTelegram(): void {
  if (!config.telegram.botToken || config.telegram.botToken.startsWith('your_')) {
    logger.info('Telegram 토큰 미설정 → 알림 비활성', { component: 'TELEGRAM' });
    return;
  }
  bot = new Telegraf(config.telegram.botToken);

  // /status 명령어 — 시스템 상태 확인
  bot.command('status', async (ctx) => {
    try {
      const balance = await getAccountBalance();
      const killSwitch = getKillSwitchStatus();

      const msg = [
        `🤖 *QUANTOPS 상태*`,
        ``,
        `💰 총 자산: ${(balance.totalDeposit + balance.totalEvalAmount).toLocaleString()}원`,
        `💵 예수금: ${balance.orderableCash.toLocaleString()}원`,
        `📈 투자금: ${balance.totalEvalAmount.toLocaleString()}원`,
        `${balance.totalProfitLoss >= 0 ? '🟢' : '🔴'} 손익: ${balance.totalProfitLoss.toLocaleString()}원`,
        ``,
        `🛡️ Kill Switch: ${killSwitch.active ? '🛑 활성' : '✅ 비활성'}`,
        killSwitch.active ? `  사유: ${killSwitch.reason}` : '',
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

  // 명령어 인증 헬퍼 — TELEGRAM_CHAT_ID와 일치하는 사용자만 허용
  const isAuthorized = (ctx: any): boolean => {
    const allowedId = String(config.telegram.chatId ?? '').replace(/^-100/, '');
    const fromId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? '').replace(/^-100/, '');
    return !!allowedId && (fromId === allowedId || chatId.endsWith(allowedId));
  };

  // /kill 명령어 — Kill Switch 수동 발동 (인증된 사용자만)
  bot.command('kill', async (ctx) => {
    if (!isAuthorized(ctx)) {
      logger.warn(`Telegram /kill 미인증 시도: userId=${ctx.from?.id}`, { component: 'TELEGRAM' });
      return;
    }
    const { activateKillSwitch } = await import('../risk/kill-switch.js');
    await activateKillSwitch('CEO 수동 발동 (Telegram)');
    await ctx.reply('🛑 Kill Switch 발동 — 모든 매매 즉시 차단');
  });

  // /resume 명령어 — Kill Switch 해제 (인증된 사용자만)
  bot.command('resume', async (ctx) => {
    if (!isAuthorized(ctx)) {
      logger.warn(`Telegram /resume 미인증 시도: userId=${ctx.from?.id}`, { component: 'TELEGRAM' });
      return;
    }
    await deactivateKillSwitch();
    await ctx.reply('✅ Kill Switch 해제 — 매매 재개');
  });

  // /positions 명령어 — 보유 종목 상세
  bot.command('positions', async (ctx) => {
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

  bot.launch().then(() => {
    logger.info('📱 Telegram 봇 시작', { component: 'TELEGRAM' });
  }).catch((err) => {
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
}
