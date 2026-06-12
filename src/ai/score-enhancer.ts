/**
 * 🎯 Score Enhancer — 외부 무료 신호로 AI 점수 후처리 가산
 *
 * CEO 지시 (2026-06-12): "AI 점수판정 더 잘되게 반응 더 좋게"
 *   "점수판정이 잘나와야 수동으로 매수 걸 수도 있음"
 *
 * 원칙: Gemini ensemble은 그대로. 후처리 가산만.
 *
 * 통합 신호 (이미 만든 무료 API):
 *  1. FRED 매크로 (-3 ~ +5)
 *  2. SEC EDGAR Form 4 (인사이더 매수 +5~+15) — US 종목만
 *  3. Reddit/WSB spike (+2~+15) — US 종목만
 *  4. Polygon IV (-10 ~ +3) — US 종목만
 *  5. FinBERT 뉴스 sentiment (별도 호출 시)
 *  6. KIS 실시간 거래량 spike (+3~+10) — 빠르게 검증 가능
 *  7. 시간대별 가중치 (황금구간 momentum +2)
 *
 * 출력: 원본 점수 + 가산 = 최종 점수 (0~99 클램프)
 */

import { logger } from '../utils/logger.js';

const COMP = 'SCORE_ENH';

export interface ScoreEnhancement {
  originalScore: number;
  finalScore: number;
  delta: number;
  breakdown: Array<{ source: string; delta: number; reason: string }>;
}

interface EnhanceContext {
  stockCode: string;
  isUs?: boolean;
  volumeRatio?: number; // 평균 대비 (1.0 = 평균, 3.0 = 3배)
  changePct?: number; // 당일 등락률
}

async function getMacroBoost(): Promise<{ delta: number; reason: string } | null> {
  try {
    const { getFredMacroAdjustment } = await import('../market/fred-macro.js');
    const r = await getFredMacroAdjustment();
    if (r.score === 0) return null;
    // FRED 매크로 점수는 시장 전체 — 종목 점수에 1/3로 반영
    const delta = Math.round(r.score / 3);
    if (delta === 0) return null;
    return {
      delta,
      reason: `매크로 ${r.score > 0 ? '+' : ''}${r.score}: ${r.reasons.slice(0, 2).join(', ')}`,
    };
  } catch {
    return null;
  }
}

async function getInsiderBoost(ticker: string): Promise<{ delta: number; reason: string } | null> {
  try {
    const { getInsiderSignal } = await import('../market/sec-edgar.js');
    const sig = await getInsiderSignal(ticker);
    if (!sig || sig.scoreAdjustment === 0) return null;
    return { delta: sig.scoreAdjustment, reason: sig.reason };
  } catch {
    return null;
  }
}

async function getRedditBoost(ticker: string): Promise<{ delta: number; reason: string } | null> {
  try {
    const { getMentionForTicker } = await import('../market/reddit-mentions.js');
    const m = await getMentionForTicker(ticker);
    if (!m || m.scoreAdjustment === 0) return null;
    return {
      delta: m.scoreAdjustment,
      reason: `Reddit spike x${m.spikeRatio.toFixed(1)} (멘션 ${m.count1h}건/1h)`,
    };
  } catch {
    return null;
  }
}

async function getIvBoost(ticker: string): Promise<{ delta: number; reason: string } | null> {
  try {
    const { getOptionsIv } = await import('../market/polygon-iv.js');
    const iv = await getOptionsIv(ticker);
    if (!iv || iv.scoreAdjustment === 0) return null;
    return {
      delta: iv.scoreAdjustment,
      reason: iv.warning ?? `IV rank ${iv.ivRank30d.toFixed(0)}`,
    };
  } catch {
    return null;
  }
}

function getVolumeBoost(volumeRatio: number | undefined, changePct: number | undefined): { delta: number; reason: string } | null {
  if (volumeRatio == null || changePct == null) return null;
  // 거래량 spike + 상승 → 강한 매수 신호
  if (volumeRatio >= 3.0 && changePct >= 1.5) {
    return { delta: 10, reason: `거래량 ${volumeRatio.toFixed(1)}x + 상승 ${changePct.toFixed(1)}%` };
  }
  if (volumeRatio >= 2.0 && changePct >= 0.5) {
    return { delta: 5, reason: `거래량 ${volumeRatio.toFixed(1)}x + 상승` };
  }
  if (volumeRatio >= 1.5 && changePct >= 0) {
    return { delta: 3, reason: `거래량 ${volumeRatio.toFixed(1)}x 활발` };
  }
  // 거래량 매우 적음 + 하락 → 경계
  if (volumeRatio < 0.5 && changePct < -1.0) {
    return { delta: -5, reason: `거래량 ${volumeRatio.toFixed(1)}x 부족 + 하락` };
  }
  return null;
}

