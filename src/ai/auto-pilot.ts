/**
 * Auto-Pilot Engine — AI API 토큰 $0으로 돌아가는 자동 매매 조절기
 *
 * 30분마다 서버 내부에서 자동 실행:
 * 1. 시장 레짐 + 승률 + 포지션 + 컨센서스 데이터 수집
 * 2. 규칙 기반 판단 (코드화된 지능)
 * 3. ai_overrides에 자동 적용 (TTL 기반 자동 만료)
 *
 * 설계 원칙:
 * - 기존 Track A/B를 방해하지 않음 (오버라이드만 설정)
 * - 모든 결정에 reason 기록 (감사 추적)
 * - 보수적 기본값 (안 하느니만 못한 조작 금지)
 * - paper/live 양쪽 독립 실행
 */

import { getStockWinRates } from '../analysis/win-rate.js';
import { getPerformanceMultiplier, getWinRateFeedback } from '../automation/portfolio-guard.js';
import { runWithMode } from '../config/context.js';
import { getOpenChains, getPool } from '../db/client.js';
import { getConsensusTrend, getMarketSentiment } from '../market/consensus.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { getOverride, loadOverridesCache, removeOverride, setOverride } from './ai-overrides.js';
import { fetchKospiRegime } from './track-b/market-regime.js';

// ── 마지막 실행 결과 (SSE/대시보드에서 조회) ────────────────────────
const _lastResult: { paper: AutoPilotResult | null; live: AutoPilotResult | null; lastRunAt: string | null } = {
  paper: null,
  live: null,
  lastRunAt: null,
};
export function getLastAutoPilotResult() {
  return _lastResult;
}

/** 장기 보완 #2: MDD 가드가 현재 active한지 확인 (reason prefix로 판별) */
async function checkMddGuardActive(isPaper: boolean): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      `SELECT reason FROM ai_overrides
       WHERE key = 'minBuyScore' AND is_paper = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 1`,
      [isPaper],
    );
    const reason = String(rows[0]?.reason ?? '');
    return reason.startsWith('mdd_guard:');
  } catch {
    return false;
  }
}

// ── 자동 조절 규칙 상수 ─────────────────────────────────────────────
// CEO 지시 (2026-06-12): "장 좋앗다는데 실전매매 무반응인게 화남"
// "유지비만 몇십만원인데 돈 거의 못 벌고 있음"
// → 임계 대폭 완화 (이전 75→65, 83→75 등) + 시간대별 동적 조정
const RULES = {
  // 시장 레짐 기반 minBuyScore (악착 매매로 회전 우선)
  REGIME_NORMAL_THRESHOLD: 65, // 정상장 (이전 75 → 65)
  REGIME_ADJUST_THRESHOLD: 75, // 조정장 (이전 83 → 75)
  REGIME_DOWN_THRESHOLD: 85, // 하락장 (이전 90 → 85)
  REGIME_CRASH_THRESHOLD: 95, // 급락장 (그대로)
  REGIME_BOOST_THRESHOLD: 55, // 강세장 (이전 65 → 55)

  // 승률 기반
  WINRATE_BAD_THRESHOLD: 0.35, // 35% 미만 → 방어 모드
  WINRATE_GOOD_THRESHOLD: 0.55, // 55% 이상 → 공격적
  STOCK_WINRATE_BLACKLIST: 0.2, // 개별 종목 20% 미만 → 블랙리스트
  STOCK_MIN_SAMPLES: 5, // 최소 5건 거래 필요

  // 포지션 건강성
  PROFIT_TRAIL_TIGHTEN_1: 8, // +8% → trail +0.5
  PROFIT_TRAIL_TIGHTEN_2: 12, // +12% → trail +1.0
  PROFIT_TRAIL_TIGHTEN_3: 18, // +18% → trail +1.5

  // 컨센서스
  SENTIMENT_BEARISH_RATIO: 0.2, // bullish 20% 미만 → 방어
  SENTIMENT_BULLISH_RATIO: 0.5, // bullish 50% 이상 → 공격

  // TTL (분) — 10분 간격 루프 기준
  TTL_REGIME: 15, // 레짐 오버라이드 (10분 루프 + 5분 여유)
  TTL_WINRATE: 120, // 승률 기반 (2시간)
  TTL_POSITION: 15, // 포지션 기반 (다음 루프 갱신)
  TTL_BLACKLIST: 240, // 블랙리스트 (4시간)
  TTL_CONSENSUS: 60, // 컨센서스 기반 (1시간)
} as const;

