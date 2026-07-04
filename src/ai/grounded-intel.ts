/**
 * 실시간 시장 인텔리전스 — Vertex AI + Google Search 그라운딩
 * GenAI App Builder 크레딧 ₩143만 활용 → 실시간 뉴스/이벤트 기반 매매 판단 강화
 *
 * 용도:
 * 1. 보유종목 악재/호재 실시간 감지 → 매도/홀드 판단 보강
 * 2. 매수 후보 뉴스 체크 → 어닝스 미스, 소송, FDA 리젝트 등 위험 회피
 * 3. 매크로 이벤트 감지 → Fed 발표, CPI, 고용지표 등 시장 방향성
 */

import { logger } from '../utils/logger.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';

// 쿨다운: 같은 종목 30분 내 중복 조회 방지 (크레딧 절약)
const _lastCheck = new Map<string, number>();
const COOLDOWN_MS = 3 * 3600_000; // v26: 3시간 쿨다운 (1시간→3시간, 비용 66% 절감)

// ── 일일 그라운딩 호출 카운터 (무료 쿼터 안전장치) ──
let _groundedCallCount = 0;
let _groundedCountDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const GROUNDED_DAILY_LIMIT = 1200; // 무료 1500의 80%

function checkGroundedQuota(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _groundedCountDate) {
    _groundedCallCount = 0;
    _groundedCountDate = today;
  }
  if (_groundedCallCount >= GROUNDED_DAILY_LIMIT) return false;
  _groundedCallCount++;
  return true;
}

export interface GroundedSignal {
  code: string;
  action: 'URGENT_SELL' | 'SELL_WARNING' | 'POSITIVE' | 'NEUTRAL';
  headline: string;
  reasoning: string;
  confidence: number; // 0~1
}

/**
 * 보유종목 실시간 뉴스 체크 — 악재 감지 시 매도 신호 강화
 * overseas-job 매도 판단 전에 호출
 */
export async function checkHoldingsNews(
  holdings: Array<{ code: string; name: string; pnlPct: number }>,
): Promise<GroundedSignal[]> {
  // Gemini OFF 시 빈 배열 → overseas-job은 규칙기반만 사용
  const { config } = await import('../config/index.js');
  if (!config.geminiEnabled) return [];
  // v15 AI Cost Optimizer: 위험 포지션만 뉴스 체크 (비용 절감)
  // 손실 -1% 미만 또는 수익 8%+ (TP 근접) → 뉴스 영향 큰 구간만 체크
  // 중간 구간(0~8% 수익)은 기술적 지표로 충분 → AI 호출 생략
  const atRisk = holdings.filter((h) => h.pnlPct < -1 || h.pnlPct >= 8);
  if (atRisk.length === 0) return [];
  const sorted = [...atRisk].sort((a, b) => a.pnlPct - b.pnlPct);
  const targets = sorted.slice(0, 5);

  // 쿨다운 필터
  const now = Date.now();
  const toCheck = targets.filter((t) => {
    const last = _lastCheck.get(t.code) ?? 0;
    return now - last > COOLDOWN_MS;
  });
  if (toCheck.length === 0) return [];

  const codeList = toCheck.map((t) => `${t.code}(${t.name})`).join(', ');

  // 일일 쿼터 체크 (grounded 호출만 카운트)
  let useGrounded = true;
  if (!checkGroundedQuota()) {
    useGrounded = false;
    logger.warn(`⚠️ 그라운딩 일일 한도 도달 (${GROUNDED_DAILY_LIMIT}회) → grounded=false 폴백`, { component: 'GROUNDED_INTEL' });
    try {
      const { sendTelegramMessage } = await import('../notifications/telegram.js');
      sendTelegramMessage(`⚠️ 그라운딩 일일 쿼터 ${GROUNDED_DAILY_LIMIT}회 도달 — grounded=false 폴백 중`).catch(() => {});
    } catch {}
  }

  try {
    const result = await callVertexGemini(
      `You are a financial news analyst for US stock trading.
Analyze ONLY breaking news, earnings reports, FDA decisions, lawsuits, analyst downgrades, or other material events from the LAST 24 HOURS.
Do NOT analyze price movements or technical indicators.
Respond in JSON array format only.`,
      `Current time: ${new Date().toISOString()}.
Check for any material news in the last 24 hours for these stocks: ${codeList}

For each stock, respond with:
{"code":"TICKER","action":"URGENT_SELL|SELL_WARNING|POSITIVE|NEUTRAL","headline":"one-line summary","reasoning":"brief explanation","confidence":0.0-1.0}

Rules:
- URGENT_SELL: earnings miss, FDA rejection, major lawsuit, fraud, bankruptcy risk (conf >= 0.85)
- SELL_WARNING: analyst downgrade, guidance cut, sector headwind (conf >= 0.70)
- POSITIVE: earnings beat, upgrade, new contract, buyback (conf >= 0.70)
- NEUTRAL: no material news (conf = 0)
- Only flag REAL news events, not speculation

Respond as JSON array: [...]`,
      { temperature: 0.1, maxOutputTokens: 500, label: '그라운딩-보유종목뉴스', grounded: useGrounded },
    );

    // 쿨다운 갱신
    for (const t of toCheck) _lastCheck.set(t.code, now);

    // JSON 파싱
    const cleaned = result
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const signals: GroundedSignal[] = JSON.parse(cleaned);
    const actionable = signals.filter((s) => s.action !== 'NEUTRAL' && s.confidence >= 0.7);

    if (actionable.length > 0) {
      logger.info(
        `🔍 그라운딩 뉴스: ${actionable.map((s) => `${s.code}=${s.action}(${(s.confidence * 100).toFixed(0)}%) "${s.headline}"`).join(' | ')}`,
        { component: 'GROUNDED_INTEL' },
      );
    }

    return actionable;
  } catch (err) {
    logger.warn(`그라운딩 뉴스 체크 실패: ${err instanceof Error ? err.message : err}`, {
      component: 'GROUNDED_INTEL',
    });
    return [];
  }
}

