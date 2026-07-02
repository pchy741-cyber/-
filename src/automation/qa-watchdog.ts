/**
 * QA Watchdog — 혁신적 품질 상시감시 시스템
 *
 * 소넷이 돌면서 코드+런타임 전수조사:
 * 1. 금액 정합성 — 스냅샷 vs 실시간 잔고 교차 검증
 * 2. Paper/Live 크로스 오염 — DB 교차 쿼리로 감지
 * 3. 매매 로직 버그 — 주문/체인 상태 이상 감지
 * 4. AI 비용 이상 — 급등 감지
 * 5. 시스템 이벤트 트렌드 — 에러율 급증 감지
 *
 * 실행: 평일 08:00(해외장 마감 후), 17:00(국내장 마감 후) — 하루 2회
 * 출력: 이슈 발견 시 이메일 + 텔레그램 즉시 알림
 */

import { runWithMode } from '../config/context.js';
import { paperOnly } from '../config/index.js';
import { getOpenChains, getPool } from '../db/client.js';
import { safeQuery } from '../db/pool.js';
import { getAccountBalance } from '../kis/account.js';
import { escapeHtml, sendAlertEmail } from '../notifications/email.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

const COMPONENT = 'QA_WATCHDOG';

export interface QAIssue {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  category: '정합성' | '크로스오염' | '매매로직' | 'AI비용' | '시스템';
  title: string;
  detail: string;
}

export interface QAAction {
  level: 'danger' | 'warn' | 'info';
  action: string;
  apiHint?: string;
}

export interface QAReport {
  runAt: string;
  elapsedSec: number;
  issues: QAIssue[];
  critical: number;
  warning: number;
  info: number;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  actions: QAAction[];
}

// 인메모리 캐시 (DB 조회 부하 절감)
let _cachedReports: QAReport[] | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 60_000; // 1분

/** DB에서 최근 QA 리포트 조회 (캐시 포함) */
export async function getQAReports(): Promise<QAReport[]> {
  if (_cachedReports && Date.now() - _cacheTs < CACHE_TTL_MS) return _cachedReports;
  try {
    const { rows } = await getPool().query(
      `SELECT run_at, elapsed_sec, issues, critical, warning, info, status
       FROM qa_reports ORDER BY run_at DESC LIMIT 20`,
    );
    _cachedReports = rows.map((r: any) => ({
      runAt: r.run_at,
      elapsedSec: Number(r.elapsed_sec),
      issues: r.issues ?? [],
      critical: Number(r.critical),
      warning: Number(r.warning),
      info: Number(r.info),
      status: r.status,
      score: Math.max(0, 100 - Number(r.critical) * 25 - Number(r.warning) * 10 - Number(r.info) * 2),
      actions: deriveQAActions(r.issues ?? []),
    }));
    _cacheTs = Date.now();
    return _cachedReports;
  } catch {
    return _cachedReports ?? [];
  }
}

/** 최신 QA 리포트 1개 */
export async function getLatestQAReport(): Promise<QAReport | null> {
  const reports = await getQAReports();
  return reports[0] ?? null;
}