export interface AutoPilotResult {
  rulesApplied: number;
  overridesSet: number;
  overridesRemoved: number;
  decisions: string[];
}

/**
 * 자동 파일럿 메인 함수 — 30분마다 호출
 */
export async function runAutoPilot(isPaper: boolean): Promise<AutoPilotResult> {
  const mode = isPaper ? 'paper' : 'live';
  const decisions: string[] = [];
  let overridesSet = 0;
  let overridesRemoved = 0;

  // Kill switch 활성화 시 스킵
  if (isKillSwitchActive('KR') && isKillSwitchActive('OVERSEAS')) {
    logger.info(`🤖 AutoPilot [${mode}]: Kill switch 활성 → 스킵`, { component: 'AUTO_PILOT' });
    return { rulesApplied: 0, overridesSet: 0, overridesRemoved: 0, decisions: ['Kill switch active — skipped'] };
  }

  try {
    // ── 데이터 수집 (병렬) ──────────────────────────────────
    const [regime, winRateFeedback, perfMultiplier, chains, sentiment] = await Promise.all([
      fetchKospiRegime().catch(() => null),
      getWinRateFeedback(isPaper).catch(() => null),
      getPerformanceMultiplier().catch(() => 1.0),
      getOpenChains(isPaper).catch(() => []),
      Promise.resolve(getMarketSentiment()),
    ]);

    // 보유종목 승률 맵
    const stockCodes = chains.map((c) => c.stock_code);
    const stockWinRates =
      stockCodes.length > 0 ? await getStockWinRates(stockCodes, 'KR').catch(() => new Map()) : new Map();

    // 최근 연패 데이터
    const lossStreaks = await getConsecutiveLosses(isPaper).catch(() => new Map());

    // ── Rule 1: 시장 레짐 기반 minBuyScore ──────────────────
    if (regime) {
      let targetThreshold: number;
      let reason: string;

      if (regime.flashCrash) {
        targetThreshold = RULES.REGIME_CRASH_THRESHOLD;
        reason = `KOSPI 급락(flashCrash) → 매수 기준 최대 상향`;
      } else if (regime.penalty >= 2) {
        targetThreshold = RULES.REGIME_DOWN_THRESHOLD;
        reason = `하락장(penalty=2) → 매수 기준 대폭 상향`;
      } else if (regime.penalty >= 1) {
        targetThreshold = RULES.REGIME_ADJUST_THRESHOLD;
        reason = `조정장(penalty=1) → 매수 기준 상향`;
      } else if (regime.boost) {
        targetThreshold = RULES.REGIME_BOOST_THRESHOLD;
        reason = `강세장(boost) → 매수 기준 완화`;
      } else {
        targetThreshold = RULES.REGIME_NORMAL_THRESHOLD;
        reason = `정상장 → 기본 매수 기준`;
      }

      // 컨센서스 센티먼트 보정
      if (sentiment) {
        if (sentiment.bullishRatio < RULES.SENTIMENT_BEARISH_RATIO) {
          targetThreshold = Math.min(95, targetThreshold + 5);
          reason += ` + 시장심리 약세(bull=${(sentiment.bullishRatio * 100).toFixed(0)}%)`;
        } else if (sentiment.bullishRatio > RULES.SENTIMENT_BULLISH_RATIO) {
          targetThreshold = Math.max(55, targetThreshold - 3);
          reason += ` + 시장심리 강세(bull=${(sentiment.bullishRatio * 100).toFixed(0)}%)`;
        }
      }

      // 퍼포먼스 멀티플라이어 보정 — 대폭 완화 (악착 매매 우선)
      // 이전 +5/+3/+2 → +2/+1/+0 으로 축소. 성과방어 핑계 매매 정체 차단
      const skipPerfPenalty = isPaper && regime.boost;
      if (skipPerfPenalty) {
        reason += ` + 강세장 paper → 성과 패널티 면제`;
      } else if (perfMultiplier <= 0.5) {
        targetThreshold = Math.min(95, targetThreshold + 2); // 이전 +5 → +2
        reason += ` + 성과 심각(×${perfMultiplier.toFixed(2)})`;
      } else if (perfMultiplier < 0.7) {
        targetThreshold = Math.min(95, targetThreshold + 1); // 이전 +3 → +1
        reason += ` + 성과 부진(×${perfMultiplier.toFixed(2)})`;
      } else if (perfMultiplier < 0.85) {
        // 이전: +2 → 0 (방어 단계는 보정 없음)
        reason += ` + 성과 방어(×${perfMultiplier.toFixed(2)}) — 임계 유지`;
      } else if (perfMultiplier > 1.1) {
        targetThreshold = Math.max(55, targetThreshold - 3); // 이전 -2 → -3
        reason += ` + 최근 성과 우수(×${perfMultiplier.toFixed(2)})`;
      }

      // 🕐 시간대별 동적 임계 (CEO 지시 — 황금구간 적극 매매)
      // 황금 오전 09:30~10:20, 황금 오후 13:00~15:00 → -10점
      // 개장벨 09:00~09:30 → -3 (백엔드 자동 구간이지만 후보 검출)
      // 마의시간 10:20~13:00 → +5 (신규 매수 금지 구간 안전망)
      try {
        const { getKrMarketPhase } = await import('../scheduler/loop-mode.js');
        const phase = getKrMarketPhase();
        if (phase === 'GOLDEN_AM' || phase === 'GOLDEN_PM') {
          targetThreshold = Math.max(50, targetThreshold - 10);
          reason += ` + 황금구간(${phase}) 임계 -10`;
        } else if (phase === 'CURSED') {
          targetThreshold = Math.min(99, targetThreshold + 5);
          reason += ` + 마의시간 임계 +5`;
        } else if (phase === 'OPENING_BELL') {
          targetThreshold = Math.max(55, targetThreshold - 3);
          reason += ` + 개장벨 임계 -3`;
        }
      } catch {
        /* phase 조회 실패 시 시간대 보정 없이 진행 */
      }

      // 승률 피드백 반영 — 완화 (+5 → +2, 매매 정체 차단)
      if (winRateFeedback && winRateFeedback.recentWinRate < RULES.WINRATE_BAD_THRESHOLD) {
        targetThreshold = Math.min(95, targetThreshold + 2);
        reason += ` + 전체 승률 저조(${(winRateFeedback.recentWinRate * 100).toFixed(0)}%)`;
      }

      // Paper 모드: 임계값 오버라이드 비활성 (적극적 매매 학습 목적)
      if (!isPaper) {
        // 🛡️ 장기 운영 보완 #2: MDD 가드가 활성이면 AutoPilot 덮어쓰기 금지
        //   둘 다 같은 key (minBuyScore) 쓰는데 reason으로 구분.
        //   MDD 가드(reason='mdd_guard:...')가 95로 설정한 직후 AutoPilot이 77로 낮추면 위험.
        const mddGuardActive = await checkMddGuardActive(isPaper);
        if (mddGuardActive) {
          decisions.push(`minBuyScore 스킵: MDD 가드 활성 (우선)`);
        } else {
          const currentOverride = getOverride<number>('minBuyScore', isPaper);
          if (currentOverride !== targetThreshold) {
            const res = await setOverride(
              'threshold',
              'minBuyScore',
              targetThreshold,
              `[AutoPilot] ${reason}`,
              RULES.TTL_REGIME,
              isPaper,
            );
            if (res.ok) {
              overridesSet++;
              decisions.push(`minBuyScore=${targetThreshold} (${reason})`);
            }
          }
        }
      } else {
        decisions.push(`minBuyScore 스킵 (paper 적극매매 모드)`);
      }
    }

    // ── Rule 2: 개별 종목 블랙리스트 (저승률 + 연패) ────────
    // Paper 모드: 블랙리스트 비활성 — 모든 종목 매매 가능 (백테스팅 데이터 최대 수집)
    if (isPaper) {
      decisions.push('종목 블랙리스트 스킵 (paper 적극매매 모드)');
    } else {
    for (const [code, wr] of stockWinRates) {
      // 승률 20% 미만 + 5건 이상 → 블랙리스트
      if (wr.winRate < RULES.STOCK_WINRATE_BLACKLIST && wr.sampleCount >= RULES.STOCK_MIN_SAMPLES) {
        const existing = getOverride<boolean>(`${code}_blacklist`, isPaper);
        if (!existing) {
          const res = await setOverride(
            'stock',
            `${code}_blacklist`,
            true,
            `[AutoPilot] 승률 ${(wr.winRate * 100).toFixed(0)}%(${wr.sampleCount}건) → 매수 차단`,
            RULES.TTL_BLACKLIST,
            isPaper,
          );
          if (res.ok) {
            overridesSet++;
            decisions.push(`${code} 블랙리스트 (WR=${(wr.winRate * 100).toFixed(0)}%)`);
          }
        }
      }
    }

    // 3연패 이상 → 블랙리스트
    for (const [code, streak] of lossStreaks) {
      if (streak >= 3) {
        const existing = getOverride<boolean>(`${code}_blacklist`, isPaper);
        if (!existing) {
          const res = await setOverride(
            'stock',
            `${code}_blacklist`,
            true,
            `[AutoPilot] ${streak}연패 → 매수 차단 (냉각기)`,
            RULES.TTL_BLACKLIST,
            isPaper,
          );
          if (res.ok) {
            overridesSet++;
            decisions.push(`${code} 블랙리스트 (${streak}연패)`);
          }
        }
      }
    }
    } // end of !isPaper block for stock blacklist

    // ── Rule 3: 보유 포지션 트레일 타이트닝 ─────────────────
    for (const chain of chains) {
      if (!chain.avg_buy_price) continue;
      // pnl은 snapshot 시점 값이 없으므로 peak_price 기준으로 대략 추정
      const peak = chain.peak_price_since_open ?? chain.avg_buy_price;
      const estimatedMaxPnl = ((peak - chain.avg_buy_price) / chain.avg_buy_price) * 100;

      let tighten = 0;
      if (estimatedMaxPnl >= RULES.PROFIT_TRAIL_TIGHTEN_3) tighten = 1.5;
      else if (estimatedMaxPnl >= RULES.PROFIT_TRAIL_TIGHTEN_2) tighten = 1.0;
      else if (estimatedMaxPnl >= RULES.PROFIT_TRAIL_TIGHTEN_1) tighten = 0.5;

      const key = `${chain.stock_code}_trailTighten`;
      const current = getOverride<number>(key, isPaper) ?? 0;

      if (tighten > 0 && tighten !== current) {
        const res = await setOverride(
          'stock',
          key,
          tighten,
          `[AutoPilot] peak수익 ${estimatedMaxPnl.toFixed(1)}% → trail +${tighten}%`,
          RULES.TTL_POSITION,
          isPaper,
        );
        if (res.ok) {
          overridesSet++;
          decisions.push(`${chain.stock_code} trail+${tighten} (peak ${estimatedMaxPnl.toFixed(1)}%)`);
        }
      } else if (tighten === 0 && current > 0) {
        // 수익 줄었으면 해제
        await removeOverride(key, isPaper);
        overridesRemoved++;
      }
    }

    // ── Rule 4: 컨센서스 강약 종목별 점수 보정 ──────────────
    for (const code of stockCodes) {
      const signal = getConsensusTrend(code);
      if (!signal) continue;

      const key = `${code}_scoreAdj`;
      const currentAdj = getOverride<number>(key, isPaper) ?? 0;

      // BEARISH → -8 (이미 pipeline.ts에서 -12 하지만 AutoPilot도 추가 감산)
      // 목적: AI Loop 블랙리스트까지는 아니지만 점수 추가 감산으로 자연스럽게 필터링
      if (signal.trend === 'BEARISH' && signal.netScore <= -3 && currentAdj > -8) {
        const res = await setOverride(
          'stock',
          key,
          -8,
          `[AutoPilot] 컨센서스 강 하향(net=${signal.netScore}) → 점수 -8`,
          RULES.TTL_CONSENSUS,
          isPaper,
        );
        if (res.ok) {
          overridesSet++;
          decisions.push(`${code} scoreAdj=-8 (consensus BEARISH)`);
        }
      }
      // BULLISH + 강한 상향 → +5
      else if (signal.trend === 'BULLISH' && signal.netScore >= 3 && currentAdj < 5) {
        const res = await setOverride(
          'stock',
          key,
          5,
          `[AutoPilot] 컨센서스 강 상향(net=${signal.netScore}) → 점수 +5`,
          RULES.TTL_CONSENSUS,
          isPaper,
        );
        if (res.ok) {
          overridesSet++;
          decisions.push(`${code} scoreAdj=+5 (consensus BULLISH)`);
        }
      }
    }

    // ── Rule 5: 해외 포지션 forceHold (실적 발표 임박) ──────
    // 해외 보유종목 중 실적 발표 7일 이내는 자동 hold
    // (earnings-drift.ts 데이터 있으면 활용, 없으면 스킵)
    try {
      const { rows: overseas } = await getPool().query(
        `SELECT stock_code FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1`,
        [isPaper],
      );
      for (const row of overseas) {
        const _code = row.stock_code as string;
        // 해외 종목은 블랙리스트/forceHold 보수적 — 기존 로직에 맡김
        // AutoPilot은 국내 중심으로 운영 (해외는 VisionScalp + overseas-job이 관리)
      }
    } catch {
      /* 해외 데이터 없으면 무시 */
    }

    // ── Rule 6: 레퍼런스 만료 정리 ────────────────────────
    try {
      const { rows: expiredRefs } = await getPool().query(
        `UPDATE trading_references SET is_active = false
         WHERE is_active = true AND is_paper = $1 AND expires_at < NOW()
         RETURNING overrides_applied`,
        [isPaper],
      );
      for (const ref of expiredRefs) {
        for (const key of (ref.overrides_applied ?? []) as string[]) {
          await removeOverride(key, isPaper);
          overridesRemoved++;
        }
      }
      if (expiredRefs.length > 0) {
        decisions.push(`ref: ${expiredRefs.length}건 만료 정리`);
      }
    } catch (err) {
      logger.warn(`Reference 정리 [${mode}] 오류: ${err}`, { component: 'AUTO_PILOT' });
    }

    // ── 결과 로깅 ──────────────────────────────────────────
    const result: AutoPilotResult = {
      rulesApplied: 7,
      overridesSet,
      overridesRemoved,
      decisions,
    };

    // 결과 저장 (SSE/대시보드용)
    _lastResult[isPaper ? 'paper' : 'live'] = result;
    _lastResult.lastRunAt = new Date().toISOString();

    if (overridesSet > 0 || overridesRemoved > 0) {
      logger.info(
        `🤖 AutoPilot [${mode}]: ${overridesSet}건 설정, ${overridesRemoved}건 해제 | ${decisions.join(' | ')}`,
        { component: 'AUTO_PILOT' },
      );
    } else {
      logger.info(`🤖 AutoPilot [${mode}]: 변경 없음 (현재 설정 유지)`, { component: 'AUTO_PILOT' });
    }

    return result;
  } catch (err) {
    logger.error(`🤖 AutoPilot [${mode}] 오류: ${err}`, { component: 'AUTO_PILOT' });
    return { rulesApplied: 0, overridesSet: 0, overridesRemoved: 0, decisions: [`ERROR: ${err}`] };
  }
}

