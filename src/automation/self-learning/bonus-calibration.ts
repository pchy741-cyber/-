/**
 * Tier 4: 보너스 가중치 자동 학습
 *
 * 90일 매매이력에서 각 보너스별 승률/PnL 역산하여 multiplier 계산.
 * multiplier 범위: 0.5 ~ 2.0 (기본값 1.0 = 변경 없음)
 * 저장: system_state 테이블 (key: 'bonus_weight_calibration')
 * 로드: 30분 캐시
 */

import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

const COMP = 'BONUS_CAL';

export interface BonusWeights {
  candleBonus: number;
  structBonus: number;
  vpBonus: number;
  pullbackBonus: number;
  fibBonus: number;
  signalBonus: number;
  rsiDivBonus: number;
  bbSqueezeBonus: number;
  volumeBonus: number;
  sequenceBonus: number;
  priorityBonus: number;
}

const DEFAULT_WEIGHTS: BonusWeights = {
  candleBonus: 1.0,
  structBonus: 1.0,
  vpBonus: 1.0,
  pullbackBonus: 1.0,
  fibBonus: 1.0,
  signalBonus: 1.0,
  rsiDivBonus: 1.0,
  bbSqueezeBonus: 1.0,
  volumeBonus: 1.0,
  sequenceBonus: 1.0,
  priorityBonus: 1.0,
};

// ── 30분 캐시 ──
let _cache: { weights: BonusWeights; expiresAt: number; isPaper: boolean } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30분

/**
 * 보너스 가중치 로드 (30분 캐시)
 * 폴백: 모든 multiplier = 1.0
 */
export async function getBonusWeights(): Promise<BonusWeights> {
  const isPaper = getCtxIsPaper();
  if (_cache && _cache.isPaper === isPaper && Date.now() < _cache.expiresAt) {
    return _cache.weights;
  }

  try {
    const key = isPaper ? 'p_bonus_weight_calibration' : 'l_bonus_weight_calibration';
    const { rows } = await getPool().query(
      `SELECT value FROM system_state WHERE key = $1`,
      [key],
    );

    if (rows.length > 0 && rows[0].value) {
      const parsed = typeof rows[0].value === 'string'
        ? JSON.parse(rows[0].value)
        : rows[0].value;
      const weights = { ...DEFAULT_WEIGHTS };

      for (const k of Object.keys(DEFAULT_WEIGHTS) as Array<keyof BonusWeights>) {
        if (typeof parsed[k] === 'number') {
          weights[k] = Math.max(0.5, Math.min(2.0, parsed[k]));
        }
      }

      _cache = { weights, expiresAt: Date.now() + CACHE_TTL_MS, isPaper };
      return weights;
    }
  } catch (err) {
    logger.debug(`보너스 가중치 로드 실패 → 기본값: ${err}`, { component: COMP });
  }

  _cache = { weights: { ...DEFAULT_WEIGHTS }, expiresAt: Date.now() + CACHE_TTL_MS, isPaper };
  return _cache.weights;
}

/**
 * 90일 매매이력에서 보너스별 multiplier 역산 및 저장
 *
 * 실행: 일일 self-learning 루프에서 호출
 */
