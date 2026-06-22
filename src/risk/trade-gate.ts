/**
 * 🚦 매매 게이트 시스템 (Trade Gate) — 오케스트레이터
 *
 * 분할 구조:
 * - trade-gate-types.ts — 인터페이스
 * - trade-gate-checks.ts — 개별 게이트 함수
 * - trade-gate-stats.ts — 승률/연패 통계 + 쿨다운
 * - trade-gate.ts (이 파일) — 통합 실행 + re-exports
 */

import { GATE } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { logger } from '../utils/logger.js';
import { chartVerificationGate, entryTimingGate, newsGate, regimeGate, volatilitySizing } from './trade-gate-checks.js';
import { cooldownGate, getWinRateStats } from './trade-gate-stats.js';

export type { MarketRegime } from './trade-gate-checks.js';
export {
  chartVerificationGate,
  detectRegime,
  entryTimingGate,
  regimeGate,
  volatilitySizing,
} from './trade-gate-checks.js';
export {
  cooldownGate,
  getCooldownStatus,
  getWinRateStats,
  resetCooldown,
  restoreCooldownResetAt,
} from './trade-gate-stats.js';
// ── Re-exports (기존 import 호환) ──
export type { CooldownStatus, GateInput, GateResult } from './trade-gate-types.js';

import type { GateInput, GateResult } from './trade-gate-types.js';

// ══════════════════════════════════════
//  기대값 게이트 (DB 의존 → 여기에 유지)
// ══════════════════════════════════════

export async function expectedValueGate(_input: GateInput): Promise<GateResult> {
  if (getCtxIsPaper()) {
    return { passed: true, reason: '모의투자 — 기대값 게이트 스킵', expectedValue: 0 };
  }

  const stats = await getWinRateStats(30);
  if (stats.totalTrades < 15) {
    return { passed: true, reason: `실거래이력 부족(${stats.totalTrades}건 < 15) — 기본 통과`, expectedValue: 0 };
  }

  const winRate = stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0.5;
  const lossRate = 1 - winRate;
  const ev = winRate * stats.avgWinPct - lossRate * Math.abs(stats.avgLossPct) - GATE.SLIPPAGE_PCT;

  // 학습 단계(30건 미만): 게이트 완화하여 거래 기회 확보 (사망 스파이럴 방지)
  const isLearningPhase = stats.totalTrades < 30;
  const evFloor = isLearningPhase ? -1.5 : -0.5;
  if (ev <= evFloor) {
    return {
      passed: false,
      reason: `기대값 음수: EV=${ev.toFixed(2)}% (승률${(winRate * 100).toFixed(0)}%, 바닥=${evFloor})`,
      expectedValue: ev,
    };
  }
  const wrFloor = isLearningPhase ? 0.15 : 0.2;
  if (winRate < wrFloor) {
    return {
      passed: false,
      reason: `승률 과소: ${(winRate * 100).toFixed(0)}% < ${(wrFloor * 100).toFixed(0)}%`,
      expectedValue: ev,
    };
  }

  return {
    passed: true,
    reason: `EV=${ev.toFixed(2)}% (승률${(winRate * 100).toFixed(0)}%, ${stats.totalTrades}건)`,
    expectedValue: ev,
  };
}

// ══════════════════════════════════════
//  통합 게이트 실행
// ══════════════════════════════════════

export async function runTradeGates(input: GateInput): Promise<GateResult> {
  const results: GateResult[] = [];

  // 매도는 항상 통과
  if (input.action !== 'BUY' && input.action !== 'AVERAGE_DOWN') {
    return { passed: true, reason: '매도 — 게이트 생략' };
  }

  // 연습모드: 모든 게이트 스킵 (백테스팅 데이터 최대 수집)
  if (getCtxIsPaper()) {
    return { passed: true, reason: '연습모드 — 게이트 전체 스킵', adjustedQuantity: input.quantity };
  }

  // 0. 진입 타이밍
  const timing = entryTimingGate(input);
  if (!timing.passed) {
    logger.debug(`🚦 [타이밍] ${input.stockCode}: ${timing.reason}`, { component: 'TRADE_GATE' });
    return timing;
  }
  results.push(timing);

  // 1. 연속손실 쿨다운
  const cooldown = await cooldownGate();
  if (!cooldown.passed) {
    logger.debug(`🚦 [쿨다운] ${input.stockCode}: ${cooldown.reason}`, { component: 'TRADE_GATE' });
    return cooldown;
  }
  results.push(cooldown);

  // 1-b. 뉴스/공시 게이트
  const news = await newsGate(input.stockCode);
  if (!news.passed) {
    logger.debug(`🚦 [뉴스게이트] ${input.stockCode}: ${news.reason}`, { component: 'TRADE_GATE' });
    return news;
  }
  results.push(news);

  // 2. 레짐 필터
  const regime = regimeGate(input);
  if (!regime.passed) {
    logger.debug(`🚦 [레짐] ${input.stockCode}: ${regime.reason}`, { component: 'TRADE_GATE' });
    return regime;
  }
  if (regime.adjustedQuantity !== undefined) {
    input = { ...input, quantity: regime.adjustedQuantity };
  }
  results.push(regime);

  // 3. 차트 검수
  const chart = chartVerificationGate(input);
  if (!chart.passed) {
    logger.debug(`🚦 [차트검수] ${input.stockCode}: ${chart.reason}`, { component: 'TRADE_GATE' });
    return chart;
  }
  results.push(chart);

  // 4. 기대값 필터
  const ev = await expectedValueGate(input);
  if (!ev.passed) {
    logger.debug(`🚦 [기대값] ${input.stockCode}: ${ev.reason}`, { component: 'TRADE_GATE' });
    return ev;
  }
  results.push(ev);

  // 5. 변동성 사이징
  const sizing = volatilitySizing(input);
  if (!sizing.passed) {
    logger.debug(`🚦 [사이징] ${input.stockCode}: ${sizing.reason}`, { component: 'TRADE_GATE' });
    return sizing;
  }

  const finalQty = Math.min(input.quantity, sizing.adjustedQuantity ?? input.quantity);
  const summary = results.map((r) => r.reason).join(' | ');
  logger.info(`✅ [게이트통과] ${input.stockCode}: ${finalQty}주 (${summary})`, { component: 'TRADE_GATE' });

  return {
    passed: true,
    reason: summary,
    adjustedQuantity: finalQty,
    riskRewardRatio: chart.riskRewardRatio,
    expectedValue: ev.expectedValue,
    regime: regime.regime,
  };
}
