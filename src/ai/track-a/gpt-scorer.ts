/**
 * GPT-4o Track A 스코어러
 * 앙상블 모드에서 병렬 실행되는 독립 스코어러
 * OPENAI_API_KEY 미설정 시 자동 스킵 (에러 아님)
 */
import OpenAI from 'openai';
import type { ScoringResult } from '../../db/models.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildScoringPrompt, type RegimeHint } from '../prompts/track-a-scoring.js';

const COMP = 'TRACK_A_GPT';
const MODEL = 'gpt-4o-mini'; // 비용 최적화: o3 대비 10배 저렴, 스코어링 충분
const BATCH_SIZE = 30; // gpt-4o-mini는 저렴하므로 배치 크기 확대 (API 호출 횟수 절감)
const API_TIMEOUT_MS = 60_000; // OpenAI API 타임아웃 (60초)
const MAX_SOURCES_CHARS = 4000; // additionalSources 최대 문자 수
const MIN_CANDLES_FOR_ANALYSIS = 5;
const RSI_PERIOD = 14;
const RSI_LOOKBACK = RSI_PERIOD + 1; // 15일치 종가 필요
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const DEFAULT_SCORE = 50;
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;
const DEFAULT_CONFIDENCE = 0.6;
const SMA_PERIOD = 20;
const PULLBACK_UPPER_THRESHOLD = 1.04; // SMA 대비 최근 고점 비율
const PULLBACK_LOWER_BAND = 0.98; // SMA 대비 현재가 하한
const PULLBACK_UPPER_BAND = 1.02; // SMA 대비 현재가 상한

interface WatchlistItem {
  stock_code: string;
  stock_name: string;
}

/** RSI-14 근사 계산 (Wilder 평활 — 캔들 배열은 최신순 [0]=오늘) */
function calcRSI14(candles: DailyCandle[]): number | null {
  if (candles.length < RSI_LOOKBACK) return null;
  const closes = candles.slice(0, RSI_LOOKBACK).map((c) => c.close).reverse(); // 오래된 순으로
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < RSI_LOOKBACK; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= RSI_PERIOD;
  avgLoss /= RSI_PERIOD;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - 100 / (1 + rs));
}

/** 차트 데이터를 토큰 절약형 텍스트로 변환 — SMA20·눌림목·RSI14 포함 */
function buildChartSummary(batch: WatchlistItem[], chartData: Map<string, DailyCandle[]>): string {
  return batch
    .map((w) => {
      const candles = chartData.get(w.stock_code) ?? [];
      if (candles.length < MIN_CANDLES_FOR_ANALYSIS) return `${w.stock_code}(${w.stock_name}): 데이터부족`;
      const recent = candles.slice(0, 10); // 최근 10일 (candles[0] = 최신)
      const latest = recent[0];
      const prev5 = recent[Math.min(4, recent.length - 1)];
      const change5d = prev5.close > 0 ? (((latest.close - prev5.close) / prev5.close) * 100).toFixed(1) : '?';
      const avgVol = recent.slice(1).reduce((a, c) => a + c.volume, 0) / Math.max(1, recent.length - 1);
      const volRatio = avgVol > 0 ? (latest.volume / avgVol).toFixed(1) : '?';
      const high = Math.max(...candles.slice(0, 30).map((c) => c.high));
      const dropPct = high > 0 ? (((latest.close - high) / high) * 100).toFixed(1) : '?';

      // SMA20 + 눌림목 (Track B와 동일 로직)
      const sma20Candles = candles.slice(0, SMA_PERIOD);
      const sma20 = sma20Candles.length >= SMA_PERIOD
        ? Math.round(sma20Candles.reduce((a, c) => a + c.close, 0) / SMA_PERIOD)
        : 0;
      const recentHigh5 = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map((c) => c.high)) : 0;
      const pullback =
        sma20 > 0 &&
        recentHigh5 > sma20 * PULLBACK_UPPER_THRESHOLD &&
        latest.close >= sma20 * PULLBACK_LOWER_BAND &&
        latest.close <= sma20 * PULLBACK_UPPER_BAND;

      // RSI-14
      const rsi = calcRSI14(candles);

      const techStr = [
        sma20 > 0 ? `SMA20=${sma20.toLocaleString()}` : '',
        pullback ? '눌림목=true' : sma20 > 0 ? '눌림목=false' : '',
        rsi !== null ? `RSI=${rsi}` : '',
      ].filter(Boolean).join(' ');

      return `${w.stock_code}(${w.stock_name}): 현재가${latest.close.toLocaleString()} 5일${change5d}% 고점대비${dropPct}% 거래량${volRatio}x${techStr ? ' ' + techStr : ''} 5일종가:${recent
        .slice(0, 5)
        .map((c) => c.close)
        .join(',')}`;
    })
    .join('\n');
}

