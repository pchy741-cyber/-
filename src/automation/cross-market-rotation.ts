/**
 * 크로스마켓 인텔리전트 로테이션
 * 단일 시장 악화 시 자본을 상대 시장으로 능동적 회전
 *
 * 입력: KOSPI 레짐, VIX 레짐, F&G, FX 추세
 * 출력: 조정된 kr_pct / us_pct + 로테이션 사유
 */

import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { getFearGreedIndex } from '../market/external-signals.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { getVixRegime } from '../scheduler/overseas/risk-intelligence.js';
import { logger } from '../utils/logger.js';
import { fetchExchangeRate } from './macro-data.js';
import { detectMarketRegime, type MarketRegime } from './market-regime.js';

const COMP = 'ROTATION';

export interface RotationSignal {
  adjustedKrPct: number;
  adjustedUsPct: number;
  baseKrPct: number;
  baseUsPct: number;
  rotationReason: string;
  rotationScore: number; // -10(국내 극부정)~+10(국내 극긍정)
  shouldRebalance: boolean;
  safeHavenEtf: string | null;
  krRegime: string;
  usRegime: string;
}

// ── 최근 로테이션 캐시 (중복 알림 방지) ──
let lastRotationScore = 0;
let lastRotationAt = 0;

/**
 * 크로스마켓 로테이션 신호 계산
 * - KR KOSPI 레짐 + US VIX 레짐 + F&G + FX 추세 종합
 * - rotationScore에 따라 kr_pct/us_pct 동적 조정
 */
export async function calcRotationSignal(): Promise<RotationSignal> {
  // 1. DB에서 기본 비중 읽기 (paper/live 분리)
  const { rows: allocRows } = await getPool().query(
    'SELECT kr_pct, us_pct FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
    [getCtxIsPaper()],
  );
  const baseKrPct = Number(allocRows[0]?.kr_pct ?? 0);
  const baseUsPct = Number(allocRows[0]?.us_pct ?? 100);

  // 2. 시장 레짐 수집
  let krRegime: MarketRegime | null = null;
  try {
    krRegime = await detectMarketRegime();
  } catch {}

  let vix = 0;
  let fearGreed = 50;
  try {
    const fg = await getFearGreedIndex();
    if (fg) {
      fearGreed = fg.fearGreedScore;
      vix = fg.vix;
    }
  } catch {}

  const vixRegime = getVixRegime(vix);

  // 3. 환율 추세 (최근 vs 이전 — 시스템에 저장된 값 참조)
  let fxTrend = 0; // 0=중립, +1=원화강세(국내유리), -1=원화약세(해외유리)
  try {
    const rate = await fetchExchangeRate();
    // 1500 기준: 낮으면 원화강세 → 국내 유리
    if (rate < 1450) fxTrend = 1;
    else if (rate > 1550) fxTrend = -1;
  } catch {}

  // 4. 로테이션 점수 계산
  let rotationScore = 0;
  const reasons: string[] = [];

  // ── KR 레짐 ──
  if (krRegime) {
    switch (krRegime.regime) {
      case 'PANIC':
        rotationScore -= 5;
        reasons.push(`KR PANIC(${krRegime.score}점)`);
        break;
      case 'BEARISH':
        rotationScore -= 3;
        reasons.push(`KR BEARISH(${krRegime.score}점)`);
        break;
      case 'BULLISH':
        rotationScore += 3;
        reasons.push(`KR BULLISH(${krRegime.score}점)`);
        break;
      // NEUTRAL: 0점
    }
  }

  // ── US 레짐 (VIX) ──
  switch (vixRegime.regime) {
    case 'CRISIS':
      rotationScore += 5;
      reasons.push(`US CRISIS(VIX=${vix.toFixed(0)})`);
      break;
    case 'STRESS':
      rotationScore += 2;
      reasons.push(`US STRESS(VIX=${vix.toFixed(0)})`);
      break;
    // CALM: 0점
  }

  // ── F&G ──
  if (fearGreed <= 20) {
    // 극단적 공포 → 역발상 매수 기회이나, 둘 다 위험하면 현금 선호
    rotationScore -= 1;
    reasons.push(`F&G극공포(${fearGreed})`);
  } else if (fearGreed >= 80) {
    // 극단적 탐욕 → 해외(특히 US) 신규 억제
    rotationScore += 1;
    reasons.push(`F&G극탐욕(${fearGreed})`);
  }

  // ── FX 추세 ──
  if (fxTrend !== 0) {
    rotationScore += fxTrend;
    reasons.push(fxTrend > 0 ? '원화강세→국내유리' : '원화약세→해외유리');
  }

  // 5. 비중 조정 맵핑
  let adjustedKrPct = baseKrPct;
  let adjustedUsPct = baseUsPct;
  let safeHavenEtf: string | null = null;

  if (rotationScore <= -5) {
    // KR 극부정 → 해외 집중 (US 비중 최대 +20%)
    adjustedKrPct = Math.max(15, baseKrPct - 20);
    adjustedUsPct = 100 - adjustedKrPct;
  } else if (rotationScore <= -3) {
    adjustedKrPct = Math.max(20, baseKrPct - 10);
    adjustedUsPct = 100 - adjustedKrPct;
  } else if (rotationScore >= 5) {
    // US 극부정 → 국내 집중
    adjustedKrPct = Math.min(85, baseKrPct + 20);
    adjustedUsPct = 100 - adjustedKrPct;
  } else if (rotationScore >= 3) {
    adjustedKrPct = Math.min(80, baseKrPct + 10);
    adjustedUsPct = 100 - adjustedKrPct;
  }

  // 양쪽 다 나쁨: KR PANIC/BEARISH + US CRISIS/STRESS → 세이프헤이븐
  if (
    krRegime &&
    (krRegime.regime === 'PANIC' || krRegime.regime === 'BEARISH') &&
    (vixRegime.regime === 'CRISIS' || vixRegime.regime === 'STRESS')
  ) {
    safeHavenEtf = vixRegime.regime === 'CRISIS' ? 'GLD' : 'KODEX200';
    reasons.push(`양쪽악화→${safeHavenEtf}파킹`);
  }

  const shouldRebalance = adjustedKrPct !== baseKrPct;
  const rotationReason = reasons.length > 0 ? reasons.join(' + ') : '중립';

  return {
    adjustedKrPct,
    adjustedUsPct,
    baseKrPct,
    baseUsPct,
    rotationReason,
    rotationScore,
    shouldRebalance,
    safeHavenEtf,
    krRegime: krRegime?.regime ?? 'UNKNOWN',
    usRegime: vixRegime.regime,
  };
}

