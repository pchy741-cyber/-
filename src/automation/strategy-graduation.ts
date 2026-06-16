/**
 * 전략 졸업 시스템 — Paper 검증 → Live 전환 추천
 *
 * Paper 모드에서 일정 기준(승률·PF·MDD·거래수) 충족 시
 * CEO에게 텔레그램 알림 + system_state 기록.
 * 자동 Live 전환은 하지 않음 (수동 확인 후 활성화).
 */

import { getPool } from '../db/client.js';
import { getAllStrategyPerformances, getStrategyPerformance } from '../risk/strategy-performance.js';
import { logger } from '../utils/logger.js';
import { classifyGraduationRisk } from './strategy-lab/risk-classifier.js';

// ── 졸업 기준 ──────────────────────────────────────────────────────────

export interface GraduationCriteria {
  minTrades: number; // 최소 CLOSED 거래수
  minWinRate: number; // 최소 승률 (0-1)
  minProfitFactor: number; // 최소 Profit Factor
  maxMDD: number; // 최대 연속 드로다운 % (음수)
  evaluationDays: number; // 평가 기간 (일)
}

const DEFAULT_CRITERIA: GraduationCriteria = {
  minTrades: 30,
  minWinRate: 0.55,
  minProfitFactor: 1.5,
  maxMDD: -15,
  evaluationDays: 30,
};

// BREAKOUT은 별도 기준 (돌파매매 특성 반영)
const BREAKOUT_CRITERIA: GraduationCriteria = {
  minTrades: 20, // 돌파 시그널 빈도 낮음
  minWinRate: 0.5, // 손익비 1.6:1이므로 50%면 충분
  minProfitFactor: 1.3,
  maxMDD: -20, // SL -5% 감안 완화
  evaluationDays: 30,
};

export interface GraduationResult {
  mode: string;
  eligible: boolean;
  criteria: GraduationCriteria;
  actual: {
    trades: number;
    winRate: number;
    profitFactor: number;
    mdd: number;
  };
  passedChecks: string[];
  failedChecks: string[];
  recommendation: string;
}

// ── 졸업 검사 ──────────────────────────────────────────────────────────

export async function checkGraduation(mode: string): Promise<GraduationResult> {
  const criteria = mode === 'BREAKOUT' ? BREAKOUT_CRITERIA : DEFAULT_CRITERIA;
  const perf = await getStrategyPerformance(mode, criteria.evaluationDays, true);

  const actual = {
    trades: perf.totalTrades,
    winRate: perf.winRate,
    profitFactor: perf.profitFactor,
    mdd: perf.maxDrawdownPct,
  };

  const passed: string[] = [];
  const failed: string[] = [];

  if (actual.trades >= criteria.minTrades) passed.push(`trades(${actual.trades}>=${criteria.minTrades})`);
  else failed.push(`trades(${actual.trades}<${criteria.minTrades})`);

  if (actual.winRate >= criteria.minWinRate)
    passed.push(`winRate(${(actual.winRate * 100).toFixed(0)}%>=${(criteria.minWinRate * 100).toFixed(0)}%)`);
  else failed.push(`winRate(${(actual.winRate * 100).toFixed(0)}%<${(criteria.minWinRate * 100).toFixed(0)}%)`);

  if (actual.profitFactor >= criteria.minProfitFactor)
    passed.push(`PF(${actual.profitFactor.toFixed(2)}>=${criteria.minProfitFactor})`);
  else failed.push(`PF(${actual.profitFactor.toFixed(2)}<${criteria.minProfitFactor})`);

  if (actual.mdd >= criteria.maxMDD) passed.push(`MDD(${actual.mdd.toFixed(1)}%>=${criteria.maxMDD}%)`);
  else failed.push(`MDD(${actual.mdd.toFixed(1)}%<${criteria.maxMDD}%)`);

  const eligible = failed.length === 0;

  const recommendation = eligible
    ? `${mode} 전략 Live 전환 준비 완료! ${passed.length}/4 기준 충족. CEO 확인 후 활성화 권장.`
    : `${mode} 전략 아직 미달: ${failed.join(', ')}. 추가 Paper 테스트 필요.`;

  return { mode, eligible, criteria, actual, passedChecks: passed, failedChecks: failed, recommendation };
}

// ── 전체 전략 자동 졸업 검사 ────────────────────────────────────────────

