/**
 * ⚡ Event-Driven 즉시 재스코어링
 *
 * CEO 지시 (2026-06-12): "반응 더 좋게"
 *
 * 트리거:
 *  - 거래량 spike 3x+ : 큰 매수/매도 발생
 *  - 갭업 +2%+ / 갭다운 -2%+ : 큰 변동
 *  - 거래정지 해제 직후
 *  - 호가창 매수 잔량 급증
 *
 * 동작:
 *  - 매 30초 폴링 (Cloud Run 추가 비용 미미)
 *  - 감지 시 해당 종목만 즉시 RSS 재스코어링
 *  - ai_scores_history에 source='event_triggered' 적재
 *  - Telegram 알림 (3x+ 거래량 spike만)
 *
 * 평균 호출 = 0.3건/30초 = 14건/시간 (KIS rate limit 여유)
 */

import { runRSSScoring } from './rss-scorer.js';
import { enhanceScore } from '../score-enhancer.js';
import { getActiveWatchlist, getPool, upsertAIScore } from '../../db/client.js';
import { getBatchPrices, getDailyChart } from '../../kis/market.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';

const COMP = 'EVENT_RESCORE';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // KST = UTC+9 in ms
const SNAPSHOT_STALE_MS = 5 * 60_000; // 5분 이상 이전 스냅샷은 무시
const VOLUME_SPIKE_THRESHOLD = 2.0; // 거래량 변화 배율 기준
const MIN_VOLUME_FOR_SPIKE = 100_000; // 거래량 spike 최소 절대량
const PRICE_CHANGE_THRESHOLD_PCT = 1.0; // 30초 내 가격 변동 기준 (%)
const VOLUME_SPIKE_ALERT_THRESHOLD = 3.0; // 텔레그램 알림 기준 배율
const MAX_WATCHLIST_POLL = 30; // 이벤트 감지 시 최대 종목 수
const MIN_CHART_CANDLES = 20; // 재스코어링 최소 캔들 수
const RESCORE_CHUNK_SIZE = 5; // 동시 재스코어 최대 병렬 수

// 직전 가격/거래량 캐시 (변화 감지용)
const _lastSnapshot = new Map<string, { price: number; volume: number; ts: number }>();
// 종목별 마지막 트리거 시각 (중복 트리거 방지)
const _lastTrigger = new Map<string, number>();
const TRIGGER_COOLDOWN_MS = 5 * 60_000; // 5분 내 재트리거 차단

interface DetectedEvent {
  stockCode: string;
  type: 'VOLUME_SPIKE' | 'GAP_UP' | 'GAP_DOWN';
  magnitude: number;
  reason: string;
}