/**
 * 로테이션 체크 실행 (스케줄러 호출)
 * - 변동 시 Telegram 알림 + DB 이력 저장
 */
export async function runRotationCheck(): Promise<void> {
  try {
    const signal = await calcRotationSignal();
    const now = Date.now();

    logger.info(
      `📊 로테이션: KR=${signal.krRegime} US=${signal.usRegime} score=${signal.rotationScore} → KR${signal.adjustedKrPct}%/US${signal.adjustedUsPct}% (${signal.rotationReason})`,
      { component: COMP },
    );

    // DB에 마지막 로테이션 신호 저장 (overseas-job에서 읽기용)
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES (${getCtxIsPaper() ? "'p_rotation_signal'" : "'l_rotation_signal'"}, $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [
        JSON.stringify({
          adjustedKrPct: signal.adjustedKrPct,
          adjustedUsPct: signal.adjustedUsPct,
          rotationScore: signal.rotationScore,
          safeHavenEtf: signal.safeHavenEtf,
          updatedAt: new Date().toISOString(),
        }),
      ],
    );

    // 점수 변화가 의미 있을 때만 알림 (±2 이상 변동, 1시간 쿨다운)
    const scoreChanged = Math.abs(signal.rotationScore - lastRotationScore) >= 2;
    const cooldownOk = now - lastRotationAt >= 60 * 60 * 1000;
    if (signal.shouldRebalance && scoreChanged && cooldownOk) {
      lastRotationScore = signal.rotationScore;
      lastRotationAt = now;
      const emoji = signal.rotationScore < 0 ? '🔴' : signal.rotationScore > 0 ? '🟢' : '⚪';
      await sendTelegramMessage(
        `${emoji} *크로스마켓 로테이션*\n` +
          `KR: ${signal.krRegime} | US: ${signal.usRegime}\n` +
          `비중 조정: KR ${signal.baseKrPct}%→${signal.adjustedKrPct}% / US ${signal.baseUsPct}%→${signal.adjustedUsPct}%\n` +
          `사유: ${signal.rotationReason}` +
          (signal.safeHavenEtf ? `\n파킹: ${signal.safeHavenEtf}` : ''),
      );
    }
  } catch (e) {
    logger.error(`로테이션 체크 실패: ${e}`, { component: COMP });
  }
}

// ══════════════════════════════════════════════════════════════════
//  성과 기반 비중 자동조정 제안 (주 1회 실행, 사용자 승인 필요)
// ══════════════════════════════════════════════════════════════════

