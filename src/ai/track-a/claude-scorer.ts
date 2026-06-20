/**
 * Claude Track A 폴백 스코러
 * Gemini 할당량 초과 시 Anthropic Claude로 종목 분석 + 스코어 생성
 */
import Anthropic from '@anthropic-ai/sdk';
import { callClaudeCli, isClaudeCliEnabled } from '../../utils/claude-cli.js';
import type { ScoringResult } from '../../db/models.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

const COMP = 'TRACK_A_CLAUDE';
const MODEL = 'claude-haiku-4-5-20251001'; // 저렴 + 빠름 (2차 검증 + 폴백)
const BATCH_SIZE = 30; // 한 번에 30종목 분석
const MAX_SOURCES_CHARS = 3000; // additionalSources 최대 문자 수 (토큰 절약)
const MAX_TOKENS = 2000;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;
const DEFAULT_CONFIDENCE = 0.6;
const MIN_CANDLES_FOR_ANALYSIS = 5;
const VALID_SIGNALS = ['BUY', 'SELL', 'HOLD', 'STRONG_BUY', 'STRONG_SELL', 'NO_DATA'] as const;
type ValidSignal = (typeof VALID_SIGNALS)[number];

interface WatchlistItem {
  stock_code: string;
  stock_name: string;
}

export async function runClaudeScoring(
  mode: string,
  watchlist: WatchlistItem[],
  chartData: Map<string, DailyCandle[]>,
  additionalSources?: string,
): Promise<ScoringResult[]> {
  const useCli = isClaudeCliEnabled();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!useCli && !apiKey) throw new Error('ANTHROPIC_API_KEY 미설정 & CLI 비활성');

  const client = useCli ? null : new Anthropic({ apiKey: apiKey! });

  const results: ScoringResult[] = [];

  // 배치로 나눠서 분석
  for (let i = 0; i < watchlist.length; i += BATCH_SIZE) {
    const batch = watchlist.slice(i, i + BATCH_SIZE);

    // 차트 데이터 요약 (토큰 절약)
    const stockSummaries = batch
      .map((w) => {
        const candles = chartData.get(w.stock_code) ?? [];
        if (candles.length < MIN_CANDLES_FOR_ANALYSIS) return `${w.stock_code}(${w.stock_name}): 데이터부족`;
        const recent = candles.slice(0, 10); // descending: index 0 = newest
        const latest = recent[0].close;
        const prev5 = recent[Math.min(4, recent.length - 1)].close;
        const change5d = prev5 > 0 ? (((latest - prev5) / prev5) * 100).toFixed(1) : '?';
        const volumes = recent.map((c) => c.volume);
        const avgVol = volumes.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
        const volRatio = avgVol > 0 ? (volumes[0] / avgVol).toFixed(1) : '?';
        return `${w.stock_code}(${w.stock_name}): 현재가${latest.toLocaleString()} 5일변동${change5d}% 거래량비율${volRatio}x`;
      })
      .join('\n');

    const sourcesBlock = additionalSources
      ? `\n\n## 시장 인텔리전스 (뉴스·공시·매크로·감성)\n${additionalSources.slice(0, MAX_SOURCES_CHARS)}`
      : '';

    const systemPrompt = `당신은 한국 주식 퀀트 분석가입니다. ${mode} 전략으로 종목별 매수 점수(0-100)와 신호를 JSON으로 반환하세요.`;
    const userPrompt = `다음 ${batch.length}개 종목을 분석해 JSON 배열로 반환하세요. 각 항목: {"stock_code":"코드","composite_score":숫자,"signal":"BUY|HOLD|SELL","confidence":0.0-1.0,"reasoning":"간단한 이유"}

점수 기준: 80+ 강매수, 70-79 매수, 50-69 보유, 50미만 매도
기술적 지표(차트 추세, 거래량), ${mode} 전략 적합성 고려. 시장 인텔리전스가 있으면 sentiment_score에 반영하세요.

종목 데이터:
${stockSummaries}${sourcesBlock}

JSON 배열만 반환 (설명 없이):`;

    try {
      let text: string;

      if (useCli) {
        text = await callClaudeCli({ systemPrompt, userPrompt });
      } else {
        const msg = await client!.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        text = msg.content[0].type === 'text' ? msg.content[0].text : '';
      }
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        stock_code: string;
        composite_score: number;
        signal: string;
        confidence: number;
        reasoning: string;
      }>;

      for (const item of parsed) {
        const wItem = batch.find((w) => w.stock_code === item.stock_code);
        if (!wItem) continue;
        const rawScore = Number(item.composite_score);
        if (!Number.isFinite(rawScore)) continue; // NaN/Infinity guard
        const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(rawScore)));
        const rawConfidence = Number(item.confidence ?? DEFAULT_CONFIDENCE);
        results.push({
          stock_code: item.stock_code,
          composite_score: score,
          fundamental_score: score,
          technical_score: score,
          sentiment_score: score,
          signal: (VALID_SIGNALS as readonly string[]).includes(item.signal)
            ? (item.signal as ValidSignal)
            : 'HOLD',
          confidence: Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, Number.isFinite(rawConfidence) ? rawConfidence : DEFAULT_CONFIDENCE)),
          reasoning: `[Claude] ${item.reasoning || ''}`,
        });
      }

      logger.info(`Claude 스코어링 배치 ${i + 1}~${i + batch.length}: ${parsed.length}개 완료`, { component: COMP });
    } catch (e) {
      logger.warn(`Claude 배치 ${i + 1} 실패: ${e}`, { component: COMP });
    }
  }

  logger.info(`Claude Track A 완료: ${results.length}개 스코어 생성`, { component: COMP });
  return results;
}
