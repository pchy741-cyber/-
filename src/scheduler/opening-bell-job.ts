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

import { technicalFallbackDecisions } from '../ai/track-b/technical-fallback.js';
import { analyzeTechnicals } from '../analysis/indicators.js';
import { isRiskOffToday } from '../automation/market-routing.js';
import { getMorningBriefContext } from '../automation/morning-brief.js';
import { getPreMarketSharedScores } from '../automation/pre-market-quick-score.js';
import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getOpenChains } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { getBatchPrices, getDailyChart } from '../kis/market.js';
import { isKillSwitchActive } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';

// ── 캐시 (워밍업 → 사이클 공유) ──────────────────────────────────────────
interface WarmCache {
  chartData: Map<string, import('../kis/market.js').DailyCandle[]>;
  geminiScores: Map<string, number>; // stock_code → Gemini 실시간 점수 (0~100)
  judeojuCodes: Set<string>; // 전일 거래대금 500억+ 주도주 종목코드
  warmAt: number;
}
let _warmCache: WarmCache | null = null;

// ── 08:55 워밍업 ─────────────────────────────────────────────────────────
export async function warmupOpeningBell(): Promise<void> {
  logger.info('🌅 [OPENING] 개장 워밍업 시작 (08:55)', { component: 'OPENING_BELL' });
  const t0 = Date.now();

  try {
    const watchlist = await getActiveWatchlist();
    const stockCodes = watchlist.map((w) => w.stock_code);
    if (stockCodes.length === 0) {
      logger.warn('[OPENING] 워치리스트 비어있음', { component: 'OPENING_BELL' });
      return;
    }

    // 1. 차트 선행 로드 (65일치) — 개장 중 재조회 없음
    const chartData = new Map<string, import('../kis/market.js').DailyCandle[]>();
    const BATCH = 5;
    for (let i = 0; i < stockCodes.length; i += BATCH) {
      const batch = stockCodes.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map((c) => getDailyChart(c, 65)));
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
      logger.info(`🤖 [OPENING] 장전 빠른 스코어 재사용 (${geminiScores.size}종목) — Gemini 중복 호출 스킵`, {
        component: 'OPENING_BELL',
      });
    } else {
      try {
        const stockSummaries = stockCodes
          .map((code) => {
            const candles = chartData.get(code);
            const price = livePrices.get(code);
            if (!candles || candles.length < 5 || !price) return null;
            const tech = analyzeTechnicals(candles);
            if (!tech) return null;
            const prev = candles[candles.length - 1];
            const gapPct = prev ? ((price.currentPrice - Number(prev.close)) / Number(prev.close)) * 100 : 0;
            const watchItem = watchlist.find((w) => w.stock_code === code);
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
          })
          .filter(Boolean);

        if (stockSummaries.length > 0) {
          const { config: appCfg } = await import('../config/index.js');
          if (appCfg.geminiEnabled) {
            // 모닝브리프 컨텍스트 (08:40에 수집된 뉴스+매크로 합산)
            const brief = getMorningBriefContext();
            const briefSection = brief
              ? `## 오늘 시장 컨텍스트 (장전 브리프)
- 상황 요약: ${brief.marketSummary}
- 리스크 레벨: ${brief.riskLevel} (VKOSPI=${brief.vkospi.toFixed(0)}, F&G=${brief.fearGreedIndex.toFixed(0)}, USD/KRW=${brief.usdKrw.toFixed(0)})
- 주요 뉴스: ${brief.macroHeadlines.slice(0, 3).join(' | ') || '없음'}
${brief.stockSentiments.size > 0 ? `- 종목 뉴스 보정 (뉴스기반 ±점수): ${[...brief.stockSentiments.entries()].map(([c, v]) => `${c}${v > 0 ? '+' : ''}${v}`).join(', ')}` : ''}`
              : '## 오늘 시장 컨텍스트\n- 장전 브리프 미수집 (기술지표만 평가)';

            // HIGH/EXTREME 리스크일 때 평가 기준 조정
            const riskGuidance =
              brief && (brief.riskLevel === 'HIGH' || brief.riskLevel === 'EXTREME')
                ? `\n⚠️ 오늘은 ${brief.riskLevel} 리스크 장세입니다. 갭하락 종목은 더 가혹하게 감점하고, 진입 기준을 높이세요.`
                : '';

            const prompt = `당신은 한국 주식 개장 초단타 전문가입니다.
아래는 09:00 개장 직전 종목별 기술 지표와 갭 현황입니다.
각 종목의 개장 10분 내 단타 매수 적합성을 0~100점으로 평가하세요.

${briefSection}

평가 기준:
- 갭상승 +1~3% + 거래량 2배 이상 + RSI 45~68 → 고점수
- 갭상승 +3% 초과 → 갭 메우기 위험, 감점
- RSI > 70 또는 < 35 → 과매수/과매도, 감점
- BB 상단 돌파(UP) + 거래량 → 가점
- MACD BULLISH → 가점
- 종목 뉴스 보정값이 있으면 해당 점수를 기술지표 점수에 가감하세요${riskGuidance}

JSON만 반환 (다른 텍스트 없이):
{"scores":[{"code":"종목코드","score":점수,"reason":"한줄사유"},...]}`;

            const userMsg = JSON.stringify(stockSummaries, null, 0);
            const raw = await callVertexGemini(prompt, userMsg, {
              temperature: 0.1,
              maxOutputTokens: 1024,
              label: '개장벨-스코어',
            });
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]) as {
                scores?: Array<{ code: string; score: number; reason: string }>;
              };
              for (const s of parsed.scores ?? []) {
                if (s.code && typeof s.score === 'number') {
                  geminiScores.set(s.code, Math.max(0, Math.min(100, s.score)));
                }
              }
              logger.info(
                `🤖 [OPENING] Gemini 사전분석 완료 (${geminiScores.size}종목): ${[...geminiScores.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([c, s]) => `${c}(${s})`)
                  .join(', ')}`,
                { component: 'OPENING_BELL' },
              );
            }
          } else {
            // 규칙기반: 기술 지표로 직접 스코어링 ($0)
            for (const ss of stockSummaries as Array<Record<string, any>>) {
              let sc = 50;
              if (ss.gap >= 1 && ss.gap <= 3) sc += 15;
              else if (ss.gap > 3) sc -= 10;
              if (ss.vol >= 3.0) sc += 15;
              else if (ss.vol >= 2.0) sc += 8;
              if (ss.rsi >= 45 && ss.rsi <= 68) sc += 10;
              else if (ss.rsi > 70) sc -= 15;
              if (ss.bb === 'UP') sc += 8;
              if (ss.macd === 'BULLISH') sc += 5;
              if (ss.adx >= 25) sc += 5;
              geminiScores.set(ss.code as string, Math.max(0, Math.min(100, sc)));
            }
            logger.info(`📊 [OPENING] 규칙기반 스코어링 (${geminiScores.size}종목, Gemini OFF)`, {
              component: 'OPENING_BELL',
            });
          }
        }
      } catch (gemErr) {
        logger.warn(`[OPENING] Gemini 사전분석 실패 (기술지표만으로 진행): ${gemErr}`, { component: 'OPENING_BELL' });
      }
    } // end else (sharedScores 없을 때만 Gemini 호출)

    // 주도주 필터: 전일 거래대금 500억+ (개장 초단타는 유동성 확보 필수)
    const JUDO_MIN_TRADED = 50_000_000_000; // 500억 KRW
    const judeojuCodes = new Set<string>();
    for (const [code, candles] of chartData) {
      if (candles.length === 0) continue;
      const last = candles[candles.length - 1];
      if (Number(last.close) * Number(last.volume) >= JUDO_MIN_TRADED) judeojuCodes.add(code);
    }
    if (judeojuCodes.size < 3) {
      // fallback: top-5 by 거래대금
      const top5 = [...chartData.entries()]
        .filter(([, c]) => c.length > 0)
        .sort(
          ([, a], [, b]) =>
            Number(b[b.length - 1].close) * Number(b[b.length - 1].volume) -
            Number(a[a.length - 1].close) * Number(a[a.length - 1].volume),
        )
        .slice(0, 5)
        .map(([code]) => code);
      for (const code of top5) judeojuCodes.add(code);
      logger.info(`[OPENING] 주도주 500억 미달 → top-5 fallback (${judeojuCodes.size}종목)`, {
        component: 'OPENING_BELL',
      });
    } else {
      logger.info(`[OPENING] 주도주 필터: ${judeojuCodes.size}종목 (전일 거래대금 500억+)`, {
        component: 'OPENING_BELL',
      });
    }

    _warmCache = { chartData, geminiScores, judeojuCodes, warmAt: Date.now() };
    logger.info(`✅ [OPENING] 워밍업 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초, 차트 ${chartData.size}종목)`, {
      component: 'OPENING_BELL',
    });
  } catch (err) {
    logger.error(`[OPENING] 워밍업 실패: ${err}`, { component: 'OPENING_BELL' });
  }
}

