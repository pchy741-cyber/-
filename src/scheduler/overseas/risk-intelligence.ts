/**
 * 리스크 인텔리전스 — ATR 트레일링, 쿨다운, 섹터 한도, AI 보정, 부분 익절, 동적 TP/SL
 * 분할: vix-regime.ts, kelly.ts, patterns.ts
 */
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { OVERSEAS_FEE_PCT, SECTOR_CLASS } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import type { GradualCooldown } from './types.js';
import { ctxMode, modePrefix } from './utils.js';
import type { RegimeAdjustment } from './vix-regime.js';

export type { StockEVResult } from './kelly.js';
export { calcRollingKelly, calcStockEVMultipliers } from './kelly.js';
export type { TradingPattern } from './patterns.js';
export { extractTradingPatterns, getMemoryBlockedStocks } from './patterns.js';
export type { KellyResult } from './types.js';
// ── re-export (기존 import 경로 유지) ──
export type { RegimeAdjustment, VixRegime } from './vix-regime.js';
export { getVixRegime } from './vix-regime.js';

export function calcDynamicTrailDrop(params: {
  sector: string;
  atrPct: number; // ATR(14) / 현재가 × 100
  maxPnlPct: number;
  adx?: number; // ADX(14) — 트렌드 강도
  rsi?: number; // RSI(14) — 과매수/과매도
}): number {
  const { sector, atrPct, maxPnlPct, adx, rsi } = params;
  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // v10.9.4: ATR × 2.0 기반 (기존 2.5 → 2.0) + 트레일 범위 축소 (수익 반납 최소화)
  const atrTrail = -(atrPct * 2.0);
  const minTrail = isHighBeta ? -8.0 : isDefense ? -4.0 : -6.0;
  const maxTrail = isHighBeta ? -4.0 : isDefense ? -2.5 : -3.0;
  let trail = atrTrail;

  // 트렌드 강도 기반 동적 조정 (강한 추세 → 넓은 트레일, 약한 추세 → 타이트)
  if (adx !== undefined && rsi !== undefined) {
    if (adx >= 30 && rsi >= 50 && rsi <= 70) {
      trail *= 1.2;
    } else if (adx < 20) {
      trail *= 0.85;
    }
    if (rsi > 75) {
      trail = Math.max(trail, -5.0);
    }
  }

  // 기본 범위 클램프 (trend/rsi 조정 후)
  trail = Math.max(minTrail, Math.min(maxTrail, trail));

  // 수익 단계별 타이트닝 — 클램프 이후 적용 (수익 보호가 범위 제한보다 우선)
  if (maxPnlPct >= 25.0) trail = Math.max(trail, -4.0);
  else if (maxPnlPct >= 20.0) trail = Math.max(trail, -5.0);
  else if (maxPnlPct >= 15.0) trail = Math.max(trail, -6.0);

  return trail;
}

