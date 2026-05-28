/**
 * /review/xray — 경량 크로스오염 전용 진단 (DB 쿼리만, 외부 API 호출 없음)
 *
 * 원칙: AI 인사이트(점수·판정)는 공통, 나머지(현금·주문·포지션·스냅샷)는 paper/live 완전 분리
 * 이 엔드포인트는 그 분리 경계가 유지되는지만 빠르게 검증한다.
 */
import { Hono } from 'hono';

const app = new Hono();

type CheckStatus = 'ok' | 'warn' | 'danger';
interface Check {
  id: string;
  status: CheckStatus;
  label: string;
  detail: string;
}

app.get('/review/xray', async (c) => {
  const checks: Check[] = [];

  try {
    const { getPool } = await import('../../../db/client.js');
    const { baseIsPaper } = await import('../../../config/index.js');
    const pool = getPool();

    // ── 1. 체인/주문 모드 경계 ──────────────────────────────────
    // OPEN 체인의 is_paper와 연결된 주문의 trading_mode가 불일치하면 크로스오염
    try {
      const { rows } = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM transaction_chains tc
        JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED'
        WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
          AND ((tc.is_paper = true  AND o.trading_mode = 'live')
            OR (tc.is_paper = false AND o.trading_mode = 'paper'))
      `);
      const cnt = Number(rows[0]?.cnt ?? 0);
      if (cnt > 0) {
        const { rows: detail } = await pool.query(`
          SELECT tc.stock_code, tc.is_paper AS chain_paper, o.trading_mode
          FROM transaction_chains tc
          JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED'
          WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
            AND ((tc.is_paper = true  AND o.trading_mode = 'live')
              OR (tc.is_paper = false AND o.trading_mode = 'paper'))
          LIMIT 3
        `);
        checks.push({ id: 'chain_mode_boundary', status: 'danger', label: '체인↔주문 모드 불일치', detail: detail.map((r: any) => `${r.stock_code}: chain=${r.chain_paper ? 'PAPER' : 'LIVE'} order=${r.trading_mode}`).join(', ') });
      } else {
        checks.push({ id: 'chain_mode_boundary', status: 'ok', label: '체인↔주문 모드 경계', detail: '정상 — 모든 체인의 주문 모드 일치' });
      }
    } catch (e: any) {
      checks.push({ id: 'chain_mode_boundary', status: 'warn', label: '체인↔주문 모드 경계', detail: `조회 실패: ${e.message?.slice(0, 60)}` });
    }

    // ── 2. 매수 게이트 상태 — pipeline.ts와 동일한 로직으로 진단 ──────────────
    try {
      // pipeline.ts와 동일: getWinRateFeedback (portfolio-guard.ts) 직접 호출
      const { getWinRateFeedback } = await import('../../../automation/portfolio-guard.js');
      const { rows: stratRows } = await pool.query(`SELECT buy_threshold FROM strategy_config WHERE is_active = true ORDER BY updated_at DESC LIMIT 1`);
      const baseThreshold: number = Number(stratRows[0]?.buy_threshold ?? 83);

      const winFeedback = await getWinRateFeedback(baseIsPaper);
      const effectiveThreshold = baseThreshold + winFeedback.thresholdBonus;

      // 오늘 또는 최근 7일 최고 점수
      const { rows: scoreRows } = await pool.query(`
        SELECT MAX(composite_score) AS max_score, COUNT(*) AS cnt
        FROM ai_scores
        WHERE score_date >= CURRENT_DATE - 7 AND composite_score > 0
      `);
      const maxScore = Number(scoreRows[0]?.max_score ?? 0);
      const scoreCnt = Number(scoreRows[0]?.cnt ?? 0);

      const canBuy = maxScore >= effectiveThreshold;
      const adjStr = winFeedback.thresholdBonus !== 0 ? `${winFeedback.thresholdBonus > 0 ? '+' : ''}${winFeedback.thresholdBonus}` : '±0';
      const detail = `기준 ${baseThreshold}pt + 승률보정 ${adjStr} = 실효 ${effectiveThreshold}pt | 최고점수 ${maxScore}pt (${scoreCnt}종목) | ${winFeedback.summary}`;

      if (!canBuy && winFeedback.thresholdBonus > 0) {
        checks.push({ id: 'buy_gate', status: 'danger', label: '매수 게이트 차단됨', detail });
      } else if (!canBuy) {
        checks.push({ id: 'buy_gate', status: 'warn', label: '매수 가능 종목 없음', detail });
      } else {
        checks.push({ id: 'buy_gate', status: 'ok', label: '매수 게이트 정상', detail });
      }

      // 추가 진입 조건 (requirePullback, minVolumeRatio)도 표시
      if (winFeedback.requirePullback || winFeedback.minVolumeRatio > 1.0) {
        const extras: string[] = [];
        if (winFeedback.requirePullback) extras.push('눌림신호 필수');
        if (winFeedback.minVolumeRatio > 1.0) extras.push(`거래량 ${winFeedback.minVolumeRatio}x+ 필수`);
        checks.push({ id: 'buy_gate_extra', status: 'warn', label: '추가 진입 조건 활성', detail: extras.join(' | ') });
      }
    } catch (e: any) {
      checks.push({ id: 'buy_gate', status: 'warn', label: '매수 게이트 확인 실패', detail: e.message?.slice(0, 60) ?? '' });
    }

    // ── 3. 해외 현금 Paper/Live 분리 ─────────────────────────────
    try {
      const { rows } = await pool.query(`SELECT key, value FROM overseas_state WHERE key IN ('cash', 'cash_paper')`);
      const map = new Map(rows.map((r: any) => [r.key, Number(r.value)]));
      const hasLive = map.has('cash');
      const hasPaper = map.has('cash_paper');
      const liveCash = map.get('cash') ?? 0;
      const paperCash = map.get('cash_paper') ?? 0;

      if (!hasLive && !hasPaper) {
        checks.push({ id: 'overseas_cash_sep', status: 'warn', label: '해외 현금 키 없음', detail: 'overseas_state에 cash/cash_paper 키 없음' });
      } else if (liveCash > 0 && paperCash > 0 && Math.abs(liveCash - paperCash) < 1) {
        checks.push({ id: 'overseas_cash_sep', status: 'danger', label: '해외 현금 오염 의심', detail: `cash=${liveCash.toFixed(0)} vs cash_paper=${paperCash.toFixed(0)} — 동일값, 공유 가능성` });
      } else {
        checks.push({ id: 'overseas_cash_sep', status: 'ok', label: '해외 현금 분리', detail: `Live $${liveCash.toFixed(0)} / Paper $${paperCash.toFixed(0)}` });
      }
    } catch {
      checks.push({ id: 'overseas_cash_sep', status: 'warn', label: '해외 현금 분리', detail: '조회 실패' });
    }

    // ── 4. 포트폴리오 스냅샷 분리 확인 ──────────────────────────────
    try {
      const { rows } = await pool.query(`
        SELECT is_paper, COUNT(*) AS cnt
        FROM portfolio_snapshots
        WHERE snapshot_at >= CURRENT_DATE - 7
        GROUP BY is_paper
      `);
      const liveSnap = rows.find((r: any) => !r.is_paper);
      const paperSnap = rows.find((r: any) => r.is_paper);
      if (liveSnap && paperSnap) {
        checks.push({ id: 'snapshot_sep', status: 'ok', label: '스냅샷 모드 분리', detail: `Live ${Number(liveSnap.cnt)}건 / Paper ${Number(paperSnap.cnt)}건 (7일내)` });
      } else if (!liveSnap && !paperSnap) {
        checks.push({ id: 'snapshot_sep', status: 'warn', label: '스냅샷 없음 (7일)', detail: 'portfolio_snapshots 7일 내 데이터 없음' });
      } else {
        const missing = !liveSnap ? 'Live' : 'Paper';
        checks.push({ id: 'snapshot_sep', status: 'warn', label: `스냅샷 ${missing} 누락`, detail: `${missing} 스냅샷 7일내 없음 — 저장 중단 가능성` });
      }
    } catch {
      checks.push({ id: 'snapshot_sep', status: 'warn', label: '스냅샷 분리', detail: '조회 실패' });
    }

    // ── 5. score_accuracy 모드 태깅 확인 ─────────────────────────
    try {
      const { rows } = await pool.query(`
        SELECT is_paper, COUNT(*) AS cnt
        FROM score_accuracy
        WHERE recorded_at >= NOW() - INTERVAL '30 days'
        GROUP BY is_paper
      `);
      const liveAcc = rows.find((r: any) => !r.is_paper);
      const paperAcc = rows.find((r: any) => r.is_paper);
      const liveCnt = Number(liveAcc?.cnt ?? 0);
      const paperCnt = Number(paperAcc?.cnt ?? 0);
      if (liveCnt > 0 && paperCnt === 0 && baseIsPaper) {
        checks.push({ id: 'score_accuracy_mode', status: 'danger', label: '승률 데이터 모드 불일치', detail: `현재 Paper 모드이나 score_accuracy는 Live만 ${liveCnt}건 — 승률 피드백이 Live 기준으로 오염` });
      } else if (liveCnt > 0 || paperCnt > 0) {
        checks.push({ id: 'score_accuracy_mode', status: 'ok', label: '승률 데이터 모드 태깅', detail: `Live ${liveCnt}건 / Paper ${paperCnt}건 (30일)` });
      } else {
        checks.push({ id: 'score_accuracy_mode', status: 'warn', label: '승률 데이터 없음', detail: '30일 내 score_accuracy 레코드 없음' });
      }
    } catch {
      checks.push({ id: 'score_accuracy_mode', status: 'warn', label: '승률 데이터 확인', detail: '조회 실패' });
    }

    // ── 6. 중복 OPEN 체인 (같은 종목 paper/live 경계 무관) ──────────────
    try {
      const { rows } = await pool.query(`
        SELECT stock_code, is_paper, COUNT(*) AS cnt
        FROM transaction_chains
        WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
        GROUP BY stock_code, is_paper
        HAVING COUNT(*) > 1
      `);
      if (rows.length > 0) {
        const detail = rows.slice(0, 4).map((r: any) => `${r.stock_code}(${r.is_paper ? 'paper' : 'live'}) ${r.cnt}개`).join(', ');
        checks.push({ id: 'duplicate_chains', status: 'danger', label: '중복 OPEN 체인', detail });
      } else {
        checks.push({ id: 'duplicate_chains', status: 'ok', label: '중복 체인 없음', detail: '모든 종목 단일 OPEN 체인' });
      }
    } catch {
      checks.push({ id: 'duplicate_chains', status: 'warn', label: '중복 체인 확인', detail: '조회 실패' });
    }

    const danger = checks.filter(c => c.status === 'danger').length;
    const warn = checks.filter(c => c.status === 'warn').length;
    const ok = checks.filter(c => c.status === 'ok').length;

    return c.json({
      ts: new Date().toISOString(),
      mode: baseIsPaper ? 'paper' : 'live',
      summary: { danger, warn, ok, total: checks.length },
      checks,
    });

  } catch (err: any) {
    return c.json({ error: err.message, checks }, 500);
  }
});

export default app;
