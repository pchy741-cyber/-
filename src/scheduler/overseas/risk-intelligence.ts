/**
 * 리스크 인텔리전스 — ATR 트레일링, VIX 레짐, 쿨다운, 섹터 한도, AI 보정, Kelly, Memory Agent
 * 연구 근거: ATR trailing (MQL5 2025), VIX regime (VolatilityBox 2025),
 *           Kelly criterion (QuantifiedStrategies), PACIS 2025 uncertainty paper
 */
import { config } from '../../config/index.js';
import { getCtxIsPaper } from '../../config/context.js';
import { SECTOR_CLASS } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

/** 현재 컨텍스트의 trading_mode 문자열 반환 */
function ctxMode(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
}

// ══════════════════════════════════════════════════════════════
// 1. ATR 기반 동적 트레일링 스톱 (기존 고정% → 변동성 적응)
// ══════════════════════════════════════════════════════════════
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

  // ATR × 2.5 기반, 섹터별 min/max 클램핑
  const atrTrail = -(atrPct * 2.5);
  const minTrail = isHighBeta ? -12.0 : isDefense ? -6.0 : -8.0;
  const maxTrail = isHighBeta ? -5.0 : isDefense ? -3.0 : -4.0;
  let trail = Math.max(minTrail, Math.min(maxTrail, atrTrail));

  // 트렌드 강도 기반 동적 조정 (강한 추세 → 넓은 트레일, 약한 추세 → 타이트)
  if (adx !== undefined && rsi !== undefined) {
    if (adx >= 30 && rsi >= 50 && rsi <= 70) {
      // 강한 상승 추세: 트레일 20% 확대 (승자를 더 오래 보유)
      trail *= 1.20; // 예: -6% → -7.2% (더 넓게, 더 큰 하락 허용)
    } else if (adx < 20) {
      // 추세 약화: 트레일 15% 축소 (빨리 수익 확보)
      trail *= 0.85; // 예: -6% → -5.1% (더 타이트)
    }
    if (rsi > 75) {
      // 과매수: 트레일 강제 타이트닝 (반전 위험)
      trail = Math.max(trail, -5.0);
    }
  }

  // 수익 단계별 타이트닝 (수익을 지킨다)
  if (maxPnlPct >= 25.0) trail = Math.max(trail, -4.0);
  else if (maxPnlPct >= 20.0) trail = Math.max(trail, -5.0);
  else if (maxPnlPct >= 15.0) trail = Math.max(trail, -6.0);

  return trail;
}

// ══════════════════════════════════════════════════════════════
// 2. VIX 레짐 감지 + 파라미터 자동 전환
// ══════════════════════════════════════════════════════════════
export type VixRegime = 'CALM' | 'STRESS' | 'CRISIS';

export interface RegimeAdjustment {
  regime: VixRegime;
  confBoost: number;       // AI confidence threshold 조정 (+0.05 = 더 보수적)
  sizingMult: number;       // 포지션 사이즈 배율 (0.5 = 반감)
  allowNewBuy: boolean;     // 신규 매수 허용 여부
  trailTighten: number;     // 트레일링 스톱 타이트닝 (고점 수익 보호)
}

export function getVixRegime(vix: number): RegimeAdjustment {
  if (vix >= 30) {
    return {
      regime: 'CRISIS',
      confBoost: 0.10,    // AI threshold +10%p → 극고확신만 진입
      sizingMult: 0.3,    // 포지션 30%로 축소
      allowNewBuy: false,  // 신규 매수 금지
      trailTighten: 2.0,  // 트레일 2%p 타이트닝
    };
  }
  if (vix >= 20) {
    return {
      regime: 'STRESS',
      confBoost: 0.05,    // AI threshold +5%p
      sizingMult: 0.6,    // 포지션 60%로 축소
      allowNewBuy: true,
      trailTighten: 1.0,  // 트레일 1%p 타이트닝
    };
  }
  return {
    regime: 'CALM',
    confBoost: 0,
    sizingMult: 1.0,
    allowNewBuy: true,
    trailTighten: 0,
  };
}

