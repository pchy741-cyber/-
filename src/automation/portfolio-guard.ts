import { getPool } from '../db/client.js';
import type { TransactionChain } from '../db/models.js';
import { getAccountBalance } from '../kis/account.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const COMPONENT = 'PORTFOLIO_GUARD';

// ── 포트폴리오 스트레스 레벨 ──────────────────────────────────────────────
// 0 = 정상  1 = 주의 (미실현 손실 -2%)  2 = 위험 (미실현 손실 -3.5%)
export type PortfolioStressLevel = 0 | 1 | 2;

/**
 * 열린 포지션들의 미실현 P&L을 합산해 스트레스 레벨을 반환한다.
 * pipeline.ts에서 매 사이클마다 직접 계산 (API 호출 없음).
 *
 * @param openChains DB에서 가져온 열린 체인 목록
 * @param livePrices 종목별 현재가 Map (stock_code → { currentPrice })
 * @param totalAssets 총 자산 (현금+주식 평가액)
 */
export function calcPortfolioStressLevel(
  openChains: TransactionChain[],
  livePrices: Map<string, { currentPrice: number }>,
  totalAssets: number,
): PortfolioStressLevel {
  if (totalAssets <= 0 || openChains.length === 0) return 0;

  let totalUnrealized = 0;

  for (const chain of openChains) {
    if (chain.total_quantity <= 0 || !chain.avg_buy_price) continue;
    const price = livePrices.get(chain.stock_code)?.currentPrice ?? 0;
    if (price <= 0) continue;
    totalUnrealized += (price - chain.avg_buy_price) * chain.total_quantity;
  }

  const unrealizedPct = (totalUnrealized / totalAssets) * 100;

  if (unrealizedPct <= -3.5) return 2;
  if (unrealizedPct <= -2.0) return 1;
  return 0;
}

/**
 * 최근 5거래일 실현수익 기반 포지션 사이즈 배율 (0.7 ~ 1.2)
 *
 * - 승률 ≥ 65% + 수익 > 30만 → 1.2x
 * - 승률 ≥ 55% + 수익 > 0   → 1.1x
 * - 승률 < 40% or 손실 < -30만 → 0.7x
 * - 승률 < 50%              → 0.85x
 * - 그 외                   → 1.0x
 */
