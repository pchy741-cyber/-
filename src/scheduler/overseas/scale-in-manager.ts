/**
 * Scale-In 관리 — 기존 보유 종목 +2% 이상 상승 시 나머지 40% 추가매수
 */
import { getPool, logSystem } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { modePrefix } from './utils.js';
import { updateTradeState } from './state.js';
import { executeOverseasOrder } from './executor.js';
import type { TechResult } from './sell-logic.js';
import type { BuyTarget } from './buy-filter.js';

export async function processScaleIns(params: {
  techResults: TechResult[];
  buyOrders: string[];
  cash: number;
  isPaper: boolean;
}): Promise<{ cash: number }> {
  const { techResults, buyOrders, isPaper } = params;
  let { cash } = params;
  const pfx = modePrefix(isPaper);
  const scaleInPrefix = `${pfx}scale_in_`;

  const { rows: scaleInRows } = await getPool().query<{ key: string; value: string }>(
    `SELECT key, value FROM overseas_state WHERE key LIKE $1`, [`${scaleInPrefix}%`]
  ).catch(() => ({ rows: [] as { key: string; value: string }[] }));

  for (const row of scaleInRows) {
    const code = row.key.replace(scaleInPrefix, '');
    const info = JSON.parse(row.value) as { remainingQty: number; entryPrice: number; createdAt: string; exchange: string };
    const holdingDays = (Date.now() - new Date(info.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (holdingDays > 2) {
      await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [row.key]).catch(() => {});
      logger.info(`📋 Scale-In 취소: ${code} (2일 초과, 미확인)`, { component: 'OVERSEAS' });
      continue;
    }
    const tech = techResults.find(t => t.code === code);
    if (!tech) continue;
    const pnlFromEntry = ((tech.price.currentPrice - info.entryPrice) / info.entryPrice) * 100;
    if (pnlFromEntry >= 1.2 && cash >= info.remainingQty * tech.price.currentPrice * 1.0025) {
      const exec = await executeOverseasOrder(code, 'BUY', info.remainingQty, tech.price.currentPrice, info.exchange,
        `📈 Scale-In 추가매수 (+${pnlFromEntry.toFixed(1)}% 확인) — 나머지 ${info.remainingQty}주`, 0, 0, { isPaper });
      if (exec.submitted && exec.filledQty > 0) {
        const cost = exec.filledQty * exec.filledPrice * 1.0025;
        cash -= cost;
        await updateTradeState({ code, exchange: info.exchange, qty: exec.finalQty, avgPrice: exec.finalAvgPrice, newCash: cash, isPaper });
        buyOrders.push(`📈 Scale-In ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${pnlFromEntry.toFixed(1)}% 확인 추가매수)`);
        await logSystem('TRADE', 'OVERSEAS', `SCALE-IN ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} +${pnlFromEntry.toFixed(1)}%`);
      }
      await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [row.key]).catch(() => {});
    }
  }
  return { cash };
}

/** Scale-In 결정: 모멘텀/빅무버/강한추세/확인된추세는 100% 즉시매수, 나머지는 60% 진입 */
export function shouldUseScaleIn(target: BuyTarget): boolean {
  const isStrongTrend = target.ai?.action === 'STRONG_BUY' && target.adx >= 35;
  // ADX>=25 + MA20 위 = 추세 확인됨 → 100% 즉시매수 (Scale-In 불필요)
  const isConfirmedTrend = target.adx >= 25 && target.aboveMA20;
  return !target.isMomentum && !target.isBigMover && !isStrongTrend && !isConfirmedTrend;
}

/** Scale-In 예약 데이터 빌드 */
export function buildScaleInReservation(code: string, remainingQty: number, entryPrice: number, exchange: string, isPaper: boolean): { key: string; value: string } {
  const pfx = modePrefix(isPaper);
  return {
    key: `${pfx}scale_in_${code}`,
    value: JSON.stringify({ remainingQty, entryPrice, createdAt: new Date().toISOString(), exchange }),
  };
}
