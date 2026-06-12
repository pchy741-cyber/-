/**
 * 시장 라우팅 — 미국 증시 야간 지수를 기반으로 당일 Risk-On/Off 판정
 *
 * 08:45 KST 크론에서 runDomesticDual() 로 호출됨 (paper → live 순)
 *
 * Risk-Off: 신규 매수 전면 차단 + 예수금 전액 SOFR ETF 대피
 * Risk-On:  SOFR 언파킹 + 8개 전략 재배분
 * Neutral:  직전 상태 유지 (매수 차단 여부 변경 없음)
 */

import { getMacroSnapshot } from '../automation/macro-data.js';
import { getCtxIsPaper } from '../config/context.js';
import { getOpenChains } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getAccountBalance } from '../kis/account.js';
import { getCurrentPrice } from '../kis/market.js';
import { getFearGreedIndex } from '../market/external-signals.js';
import { getMacroSignal } from '../market/macro-signal.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

const SOFR_ETF_CODE = '449170'; // KODEX 미국달러SOFR금리액티브

// 모듈 레벨 상태 — 서버 재시작 시 안전 기본값 (차단 없음)
let _riskOff = false;
let _riskOffStreak = 0; // 연속 Risk-Off 감지 일수 (score ≥ 35)
let _riskOnStreak = 0; // 연속 Risk-On  감지 일수 (score < 20)
let _lastRoutingDate = ''; // 중복 카운트 방지 (YYYY-MM-DD KST)

// SOFR ETF 배당소득세(15.4%) Whipsaw 마찰 방지 — 불감대(Dead Band) 임계값
const DEAD_BAND = {
  PARK_DAYS: 3, // 3영업일 연속 Risk-Off → 파킹 실행
  UNPARK_DAYS: 2, // 2영업일 연속 Risk-On 회복 → 언파킹 실행
  IMMEDIATE_SCORE: 50, // 초극단 위기 점수 → 즉시 파킹 (불감대 우회)
} as const;

export function isRiskOffToday(): boolean {
  return _riskOff;
}

export function getMarketRoutingState(): { riskOff: boolean } {
  return { riskOff: _riskOff };
}

// ── S&P 500 등락률 조회 ──────────────────────────────────────────────────────