export async function getPerformanceMultiplier(): Promise<number> {
  try {
    const pool = getPool();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 10); // 주말 포함해 5거래일 커버

    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                                 AS total,
         COUNT(CASE WHEN realized_pnl > 0 THEN 1 END)           AS wins,
         COALESCE(SUM(realized_pnl), 0)::numeric                 AS total_pnl
       FROM transaction_chains
       WHERE status = 'CLOSED'
         AND closed_at >= $1
         AND stock_code ~ '^[0-9]{6}$'`,
      [cutoff.toISOString()],
    );

    const total = Number(rows[0]?.total ?? 0);
    if (total < 2) return 1.0; // 데이터 부족 → 중립

    const wins = Number(rows[0]?.wins ?? 0);
    const totalPnl = Number(rows[0]?.total_pnl ?? 0);
    const winRate = wins / total;

    let mult: number;
    if (winRate >= 0.65 && totalPnl > 300_000) {
      mult = 1.2;
    } else if (winRate >= 0.55 && totalPnl > 0) {
      mult = 1.1;
    } else if (winRate < 0.40 || totalPnl < -300_000) {
      mult = 0.7;
    } else if (winRate < 0.50) {
      mult = 0.85;
    } else {
      mult = 1.0;
    }

    logger.info(
      `📈 성과배율: ${mult}x (최근 ${total}건 승률 ${(winRate * 100).toFixed(0)}% 수익 ${totalPnl.toLocaleString()}원)`,
      { component: COMPONENT },
    );

    return mult;
  } catch (err) {
    logger.warn(`성과배율 조회 실패: ${err}`, { component: COMPONENT });
    return 1.0;
  }
}

// ── 집중도 한도 ────────────────────────────────────────────────────────────
const MAX_SINGLE_STOCK_PCT = 0.25; // 단일 종목 25% 초과 → 경고

/**
 * 30분 주기 포트폴리오 헬스체크 (스케줄러에서 호출)
 *
 * 1. 미실현 손실 집계 → 위험 레벨 전보
 * 2. 단일 종목 집중도 25% 초과 → 텔레그램 경고
 */
export async function runPortfolioHealthCheck(): Promise<void> {
  try {
    const balance = await getAccountBalance();
    const positions = balance.positions;

    if (positions.length === 0) return;

    const totalPortfolio = balance.totalDeposit + balance.totalEvalAmount;
    if (totalPortfolio <= 0) return;

    // 미실현 손실 합계
    const totalUnrealizedPnl = positions.reduce((s, p) => s + p.profitLoss, 0);
    const unrealizedPct = (totalUnrealizedPnl / totalPortfolio) * 100;

    // 집중도 체크
    const concentrated: { name: string; pct: number }[] = [];
    for (const pos of positions) {
      const pct = pos.evalAmount / totalPortfolio;
      if (pct > MAX_SINGLE_STOCK_PCT) {
        concentrated.push({ name: pos.stockName, pct });
      }
    }

    const stressLevel: PortfolioStressLevel = unrealizedPct <= -3.5 ? 2 : unrealizedPct <= -2.0 ? 1 : 0;

    if (stressLevel >= 2) {
      const msg = [
        `🚨 *포트폴리오 위험 경보*`,
        `미실현 손실: ${unrealizedPct.toFixed(2)}% (${totalUnrealizedPnl.toLocaleString()}원)`,
        `신규매수 자동 차단 — 기존 포지션 확인 요망`,
      ].join('\n');
      await sendTelegramMessage(msg).catch(() => {});
      logger.warn(`🚨 포트폴리오 위험: 미실현 ${unrealizedPct.toFixed(2)}%`, { component: COMPONENT });
    } else if (stressLevel === 1) {
      logger.warn(`⚠️ 포트폴리오 주의: 미실현 ${unrealizedPct.toFixed(2)}%`, { component: COMPONENT });
    }

    if (concentrated.length > 0) {
      const names = concentrated.map((c) => `${c.name}(${(c.pct * 100).toFixed(1)}%)`).join(', ');
      const msg = `⚠️ *집중도 경고*\n${names}\n포트폴리오 25% 초과 — 분산 고려 권장`;
      await sendTelegramMessage(msg).catch(() => {});
      logger.warn(`⚠️ 집중도 초과: ${names}`, { component: COMPONENT });
    }

    // 집중도 초과 + 충분한 수익 → 자동 부분매도 신호 로그 (실제 매도는 다음 Track B 사이클에서 처리)
    for (const pos of positions) {
      const pct = pos.evalAmount / totalPortfolio;
      if (pct > MAX_SINGLE_STOCK_PCT && pos.profitLossPct > 5) {
        logger.warn(
          `🔧 자동조정 권고: ${pos.stockName}(${pos.stockCode}) — 비중 ${(pct * 100).toFixed(1)}% 초과, 수익 +${pos.profitLossPct.toFixed(1)}% → 다음 사이클 부분매도 대상`,
          { component: COMPONENT },
        );
      }
    }
  } catch (err) {
    logger.error(`포트폴리오 헬스체크 실패: ${err}`, { component: COMPONENT });
  }
}

/**
 * Track B 사이클에서 집중 포지션 감지 → PARTIAL_SELL 결정 주입
 *
 * @returns 부분매도 대상 종목코드 Set
 */
export function getConcentrationSellTargets(
  openChains: TransactionChain[],
  livePrices: Map<string, { currentPrice: number }>,
  totalAssets: number,
): Set<string> {
  const targets = new Set<string>();
  if (totalAssets <= 0) return targets;

  for (const chain of openChains) {
    if (chain.total_quantity <= 0 || !chain.avg_buy_price) continue;
    const price = livePrices.get(chain.stock_code)?.currentPrice ?? 0;
    if (price <= 0) continue;

    const evalValue = price * chain.total_quantity;
    const pct = evalValue / totalAssets;

    // 25% 초과 + 수익 상태일 때만 자동 부분매도
    const unrealizedPnlPct = chain.avg_buy_price > 0
      ? ((price - chain.avg_buy_price) / chain.avg_buy_price) * 100
      : 0;

    if (pct > MAX_SINGLE_STOCK_PCT && unrealizedPnlPct > 3) {
      targets.add(chain.stock_code);
      logger.info(
        `🔧 집중 자동조정: ${chain.stock_code} — 비중 ${(pct * 100).toFixed(1)}% 초과, 수익 +${unrealizedPnlPct.toFixed(1)}%`,
        { component: COMPONENT },
      );
    }
  }

  return targets;
}
