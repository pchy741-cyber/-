/**
 * 🔍 데이터스누핑 감시 모듈 (Claude CLI)
 *
 * 매일 자기학습/캘리브레이션/백테스팅에서 데이터스누핑(과적합) 여부를 상시 감시.
 * Claude CLI(Sonnet)가 전수조사하여 위험 요소 발견 시 Telegram 경보.
 *
 * 감시 항목:
 *  1. 파라미터 변경 이력 vs holdout 기간 준수 여부
 *  2. 순환 과적합 탐지 (백테스트 결과 → 파라미터 → 같은 백테스트 검증)
 *  3. Paper vs Live 괴리도 추적
 *  4. 인사이트 자기참조 루프 감지
 *  5. 앙상블 가중치 temporal overlap 검증
 *
 * 스케줄: 평일 18:50 KST (자기학습 18:30 직후)
 */

import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { callClaudeCli, isClaudeCliEnabled } from '../utils/claude-cli.js';
import { logger } from '../utils/logger.js';

const COMP = 'SNOOPING_GUARD';

interface SnoopingReport {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  findings: string[];
  recommendations: string[];
}

/** 1. 파라미터 변경 이력 감사 — holdout gap 준수 확인 */
async function auditParamChanges(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `SELECT
         li.insight,
         li.param_change,
         li.applied_at,
         li.confidence,
         li.sample_count,
         li.details,
         li.is_paper
       FROM learned_insights li
       WHERE li.is_applied = true
         AND li.applied_at >= NOW() - INTERVAL '30 days'
       ORDER BY li.applied_at DESC
       LIMIT 20`,
    );

    if (rows.length === 0) return '파라미터 변경 없음 (최근 30일)';

    const lines = rows.map((r: any) => {
      const pc = r.param_change as { field: string; value: any; reason: string } | null;
      const prev = r.details?.previous_value;
      return `[${r.is_paper ? 'P' : 'L'}] ${pc?.field}: ${prev}→${pc?.value} | 신뢰도 ${(r.confidence * 100).toFixed(0)}% | n=${r.sample_count} | ${String(r.insight).slice(0, 60)}`;
    });

    return `### 최근 30일 파라미터 변경 (${rows.length}건)\n${lines.join('\n')}`;
  } catch (e) {
    return `파라미터 변경 조회 실패: ${e}`;
  }
}

/** 2. Paper vs Live 괴리도 측정 */
async function auditPaperLiveDivergence(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `WITH stats AS (
        SELECT
          is_paper,
          COUNT(*) AS trades,
          SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
          AVG((realized_pnl / NULLIF(total_invested, 0)) * 100) AS avg_pnl_pct,
          AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 86400) AS avg_hold_days
        FROM transaction_chains
        WHERE status = 'CLOSED'
          AND closed_at >= NOW() - INTERVAL '30 days'
        GROUP BY is_paper
      )
      SELECT * FROM stats ORDER BY is_paper`,
    );

    if (rows.length < 2) return 'Paper/Live 양쪽 데이터 부족 — 비교 불가';

    const paper = rows.find((r: any) => r.is_paper === true);
    const live = rows.find((r: any) => r.is_paper === false);
    if (!paper || !live) return 'Paper 또는 Live 데이터 없음';

    const pWR = paper.trades > 0 ? (paper.wins / paper.trades * 100).toFixed(1) : '0';
    const lWR = live.trades > 0 ? (live.wins / live.trades * 100).toFixed(1) : '0';

    return `### Paper vs Live 괴리도 (최근 30일)
Paper: ${paper.trades}건, 승률 ${pWR}%, 평균PnL ${Number(paper.avg_pnl_pct).toFixed(2)}%, 보유 ${Number(paper.avg_hold_days).toFixed(1)}일
Live:  ${live.trades}건, 승률 ${lWR}%, 평균PnL ${Number(live.avg_pnl_pct).toFixed(2)}%, 보유 ${Number(live.avg_hold_days).toFixed(1)}일
승률 차이: ${(Number(pWR) - Number(lWR)).toFixed(1)}%p`;
  } catch (e) {
    return `괴리도 조회 실패: ${e}`;
  }
}