export async function autoGraduate(): Promise<void> {
  try {
    const pool = getPool();

    // 만료된 PENDING 건 자동 처리
    await pool
      .query(`
      UPDATE strategy_graduations SET status = 'EXPIRED'
      WHERE status = 'PENDING' AND expires_at < NOW()
    `)
      .catch(() => {});

    const allPerfs = await getAllStrategyPerformances(30, true);
    if (allPerfs.length === 0) {
      logger.info('🎓 졸업 검사: Paper 거래 내역 없음', { component: 'GRADUATION' });
      return;
    }

    logger.info(`🎓 ═══ 전략 졸업 검사 (${allPerfs.length}개 전략) ═══`, { component: 'GRADUATION' });

    for (const perf of allPerfs) {
      const result = await checkGraduation(perf.mode);

      if (result.eligible) {
        const risk = classifyGraduationRisk(result, result.criteria);

        // 이미 PENDING 건이 있으면 스킵
        const existing = await pool
          .query(`SELECT id FROM strategy_graduations WHERE strategy_mode = $1 AND status = 'PENDING'`, [perf.mode])
          .catch(() => ({ rows: [] }));
        if (existing.rows.length > 0) {
          logger.info(`  ⏳ ${perf.mode}: 이미 대기 중인 졸업 건 있음 — 스킵`, { component: 'GRADUATION' });
          continue;
        }

        const margin = {
          winRate: `+${((result.actual.winRate - result.criteria.minWinRate) * 100).toFixed(1)}%p`,
          profitFactor: `+${(result.actual.profitFactor - result.criteria.minProfitFactor).toFixed(2)}`,
          mdd: `+${(result.actual.mdd - result.criteria.maxMDD).toFixed(1)}%p`,
        };

        const status = risk.autoApply ? 'AUTO_APPLIED' : 'PENDING';

        logger.info(
          `  🎉 ${perf.mode}: 졸업 자격 충족! [${risk.level}] ${risk.autoApply ? '→ 자동적용' : '→ CEO 승인 대기'} ` +
            `${perf.totalTrades}건 승률${(perf.winRate * 100).toFixed(0)}% PF=${perf.profitFactor.toFixed(2)} MDD=${perf.maxDrawdownPct.toFixed(1)}%`,
          { component: 'GRADUATION' },
        );

        // strategy_graduations 테이블에 기록
        await pool
          .query(
            `
          INSERT INTO strategy_graduations
            (strategy_mode, risk_level, status, trades, win_rate, profit_factor, mdd,
             total_pnl_krw, avg_holding_days, criteria_margin,
             auto_applied, decided_by, decided_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${risk.autoApply ? 'NOW()' : 'NULL'})
        `,
            [
              perf.mode,
              risk.level,
              status,
              perf.totalTrades,
              perf.winRate,
              perf.profitFactor,
              perf.maxDrawdownPct,
              perf.totalPnlKrw,
              perf.avgHoldingDays,
              JSON.stringify(margin),
              risk.autoApply,
              risk.autoApply ? 'SYSTEM' : null,
            ],
          )
          .catch((e) => logger.warn(`졸업 기록 실패: ${e}`, { component: 'GRADUATION' }));

        // system_state 기록 (레거시 호환)
        await pool
          .query(
            `
          INSERT INTO system_state (key, value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
        `,
            [
              `graduation_${perf.mode}_eligible`,
              JSON.stringify({
                eligible: true,
                riskLevel: risk.level,
                status,
                checkedAt: new Date().toISOString(),
                trades: perf.totalTrades,
                winRate: perf.winRate,
                profitFactor: perf.profitFactor,
                mdd: perf.maxDrawdownPct,
                totalPnlKrw: perf.totalPnlKrw,
              }),
            ],
          )
          .catch(() => {});

        // 텔레그램 알림
        try {
          const { sendTelegramMessage } = await import('../notifications/telegram.js');
          const emoji = risk.level === 'HIGH' ? '🔴' : risk.level === 'MEDIUM' ? '🟡' : '🟢';
          await sendTelegramMessage(
            `🎓 전략 졸업 ${risk.autoApply ? '자동적용' : '승인 필요'}\n\n` +
              `전략: ${perf.mode} ${emoji} ${risk.level}\n` +
              `거래수: ${perf.totalTrades}건\n` +
              `승률: ${(perf.winRate * 100).toFixed(0)}%\n` +
              `PF: ${perf.profitFactor.toFixed(2)}\n` +
              `MDD: ${perf.maxDrawdownPct.toFixed(1)}%\n` +
              `PnL: ${(perf.totalPnlKrw / 10000).toFixed(0)}만원\n` +
              `사유: ${risk.reasons.join(', ')}\n\n` +
              (risk.autoApply ? '✅ 자동 적용 완료' : '→ 대시보드 전략 Lab에서 승인'),
          ).catch(() => {});
        } catch {
          /* 텔레그램 미설정 시 무시 */
        }
      } else {
        logger.info(
          `  📝 ${perf.mode}: 미달 [${result.failedChecks.join(', ')}] ` +
            `(${perf.totalTrades}건 승률${(perf.winRate * 100).toFixed(0)}%)`,
          { component: 'GRADUATION' },
        );
      }
    }
  } catch (e) {
    logger.error(`졸업 검사 실패: ${e}`, { component: 'GRADUATION' });
  }
}

