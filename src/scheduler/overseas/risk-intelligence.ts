/**
 * 리스크 인텔리전스 — ATR 트레일링, 쿨다운, 섹터 한도, AI 보정, 부분 익절, 동적 TP/SL
 * 분할: vix-regime.ts, kelly.ts, patterns.ts
 */
import { SECTOR_CLASS } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { ctxMode, modePrefix } from './utils.js';
import type { GradualCooldown } from './types.js';
import type { RegimeAdjustment } from './vix-regime.js';

// ── re-export (기존 import 경로 유지) ──
export type { VixRegime, RegimeAdjustment } from './vix-regime.js';
export { getVixRegime } from './vix-regime.js';
export type { KellyResult } from './types.js';
export type { StockEVResult } from './kelly.js';
export { calcRollingKelly, calcStockEVMultipliers } from './kelly.js';
export type { TradingPattern } from './patterns.js';
export { extractTradingPatterns, getMemoryBlockedStocks } from './patterns.js';

export function calcDynamicTrailDrop(params: {
  sector: string;
  atrPct: number; // ATR(14) / 현재가 × 100
  maxPnlPct: number;
  adx?: number;   // ADX(14) — 트렌드 강도
  rsi?: number;   // RSI(14) — 과매수/과매도
}): number {
  const { sector, atrPct, maxPnlPct, adx, rsi } = params;
  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // ATR × 2.5 기반 (클램프는 모든 조정 후 마지막에 적용)
  const atrTrail = -(atrPct * 2.5);
  const minTrail = isHighBeta ? -12.0 : isDefense ? -6.0 : -8.0;
  const maxTrail = isHighBeta ? -5.0 : isDefense ? -3.0 : -4.0;
  let trail = atrTrail;

  // 트렌드 강도 기반 동적 조정 (강한 추세 → 넓은 트레일, 약한 추세 → 타이트)
  if (adx !== undefined && rsi !== undefined) {
    if (adx >= 30 && rsi >= 50 && rsi <= 70) {
      trail *= 1.20;
    } else if (adx < 20) {
      trail *= 0.85;
    }
    if (rsi > 75) {
      trail = Math.max(trail, -5.0);
    }
  }

  // 수익 단계별 타이트닝 (수익을 지킨다)
  if (maxPnlPct >= 25.0) trail = Math.max(trail, -4.0);
  else if (maxPnlPct >= 20.0) trail = Math.max(trail, -5.0);
  else if (maxPnlPct >= 15.0) trail = Math.max(trail, -6.0);

  // 모든 조정 후 최종 클램프
  trail = Math.max(minTrail, Math.min(maxTrail, trail));

  return trail;
}

export async function getGradualCooldown(isPaper?: boolean): Promise<GradualCooldown> {
  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(`
      SELECT COUNT(*) AS loss_count,
             COUNT(DISTINCT stock_code) AS stock_count
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
        )
    `, [mode]);
    const lossCount = Number(rows[0]?.loss_count ?? 0);

    if (lossCount >= 3) {
      return { level: 3, cooldownMs: 12 * 60 * 60_000, sizingPenalty: 0.65, message: `3연속 손절 → 12h 쿨다운 + 포지션 65%` };
    }
    if (lossCount >= 2) {
      return { level: 2, cooldownMs: 6 * 60 * 60_000, sizingPenalty: 0.80, message: `2연속 손절 → 6h 전체 쿨다운` };
    }
    if (lossCount >= 1) {
      return { level: 1, cooldownMs: 4 * 60 * 60_000, sizingPenalty: 1.0, message: `1회 손절 → 해당 종목 4h 쿨다운` };
    }
    return { level: 0, cooldownMs: 0, sizingPenalty: 1.0, message: '' };
  } catch {
    return { level: 0, cooldownMs: 0, sizingPenalty: 1.0, message: '' };
  }
}