/** 3. 앙상블 가중치 변경 이력 — temporal overlap 검증 */
async function auditEnsembleWeights(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `SELECT ensemble_config, is_paper, updated_at
       FROM strategy_config
       WHERE is_active = true
       ORDER BY is_paper`,
    );

    if (rows.length === 0) return '전략 설정 없음';

    const lines = rows.map((r: any) => {
      const cfg = r.ensemble_config as { weights?: Record<string, number>; strategy?: string } | null;
      const weights = cfg?.weights ?? {};
      const wStr = Object.entries(weights).map(([k, v]) => `${k}=${(Number(v) * 100).toFixed(0)}%`).join(', ');
      return `[${r.is_paper ? 'Paper' : 'Live'}] ${wStr} (${cfg?.strategy ?? 'N/A'}) | 갱신: ${new Date(r.updated_at).toISOString().slice(0, 10)}`;
    });

    return `### 앙상블 가중치 현황\n${lines.join('\n')}`;
  } catch (e) {
    return `앙상블 가중치 조회 실패: ${e}`;
  }
}

/** 4. Score Accuracy 분포 — holdout gap 전후 성과 비교 */
async function auditScoreAccuracy(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `WITH recent AS (
        SELECT entry_score, outcome, realized_pnl_pct, is_paper
        FROM score_accuracy
        WHERE recorded_at >= NOW() - INTERVAL '14 days'
          AND entry_score IS NOT NULL
      ),
      holdout AS (
        SELECT entry_score, outcome, realized_pnl_pct, is_paper
        FROM score_accuracy
        WHERE recorded_at BETWEEN NOW() - INTERVAL '90 days' AND NOW() - INTERVAL '14 days'
          AND entry_score IS NOT NULL
      )
      SELECT
        'recent' AS period,
        is_paper,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
        AVG(realized_pnl_pct) AS avg_pnl
      FROM recent GROUP BY is_paper
      UNION ALL
      SELECT
        'holdout' AS period,
        is_paper,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
        AVG(realized_pnl_pct) AS avg_pnl
      FROM holdout GROUP BY is_paper
      ORDER BY period, is_paper`,
    );

    if (rows.length === 0) return 'Score Accuracy 데이터 없음';

    const lines = rows.map((r: any) => {
      const wr = r.total > 0 ? (r.wins / r.total * 100).toFixed(1) : '0';
      return `[${r.period}][${r.is_paper ? 'P' : 'L'}] ${r.total}건, 승률 ${wr}%, 평균PnL ${Number(r.avg_pnl).toFixed(2)}%`;
    });

    return `### Score Accuracy — Holdout(14-90일) vs Recent(0-14일)\n${lines.join('\n')}`;
  } catch (e) {
    return `Score Accuracy 조회 실패: ${e}`;
  }
}

/** 5. 전략 설정 현재값 vs 기본값 비교 */
async function auditStrategyDrift(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `SELECT mode, buy_threshold, take_profit_pct, stop_loss_pct,
              use_dynamic_tpsl, is_paper, updated_at
       FROM strategy_config
       WHERE is_active = true
       ORDER BY is_paper`,
    );

    const lines = rows.map((r: any) =>
      `[${r.is_paper ? 'Paper' : 'Live'}] ${r.mode} | BT=${r.buy_threshold} | TP=${r.take_profit_pct}% | SL=${r.stop_loss_pct}% | DynTPSL=${r.use_dynamic_tpsl} | 갱신: ${new Date(r.updated_at).toISOString().slice(0, 10)}`,
    );

    return `### 전략 설정 현재값\n${lines.join('\n')}`;
  } catch (e) {
    return `전략 설정 조회 실패: ${e}`;
  }
}

/** 6. 인사이트 자기참조 루프 감지 */
async function auditInsightLoops(): Promise<string> {
  try {
    // 같은 field에 대해 반복 적용→롤백→재적용 패턴 탐지
    const { rows } = await getPool().query(
      `SELECT
         (param_change->>'field') AS field,
         COUNT(*) AS change_count,
         COUNT(*) FILTER (WHERE is_applied = true) AS applied,
         COUNT(*) FILTER (WHERE is_dismissed = true) AS dismissed,
         ARRAY_AGG(DISTINCT (param_change->>'value')::text ORDER BY (param_change->>'value')::text) AS values_tried
       FROM learned_insights
       WHERE param_change IS NOT NULL
         AND last_updated >= NOW() - INTERVAL '30 days'
       GROUP BY (param_change->>'field')
       HAVING COUNT(*) >= 3
       ORDER BY COUNT(*) DESC`,
    );

    if (rows.length === 0) return '인사이트 루프 미감지 (정상)';

    const lines = rows.map((r: any) =>
      `${r.field}: ${r.change_count}회 변경시도 (적용 ${r.applied}, 기각 ${r.dismissed}) — 시도값: [${r.values_tried?.join(', ')}]`,
    );

    return `### 인사이트 반복 패턴 (30일)\n${lines.join('\n')}`;
  } catch (e) {
    return `인사이트 루프 조회 실패: ${e}`;
  }
}

