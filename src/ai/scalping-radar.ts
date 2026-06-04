/**
 * ScalpingRadar — AI Loop 주도 스캘핑 모멘텀 스캐너
 *
 * Gemini/Claude API $0 — 순수 기술지표 기반 규칙 엔진
 * 10분마다 AutoPilot에서 호출:
 *   1. 워치리스트 중 모멘텀 급등 종목 탐지
 *   2. 호가(bid/ask) + 거래량 + 가격 변동 4단계 필터
 *   3. 통과 종목 → ai_overrides에 scalpTarget 설정
 *   4. Track B 다음 3분 사이클에서 자동 매수
 *
 * 설계 원칙:
 * - DB 전략 모드를 SCALPING으로 바꾸지 않음 (SWING 유지, 개별 종목만 스캘핑)
 * - 최대 동시 2종목, 당일 5건 한도
 * - Paper/Live 독립 실행
 */
import { getPool, getActiveWatchlist, getOpenChains, getLatestScores } from '../db/client.js';
import { getBatchPrices, type CurrentPrice } from '../kis/market.js';
import { getOrderbookDepth } from '../kis/market-signals.js';
import { analyzeTechnicals } from '../analysis/indicators.js';
import { getDailyChart } from '../kis/market.js';
import { setOverride, getOverride, removeOverride, getOverridesByPrefix } from './ai-overrides.js';
import { logger } from '../utils/logger.js';
import { STRATEGY_PARAMS } from '../config/constants.js';

// ── 상수 ────────────────────────────────────────────────────────────
const SCALP = {
  // 필터 조건
  MIN_CHANGE_PCT: 0.5,        // 전일 대비 최소 +0.5% 상승 중
  MAX_CHANGE_PCT: 5.0,        // 갭 추격 방지: +5% 초과는 과열
  MIN_VOLUME_RATIO: 2.0,      // 20일 평균 대비 거래량 2배+
  MIN_BID_ASK_RATIO: 1.2,     // 매수 호가 ≥ 매도 호가 × 1.2
  MIN_AI_SCORE: 55,           // AI 스코어 최소 55점 (pre-filter)
  MIN_TECH_SCORE: 60,         // 기술지표 점수 최소 60점

  // 리스크 제한
  MAX_CONCURRENT_SCALPS: 2,   // 동시 스캘핑 최대 2종목
  MAX_DAILY_SCALPS: 5,        // 당일 스캘핑 최대 5건
  TTL_TARGET: 15,             // scalpTarget TTL (분)
  TTL_EXIT: 10,               // scalpExit TTL (분)

  // 시간 윈도우
  START_HOUR: 9, START_MIN: 5,   // 09:05 (개장 5분 노이즈 회피)
  END_HOUR: 14, END_MIN: 30,     // 14:30 (마감 30분 전 중단)

  // 퇴출 조건
  EXIT_BID_ASK_RATIO: 0.8,   // 매수/매도 비율 0.8 미만 → 매도 압력
} as const;

// ── 유틸: KST 시간 확인 ─────────────────────────────────────────────
function getKSTTime(): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  return {
    h: Number(parts.find(p => p.type === 'hour')!.value),
    m: Number(parts.find(p => p.type === 'minute')!.value),
  };
}

function isInScalpWindow(): boolean {
  const { h, m } = getKSTTime();
  const now = h * 60 + m;
  return now >= SCALP.START_HOUR * 60 + SCALP.START_MIN
    && now <= SCALP.END_HOUR * 60 + SCALP.END_MIN;
}