/** 점진적 쿨다운: 레벨별 쿨다운 시간에 걸리는 종목 Set 반환 */
export async function getGradualCooldownStocks(cooldown: GradualCooldown, isPaper?: boolean): Promise<Set<string>> {
  if (cooldown.level === 0) return new Set();

  try {
    const mode = ctxMode(isPaper);
    const intervalHours = Math.ceil(cooldown.cooldownMs / (60 * 60_000));
    const { rows } = await getPool().query(`
      SELECT DISTINCT stock_code
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $2
        AND status = 'FILLED'
        AND created_at >= NOW() - make_interval(hours => $1)
        AND (
          ai_reasoning LIKE '%손절%'
          OR ai_reasoning LIKE '%stopLoss%'
          OR ai_reasoning LIKE '%보유기한 초과%'
        )
    `, [intervalHours, mode]);
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch { return new Set(); }
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
}): { blocked: boolean; group: string; currentPct: number; limitPct: number } | null {
  const { targetSector, sectorValues, portfolioValue } = params;
  if (portfolioValue <= 0) return null;

  for (const [, group] of Object.entries(SECTOR_GROUP_LIMITS)) {
    if (!group.sectors.includes(targetSector)) continue;
    const groupValue = group.sectors.reduce((sum, s) => sum + (sectorValues.get(s) ?? 0), 0);
    const groupPct = (groupValue / portfolioValue) * 100;
    if (groupPct >= group.maxWeightPct) {
      return { blocked: true, group: group.label, currentPct: groupPct, limitPct: group.maxWeightPct };
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
    const { rows } = await getPool().query(`
      SELECT ai_reasoning FROM orders
      WHERE stock_code = $1
        AND trading_mode = $2
        AND trigger_source = 'OVERSEAS'
        AND status = 'FILLED'
        AND created_at >= NOW() - INTERVAL '5 days'
      ORDER BY created_at DESC LIMIT 10
    `, [code, mode]);

    const recentSells = rows.filter((r: { ai_reasoning: string | null }) =>
      String(r.ai_reasoning ?? '').includes('손절') || String(r.ai_reasoning ?? '').includes('stopLoss')
    );
    if (recentSells.length >= 3) {
      penalty += 0.20;
      reasons.push(`연속손절${recentSells.length}회(블랙)`);
    } else if (recentSells.length >= 2) {
      penalty += 0.15;
      reasons.push(`연속손절${recentSells.length}회`);
    }
  } catch { /* skip */ }

  if (vix && vix > 25) { penalty += 0.05; reasons.push(`VIX=${vix.toFixed(0)}`); }
  if (sectorDown) { penalty += 0.05; reasons.push('섹터하락'); }

  return { penalty: Math.min(0.20, penalty), reasons };
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

export function getPartialTpStages(sector: string): PartialTpStage[] {
  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // 부분익절: 노이즈 스킵 — 1단계 트리거 상향 (일간 변동 범위 밖에서만 확정)
  if (isHighBeta) {
    return [
      { stage: 1, triggerPct: 3.5, sellRatio: 0.15 },  // +3.5% → 15% (기존 2.0%, 고베타 일간 변동 2-3%)
      { stage: 2, triggerPct: 6.0, sellRatio: 0.15 },
      { stage: 3, triggerPct: 10.0, sellRatio: 0.20 },
      { stage: 4, triggerPct: 15.0, sellRatio: 0.20 },
      { stage: 5, triggerPct: 22.0, sellRatio: 0.25 },
    ];
  }
  if (isDefense) {
    return [
      { stage: 1, triggerPct: 2.5, sellRatio: 0.20 },  // +2.5% (기존 1.5%, 방어주 일간 변동 0.5-1.5%)
      { stage: 2, triggerPct: 4.0, sellRatio: 0.20 },
      { stage: 3, triggerPct: 6.0, sellRatio: 0.25 },
      { stage: 4, triggerPct: 9.0, sellRatio: 0.25 },
    ];
  }
  // 일반 종목
  return [
    { stage: 1, triggerPct: 3.0, sellRatio: 0.15 },   // +3.0% (기존 1.5%, 일간 노이즈 1-2% 스킵)
    { stage: 2, triggerPct: 5.0, sellRatio: 0.15 },   // +5.0% → 추가 15%
    { stage: 3, triggerPct: 8.0, sellRatio: 0.20 },   // +8.0% → 추가 20% (누적 50%)
    { stage: 4, triggerPct: 12.0, sellRatio: 0.20 },
    { stage: 5, triggerPct: 18.0, sellRatio: 0.25 },
  ];
}

/** DB에서 현재 부분익절 단계 조회 (paper/live 분리) */
export async function getPartialTpStageNum(code: string, isPaper?: boolean): Promise<number> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = $1",
      [`${modePrefix(isPaper)}partial_tp_stage_${code}`],
    );
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

/** 부분익절 단계 저장 (paper/live 분리) */
export async function setPartialTpStageNum(code: string, stage: number, isPaper?: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`${modePrefix(isPaper)}partial_tp_stage_${code}`, String(stage)],
  ).catch(() => {});
}