export async function runQAWatchdog(): Promise<void> {
  const startMs = Date.now();
  const issues: QAIssue[] = [];

  try {
    // 병렬 전수조사 (v17: 대형손실 감지 추가)
    const results = await Promise.allSettled([
      checkBalanceIntegrity(issues),
      checkCrossContamination(issues),
      checkTradingLogic(issues),
      checkAICostAnomaly(issues),
      checkSystemHealth(issues),
      checkOrderChainConsistency(issues),
      checkProfitability(issues),
      checkTradeLatency(issues),
      checkLargeLoss(issues),
    ]);

    // 실패한 검사 자체도 이슈로 기록
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const names = ['잔고정합', '크로스오염', '매매로직', 'AI비용', '시스템헬스', '주문체인', '수익성', '매매딜레이', '대형손실'];
        issues.push({
          severity: 'WARNING',
          category: '시스템',
          title: `${names[i]} 검사 실패`,
          detail: String(r.reason),
        });
      }
    });

    const elapsedSec = (Date.now() - startMs) / 1000;
    const elapsed = elapsedSec.toFixed(1);
    const critical = issues.filter((i) => i.severity === 'CRITICAL');
    const warnings = issues.filter((i) => i.severity === 'WARNING');
    const infos = issues.filter((i) => i.severity === 'INFO');

    // 리포트 저장 (DB 영구 + 캐시 무효화)
    const score = Math.max(0, 100 - critical.length * 25 - warnings.length * 10 - infos.length * 2);
    const qaActions = deriveQAActions(issues);
    const report: QAReport = {
      runAt: getKSTNow().toISOString(),
      elapsedSec,
      issues,
      critical: critical.length,
      warning: warnings.length,
      info: infos.length,
      status: critical.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
      score,
      actions: qaActions,
    };
    try {
      await getPool().query(
        `INSERT INTO qa_reports (run_at, elapsed_sec, issues, critical, warning, info, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [report.runAt, report.elapsedSec, JSON.stringify(report.issues),
         report.critical, report.warning, report.info, report.status],
      );
      // 30일 넘은 리포트 정리
      await getPool().query(`DELETE FROM qa_reports WHERE run_at < NOW() - INTERVAL '30 days'`).catch(() => {});
    } catch (err) {
      logger.warn(`QA 리포트 DB 저장 실패: ${err}`, { component: COMPONENT });
    }
    _cachedReports = null; // 캐시 무효화

    if (issues.length === 0) {
      logger.info(`✅ QA Watchdog 전수조사 통과 (${elapsed}s)`, { component: COMPONENT });
      return;
    }

    // 이슈 발견 → 알림 발송
    logger.warn(
      `🔍 QA Watchdog: ${critical.length} CRITICAL, ${warnings.length} WARNING, ${infos.length} INFO (${elapsed}s)`,
      { component: COMPONENT },
    );

    // 텔레그램 (간결 + 스코어)
    const teleMsg = [
      `🔍 *QA Watchdog* [SCORE: ${score}/100]`,
      `⏱️ ${elapsed}s · ${getKSTNow().toISOString().slice(0, 16)}`,
      '',
      ...critical.map((i) => `🔴 [${i.category}] ${i.title}`),
      ...warnings.map((i) => `🟡 [${i.category}] ${i.title}`),
      ...infos.slice(0, 3).map((i) => `🔵 [${i.category}] ${i.title}`),
      infos.length > 3 ? `  ... +${infos.length - 3}건 INFO` : '',
    ]
      .filter(Boolean)
      .join('\n');
    await sendTelegramMessage(teleMsg).catch(() => {});

    // 이메일 (상세 HTML) — CRITICAL/WARNING 있을 때만
    if (critical.length > 0 || warnings.length > 0) {
      await sendAlertEmail({
        subject: `🔍 [QA] ${critical.length} CRITICAL, ${warnings.length} WARNING 감지`,
        html: buildQAHtml(issues, elapsed),
      });
    }
  } catch (err) {
    logger.error(`QA Watchdog 실패: ${err}`, { component: COMPONENT });
  }
}

// ═══════════════════════════════════════════
//  검사 모듈들
// ═══════════════════════════════════════════

/** 1. 잔고 정합성 — 스냅샷 vs 실시간 잔고 교차 검증 */
async function checkBalanceIntegrity(issues: QAIssue[]): Promise<void> {
  // 오늘 첫 스냅샷과 현재 잔고 비교 (is_paper 별로 최신 1개씩 → 중복 CRITICAL 방지)
  const today = getKSTNow().toISOString().split('T')[0];

  const { rows: snapshots } = await safeQuery<Record<string, unknown>>(
    `SELECT DISTINCT ON (is_paper) total_value, cash_balance, invested_value, is_paper
     FROM portfolio_snapshots
     WHERE snapshot_at >= $1
     ORDER BY is_paper, snapshot_at DESC`,
    [`${today}T00:00:00+09:00`],
  );

  // 오늘 매매 발생 여부 확인 — 매매 있으면 잔고 변동 자연스러우므로 임계값 완화
  const { rows: todayTradeRows } = await safeQuery<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM orders WHERE status = 'FILLED' AND created_at >= $1`,
    [`${today}T00:00:00+09:00`],
  );
  const hasTodayTrades = Number(todayTradeRows[0]?.cnt ?? 0) > 0;

  for (const snap of snapshots) {
    const isPaper = Boolean(snap.is_paper);
    try {
      const balance = await runWithMode(isPaper, async () => {
        return isPaper
          ? await (await import('../risk/engine.js')).getPaperBalance()
          : await getAccountBalance(true);
      });

      const snapTotal = Number(snap.total_value ?? 0);
      // snapshot-job.ts의 total_value는 국내+해외 합산이므로, 비교 대상도 해외분을 포함해야 함
      // (해외분 누락 시 정상 잔고인데도 CRITICAL 괴리로 오탐됨)
      const { getOverseasValueKrw } = await import('../scheduler/snapshot-job.js');
      const overseasKrw = await getOverseasValueKrw(isPaper).catch(() => ({ totalKrw: 0, unrealizedPnlKrw: 0 }));
      const liveTotal = balance.orderableCash + balance.totalEvalAmount + overseasKrw.totalKrw;

      if (snapTotal > 0) {
        const diffPct = Math.abs((liveTotal - snapTotal) / snapTotal) * 100;
        // 매매 발생 시: 20% 이상만 CRITICAL, 15% WARNING (매매로 인한 변동 감안)
        // 매매 없을 때: 10% CRITICAL, 5% WARNING
        const critThreshold = hasTodayTrades ? 20 : 10;
        const warnThreshold = hasTodayTrades ? 15 : 5;

        if (diffPct > critThreshold) {
          issues.push({
            severity: 'CRITICAL',
            category: '정합성',
            title: `${isPaper ? 'PAPER' : 'LIVE'} 총자산 스냅샷 괴리 ${diffPct.toFixed(1)}%`,
            detail: `스냅샷: ${snapTotal.toLocaleString()}원 vs 현재: ${liveTotal.toLocaleString()}원`,
          });
        } else if (diffPct > warnThreshold) {
          issues.push({
            severity: 'WARNING',
            category: '정합성',
            title: `${isPaper ? 'PAPER' : 'LIVE'} 총자산 변동 ${diffPct.toFixed(1)}%`,
            detail: `스냅샷: ${snapTotal.toLocaleString()}원 → 현재: ${liveTotal.toLocaleString()}원`,
          });
        }
      }
    } catch {
      // 잔고 조회 실패 — live KIS API 등
    }
  }
}

