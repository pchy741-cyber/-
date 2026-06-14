/**
 * 세션 전략 리뷰 시스템
 * 루프 시작 시 종합 리뷰 → 세션 전략 수립 → 매 사이클 유효성 체크 → 종료 시 요약
 */

import { getAIGeneratedInsights } from '../../ai/overseas/insights-generator.js';
import { getOverseasInsightsForPrompt } from '../../automation/self-learning/overseas-analyzers.js';
import { getPool } from '../../db/client.js';
import { getFearGreedIndex } from '../../market/external-signals.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';
import { getOverseasWinRates, getRecentPerfSummary } from './analytics.js';
import { calcRollingKelly, extractTradingPatterns, getVixRegime } from './risk-intelligence.js';
import { getCash, getHoldings } from './state.js';

// ── Types ──

export interface SessionStrategyBrief {
  marketRegime: 'BULL' | 'NEUTRAL' | 'BEAR' | 'CRISIS';
  riskLevel: 'AGGRESSIVE' | 'NORMAL' | 'CAUTIOUS' | 'DEFENSIVE';
  focusSectors: string[];
  avoidStocks: string[];
  priorityStocks: string[];
  sizingMultiplier: number;
  confidenceFloor: number;
  narrative: string;
  warnings: string[];
}

interface SessionSnapshot {
  vix: number;
  fearGreed: number;
  vixRegime: 'CALM' | 'STRESS' | 'CRISIS';
  portfolioValue: number;
}

interface SessionLog {
  startedAt: string;
  totalRuns: number;
  briefGenerated: boolean;
}

// ── State ──

let _activeBrief: SessionStrategyBrief | null = null;
let _sessionSnapshot: SessionSnapshot | null = null;
let _sessionId: string | null = null;
let _priceShockTriggered = false;

export function getActiveSessionBrief(): SessionStrategyBrief | null {
  return _activeBrief;
}

export function clearSessionBrief(): void {
  _activeBrief = null;
  _sessionSnapshot = null;
  _sessionId = null;
}

// ── Session Brief Generation ──

const SESSION_STRATEGY_PROMPT = `당신은 알고리즘 트레이딩 세션 전략가입니다.
아래 데이터를 분석하여 이번 매매 세션의 전략을 수립하세요.

분석 항목:
1. 시장 레짐 판단 (BULL/NEUTRAL/BEAR/CRISIS)
2. 리스크 수준 설정 (AGGRESSIVE/NORMAL/CAUTIOUS/DEFENSIVE)
3. 집중할 섹터 및 우선 종목
4. 회피할 종목 (저승률, 패턴 불리)
5. 전역 사이징 배율 (0.5~1.5)
6. 세션 최소 confidence 임계값

반드시 아래 JSON 형식만 응답:
{
  "marketRegime": "BULL|NEUTRAL|BEAR|CRISIS",
  "riskLevel": "AGGRESSIVE|NORMAL|CAUTIOUS|DEFENSIVE",
  "focusSectors": ["섹터1", "섹터2"],
  "avoidStocks": ["코드1"],
  "priorityStocks": ["코드1", "코드2"],
  "sizingMultiplier": 1.0,
  "confidenceFloor": 0.70,
  "narrative": "2~3문장 전략 요약",
  "warnings": ["경고1"]
}`;