/** 부분익절 단계 초기화 (포지션 청산 시, paper/live 분리) */
export async function clearPartialTpStageNum(code: string, isPaper?: boolean): Promise<void> {
  await getPool().query(
    "DELETE FROM overseas_state WHERE key = $1",
    [`${modePrefix(isPaper)}partial_tp_stage_${code}`],
  ).catch(() => {});
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
  const { sector, adx, rsi, aiConfidence = 0.5, aiAction = 'HOLD', aiScore, vixRegime, isMomentum = false, tunerOverrides, atrPct } = params;

  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // Trade Tuner 오버라이드가 있으면 base 값 조정
  // TP 현실화: 소규모 포트폴리오 자본 회전 → 5~8% 도달 가능 목표
  const tunerTpAdj = tunerOverrides?.tp_base_pct;
  const tunerSlAdj = tunerOverrides?.sl_base_pct;
  const baseTp = tunerTpAdj != null
    ? tunerTpAdj
    : isHighBeta ? 8.0 : isMediumBeta ? 6.0 : isDefense ? 5.0 : 6.0;
  const baseSl = tunerSlAdj != null
    ? tunerSlAdj
    : isHighBeta ? 6.0 : isMediumBeta ? 4.0 : isDefense ? 3.0 : 4.0;

  const momentumExt = adx >= 35 && rsi >= 45 && rsi <= 68 ? 10.0
                    : adx >= 28 && rsi >= 45 && rsi <= 70 ? 5.0
                    : isMomentum ? 3.0 : 0;

  const overboughtCut = rsi > 78 ? -8.0 : rsi > 75 ? -5.0 : 0;

  const aiTpBonus = aiAction === 'BUY' && aiConfidence >= 0.85 ? 5.0
                  : aiAction === 'BUY' && aiConfidence >= 0.75 ? 2.5
                  : aiAction === 'HOLD' && aiConfidence >= 0.80 ? 1.0
                  : aiAction === 'SELL' ? -5.0
                  : 0;

  const scoreTpBonus = aiScore != null
    ? aiScore >= 90 ? 5.0 : aiScore >= 80 ? 2.5 : aiScore >= 70 ? 1.0 : 0
    : 0;

  const vixTpAdj = vixRegime.regime === 'CRISIS' ? -7.0
                 : vixRegime.regime === 'STRESS' ? -3.0
                 : vixRegime.regime === 'CALM' ? 3.0
                 : 0;

  const aiSlAdj = aiAction === 'SELL' && aiConfidence >= 0.80 ? -1.0 : 0;
  const scoreSlAdj = aiScore != null && aiScore >= 85 ? 0.5 : 0;

  // TP 바닥: base와 동일 레벨 (보너스만 올릴 수 있게)
  const tpFloor = isHighBeta ? 6.0 : isMediumBeta ? 5.0 : isDefense ? 4.0 : 5.0;
  const tpCeil = isHighBeta ? 40.0 : isMediumBeta ? 35.0 : isDefense ? 25.0 : 35.0;
  const tpPct = Math.min(tpCeil, Math.max(tpFloor, baseTp + momentumExt + overboughtCut + aiTpBonus + scoreTpBonus + vixTpAdj));
  let slPct = Math.max(isHighBeta ? 5.0 : 2.5, baseSl + aiSlAdj + scoreSlAdj);

  // ATR 기반 SL 바닥: 최소 2×ATR% (일간 변동성의 2배 — 노이즈 손절 방지)
  // 예: NVDA ATR 3.5% → SL 최소 7%, 기존 5% SL에 걸리던 허위손절 제거
  if (atrPct && atrPct > 0) {
    const atrFloor = Math.round(atrPct * 2.0 * 10) / 10;
    if (atrFloor > slPct) {
      slPct = Math.min(atrFloor, isHighBeta ? 12.0 : 8.0); // 안전 상한: HIGH_BETA 12%, 기타 8%
    }
  }

  const parts: string[] = [`base${baseTp}`];
  if (momentumExt) parts.push(`mom${momentumExt > 0 ? '+' : ''}${momentumExt}`);
  if (overboughtCut) parts.push(`rsi${overboughtCut}`);
  if (aiTpBonus) parts.push(`AI${aiTpBonus > 0 ? '+' : ''}${aiTpBonus}`);
  if (scoreTpBonus) parts.push(`s${aiScore}+${scoreTpBonus}`);
  if (vixTpAdj) parts.push(`VIX${vixTpAdj > 0 ? '+' : ''}${vixTpAdj}`);
  if (atrPct && atrPct > 0) parts.push(`ATR${atrPct.toFixed(1)}`);

  return { tpPct, slPct, tpLabel: parts.join('/') };
}