/** 2. Paper/Live 크로스 오염 감지 */
async function checkCrossContamination(issues: QAIssue[]): Promise<void> {
  const pool = getPool();

  // 체인의 is_paper와 연결된 주문의 trading_mode 교차 확인
  const { rows: crossOrders } = await pool.query(`
    SELECT DISTINCT tc.id, tc.stock_code, tc.is_paper AS chain_paper, o.trading_mode
    FROM transaction_chains tc
    JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED'
    WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      AND ((tc.is_paper = true AND o.trading_mode = 'live')
        OR (tc.is_paper = false AND o.trading_mode = 'paper'))
  `);

  for (const r of crossOrders) {
    issues.push({
      severity: 'CRITICAL',
      category: '크로스오염',
      title: `모드 불일치: ${r.stock_code}`,
      detail: `체인=${r.chain_paper ? 'PAPER' : 'LIVE'} vs 주문=${r.trading_mode}`,
    });
  }

  // 최근 1시간 동일 종목이 paper+live 양쪽에서 체결
  const { rows: dualMode } = await pool.query(`
    SELECT stock_code, COUNT(DISTINCT CASE WHEN is_paper THEN 'paper' ELSE 'live' END) AS mode_cnt
    FROM orders
    WHERE status = 'FILLED' AND created_at >= NOW() - INTERVAL '1 hour'
    GROUP BY stock_code
    HAVING COUNT(DISTINCT CASE WHEN is_paper THEN 'paper' ELSE 'live' END) > 1
  `);

  for (const r of dualMode) {
    issues.push({
      severity: 'WARNING',
      category: '크로스오염',
      title: `동시 양모드 체결: ${r.stock_code}`,
      detail: `최근 1시간 내 paper+live 양쪽에서 체결됨 — 의도 확인 필요`,
    });
  }
}

