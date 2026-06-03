import { getActiveStrategy, getOpenChains } from '../db/client.js';
import { getCurrentPrice } from '../kis/market.js';
import type { TradeDecision } from '../db/models.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { calcPnlPct } from '../utils/money.js';

/**
 * 단타 모드 장 마감 점검 (15:20 KST)
 * - SCALPING 모드 체인만 대상
 * - 손실 -2% 이상 → 강제 청산 (실제 손상된 포지션만)
 * - -2% 미만 손실 or 수익 중 → 오버나잇 유지 (억지로 손실 실현 금지)
 */
const FORCE_CLOSE_LOSS_THRESHOLD = -2.0; // 이 이상 손실일 때만 강제청산

export async function runForceCloseJob(): Promise<void> {
  // 킬스위치 활성이어도 강제청산(매도)은 항상 실행 — 포지션 탈출은 막으면 안 됨
  if (isKillSwitchActive()) {
    logger.info('🛑 Kill Switch 활성 중이나 강제청산(매도)은 실행', { component: 'FORCE_CLOSE' });
  }

  const strategy = await getActiveStrategy();
  if (strategy?.mode !== 'SCALPING') return;

  const chains = await getOpenChains();
  const scalpingChains = chains.filter((c) => c.strategy_mode === 'SCALPING' && c.total_quantity > 0);

  if (scalpingChains.length === 0) return;

  logger.warn(`🔥 단타 마감 점검: ${scalpingChains.length}개 체인`, { component: 'FORCE_CLOSE' });

  const toClose: TradeDecision[] = [];
  const held: string[] = [];

  for (const chain of scalpingChains) {
    try {
      const quote = await getCurrentPrice(chain.stock_code);
      const pnlPct = calcPnlPct(Number(chain.avg_buy_price), quote.currentPrice);

      // 손실이 임계값(-2%) 미만이면 강제청산 — 실제 손상된 포지션
      if (pnlPct <= FORCE_CLOSE_LOSS_THRESHOLD) {
        toClose.push({
          action: 'FORCE_CLOSE' as const,
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET' as const,
          reasoning: `마감 손절 (${pnlPct.toFixed(1)}% ≤ ${FORCE_CLOSE_LOSS_THRESHOLD}%, 추가 손실 방지)`,
          confidence: 1.0,
        });
      } else {
        // 보합(-2%~0%) or 수익 중 → 오버나잇 유지. 억지로 팔면 수수료 + 실현손만 남음
        const label = pnlPct >= 0 ? `+${pnlPct.toFixed(1)}%` : `${pnlPct.toFixed(1)}%`;
        held.push(`${chain.stock_code}(${label})`);
        logger.info(`  ✅ 오버나잇: ${chain.stock_code} ${label} → 내일 회복 기대`, { component: 'FORCE_CLOSE' });
      }
    } catch {
      // 시세 조회 실패 → 안전하게 홀딩 (억지 청산 금지)
      held.push(`${chain.stock_code}(시세실패-홀딩)`);
      logger.warn(`  ⚠️ ${chain.stock_code} 시세 실패 → 홀딩 유지`, { component: 'FORCE_CLOSE' });
    }
  }

  if (toClose.length > 0) {
    await tradeExecutor.processDecisions(toClose, 'SCALPING', 'FORCE_CLOSE');
    logger.warn(`🔥 마감 손절 완료: ${toClose.length}건`, { component: 'FORCE_CLOSE' });
  }

  const lines = [
    toClose.length > 0 ? `🔥 마감 손절 (${FORCE_CLOSE_LOSS_THRESHOLD}% 초과): ${toClose.map((d) => d.stock_code).join(', ')}` : null,
    held.length > 0 ? `🌙 오버나잇 유지: ${held.join(', ')}` : null,
    toClose.length === 0 && held.length > 0 ? '→ 억지 청산 없음. 수수료 절약.' : null,
  ].filter(Boolean);

  if (lines.length > 0) {
    await sendTelegramMessage(`📊 15:20 마감 점검:\n${lines.join('\n')}`);
  }
}
