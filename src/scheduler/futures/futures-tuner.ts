/**
 * 선물 자동 파라미터 튜닝 — 30일 승률 기반
 *
 * 매일 1회 실행:
 * 1. 30일 승률/패턴 분석
 * 2. TP/SL 배수 자동 조정
 * 3. confidence 임계값 조정
 * 4. overseas_state에 저장 → signal-generator가 읽어서 적용
 */
import { getPool } from '../../db/client.js';
import { getCtxIsPaper } from '../../config/context.js';
import { setOverseasState, getOverseasState } from '../overseas/utils.js';
import { logger } from '../../utils/logger.js';

const COMP = 'FUTURES_TUNER';

export interface FuturesTunerResult {
  winRate: number;
  totalTrades: number;
  avgWinUsd: number;
  avgLossUsd: number;
  tpMultiplier: number;    // default 2.0
  slMultiplier: number;    // default 1.5
  minConfidence: number;   // default 60
  kellyWinRate: number;    // calcFuturesQty에 전달할 실제 승률
  updatedAt: string;
}

// 기본값 (데이터 부족 시)
const DEFAULTS: FuturesTunerResult = {
  winRate: 50, totalTrades: 0, avgWinUsd: 0, avgLossUsd: 0,
  tpMultiplier: 2.0, slMultiplier: 1.5, minConfidence: 60, kellyWinRate: 0.5,
  updatedAt: new Date().toISOString(),
};

export async function runFuturesTuner(): Promise<FuturesTunerResult> {
  const isPaper = getCtxIsPaper();
  const mode = isPaper ? 'paper' : 'live';
  const key = `futures_tuner_${mode}`;

  try {
    // 30일 매매 통계
    const { rows } = await getPool().query(`
      SELECT
        COUNT(*) FILTER (WHERE pnl_usd IS NOT NULL) AS total,
        COUNT(*) FILTER (WHERE pnl_usd > 0) AS wins,
        COUNT(*) FILTER (WHERE pnl_usd < 0) AS losses,
        COALESCE(AVG(pnl_usd) FILTER (WHERE pnl_usd > 0), 0) AS avg_win,
        COALESCE(AVG(ABS(pnl_usd)) FILTER (WHERE pnl_usd < 0), 0) AS avg_loss
      FROM futures_trades
      WHERE is_paper = $1
        AND executed_at > NOW() - INTERVAL '30 days'
        AND pnl_usd IS NOT NULL
    `, [isPaper]);

    const total = Number(rows[0]?.total ?? 0);
    const wins = Number(rows[0]?.wins ?? 0);
    const losses = Number(rows[0]?.losses ?? 0);
    const avgWin = Number(rows[0]?.avg_win ?? 0);
    const avgLoss = Number(rows[0]?.avg_loss ?? 0);

    // 데이터 부족 시 기본값
    if (total < 5) {
      logger.info(`[${mode}] 선물 튜너: 거래 ${total}건 — 데이터 부족, 기본값 유지`, { component: COMP });
      await setOverseasState(key, JSON.stringify(DEFAULTS));
      return DEFAULTS;
    }

    const winRate = (wins / total) * 100;
    const kellyWinRate = wins / total;

    // TP/SL 배수 조정
    let tpMultiplier = 2.0;
    let slMultiplier = 1.5;

    if (winRate > 60) {
      // 승률 높음 → TP 넓게 (수익 극대화)
      tpMultiplier = 2.3;
      slMultiplier = 1.5;
    } else if (winRate > 55) {
      tpMultiplier = 2.2;
      slMultiplier = 1.5;
    } else if (winRate < 35) {
      // 승률 낮음 → SL 타이트 + TP 낮춰서 빈도 높이기
      tpMultiplier = 1.6;
      slMultiplier = 1.2;
    } else if (winRate < 40) {
      tpMultiplier = 1.8;
      slMultiplier = 1.3;
    }

    // 이익 누출 분석: avg_win < avg_loss 이면 TP 낮추기
    if (avgWin > 0 && avgLoss > 0 && avgWin < avgLoss * 0.8) {
      tpMultiplier = Math.max(1.5, tpMultiplier - 0.2);
    }

    // confidence 임계값 조정
    let minConfidence = 60;
    if (winRate > 60) minConfidence = 55;      // 잘 되고 있음 → 더 공격적
    else if (winRate < 35) minConfidence = 70;  // 잘 안 됨 → 까다롭게
    else if (winRate < 40) minConfidence = 65;

    const result: FuturesTunerResult = {
      winRate: +winRate.toFixed(1),
      totalTrades: total,
      avgWinUsd: +avgWin.toFixed(2),
      avgLossUsd: +avgLoss.toFixed(2),
      tpMultiplier,
      slMultiplier,
      minConfidence,
      kellyWinRate: +kellyWinRate.toFixed(3),
      updatedAt: new Date().toISOString(),
    };

    await setOverseasState(key, JSON.stringify(result));
    logger.info(
      `[${mode}] 선물 튜너: 승률${winRate.toFixed(0)}% (${wins}W/${losses}L) → TP×${tpMultiplier} SL×${slMultiplier} conf≥${minConfidence}`,
      { component: COMP },
    );
    return result;
  } catch (e: any) {
    logger.warn(`선물 튜너 실패: ${e.message}`, { component: COMP });
    return DEFAULTS;
  }
}

/** signal-generator가 호출 — 튜너 결과 로드 (캐시) */
export async function loadTunerParams(isPaper: boolean): Promise<FuturesTunerResult> {
  const key = `futures_tuner_${isPaper ? 'paper' : 'live'}`;
  try {
    const raw = await getOverseasState(key);
    if (raw) return JSON.parse(raw) as FuturesTunerResult;
  } catch { /* ignore */ }
  return DEFAULTS;
}