// ── 동적 PAPER_ONLY_MODES ──────────────────────────────────────────

const DEFAULT_PAPER_ONLY = ['BREAKOUT', 'SNIPER', 'BOTTOM_FISHING'];
let _paperOnlyCache: { modes: Set<string>; ts: number } | null = null;
const PAPER_ONLY_CACHE_TTL = 30 * 60_000; // 30분

/**
 * 졸업 테이블 기반 동적 PAPER_ONLY_MODES
 * AUTO_APPLIED/APPROVED 상태인 전략은 제외 (Live 매수 허용)
 */
export async function getPaperOnlyModes(): Promise<Set<string>> {
  const now = Date.now();
  if (_paperOnlyCache && now - _paperOnlyCache.ts < PAPER_ONLY_CACHE_TTL) {
    return _paperOnlyCache.modes;
  }

  const paperOnly = new Set(DEFAULT_PAPER_ONLY);
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT strategy_mode FROM strategy_graduations
       WHERE status IN ('AUTO_APPLIED', 'APPROVED')
       AND decided_at >= NOW() - INTERVAL '90 days'`,
    );
    for (const row of rows) {
      paperOnly.delete(row.strategy_mode);
    }
    logger.debug(
      `🎓 PAPER_ONLY: [${[...paperOnly].join(',')}] (졸업: [${rows.map((r: any) => r.strategy_mode).join(',')}])`,
      { component: 'GRADUATION' },
    );
  } catch {}

  _paperOnlyCache = { modes: paperOnly, ts: now };
  return paperOnly;
}

/** PAPER_ONLY 캐시 무효화 */
export function invalidatePaperOnlyCache(): void {
  _paperOnlyCache = null;
}

// ── 강등 검사 ──────────────────────────────────────────────────────────

/**
 * 졸업 후 Live 성과 악화 시 PAPER_ONLY로 복귀
 * 기준: 14일간 10건+ 거래, 승률 < 40% OR PF < 1.0
 */
export async function checkDemotion(): Promise<void> {
  const pool = getPool();
  try {
    const { rows: graduated } = await pool.query(
      `SELECT DISTINCT strategy_mode FROM strategy_graduations
       WHERE status IN ('AUTO_APPLIED', 'APPROVED')`,
    );
    if (graduated.length === 0) return;

    for (const row of graduated) {
      const mode = row.strategy_mode;
      const livePerf = await getStrategyPerformance(mode, 14, false);

      if (livePerf.totalTrades < 10) continue; // 표본 부족 — 유보

      const shouldDemote = livePerf.winRate < 0.4 || livePerf.profitFactor < 1.0;
      if (!shouldDemote) continue;

      // 강등 처리
      await pool.query(
        `UPDATE strategy_graduations SET status = 'REVOKED', decided_at = NOW(), decided_by = 'SYSTEM_DEMOTION'
         WHERE strategy_mode = $1 AND status IN ('AUTO_APPLIED', 'APPROVED')`,
        [mode],
      );

      _paperOnlyCache = null; // 캐시 무효화

      logger.warn(
        `⚠️ ${mode} 전략 강등: Live 14일 성과 악화 (승률 ${(livePerf.winRate * 100).toFixed(0)}%, PF ${livePerf.profitFactor.toFixed(2)}) → PAPER_ONLY 복귀`,
        { component: 'GRADUATION' },
      );

      try {
        const { sendTelegramMessage } = await import('../notifications/telegram.js');
        await sendTelegramMessage(
          `⚠️ *전략 강등*\n\n${mode}: Live 14일 성과 미달\n승률: ${(livePerf.winRate * 100).toFixed(0)}%\nPF: ${livePerf.profitFactor.toFixed(2)}\n→ Paper 모드로 복귀`,
        ).catch(() => {});
      } catch {}
    }
  } catch (e) {
    logger.error(`강등 검사 실패: ${e}`, { component: 'GRADUATION' });
  }
}