/** Claude CLI에게 전수조사 위임 */
async function runClaudeAudit(auditData: string): Promise<SnoopingReport> {
  const systemPrompt = `당신은 알고리즘 트레이딩 시스템의 데이터스누핑(과적합) 감사관입니다.

다음을 검사하세요:
1. **순환 과적합**: 백테스트 결과로 파라미터 설정 → 같은 백테스트로 검증하는 자기참조 루프
2. **Holdout Gap 위반**: 학습 데이터와 평가 데이터가 시간적으로 겹치는 경우
3. **Paper/Live 괴리**: Paper 성과가 Live보다 현저히 좋으면 Paper 필터가 느슨한 것 (과적합 신호)
4. **핫핸드 오류**: 최근 연승 종목에 과도한 가중치를 부여하는 패턴
5. **파라미터 진동**: 같은 필드를 반복적으로 변경-롤백하는 루프 (학습 불안정)
6. **앙상블 가중치 temporal leak**: 가중치 학습 기간과 평가 기간이 겹치는지

JSON으로 반환:
{
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "findings": ["발견 1", "발견 2", ...],
  "recommendations": ["권고 1", "권고 2", ...]
}

규칙:
- findings는 구체적 데이터 근거를 포함 (숫자, 비율 등)
- recommendations는 실행 가능한 수정사항
- 문제 없으면 riskLevel=LOW, findings=["정상"]
- 최대 5개 findings, 3개 recommendations`;

  const userPrompt = `## 데이터스누핑 전수조사 데이터\n\n${auditData}`;

  const text = await callClaudeCli({
    systemPrompt,
    userPrompt,
    model: 'sonnet',
    timeoutMs: 60_000,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { riskLevel: 'LOW', findings: ['Claude 응답 파싱 실패'], recommendations: [] };
  }

  const parsed = JSON.parse(jsonMatch[0]) as SnoopingReport;
  return {
    riskLevel: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(parsed.riskLevel) ? parsed.riskLevel : 'MEDIUM') as SnoopingReport['riskLevel'],
    findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 7) : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
  };
}

/** 7. 전략 최적화기(strategy-optimizer) 순환 과적합 감사
 *
 * strategy_config 변경 이력을 system_state에서 조회하여:
 *   - 같은 모드가 3일 연속 적용됨 = 매일 다른 TP/SL → 파라미터 진동
 *   - OOS 검증 없이 적용 = wfeValidated=false (v10.11.3 이전 데이터)
 *   - 적용 후 Paper 성과 악화 = 최적화→악화 순환
 */