/** 3. 매매 로직 이상 감지 */
async function checkTradingLogic(issues: QAIssue[]): Promise<void> {
  const pool = getPool();

  // 동일 종목 1분 내 중복 주문 (모드별 구분)
  const { rows: dupOrders } = await pool.query(`
    SELECT stock_code, side, is_paper, COUNT(*) as cnt,
           MIN(created_at) as first_at, MAX(created_at) as last_at
    FROM orders
    WHERE status = 'FILLED' AND created_at >= NOW() - INTERVAL '4 hours'
    GROUP BY stock_code, side, is_paper,
             DATE_TRUNC('minute', created_at)
    HAVING COUNT(*) > 1
  `);

  for (const r of dupOrders) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    issues.push({
      severity: 'WARNING',
      category: '매매로직',
      title: `[${mode}] 1분 내 중복 ${r.side}: ${r.stock_code} (${r.cnt}건)`,
      detail: `${r.first_at} ~ ${r.last_at}`,
    });
  }

  // 매수 직후 즉시 매도 (1분 이내) — 로직 버그 의심 (같은 모드 내에서만 비교)
  const { rows: quickFlip } = await pool.query(`
    SELECT b.stock_code, b.is_paper, b.created_at AS buy_at, s.created_at AS sell_at
    FROM orders b
    JOIN orders s ON b.stock_code = s.stock_code
      AND s.side = 'SELL' AND s.status = 'FILLED'
      AND s.is_paper = b.is_paper
      AND s.created_at BETWEEN b.created_at AND b.created_at + INTERVAL '1 minute'
    WHERE b.side = 'BUY' AND b.status = 'FILLED'
      AND b.created_at >= NOW() - INTERVAL '4 hours'
  `);

  for (const r of quickFlip) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    issues.push({
      severity: 'CRITICAL',
      category: '매매로직',
      title: `[${mode}] 즉시 반전: ${r.stock_code} (매수→매도 1분 이내)`,
      detail: `매수: ${r.buy_at}, 매도: ${r.sell_at}`,
    });
  }

  // OPEN 체인인데 total_quantity <= 0
  const { rows: zeroQty } = await pool.query(`
    SELECT stock_code, is_paper, total_quantity, status
    FROM transaction_chains
    WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND total_quantity <= 0
  `);

  for (const r of zeroQty) {
    issues.push({
      severity: 'CRITICAL',
      category: '매매로직',
      title: `0수량 열린 체인: ${r.stock_code} (${r.is_paper ? 'PAPER' : 'LIVE'})`,
      detail: `상태=${r.status}, 수량=${r.total_quantity}`,
    });
  }
}

