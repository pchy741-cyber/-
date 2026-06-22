/**
 * 시장 라우팅 — 미국 증시 야간 지수를 기반으로 당일 Risk-On/Off 판정
 *
 * 08:45 KST 크론에서 runDomesticDual() 로 호출됨 (paper → live 순)
 *
 * v10.9.5: SOFR 파킹 폐지
 * Risk-Off: 신규 매수 전면 차단 (현금 보존, 해외매매 자금 유지)
 * Risk-On:  매수 재개 + 잔여 SOFR 정리
 * Neutral:  직전 상태 유지
 */

import { getMacroSnapshot } from '../automation/macro-data.js';
import { getCtxIsPaper } from '../config/context.js';
import { getOpenChains } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getFearGreedIndex } from '../market/external-signals.js';
import { getMacroSignal } from '../market/macro-signal.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { PARK_STOCK_CODE } from '../ai/track-b/defense-park.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

/** @deprecated SOFR 잔여분 매도용 — 신규 매수 없음 */
const SOFR_ETF_CODE = PARK_STOCK_CODE;

// 모듈 레벨 상태 — Paper/Live 완전 분리 (전역 공유 시 paper 크론이 live 스트릭 오염)
const _state = {
  paper: { riskOff: false, riskOffStreak: 0, riskOnStreak: 0, lastDate: '' },
  live:  { riskOff: false, riskOffStreak: 0, riskOnStreak: 0, lastDate: '' },
};

// SOFR ETF 배당소득세(15.4%) Whipsaw 마찰 방지 — 불감대(Dead Band) 임계값
const DEAD_BAND = {
  PARK_DAYS: 3, // 3영업일 연속 Risk-Off → 파킹 실행
  UNPARK_DAYS: 2, // 2영업일 연속 Risk-On 회복 → 언파킹 실행
  IMMEDIATE_SCORE: 50, // 초극단 위기 점수 → 즉시 파킹 (불감대 우회)
} as const;

export function isRiskOffToday(): boolean {
  return _state[getCtxIsPaper() ? 'paper' : 'live'].riskOff;
}

export function getMarketRoutingState(): { riskOff: boolean } {
  return { riskOff: _state[getCtxIsPaper() ? 'paper' : 'live'].riskOff };
}

// ── S&P 500 등락률 조회 (5분 캐시 — 외부 API 타임아웃 시 stale 결과 사용) ──

let _spxCache: { value: number | null; fetchedAt: number } | null = null;
const SPX_CACHE_TTL_MS = 5 * 60 * 1000; // 5분

async function fetchSpxChangePct(): Promise<number | null> {
  // 캐시 히트: 5분 이내 결과 재사용 (외부 API 지연 방지)
  if (_spxCache && Date.now() - _spxCache.fetchedAt < SPX_CACHE_TTL_MS) {
    return _spxCache.value;
  }
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=2d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantOps/1.0)' },
      signal: AbortSignal.timeout(5_000), // 8s→5s 타임아웃 단축
    });
    if (!res.ok) {
      // 실패 시 stale 캐시 반환 (null보다 낫다)
      return _spxCache?.value ?? null;
    }
    const data = (await res.json()) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> };
    };
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice || !meta?.chartPreviousClose) return _spxCache?.value ?? null;
    const pct = ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
    _spxCache = { value: pct, fetchedAt: Date.now() };
    return pct;
  } catch (err) {
    logger.debug(`S&P500 등락률 조회 실패 (stale 캐시 반환): ${err}`, { component: 'MARKET_ROUTING' });
    return _spxCache?.value ?? null;
  }
}

// ── 멀티팩터 리스크 스코어링 ────────────────────────────────────────────────

interface RiskInputs {
  vix: number | null;
  spxChangePct: number | null;
  nasdaqChangePct: number | null;
  vkospi: number | null;
  fearGreed: number | null;
  usdKrw: number | null;
}