async function auditOptimizerLoop(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `SELECT key, value, updated_at
       FROM system_state
       WHERE key LIKE 'optimizer_%'
       ORDER BY updated_at DESC
       LIMIT 30`,
    );

    if (rows.length === 0) return '### 최적화기 감사\n최적화 이력 없음';

    const findings: string[] = [];

    // 모드별 적용 이력 집계
    const modeHistory = new Map<string, Array<{ applied: boolean; wfeValidated?: boolean; date: string; bestSharpe: number; currentSharpe: number }>>();
    for (const r of rows) {
      const mode = String(r.key).replace('optimizer_', '');
      const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      if (!modeHistory.has(mode)) modeHistory.set(mode, []);
      modeHistory.get(mode)!.push({
        applied: v.applied === true,
        wfeValidated: v.wfeValidated,
        date: v.runAt ?? r.updated_at,
        bestSharpe: Number(v.bestSharpe ?? 0),
        currentSharpe: Number(v.currentSharpe ?? 0),
      });
    }

    for (const [mode, history] of modeHistory) {
      // 3회 연속 적용 = 파라미터 진동
      const recentApplied = history.slice(0, 5).filter((h) => h.applied);
      if (recentApplied.length >= 3) {
        findings.push(`⚠️ ${mode}: 최근 5회 중 ${recentApplied.length}회 TP/SL 변경 — 파라미터 진동 의심`);
      }

      // OOS 검증 없는 적용 감지 (v10.11.3 이전 데이터)
      const noWfe = history.filter((h) => h.applied && h.wfeValidated !== true);
      if (noWfe.length > 0) {
        findings.push(`⚠️ ${mode}: OOS 미검증 적용 ${noWfe.length}건 (순환 과적합 위험)`);
      }

      // Sharpe 하락 추세 (3회+ 적용 후 currentSharpe 하락 = 최적화 역효과)
      const appliedHistory = history.filter((h) => h.applied).slice(0, 4);
      if (appliedHistory.length >= 3) {
        const sharpes = appliedHistory.map((h) => h.currentSharpe);
        const declining = sharpes.every((s, i) => i === 0 || s <= sharpes[i - 1]);
        if (declining && sharpes[sharpes.length - 1] < sharpes[0]) {
          findings.push(`🔴 ${mode}: 최적화 적용 후 Sharpe 하락세 (${sharpes.map((s) => s.toFixed(2)).join('→')}) — 역효과`);
        }
      }
    }

    const lines = rows.slice(0, 10).map((r: any) => {
      const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      const mode = String(r.key).replace('optimizer_', '');
      return `${mode}: ${v.applied ? '적용' : '유지'} TP=${v.bestTp}% SL=${v.bestSl}% Sharpe=${Number(v.bestSharpe ?? 0).toFixed(2)} WFE=${v.wfeValidated ? '✓' : '✗'}`;
    });

    return `### 최적화기 감사 (${findings.length}건 발견)\n${lines.join('\n')}${findings.length > 0 ? '\n\n' + findings.join('\n') : ''}`;
  } catch (e) {
    return `최적화기 감사 실패: ${e}`;
  }
}

/** 통계 기반 자체 감사 (Claude CLI 없을 때) */
async function runStatisticalAudit(auditData: string): Promise<SnoopingReport> {
  const findings: string[] = [];
  const recommendations: string[] = [];

  // Paper/Live 괴리 체크
  try {
    const { rows } = await getPool().query(
      `SELECT is_paper,
              COUNT(*) AS trades,
              AVG(CASE WHEN realized_pnl > 0 THEN 1.0 ELSE 0.0 END) AS win_rate
       FROM transaction_chains
       WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '30 days'
       GROUP BY is_paper`,
    );
    const paper = rows.find((r: any) => r.is_paper);
    const live = rows.find((r: any) => !r.is_paper);
    if (paper && live) {
      const gap = Number(paper.win_rate) - Number(live.win_rate);
      if (gap > 0.15) {
        findings.push(`Paper/Live 승률 괴리 ${(gap * 100).toFixed(1)}%p — Paper 필터가 느슨하거나 과적합 의심`);
        recommendations.push('Paper minTechScore를 Live와 동일하게 설정하여 괴리 축소');
      }
    }
  } catch { /* ignore */ }

  // 파라미터 진동 체크 + 자동 차단 (순환 과적합 원천 차단)
  try {
    const { rows } = await getPool().query(
      `SELECT (param_change->>'field') AS field, COUNT(*) AS cnt, is_paper
       FROM learned_insights
       WHERE param_change IS NOT NULL AND last_updated >= NOW() - INTERVAL '14 days'
         AND COALESCE(is_dismissed, false) IS NOT TRUE
       GROUP BY (param_change->>'field'), is_paper
       HAVING COUNT(*) >= 3`,
    );
    for (const r of rows) {
      findings.push(`${r.field} 파라미터 ${r.cnt}회 변경시도 (14일, ${r.is_paper ? 'Paper' : 'Live'}) — 학습 불안정`);
      recommendations.push(`${r.field} 변경 주기를 최소 7일로 제한`);
      // 3회 이상 진동 → 미적용 인사이트 자동 dismiss (순환 과적합 원천 차단)
      if (Number(r.cnt) >= 3) {
        await getPool().query(
          `UPDATE learned_insights SET is_dismissed = true, dismissed_at = NOW()
           WHERE (param_change->>'field') = $1
             AND is_paper = $2
             AND COALESCE(is_applied, false) IS NOT TRUE
             AND COALESCE(is_dismissed, false) IS NOT TRUE`,
          [r.field, r.is_paper],
        ).catch(() => {});
        findings.push(`→ ${r.field} 미적용 인사이트 자동 dismiss 처리됨 (순환 과적합 차단)`);
      }
    }
  } catch { /* ignore */ }

  // 최적화기 순환 과적합 체크
  try {
    const { rows } = await getPool().query(
      `SELECT key, value FROM system_state WHERE key LIKE 'optimizer_%' ORDER BY updated_at DESC LIMIT 15`,
    );
    const appliedCount = rows.filter((r: any) => {
      const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      return v.applied === true;
    }).length;
    const noWfeCount = rows.filter((r: any) => {
      const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      return v.applied === true && v.wfeValidated !== true;
    }).length;
    if (appliedCount >= 5) {
      findings.push(`전략 최적화기 최근 15회 중 ${appliedCount}회 적용 — 과빈도 변경`);
      recommendations.push('최적화 적용 간격을 최소 7일로 제한');
    }
    if (noWfeCount > 0) {
      findings.push(`최적화기 OOS 미검증 적용 ${noWfeCount}건 — 순환 과적합 위험`);
      recommendations.push('v10.11.3 이상 업데이트 확인 (OOS+WF 검증 필수)');
    }
  } catch { /* ignore */ }

  const riskLevel = findings.length === 0 ? 'LOW' : findings.length <= 2 ? 'MEDIUM' : 'HIGH';
  if (findings.length === 0) findings.push('통계적 이상 미감지 (정상)');

  return { riskLevel: riskLevel as SnoopingReport['riskLevel'], findings, recommendations };
}