/** 4. AI 비용 이상 감지 */
async function checkAICostAnomaly(issues: QAIssue[]): Promise<void> {
  const today = getKSTNow().toISOString().split('T')[0];

  // 오늘 비용
  const { rows: todayRows } = await safeQuery<{ total_cost: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM ai_token_usage WHERE created_at >= $1`,
    [`${today}T00:00:00+09:00`],
  );
  const todayCost = Number(todayRows[0]?.total_cost ?? 0);

  // 최근 7일 평균
  const { rows: avgRows } = await safeQuery<{ avg_cost: string }>(
    `SELECT COALESCE(AVG(daily_cost), 0) as avg_cost FROM (
       SELECT DATE(created_at AT TIME ZONE 'Asia/Seoul') as d, SUM(cost_usd) as daily_cost
       FROM ai_token_usage
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY d
     ) sub`,
    [],
  );
  const avgCost = Number(avgRows[0]?.avg_cost ?? 0);

  // 평균의 3배 초과 → 이상
  if (avgCost > 0 && todayCost > avgCost * 3) {
    issues.push({
      severity: 'WARNING',
      category: 'AI비용',
      title: `AI 비용 급등: $${todayCost.toFixed(4)} (평균의 ${(todayCost / avgCost).toFixed(1)}배)`,
      detail: `7일 평균: $${avgCost.toFixed(4)}/일, 오늘: $${todayCost.toFixed(4)}`,
    });
  }
}

/** 5. 시스템 헬스 체크 */
async function checkSystemHealth(issues: QAIssue[]): Promise<void> {
  // 최근 1시간 에러 건수 — UPPER() 대소문자 무관 (DB: 'ERROR'/'WARN' 대문자)
  const { rows: errorRows } = await safeQuery<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM system_log
     WHERE UPPER(level) = 'ERROR' AND timestamp >= NOW() - INTERVAL '1 hour'`,
    [],
  );
  const recentErrors = Number(errorRows[0]?.cnt ?? 0);

  if (recentErrors >= 10) {
    // 에러 상위 컴포넌트 파악
    const { rows: topComponents } = await safeQuery<{ component: string; cnt: string }>(
      `SELECT component, COUNT(*) as cnt FROM system_log
       WHERE UPPER(level) = 'ERROR' AND timestamp >= NOW() - INTERVAL '1 hour'
       GROUP BY component ORDER BY cnt DESC LIMIT 3`,
      [],
    );
    const topStr = topComponents.map((r) => `${r.component}(${r.cnt})`).join(', ');
    issues.push({
      severity: 'CRITICAL',
      category: '시스템',
      title: `1시간 에러 ${recentErrors}건 — 시스템 불안정`,
      detail: `최근 1시간 에러 급증. 주요 컴포넌트: ${topStr || '확인 필요'}`,
    });
  } else if (recentErrors >= 5) {
    issues.push({
      severity: 'WARNING',
      category: '시스템',
      title: `1시간 에러 ${recentErrors}건`,
      detail: `에러율 증가 추세. 모니터링 필요.`,
    });
  }

  // Kill Switch 장기 활성 체크 (2시간+)
  try {
    const { getKillSwitchStatusAll } = await import('../risk/kill-switch.js');
    const ks = getKillSwitchStatusAll();
    for (const [key, status] of Object.entries(ks)) {
      const s = status as Record<string, unknown>;
      if (s.active && s.activatedAt) {
        const hours = (Date.now() - new Date(String(s.activatedAt)).getTime()) / 3600_000;
        if (hours >= 2) {
          issues.push({
            severity: 'WARNING',
            category: '시스템',
            title: `Kill Switch [${key}] ${hours.toFixed(1)}시간 활성`,
            detail: `사유: ${String(s.reason ?? '알 수 없음')}`,
          });
        }
      }
    }
  } catch {
    // kill switch 상태 조회 실패 — 무시
  }
}

/** 6. 주문-체인 상세 일관성 */
async function checkOrderChainConsistency(issues: QAIssue[]): Promise<void> {
  const pool = getPool();

  // 체인 avg_buy_price가 0 or NULL인 열린 체인
  const { rows: zeroPriceChains } = await pool.query(`
    SELECT stock_code, is_paper, avg_buy_price, total_quantity
    FROM transaction_chains
    WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      AND (avg_buy_price IS NULL OR avg_buy_price <= 0)
      AND total_quantity > 0
  `);

  for (const r of zeroPriceChains) {
    issues.push({
      severity: 'CRITICAL',
      category: '정합성',
      title: `평단가 0/NULL: ${r.stock_code} (${r.is_paper ? 'PAPER' : 'LIVE'})`,
      detail: `${r.total_quantity}주 보유 중인데 avg_buy_price=${r.avg_buy_price}`,
    });
  }

  // v20: 기존엔 total_invested(부분매도 반영 후 "현재 순보유가치")를 BUY 주문 총합(부분매도
  // 무관 "누적 매수 총액")과 비교해서, 부분매도 이력이 있는 모든 정상 체인이 오탐(false positive)
  // 처리되던 버그였음 — 실제 DB 조사 결과 total_invested는 avg_buy_price × total_quantity와
  // 정확히 일치(정상)했는데도 "불일치"로 잘못 잡혔음. 자기정합성(total_invested ≈ 평단가×수량)으로 교체.
  const { rows: investMismatch } = await pool.query(`
    SELECT stock_code, is_paper, total_invested, avg_buy_price, total_quantity,
           (avg_buy_price * total_quantity) AS expected_invested
    FROM transaction_chains
    WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      AND total_invested > 0
      AND ABS(total_invested - (avg_buy_price * total_quantity)) > total_invested * 0.1
  `);

  for (const r of investMismatch) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    issues.push({
      severity: 'WARNING',
      category: '정합성',
      title: `[${mode}] 투자금 불일치: ${r.stock_code}`,
      detail: `체인 total_invested: ${Number(r.total_invested).toLocaleString()}원 vs 평단가×수량: ${Number(r.expected_invested).toLocaleString()}원`,
    });
  }
}