interface MarketPerformance {
  market: 'KR' | 'US';
  winRate: number;
  avgProfitPct: number;
  avgLossPct: number;
  tradeCount: number;
  totalPnlPct: number;
  profitFactor: number; // 총수익/총손실
}

/**
 * 30일 성과 분석 → 최적 배분 비율 제안 → pending_decisions에 저장 + 알림
 * 사용자가 승인하면 portfolio_allocation_config 업데이트
 */
export async function proposeAllocationRebalance(): Promise<void> {
  const pool = getPool();
  const isPaper = getCtxIsPaper();

  try {
    // 1. 최근 30일 국내/해외 성과 분석
    const { rows: krRows } = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE side = 'SELL' AND filled_price > avg_buy_price) AS win_count,
        COUNT(*) FILTER (WHERE side = 'SELL' AND filled_price <= avg_buy_price) AS loss_count,
        COUNT(*) FILTER (WHERE side = 'SELL') AS total_sells,
        COALESCE(AVG(CASE WHEN side='SELL' AND filled_price > avg_buy_price
          THEN ((filled_price - avg_buy_price) / NULLIF(avg_buy_price, 0)) * 100 END), 0) AS avg_profit_pct,
        COALESCE(AVG(CASE WHEN side='SELL' AND filled_price <= avg_buy_price
          THEN ((filled_price - avg_buy_price) / NULLIF(avg_buy_price, 0)) * 100 END), 0) AS avg_loss_pct,
        COALESCE(SUM(CASE WHEN side='SELL' AND filled_price > avg_buy_price
          THEN (filled_price - avg_buy_price) * filled_quantity END), 0) AS total_profit,
        COALESCE(SUM(CASE WHEN side='SELL' AND filled_price <= avg_buy_price
          THEN ABS(filled_price - avg_buy_price) * filled_quantity END), 0) AS total_loss
      FROM orders
      WHERE trading_mode = $1 AND created_at >= NOW() - INTERVAL '30 days'
        AND stock_code ~ '^[0-9]{6}$'
        AND status IN ('FILLED', 'PARTIAL')
    `,
      [isPaper ? 'paper' : 'live'],
    );

    const { rows: usRows } = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE side = 'SELL' AND filled_price > avg_buy_price) AS win_count,
        COUNT(*) FILTER (WHERE side = 'SELL' AND filled_price <= avg_buy_price) AS loss_count,
        COUNT(*) FILTER (WHERE side = 'SELL') AS total_sells,
        COALESCE(AVG(CASE WHEN side='SELL' AND filled_price > avg_buy_price
          THEN ((filled_price - avg_buy_price) / NULLIF(avg_buy_price, 0)) * 100 END), 0) AS avg_profit_pct,
        COALESCE(AVG(CASE WHEN side='SELL' AND filled_price <= avg_buy_price
          THEN ((filled_price - avg_buy_price) / NULLIF(avg_buy_price, 0)) * 100 END), 0) AS avg_loss_pct,
        COALESCE(SUM(CASE WHEN side='SELL' AND filled_price > avg_buy_price
          THEN (filled_price - avg_buy_price) * filled_quantity END), 0) AS total_profit,
        COALESCE(SUM(CASE WHEN side='SELL' AND filled_price <= avg_buy_price
          THEN ABS(filled_price - avg_buy_price) * filled_quantity END), 0) AS total_loss
      FROM orders
      WHERE trading_mode = $1 AND created_at >= NOW() - INTERVAL '30 days'
        AND stock_code !~ '^[0-9]{6}$'
        AND status IN ('FILLED', 'PARTIAL')
    `,
      [isPaper ? 'paper' : 'live'],
    );

    const parsePerf = (rows: any[], market: 'KR' | 'US'): MarketPerformance => {
      const r = rows[0] ?? {};
      const winCount = Number(r.win_count ?? 0);
      const _lossCount = Number(r.loss_count ?? 0);
      const totalSells = Number(r.total_sells ?? 0);
      const totalProfit = Number(r.total_profit ?? 0);
      const totalLoss = Number(r.total_loss ?? 0);
      return {
        market,
        winRate: totalSells > 0 ? winCount / totalSells : 0,
        avgProfitPct: Number(r.avg_profit_pct ?? 0),
        avgLossPct: Number(r.avg_loss_pct ?? 0),
        tradeCount: totalSells,
        totalPnlPct: 0, // simplified
        profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 99 : 0,
      };
    };

    const krPerf = parsePerf(krRows, 'KR');
    const usPerf = parsePerf(usRows, 'US');

    // 2. 최소 거래 수 체크 (양쪽 합산 5건 미만이면 제안 보류)
    if (krPerf.tradeCount + usPerf.tradeCount < 5) {
      logger.info(`📊 비중 제안 보류: 거래 수 부족 (KR=${krPerf.tradeCount} US=${usPerf.tradeCount})`, {
        component: COMP,
      });
      return;
    }

    // 3. 현재 배분 읽기
    const { rows: allocRows } = await pool.query(
      'SELECT kr_pct, us_pct FROM portfolio_allocation_config WHERE is_paper = $1 LIMIT 1',
      [isPaper],
    );
    const currentKrPct = Number(allocRows[0]?.kr_pct ?? 0);
    const currentUsPct = Number(allocRows[0]?.us_pct ?? 100);

    // 한쪽 0% = 사용자가 명시적으로 100% 단일시장 설정 → 로테이션 스킵
    if (currentKrPct === 0 || currentUsPct === 0) {
      logger.info(`📊 비중 제안 보류: 단일시장 모드 (KR=${currentKrPct}% / US=${currentUsPct}%) → 로테이션 스킵`, {
        component: COMP,
      });
      return;
    }

    // 4. 성과 점수 계산 — profit factor × sqrt(거래수) (샘플 보정)
    const krScore = krPerf.profitFactor * Math.sqrt(Math.min(krPerf.tradeCount, 30));
    const usScore = usPerf.profitFactor * Math.sqrt(Math.min(usPerf.tradeCount, 30));
    const totalScore = krScore + usScore;

    // 5. 최적 비율 산출 (점수 비례, 20~80% 범위 제한)
    let targetKrPct: number;
    if (totalScore <= 0) {
      targetKrPct = 50;
    } else {
      targetKrPct = Math.round(Math.max(20, Math.min(80, (krScore / totalScore) * 100)));
    }

    // 6. 점진적 이동 — 한 번에 최대 ±5%p만 이동 (스무스 수렴)
    const MAX_STEP = 5;
    const diff = targetKrPct - currentKrPct;
    if (Math.abs(diff) < 2) {
      logger.info(`📊 비중 제안 보류: 현재(KR${currentKrPct}/US${currentUsPct})와 목표(KR${targetKrPct}) 차이 미미`, {
        component: COMP,
      });
      return;
    }
    const step = Math.sign(diff) * Math.min(MAX_STEP, Math.abs(diff));
    const proposedKrPct = currentKrPct + step;
    const proposedUsPct = 100 - proposedKrPct;

    const context = {
      krPerf,
      usPerf,
      krScore: Math.round(krScore * 10) / 10,
      usScore: Math.round(usScore * 10) / 10,
      current: { kr_pct: currentKrPct, us_pct: currentUsPct },
      proposed: { kr_pct: proposedKrPct, us_pct: proposedUsPct },
      target: { kr_pct: targetKrPct, us_pct: 100 - targetKrPct },
    };

    const krWrStr = krPerf.tradeCount > 0 ? `${(krPerf.winRate * 100).toFixed(0)}%` : '-';
    const usWrStr = usPerf.tradeCount > 0 ? `${(usPerf.winRate * 100).toFixed(0)}%` : '-';

    // 7. 소폭 변경(≤5%p) + 강한 시그널 → 자동 적용 (승인 불필요)
    const isSmallStep = Math.abs(step) <= MAX_STEP;
    const strongSignal = totalScore > 0 && Math.max(krScore, usScore) / totalScore >= 0.6; // 60%+ 우위
    const autoApply = isSmallStep && strongSignal;

    if (autoApply) {
      // 자동 적용: portfolio_allocation_config 직접 업데이트
      const { rows: existing } = await pool.query(
        'SELECT id FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
        [isPaper],
      );
      if (existing.length > 0) {
        await pool.query('UPDATE portfolio_allocation_config SET kr_pct=$1, us_pct=$2, updated_at=NOW() WHERE id=$3', [
          proposedKrPct,
          proposedUsPct,
          existing[0].id,
        ]);
      }

      logger.info(
        `📊 비중 자동조정: KR ${currentKrPct}→${proposedKrPct}% / US ${currentUsPct}→${proposedUsPct}% ` +
          `(목표 KR${targetKrPct}% | KR승률${krWrStr} PF=${krPerf.profitFactor.toFixed(2)} / US승률${usWrStr} PF=${usPerf.profitFactor.toFixed(2)})`,
        { component: COMP },
      );

      await sendTelegramMessage(
        `📊 *비중 자동조정 완료* (${Math.abs(step)}%p 이동)\n\n` +
          `KR ${currentKrPct}%→*${proposedKrPct}%* / US ${currentUsPct}%→*${proposedUsPct}%*\n` +
          `목표: KR ${targetKrPct}% / US ${100 - targetKrPct}%\n` +
          `국내 PF=${krPerf.profitFactor.toFixed(2)} / 해외 PF=${usPerf.profitFactor.toFixed(2)}`,
      ).catch(() => {});
    } else {
      // 큰 변경 또는 약한 시그널 → 제안 저장 + 승인 대기
      await pool.query(
        `INSERT INTO pending_decisions (situation, category, context, urgency, is_paper, expires_at)
         VALUES ($1, 'rebalance', $2, 3, $3, NOW() + INTERVAL '7 days')`,
        [
          `비중 조정 제안: KR ${currentKrPct}%→${proposedKrPct}% / US ${currentUsPct}%→${proposedUsPct}%`,
          JSON.stringify(context),
          isPaper,
        ],
      );

      const msg =
        `📊 *비중 조정 제안* (30일 성과 기반)\n\n` +
        `*국내* 승률 ${krWrStr} (${krPerf.tradeCount}건) PF=${krPerf.profitFactor.toFixed(2)}\n` +
        `*해외* 승률 ${usWrStr} (${usPerf.tradeCount}건) PF=${usPerf.profitFactor.toFixed(2)}\n\n` +
        `현재: KR ${currentKrPct}% / US ${currentUsPct}%\n` +
        `제안: *KR ${proposedKrPct}%* / *US ${proposedUsPct}%*\n` +
        `목표: KR ${targetKrPct}% / US ${100 - targetKrPct}%\n\n` +
        `대시보드 Settings에서 승인/거부해 주세요.`;

      await sendTelegramMessage(msg).catch(() => {});

      const { sendPushNotification } = await import('../notifications/web-push.js');
      await sendPushNotification({
        title: `📊 비중 조정 제안 KR${proposedKrPct}/US${proposedUsPct}`,
        body: `국내 승률${krWrStr} PF${krPerf.profitFactor.toFixed(1)} / 해외 승률${usWrStr} PF${usPerf.profitFactor.toFixed(1)}`,
        tag: 'rebalance-proposal',
        url: '/?tab=settings',
      }).catch(() => {});

      logger.info(
        `📊 비중 조정 제안: KR ${currentKrPct}→${proposedKrPct}% / US ${currentUsPct}→${proposedUsPct}% ` +
          `(목표 KR${targetKrPct}% | KR승률${krWrStr} PF=${krPerf.profitFactor.toFixed(2)} / US승률${usWrStr} PF=${usPerf.profitFactor.toFixed(2)})`,
        { component: COMP },
      );
    }
  } catch (e) {
    logger.error(`비중 제안 분석 실패: ${e}`, { component: COMP });
  }
}

