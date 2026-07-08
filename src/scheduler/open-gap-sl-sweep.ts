/**
 * 장초반 갭 SL 스위프 (09:01 KST)
 *
 * 전수조사 결과: 국내 SL은 폴링 전용(08~15시 평일)이라 장마감~개장(~16h)·주말(~64h) 무감시.
 *   + 파킹 SL은 30분 홀드가드로 지연 → 밤사이 갭다운이 SL(-2%)을 관통, 한화오션 -20.3%가 09:29에야 뒤늦게 감지.
 * 이 스위프는 개장 직후(09:01) 모든 보유 체인(파킹 포함, 가드 없이)을 통합 점검해
 *   현재가 기준 SL 이하면 즉시 시장가(FORCE_CLOSE) 청산 → 갭 포지션을 개장 직후 1분 내 탈출.
 *   (장전 08~09시는 KIS 시장가 접수 불가·지정가가 전일종가로 잡혀 갭다운 미체결 → 개장 직후 시장가가 확실.)
 */

import { getCtxIsPaper } from '../config/context.js';
import { getOpenChains } from '../db/client.js';
import { getCurrentPrice } from '../kis/market.js';
import type { TradeDecision } from '../db/models.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

const HARD_FLOOR_PCT = -3.0; // SL 미설정 체인 기본 하한

export interface GapSweepResult {
  scanned: number;
  closed: number;
  details: string[];
}

/** 장초반 갭 SL 스위프 실행 — runDomesticDual로 paper/live 양쪽 호출 */
export async function runOpenGapSlSweep(): Promise<GapSweepResult> {
  const isPaper = getCtxIsPaper();
  const modeLabel = isPaper ? 'PAPER' : 'LIVE';
  const result: GapSweepResult = { scanned: 0, closed: 0, details: [] };

  const chains = await getOpenChains(isPaper);
  const held = chains.filter((c) => Number(c.total_quantity ?? 0) > 0);
  result.scanned = held.length;
  if (held.length === 0) return result;

  const decisions: TradeDecision[] = [];
  for (const chain of held) {
    const code = chain.stock_code;
    const avgBuy = Number(chain.avg_buy_price ?? 0);
    if (avgBuy <= 0) continue;

    const price = await getCurrentPrice(code)
      .then((p) => p.currentPrice)
      .catch(() => 0);
    if (!price || price <= 0) continue;

    const pnlPct = ((price - avgBuy) / avgBuy) * 100;
    const slRaw = Number(chain.stop_loss_pct);
    const slPct = Number.isFinite(slRaw) && slRaw < 0 ? slRaw : HARD_FLOOR_PCT;

    if (pnlPct <= slPct) {
      decisions.push({
        action: 'FORCE_CLOSE',
        stock_code: code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `장초반 갭SL: 밤사이 갭다운 SL 관통 ${pnlPct.toFixed(1)}% <= ${slPct.toFixed(1)}% → 즉시 시장가 청산`,
        confidence: 0.99,
      });
      result.closed++;
      result.details.push(`🔻 ${code} ${pnlPct.toFixed(1)}% (SL ${slPct.toFixed(1)}%)`);
      logger.warn(`🔻 [장초반갭SL][${modeLabel}] ${code} 갭다운 ${pnlPct.toFixed(1)}% ≤ SL ${slPct.toFixed(1)}% → 강제청산`, {
        component: 'GAP_SL',
      });
    }
  }

  if (decisions.length > 0) {
    await tradeExecutor.processDecisions(decisions, 'SWING', 'OPEN_GAP_SL_SWEEP');
    sendTelegramMessage(
      `🔻 장초반 갭SL 청산 [${modeLabel}]: ${decisions.length}종목 (밤사이 갭다운 SL 관통)\n${result.details.join('\n')}`,
    ).catch(() => {});
  }
  logger.info(`[장초반갭SL][${modeLabel}] 스캔 ${result.scanned} / 청산 ${result.closed}`, { component: 'GAP_SL' });
  return result;
}
