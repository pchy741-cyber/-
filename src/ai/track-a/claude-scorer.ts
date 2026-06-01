/**
 * Claude Track A 폴백 스코러
 * Gemini 할당량 초과 시 Anthropic Claude로 종목 분석 + 스코어 생성
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DailyCandle } from '../../kis/market.js';
import type { ScoringResult } from '../../db/models.js';
import { logger } from '../../utils/logger.js';

const COMP = 'TRACK_A_CLAUDE';
const MODEL = 'claude-haiku-4-5-20251001'; // 저렴 + 빠름 (스코어링 전용)
const BATCH_SIZE = 30; // 한 번에 30종목 분석

interface WatchlistItem { stock_code: string; stock_name: string; }

export async function runClaudeScoring(
  mode: string,
  watchlist: WatchlistItem[],
  chartData: Map<string, DailyCandle[]>,
): Promise<ScoringResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 미설정');

  const client = new Anthropic({ apiKey });

  const results: ScoringResult[] = [];

  // 배치로 나눠서 분석
  for (let i = 0; i < watchlist.length; i += BATCH_SIZE) {
    const batch = watchlist.slice(i, i + BATCH_SIZE);

    // 차트 데이터 요약 (토큰 절약)
    const stockSummaries = batch.map(w => {
      const candles = chartData.get(w.stock_code) ?? [];
      if (candles.length < 5) return `${w.stock_code}(${w.stock_name}): 데이터부족`;
      const recent = candles.slice(-10);
      const prices = recent.map(c => c.close);
      const latest = prices[prices.length - 1];
      const prev5 = prices[0];
      const change5d = ((latest - prev5) / prev5 * 100).toFixed(1);
      const volumes = recent.map(c => c.volume);
      const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
      const volRatio = avgVol > 0 ? (volumes[volumes.length - 1] / avgVol).toFixed(1) : '?';
      return `${w.stock_code}(${w.stock_name}): 현재가${latest.toLocaleString()} 5일변동${change5d}% 거래량비율${volRatio}x`;
    }).join('\n');

    const systemPrompt = `당신은 한국 주식 퀀트 분석가입니다. ${mode} 전략으로 종목별 매수 점수(0-100)와 신호를 JSON으로 반환하세요.`;
    const userPrompt = `다음 ${batch.length}개 종목을 분석해 JSON 배열로 반환하세요. 각 항목: {"stock_code":"코드","composite_score":숫자,"signal":"BUY|HOLD|SELL","confidence":0.0-1.0,"reasoning":"간단한 이유"}

점수 기준: 80+ 강매수, 70-79 매수, 50-69 보유, 50미만 매도
기술적 지표(차트 추세, 거래량), ${mode} 전략 적합성 고려

종목 데이터:
${stockSummaries}

JSON 배열만 반환 (설명 없이):`;

    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        stock_code: string; composite_score: number;
        signal: string; confidence: number; reasoning: string;
      }>;

      for (const item of parsed) {
        const wItem = batch.find(w => w.stock_code === item.stock_code);
        if (!wItem) continue;
        const score = Math.max(0, Math.min(100, Math.round(item.composite_score)));
        results.push({
          stock_code: item.stock_code,
          composite_score: score,
          fundamental_score: score,
          technical_score: score,
          sentiment_score: score,
          signal: (['BUY','SELL','HOLD','STRONG_BUY','STRONG_SELL','NO_DATA'].includes(item.signal) ? item.signal : 'HOLD') as any,
          confidence: Math.max(0, Math.min(1, item.confidence ?? 0.6)),
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
