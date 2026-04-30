/**
 * 개장 초단타 전용 파이프라인 (09:00~09:10)
 *
 * 흐름:
 *   08:55 — warmupOpeningBell(): 차트+시세 캐시, Gemini 사전 분석
 *   09:00~09:10, 1분 간격 — runOpeningBellCycle(): 캐시 사용 + Gemini 실시간 판단
 *
 * Gemini 무료 한도 (gemini-2.0-flash AI Studio):
 *   15 RPM × 10분 = 최대 150콜 가능 → 종목당 1콜, 10~15종목 × 2회 = 20~30콜 (여유)
 */

import { getActiveWatchlist, getLatestScores, getOpenChains, getActiveStrategy } from '../db/client.js';
import { getPreMarketSharedScores } from '../automation/pre-market-quick-score.js';
import { getBatchPrices, getDailyChart } from '../kis/market.js';
import { analyzeTechnicals } from '../analysis/indicators.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';
import { logger } from '../utils/logger.js';
import { technicalFallbackDecisions } from '../ai/track-b/technical-fallback.js';
import { tradeExecutor } from '../trading/executor.js';
import { getAccountBalance } from '../kis/account.js';
import { config } from '../config/index.js';
import { IDLE_PARK_CODES } from '../ai/track-b/trading-rules.js';

const IDLE_PARK_CODE_SET = new Set<string>(IDLE_PARK_CODES);

// ── 캐시 (워밍업 → 사이클 공유) ──────────────────────────────────────────
interface WarmCache {
  chartData: Map<string, import('../kis/market.js').DailyCandle[]>;
  geminiScores: Map<string, number>; // stock_code → Gemini 실시간 점수 (0~100)
  warmAt: number;
}
let _warmCache: WarmCache | null = null;

// ── 08:55 워밍업 ─────────────────────────────────────────────────────────
export async function warmupOpeningBell(): Promise<void> {
  logger.info('🌅 [OPENING] 개장 워밍업 시작 (08:55)', { component: 'OPENING_BELL' });
  const t0 = Date.now();

  try {
    const watchlist = await getActiveWatchlist();
    const stockCodes = watchlist.map(w => w.stock_code).filter(c => !IDLE_PARK_CODE_SET.has(c));
    if (stockCodes.length === 0) {
      logger.warn('[OPENING] 워치리스트 비어있음', { component: 'OPENING_BELL' });
      return;
    }

    // 1. 차트 선행 로드 (65일치) — 개장 중 재조회 없음
    const chartData = new Map<string, import('../kis/market.js').DailyCandle[]>();
    const BATCH = 5;
    for (let i = 0; i < stockCodes.length; i += BATCH) {
      const batch = stockCodes.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(c => getDailyChart(c, 65)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value.length >= 20) {
          chartData.set(batch[j], r.value);
        }
      }
    }

    // 2. 실시간 시세 (갭 확인용)
    const livePrices = await getBatchPrices(stockCodes).catch(() => new Map());

    // 3. 장전 스코어 확인 — 이미 runPreMarketQuickScore()가 Gemini를 호출했으면 재사용 (중복 호출 방지)
    const geminiScores = new Map<string, number>();
    const sharedScores = getPreMarketSharedScores();
    if (sharedScores && sharedScores.size > 0) {
      for (const [code, score] of sharedScores) {
        geminiScores.set(code, score);
      }
      logger.info(
        `🤖 [OPENING] 장전 빠른 스코어 재사용 (${geminiScores.size}종목) — Gemini 중복 호출 스킵`,
        { component: 'OPENING_BELL' },
      );
    } else {
    try {
      const stockSummaries = stockCodes.map(code => {
        const candles = chartData.get(code);
        const price = livePrices.get(code);
        if (!candles || candles.length < 5 || !price) return null;
        const tech = analyzeTechnicals(candles);
        if (!tech) return null;
        const prev = candles[candles.length - 1];
        const gapPct = prev ? ((price.currentPrice - Number(prev.close)) / Number(prev.close)) * 100 : 0;
        const watchItem = watchlist.find(w => w.stock_code === code);
        return {
          code,
          name: watchItem?.stock_name ?? code,
          gapPct: parseFloat(gapPct.toFixed(2)),
          currentPrice: price.currentPrice,
          volumeRatio: parseFloat(tech.volumeRatio.toFixed(2)),
          rsi14: parseFloat(tech.rsi14.toFixed(1)),
          macd: tech.macdCrossover,
          bbPosition: tech.bollingerPosition,
          bbBreakout: tech.bollingerBreakout,
          adx: parseFloat(tech.adx14.toFixed(1)),
          trend: tech.trendStrength,
          techScore: tech.score,
        };
      }).filter(Boolean);

      if (stockSummaries.length > 0) {
        const prompt = `당신은 한국 주식 개장 초단타 전문가입니다.
아래는 09:00 개장 직전 종목별 기술 지표와 갭 현황입니다.
각 종목의 개장 10분 내 단타 매수 적합성을 0~100점으로 평가하세요.

평가 기준:
- 갭상승 +1~3% + 거래량 2배 이상 + RSI 45~68 → 고점수
- 갭상승 +3% 초과 → 갭 메우기 위험, 감점
- RSI > 70 또는 < 35 → 과매수/과매도, 감점
- BB 상단 돌파(UP) + 거래량 → 가점
- MACD BULLISH → 가점

JSON만 반환 (다른 텍스트 없이):
{"scores":[{"code":"종목코드","score":점수,"reason":"한줄사유"},...]}`;

        const userMsg = JSON.stringify(stockSummaries, null, 0);
        const raw = await callVertexGemini(prompt, userMsg, { temperature: 0.1, maxOutputTokens: 1024 });
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { scores?: Array<{ code: string; score: number; reason: string }> };
          for (const s of parsed.scores ?? []) {
            if (s.code && typeof s.score === 'number') {
              geminiScores.set(s.code, Math.max(0, Math.min(100, s.score)));
            }
          }
          logger.info(
            `🤖 [OPENING] Gemini 사전분석 완료 (${geminiScores.size}종목): ${[...geminiScores.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([c,s])=>`${c}(${s})`).join(', ')}`,
            { component: 'OPENING_BELL' },
          );
        }
      }
    } catch (gemErr) {
      logger.warn(`[OPENING] Gemini 사전분석 실패 (기술지표만으로 진행): ${gemErr}`, { component: 'OPENING_BELL' });
    }
    } // end else (sharedScores 없을 때만 Gemini 호출)

    _warmCache = { chartData, geminiScores, warmAt: Date.now() };
    logger.info(`✅ [OPENING] 워밍업 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초, 차트 ${chartData.size}종목)`, { component: 'OPENING_BELL' });
  } catch (err) {
    logger.error(`[OPENING] 워밍업 실패: ${err}`, { component: 'OPENING_BELL' });
  }
}