// ── 당일 스캘핑 건수 조회 ───────────────────────────────────────────
async function getTodayScalpCount(isPaper: boolean): Promise<number> {
  try {
    const { rows } = await getPool().query(`
      SELECT COUNT(*) AS cnt FROM transaction_chains
      WHERE strategy_mode = 'SCALPING'
        AND is_paper = $1
        AND opened_at >= CURRENT_DATE
    `, [isPaper]);
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}

// ── 현재 스캘핑 포지션 수 ───────────────────────────────────────────
async function getCurrentScalpPositions(isPaper: boolean): Promise<number> {
  try {
    const chains = await getOpenChains(isPaper);
    return chains.filter(c => c.strategy_mode === 'SCALPING').length;
  } catch {
    return 0;
  }
}

// ── 메인: 스캘핑 레이더 ─────────────────────────────────────────────
export async function runScalpingRadar(isPaper: boolean): Promise<{
  scanned: number;
  detected: number;
  exits: number;
  details: string[];
}> {
  const mode = isPaper ? 'paper' : 'live';
  const details: string[] = [];

  // 1. 시간 윈도우 체크
  if (!isInScalpWindow()) {
    return { scanned: 0, detected: 0, exits: 0, details: ['장중 윈도우 밖 (09:05~14:30)'] };
  }

  // 2. 리스크 한도 체크
  const [todayCount, currentPositions] = await Promise.all([
    getTodayScalpCount(isPaper),
    getCurrentScalpPositions(isPaper),
  ]);

  if (todayCount >= SCALP.MAX_DAILY_SCALPS) {
    details.push(`당일 한도 도달 (${todayCount}/${SCALP.MAX_DAILY_SCALPS}건)`);
    // 퇴출 로직은 여전히 실행
    const exits = await checkScalpExits(isPaper);
    return { scanned: 0, detected: 0, exits, details };
  }

  if (currentPositions >= SCALP.MAX_CONCURRENT_SCALPS) {
    details.push(`동시 보유 한도 (${currentPositions}/${SCALP.MAX_CONCURRENT_SCALPS}종목)`);
    const exits = await checkScalpExits(isPaper);
    return { scanned: 0, detected: 0, exits, details };
  }

  const remaining = Math.min(
    SCALP.MAX_DAILY_SCALPS - todayCount,
    SCALP.MAX_CONCURRENT_SCALPS - currentPositions,
  );

  // 3. AI 스코어 기반 pre-filter (KIS rate limit 보호)
  const watchlist = await getActiveWatchlist();
  const scores = await getLatestScores(watchlist.map(w => w.stock_code)).catch(() => []);
  const scoreMap = new Map<string, number>();
  for (const s of scores) scoreMap.set(s.stock_code, s.composite_score ?? 0);

  // 이미 보유 중이거나 이미 scalpTarget인 종목 제외
  const chains = await getOpenChains(isPaper);
  const holdingCodes = new Set(chains.map(c => c.stock_code));
  const existingTargets = getOverridesByPrefix('scalpTarget', isPaper);

  const candidates = watchlist
    .filter(w => {
      const score = scoreMap.get(w.stock_code) ?? 0;
      return score >= SCALP.MIN_AI_SCORE
        && !holdingCodes.has(w.stock_code)
        && !existingTargets.has(`${w.stock_code}_scalpTarget`);
    })
    .sort((a, b) => (scoreMap.get(b.stock_code) ?? 0) - (scoreMap.get(a.stock_code) ?? 0))
    .slice(0, 10); // 최대 10종목만 (rate limit: 10 × 2 req = ~5초)

  if (candidates.length === 0) {
    details.push('pre-filter 통과 종목 없음');
    const exits = await checkScalpExits(isPaper);
    return { scanned: 0, detected: 0, exits, details };
  }

  // 4. 실시간 데이터 수집 (병렬)
  const codes = candidates.map(c => c.stock_code);
  const [prices, ...orderbooks] = await Promise.all([
    getBatchPrices(codes).catch(() => new Map<string, CurrentPrice>()),
    ...codes.slice(0, 5).map(c => getOrderbookDepth(c).catch(() => null)), // 상위 5종목만 호가 조회
  ]);

  const obMap = new Map<string, { bidAskRatio: number }>();
  for (let i = 0; i < Math.min(codes.length, 5); i++) {
    const ob = orderbooks[i];
    if (ob) obMap.set(codes[i], { bidAskRatio: ob.bidAskRatio });
  }

  // 5. 차트 데이터 + 기술지표 (캐시 활용, 추가 호출 최소화)
  const chartBatch = 3;
  const techMap = new Map<string, ReturnType<typeof analyzeTechnicals>>();
  for (let i = 0; i < codes.length; i += chartBatch) {
    const batch = codes.slice(i, i + chartBatch);
    const charts = await Promise.allSettled(batch.map(c => getDailyChart(c, 30)));
    for (let j = 0; j < batch.length; j++) {
      const r = charts[j];
      if (r.status === 'fulfilled' && r.value.length >= 10) {
        techMap.set(batch[j], analyzeTechnicals(r.value));
      }
    }
  }

  // 6. 4단계 필터
  const detected: Array<{ code: string; score: number; reason: string }> = [];

  for (const cand of candidates) {
    const code = cand.stock_code;
    const price = prices.get(code);
    const tech = techMap.get(code);
    if (!price || !tech) continue;

    // Filter 1: 가격 모멘텀 (+0.5% ~ +5%)
    if (price.changePct < SCALP.MIN_CHANGE_PCT || price.changePct > SCALP.MAX_CHANGE_PCT) continue;

    // Filter 2: 거래량 급증 (2x+)
    if (tech.volumeRatio < SCALP.MIN_VOLUME_RATIO) continue;

    // Filter 3: 기술지표 점수
    if (tech.score < SCALP.MIN_TECH_SCORE) continue;

    // Filter 4: 호가 매수 우세 (상위 5종목만 체크, 나머지는 스킵)
    const ob = obMap.get(code);
    if (ob && ob.bidAskRatio < SCALP.MIN_BID_ASK_RATIO) continue;

    // 추가 확인: RSI 과매수 아닌지
    if (tech.rsi14 > 75) continue;

    // 통과!
    const reasons: string[] = [];
    if (price.changePct >= 2.0) reasons.push(`급등+${price.changePct.toFixed(1)}%`);
    else reasons.push(`상승+${price.changePct.toFixed(1)}%`);
    if (tech.volumeRatio >= 3.0) reasons.push(`거래량${tech.volumeRatio.toFixed(1)}x`);
    else reasons.push(`vol${tech.volumeRatio.toFixed(1)}x`);
    if (tech.bollingerBreakout === 'UP') reasons.push('BB돌파');
    if (tech.macdCrossover === 'BULLISH') reasons.push('MACD↑');
    if (ob) reasons.push(`호가${ob.bidAskRatio.toFixed(2)}`);

    detected.push({
      code,
      score: tech.score + (scoreMap.get(code) ?? 0) / 10, // 복합 점수
      reason: reasons.join('+'),
    });
  }

  // 7. 상위 N종목만 scalpTarget 설정
  detected.sort((a, b) => b.score - a.score);
  const toSet = detected.slice(0, remaining);

  let setCount = 0;
  for (const target of toSet) {
    const res = await setOverride('signal', `${target.code}_scalpTarget`, true,
      `[ScalpRadar] ${target.reason}`, SCALP.TTL_TARGET, isPaper);
    if (res.ok) {
      setCount++;
      details.push(`🎯 ${target.code}: ${target.reason}`);
      logger.info(`🎯 ScalpRadar [${mode}]: ${target.code} 모멘텀 감지 — ${target.reason}`, { component: 'SCALP_RADAR' });
    }
  }

  // 8. 퇴출 체크 (보유 스캘핑 포지션)
  const exits = await checkScalpExits(isPaper);

  return { scanned: candidates.length, detected: setCount, exits, details };
}

// ── 퇴출 체크: 보유 스캘핑 포지션 감시 ──────────────────────────────
async function checkScalpExits(isPaper: boolean): Promise<number> {
  const mode = isPaper ? 'paper' : 'live';
  const chains = await getOpenChains(isPaper);
  const scalpChains = chains.filter(c => c.strategy_mode === 'SCALPING' && c.total_quantity > 0);

  if (scalpChains.length === 0) return 0;

  let exits = 0;

  for (const chain of scalpChains) {
    const code = chain.stock_code;
    const avgPrice = Number(chain.avg_buy_price ?? 0);
    if (avgPrice <= 0) continue;

    // 호가 체크 (매도 압력 감지)
    const ob = await getOrderbookDepth(code).catch(() => null);
    if (ob && ob.bidAskRatio < SCALP.EXIT_BID_ASK_RATIO) {
      const existing = getOverride<boolean>(`${code}_forceSell`, isPaper);
      if (!existing) {
        await setOverride('signal', `${code}_forceSell`, true,
          `[ScalpRadar] 매도 압력 급증 (bid/ask=${ob.bidAskRatio.toFixed(2)})`,
          SCALP.TTL_EXIT, isPaper);
        exits++;
        logger.info(`🚨 ScalpRadar [${mode}]: ${code} 매도 압력 → forceSell`, { component: 'SCALP_RADAR' });
      }
    }

    // 진입 후 45분 경과 + 수익 미미 → 탈출 권고
    if (chain.opened_at) {
      const elapsedMin = (Date.now() - new Date(chain.opened_at).getTime()) / 60_000;
      const peak = chain.peak_price_since_open ?? avgPrice;
      const peakPnl = ((peak - avgPrice) / avgPrice) * 100;
      if (elapsedMin >= 45 && peakPnl < 0.5) {
        const existing = getOverride<boolean>(`${code}_forceSell`, isPaper);
        if (!existing) {
          await setOverride('signal', `${code}_forceSell`, true,
            `[ScalpRadar] 45분 경과 + 모멘텀 소진 (peak ${peakPnl.toFixed(1)}%)`,
            SCALP.TTL_EXIT, isPaper);
          exits++;
          logger.info(`⏰ ScalpRadar [${mode}]: ${code} 45분+모멘텀소진 → forceSell`, { component: 'SCALP_RADAR' });
        }
      }
    }
  }

  return exits;
}