/**
 * pending_decisions의 rebalance 제안을 승인하여 적용
 */
export async function approveAllocationProposal(decisionId: number): Promise<{ ok: boolean; message: string }> {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM pending_decisions WHERE id = $1 AND category = 'rebalance' AND status = 'PENDING'`,
      [decisionId],
    );
    if (rows.length === 0) return { ok: false, message: '유효한 제안이 없습니다' };

    const ctx = rows[0].context;
    const proposed = ctx.proposed;
    if (!proposed?.kr_pct || !proposed?.us_pct) return { ok: false, message: '제안 데이터 오류' };

    // portfolio_allocation_config 업데이트
    const { rows: existing } = await pool.query(
      'SELECT id FROM portfolio_allocation_config WHERE is_paper = $1 ORDER BY id DESC LIMIT 1',
      [rows[0].is_paper],
    );
    if (existing.length > 0) {
      await pool.query('UPDATE portfolio_allocation_config SET kr_pct=$1, us_pct=$2, updated_at=NOW() WHERE id=$3', [
        proposed.kr_pct,
        proposed.us_pct,
        existing[0].id,
      ]);
    }

    // 제안 상태 업데이트
    await pool.query(`UPDATE pending_decisions SET status='DECIDED', decision=$1, decided_at=NOW() WHERE id=$2`, [
      JSON.stringify({ action: 'APPROVED', appliedAt: new Date().toISOString() }),
      decisionId,
    ]);

    await sendTelegramMessage(
      `✅ *비중 조정 승인 완료*\nKR ${proposed.kr_pct}% / US ${proposed.us_pct}%\n즉시 적용됨`,
    ).catch(() => {});

    logger.info(`✅ 비중 조정 승인: KR ${proposed.kr_pct}% / US ${proposed.us_pct}%`, { component: COMP });
    return { ok: true, message: `KR ${proposed.kr_pct}% / US ${proposed.us_pct}% 적용 완료` };
  } catch (e) {
    return { ok: false, message: `승인 실패: ${e}` };
  }
}