/** 거래량/가격 급변 감지 — 매 30초 호출 */
async function detectEvents(): Promise<DetectedEvent[]> {
  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) return [];
  const codes = watchlist.slice(0, MAX_WATCHLIST_POLL).map((w) => w.stock_code);

  try {
    const batchPrices = await getBatchPrices(codes);
    const events: DetectedEvent[] = [];
    const now = Date.now();

    for (const [code, quote] of batchPrices) {
      const price = quote.currentPrice ?? 0;
      const volume = quote.volume ?? 0;
      if (!Number.isFinite(price) || price <= 0) continue;

      const prev = _lastSnapshot.get(code);
      _lastSnapshot.set(code, { price, volume, ts: now });

      if (!prev || now - prev.ts > SNAPSHOT_STALE_MS) continue; // 5분+ 갭은 신선치 X

      // 트리거 쿨다운 체크
      const lastTrig = _lastTrigger.get(code) ?? 0;
      if (now - lastTrig < TRIGGER_COOLDOWN_MS) continue;

      // 1) 거래량 spike — 30초 구간 증분 vs 평균 증분 비교
      // v17 fix: volume은 누적 일거래량 → 비율(volume/prev.volume)은 항상 ~1.0x
      // 증분 기반: (현재-이전) / 기대 증분 = 실제 스파이크 배율
      const volumeIncrement = volume - prev.volume;
      if (volumeIncrement > 0 && prev.volume > 0) {
        const elapsedSec = Math.max(10, (now - prev.ts) / 1000);
        // KST 기준 장 시작(09:00) 이후 경과 시간으로 평균 증분율 계산
        const kstNow = new Date(now);
        const kstH = (kstNow.getUTCHours() + 9) % 24;
        const kstM = kstNow.getUTCMinutes();
        const minutesSinceOpen = Math.max(1, (kstH - 9) * 60 + kstM);
        const avgVolumePerSec = prev.volume / (minutesSinceOpen * 60);
        const expectedIncrement = avgVolumePerSec * elapsedSec;
        const spikeRatio = expectedIncrement > 0 ? volumeIncrement / expectedIncrement : 1;

        if (spikeRatio >= VOLUME_SPIKE_THRESHOLD && volume > MIN_VOLUME_FOR_SPIKE) {
          events.push({
            stockCode: code,
            type: 'VOLUME_SPIKE',
            magnitude: spikeRatio,
            reason: `거래량 증분 ${spikeRatio.toFixed(1)}x spike (Δ${volumeIncrement.toLocaleString()} / 기대${Math.round(expectedIncrement).toLocaleString()})`,
          });
          _lastTrigger.set(code, now);
          continue;
        }
      }

      // 2) 갭업/갭다운 — 30초 사이 ±1% 이상 변동
      const priceChangePct = prev.price > 0 ? ((price - prev.price) / prev.price) * 100 : 0; // division-by-zero guard
      if (Math.abs(priceChangePct) >= PRICE_CHANGE_THRESHOLD_PCT) {
        events.push({
          stockCode: code,
          type: priceChangePct > 0 ? 'GAP_UP' : 'GAP_DOWN',
          magnitude: Math.abs(priceChangePct),
          reason: `${priceChangePct >= 0 ? '갭업' : '갭다운'} ${priceChangePct.toFixed(2)}% (30초)`,
        });
        _lastTrigger.set(code, now);
      }
    }
    return events;
  } catch (e) {
    logger.debug(`이벤트 감지 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
    return [];
  }
}

/** 감지된 이벤트 종목 즉시 재스코어링 */
async function rescoreEventStock(event: DetectedEvent): Promise<void> {
  try {
    const watchlist = await getActiveWatchlist();
    const w = watchlist.find((x) => x.stock_code === event.stockCode);
    if (!w) return;

    const chart = await getDailyChart(event.stockCode, 60);
    if (!chart || chart.length < MIN_CHART_CANDLES) return;

    const chartData = new Map<string, typeof chart>();
    chartData.set(event.stockCode, chart);
    const watchlistForRss = [{ stock_code: event.stockCode, stock_name: w.stock_name ?? event.stockCode }];
    const results = await runRSSScoring(
      'SWING',
      watchlistForRss,
      chartData,
      new Set(),
      new Set(),
      new Map(),
    );

    if (results.length === 0) return;
    const r = results[0];

    // Score Enhancer 적용 (이벤트 자체가 거래량 spike 시 가산)
    const enhanced = await enhanceScore(r.composite_score, {
      stockCode: event.stockCode,
      volumeRatio: event.type === 'VOLUME_SPIKE' ? event.magnitude : undefined,
      changePct: event.type === 'GAP_UP' ? event.magnitude : event.type === 'GAP_DOWN' ? -event.magnitude : undefined,
    });

    const today = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
    await upsertAIScore({
      stock_code: r.stock_code,
      score_date: today,
      gemini_summary: null,
      composite_score: enhanced.finalScore,
      fundamental_score: r.fundamental_score ?? 0,
      technical_score: r.technical_score ?? 0,
      sentiment_score: r.sentiment_score ?? 0,
      confidence: r.confidence ?? 0.5,
      reasoning: `[EVENT: ${event.type}] ${event.reason} | enhanced Δ${enhanced.delta >= 0 ? '+' : ''}${enhanced.delta}`,
      signal: r.signal ?? 'HOLD',
      target_price: r.target_price ?? null,
      stop_loss_price: r.stop_loss_price ?? null,
    });

    // 시계열 적재
    try {
      const { rows: prev } = await getPool().query(
        `SELECT composite_score FROM ai_scores_history WHERE stock_code = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [r.stock_code],
      );
      const prevScore = prev[0]?.composite_score != null ? Number(prev[0].composite_score) : null;
      const delta = prevScore != null ? enhanced.finalScore - prevScore : null;
      await getPool().query(
        `INSERT INTO ai_scores_history (stock_code, composite_score, technical_score, sentiment_score, source, delta_from_prev)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.stock_code, enhanced.finalScore, r.technical_score ?? 0, r.sentiment_score ?? 0, `event_${event.type.toLowerCase()}`, delta],
      );
    } catch {
      /* ignore */
    }

    logger.info(`⚡ 이벤트 재스코어 ${event.stockCode}: ${event.reason} → ${enhanced.finalScore.toFixed(0)}점`, {
      component: COMP,
    });

    // 거래량 3x+ 큰 이벤트만 텔레그램 알림
    if (event.type === 'VOLUME_SPIKE' && event.magnitude >= VOLUME_SPIKE_ALERT_THRESHOLD) {
      sendTelegramMessage(
        `⚡ *거래량 폭발 감지* ${event.stockCode}\n${event.reason}\n점수: ${enhanced.finalScore.toFixed(0)}점${
          enhanced.delta !== 0 ? ` (Δ${enhanced.delta >= 0 ? '+' : ''}${enhanced.delta})` : ''
        }`,
      ).catch(() => {});
    }
  } catch (e) {
    logger.debug(`${event.stockCode} 이벤트 재스코어 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
  }
}

/** 매 30초 호출 — 이벤트 감지 + 재스코어 */
export async function runEventRescore(): Promise<void> {
  try {
    const events = await detectEvents();
    if (events.length === 0) return;
    logger.info(`⚡ 이벤트 ${events.length}건 감지`, { component: COMP });

    // 동시 호출 제한 — 5개씩 순차 (KIS rate limit 보호)
    for (let i = 0; i < events.length; i += RESCORE_CHUNK_SIZE) {
      const chunk = events.slice(i, i + RESCORE_CHUNK_SIZE);
      await Promise.allSettled(chunk.map((e) => rescoreEventStock(e)));
      if (i + RESCORE_CHUNK_SIZE < events.length) await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    logger.warn(`이벤트 재스코어 사이클 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
  }
}
