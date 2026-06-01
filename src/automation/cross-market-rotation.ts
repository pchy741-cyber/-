/**
 * 크로스마켓 인텔리전트 로테이션
 * 단일 시장 악화 시 자본을 상대 시장으로 능동적 회전
 *
 * 입력: KOSPI 레짐, VIX 레짐, F&G, FX 추세
 * 출력: 조정된 kr_pct / us_pct + 로테이션 사유
 */
import { detectMarketRegime, type MarketRegime } from './market-regime.js';
import { getVixRegime } from '../scheduler/overseas/risk-intelligence.js';
import { getFearGreedIndex } from '../market/external-signals.js';
import { fetchExchangeRate } from './macro-data.js';
import { getPool } from '../db/client.js';
import { getCtxIsPaper } from '../config/context.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const COMP = 'ROTATION';

export interface RotationSignal {
  adjustedKrPct: number;
  adjustedUsPct: number;
  baseKrPct: number;
  baseUsPct: number;
  rotationReason: string;
  rotationScore: number;   // -10(국내 극부정)~+10(국내 극긍정)
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
  // 1. DB에서 기본 비중 읽기
  const { rows: allocRows } = await getPool().query(
    'SELECT kr_pct, us_pct FROM portfolio_allocation_config LIMIT 1',
  );
  const baseKrPct = Number(allocRows[0]?.kr_pct ?? 70);
  const baseUsPct = Number(allocRows[0]?.us_pct ?? 30);

  // 2. 시장 레짐 수집
  let krRegime: MarketRegime | null = null;
  try { krRegime = await detectMarketRegime(); } catch {}

  let vix = 0;
  let fearGreed = 50;
  try {
    const fg = await getFearGreedIndex();
    if (fg) { fearGreed = fg.fearGreedScore; vix = fg.vix; }
  } catch {}

  const vixRegime = getVixRegime(vix);

  // 3. 환율 추세 (최근 vs 이전 — 시스템에 저장된 값 참조)
  let fxTrend = 0; // 0=중립, +1=원화강세(국내유리), -1=원화약세(해외유리)
  try {
    const rate = await fetchExchangeRate();
    // 1350 기준: 낮으면 원화강세 → 국내 유리
    if (rate < 1300) fxTrend = 1;
    else if (rate > 1400) fxTrend = -1;
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
  if (krRegime && (krRegime.regime === 'PANIC' || krRegime.regime === 'BEARISH')
      && (vixRegime.regime === 'CRISIS' || vixRegime.regime === 'STRESS')) {
    safeHavenEtf = vixRegime.regime === 'CRISIS' ? 'GLD' : 'KODEX200';
    reasons.push(`양쪽악화→${safeHavenEtf}파킹`);
  }

  const shouldRebalance = adjustedKrPct !== baseKrPct;
  const rotationReason = reasons.length > 0 ? reasons.join(' + ') : '중립';

  return {
    adjustedKrPct, adjustedUsPct, baseKrPct, baseUsPct,
    rotationReason, rotationScore, shouldRebalance, safeHavenEtf,
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
      [JSON.stringify({
        adjustedKrPct: signal.adjustedKrPct,
        adjustedUsPct: signal.adjustedUsPct,
        rotationScore: signal.rotationScore,
        safeHavenEtf: signal.safeHavenEtf,
        updatedAt: new Date().toISOString(),
      })],
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