// ── 09:00~09:10 매 사이클 (1분 간격) ────────────────────────────────────
export async function runOpeningBellCycle(): Promise<void> {
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const h = nowKst.getUTCHours();
  const m = nowKst.getUTCMinutes();

  // 09:00~09:12 구간만 실행 (약간 여유)
  if (h !== 9 || m > 12) return;

  logger.info(`⚡ [OPENING] 개장 사이클 ${h}:${String(m).padStart(2, '0')}`, { component: 'OPENING_BELL' });

  try {
    const cache = _warmCache;
    const cacheAge = cache ? (Date.now() - cache.warmAt) / 60000 : 999;

    // 캐시가 20분 이상 오래됐으면 경고만 (차트 재조회는 하지 않음 — 속도 우선)
    if (cacheAge > 20) {
      logger.warn(`[OPENING] 워밍업 캐시 오래됨 (${cacheAge.toFixed(0)}분) — 기술지표 fallback`, { component: 'OPENING_BELL' });
    }

    const [watchlist, openChains, strategy, balanceRaw] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
      getActiveStrategy(),
      getAccountBalance(),
    ]);

    const stockCodes = watchlist.map(w => w.stock_code).filter(c => !IDLE_PARK_CODE_SET.has(c));

    // 실시간 시세만 빠르게 조회 (캐시된 차트 재활용)
    const livePrices = await getBatchPrices([
      ...stockCodes,
      ...openChains.map(c => c.stock_code),
    ]);

    // Gemini 실시간 점수 → AI 힌트로 주입
    // 캐시된 점수 + 현재 갭/거래량 변화로 재조정 (RPM 절약: 상위 후보만 재호출)
    const aiScores: Array<{ stock_code: string; score: number }> = [];
    const cachedGeminiScores = cache?.geminiScores ?? new Map<string, number>();

    // 현재 가격 기반으로 캐시 점수 재조정 (Gemini 재호출 없이)
    for (const code of stockCodes) {
      const baseScore = cachedGeminiScores.get(code);
      if (baseScore === undefined) continue;
      const price = livePrices.get(code);
      const candles = cache?.chartData.get(code);
      if (!price || !candles) { aiScores.push({ stock_code: code, score: baseScore }); continue; }
      const tech = analyzeTechnicals(candles);
      if (!tech) { aiScores.push({ stock_code: code, score: baseScore }); continue; }
      // 거래량 급증 시 점수 보너스 (실시간 확인)
      const volBonus = tech.volumeRatio >= 3.0 ? 10 : tech.volumeRatio >= 2.0 ? 5 : 0;
      // RSI 과매수 진입 패널티
      const rsiPenalty = tech.rsi14 > 72 ? -15 : tech.rsi14 > 68 ? -5 : 0;
      const adjusted = Math.max(0, Math.min(100, baseScore + volBonus + rsiPenalty));
      aiScores.push({ stock_code: code, score: adjusted });
    }

    // 상위 후보 3종목만 Gemini 재호출 (RPM 여유 있으면)
    // 분당 최대 3콜 → 10분간 30콜 → 무료 한도 15 RPM 안전
    const topCandidates = aiScores
      .filter(s => s.score >= 65)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (topCandidates.length > 0) {
      const realtimeDetails = topCandidates.map(s => {
        const price = livePrices.get(s.stock_code);
        const candles = cache?.chartData.get(s.stock_code);
        const tech = candles ? analyzeTechnicals(candles) : null;
        const prev = candles ? candles[candles.length - 1] : null;
        const gapPct = prev && price ? ((price.currentPrice - Number(prev.close)) / Number(prev.close)) * 100 : 0;
        return {
          code: s.stock_code,
          baseScore: s.score,
          gapPct: parseFloat(gapPct.toFixed(2)),
          currentPrice: price?.currentPrice ?? 0,
          volumeRatio: tech ? parseFloat(tech.volumeRatio.toFixed(2)) : 0,
          rsi14: tech ? parseFloat(tech.rsi14.toFixed(1)) : 0,
          bbBreakout: tech?.bollingerBreakout ?? 'NONE',
          macd: tech?.macdCrossover ?? 'NEUTRAL',
          minute: m,
        };
      });

      try {
        const realtimePrompt = `개장 단타 실시간 판단 (현재 09:0${m}).
아래 상위 후보 종목들의 지금 이 순간 매수 확신도를 0~100으로 재평가하세요.
갭이 이미 많이 올랐으면 추격 위험 → 낮춰라. 거래량 터지고 BB 돌파 중이면 → 높여라.
JSON만: {"scores":[{"code":"코드","score":점수},...]}`;

        const raw = await callVertexGemini(realtimePrompt, JSON.stringify(realtimeDetails), { temperature: 0.05, maxOutputTokens: 256 });
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { scores?: Array<{ code: string; score: number }> };
          for (const s of parsed.scores ?? []) {
            const idx = aiScores.findIndex(a => a.stock_code === s.code);
            if (idx >= 0 && typeof s.score === 'number') {
              const prev = aiScores[idx].score;
              aiScores[idx].score = Math.max(0, Math.min(100, s.score));
              logger.info(`🤖 [OPENING] Gemini 실시간 재평가: ${s.code} ${prev}→${aiScores[idx].score}점`, { component: 'OPENING_BELL' });
            }
          }
        }
      } catch { /* Gemini 실시간 실패해도 캐시 점수로 진행 */ }
    }

    // Track B 기술 판단 (캐시 차트 + 실시간 시세 + Gemini 점수 주입)
    const chartData = cache?.chartData ?? new Map();
    const orderableCash = Math.max(0, balanceRaw.orderableCash);
    const totalAssets = balanceRaw.totalEvalAmount + orderableCash;

    const decisions = await technicalFallbackDecisions({
      mode: 'SCALPING',
      watchlist: watchlist
        .filter(w => !IDLE_PARK_CODE_SET.has(w.stock_code))
        .map(w => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
      livePrices,
      chartData,
      openChains,
      orderableCash,
      maxPositionKrw: config.risk.maxPositionKrw,
      totalAssets,
      aiScores,
      blockNewBuys: false,
    });

    if (decisions.length > 0) {
      logger.info(`⚡ [OPENING] 개장 결정 ${decisions.length}건 실행`, { component: 'OPENING_BELL' });
      await tradeExecutor.processDecisions(decisions, 'SCALPING');
    } else {
      logger.info(`[OPENING] 09:0${m} — 매매 신호 없음`, { component: 'OPENING_BELL' });
    }
  } catch (err) {
    logger.error(`[OPENING] 사이클 실패: ${err}`, { component: 'OPENING_BELL' });
  }
}