/** 7. v16: 수익성 분석 — 손실 패턴 감지 */
async function checkProfitability(issues: QAIssue[]): Promise<void> {
  const pool = getPool();

  // 최근 7일 승률 (paper + live 각각)
  for (const isPaper of [false, true]) {
    const mode = isPaper ? 'PAPER' : 'LIVE';
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE pnl_pct > 0) as wins,
        COALESCE(AVG(pnl_pct), 0) as avg_pnl,
        COALESCE(SUM(realized_pnl), 0) as total_pnl
      FROM transaction_chains
      WHERE is_paper = $1 AND status = 'CLOSED'
        AND closed_at >= NOW() - INTERVAL '7 days'
    `, [isPaper]);

    const total = Number(rows[0]?.total ?? 0);
    if (total < 3) continue;

    const wins = Number(rows[0]?.wins ?? 0);
    const wr = wins / total;
    const avgPnl = Number(rows[0]?.avg_pnl ?? 0);
    const totalPnl = Number(rows[0]?.total_pnl ?? 0);

    if (wr < 0.25 && total >= 5) {
      issues.push({
        severity: 'CRITICAL',
        category: '매매로직',
        title: `[${mode}] 7일 승률 ${(wr * 100).toFixed(0)}% (${wins}/${total}건)`,
        detail: `평균 PnL ${avgPnl.toFixed(2)}%, 누적 ${totalPnl.toLocaleString()}원 — 전략 재검토 필요`,
      });
    } else if (wr < 0.40 && total >= 5) {
      issues.push({
        severity: 'WARNING',
        category: '매매로직',
        title: `[${mode}] 7일 승률 ${(wr * 100).toFixed(0)}% (${wins}/${total}건)`,
        detail: `평균 PnL ${avgPnl.toFixed(2)}%, 누적 ${totalPnl.toLocaleString()}원`,
      });
    }

    // 연패 감지 (5연패 이상)
    const { rows: recentTrades } = await pool.query(`
      SELECT pnl_pct FROM transaction_chains
      WHERE is_paper = $1 AND status = 'CLOSED'
      ORDER BY closed_at DESC LIMIT 10
    `, [isPaper]);

    let streak = 0;
    for (const t of recentTrades) {
      if (Number(t.pnl_pct) < 0) streak++;
      else break;
    }
    if (streak >= 5) {
      issues.push({
        severity: 'WARNING',
        category: '매매로직',
        title: `[${mode}] ${streak}연패 진행 중`,
        detail: `최근 ${streak}건 연속 손실 — 쿨다운 또는 전략 변경 고려`,
      });
    }
  }
}

/** 8. v16: 매매 딜레이 체크 — 주문 지연 감지 */
async function checkTradeLatency(issues: QAIssue[]): Promise<void> {
  const pool = getPool();

  // 체결 지연: updated_at - created_at 기준 (orders에 filled_at 없음 → updated_at 대체)
  // v20: 기존엔 is_paper=false로 LIVE만 검사 — PAPER도 KIS 모의투자 서버를 실제로 거치는
  // 주문이라 지연 감지가 똑같이 의미있는데 통째로 안 보고 있었음(QA 사각지대) → 양쪽 다 검사.
  const { rows } = await pool.query(`
    SELECT stock_code, side, is_paper,
           EXTRACT(EPOCH FROM (updated_at - created_at)) AS latency_sec,
           created_at, updated_at
    FROM orders
    WHERE status = 'FILLED' AND updated_at IS NOT NULL
      AND created_at >= NOW() - INTERVAL '4 hours'
    ORDER BY latency_sec DESC
    LIMIT 5
  `);

  for (const r of rows) {
    const latency = Number(r.latency_sec ?? 0);
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    if (latency > 300) {
      issues.push({
        severity: 'WARNING',
        category: '매매로직',
        title: `[${mode}] 체결 지연 ${Math.round(latency)}초: ${r.stock_code} ${r.side}`,
        detail: `주문: ${r.created_at}, 체결확인: ${r.updated_at}`,
      });
    }
  }

  // 미체결 방치 주문 (10분+)
  const { rows: unfilled } = await pool.query(`
    SELECT stock_code, side, is_paper, created_at,
           EXTRACT(EPOCH FROM (NOW() - created_at)) as age_sec
    FROM orders
    WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL '10 minutes'
  `);

  for (const r of unfilled) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    const ageMin = Math.round(Number(r.age_sec) / 60);
    issues.push({
      severity: ageMin > 30 ? 'CRITICAL' : 'WARNING',
      category: '매매로직',
      title: `[${mode}] 미체결 ${ageMin}분: ${r.stock_code} ${r.side}`,
      detail: `주문시각: ${r.created_at} — 자동취소 또는 수동 확인 필요`,
    });
  }
}

/** 9. v17: 대형 손실 체인 감지 — SL 초과 손실 (갭 하락·SL 미작동 의심) */
async function checkLargeLoss(issues: QAIssue[]): Promise<void> {
  const pool = getPool();

  // 최근 2일 내 단일 체인 손실이 SL의 1.5배 초과 → 갭 하락 슬리피지 또는 SL 미작동
  const { rows } = await pool.query(`
    SELECT stock_code, is_paper, pnl_pct, stop_loss_pct, realized_pnl, closed_at
    FROM transaction_chains
    WHERE status = 'CLOSED'
      AND closed_at >= NOW() - INTERVAL '2 days'
      AND pnl_pct < 0
      AND stop_loss_pct < 0
      AND ABS(pnl_pct) > ABS(stop_loss_pct) * 1.5
    ORDER BY pnl_pct ASC
    LIMIT 5
  `);

  for (const r of rows) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    const pnl = Number(r.pnl_pct).toFixed(1);
    const sl = Number(r.stop_loss_pct).toFixed(1);
    const pnlAmt = Number(r.realized_pnl).toLocaleString();
    issues.push({
      severity: 'WARNING',
      category: '매매로직',
      title: `[${mode}] SL 초과 손실: ${r.stock_code} ${pnl}% (SL ${sl}%)`,
      detail: `${pnlAmt}원 손실 — 갭 하락 슬리피지 또는 SL 미작동 의심`,
    });
  }
}

// ═══════════════════════════════════════════
//  QA 이슈 → 액션 추천
// ═══════════════════════════════════════════

function deriveQAActions(issues: QAIssue[]): QAAction[] {
  const actions: QAAction[] = [];
  for (const issue of issues) {
    if (issue.category === '크로스오염') {
      actions.push({ level: 'danger', action: `${issue.title} — 모드 불일치 즉시 확인`, apiHint: 'GET /api/dashboard 로 상태 확인' });
    } else if (issue.category === '매매로직' && issue.title.includes('연패')) {
      actions.push({ level: 'warn', action: `${issue.title} — 쿨다운 연장 고려`, apiHint: 'POST /api/ai-loop/command {"category":"cooldown_min","value":120}' });
    } else if (issue.category === '매매로직' && issue.title.includes('승률')) {
      actions.push({ level: issue.severity === 'CRITICAL' ? 'danger' : 'warn', action: `${issue.title} — 전략 재검토 필요` });
    } else if (issue.category === '매매로직' && issue.title.includes('즉시 반전')) {
      actions.push({ level: 'danger', action: `${issue.title} — 매매 로직 버그 확인`, apiHint: 'GET /api/qa/reports' });
    } else if (issue.category === '시스템' && issue.title.includes('Kill Switch')) {
      actions.push({ level: 'warn', action: `${issue.title} — 정상화 시 해제 권장`, apiHint: 'POST /api/kill-switch/reset' });
    } else if (issue.category === '시스템' && issue.title.includes('에러')) {
      actions.push({ level: issue.severity === 'CRITICAL' ? 'danger' : 'warn', action: `${issue.title} — 시스템 로그 확인` });
    } else if (issue.category === '정합성') {
      actions.push({ level: issue.severity === 'CRITICAL' ? 'danger' : 'warn', action: `${issue.title} — 데이터 정합성 검증 필요` });
    } else if (issue.category === 'AI비용') {
      actions.push({ level: 'warn', action: `${issue.title} — AI 호출 패턴 점검` });
    }
  }
  return actions;
}

// ═══════════════════════════════════════════
//  HTML 리포트
// ═══════════════════════════════════════════

function buildQAHtml(issues: QAIssue[], elapsed: string): string {
  const today = getKSTNow().toISOString().split('T')[0];
  const time = getKSTNow().toISOString().split('T')[1].slice(0, 5);

  const critical = issues.filter((i) => i.severity === 'CRITICAL');
  const warnings = issues.filter((i) => i.severity === 'WARNING');
  const infos = issues.filter((i) => i.severity === 'INFO');

  const severityColor = { CRITICAL: '#ef4444', WARNING: '#f59e0b', INFO: '#3b82f6' };
  const categoryEmoji = { '정합성': '💰', '크로스오염': '🔀', '매매로직': '📊', 'AI비용': '🤖', '시스템': '⚙️' };

  const renderIssue = (issue: QAIssue) => `
    <div style="background:#1e293b;border-left:3px solid ${severityColor[issue.severity]};border-radius:4px;padding:10px 12px;margin-bottom:8px;">
      <div style="font-size:13px;font-weight:bold;color:${severityColor[issue.severity]};">
        ${issue.severity} ${categoryEmoji[issue.category] ?? '🔍'} [${escapeHtml(issue.category)}] ${escapeHtml(issue.title)}
      </div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px;">${escapeHtml(issue.detail)}</div>
    </div>`;

  return `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:20px;background:#020617;font-family:sans-serif;color:#e2e8f0;">
      <div style="max-width:640px;margin:0 auto;">
        <h1 style="color:#f8fafc;font-size:18px;margin:0 0 4px 0;">🔍 QA Watchdog 감시 리포트</h1>
        <p style="color:#64748b;font-size:12px;margin:0 0 16px 0;">${today} ${time} KST · ${elapsed}s · ${issues.length}건 감지</p>

        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <div style="flex:1;background:#7f1d1d;border-radius:6px;padding:8px;text-align:center;">
            <div style="font-size:24px;font-weight:bold;color:#fca5a5;">${critical.length}</div>
            <div style="font-size:11px;color:#fca5a5;">CRITICAL</div>
          </div>
          <div style="flex:1;background:#78350f;border-radius:6px;padding:8px;text-align:center;">
            <div style="font-size:24px;font-weight:bold;color:#fde68a;">${warnings.length}</div>
            <div style="font-size:11px;color:#fde68a;">WARNING</div>
          </div>
          <div style="flex:1;background:#1e3a5f;border-radius:6px;padding:8px;text-align:center;">
            <div style="font-size:24px;font-weight:bold;color:#93c5fd;">${infos.length}</div>
            <div style="font-size:11px;color:#93c5fd;">INFO</div>
          </div>
        </div>

        ${critical.length > 0 ? `<h2 style="color:#ef4444;font-size:14px;margin:16px 0 8px;">🔴 CRITICAL (${critical.length})</h2>${critical.map(renderIssue).join('')}` : ''}
        ${warnings.length > 0 ? `<h2 style="color:#f59e0b;font-size:14px;margin:16px 0 8px;">🟡 WARNING (${warnings.length})</h2>${warnings.map(renderIssue).join('')}` : ''}
        ${infos.length > 0 ? `<h2 style="color:#3b82f6;font-size:14px;margin:16px 0 8px;">🔵 INFO (${infos.length})</h2>${infos.map(renderIssue).join('')}` : ''}

        <p style="color:#475569;font-size:11px;text-align:center;margin-top:24px;">
          QA Watchdog — AI 자동매매 품질 감시 시스템
        </p>
      </div>
    </body></html>`;
}