// ══════════════════════════════════════════════════════════════
// 3. 점진적 쿨다운 (손절 횟수별 차등)
// ══════════════════════════════════════════════════════════════
export interface GradualCooldown {
  level: number;           // 0=쿨다운 없음, 1=경미, 2=중간, 3=심각
  cooldownMs: number;      // 쿨다운 시간 (밀리초)
  sizingPenalty: number;   // 포지션 사이즈 패널티 배율 (1.0=정상)
  message: string;
}

export async function getGradualCooldown(isPaper?: boolean): Promise<GradualCooldown> {
  try {
    const mode = ctxMode(isPaper);
    // 24시간 내 손절 횟수 카운트
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
      return {
        level: 3,
        cooldownMs: 24 * 60 * 60_000,  // 24시간
        sizingPenalty: 0.5,             // 포지션 50% 축소
        message: `3연속 손절 → 24h 쿨다운 + 포지션 50% 축소`,
      };
    }
    if (lossCount >= 2) {
      return {
        level: 2,
        cooldownMs: 12 * 60 * 60_000,  // 12시간
        sizingPenalty: 0.7,             // 포지션 30% 축소
        message: `2연속 손절 → 12h 전체 쿨다운`,
      };
    }
    if (lossCount >= 1) {
      return {
        level: 1,
        cooldownMs: 4 * 60 * 60_000,   // 4시간
        sizingPenalty: 1.0,             // 사이즈 유지
        message: `1회 손절 → 해당 종목 4h 쿨다운`,
      };
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

// ══════════════════════════════════════════════════════════════
// 4. 상관관계 기반 섹터 포지션 한도
// ══════════════════════════════════════════════════════════════
// 섹터 그룹별 상관관계 매트릭스 (근사값 — Fidelity/BlackRock 2025 데이터 기반)
export const SECTOR_GROUP_LIMITS: Record<string, { sectors: string[]; maxWeightPct: number; label: string }> = {
  US_TECH: {
    sectors: ['AI_SEMI', 'TECH', 'CLOUD', 'GROWTH'],
    maxWeightPct: 60,
    label: 'US 테크+반도체',
  },
  US_DEFENSE: {
    sectors: ['DEFENSE', 'INDUSTRIAL', 'INFRA'],
    maxWeightPct: 35,
    label: '방산+산업',
  },
  US_HEALTH_FIN: {
    sectors: ['HEALTH', 'FINANCE'],
    maxWeightPct: 30,
    label: '헬스+금융',
  },
  US_EV: {
    sectors: ['EV', 'CRYPTO'],
    maxWeightPct: 20,
    label: 'EV+크립토',
  },
  JAPAN: {
    sectors: ['JP_AUTO', 'JP_TECH', 'JP_BANK'],
    maxWeightPct: 25,
    label: '일본 ADR',
  },
  TAIWAN: {
    sectors: ['TW_SEMI'],
    maxWeightPct: 15,
    label: '대만 반도체',
  },
};

export function checkSectorGroupLimit(params: {
  targetSector: string;
  sectorValues: Map<string, number>;
  portfolioValue: number;
}): { blocked: boolean; group: string; currentPct: number; limitPct: number } | null {
  const { targetSector, sectorValues, portfolioValue } = params;
  if (portfolioValue <= 0) return null;

  for (const [groupName, group] of Object.entries(SECTOR_GROUP_LIMITS)) {
    if (!group.sectors.includes(targetSector)) continue;
    const groupValue = group.sectors.reduce((sum, s) => sum + (sectorValues.get(s) ?? 0), 0);
    const groupPct = (groupValue / portfolioValue) * 100;
    if (groupPct >= group.maxWeightPct) {
      return { blocked: true, group: group.label, currentPct: groupPct, limitPct: group.maxWeightPct };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 5. 불확실성 보정 AI confidence
// ══════════════════════════════════════════════════════════════
export interface UncertaintyPenalty {
  penalty: number;       // 0~0.20 범위
  reasons: string[];
}

export async function calcUncertaintyPenalty(params: {
  code: string;
  vix?: number;
  sectorDown?: boolean; // 섹터 전체 하락 여부
  isPaper?: boolean;
}): Promise<UncertaintyPenalty> {
  const { code, vix, sectorDown, isPaper } = params;
  let penalty = 0;
  const reasons: string[] = [];

  // 1. 최근 5거래일 AI 점수 변동성 (DB에서 조회)
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

    // 같은 종목의 최근 거래 성적 확인 — 연속 손실이면 penalty
    const recentSells = rows.filter((r: { ai_reasoning: string | null }) =>
      String(r.ai_reasoning ?? '').includes('손절') || String(r.ai_reasoning ?? '').includes('stopLoss')
    );
    if (recentSells.length >= 2) {
      penalty += 0.08;
      reasons.push(`연속손절${recentSells.length}회`);
    }
  } catch { /* skip */ }

  // 2. VIX 스트레스
  if (vix && vix > 25) {
    penalty += 0.05;
    reasons.push(`VIX=${vix.toFixed(0)}`);
  }

  // 3. 섹터 전체 하락
  if (sectorDown) {
    penalty += 0.05;
    reasons.push('섹터하락');
  }

  return { penalty: Math.min(0.20, penalty), reasons };
}

/** 불확실성 보정 적용 — effective confidence 반환 */
export function applyUncertaintyPenalty(rawConfidence: number, penalty: UncertaintyPenalty): number {
  return Math.max(0, rawConfidence * (1 - penalty.penalty));
}

// ══════════════════════════════════════════════════════════════
// 6. 부분 익절 3단계 스케일링
// ══════════════════════════════════════════════════════════════
export interface PartialTpStage {
  stage: number;        // 1, 2, 3
  triggerPct: number;   // 트리거 수익률
  sellRatio: number;    // 매도 비율 (0.25 = 25%)
}

export function getPartialTpStages(sector: string): PartialTpStage[] {
  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);

  if (isHighBeta) {
    return [
      { stage: 1, triggerPct: 10.0, sellRatio: 0.25 },  // +10%에서 25%
      { stage: 2, triggerPct: 20.0, sellRatio: 0.25 },  // +20%에서 25% 추가
      // 잔여 50%는 트레일링 스톱으로 관리
    ];
  }
  return [
    { stage: 1, triggerPct: 8.0, sellRatio: 0.25 },    // +8%에서 25%  (기존 6% → 더 오래 홀딩)
    { stage: 2, triggerPct: 16.0, sellRatio: 0.25 },   // +16%에서 25% (기존 12% → 수익 극대화)
    // 잔여 50%는 트레일링 스톱으로 관리
  ];
}

/** paper/live 분리 state key 접두사 */
function modePrefix(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'p_' : 'l_';
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

// ══════════════════════════════════════════════════════════════
// 7. 롤링 Kelly 사이징
// ══════════════════════════════════════════════════════════════
export interface KellyResult {
  fullKelly: number;       // 전체 Kelly%
  halfKelly: number;       // Half-Kelly%
  winRate: number;
  avgWin: number;
  avgLoss: number;
  sampleCount: number;
}

export async function calcRollingKelly(days: number = 30, isPaper?: boolean): Promise<KellyResult> {
  const defaultResult: KellyResult = {
    fullKelly: 0.20, halfKelly: 0.10,
    winRate: 0.5, avgWin: 5.0, avgLoss: 3.0, sampleCount: 0,
  };

  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(`
      SELECT
        filled_price,
        avg_buy_price
      FROM orders
      WHERE side = 'SELL'
        AND trigger_source = 'OVERSEAS'
        AND trading_mode = $2
        AND status = 'FILLED'
        AND avg_buy_price > 0
        AND filled_price > 0
        AND created_at >= NOW() - make_interval(days => $1)
      ORDER BY created_at DESC
    `, [days, mode]);

    if (rows.length < 10) return defaultResult; // 표본 부족 시 기본값

    let wins = 0, losses = 0;
    let totalWinPct = 0, totalLossPct = 0;

    for (const r of rows) {
      const sellPrice = Number(r.filled_price);
      const buyPrice = Number(r.avg_buy_price);
      const pnlPct = ((sellPrice - buyPrice) / buyPrice) * 100;

      if (pnlPct > 0) {
        wins++;
        totalWinPct += pnlPct;
      } else {
        losses++;
        totalLossPct += Math.abs(pnlPct);
      }
    }

    const total = wins + losses;
    if (total < 5) return defaultResult;

    const winRate = wins / total;
    const avgWin = wins > 0 ? totalWinPct / wins : 3.0;
    const avgLoss = losses > 0 ? totalLossPct / losses : 3.0;

    // Kelly Criterion: f = (b×p - q) / b, where b=avgWin/avgLoss, p=winRate, q=1-p
    const b = avgLoss > 0 ? avgWin / avgLoss : 1.0;
    const q = 1 - winRate;
    const fullKelly = Math.max(0.05, Math.min(0.30, (b * winRate - q) / b));
    const halfKelly = fullKelly * 0.5;

    logger.info(
      `📊 Rolling Kelly (${days}d, ${total}건): 승률 ${(winRate * 100).toFixed(0)}%, 평균수익 +${avgWin.toFixed(1)}%, 평균손실 -${avgLoss.toFixed(1)}% → Kelly ${(fullKelly * 100).toFixed(1)}% / Half ${(halfKelly * 100).toFixed(1)}%`,
      { component: 'RISK_INTEL' },
    );

    return { fullKelly, halfKelly, winRate, avgWin, avgLoss, sampleCount: total };
  } catch {
    return defaultResult;
  }
}

// ══════════════════════════════════════════════════════════════
// 8. EV 기반 포지션 사이징 배율
// ══════════════════════════════════════════════════════════════
export interface StockEVResult {
  evPct: number;       // 기대값 % (winRate×avgWin - lossRate×avgLoss)
  evMultiplier: number; // 포지션 사이즈 배율 (0.5~1.5)
  winRate: number;
  sampleCount: number;
}

/**
 * 종목별 기대값(EV)을 계산하고 포지션 사이징 배율 반환
 * - EV > 3%: 1.3~1.5x (확실한 승자 집중)
 * - EV 1~3%: 1.0~1.3x (기본 사이즈)
 * - EV 0~1%: 0.8~1.0x (보수적)
 * - EV < 0%: 0.5~0.8x (축소)
 */
export async function calcStockEVMultipliers(codes: string[], isPaper?: boolean): Promise<Map<string, StockEVResult>> {
  const result = new Map<string, StockEVResult>();
  if (codes.length === 0) return result;

  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(`
      SELECT stock_code,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE filled_price > avg_buy_price) AS wins,
             COALESCE(AVG(CASE WHEN filled_price > avg_buy_price
               THEN ((filled_price - avg_buy_price) / avg_buy_price * 100) END), 5.0) AS avg_win_pct,
             COALESCE(AVG(CASE WHEN filled_price <= avg_buy_price
               THEN ABS((filled_price - avg_buy_price) / avg_buy_price * 100) END), 3.0) AS avg_loss_pct
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND trading_mode = $2
        AND avg_buy_price > 0 AND filled_price > 0
        AND stock_code = ANY($1)
        AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY stock_code
    `, [codes, mode]);

    for (const r of rows) {
      const code = String(r.stock_code);
      const total = Number(r.total);
      const wins = Number(r.wins);
      const avgWin = Number(r.avg_win_pct);
      const avgLoss = Number(r.avg_loss_pct);
      const winRate = total > 0 ? wins / total : 0.5;
      const evPct = winRate * avgWin - (1 - winRate) * avgLoss;

      let evMultiplier: number;
      if (total < 3) {
        evMultiplier = 1.0; // 표본 부족 → 기본
      } else if (evPct >= 3.0) {
        evMultiplier = Math.min(1.5, 1.3 + (evPct - 3.0) * 0.05);
      } else if (evPct >= 1.0) {
        evMultiplier = 1.0 + (evPct - 1.0) * 0.15;
      } else if (evPct >= 0) {
        evMultiplier = 0.8 + evPct * 0.2;
      } else {
        evMultiplier = Math.max(0.5, 0.8 + evPct * 0.1);
      }

      result.set(code, { evPct, evMultiplier, winRate, sampleCount: total });
    }
  } catch {
    // DB 실패 시 빈 맵 반환 (기본 배율 1.0 사용)
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// 9. Memory Agent 패턴 — 거래 결과 자동 패턴 추출
// ══════════════════════════════════════════════════════════════
export interface TradingPattern {
  pattern: string;
  evidence: string;
  confidence: number;
  actionable: boolean;
}

export async function extractTradingPatterns(isPaper?: boolean): Promise<TradingPattern[]> {
  const patterns: TradingPattern[] = [];
  const mode = ctxMode(isPaper);

  try {
    // 종목별 승률 패턴
    const { rows: stockWr } = await getPool().query(`
      SELECT stock_code,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE filled_price > avg_buy_price) AS wins,
             ROUND(AVG(CASE WHEN filled_price > avg_buy_price
               THEN ((filled_price - avg_buy_price) / avg_buy_price * 100)
               ELSE NULL END)::numeric, 1) AS avg_win_pct,
             ROUND(AVG(CASE WHEN filled_price <= avg_buy_price
               THEN ((filled_price - avg_buy_price) / avg_buy_price * 100)
               ELSE NULL END)::numeric, 1) AS avg_loss_pct
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND trading_mode = $1
        AND avg_buy_price > 0 AND filled_price > 0
        AND created_at >= NOW() - INTERVAL '60 days'
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC
    `, [mode]);

    for (const r of stockWr) {
      const wr = Number(r.wins) / Number(r.total);
      const code = r.stock_code;
      if (wr >= 0.70 && Number(r.total) >= 5) {
        patterns.push({
          pattern: `${code} 고승률 종목`,
          evidence: `승률 ${(wr * 100).toFixed(0)}% (${r.total}건), 평균수익 +${r.avg_win_pct ?? 0}%`,
          confidence: wr,
          actionable: true,
        });
      } else if (wr <= 0.25 && Number(r.total) >= 4) {
        patterns.push({
          pattern: `${code} 저승률 종목 — 제외 검토`,
          evidence: `승률 ${(wr * 100).toFixed(0)}% (${r.total}건), 평균손실 ${r.avg_loss_pct ?? 0}%`,
          confidence: 1 - wr,
          actionable: true,
        });
      }
    }

    // 시간대별 승률 패턴 (요일)
    const { rows: dayWr } = await getPool().query(`
      SELECT
        EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') AS dow,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE filled_price > avg_buy_price) AS wins
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND trading_mode = $1
        AND avg_buy_price > 0 AND filled_price > 0
        AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY dow
      HAVING COUNT(*) >= 5
      ORDER BY dow
    `, [mode]);

    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    for (const r of dayWr) {
      const wr = Number(r.wins) / Number(r.total);
      const dow = Number(r.dow);
      if (wr <= 0.30 && Number(r.total) >= 5) {
        patterns.push({
          pattern: `${dayNames[dow]}요일 저승률`,
          evidence: `승률 ${(wr * 100).toFixed(0)}% (${r.total}건) — 진입 축소 권장`,
          confidence: 0.7,
          actionable: true,
        });
      }
    }

    // 패턴을 DB에 저장 (learned_insights 테이블 활용)
    for (const p of patterns.filter(p => p.actionable)) {
      await getPool().query(`
        INSERT INTO overseas_state (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = $2
      `, [`pattern_${p.pattern.replace(/\s/g, '_').substring(0, 50)}`, JSON.stringify(p)]).catch(() => {});
    }

  } catch (e) {
    logger.warn(`패턴 추출 실패: ${(e as Error).message}`, { component: 'RISK_INTEL' });
  }

  return patterns;
}

// ══════════════════════════════════════════════════════════════
// 10. 동적 TP/SL (AI 확신도 × VIX 레짐 × 모멘텀 통합)
// ══════════════════════════════════════════════════════════════
export interface DynamicTpSlResult {
  tpPct: number;   // take profit % (예: 27.5)
  slPct: number;   // stop loss % 절댓값 (예: 5.0 → -5%)
  tpLabel: string; // 계산 근거 레이블 (로그용)
}

/**
 * 동적 TP/SL 계산 — 섹터 × 모멘텀 × AI 확신도 × VIX 레짐
 * - 고확신 + 강추세 + 저변동성 → TP 최대 45%까지 확대
 * - AI 매도 신호 + 고VIX → TP 축소, 조기 수익 확보
 */
export function calcDynamicTpSl(params: {
  sector: string;
  adx: number;
  rsi: number;
  aiConfidence?: number;
  aiAction?: string;
  aiScore?: number;       // 진입 품질 점수 (높을수록 TP 확대)
  vixRegime: RegimeAdjustment;
  isMomentum?: boolean;
}): DynamicTpSlResult {
  const { sector, adx, rsi, aiConfidence = 0.5, aiAction = 'HOLD', aiScore, vixRegime, isMomentum = false } = params;

  const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
  const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
  const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

  // 섹터별 기본 TP/SL
  const baseTp = isHighBeta ? 25.0 : isMediumBeta ? 20.0 : isDefense ? 18.0 : 20.0;
  const baseSl = isHighBeta ? 8.0 : isMediumBeta ? 5.0 : isDefense ? 4.0 : 5.0;

  // ADX + RSI 모멘텀 연장
  const momentumExt = adx >= 35 && rsi >= 45 && rsi <= 68 ? 10.0
                    : adx >= 28 && rsi >= 45 && rsi <= 70 ? 5.0
                    : isMomentum ? 3.0 : 0;

  // 과매수 TP 축소
  const overboughtCut = rsi > 78 ? -8.0 : rsi > 75 ? -5.0 : 0;

  // AI 확신도 TP 보정
  const aiTpBonus = aiAction === 'BUY' && aiConfidence >= 0.85 ? 5.0
                  : aiAction === 'BUY' && aiConfidence >= 0.75 ? 2.5
                  : aiAction === 'HOLD' && aiConfidence >= 0.80 ? 1.0
                  : aiAction === 'SELL' ? -5.0   // AI 매도 신호 → TP 목표 축소
                  : 0;

  // AI 점수 기반 TP 보너스 (진입 품질이 높을수록 더 오래 보유)
  const scoreTpBonus = aiScore != null
    ? aiScore >= 90 ? 5.0
    : aiScore >= 80 ? 2.5
    : aiScore >= 70 ? 1.0
    : 0
    : 0;

  // VIX 레짐 TP 조정
  const vixTpAdj = vixRegime.regime === 'CRISIS' ? -7.0   // 위기 → 빨리 수익 확보
                 : vixRegime.regime === 'STRESS' ? -3.0
                 : vixRegime.regime === 'CALM' ? 3.0       // 안정 → 수익 극대화
                 : 0;

  // AI 매도 신호 시 SL 타이트닝 (손실 최소화)
  const aiSlAdj = aiAction === 'SELL' && aiConfidence >= 0.80 ? -1.0 : 0;
  // 고확신 점수 진입 시 SL 약간 여유 (노이즈 흡수)
  const scoreSlAdj = aiScore != null && aiScore >= 85 ? 0.5 : 0;

  const tpPct = Math.max(
    isHighBeta ? 20.0 : 15.0,
    baseTp + momentumExt + overboughtCut + aiTpBonus + scoreTpBonus + vixTpAdj,
  );
  const slPct = Math.max(
    isHighBeta ? 5.0 : 2.5,
    baseSl + aiSlAdj + scoreSlAdj,
  );

  const parts: string[] = [`base${baseTp}`];
  if (momentumExt) parts.push(`mom${momentumExt > 0 ? '+' : ''}${momentumExt}`);
  if (overboughtCut) parts.push(`rsi${overboughtCut}`);
  if (aiTpBonus) parts.push(`AI${aiTpBonus > 0 ? '+' : ''}${aiTpBonus}`);
  if (scoreTpBonus) parts.push(`s${aiScore}+${scoreTpBonus}`);
  if (vixTpAdj) parts.push(`VIX${vixTpAdj > 0 ? '+' : ''}${vixTpAdj}`);

  return { tpPct, slPct, tpLabel: parts.join('/') };
}

/** Memory Agent: 저승률 종목 차단 Set 반환 (승률 25% 이하, 4건 이상) */
export async function getMemoryBlockedStocks(isPaper?: boolean): Promise<Set<string>> {
  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(`
      SELECT stock_code
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND trading_mode = $1
        AND avg_buy_price > 0 AND filled_price > 0
        AND created_at >= NOW() - INTERVAL '60 days'
      GROUP BY stock_code
      HAVING COUNT(*) >= 4
        AND (COUNT(*) FILTER (WHERE filled_price > avg_buy_price))::float / COUNT(*) <= 0.25
    `, [mode]);
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch { return new Set(); }
}