function computeRiskScore(p: RiskInputs): number {
  let score = 0;

  if (p.vix !== null) {
    if (p.vix >= 35) score += 35;
    else if (p.vix >= 28) score += 22;
    else if (p.vix >= 22) score += 12;
  }

  if (p.spxChangePct !== null) {
    if (p.spxChangePct <= -3.0) score += 30;
    else if (p.spxChangePct <= -2.0) score += 20;
    else if (p.spxChangePct <= -1.0) score += 10;
    else if (p.spxChangePct >= 1.0) score -= 5;
  }

  if (p.nasdaqChangePct !== null) {
    if (p.nasdaqChangePct <= -3.0) score += 25;
    else if (p.nasdaqChangePct <= -2.0) score += 15;
    else if (p.nasdaqChangePct <= -1.0) score += 8;
  }

  if (p.vkospi !== null) {
    if (p.vkospi >= 35) score += 20;
    else if (p.vkospi >= 25) score += 12;
    else if (p.vkospi >= 20) score += 5;
  }

  if (p.fearGreed !== null) {
    if (p.fearGreed < 15) score += 15;
    else if (p.fearGreed < 30) score += 8;
  }

  if (p.usdKrw !== null) {
    if (p.usdKrw >= 1500) score += 12;
    else if (p.usdKrw >= 1450) score += 6;
  }

  return score;
}

type RiskLevel = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

function scoreToLevel(score: number): RiskLevel {
  if (score >= 35) return 'RISK_OFF';
  if (score >= 20) return 'NEUTRAL';
  return 'RISK_ON';
}

// ── SOFR ETF 잔여분 매도 (레거시 정리용) ─────────────────────────────────────

async function unparkSofrEtf(): Promise<boolean> {
  const isPaper = getCtxIsPaper();
  try {
    const openChains = await getOpenChains(isPaper);
    const sofrChains = openChains.filter((c) => c.stock_code === SOFR_ETF_CODE && c.total_quantity > 0);
    if (sofrChains.length === 0) {
      logger.info(`[${isPaper ? 'PAPER' : 'LIVE'}] SOFR 보유 없음 — 언파킹 스킵`, { component: 'MARKET_ROUTING' });
      return false;
    }

    const decisions: TradeDecision[] = sofrChains.map((c) => ({
      action: 'FORCE_CLOSE' as const,
      stock_code: SOFR_ETF_CODE,
      quantity: c.total_quantity,
      price_type: 'MARKET' as const,
      reasoning: 'Risk-On 회복: SOFR 파킹 해제, 운용 자금 복귀',
      confidence: 1.0,
    }));

    await tradeExecutor.processDecisions(decisions, 'DEFENSE', 'MARKET_ROUTING_UNPARK');
    const totalQty = sofrChains.reduce((s, c) => s + c.total_quantity, 0);
    logger.info(`🚀 [${isPaper ? 'PAPER' : 'LIVE'}] SOFR 언파킹 완료: ${totalQty}주`, { component: 'MARKET_ROUTING' });
    return true;
  } catch (e) {
    logger.error(`SOFR 언파킹 실패 [${isPaper ? 'PAPER' : 'LIVE'}]: ${e}`, { component: 'MARKET_ROUTING' });
    return false;
  }
}

// ── 메인 엔트리 ─────────────────────────────────────────────────────────────

