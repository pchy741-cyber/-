import { config } from '../config/index.js';
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
 * 최근 5거래일 실현수익 기반 포지션 사이즈 배율 (0.5 ~ 1.2)
 *
 * - 승률 ≥ 65% + 수익 > 30만 → 1.2x (공격)
 * - 승률 ≥ 55% + 수익 > 0   → 1.1x (약공격)
 * - 승률 < 30% or 손실 < -50만 → 0.5x (심각 손실 — 신규 진입 최소화)
 * - 승률 < 40% or 손실 < -30만 → 0.7x (방어)
 * - 승률 < 50%              → 0.85x (보수)
 * - 그 외                   → 1.0x (중립)
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
         AND stock_code ~ '^[0-9]{6}$'
         AND is_paper = $2`,
      [cutoff.toISOString(), config.isPaper],
    );

    const total = Number(rows[0]?.total ?? 0);
    if (total < 2) return 1.0; // 데이터 부족 → 중립

    const wins = Number(rows[0]?.wins ?? 0);
    const totalPnl = Number(rows[0]?.total_pnl ?? 0);
    const winRate = wins / total;

    let mult: number;
    let label: string;
    if (winRate >= 0.65 && totalPnl > 300_000) {
      mult = 1.2;
      label = '공격';
    } else if (winRate >= 0.55 && totalPnl > 0) {
      mult = 1.1;
      label = '약공격';
    } else if (winRate < 0.30 || totalPnl < -500_000) {
      mult = 0.5;
      label = '심각손실 — 신규진입 최소화';
    } else if (winRate < 0.40 || totalPnl < -300_000) {
      mult = 0.7;
      label = '방어';
    } else if (winRate < 0.50) {
      mult = 0.85;
      label = '보수';
    } else {
      mult = 1.0;
      label = '중립';
    }

    logger.info(
      `📈 성과배율: ${mult}x [${label}] (최근 ${total}건 승률 ${(winRate * 100).toFixed(0)}% 수익 ${totalPnl.toLocaleString()}원)`,
      { component: COMPONENT },
    );

    return mult;
  } catch (err) {
    logger.warn(`성과배율 조회 실패: ${err}`, { component: COMPONENT });
    return 1.0;
  }
}

// ── 승률 피드백 루프 ──────────────────────────────────────────────────────
export interface WinRateFeedback {
  recentWinRate: number;
  thresholdBonus: number;   // buyThreshold에 더할 점수 (0/3/5/8)
  requirePullback: boolean; // truePullbackPattern 없으면 스킵
  minVolumeRatio: number;   // 최소 거래량 배율 (1.0/1.5/2.0)
  sampleSize: number;
  summary: string;
}

let _feedbackCache: { data: WinRateFeedback; ts: number } | null = null;
const FEEDBACK_CACHE_MS = 15 * 60 * 1000;

/**
 * 최근 30일 실거래 체인 분석 → 신호별 승률 기반 진입 필터 강화
 * ai_reasoning 파싱: pb=True/False, volXx, RSI, score
 */
export async function getWinRateFeedback(isPaper: boolean): Promise<WinRateFeedback> {
  const neutral: WinRateFeedback = {
    recentWinRate: 0.5, thresholdBonus: 0, requirePullback: false, minVolumeRatio: 1.0,
    sampleSize: 0, summary: '샘플 부족 — 기본값',
  };

  try {
    const now = Date.now();
    if (_feedbackCache && now - _feedbackCache.ts < FEEDBACK_CACHE_MS) {
      return _feedbackCache.data;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const { rows } = await getPool().query(
      `SELECT tc.realized_pnl, o.ai_reasoning
       FROM transaction_chains tc
       JOIN orders o ON o.chain_id = tc.id AND o.side = 'BUY' AND o.ai_reasoning IS NOT NULL
       WHERE tc.status = 'CLOSED'
         AND tc.is_paper = $1
         AND tc.closed_at >= $2
         AND tc.stock_code ~ '^[0-9]{6}$'
       ORDER BY tc.closed_at DESC
       LIMIT 50`,
      [isPaper, cutoff.toISOString()],
    );

    if (rows.length < 5) {
      _feedbackCache = { data: neutral, ts: now };
      return neutral;
    }

    interface TradeSignal { win: boolean; hasPb: boolean; vol: number; }
    const trades: TradeSignal[] = rows.map((r: { realized_pnl: string | number; ai_reasoning: string | null }) => {
      const reasoning = r.ai_reasoning ?? '';
      const win = Number(r.realized_pnl) > 0;
      const pbMatch = reasoning.match(/pb=(True|False)/i);
      const hasPb = pbMatch ? pbMatch[1].toLowerCase() === 'true' : false;
      const volMatch = reasoning.match(/vol(\d+\.?\d*)x/i);
      const vol = volMatch ? parseFloat(volMatch[1]) : 1.0;
      return { win, hasPb, vol };
    });

    const total = trades.length;
    const winRate = trades.filter(t => t.win).length / total;

    const withPb = trades.filter(t => t.hasPb);
    const withoutPb = trades.filter(t => !t.hasPb);
    const pbWinRate = withPb.length >= 3 ? withPb.filter(t => t.win).length / withPb.length : null;
    const noPbWinRate = withoutPb.length >= 3 ? withoutPb.filter(t => t.win).length / withoutPb.length : null;

    const highVol = trades.filter(t => t.vol >= 1.5);
    const lowVol = trades.filter(t => t.vol < 1.5);
    const highVolWinRate = highVol.length >= 3 ? highVol.filter(t => t.win).length / highVol.length : null;
    const lowVolWinRate = lowVol.length >= 3 ? lowVol.filter(t => t.win).length / lowVol.length : null;

    let thresholdBonus = 0;
    if (winRate < 0.25) thresholdBonus = 5;
    else if (winRate < 0.35) thresholdBonus = 3;
    else if (winRate < 0.45) thresholdBonus = 2;

    const requirePullback = pbWinRate !== null && noPbWinRate !== null
      && noPbWinRate < 0.30 && pbWinRate > noPbWinRate + 0.15;

    let minVolumeRatio = 1.0;
    if (lowVolWinRate !== null && highVolWinRate !== null && lowVolWinRate < 0.30) {
      minVolumeRatio = highVolWinRate >= 0.50 ? 2.0 : 1.5;
    }

    const pbStr = pbWinRate !== null
      ? `pb유${(pbWinRate * 100).toFixed(0)}% vs 무${((noPbWinRate ?? 0) * 100).toFixed(0)}%`
      : '';
    const summary = [
      `승률 ${(winRate * 100).toFixed(0)}%(${total}건)`,
      thresholdBonus > 0 ? `임계값+${thresholdBonus}` : '',
      requirePullback ? '눌림필수' : '',
      minVolumeRatio > 1.0 ? `거래량${minVolumeRatio}x+` : '',
      pbStr,
    ].filter(Boolean).join(' | ');

    logger.info(`🎯 승률피드백: ${summary}`, { component: COMPONENT });

    const result: WinRateFeedback = {
      recentWinRate: winRate, thresholdBonus, requirePullback, minVolumeRatio,
      sampleSize: total, summary,
    };
    _feedbackCache = { data: result, ts: now };
    return result;
  } catch (err) {
    logger.warn(`승률피드백 조회 실패: ${err}`, { component: COMPONENT });
    return neutral;
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
    const { getPaperBalance } = await import('../risk/engine.js');
    const balance = config.isPaper ? await getPaperBalance() : await getAccountBalance();
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
