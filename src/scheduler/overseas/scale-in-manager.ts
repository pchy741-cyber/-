/**
 * Scale-In 관리 — 기존 보유 종목 +2% 이상 상승 시 나머지 40% 추가매수
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool, logSystem } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import type { BuyTarget } from './buy-filter.js';
import { executeOverseasOrder } from './executor.js';
import type { TechResult } from './sell-logic.js';
import { getHoldings, updateTradeState } from './state.js';
import { modePrefix } from './utils.js';

// ── Named constants ──
/** Scale-in trigger: minimum PnL% above entry to execute additional buy */
// v14: 1.2→2.5% (기존: trail activation 2-4%과 0.8% 차이 → 추가매수 직후 즉시 트레일 손절 위험)
const SCALE_IN_TRIGGER_PCT = 2.5;
/** Maximum days to keep a scale-in reservation before auto-cancel */
const SCALE_IN_MAX_DAYS = 2;
/** Milliseconds per day */
const MS_PER_DAY = 1000 * 60 * 60 * 24;

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

  const { rows: scaleInRows } = await getPool()
    .query<{ key: string; value: string }>(`SELECT key, value FROM overseas_state WHERE key LIKE $1`, [
      `${scaleInPrefix}%`,
    ])
    .catch(() => ({ rows: [] as { key: string; value: string }[] }));

  for (const row of scaleInRows) {
    const code = row.key.replace(scaleInPrefix, '');
    let info: { remainingQty: number; entryPrice: number; createdAt: string; exchange: string };
    try {
      info = JSON.parse(row.value);
    } catch {
      logger.warn(`Scale-In JSON 파싱 실패: ${code} — 스킵 (손상된 레코드 삭제)`, { component: 'OVERSEAS' });
      await getPool().query(`DELETE FROM overseas_state WHERE key = $1`, [row.key]).catch(() => {});
      continue;
    }
    const holdingDays = (Date.now() - new Date(info.createdAt).getTime()) / MS_PER_DAY;
    if (holdingDays > SCALE_IN_MAX_DAYS) {
      await getPool()
        .query(`DELETE FROM overseas_state WHERE key = $1`, [row.key])
        .catch(() => {});
      logger.info(`📋 Scale-In 취소: ${code} (2일 초과, 미확인)`, { component: 'OVERSEAS' });
      continue;
    }
    const tech = techResults.find((t: TechResult) => t.code === code);
    if (!tech) continue;
    const pnlFromEntry = ((tech.price.currentPrice - info.entryPrice) / info.entryPrice) * 100;
    if (pnlFromEntry >= SCALE_IN_TRIGGER_PCT && cash >= info.remainingQty * tech.price.currentPrice * (1 + OVERSEAS_FEE_PCT)) {
      // v10.8: 기존 보유 수량/평균단가 조회 — 올바른 finalAvgPrice 계산을 위해
      const currentHoldings = await getHoldings(isPaper);
      const existingHolding = currentHoldings.get(code);
      const prevQty = existingHolding?.qty ?? 0;
      const prevAvgPrice = existingHolding?.avgPrice ?? info.entryPrice;
      const exec = await executeOverseasOrder(
        code,
        'BUY',
        info.remainingQty,
        tech.price.currentPrice,
        info.exchange,
        `📈 Scale-In 추가매수 (+${pnlFromEntry.toFixed(1)}% 확인) — 나머지 ${info.remainingQty}주`,
        prevQty,
        prevAvgPrice,
        { isPaper },
      );
      if (exec.submitted && exec.filledQty > 0) {
        const cost = exec.filledQty * exec.filledPrice * (1 + OVERSEAS_FEE_PCT);
        cash -= cost;
        await updateTradeState({
          code,
          exchange: info.exchange,
          qty: exec.finalQty,
          avgPrice: exec.finalAvgPrice,
          newCash: cash,
          isPaper,
        });
        buyOrders.push(
          `📈 Scale-In ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (+${pnlFromEntry.toFixed(1)}% 확인 추가매수)`,
        );
        await logSystem(
          'TRADE',
          'OVERSEAS',
          `SCALE-IN ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} +${pnlFromEntry.toFixed(1)}%`,
        );
        // v10.11: 체결 성공시에만 예약 삭제 (기존: 무조건 삭제 → 미체결시 분할매수 영구 유실)
        await getPool()
          .query(`DELETE FROM overseas_state WHERE key = $1`, [row.key])
          .catch(() => {});
      } else if (!exec.submitted) {
        // 주문 제출 자체 실패 → 다음 사이클에서 재시도 (예약 유지)
        logger.warn(`📋 Scale-In 주문 실패 (다음 사이클 재시도): ${code}`, { component: 'OVERSEAS' });
      }
      // exec.submitted && filledQty===0: 접수됐지만 미체결 → 다음 사이클 재시도 (예약 유지)
    }
  }
  return { cash };
}

/** Scale-In 결정: 대부분 100% 즉시매수, RSI 과매수 구간 접근 시에만 분할진입
 *  v10.10.4: 기존 과다 분할매수 완화 — 대부분의 매수를 즉시 전량 진입으로 변경
 *  Scale-In은 RSI가 높아서 조정 가능성 있는 경우에만 사용 (= 신중한 진입)
 */
export function shouldUseScaleIn(target: BuyTarget): boolean {
  // 모멘텀/빅무버/강한추세/확인된추세 → 무조건 즉시매수
  if (target.isMomentum || target.isBigMover) return false;
  if (target.ai?.action === 'STRONG_BUY' && target.adx >= 35) return false;
  if (target.adx >= 25 && target.aboveMA20) return false;
  // v10.10.4: ADX 약하고 + RSI 높은 경우에만 분할진입 (과매수 구간 신중 진입)
  // RSI < 55: 과매수 아님 → 즉시매수, RSI >= 55 + ADX < 20: 추세 약하면서 RSI 높음 → 분할
  return target.rsi >= 55 && target.adx < 20;
}

/** Scale-In 예약 데이터 빌드 */
export function buildScaleInReservation(
  code: string,
  remainingQty: number,
  entryPrice: number,
  exchange: string,
  isPaper: boolean,
): { key: string; value: string } {
  const pfx = modePrefix(isPaper);
  return {
    key: `${pfx}scale_in_${code}`,
    value: JSON.stringify({ remainingQty, entryPrice, createdAt: new Date().toISOString(), exchange }),
  };
}
