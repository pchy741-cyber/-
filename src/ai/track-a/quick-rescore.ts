/**
 * ⚡ Quick Re-Score — 매시간 무료 RSS 재스코어링 (paid AI 0 호출)
 *
 * 전체 Track A 파이프라인은 비용 큰 ensemble (Gemini+GPT+Claude) 3회/일.
 * Quick Re-Score는 그 사이에 무료 RSS 스코어러만 돌려서 점수 신선도 유지.
 *
 * 호출 빈도: 매시간 :15분 (장중 평일)
 * 비용: $0 (Google RSS + 키워드 NLP, KIS 호출만)
 *
 * 동작:
 *  1. 활성 watchlist (상위 30종목)
 *  2. KIS 일봉 데이터 (캐시 우선 — 30분)
 *  3. runRSSScoring 호출 (뉴스 감성 + 기술지표 + 모멘텀)
 *  4. ai_scores 테이블 UPSERT (오늘 날짜)
 *
 * Track B는 ai_scores 최신값 사용하므로 매시간 갱신 → 매 3분 Track B에 반영
 */

import { cacheScores } from '../../cache/redis.js';
import { getActiveWatchlist, getPool, upsertAIScore } from '../../db/client.js';
import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { analyzeNewsWithGroq } from './groq-news.js';
import { filterCandidatesWithLLM } from './llm-signal-filter.js';
import { runRSSScoring } from './rss-scorer.js';

const BUY_THRESHOLD = 68; // rss-scorer.ts와 동일 기준 (여기 재정의는 순환 import 회피용)

const COMP = 'QUICK_RESCORE';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // KST = UTC+9 in ms
const CHART_BATCH_SIZE = 10; // KIS 차트 조회 배치 크기
const CHART_BATCH_DELAY_MS = 1000; // 배치 간 대기 시간 (1초)
// 황금구간 1분 간격 시: 15종목으로 축소 (KIS rate limit 보호)
// 비 황금구간: 30종목 (기존)
const MAX_STOCKS_GOLDEN = 15;
const MAX_STOCKS = 30;

// 장세별 최소 간격 (분) — GCP 유지비 영향 미미하므로 타이트하게
// (KIS API rate limit + RSS Google News만 사용 — 무료)
const MIN_INTERVAL_MIN: Record<string, number> = {
  BULLISH: 3, // 강세장: 3분 (v18: 5→3, 모멘텀 포착 강화)
  NEUTRAL: 5, // 평상: 5분 (v18: 10→5)
  BEARISH: 10, // 약세: 10분 (v18: 20→10, 매매 적으니 여전히 낮은 빈도)
  PANIC: 30, // 패닉: 30분 (v18: 60→30)
};

let _lastRunAt = 0;
let _lastRegime = 'NEUTRAL';
let _lastOnDemandSurgeAt = 0;

async function getCurrentRegime(): Promise<string> {
  try {
    const { getPool } = await import('../../db/client.js');
    const { rows } = await getPool().query(
      `SELECT mode FROM strategy_config WHERE is_active = true ORDER BY id DESC LIMIT 1`,
    );
    const mode = String(rows[0]?.mode ?? 'SWING');
    // mode → regime 매핑
    if (mode === 'DEFENSE') return 'BEARISH';
    if (mode === 'DIVIDEND') return 'BEARISH';
    return 'NEUTRAL';
  } catch {
    return _lastRegime;
  }
}

/** 장세 + 황금구간 기반 적응형 호출 결정 */
async function shouldRunNow(): Promise<{ run: boolean; reason: string; intervalMin: number }> {
  const regime = await getCurrentRegime();
  _lastRegime = regime;

  // KST 황금구간 → 1분 간격 (CEO 강화: "반응 더 좋게")
  // 마의시간 → 5분 (v18: 15→5, 무료 RSS라 비용 영향 없음)
  // 그 외 → 장세별 3-30분
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const t = kstH * 100 + kstM;
  const inGolden = (t >= 930 && t < 1020) || (t >= 1300 && t < 1500);
  const inCursed = t >= 1020 && t < 1300;
  const intervalMin = inGolden ? 1 : inCursed ? 5 : (MIN_INTERVAL_MIN[regime] ?? 5);

  const elapsedMin = (Date.now() - _lastRunAt) / 60_000;
  if (elapsedMin < intervalMin) {
    return {
      run: false,
      reason: `스킵: ${elapsedMin.toFixed(0)}분 < ${intervalMin}분 (${regime}${inGolden ? '/황금구간' : ''})`,
      intervalMin,
    };
  }
  return {
    run: true,
    reason: `실행: ${regime}${inGolden ? '/황금구간' : ''} (간격 ${intervalMin}분)`,
    intervalMin,
  };
}

