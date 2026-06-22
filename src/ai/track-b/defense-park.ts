/**
 * 하락장 방어 파킹 시스템
 *
 * 파킹 진입: market-routing.ts (VIX/S&P500/Fear&Greed 기반, 08:45 크론)
 * 파킹 해제: pipeline.ts → isMarketRecovering() 판정
 *
 * 파킹 자산: KODEX 미국달러SOFR금리액티브 (449170)
 */

import { CrashSignal, INVERSE_ETF_CODES, INVERSE_ETFS } from '../../automation/crash-profit.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool, isMemoryMode } from '../../db/client.js';
import { getCashReserveRatio } from './cash-manager.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

/** @deprecated v10.9.5: SOFR 파킹 폐지. 잔여분 감지/매도용으로만 유지 */
export const PARK_STOCK_CODE = '449170';
export const PARK_STOCK_NAME = 'KODEX 미국달러SOFR금리액티브';

// 상승세 복귀 기준
const RECOVERY_PARK_PROFIT_PCT = 1.5; // 파킹 자산 수익률 1.5% 이상 (= 시장 회복 신호)
const RECOVERY_POSITIVE_DAYS = 2; // 연속 n일 양수 daily_pnl

// 하락장 감지 기준 (isPortfolioInDowntrend 내부 사용)
const DOWNTREND_MIN_DAYS = 5; // 최소 5일 스냅샷 필요
const DOWNTREND_DRAWDOWN_PCT = 3.0; // 전고점 대비 3% 이상 낙폭
const DOWNTREND_CONFIRM_DAYS = 3; // 최근 5일 중 3일 이상 손실 확인

export interface DefenseParkState {
  isActive: boolean;
  parkStockCode: string;
  parkStockName: string;
  entryReason: string | null;
  enteredAt: Date | null;
}

/** DB에서 현재 방어 파킹 상태 조회 */
export async function getDefenseParkState(): Promise<DefenseParkState> {
  if (isMemoryMode()) {
    return {
      isActive: false,
      parkStockCode: PARK_STOCK_CODE,
      parkStockName: PARK_STOCK_NAME,
      entryReason: null,
      enteredAt: null,
    };
  }
  try {
    const isPaper = getCtxIsPaper();
    const { rows } = await getPool().query(
      `SELECT park_stock_code, park_stock_name, entry_reason, entered_at
       FROM defense_park_state WHERE is_active = TRUE AND is_paper = $1 ORDER BY entered_at DESC LIMIT 1`,
      [isPaper],
    );
    if (rows.length === 0) {
      return {
        isActive: false,
        parkStockCode: PARK_STOCK_CODE,
        parkStockName: PARK_STOCK_NAME,
        entryReason: null,
        enteredAt: null,
      };
    }
    return {
      isActive: true,
      parkStockCode: rows[0].park_stock_code,
      parkStockName: rows[0].park_stock_name,
      entryReason: rows[0].entry_reason,
      enteredAt: rows[0].entered_at,
    };
  } catch {
    return {
      isActive: false,
      parkStockCode: PARK_STOCK_CODE,
      parkStockName: PARK_STOCK_NAME,
      entryReason: null,
      enteredAt: null,
    };
  }
}

/** 방어 파킹 활성화 기록 */
async function activateDefensePark(reason: string): Promise<void> {
  if (isMemoryMode()) return;
  const isPaper = getCtxIsPaper();
  await getPool().query(
    `INSERT INTO defense_park_state (is_active, is_paper, park_stock_code, park_stock_name, entry_reason, entered_at)
     VALUES (TRUE, $1, $2, $3, $4, NOW())
     ON CONFLICT (is_paper) WHERE is_active = TRUE DO NOTHING`,
    [isPaper, PARK_STOCK_CODE, PARK_STOCK_NAME, reason],
  );
}

/** 방어 파킹 해제 기록 */
export async function deactivateDefensePark(reason: string): Promise<void> {
  if (isMemoryMode()) return;
  const isPaper = getCtxIsPaper();
  await getPool().query(
    `UPDATE defense_park_state SET is_active = FALSE, exit_reason = $1, exited_at = NOW()
     WHERE is_active = TRUE AND is_paper = $2`,
    [reason, isPaper],
  );
}