// ── 09:00~09:10 매 사이클 (1분 간격) ────────────────────────────────────
export async function runOpeningBellCycle(): Promise<void> {
  const nowKst = getKSTNow();
  const h = nowKst.getUTCHours();
  const m = nowKst.getUTCMinutes();

  // 09:00~09:12 구간만 실행 (약간 여유)
  if (h !== 9 || m > 12) return;

  if (isKillSwitchActive('KR')) {
    logger.info('🛑 Kill Switch 활성 — 개장벨 신규 스캔 차단', { component: 'OPENING_BELL' });
    return;
  }

  if (isRiskOffToday()) {
    logger.info('🚨 Risk-Off — 개장벨 신규 스캔 차단', { component: 'OPENING_BELL' });
    return;
  }

  // Paper 모드: AI Loop ScalpingRadar가 주도 — 기존 Gemini 스캘핑만 스킵, 기술지표 매매는 허용
  // (해외는 paper에서 잘 잡히는데 국내만 안 잡힘 → 이 early return이 원인이었음)

  logger.info(`⚡ [OPENING] 개장 사이클 ${h}:${String(m).padStart(2, '0')}`, { component: 'OPENING_BELL' });

  try {
    const cache = _warmCache;
    const cacheAge = cache ? (Date.now() - cache.warmAt) / 60000 : 999;

    // 캐시가 20분 이상 오래됐으면 경고만 (차트 재조회는 하지 않음 — 속도 우선)
    if (cacheAge > 20) {
      logger.warn(`[OPENING] 워밍업 캐시 오래됨 (${cacheAge.toFixed(0)}분) — 기술지표 fallback`, {
        component: 'OPENING_BELL',
      });
    }

    const [watchlist, openChains, _strategy, balanceRaw] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
      getActiveStrategy(),
      getCtxIsPaper() ? import('../risk/engine.js').then((m) => m.getPaperBalance()) : getAccountBalance(true),
    ]);

    const stockCodes = watchlist.map((w) => w.stock_code);

    // 실시간 시세만 빠르게 조회 (캐시된 차트 재활용)
    const livePrices = await getBatchPrices([...stockCodes, ...openChains.map((c) => c.stock_code)]);

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
      if (!price || !candles) {
        aiScores.push({ stock_code: code, score: baseScore });
        continue;
      }
      const tech = analyzeTechnicals(candles);
      if (!tech) {
        aiScores.push({ stock_code: code, score: baseScore });
        continue;
      }
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
      .filter((s) => s.score >= 65)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (topCandidates.length > 0) {
      const realtimeDetails = topCandidates.map((s) => {
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
        const { config: appCfg2 } = await import('../config/index.js');
        let raw = '';
        if (appCfg2.geminiEnabled) {
          const realtimePrompt = `개장 단타 실시간 판단 (현재 09:0${m}).
아래 상위 후보 종목들의 지금 이 순간 매수 확신도를 0~100으로 재평가하세요.
갭이 이미 많이 올랐으면 추격 위험 → 낮춰라. 거래량 터지고 BB 돌파 중이면 → 높여라.
JSON만: {"scores":[{"code":"코드","score":점수},...]}`;

          raw = await callVertexGemini(realtimePrompt, JSON.stringify(realtimeDetails), {
            temperature: 0.05,
            maxOutputTokens: 256,
            label: '개장벨-실시간',
          });
        } else {
          // 규칙기반: 기술지표로 실시간 재스코어링
          const ruleScores = realtimeDetails.map((d: any) => {
            let sc = d.baseScore;
            if (d.gapPct > 4) sc -= 15;
            if (d.volumeRatio >= 3) sc += 10;
            if (d.bbBreakout === 'UP') sc += 8;
            if (d.rsi14 > 70) sc -= 10;
            return { code: d.code, score: Math.max(0, Math.min(100, sc)) };
          });
          raw = JSON.stringify({ scores: ruleScores });
        }
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { scores?: Array<{ code: string; score: number }> };
          for (const s of parsed.scores ?? []) {
            const idx = aiScores.findIndex((a) => a.stock_code === s.code);
            if (idx >= 0 && typeof s.score === 'number') {
              const prev = aiScores[idx].score;
              aiScores[idx].score = Math.max(0, Math.min(100, s.score));
              logger.info(`🤖 [OPENING] Gemini 실시간 재평가: ${s.code} ${prev}→${aiScores[idx].score}점`, {
                component: 'OPENING_BELL',
              });
            }
          }
        }
      } catch {
        /* Gemini 실시간 실패해도 캐시 점수로 진행 */
      }
    }

    // Track B 기술 판단 (캐시 차트 + 실시간 시세 + Gemini 점수 주입)
    const chartData = cache?.chartData ?? new Map();
    const orderableCash = Math.max(0, balanceRaw.orderableCash);
    // nass_amt(순자산) 우선: max_buy_amt(대용 포함)로 인한 이중계산 방지
    const totalAssets = balanceRaw.netAsset > 0
      ? balanceRaw.netAsset
      : balanceRaw.totalEvalAmount + orderableCash;

    // 갭다운 필터 — 전날 종가 대비 -0.3% 이하 종목은 개장 진입 금지
    const gapFilteredWatchlist = watchlist.filter((w) => {
      const price = livePrices.get(w.stock_code);
      const candles = cache?.chartData.get(w.stock_code);
      if (!price || !candles || candles.length === 0) return true;
      const prevClose = Number(candles[candles.length - 1].close);
      if (!prevClose || prevClose <= 0) return true;
      const gapPct = ((price.currentPrice - prevClose) / prevClose) * 100;
      if (gapPct < -0.3) {
        logger.info(`[OPENING] ${w.stock_code} 갭다운 ${gapPct.toFixed(2)}% — 개장 진입 스킵`, {
          component: 'OPENING_BELL',
        });
        return false;
      }
      return true;
    });

    // 주도주 필터 — 워밍업에서 캐시된 전일 거래대금 500억+ 종목만 허용
    const judeojuCodes = cache?.judeojuCodes;
    const judeojuFiltered =
      judeojuCodes && judeojuCodes.size > 0
        ? gapFilteredWatchlist.filter((w) => {
            const ok = judeojuCodes.has(w.stock_code);
            if (!ok) logger.info(`[OPENING] ${w.stock_code} 주도주 아님 — 개장 스킵`, { component: 'OPENING_BELL' });
            return ok;
          })
        : gapFilteredWatchlist;

    // SCALPING 영구 비활성화 (구조적 비용 > 에지) → 개장벨도 SWING 모드로 실행
    const decisions = await technicalFallbackDecisions({
      mode: 'SWING',
      watchlist: judeojuFiltered.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
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
      await tradeExecutor.processDecisions(decisions, 'SWING', 'OPENING_BELL');
    } else {
      logger.info(`[OPENING] 09:0${m} — 매매 신호 없음`, { component: 'OPENING_BELL' });
    }
  } catch (err) {
    logger.error(`[OPENING] 사이클 실패: ${err}`, { component: 'OPENING_BELL' });
  }
}