export async function runQuickRescore(): Promise<{ scored: number; errors: number; skipped?: boolean }> {
  const decision = await shouldRunNow();
  if (!decision.run) {
    logger.debug(`Quick Re-Score ${decision.reason}`, { component: COMP });
    return { scored: 0, errors: 0, skipped: true };
  }
  _lastRunAt = Date.now();
  logger.info(`⚡ ${decision.reason}`, { component: COMP });

  const start = Date.now();
  try {
    const fullWatchlist = await getActiveWatchlist();
    if (fullWatchlist.length === 0) {
      logger.debug('Quick Re-Score 스킵: watchlist 비어있음', { component: COMP });
      return { scored: 0, errors: 0 };
    }

    // 황금구간(1분 간격) 시 15종목, 아니면 30종목
    const maxStocks = decision.intervalMin === 1 ? MAX_STOCKS_GOLDEN : MAX_STOCKS;
    // v17: getActiveWatchlist()는 added_at ASC(오래된 순) → 그냥 slice(0,N)하면
    // surge-detector가 방금 편입한 급등/모멘텀 종목이 리스트 뒤쪽에 밀려 재스코어링 순번이 영영 안 옴.
    // 최근 4시간 내 편입 종목을 최우선으로 배치하고, 남는 자리를 나머지(오래된 순)로 채운다.
    const RECENT_ADD_WINDOW_MS = 4 * 3600_000;
    const now = Date.now();
    const recent = fullWatchlist.filter((w) => now - new Date(w.added_at).getTime() < RECENT_ADD_WINDOW_MS);
    const rest = fullWatchlist.filter((w) => now - new Date(w.added_at).getTime() >= RECENT_ADD_WINDOW_MS);
    const prioritized = [...recent, ...rest].slice(0, maxStocks);
    const codes = prioritized.map((w) => w.stock_code);
    logger.info(
      `⚡ Quick Re-Score 시작: ${codes.length}종목 (RSS only, paid AI 0, 최근편입 ${recent.length}종목 우선)`,
      { component: COMP },
    );

    // 일봉 차트 데이터 병렬 수집 (10개씩 배치, 1초 간격 — KIS rate limit)
    const chartData = new Map<string, Awaited<ReturnType<typeof getDailyChart>>>();
    for (let i = 0; i < codes.length; i += CHART_BATCH_SIZE) {
      const batch = codes.slice(i, i + CHART_BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (code) => {
          try {
            const chart = await getDailyChart(code, 60);
            if (chart && chart.length > 0) chartData.set(code, chart);
          } catch {
            /* 종목별 실패는 무시 */
          }
        }),
      );
      if (i + CHART_BATCH_SIZE < codes.length) await new Promise((r) => setTimeout(r, CHART_BATCH_DELAY_MS));
    }
    if (chartData.size === 0) {
      logger.warn('Quick Re-Score: 일봉 차트 데이터 0종목 — 종료', { component: COMP });
      return { scored: 0, errors: codes.length };
    }

    // 비어있는 Map들은 RSS 스코어러가 graceful 처리
    const emptySet = new Set<string>();
    const emptyMap = new Map<string, number>();

    const watchlistForRss = fullWatchlist.slice(0, maxStocks).map((w) => ({
      stock_code: w.stock_code,
      stock_name: w.stock_name ?? w.stock_code,
    }));

    // 🗞️ 황금시간 실시간 뉴스 분석 (Claude Haiku) — 15분 캐시, 황금시간만 실행
    const newsSentimentMap = new Map<string, number>();
    if (decision.intervalMin <= 5) {
      try {
        const stockMeta = watchlistForRss.map((w) => ({ stockCode: w.stock_code, companyName: w.stock_name }));
        const newsResults = await analyzeNewsWithGroq(stockMeta);
        for (const n of newsResults) {
          if (Math.abs(n.score) >= 20) {
            newsSentimentMap.set(n.stockCode, n.score);
          }
        }
        if (newsSentimentMap.size > 0) {
          logger.info(`🗞️ 실시간 뉴스 ${newsSentimentMap.size}종목 반영 (황금시간)`, { component: COMP });
        }
      } catch (e) {
        logger.warn(`실시간 뉴스 실패 (RSS 계속): ${e}`, { component: COMP });
      }
    }

    const results = await runRSSScoring('SWING', watchlistForRss, chartData, emptySet, emptySet, emptyMap);

    // 뉴스 감성 → sentiment_score 및 composite_score 보정
    for (const r of results) {
      const newsScore = newsSentimentMap.get(r.stock_code);
      if (newsScore != null) {
        // 뉴스 감성 → sentiment_score에 직접 반영 (기존 50점 기준)
        const sentimentAdj = Math.round(newsScore * 0.3); // -100~100 → -30~+30
        r.sentiment_score = Math.max(0, Math.min(100, (r.sentiment_score ?? 50) + sentimentAdj));
        // composite에도 소폭 반영 (뉴스 가중치 15%)
        const compositeAdj = Math.round(newsScore * 0.15);
        r.composite_score = Math.max(0, Math.min(100, r.composite_score + compositeAdj));
        r.reasoning = `${r.reasoning ?? ''} [뉴스${newsScore > 0 ? '+' : ''}${newsScore}]`;
      }
    }

    // 🎯 Score Enhancer — 외부 무료 신호로 후처리 가산 (FRED + 거래량 + 시간대)
    const { enhanceScoreBatch } = await import('../score-enhancer.js');
    const enhanced = await enhanceScoreBatch(
      results.map((r) => ({
        stock_code: r.stock_code,
        composite_score: r.composite_score,
        // 거래량/등락률은 chartData에서 추출 (이번 빌드는 단순 — 다음 빌드에 정밀화)
      })),
      false, // KR 종목
    );

    // 🤖 LLM 신호 검증 필터 — RSS+이벤트가 이미 BUY_THRESHOLD 이상으로 걸러낸 소수 후보만,
    // GPT-4o-mini로 "노이즈/거짓신호인지" 검증 (딥리서치 근거: 1분 황금구간은 지연시간 리스크로 제외)
    if (decision.intervalMin > 1) {
      const eligible = results.filter((r) => (enhanced.get(r.stock_code)?.finalScore ?? r.composite_score) >= BUY_THRESHOLD);
      if (eligible.length > 0) {
        try {
          const validated = await filterCandidatesWithLLM(eligible);
          for (const v of validated) {
            const orig = results.find((r) => r.stock_code === v.stock_code);
            if (!orig) continue;
            orig.reasoning = v.reasoning;
            if (v.composite_score !== orig.composite_score) {
              const enh = enhanced.get(v.stock_code);
              if (enh) enh.finalScore = v.composite_score;
              else orig.composite_score = v.composite_score;
              orig.signal = v.signal;
            }
          }
        } catch (e) {
          logger.warn(`LLM 신호 검증 필터 실패 (원본 유지): ${e}`, { component: COMP });
        }
      }
    }

    // 🔎 워치리스트 전멸 감지 — 현재 후보 전원이 매수권(BUY_THRESHOLD) 미달이면
    // 30분 주기를 기다리지 않고 즉시 급등/뉴스/테마 감지기를 돌려 다른 방향 종목을 흡수
    if (results.length > 0) {
      const bestScore = Math.max(...results.map((r) => enhanced.get(r.stock_code)?.finalScore ?? r.composite_score));
      const COOLDOWN_MS = 15 * 60_000;
      if (bestScore < BUY_THRESHOLD && Date.now() - _lastOnDemandSurgeAt > COOLDOWN_MS) {
        _lastOnDemandSurgeAt = Date.now();
        logger.info(
          `📉 워치리스트 ${results.length}종목 전원 매수권 미달 (최고 ${bestScore.toFixed(0)}점) → 급등/뉴스/테마 즉시 재탐색`,
          { component: COMP },
        );
        import('../../automation/surge-detector.js')
          .then((m) => m.runSurgeDetector())
          .catch((e) => logger.warn(`즉시 재탐색 실패: ${e}`, { component: COMP }));
      }
    }

    // ai_scores UPSERT + history INSERT (시계열 추적)
    // v17: 앙상블 점수 덮어쓰기 방지 — Gemini 앙상블 결과가 있으면 RSS만으로 덮어쓰지 않음
    const existingScoresMap = new Map<string, { composite_score: number; hasEnsemble: boolean }>();
    try {
      const { rows: existingRows } = await getPool().query(
        `SELECT stock_code, composite_score, gemini_summary IS NOT NULL AS has_ensemble
         FROM ai_scores WHERE score_date = $1 AND stock_code = ANY($2)`,
        [new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10), codes],
      );
      for (const row of existingRows) {
        existingScoresMap.set(String(row.stock_code), {
          composite_score: Number(row.composite_score),
          hasEnsemble: row.has_ensemble === true,
        });
      }
    } catch { /* 조회 실패 시 보호 없이 진행 */ }

    let scored = 0;
    let errors = 0;
    const today = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10); // KST
    for (const r of results) {
      const enh = enhanced.get(r.stock_code);
      const finalScore = enh ? enh.finalScore : r.composite_score;

      // v19: 핵심엔진(RSS+NLP) 우선 — 앙상블 보호 게이트 제거.
      // 이전엔 Gemini 앙상블 점수와 15점+ 차이 나야만 갱신 허용했으나, 그러면 실시간성이
      // 생명인 눌림목/모멘텀/거래량/버즈 신호가 하루 3-4회 도는 앙상블에 항상 밀림.
      // CEO 방침: RSS+NLP 코어엔진이 핵심, 앙상블은 보조 — 매 사이클 갱신을 그대로 반영한다.
      const existing = existingScoresMap.get(r.stock_code);
      if (existing?.hasEnsemble) {
        const delta = Math.abs(finalScore - existing.composite_score);
        if (delta >= 15) {
          logger.info(`⚡ ${r.stock_code}: 앙상블 대비 큰 폭 갱신 (Δ${delta.toFixed(0)}점)`, { component: COMP });
        }
      }

      try {
        await upsertAIScore({
          stock_code: r.stock_code,
          score_date: today,
          gemini_summary: null,
          composite_score: finalScore,
          fundamental_score: r.fundamental_score ?? 0,
          technical_score: r.technical_score ?? 0,
          sentiment_score: r.sentiment_score ?? 0,
          confidence: r.confidence ?? 0.5,
          reasoning:
            r.reasoning ??
            (enh && enh.delta !== 0
              ? `Quick Re-Score + Enhanced (Δ${enh.delta >= 0 ? '+' : ''}${enh.delta}: ${enh.breakdown.map((b) => b.source).join(',')})`
              : 'Quick Re-Score (RSS)'),
          signal: r.signal ?? 'HOLD',
          target_price: r.target_price ?? null,
          stop_loss_price: r.stop_loss_price ?? null,
        });

        // 시계열 적재 (UI 그래프용)
        try {
          const { rows: prev } = await getPool().query(
            `SELECT composite_score FROM ai_scores_history
             WHERE stock_code = $1 ORDER BY recorded_at DESC LIMIT 1`,
            [r.stock_code],
          );
          const prevScore = prev[0]?.composite_score != null ? Number(prev[0].composite_score) : null;
          const delta = prevScore != null ? finalScore - prevScore : null;
          await getPool().query(
            `INSERT INTO ai_scores_history
               (stock_code, composite_score, technical_score, sentiment_score, source, delta_from_prev)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [r.stock_code, finalScore, r.technical_score ?? 0, r.sentiment_score ?? 0, 'quick_enhanced', delta],
          );
        } catch {
          /* history 테이블 미생성 시 무시 */
        }
        scored++;
      } catch (e) {
        errors++;
        logger.debug(`${r.stock_code} ai_scores upsert 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
      }
    }

    // Redis 캐시 갱신 — 대시보드가 Redis 우선 조회하므로 DB만 갱신하면 점수 고정됨
    const cacheItems = results.map((r) => {
      const enh = enhanced.get(r.stock_code);
      const finalScore = enh ? enh.finalScore : r.composite_score;
      return {
        stock_code: r.stock_code,
        score_date: today,
        composite_score: finalScore,
        fundamental_score: r.fundamental_score ?? 0,
        technical_score: r.technical_score ?? 0,
        sentiment_score: r.sentiment_score ?? 0,
        confidence: r.confidence ?? 0.5,
        reasoning: r.reasoning ?? 'Quick Re-Score (RSS)',
        signal: (r.signal ?? 'HOLD') as string,
        target_price: r.target_price ?? null,
        stop_loss_price: r.stop_loss_price ?? null,
        gemini_summary: null,
        id: '0',
        created_at: new Date().toISOString(),
      };
    });
    await cacheScores(cacheItems).catch((e) =>
      logger.warn(`Quick Re-Score Redis 캐시 갱신 실패: ${e}`, { component: COMP }),
    );

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`⚡ Quick Re-Score 완료: ${scored}건 갱신, ${errors}건 에러 (${elapsed}초)`, { component: COMP });
    // 마지막 실행 시각 system_state에 기록
    try {
      await getPool().query(
        `INSERT INTO system_state (key, value, updated_at) VALUES ('quick_rescore_last_run', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [
          JSON.stringify({ at: new Date().toISOString(), scored, errors, elapsedSec: Number(elapsed) }),
        ],
      );
    } catch {
      /* 기록 실패 무시 */
    }
    return { scored, errors };
  } catch (e) {
    logger.error(`Quick Re-Score 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
    return { scored: 0, errors: -1 };
  }
}