export async function getGradualCooldown(isPaper?: boolean): Promise<GradualCooldown> {
  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT COUNT(*) AS loss_count,
             COUNT(DISTINCT stock_code) AS stock_count
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
        )
    `,
      [mode],
    );
    const lossCount = Number(rows[0]?.loss_count ?? 0);
    const stockCount = Number(rows[0]?.stock_count ?? 0);

    // v12.2: 쿨다운 임계값 완화 (기존 2/3건 → 4/6건)
    // 근거: 조정장에서 2-3건 손절은 상관관계 손실(시장 전체 하락)이지 전략 실패가 아님
    // 추가: 섹터 집중도 감지 — 손절 종목이 2개 이하(동일 섹터 집중)면 전체 쿨다운 대신 완화
    const isSectorConcentrated = stockCount <= 2 && lossCount >= 3; // 같은 1-2종목 반복 손절

    if (lossCount >= 6) {
      return {
        level: 3,
        cooldownMs: 8 * 60 * 60_000, // 12h→8h (기회비용 감소)
        sizingPenalty: 0.65,
        message: `${lossCount}건 손절 → 8h 쿨다운 + 포지션 65%`,
      };
    }
    if (lossCount >= 4) {
      // 섹터 집중 손실이면 Lv1로 완화 (전체 차단 불필요)
      if (isSectorConcentrated) {
        return { level: 1, cooldownMs: 4 * 60 * 60_000, sizingPenalty: 0.9, message: `섹터집중 ${lossCount}건 → 해당종목만 4h 쿨다운` };
      }
      return { level: 2, cooldownMs: 4 * 60 * 60_000, sizingPenalty: 0.8, message: `${lossCount}건 손절 → 4h 전체 쿨다운` };
    }
    if (lossCount >= 2) {
      return { level: 1, cooldownMs: 2 * 60 * 60_000, sizingPenalty: 1.0, message: `${lossCount}건 손절 → 해당 종목 2h 쿨다운` };
    }
    return { level: 0, cooldownMs: 0, sizingPenalty: 1.0, message: '' };
  } catch (e) {
    // Cooldown query failed — safe fallback to no cooldown
    const err = e as Error;
    if (err.message) { /* non-critical, logged by DB layer */ }
    return { level: 0, cooldownMs: 0, sizingPenalty: 1.0, message: '' };
  }
}

/** 점진적 쿨다운: 레벨별 쿨다운 시간에 걸리는 종목 Set 반환 */
export async function getGradualCooldownStocks(cooldown: GradualCooldown, isPaper?: boolean): Promise<Set<string>> {
  if (cooldown.level === 0) return new Set();

  try {
    const mode = ctxMode(isPaper);
    const intervalHours = Math.ceil(cooldown.cooldownMs / (60 * 60_000));
    const { rows } = await getPool().query(
      `
      SELECT DISTINCT stock_code
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
        AND status = 'FILLED'
        AND created_at >= NOW() - make_interval(hours => $1)
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
        )
    `,
      [intervalHours, mode],
    );
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch (e) {
    // Cooldown stock query failed — safe fallback to empty set
    const err = e as Error;
    if (err.message) { /* non-critical */ }
    return new Set();
  }
}

export const SECTOR_GROUP_LIMITS: Record<string, { sectors: string[]; maxWeightPct: number; label: string }> = {
  US_TECH: { sectors: ['AI_SEMI', 'TECH', 'CLOUD', 'GROWTH'], maxWeightPct: 60, label: 'US 테크+반도체' },
  US_DEFENSE: { sectors: ['DEFENSE', 'INDUSTRIAL', 'INFRA'], maxWeightPct: 35, label: '방산+산업' },
  US_HEALTH_FIN: { sectors: ['HEALTH', 'FINANCE'], maxWeightPct: 30, label: '헬스+금융' },
  US_EV: { sectors: ['EV', 'CRYPTO'], maxWeightPct: 20, label: 'EV+크립토' },
  JAPAN: { sectors: ['JP_AUTO', 'JP_TECH', 'JP_BANK'], maxWeightPct: 25, label: '일본 ADR' },
  TAIWAN: { sectors: ['TW_SEMI'], maxWeightPct: 15, label: '대만 반도체' },
};

export function checkSectorGroupLimit(params: {
  targetSector: string;
  sectorValues: Map<string, number>;
  portfolioValue: number;
  holdingCount?: number;
}): { blocked: boolean; group: string; currentPct: number; limitPct: number } | null {
  const { targetSector, sectorValues, portfolioValue, holdingCount } = params;
  if (portfolioValue <= 0) return null;

  for (const [, group] of Object.entries(SECTOR_GROUP_LIMITS)) {
    if (!group.sectors.includes(targetSector)) continue;
    const groupValue = group.sectors.reduce((sum, s) => sum + (sectorValues.get(s) ?? 0), 0);
    const groupPct = (groupValue / portfolioValue) * 100;
    // 소형 포트폴리오(4종목 이하): 섹터캡 +15% 완화 (2종목에 1종목 65%는 자연스러움)
    const effectiveLimit = (holdingCount ?? 99) <= 4 ? group.maxWeightPct + 15 : group.maxWeightPct;
    if (groupPct >= effectiveLimit) {
      return { blocked: true, group: group.label, currentPct: groupPct, limitPct: effectiveLimit };
    }
  }
  return null;
}

export interface UncertaintyPenalty {
  penalty: number;
  reasons: string[];
}

export async function calcUncertaintyPenalty(params: {
  code: string;
  vix?: number;
  sectorDown?: boolean;
  isPaper?: boolean;
}): Promise<UncertaintyPenalty> {
  const { code, vix, sectorDown, isPaper } = params;
  let penalty = 0;
  const reasons: string[] = [];

  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT ai_reasoning FROM orders
      WHERE stock_code = $1
        AND (trading_mode = $2::text OR ($2::text = 'paper' AND trading_mode = 'p_arch'))
        AND trigger_source = 'OVERSEAS'
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '5 days'
      ORDER BY created_at DESC LIMIT 10
    `,
      [code, mode],
    );

    const recentSells = rows.filter(
      (r: { ai_reasoning: string | null }) =>
        String(r.ai_reasoning ?? '').includes('손절') || String(r.ai_reasoning ?? '').includes('stopLoss'),
    );
    if (recentSells.length >= 3) {
      penalty += 0.2;
      reasons.push(`연속손절${recentSells.length}회(블랙)`);
    } else if (recentSells.length >= 2) {
      penalty += 0.15;
      reasons.push(`연속손절${recentSells.length}회`);
    }
  } catch (e) {
    // Uncertainty penalty DB query failed — continue with partial result
    const err = e as Error;
    if (err.message) { /* logged via caller if significant */ }
  }

  if (vix && vix > 25) {
    penalty += 0.05;
    reasons.push(`VIX=${vix.toFixed(0)}`);
  }
  if (sectorDown) {
    penalty += 0.05;
    reasons.push('섹터하락');
  }

  return { penalty: Math.min(0.35, penalty), reasons };
}