function getTimePhaseBoost(): { delta: number; reason: string } | null {
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const t = kstH * 100 + kstM;
  // 황금구간 KR (09:30~10:20, 13:00~15:00) → momentum 가중 +2
  if ((t >= 930 && t < 1020) || (t >= 1300 && t < 1500)) {
    return { delta: 2, reason: '황금구간 모멘텀 가중' };
  }
  // 마의시간은 가산 X (entry-timing-guard가 차단)
  return null;
}

/**
 * AI 점수 후처리 가산
 *
 * @param originalScore 원본 composite_score
 * @param ctx 종목/거래량 정보
 */
export async function enhanceScore(
  originalScore: number,
  ctx: EnhanceContext,
): Promise<ScoreEnhancement> {
  const breakdown: ScoreEnhancement['breakdown'] = [];

  // 공통 신호: 매크로 + 거래량 + 시간대
  const [macro, vol, phase] = await Promise.all([
    getMacroBoost(),
    Promise.resolve(getVolumeBoost(ctx.volumeRatio, ctx.changePct)),
    Promise.resolve(getTimePhaseBoost()),
  ]);
  if (macro) breakdown.push({ source: 'FRED', delta: macro.delta, reason: macro.reason });
  if (vol) breakdown.push({ source: 'VOL', delta: vol.delta, reason: vol.reason });
  if (phase) breakdown.push({ source: 'TIME', delta: phase.delta, reason: phase.reason });

  // US 종목 추가 신호: EDGAR + Reddit + IV
  if (ctx.isUs) {
    const [edgar, reddit, iv] = await Promise.all([
      getInsiderBoost(ctx.stockCode),
      getRedditBoost(ctx.stockCode),
      getIvBoost(ctx.stockCode),
    ]);
    if (edgar) breakdown.push({ source: 'EDGAR', delta: edgar.delta, reason: edgar.reason });
    if (reddit) breakdown.push({ source: 'WSB', delta: reddit.delta, reason: reddit.reason });
    if (iv) breakdown.push({ source: 'IV', delta: iv.delta, reason: iv.reason });
  }

  const totalDelta = breakdown.reduce((s, b) => s + b.delta, 0);
  const finalScore = Math.max(0, Math.min(99, originalScore + totalDelta));

  if (totalDelta !== 0) {
    logger.debug(
      `[${ctx.stockCode}] ${originalScore} → ${finalScore} (Δ${totalDelta >= 0 ? '+' : ''}${totalDelta})`,
      { component: COMP },
    );
  }

  return {
    originalScore,
    finalScore,
    delta: totalDelta,
    breakdown,
  };
}

/** 배치 가산 — 여러 종목 동시 처리 */
export async function enhanceScoreBatch(
  scores: Array<{ stock_code: string; composite_score: number; volumeRatio?: number; changePct?: number }>,
  isUs = false,
): Promise<Map<string, ScoreEnhancement>> {
  const result = new Map<string, ScoreEnhancement>();
  // 동시 처리 시 외부 API rate limit 보호 — 5개씩 직렬 배치
  const CHUNK = 5;
  for (let i = 0; i < scores.length; i += CHUNK) {
    const chunk = scores.slice(i, i + CHUNK);
    const enhanced = await Promise.all(
      chunk.map((s) =>
        enhanceScore(s.composite_score, {
          stockCode: s.stock_code,
          isUs,
          volumeRatio: s.volumeRatio,
          changePct: s.changePct,
        }).catch(() => null),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      const e = enhanced[j];
      if (e) result.set(chunk[j].stock_code, e);
    }
    // chunk 사이 300ms 쿨다운 (외부 API rate limit 안전 마진)
    if (i + CHUNK < scores.length) await new Promise((r) => setTimeout(r, 300));
  }
  return result;
}