/** 메인 실행 함수 — 스케줄러에서 호출 */
export async function runDataSnoopingGuard(): Promise<void> {
  try {
    logger.info('🔍 데이터스누핑 감시 시작', { component: COMP });

    // 감사 데이터 수집 (병렬)
    const [paramChanges, divergence, ensemble, accuracy, drift, loops, optimizerAudit] = await Promise.all([
      auditParamChanges(),
      auditPaperLiveDivergence(),
      auditEnsembleWeights(),
      auditScoreAccuracy(),
      auditStrategyDrift(),
      auditInsightLoops(),
      auditOptimizerLoop(),
    ]);

    const auditData = [paramChanges, divergence, ensemble, accuracy, drift, loops, optimizerAudit].join('\n\n');

    let report: SnoopingReport;

    if (isClaudeCliEnabled()) {
      report = await runClaudeAudit(auditData);
    } else {
      report = await runStatisticalAudit(auditData);
    }

    // 결과 로깅
    const emoji = { LOW: '✅', MEDIUM: '⚠️', HIGH: '🚨', CRITICAL: '🔴' }[report.riskLevel];
    logger.info(`${emoji} 데이터스누핑 감시 결과: ${report.riskLevel} — ${report.findings.length}건 발견`, { component: COMP });

    // MEDIUM 이상일 때 Telegram 경보
    if (report.riskLevel !== 'LOW') {
      const msg = [
        `🔍 *데이터스누핑 감시* [${report.riskLevel}]`,
        '',
        '*발견 사항:*',
        ...report.findings.map((f) => `  • ${f}`),
        '',
        '*권고:*',
        ...report.recommendations.map((r) => `  → ${r}`),
      ].join('\n');

      await sendTelegramMessage(msg).catch(() => {});
    }

    // DB 로그
    try {
      await getPool().query(
        `INSERT INTO system_log (level, component, message, timestamp)
         VALUES ($1, $2, $3, NOW())`,
        [
          report.riskLevel === 'LOW' ? 'INFO' : 'WARN',
          COMP,
          `데이터스누핑 감시: ${report.riskLevel} — ${report.findings.join(' | ')}`,
        ],
      );
    } catch { /* DB 없으면 스킵 */ }

    logger.info(`🔍 데이터스누핑 감시 완료`, { component: COMP });
  } catch (e) {
    logger.error(`데이터스누핑 감시 실패: ${(e as Error).message}`, { component: COMP });
  }
}