/** 불확실성 보정 적용 — effective confidence 반환 */
export function applyUncertaintyPenalty(rawConfidence: number, penalty: UncertaintyPenalty): number {
  return Math.max(0, rawConfidence * (1 - penalty.penalty));
}

export interface PartialTpStage {
  stage: number;
  triggerPct: number;
  sellRatio: number;
}

export function getPartialTpStages(sector: string, bucket?: string): PartialTpStage[] {
  // SNIPER: 고확신 집중 포지션 — 4%@30% 선확정 후 8%+ 잔여 전량
  if (bucket === 'SNIPER') {
    return [
      { stage: 1, triggerPct: 4.0, sellRatio: 0.30 },
      { stage: 2, triggerPct: 8.0, sellRatio: 0.70 },
    ];
  }

  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // v10.9: 부분익절 현실화 — 1단계 빠른 수익 확정 (25~30%), 트리거 하향
  if (isHighBeta) {
    return [
      { stage: 1, triggerPct: 2.0, sellRatio: 0.25 }, // v10.9: +2%→25% (기존 3.5%→15%)
      { stage: 2, triggerPct: 4.0, sellRatio: 0.20 },
      { stage: 3, triggerPct: 7.0, sellRatio: 0.20 },
      { stage: 4, triggerPct: 12.0, sellRatio: 0.20 },
      { stage: 5, triggerPct: 18.0, sellRatio: 0.15 },
    ];
  }
  if (isDefense) {
    return [
      { stage: 1, triggerPct: 1.5, sellRatio: 0.30 }, // v10.9: +1.5%→30% (방어주 빠른 확정)
      { stage: 2, triggerPct: 3.0, sellRatio: 0.25 },
      { stage: 3, triggerPct: 5.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 8.0, sellRatio: 0.20 },
    ];
  }
  // 일반 종목
  return [
    { stage: 1, triggerPct: 1.5, sellRatio: 0.25 }, // v10.9: +1.5%→25% (기존 3.0%→15%)
    { stage: 2, triggerPct: 3.0, sellRatio: 0.20 },
    { stage: 3, triggerPct: 5.0, sellRatio: 0.20 },
    { stage: 4, triggerPct: 8.0, sellRatio: 0.20 },
    { stage: 5, triggerPct: 13.0, sellRatio: 0.15 },
  ];
}