/**
 * 종목별 최근 연속 손실 횟수 조회
 */
async function getConsecutiveLosses(isPaper: boolean): Promise<Map<string, number>> {
  const { rows } = await getPool().query(
    `
    WITH recent AS (
      SELECT stock_code, pnl_pct, closed_at,
             ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY closed_at DESC) AS rn
      FROM transaction_chains
      WHERE status = 'CLOSED' AND is_paper = $1
        AND closed_at > NOW() - INTERVAL '30 days'
    ),
    streaks AS (
      SELECT stock_code, pnl_pct, rn,
             CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END AS is_loss
      FROM recent
      WHERE rn <= 10
    )
    SELECT stock_code, COUNT(*) AS streak
    FROM (
      SELECT stock_code, is_loss,
             rn - ROW_NUMBER() OVER (PARTITION BY stock_code, is_loss ORDER BY rn) AS grp
      FROM streaks
    ) g
    WHERE is_loss = 1
    GROUP BY stock_code, grp
    HAVING MIN(rn) = 1
  `,
    [isPaper],
  );

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.stock_code as string, Number(r.streak));
  }
  return map;
}

/**
 * Dual-mode 실행: paper + live 양쪽 모두 실행
 */
export async function runAutoPilotDual(): Promise<void> {
  // 캐시 먼저 리프레시
  await loadOverridesCache().catch(() => {});

  const [paperResult, liveResult] = await Promise.all([
    runWithMode(true, () => runAutoPilot(true)),
    runWithMode(false, () => runAutoPilot(false)),
  ]);

  const totalSet = paperResult.overridesSet + liveResult.overridesSet;
  const totalRemoved = paperResult.overridesRemoved + liveResult.overridesRemoved;
  if (totalSet > 0 || totalRemoved > 0) {
    logger.info(
      `🤖 AutoPilot 완료: paper(${paperResult.overridesSet}↑${paperResult.overridesRemoved}↓) live(${liveResult.overridesSet}↑${liveResult.overridesRemoved}↓)`,
      { component: 'AUTO_PILOT' },
    );
  }

  // 상황 감지: 규칙으로 못 푸는 판단 큐 적재
  const { detectSituationsDual } = await import('./situation-detector.js');
  await detectSituationsDual().catch((err) => logger.error(`상황 감지 실패: ${err}`, { component: 'SITUATION' }));
}