/**
 * 매크로 이벤트 체크 — 시장 전체에 영향 줄 이벤트 감지
 * 하루 2~3회 호출 (개장 전, 장중, 장 마감 전)
 */
let _lastMacroCheck = 0;
const MACRO_COOLDOWN_MS = 8 * 3600_000; // v26: 8시간 쿨다운 (6→8시간, 일 3회→3회 유지하되 여유 확보)

export interface MacroSignal {
  event: string;
  impact: 'RISK_OFF' | 'RISK_ON' | 'NEUTRAL';
  severity: 1 | 2 | 3; // 1=minor, 2=moderate, 3=major
  reasoning: string;
}

export async function checkMacroEvents(): Promise<MacroSignal[]> {
  const { config } = await import('../config/index.js');
  if (!config.geminiEnabled) return [];
  const now = Date.now();
  if (now - _lastMacroCheck < MACRO_COOLDOWN_MS) return [];
  _lastMacroCheck = now;

  // 일일 쿼터 체크
  let useGrounded = true;
  if (!checkGroundedQuota()) {
    useGrounded = false;
    logger.warn(`⚠️ 그라운딩 일일 한도 도달 (${GROUNDED_DAILY_LIMIT}회) → grounded=false 폴백`, { component: 'GROUNDED_INTEL' });
    try {
      const { sendTelegramMessage } = await import('../notifications/telegram.js');
      sendTelegramMessage(`⚠️ 그라운딩 일일 쿼터 ${GROUNDED_DAILY_LIMIT}회 도달 — grounded=false 폴백 중`).catch(() => {});
    } catch {}
  }

  try {
    const result = await callVertexGemini(
      `You are a macro economist monitoring US market-moving events.
Only report events from the LAST 6 HOURS that could move the US stock market significantly.`,
      `Current time: ${new Date().toISOString()}.
What major economic events, Fed announcements, geopolitical developments, or market-moving news happened in the last 6 hours?

Respond as JSON array:
[{"event":"brief description","impact":"RISK_OFF|RISK_ON|NEUTRAL","severity":1-3,"reasoning":"why this matters"}]

severity: 1=minor, 2=moderate (+/-1% market), 3=major (+/-2%+ market)
If nothing significant, respond: []`,
      { temperature: 0.1, maxOutputTokens: 400, label: '그라운딩-매크로이벤트', grounded: useGrounded },
    );

    const cleaned = result
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const events: MacroSignal[] = JSON.parse(cleaned);
    const significant = events.filter((e) => e.severity >= 2);

    if (significant.length > 0) {
      logger.info(
        `🌍 매크로 이벤트: ${significant.map((e) => `[Lv${e.severity}] ${e.impact} "${e.event}"`).join(' | ')}`,
        { component: 'GROUNDED_INTEL' },
      );
    }

    return significant;
  } catch (err) {
    logger.warn(`매크로 이벤트 체크 실패: ${err instanceof Error ? err.message : err}`, {
      component: 'GROUNDED_INTEL',
    });
    return [];
  }
}
