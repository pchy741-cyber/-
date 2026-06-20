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

import { getActiveWatchlist, getPool, upsertAIScore } from '../../db/client.js';
import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { runRSSScoring } from './rss-scorer.js';

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
  BULLISH: 5, // 강세장: 5분 (매우 타이트, 모멘텀 놓치지 않음)
  NEUTRAL: 10, // 평상: 10분
  BEARISH: 20, // 약세: 20분 (매매 적으니 빈도 낮춤)
  PANIC: 60, // 패닉: 1시간 (거의 매매 안 함)
};

let _lastRunAt = 0;
let _lastRegime = 'NEUTRAL';

async function getCurrentRegime(): Promise<string> {
  try {
    const { getPool } = await import('../../db/client.js');
    const { rows } = await getPool().query(
      `SELECT mode FROM strategy_config WHERE is_active = true ORDER BY id DESC LIMIT 1`,
    );
    const mode = String(rows[0]?.mode ?? 'SWING');
    // mode → regime 매핑
    if (mode === 'SCALPING') return 'BULLISH';
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
  // 마의시간 → 15분
  // 그 외 → 장세별 5-60분
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const t = kstH * 100 + kstM;
  const inGolden = (t >= 930 && t < 1020) || (t >= 1300 && t < 1500);
  const inCursed = t >= 1020 && t < 1300;
  const intervalMin = inGolden ? 1 : inCursed ? 15 : (MIN_INTERVAL_MIN[regime] ?? 10);

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
    const codes = fullWatchlist.slice(0, maxStocks).map((w) => w.stock_code);
    logger.info(`⚡ Quick Re-Score 시작: ${codes.length}종목 (RSS only, paid AI 0)`, { component: COMP });

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

    const watchlistForRss = fullWatchlist.slice(0, MAX_STOCKS).map((w) => ({
      stock_code: w.stock_code,
      stock_name: w.stock_name ?? w.stock_code,
    }));

    const results = await runRSSScoring('SWING', watchlistForRss, chartData, emptySet, emptySet, emptyMap);

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

    // ai_scores UPSERT + history INSERT (시계열 추적)
    let scored = 0;
    let errors = 0;
    const today = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10); // KST
    for (const r of results) {
      const enh = enhanced.get(r.stock_code);
      const finalScore = enh ? enh.finalScore : r.composite_score;
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
