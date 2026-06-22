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

export interface QAReport {
  runAt: string;
  elapsedSec: number;
  issues: QAIssue[];
  critical: number;
  warning: number;
  info: number;
  status: 'pass' | 'warn' | 'fail';
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
      critical: r.critical,
      warning: r.warning,
      info: r.info,
      status: r.status,
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
    // 병렬 전수조사
    const results = await Promise.allSettled([
      checkBalanceIntegrity(issues),
      checkCrossContamination(issues),
      checkTradingLogic(issues),
      checkAICostAnomaly(issues),
      checkSystemHealth(issues),
      checkOrderChainConsistency(issues),
    ]);

    // 실패한 검사 자체도 이슈로 기록
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const names = ['잔고정합', '크로스오염', '매매로직', 'AI비용', '시스템헬스', '주문체인'];
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
    const report: QAReport = {
      runAt: getKSTNow().toISOString(),
      elapsedSec,
      issues,
      critical: critical.length,
      warning: warnings.length,
      info: infos.length,
      status: critical.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
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

    // 텔레그램 (간결)
    const teleMsg = [
      `🔍 *QA Watchdog 감시 결과*`,
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
  // 오늘 첫 스냅샷과 현재 잔고 비교
  const today = getKSTNow().toISOString().split('T')[0];

  const { rows: snapshots } = await safeQuery<Record<string, unknown>>(
    `SELECT total_value, cash_balance, invested_value, is_paper
     FROM portfolio_snapshots
     WHERE snapshot_at >= $1
     ORDER BY snapshot_at DESC LIMIT 2`,
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
      const liveTotal = balance.orderableCash + balance.totalEvalAmount;

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
  // 최근 1시간 에러 건수
  const { rows: errorRows } = await safeQuery<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM system_log
     WHERE level = 'error' AND timestamp >= NOW() - INTERVAL '1 hour'`,
    [],
  );
  const recentErrors = Number(errorRows[0]?.cnt ?? 0);

  if (recentErrors >= 10) {
    issues.push({
      severity: 'CRITICAL',
      category: '시스템',
      title: `1시간 에러 ${recentErrors}건 — 시스템 불안정`,
      detail: `최근 1시간 에러 급증. 로그 확인 필요.`,
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

  // 체인의 total_invested와 실제 BUY 주문 합산 비교 (10% 이상 차이)
  const { rows: investMismatch } = await pool.query(`
    SELECT tc.stock_code, tc.is_paper, tc.total_invested,
           COALESCE(SUM(o.filled_price * o.filled_quantity), 0) as order_invested
    FROM transaction_chains tc
    JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED' AND o.side = 'BUY'
    WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      AND tc.total_invested > 0
    GROUP BY tc.id, tc.stock_code, tc.is_paper, tc.total_invested
    HAVING ABS(tc.total_invested - COALESCE(SUM(o.filled_price * o.filled_quantity), 0))
           > tc.total_invested * 0.1
  `);

  for (const r of investMismatch) {
    const mode = r.is_paper ? 'PAPER' : 'LIVE';
    issues.push({
      severity: 'WARNING',
      category: '정합성',
      title: `[${mode}] 투자금 불일치: ${r.stock_code}`,
      detail: `체인: ${Number(r.total_invested).toLocaleString()}원 vs 주문합산: ${Number(r.order_invested).toLocaleString()}원`,
    });
  }
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