export async function generateSessionBrief(): Promise<SessionStrategyBrief | null> {
  const { config } = await import('../../config/index.js');
  if (!config.geminiEnabled) {
    logger.info('📋 세션전략 스킵 (Gemini OFF)', { component: 'SESSION' });
    return null;
  }
  try {
    _sessionId = `sess_${Date.now()}`;

    // 병렬 데이터 수집
    const [sentiment, holdings, cashPaper, cashLive, kelly, patterns, perfSummary, aiInsights] = await Promise.all([
      getFearGreedIndex().catch(() => null),
      getHoldings().catch(() => new Map()),
      getCash(true).catch(() => 0),
      getCash(false).catch(() => 0),
      calcRollingKelly().catch(() => ({
        fullKelly: 0.2,
        halfKelly: 0.1,
        winRate: 0.5,
        avgWin: 5.0,
        avgLoss: 3.0,
        sampleCount: 0,
      })),
      extractTradingPatterns().catch(() => []),
      getRecentPerfSummary().catch(() => ''),
      getAIGeneratedInsights().catch(() => ''),
    ]);

    // 보유 종목 코드 추출
    const holdingCodes = [...holdings.keys()];
    const winRates =
      holdingCodes.length > 0 ? await getOverseasWinRates(holdingCodes).catch(() => new Map()) : new Map();

    // 스냅샷 저장
    const vixValue = sentiment?.vix ?? 0;
    const fgScore = sentiment?.fearGreedScore ?? 50;
    const vixRegime = getVixRegime(vixValue);
    const totalHoldingValue = [...holdings.values()].reduce((s, h) => s + h.qty * h.avgPrice, 0);
    _sessionSnapshot = {
      vix: vixValue,
      fearGreed: fgScore,
      vixRegime: vixRegime.regime,
      portfolioValue: cashPaper + cashLive + totalHoldingValue,
    };

    // 데이터 조합
    const holdingsSummary =
      holdingCodes
        .map((code) => {
          const h = holdings.get(code)!;
          const wr = winRates.get(code);
          return `${code}: ${h.qty}주 @$${h.avgPrice.toFixed(2)} (${h.exchange})${wr ? ` 승률${(wr.winRate * 100).toFixed(0)}%` : ''}`;
        })
        .join('\n') || '보유 없음';

    const patternsSummary = patterns.map((p) => `- ${p.pattern}: ${p.evidence}`).join('\n') || '패턴 없음';

    const userMessage = [
      `【시장 상황】`,
      `Fear&Greed: ${fgScore} (${sentiment?.fearGreedLabel ?? 'N/A'})`,
      `VIX: ${vixValue.toFixed(1)} (레짐: ${vixRegime.regime})`,
      '',
      `【포트폴리오】`,
      `Paper 현금: $${cashPaper.toFixed(0)} | Live 현금: $${cashLive.toFixed(0)}`,
      `보유 ${holdingCodes.length}종목:`,
      holdingsSummary,
      '',
      `【켈리 사이징】`,
      `승률 ${(kelly.winRate * 100).toFixed(0)}% | Half-Kelly ${(kelly.halfKelly * 100).toFixed(1)}% (${kelly.sampleCount}건)`,
      '',
      `【최근 실적】`,
      perfSummary || '데이터 없음',
      '',
      `【트레이딩 패턴】`,
      patternsSummary,
      '',
      aiInsights ? `【AI 인사이트】\n${aiInsights}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // 해외 매매일지 학습 인사이트 추가 (데이터가 쌓일수록 정밀해짐)
    const overseasLearned = await getOverseasInsightsForPrompt().catch(() => '');
    const fullMessage = overseasLearned ? `${userMessage}\n${overseasLearned}` : userMessage;

    const response = await callVertexGemini(SESSION_STRATEGY_PROMPT, fullMessage, {
      temperature: 0.2,
      maxOutputTokens: 500,
      label: '해외-세션전략',
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');

    const parsed = JSON.parse(jsonMatch[0]) as SessionStrategyBrief;

    // 유효성 보정
    parsed.sizingMultiplier = Math.max(0.5, Math.min(1.5, parsed.sizingMultiplier ?? 1.0));
    parsed.confidenceFloor = Math.max(0.6, Math.min(0.85, parsed.confidenceFloor ?? 0.7));
    parsed.focusSectors = (parsed.focusSectors ?? []).slice(0, 5);
    parsed.avoidStocks = (parsed.avoidStocks ?? []).slice(0, 10);
    parsed.priorityStocks = (parsed.priorityStocks ?? []).slice(0, 5);
    parsed.warnings = (parsed.warnings ?? []).slice(0, 5);

    _activeBrief = parsed;

    // DB 저장
    await getPool()
      .query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
        [`session_brief_${_sessionId}`, JSON.stringify(parsed)],
      )
      .catch(() => {});

    logger.info(`📋 세션 전략 수립 완료: ${parsed.marketRegime}/${parsed.riskLevel} — ${parsed.narrative}`, {
      component: 'SESSION_STRATEGY',
    });

    return parsed;
  } catch (err) {
    logger.warn(`세션 전략 생성 실패 (기존 로직으로 진행): ${(err as Error).message}`, {
      component: 'SESSION_STRATEGY',
    });
    _activeBrief = null;
    return null;
  }
}

// ── Strategy Validity Check (no API call) ──

export interface StrategyAdjustment {
  adjusted: boolean;
  regenerate: boolean;
  reason?: string;
}

export async function checkStrategyValidity(): Promise<StrategyAdjustment> {
  if (!_activeBrief || !_sessionSnapshot) {
    return { adjusted: false, regenerate: false };
  }

  const current = await getFearGreedIndex().catch(() => null);
  if (!current) return { adjusted: false, regenerate: false };

  const vixDelta = Math.abs(current.vix - _sessionSnapshot.vix);
  const fgDelta = Math.abs(current.fearGreedScore - _sessionSnapshot.fearGreed);
  const currentRegime = getVixRegime(current.vix).regime;

  // VIX 레짐 변경 → 전략 재생성 필요
  if (currentRegime !== _sessionSnapshot.vixRegime) {
    logger.info(`⚠️ VIX 레짐 변경: ${_sessionSnapshot.vixRegime} → ${currentRegime} — 전략 재생성`, {
      component: 'SESSION_STRATEGY',
    });
    _sessionSnapshot.vixRegime = currentRegime;
    return { adjusted: false, regenerate: true, reason: `VIX 레짐 ${_sessionSnapshot.vixRegime} → ${currentRegime}` };
  }

  let adjusted = false;

  // VIX 5pt+ 변동 → 로컬 조정
  if (vixDelta >= 5) {
    if (current.vix > _sessionSnapshot.vix) {
      _activeBrief.riskLevel =
        _activeBrief.riskLevel === 'AGGRESSIVE'
          ? 'NORMAL'
          : _activeBrief.riskLevel === 'NORMAL'
            ? 'CAUTIOUS'
            : 'DEFENSIVE';
      _activeBrief.sizingMultiplier = Math.max(0.5, _activeBrief.sizingMultiplier * 0.8);
    } else {
      _activeBrief.sizingMultiplier = Math.min(1.5, _activeBrief.sizingMultiplier * 1.1);
    }
    _sessionSnapshot.vix = current.vix;
    adjusted = true;
    logger.info(`📊 VIX ${vixDelta.toFixed(1)}pt 변동 → 사이징 ${_activeBrief.sizingMultiplier.toFixed(2)}x`, {
      component: 'SESSION_STRATEGY',
    });
  }

  // F&G 15pt+ 변동 → 로컬 조정
  if (fgDelta >= 15) {
    if (current.fearGreedScore < _sessionSnapshot.fearGreed) {
      _activeBrief.riskLevel =
        _activeBrief.riskLevel === 'AGGRESSIVE'
          ? 'NORMAL'
          : _activeBrief.riskLevel === 'NORMAL'
            ? 'CAUTIOUS'
            : 'DEFENSIVE';
    }
    _sessionSnapshot.fearGreed = current.fearGreedScore;
    adjusted = true;
    logger.info(`📊 F&G ${fgDelta}pt 변동 → 리스크 ${_activeBrief.riskLevel}`, { component: 'SESSION_STRATEGY' });
  }

  // 이벤트 기반: 보유 종목 ±3% 급변 감지 (sell-logic에서 플래그 설정)
  if (_priceShockTriggered) {
    _priceShockTriggered = false;
    return { adjusted: false, regenerate: true, reason: '보유종목 ±3% 급변 이벤트' };
  }

  return { adjusted, regenerate: false };
}

// ── 이벤트 기반 AI 리프레시 트리거 (보유 종목 ±3% 급변 감지) ──

const _lastPriceSnapshot = new Map<string, number>();

/**
 * 보유 종목 가격 변동 체크 — ±3% 이상 변동 시 true 반환 (즉시 AI 재분석 트리거용)
 * sell-logic에서 매 사이클 호출 — 실시간 가격 이미 조회된 상태에서 비교
 */
export function checkHoldingPriceShock(currentPrices: Map<string, number>): boolean {
  let shockDetected = false;

  for (const [code, curPrice] of currentPrices) {
    if (!curPrice || curPrice <= 0) continue;

    const prevPrice = _lastPriceSnapshot.get(code);
    if (prevPrice && prevPrice > 0) {
      const changePct = Math.abs((curPrice - prevPrice) / prevPrice) * 100;
      if (changePct >= 3.0) {
        logger.info(`⚡ [EVENT-TRIGGER] ${code}: ${changePct.toFixed(1)}% 급변 → AI 즉시 재분석`, { component: 'SESSION_STRATEGY' });
        shockDetected = true;
      }
    }
    _lastPriceSnapshot.set(code, curPrice);
  }

  if (shockDetected) _priceShockTriggered = true;
  return shockDetected;
}

// ── Session Summary ──

const SESSION_SUMMARY_PROMPT = `당신은 트레이딩 세션 리뷰어입니다.
이번 세션의 전략과 결과를 분석하여 간결한 요약을 작성하세요.

포함:
1. 세션 전략 vs 실제 결과
2. 잘된 점 / 개선할 점
3. 다음 세션 권장사항

한국어로, 텔레그램 메시지용 간결한 포맷으로 응답.
이모지 사용 가능. 마크다운 불필요 (텔레그램 평문).`;

export async function generateSessionSummary(log: SessionLog): Promise<void> {
  if (!_activeBrief) return;
  const { config } = await import('../../config/index.js');
  if (!config.geminiEnabled) return;

  try {
    const perfSummary = await getRecentPerfSummary().catch(() => '');

    const userMessage = [
      `【세션 전략】`,
      `레짐: ${_activeBrief.marketRegime} | 리스크: ${_activeBrief.riskLevel}`,
      `집중 섹터: ${_activeBrief.focusSectors.join(', ') || '없음'}`,
      `전략: ${_activeBrief.narrative}`,
      '',
      `【세션 결과】`,
      `시작: ${log.startedAt}`,
      `총 실행: ${log.totalRuns}회`,
      perfSummary ? `실적: ${perfSummary}` : '',
      '',
      _activeBrief.warnings.length > 0 ? `【경고사항】\n${_activeBrief.warnings.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const summary = await callVertexGemini(SESSION_SUMMARY_PROMPT, userMessage, {
      temperature: 0.3,
      maxOutputTokens: 400,
      label: '해외-세션요약',
    });

    // DB 저장
    if (_sessionId) {
      await getPool()
        .query(
          `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
          [`session_summary_${_sessionId}`, summary],
        )
        .catch(() => {});
    }

    // Telegram 전송
    const msg = `📋 세션 요약\n\n${summary}`;
    await sendTelegramMessage(msg).catch(() => {});

    logger.info(`📋 세션 요약 생성 완료`, { component: 'SESSION_STRATEGY' });
  } catch (err) {
    logger.warn(`세션 요약 생성 실패: ${(err as Error).message}`, { component: 'SESSION_STRATEGY' });
  }
}