async function fetchSpxChangePct(): Promise<number | null> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=2d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantOps/1.0)' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> };
    };
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice || !meta?.chartPreviousClose) return null;
    return ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
  } catch {
    return null;
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

// ── SOFR ETF 파킹 ────────────────────────────────────────────────────────────

async function parkCashInSofr(): Promise<boolean> {
  const isPaper = getCtxIsPaper();
  try {
    const openChains = await getOpenChains();
    const existing = openChains.find((c) => c.stock_code === SOFR_ETF_CODE && c.total_quantity > 0);
    if (existing) {
      logger.info(`💰 [${isPaper ? 'PAPER' : 'LIVE'}] SOFR 이미 ${existing.total_quantity}주 보유 — 추가 매수 스킵`, {
        component: 'MARKET_ROUTING',
      });
      return true;
    }

    const balance = await getAccountBalance();
    const cash = balance?.orderableCash ?? 0;
    if (cash < 10_000) {
      logger.info(`💰 [${isPaper ? 'PAPER' : 'LIVE'}] 예수금 부족 (${cash.toLocaleString()}원) — SOFR 파킹 스킵`, {
        component: 'MARKET_ROUTING',
      });
      return false;
    }

    const priceData = await getCurrentPrice(SOFR_ETF_CODE);
    const price = priceData.currentPrice;
    if (!price || price <= 0) return false;

    const qty = Math.floor(cash / price);
    if (qty <= 0) return false;

    const decision: TradeDecision = {
      action: 'BUY',
      stock_code: SOFR_ETF_CODE,
      quantity: qty,
      price_type: 'MARKET',
      reasoning: `Risk-Off 시장라우팅: 예수금 ${cash.toLocaleString()}원 전액 SOFR 대피`,
      confidence: 1.0,
    };

    await tradeExecutor.processDecisions([decision], 'DEFENSE', 'MARKET_ROUTING_PARK');
    logger.info(`🅿️ [${isPaper ? 'PAPER' : 'LIVE'}] SOFR 파킹 완료: ${qty}주 × ${price.toLocaleString()}원`, {
      component: 'MARKET_ROUTING',
    });
    return true;
  } catch (e) {
    logger.error(`SOFR 파킹 실패 [${isPaper ? 'PAPER' : 'LIVE'}]: ${e}`, { component: 'MARKET_ROUTING' });
    return false;
  }
}

// ── SOFR ETF 언파킹 ──────────────────────────────────────────────────────────

async function unparkSofrEtf(): Promise<boolean> {
  const isPaper = getCtxIsPaper();
  try {
    const openChains = await getOpenChains();
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

  // 3. 불감대(Dead Band) 스트릭 업데이트 — 하루 1회만 카운트 (paper/live 중복 방지)
  const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (todayKst !== _lastRoutingDate) {
    _lastRoutingDate = todayKst;
    if (level === 'RISK_OFF') {
      _riskOffStreak++;
      _riskOnStreak = 0;
    } else if (level === 'RISK_ON') {
      _riskOnStreak++;
      _riskOffStreak = 0;
    }
    // NEUTRAL: 양쪽 스트릭 모두 유지 (카운트 없음)
  }

  const streakLine = `RiskOff연속=${_riskOffStreak}d RiskOn연속=${_riskOnStreak}d`;
  logger.info(`📡 시장라우팅 [${isPaper ? 'PAPER' : 'LIVE'}] ${infoLine} | ${streakLine}`, {
    component: 'MARKET_ROUTING',
  });

  // 4. 파킹/언파킹 결정 — 불감대 통과 여부 확인
  const immediateMode = score >= DEAD_BAND.IMMEDIATE_SCORE; // 초극단 위기: 즉시 행동
  const shouldPark = !_riskOff && level === 'RISK_OFF' && (immediateMode || _riskOffStreak >= DEAD_BAND.PARK_DAYS);
  const shouldUnpark = _riskOff && level === 'RISK_ON' && _riskOnStreak >= DEAD_BAND.UNPARK_DAYS;

  if (shouldPark) {
    _riskOff = true;
    await parkCashInSofr();
    if (!isPaper) {
      const reason = immediateMode
        ? `⚡ 초극단 위기(Score=${score}) — 즉시 파킹`
        : `📅 ${_riskOffStreak}영업일 연속 Risk-Off — 불감대 통과`;
      await sendTelegramMessage(
        `🚨 *시장라우팅: RISK_OFF*\n${infoLine}\n${reason}\n💰 SOFR ETF 파킹 실행 — 신규 스캔 전면 차단`,
      ).catch(() => {});
    }
  } else if (shouldUnpark) {
    _riskOff = false;
    const unpacked = await unparkSofrEtf();
    if (unpacked && !isPaper) {
      await sendTelegramMessage(
        `✅ *시장라우팅: RISK_ON 회복*\n${infoLine}\n📅 ${_riskOnStreak}영업일 연속 회복 — SOFR 언파킹 → 8개 전략 재배분`,
      ).catch(() => {});
    }
  } else if (level === 'RISK_OFF' && !_riskOff && !isPaper && _riskOffStreak === 1) {
    // 첫 Risk-Off 감지: 불감대 대기 시작 알림
    await sendTelegramMessage(
      `⚠️ *시장라우팅: RISK_OFF 감지 (불감대 대기)*\n${infoLine}\n📅 ${_riskOffStreak}/${DEAD_BAND.PARK_DAYS}영업일 — ${DEAD_BAND.PARK_DAYS - _riskOffStreak}일 더 유지 시 파킹`,
    ).catch(() => {});
  }
  // NEUTRAL / 불감대 대기 중: 현재 _riskOff 상태 유지, 행동 없음
}
