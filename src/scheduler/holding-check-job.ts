import { STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { getActiveStrategy, getOpenChains } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { calcPnlPct } from '../utils/money.js';

/**
 * 보유일 초과 자동 손절 체크
 * - 매수 후 N영업일(기본 3일) 경과 시 수익이 안 나면 전량 손절
 * - CEO 매뉴얼: "매수 후 3영업일이 지나도 수익이 안 나면 미련 없이 전량 시장가로 손절"
 *
 * 실행 시점: 장중 매 10분마다 Track B와 함께
 */
export async function runHoldingCheckJob(): Promise<void> {
  try {
    const chains = await getOpenChains();
    if (chains.length === 0) return;

    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
    const params = STRATEGY_PARAMS[mode];

    // 단타 모드는 별도 강제청산 로직(15:20)이 있으므로 스킵
    if (mode === 'SCALPING') return;

    const maxDays = params.maxHoldingDays;
    if (maxDays <= 0) return;

    const now = new Date();
    const forceCloseDecisions: TradeDecision[] = [];

    for (const chain of chains) {
      if (chain.total_quantity <= 0) continue;

      // 영업일 계산 (주말 제외)
      const openedAt = new Date(chain.opened_at);
      const businessDays = countBusinessDays(openedAt, now);

      // 1영업일 미만은 건드리지 않음
      if (businessDays < 1) continue;

      // 현재가 확인 — 최대 2회 재시도
      let currentPrice: number | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const priceData = await getCurrentPrice(chain.stock_code);
          if (priceData.currentPrice > 0) {
            currentPrice = priceData.currentPrice;
            break;
          }
        } catch {
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (currentPrice === null) {
        if (businessDays >= maxDays) {
          // maxDays 초과 + 가격 조회 실패 → 강행
          logger.warn(
            `${chain.stock_code} 현재가 조회 2회 실패 → 평균가(${chain.avg_buy_price}) 기준 시간손절 강행`,
            { component: 'HOLDING_CHECK' },
          );
          forceCloseDecisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `보유 ${businessDays}영업일 초과 (한도 ${maxDays}일), 현재가 조회 실패 → 시장가 강제 손절`,
            confidence: 1.0,
          });
        }
        continue;
      }

      const pnlPct = calcPnlPct(Number(chain.avg_buy_price), currentPrice);

      // ── 조기 정체 감지 (수익 가능성 없는 포지션 선제 청산) ──
      // 기준: 일수별 슬라이딩 임계값. 아래 조건 충족 시 maxDays 기다리지 않고 청산
      const stagnantReason = checkStagnation(businessDays, pnlPct, maxDays);
      if (stagnantReason) {
        logger.warn(
          `🥱 정체 청산: ${chain.stock_code} ${businessDays}일 보유, ${pnlPct.toFixed(2)}% — ${stagnantReason}`,
          { component: 'HOLDING_CHECK' },
        );
        forceCloseDecisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `정체 청산 (${businessDays}영업일, ${pnlPct.toFixed(2)}%): ${stagnantReason}`,
          confidence: 1.0,
        });
        continue;
      }

      // ── 최대 보유일 초과 ──
      if (businessDays < maxDays) continue;

      // 수익이 충분히 나고 있으면 계속 보유
      if (pnlPct > 1.0) {
        logger.info(`⏰ ${chain.stock_code}: ${businessDays}일 보유, 수익 ${pnlPct.toFixed(2)}% → 유지`, {
          component: 'HOLDING_CHECK',
        });
        continue;
      }

      logger.warn(`⏰ ${chain.stock_code}: ${businessDays}일 보유, 수익 ${pnlPct.toFixed(2)}% → 시간 손절`, {
        component: 'HOLDING_CHECK',
      });
      forceCloseDecisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `보유 ${businessDays}영업일 초과 (한도 ${maxDays}일), 수익률 ${pnlPct.toFixed(2)}% → 시간 손절`,
        confidence: 1.0,
      });
    }

    if (forceCloseDecisions.length > 0) {
      await tradeExecutor.processDecisions(forceCloseDecisions, mode);

      const summary = forceCloseDecisions.map((d) => `${d.stock_code} x${d.quantity} (${d.reasoning})`).join('\n');
      await sendTelegramMessage(`⏰ 시간 손절 실행:\n${summary}`);
    }
  } catch (error) {
    logger.error(`보유일 체크 실패: ${error}`, { component: 'HOLDING_CHECK' });
  }
}

/**
 * 정체 감지: 일수별 슬라이딩 임계값으로 "수익 가능성 없는 포지션" 조기 청산 여부 판단
 *
 * 기준:
 *  - 2일차: -1.5% 미만 (손절선 절반 넘었는데 회복 없음 → 더 내려갈 가능성)
 *  - 3일차: 0% 미만 (3일 넘어도 여전히 마이너스 = 기대 없음)
 *  - maxDays-1 일차: +0.5% 미만 (만기 하루 전인데 거의 보합 = 수수료만 날림)
 *
 * @returns 청산 사유 문자열 (청산 불필요하면 null)
 */
function checkStagnation(businessDays: number, pnlPct: number, maxDays: number): string | null {
  // 2일차 이상: 손절선(-3%) 절반 이상 내려왔으면 조기 차단
  if (businessDays >= 2 && pnlPct < -1.5) {
    return `2일 이상 보유 중 -1.5% 이하 (${pnlPct.toFixed(2)}%) — 추가 하락 전 선제 청산`;
  }
  // 3일차 이상: 아직도 마이너스 = 수익 전환 가능성 낮음
  if (businessDays >= 3 && pnlPct < 0) {
    return `3일 이상 보유 중 여전히 마이너스 (${pnlPct.toFixed(2)}%) — 데드머니 청산`;
  }
  // maxDays 하루 전: 거의 보합이면 기다려봤자 수수료만 손해
  if (maxDays > 1 && businessDays >= maxDays - 1 && pnlPct < 0.5) {
    return `만기 하루 전 수익률 미달 (${pnlPct.toFixed(2)}% < 0.5%) — 조기 청산`;
  }
  return null;
}

/** 한국 공휴일 목록 (KRX 휴장일 기준 2025~2026) */
const KRX_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30',
  '2025-03-01', '2025-05-05', '2025-05-06', '2025-06-06',
  '2025-08-15', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  '2025-12-25',
  // 2026
  '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-03-01', '2026-03-02', '2026-05-05', '2026-05-25',
  '2026-06-06', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-28',
  '2026-10-09', '2026-12-25',
]);

/** 두 날짜 사이의 영업일 수 (주말 + 한국 공휴일 제외) */
function countBusinessDays(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current < endDate) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    const ymd = current.toISOString().split('T')[0];
    if (day !== 0 && day !== 6 && !KRX_HOLIDAYS.has(ymd)) count++;
  }

  return count;
}