export async function calibrateBonusWeights(): Promise<void> {
  const isPaper = getCtxIsPaper();
  try {
    // score_accuracy + transaction_chains 조인 — 보너스별 성과 분석
    // score_accuracy.details에 각 보너스 활성 여부가 기록되어 있다고 가정
    // 없으면 entry_score 기반 간이 분석
    // v23-audit: EXPLORE 프로파일 제외
    const { rows } = await getPool().query(
      `SELECT sa.entry_score, sa.outcome, sa.realized_pnl_pct, sa.details
       FROM score_accuracy sa
       WHERE sa.recorded_at >= NOW() - INTERVAL '90 days'
         AND sa.is_paper = $1
         AND sa.entry_score IS NOT NULL
         AND COALESCE(sa.trading_profile, 'LIVE') != 'EXPLORE'`,
      [isPaper],
    );

    if (rows.length < 30) {
      logger.info(`보너스 캘리브레이션: 데이터 부족 (${rows.length}/30건)`, { component: COMP });
      return;
    }

    // 전체 기준선
    const totalWins = rows.filter((r: any) => r.outcome === 'WIN').length;
    const baseWinRate = totalWins / rows.length;
    const baseAvgPnl = rows.reduce((s: number, r: any) => s + Number(r.realized_pnl_pct), 0) / rows.length;
    const baseScore = baseWinRate * Math.max(baseAvgPnl, 0.01);

    if (baseScore <= 0) {
      logger.info('보너스 캘리브레이션: 기준선 성과 0 이하 → 스킵', { component: COMP });
      return;
    }

    // 점수 대역별 분석으로 간접 보너스 효과 측정
    // 높은 entry_score 거래의 승률이 높으면 보너스 시스템이 효과적
    const tiers = [
      { min: 45, max: 59, label: 'low' },
      { min: 60, max: 74, label: 'mid' },
      { min: 75, max: 89, label: 'high' },
      { min: 90, max: 100, label: 'top' },
    ];

    const tierPerformance: Record<string, { winRate: number; avgPnl: number; count: number }> = {};
    for (const tier of tiers) {
      const tierData = rows.filter((r: any) => r.entry_score >= tier.min && r.entry_score <= tier.max);
      if (tierData.length < 5) continue;
      const wins = tierData.filter((r: any) => r.outcome === 'WIN').length;
      tierPerformance[tier.label] = {
        winRate: wins / tierData.length,
        avgPnl: tierData.reduce((s: number, r: any) => s + Number(r.realized_pnl_pct), 0) / tierData.length,
        count: tierData.length,
      };
    }

    // 상위 티어가 하위보다 성과가 좋으면 → 보너스 시스템 유효 → 가중치 유지/강화
    // 역전되면 → 특정 보너스가 노이즈 → 가중치 약화
    const weights = { ...DEFAULT_WEIGHTS };

    const highPerf = tierPerformance['high'];
    const midPerf = tierPerformance['mid'];
    const lowPerf = tierPerformance['low'];
    const topPerf = tierPerformance['top'];

    if (highPerf && midPerf && lowPerf) {
      // 고점수 대역이 저점수 대역보다 성과 좋으면 전체 보너스 강화
      if (highPerf.winRate > lowPerf.winRate + 0.05) {
        const boost = Math.min(1.5, 1.0 + (highPerf.winRate - lowPerf.winRate));
        // 가장 효과적인 보너스들 강화
        weights.signalBonus = boost;
        weights.pullbackBonus = boost;
        weights.fibBonus = boost;
      }

      // 고점수 대역이 오히려 성과 나쁘면 일부 보너스가 노이즈
      if (highPerf.winRate < lowPerf.winRate - 0.10) {
        weights.candleBonus = 0.7;
        weights.structBonus = 0.7;
      }
    }

    // 최상위 티어가 매우 좋으면 rsiDiv/bbSqueeze 보너스 효과적
    if (topPerf && topPerf.winRate > baseWinRate + 0.10) {
      weights.rsiDivBonus = Math.min(2.0, 1.0 + (topPerf.winRate - baseWinRate));
      weights.bbSqueezeBonus = weights.rsiDivBonus;
    }

    // 범위 클램핑
    for (const k of Object.keys(weights) as Array<keyof BonusWeights>) {
      weights[k] = Math.max(0.5, Math.min(2.0, Math.round(weights[k] * 100) / 100));
    }

    // system_state에 저장
    const key = isPaper ? 'p_bonus_weight_calibration' : 'l_bonus_weight_calibration';
    await getPool().query(
      `INSERT INTO system_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(weights)],
    );

    // 캐시 무효화
    _cache = null;

    const changed = (Object.keys(weights) as Array<keyof BonusWeights>)
      .filter((k) => weights[k] !== 1.0)
      .map((k) => `${k}=${weights[k]}`)
      .join(', ');

    logger.info(
      `🎛️ 보너스 가중치 캘리브레이션 완료 (${rows.length}건): ${changed || '전부 1.0 (변경 없음)'}`,
      { component: COMP },
    );
  } catch (err) {
    logger.warn(`보너스 가중치 캘리브레이션 실패: ${err}`, { component: COMP });
  }
}