/**
 * 포트폴리오 스냅샷 기반 하락세 감지
 * 최근 7일 스냅샷의 최고점 대비 낙폭 + 연속 음수 일수로 판단
 */
export async function isPortfolioInDowntrend(): Promise<{ downtrend: boolean; reason: string }> {
  if (isMemoryMode()) return { downtrend: false, reason: '' };

  try {
    const { rows } = await getPool().query(
      `
      SELECT total_value, daily_pnl, snapshot_at
      FROM portfolio_snapshots
      WHERE snapshot_at >= NOW() - INTERVAL '8 days'
        AND is_paper = $1
      ORDER BY snapshot_at DESC
      LIMIT 10
    `,
      [getCtxIsPaper()],
    );

    if (rows.length < DOWNTREND_MIN_DAYS) {
      return { downtrend: false, reason: `스냅샷 부족 (${rows.length}개)` };
    }

    const values = rows.map((r: Record<string, unknown>) => Number(r.total_value));
    const pnls = rows.map((r: Record<string, unknown>) => Number(r.daily_pnl));

    const currentValue = values[0];
    const peakValue = Math.max(...values);
    const drawdownPct = peakValue > 0 ? ((peakValue - currentValue) / peakValue) * 100 : 0;

    // 최근 5일 중 음수 일수 계산
    const recentPnls = pnls.slice(0, 5);
    const negativeDays = recentPnls.filter((p) => p < 0).length;

    const drawdownTriggered = drawdownPct >= DOWNTREND_DRAWDOWN_PCT;
    const consecutiveLossTriggered = negativeDays >= DOWNTREND_CONFIRM_DAYS;

    if (drawdownTriggered && consecutiveLossTriggered) {
      const reason = `7일 최고점 대비 -${drawdownPct.toFixed(1)}% 낙폭 + 최근 5일 중 ${negativeDays}일 손실`;
      return { downtrend: true, reason };
    }

    return { downtrend: false, reason: `낙폭 ${drawdownPct.toFixed(1)}%, 손실일 ${negativeDays}/5` };
  } catch (err) {
    logger.warn(`하락세 감지 오류: ${err}`, { component: 'DEFENSE_PARK' });
    return { downtrend: false, reason: '오류' };
  }
}

/**
 * 파킹 포지션의 시장 회복 여부 감지
 * SOFR ETF 수익률 > 1.5% OR 연속 2일 양수 스냅샷
 */