export async function dailyMarketRouting(): Promise<void> {
  const isPaper = getCtxIsPaper();
  const s = _state[isPaper ? 'paper' : 'live'];

  // 1. 병렬 데이터 수집
  const [spxResult, macroResult, sentResult, snapResult] = await Promise.allSettled([
    fetchSpxChangePct(),
    getMacroSignal(),
    getFearGreedIndex(),
    getMacroSnapshot(),
  ]);

  const spxChangePct = spxResult.status === 'fulfilled' ? spxResult.value : null;
  const macro = macroResult.status === 'fulfilled' ? macroResult.value : null;
  const sent = sentResult.status === 'fulfilled' ? sentResult.value : null;
  const snap = snapResult.status === 'fulfilled' ? snapResult.value : null;

  const inputs: RiskInputs = {
    vix: sent?.vix ?? null,
    spxChangePct,
    nasdaqChangePct: macro?.nasdaqChange1d ?? null,
    vkospi: snap?.vkospi ?? null,
    fearGreed: sent?.fearGreedScore ?? null,
    usdKrw: macro?.usdKrw ?? null,
  };

  // 2. 리스크 레벨 판정
  const score = computeRiskScore(inputs);
  const level = scoreToLevel(score);

  const infoLine = [
    `VIX=${inputs.vix != null ? inputs.vix.toFixed(1) : 'N/A'}`,
    `SPX=${inputs.spxChangePct != null ? `${inputs.spxChangePct.toFixed(2)}%` : 'N/A'}`,
    `NDX=${inputs.nasdaqChangePct != null ? `${inputs.nasdaqChangePct.toFixed(2)}%` : 'N/A'}`,
    `VKOSPI=${inputs.vkospi != null ? inputs.vkospi.toFixed(1) : 'N/A'}`,
    `F&G=${inputs.fearGreed ?? 'N/A'}`,
    `USD=${inputs.usdKrw != null ? inputs.usdKrw.toFixed(0) : 'N/A'}`,
    `Score=${score}`,
    `→ ${level}`,
  ].join(' ');

  // 3. 불감대(Dead Band) 스트릭 업데이트 — 하루 1회만 카운트 (paper/live 각자 독립 추적)
  const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (todayKst !== s.lastDate) {
    s.lastDate = todayKst;
    if (level === 'RISK_OFF') {
      s.riskOffStreak++;
      s.riskOnStreak = 0;
    } else if (level === 'RISK_ON') {
      s.riskOnStreak++;
      s.riskOffStreak = 0;
    }
    // NEUTRAL: 양쪽 스트릭 모두 유지 (카운트 없음)
  }

  const streakLine = `RiskOff연속=${s.riskOffStreak}d RiskOn연속=${s.riskOnStreak}d`;
  logger.info(`📡 시장라우팅 [${isPaper ? 'PAPER' : 'LIVE'}] ${infoLine} | ${streakLine}`, {
    component: 'MARKET_ROUTING',
  });

  // 4. 파킹/언파킹 결정 — 불감대 통과 여부 확인
  const immediateMode = score >= DEAD_BAND.IMMEDIATE_SCORE; // 초극단 위기: 즉시 행동
  const shouldPark = !s.riskOff && level === 'RISK_OFF' && (immediateMode || s.riskOffStreak >= DEAD_BAND.PARK_DAYS);
  const shouldUnpark = s.riskOff && level === 'RISK_ON' && s.riskOnStreak >= DEAD_BAND.UNPARK_DAYS;

  if (shouldPark) {
    s.riskOff = true;
    // v10.9.5: SOFR 파킹 비활성화 — 수수료 > 수익 구조적 손실 + 해외매매 현금 잠식
    // 기존: parkCashInSofr() → 예수금 전액 SOFR ETF 매수
    // 변경: 신규 매수만 차단, 현금은 유지 (해외주식 매수 자금으로 활용)
    logger.info(`🛡️ [${isPaper ? 'PAPER' : 'LIVE'}] Risk-Off 진입 — 신규 매수 차단 (SOFR 파킹 비활성)`, {
      component: 'MARKET_ROUTING',
    });
    if (!isPaper) {
      const reason = immediateMode
        ? `⚡ 초극단 위기(Score=${score}) — 즉시 매수 차단`
        : `📅 ${s.riskOffStreak}영업일 연속 Risk-Off — 불감대 통과`;
      await sendTelegramMessage(
        `🚨 *시장라우팅: RISK_OFF*\n${infoLine}\n${reason}\n🛡️ 신규 매수 차단 (현금 보존, 해외매매 자금 유지)`,
      ).catch(() => {});
    }
  } else if (shouldUnpark) {
    s.riskOff = false;
    // v10.9.5: 기존 SOFR 잔여분 있으면 정리 (이전 버전에서 매수한 것)
    const unpacked = await unparkSofrEtf();
    if (!isPaper) {
      const msg = unpacked
        ? `✅ *시장라우팅: RISK_ON 회복*\n${infoLine}\n📅 ${s.riskOnStreak}영업일 연속 회복 — SOFR 잔여분 매도 + 매수 재개`
        : `✅ *시장라우팅: RISK_ON 회복*\n${infoLine}\n📅 ${s.riskOnStreak}영업일 연속 회복 — 매수 재개`;
      await sendTelegramMessage(msg).catch(() => {});
    }
  } else if (level === 'RISK_OFF' && !s.riskOff && !isPaper && s.riskOffStreak === 1) {
    // 첫 Risk-Off 감지: 불감대 대기 시작 알림
    await sendTelegramMessage(
      `⚠️ *시장라우팅: RISK_OFF 감지 (불감대 대기)*\n${infoLine}\n📅 ${s.riskOffStreak}/${DEAD_BAND.PARK_DAYS}영업일 — ${DEAD_BAND.PARK_DAYS - _state.live.riskOffStreak}일 더 유지 시 파킹`,
    ).catch(() => {});
  }
  // NEUTRAL / 불감대 대기 중: 현재 riskOff 상태 유지, 행동 없음
}