export async function runGPTScoring(
  mode: string,
  watchlist: WatchlistItem[],
  chartData: Map<string, DailyCandle[]>,
  regimeHint?: RegimeHint,
  customPrompt?: string,
  additionalSources?: string,
): Promise<ScoringResult[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.info('GPT 스코어러 스킵: OPENAI_API_KEY 미설정', { component: COMP });
    return [];
  }

  const client = new OpenAI({ apiKey, timeout: API_TIMEOUT_MS });
  const basePrompt = buildScoringPrompt(mode, regimeHint);
  const systemPrompt = customPrompt ? `${basePrompt}\n\n## CEO 추가 지시사항\n${customPrompt}` : basePrompt;
  const results: ScoringResult[] = [];

  for (let i = 0; i < watchlist.length; i += BATCH_SIZE) {
    const batch = watchlist.slice(i, i + BATCH_SIZE);
    const chartSummary = buildChartSummary(batch, chartData);

    const sourcesBlock = additionalSources
      ? `\n\n## 시장 인텔리전스 (뉴스·공시·매크로·감성)\n${additionalSources.slice(0, MAX_SOURCES_CHARS)}`
      : '';

    const userMessage = `## 차트 데이터 (${batch.length}개 종목, 모드: ${mode})
${chartSummary}${sourcesBlock}

위 데이터와 시장 인텔리전스를 종합해 각 종목의 점수를 산출해주세요. 뉴스 감성(Groq), 공시(KRX), 거시경제 방향, 커뮤니티 신호를 sentiment_score에 반영하세요.`;

    try {
      const res = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0.3, // 일관된 스코어링 위해 낮은 temperature
        response_format: { type: 'json_object' }, // GPT에게 pure JSON 강제 (코드블록/전문 텍스트 방지)
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });

      const text = res.choices[0]?.message?.content ?? '';
      if (!text) {
        logger.warn(`GPT 배치 ${i + 1} 빈 응답`, { component: COMP });
        continue;
      }

      let parsed: { scores: Array<Record<string, unknown>> };
      try {
        parsed = JSON.parse(text) as { scores: Array<Record<string, unknown>> };
      } catch {
        // response_format 강제에도 파싱 실패 시 정규식 폴백
        const jsonMatch = text.match(/\{[\s\S]*"scores"\s*:\s*\[[\s\S]*\]\s*\}/);
        if (!jsonMatch) {
          logger.warn(`GPT 배치 ${i + 1} JSON 파싱 실패`, { component: COMP, rawPreview: text.slice(0, 200) });
          continue;
        }
        parsed = JSON.parse(jsonMatch[0]) as { scores: Array<Record<string, unknown>> };
      }
      if (!Array.isArray(parsed.scores)) {
        logger.warn(`GPT 배치 ${i + 1} scores 배열 없음`, { component: COMP });
        continue;
      }
      for (const item of parsed.scores) {
        const code = String(item.stock_code ?? '');
        if (!batch.some((w) => w.stock_code === code)) continue;
        const signal = String(item.signal ?? 'HOLD');
        const validSignals = ['BUY', 'SELL', 'HOLD', 'STRONG_BUY', 'STRONG_SELL', 'NO_DATA'];
        if (signal === 'NO_DATA') continue;

        // NaN/Invalid score guard: non-numeric AI responses produce NaN
        const rawComposite = Number(item.composite_score ?? DEFAULT_SCORE);
        if (!Number.isFinite(rawComposite)) {
          logger.warn(`GPT 비정상 스코어 스킵: ${code} composite_score=${item.composite_score}`, { component: COMP });
          continue;
        }

        const safeNum = (val: unknown, fallback: number): number => {
          const n = Number(val ?? fallback);
          return Number.isFinite(n) ? n : fallback;
        };

        const clampScore = (v: number) => Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(v)));

        results.push({
          stock_code: code,
          composite_score: clampScore(rawComposite),
          fundamental_score: clampScore(safeNum(item.fundamental_score, DEFAULT_SCORE)),
          technical_score: clampScore(safeNum(item.technical_score, DEFAULT_SCORE)),
          sentiment_score: clampScore(safeNum(item.sentiment_score, DEFAULT_SCORE)),
          signal: (validSignals.includes(signal) ? signal : 'HOLD') as ScoringResult['signal'],
          confidence: Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, safeNum(item.confidence, DEFAULT_CONFIDENCE))),
          reasoning: `[GPT] ${String(item.reasoning ?? '').slice(0, 200)}`,
          target_price: item.target_price != null && Number.isFinite(Number(item.target_price)) ? Number(item.target_price) : undefined,
          stop_loss_price: item.stop_loss_price != null && Number.isFinite(Number(item.stop_loss_price)) ? Number(item.stop_loss_price) : undefined,
        });
      }

      logger.info(`GPT 배치 ${Math.floor(i / BATCH_SIZE) + 1}: ${parsed.scores.length}개 스코어`, { component: COMP });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`GPT 배치 ${Math.floor(i / BATCH_SIZE) + 1} 실패: ${msg.slice(0, 150)}`, { component: COMP });
    }
  }

  logger.info(`GPT Track A 완료: ${results.length}개 스코어`, { component: COMP });
  return results;
}