/** DB에서 현재 부분익절 단계 조회 (paper/live 분리, 메모리 캐시 적용) */
export async function getPartialTpStageNum(code: string, isPaper?: boolean): Promise<number> {
  const cacheKey = `ov_tp_stage:${modePrefix(isPaper)}${code}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached != null) return cached;
  try {
    const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [
      `${modePrefix(isPaper)}partial_tp_stage_${code}`,
    ]);
    const raw = rows.length > 0 ? Number(rows[0].value) : 0;
    const val = Number.isFinite(raw) ? raw : 0;
    cacheSet(cacheKey, val, 300); // 5min TTL
    return val;
  } catch (e) {
    // Partial TP stage query failed — safe fallback to stage 0
    const err = e as Error;
    if (err.message) { /* non-critical */ }
    return 0;
  }
}

/** 부분익절 단계 저장 (paper/live 분리) */
export async function setPartialTpStageNum(code: string, stage: number, isPaper?: boolean): Promise<void> {
  const cacheKey = `ov_tp_stage:${modePrefix(isPaper)}${code}`;
  cacheSet(cacheKey, stage, 300); // 캐시 즉시 갱신
  await getPool()
    .query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`${modePrefix(isPaper)}partial_tp_stage_${code}`, String(stage)],
    )
    .catch(() => {});
}

/** 부분익절 단계 초기화 (포지션 청산 시, paper/live 분리) */
export async function clearPartialTpStageNum(code: string, isPaper?: boolean): Promise<void> {
  const cacheKey = `ov_tp_stage:${modePrefix(isPaper)}${code}`;
  cacheSet(cacheKey, 0, 300); // 캐시 초기화
  await getPool()
    .query('DELETE FROM overseas_state WHERE key = $1', [`${modePrefix(isPaper)}partial_tp_stage_${code}`])
    .catch(() => {});
}

export interface DynamicTpSlResult {
  tpPct: number;
  slPct: number;
  tpLabel: string;
}

export function calcDynamicTpSl(params: {
  sector: string;
  adx: number;
  rsi: number;
  aiConfidence?: number;
  aiAction?: string;
  aiScore?: number;
  vixRegime: RegimeAdjustment;
  isMomentum?: boolean;
  tunerOverrides?: Record<string, number>; // Trade Tuner 자동 최적화 값
  atrPct?: number; // ATR/가격 % — SL이 최소 2×ATR 보장 (노이즈 손절 방지)
}): DynamicTpSlResult {
  const {
    sector,
    adx,
    rsi,
    aiConfidence = 0.5,
    aiAction = 'HOLD',
    aiScore,
    vixRegime,
    isMomentum = false,
    tunerOverrides,
    atrPct,
  } = params;

  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // v10.9: TP/SL 현실화 — 소액 자본 회전 최적화
  // 기존 4~6% TP는 소액 계좌에서 대부분 미달 → 시간손절로 전환
  // 3.5/2.5/2.0% 기본 → 승자 빈도 ↑, 자본 회전 ↑
  const tunerTpAdj = tunerOverrides?.tp_base_pct;
  const tunerSlAdj = tunerOverrides?.sl_base_pct;
  const baseTp = tunerTpAdj != null ? tunerTpAdj : isHighBeta ? 4.5 : isMediumBeta ? 2.5 : isDefense ? 2.0 : 2.5;
  const baseSl = tunerSlAdj != null ? tunerSlAdj : isHighBeta ? 4.0 : isMediumBeta ? 2.5 : isDefense ? 2.0 : 2.5;

  const momentumExt =
    adx >= 35 && rsi >= 45 && rsi <= 68 ? 5.0 : adx >= 28 && rsi >= 45 && rsi <= 70 ? 2.0 : isMomentum ? 1.0 : 0;

  const overboughtCut = rsi > 78 ? -8.0 : rsi > 75 ? -5.0 : 0;

  const aiTpBonus =
    aiAction === 'BUY' && aiConfidence >= 0.85
      ? 5.0
      : aiAction === 'BUY' && aiConfidence >= 0.75
        ? 2.5
        : aiAction === 'HOLD' && aiConfidence >= 0.8
          ? 1.0
          : aiAction === 'SELL'
            ? -5.0
            : 0;

  const scoreTpBonus = aiScore != null ? (aiScore >= 90 ? 5.0 : aiScore >= 80 ? 2.5 : aiScore >= 70 ? 1.0 : 0) : 0;

  const vixTpAdj =
    vixRegime.regime === 'CRISIS' ? -5.0 : vixRegime.regime === 'STRESS' ? -2.0 : vixRegime.regime === 'CALM' ? 1.0 : 0;

  const aiSlAdj = aiAction === 'SELL' && aiConfidence >= 0.8 ? -1.0 : 0;
  const scoreSlAdj = aiScore != null && aiScore >= 85 ? 0.5 : 0;

  // v10.9: TP 바닥 = base + 수수료 (기존 6/4/4% → 3.5/2.5/2.0%)
  const roundTripFeePct = OVERSEAS_FEE_PCT * 2 * 100; // 0.7%
  const tpFloor = baseTp + roundTripFeePct;
  const tpCeil = isHighBeta ? 40.0 : isMediumBeta ? 35.0 : isDefense ? 25.0 : 35.0;
  let tpPct = Math.min(
    tpCeil,
    Math.max(tpFloor, baseTp + roundTripFeePct + momentumExt + overboughtCut + aiTpBonus + scoreTpBonus + vixTpAdj),
  );
  // v10.9: SL 하한 조정 (기존 HIGH_BETA 5% → 3%, 기타 2.5% → 2%)
  let slPct = Math.max(isHighBeta ? 3.0 : 2.0, baseSl + aiSlAdj + scoreSlAdj);

  // ATR 기반 SL: 항상 적용 — 고변동성은 SL 확대(노이즈 방지), 저변동성은 SL 타이트닝
  // v10.9.4: ATR SL 상한 축소 (기존 8/12% → 5/8%) — 과도한 SL 확대가 R:R < 1의 근본 원인
  if (atrPct && atrPct > 0) {
    if (atrPct < 1.5) {
      // 저변동성(ATR<1.5%): SL 타이트닝 — 최대 2.5% (불필요한 자본 노출 축소)
      slPct = Math.min(slPct, 2.5);
    } else {
      // 고변동성: 최소 1.5×ATR% (기존 2x → 1.5x — 노이즈 방어와 손실 제한 균형)
      const atrFloor = Math.round(atrPct * 1.5 * 10) / 10;
      if (atrFloor > slPct) {
        slPct = Math.min(atrFloor, isHighBeta ? 8.0 : 5.0); // 안전 상한: HIGH_BETA 8%, 기타 5%
      }
    }
  }

  // ── R:R 비율 검증 — v10.9.4: R:R < 1.5 시 SL 축소 우선 (기존: TP 확대 → 도달 불가능한 TP) ──
  const rr = tpPct / slPct;
  if (rr > 4.0) {
    tpPct = Math.round(slPct * 4.0 * 10) / 10;
  } else if (rr < 1.5) {
    // TP를 올리는 대신 SL을 줄여서 R:R 보정 (단, SL 하한 유지)
    const adjustedSl = Math.round((tpPct / 1.5) * 10) / 10;
    const slFloor = isHighBeta ? 3.0 : 2.0;
    if (adjustedSl >= slFloor) {
      slPct = adjustedSl;
    } else {
      // SL이 하한에 걸리면 TP 보정 (기존 방식 폴백)
      slPct = slFloor;
      tpPct = Math.round(slFloor * 1.5 * 10) / 10;
    }
  }

  const parts: string[] = [`base${baseTp}`];
  if (momentumExt) parts.push(`mom${momentumExt > 0 ? '+' : ''}${momentumExt}`);
  if (overboughtCut) parts.push(`rsi${overboughtCut}`);
  if (aiTpBonus) parts.push(`AI${aiTpBonus > 0 ? '+' : ''}${aiTpBonus}`);
  if (scoreTpBonus) parts.push(`s${aiScore}+${scoreTpBonus}`);
  if (vixTpAdj) parts.push(`VIX${vixTpAdj > 0 ? '+' : ''}${vixTpAdj}`);
  if (atrPct && atrPct > 0) parts.push(`ATR${atrPct.toFixed(1)}`);
  if (rr > 4.0) parts.push('RR>4→TP축소');
  else if (rr < 1.5) parts.push('RR<1.5→조정');

  return { tpPct, slPct, tpLabel: parts.join('/') };
}
