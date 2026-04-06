import { getActiveStrategy, getOpenChains } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

/**
 * 단타 모드 강제 청산 (15:20 KST)
 * - SCALPING 모드 체인만 대상
 * - 오버나잇 절대 금지
 */
export async function runForceCloseJob(): Promise<void> {
  const strategy = await getActiveStrategy();
  if (strategy?.mode !== 'SCALPING') return;

  const chains = await getOpenChains();
  const scalpingChains = chains.filter((c) => c.strategy_mode === 'SCALPING' && c.total_quantity > 0);

  if (scalpingChains.length === 0) return;

  logger.warn(`🔥 단타 강제 청산: ${scalpingChains.length}개 체인`, { component: 'FORCE_CLOSE' });

  const decisions: TradeDecision[] = scalpingChains.map((chain) => ({
    action: 'FORCE_CLOSE' as const,
    stock_code: chain.stock_code,
    quantity: chain.total_quantity,
    price_type: 'MARKET' as const,
    reasoning: '15:20 단타 모드 강제 청산 (오버나잇 금지)',
    confidence: 1.0,
  }));

  await tradeExecutor.processDecisions(decisions, 'SCALPING');

  await sendTelegramMessage(
    `🔥 단타 강제 청산 완료:\n${scalpingChains.map((c) => `${c.stock_code} x${c.total_quantity}`).join('\n')}`,
  );
}