export async function isMarketRecovering(
  openChains: TransactionChain[],
  livePrices: Map<string, CurrentPrice>,
): Promise<{ recovering: boolean; reason: string }> {
  // 1. SOFR ETF 또는 인버스 포지션 수익률 확인
  const parkChain = openChains.find((c) => c.stock_code === PARK_STOCK_CODE || INVERSE_ETF_CODES.has(c.stock_code));
  if (parkChain?.avg_buy_price) {
    const price = livePrices.get(parkChain.stock_code);
    if (price && price.currentPrice > 0) {
      const avgBuy = Number(parkChain.avg_buy_price);
      const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;
      if (pnlPct >= RECOVERY_PARK_PROFIT_PCT) {
        const assetName = INVERSE_ETFS.find((e) => e.code === parkChain.stock_code)?.name ?? PARK_STOCK_NAME;
        return {
          recovering: true,
          reason: `${assetName} 수익률 +${pnlPct.toFixed(1)}% (기준 +${RECOVERY_PARK_PROFIT_PCT}%)`,
        };
      }
    }
  }

  // 2. 스냅샷 연속 양수 확인
  if (!isMemoryMode()) {
    try {
      const { rows } = await getPool().query(
        `
        SELECT daily_pnl FROM portfolio_snapshots
        WHERE is_paper = $1
        ORDER BY snapshot_at DESC LIMIT 3
      `,
        [getCtxIsPaper()],
      );
      const recentPnls = rows.map((r: Record<string, unknown>) => Number(r.daily_pnl));
      const consecutivePositive = recentPnls.slice(0, RECOVERY_POSITIVE_DAYS).every((p) => p > 0);
      if (consecutivePositive && recentPnls.length >= RECOVERY_POSITIVE_DAYS) {
        return {
          recovering: true,
          reason: `연속 ${RECOVERY_POSITIVE_DAYS}일 수익 흑자 전환`,
        };
      }
    } catch {
      /* 스냅샷 없으면 스킵 */
    }
  }

  // 3. 파킹 48시간 이상 경과 시 해제
  // v10.9.5: 인버스 ETF 전용 — 장기 보유 시 시간가치 감소 + 괴리율 확대 리스크
  // parkChain 없거나 PnL ≥ -1.0% 이면 48h 후 강제 해제
  if (!isMemoryMode()) {
    try {
      const { rows } = await getPool().query(
        `SELECT entered_at FROM defense_park_state WHERE is_active = TRUE AND is_paper = $1 ORDER BY entered_at DESC LIMIT 1`,
        [getCtxIsPaper()],
      );
      if (rows.length > 0) {
        const enteredAt = new Date(rows[0].entered_at);
        const hoursParked = (Date.now() - enteredAt.getTime()) / 3_600_000;
        if (hoursParked >= 48) {
          if (!parkChain) {
            // 파킹 포지션이 이미 없는 상태 → 즉시 해제 (고착 방지)
            return {
              recovering: true,
              reason: `파킹 ${hoursParked.toFixed(0)}시간 경과 — 포지션 없음, 강제 해제`,
            };
          }
          // v10.9.4: parkChain의 실제 종목코드 사용 (기존: PARK_STOCK_CODE 고정 → 인버스 ETF일 때 SOFR 가격으로 PnL 계산 → 타임아웃 불발)
          const price = livePrices.get(parkChain.stock_code);
          const avgBuy = Number(parkChain.avg_buy_price ?? 0);
          const currentPx = price?.currentPrice ?? 0;
          const pnlPct = avgBuy > 0 && currentPx > 0 ? ((currentPx - avgBuy) / avgBuy) * 100 : 0;
          if (pnlPct >= -1.0) {
            // -1.0% 이상이면 해제 — 인버스 ETF는 반등 시 손실 확대 방지
            return {
              recovering: true,
              reason: `파킹 ${hoursParked.toFixed(0)}시간 경과 — 기간 만료 해제 (인버스 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
            };
          }
        }
      }
    } catch {
      /* 스킵 */
    }
  }

  return { recovering: false, reason: '' };
}

/**
 * 방어 파킹 진입 결정 생성 (v10.9.5: 인버스 ETF 전용)
 * 1) 손실 포지션 FORCE_CLOSE (수익 중 +1% 이상은 보존)
 * 2) KODEX 200선물인버스2X 매수 (하락 수익화)
 */
export async function buildDefenseParkEntryDecisions(
  openChains: TransactionChain[],
  livePrices: Map<string, CurrentPrice>,
  orderableCash: number,
  totalAssets: number,
  reason: string,
  crashSignal?: CrashSignal,
): Promise<TradeDecision[]> {
  const parkCode = INVERSE_ETFS[0].code;
  const parkName = INVERSE_ETFS[0].name;
  const scoreLabel = crashSignal ? ` (score=${crashSignal.score})` : '';

  logger.warn(`🛡️ 방어 파킹 진입: ${reason} → ${parkName}${scoreLabel}`, {
    component: 'DEFENSE_PARK',
  });
  await activateDefensePark(reason);

  import('../../notifications/web-push.js')
    .then((m) =>
      m.notifyAlert(
        `🛡️ DEFENSE 모드 진입`,
        `사유: ${reason.slice(0, 80)}\n${parkName}으로 자산 이동 (인버스)`,
      ),
    )
    .catch(() => {});

  const decisions: TradeDecision[] = [];

  // 1. 손실 포지션만 청산 (파킹 자산 및 수익 중 종목 제외)
  for (const chain of openChains) {
    if (chain.stock_code === PARK_STOCK_CODE || INVERSE_ETF_CODES.has(chain.stock_code)) continue;
    const livePrice = livePrices.get(chain.stock_code);
    const avgBuy = Number(chain.avg_buy_price ?? 0);
    const currentPx = livePrice?.currentPrice ?? 0;
    // PANIC: 전 포지션 청산 (수익 중이어도). 그 외: 수익 중(+1%)은 보존
    if (crashSignal?.level !== 'PANIC') {
      if (avgBuy > 0 && currentPx > 0 && ((currentPx - avgBuy) / avgBuy) * 100 >= 1.0) {
        logger.info(`🛡️ 방어 파킹: ${chain.stock_code} 수익 중 — 청산 제외`, { component: 'DEFENSE_PARK' });
        continue;
      }
    }
    decisions.push({
      action: 'FORCE_CLOSE',
      stock_code: chain.stock_code,
      quantity: chain.total_quantity,
      price_type: 'MARKET',
      reasoning: `🛡️ 방어 파킹 진입 — ${crashSignal?.level === 'PANIC' ? '긴급 전량' : '손실 포지션'} 청산: ${reason}`,
      confidence: 0.99,
    });
  }

  // 2. 파킹 자산 매수 (이미 보유 중이면 스킵)
  const alreadyHasPark = openChains.some((c) => c.stock_code === parkCode);
  if (!alreadyHasPark) {
    const parkPrice = livePrices.get(parkCode);
    if (parkPrice && parkPrice.currentPrice > 0) {
      const minCashReserve = Math.floor(totalAssets * getCashReserveRatio(getCtxIsPaper()));
      const parkable = Math.max(0, orderableCash - minCashReserve);
      // v10.9.5: 인버스 전용 — PANIC: 90%, CRASH: 80%, 기본: 70% (인버스는 양방향 리스크)
      const crashLevel = crashSignal?.level;
      const investRatio = crashLevel === 'PANIC' ? 0.90 : crashLevel === 'CRASH' ? 0.80 : 0.70;
      const investAmount = Math.floor(parkable * investRatio);
      const qty = Math.floor(investAmount / parkPrice.currentPrice);
      if (qty > 0) {
        decisions.push({
          action: 'BUY',
          stock_code: parkCode,
          quantity: qty,
          price_type: 'MARKET',
          limit_price: parkPrice.currentPrice,
          reasoning: `🛡️ 방어 파킹: ${parkName} — 하락 수익화 (${reason})`,
          confidence: 0.99,
          strategy_mode: 'DEFENSE',
          trigger_source: crashSignal ? `CRASH_PROFIT_PARK_${crashSignal.level}` : 'DEFENSE_PARK_INVERSE',
        });
      }
    }
  }

  return decisions;
}

/**
 * 방어 파킹 해제 결정 생성
 * SOFR ETF 전량 매도 후 정상 매매 복귀
 */
export async function buildDefenseParkExitDecisions(
  openChains: TransactionChain[],
  reason: string,
): Promise<TradeDecision[]> {
  logger.info(`✅ 방어 파킹 해제: ${reason}`, { component: 'DEFENSE_PARK' });
  await deactivateDefensePark(reason);

  import('../../notifications/web-push.js')
    .then((m) => m.notifyAlert('✅ DEFENSE 모드 해제', `사유: ${reason.slice(0, 80)}\n정상 SWING 매매 복귀`))
    .catch(() => {});

  // SOFR ETF 또는 인버스 둘 다 확인
  const parkChains = openChains.filter((c) => c.stock_code === PARK_STOCK_CODE || INVERSE_ETF_CODES.has(c.stock_code));
  if (parkChains.length === 0) return [];

  return parkChains.map((chain) => {
    const name = INVERSE_ETFS.find((e) => e.code === chain.stock_code)?.name ?? PARK_STOCK_NAME;
    return {
      action: 'SELL' as const,
      stock_code: chain.stock_code,
      quantity: chain.total_quantity,
      price_type: 'MARKET' as const,
      reasoning: `✅ 방어 파킹 해제 — ${name} 전량 매도: ${reason}`,
      confidence: 0.99,
    };
  });
}
