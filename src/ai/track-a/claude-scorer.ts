/**
 * Claude Track A 스코러 (v2 — Max 구독 풀파워)
 * USE_CLAUDE_CLI=true → claude -p (Sonnet) 모델로 정밀 스코어링
 * API 키 모드 → Haiku (비용 최적화)
 */
import Anthropic from '@anthropic-ai/sdk';
import { callClaudeCli, isClaudeCliEnabled } from '../../utils/claude-cli.js';
import type { ScoringResult } from '../../db/models.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { logTokenUsage, calcClaudeApiCost, calcClaudeCliCost } from '../../utils/ai-token-logger.js';

const COMP = 'TRACK_A_CLAUDE';
const MODEL_API = 'claude-haiku-4-5-20251001'; // API 키 모드: 비용 최적화
const BATCH_SIZE = 30;
const MAX_SOURCES_CHARS = 6000; // CLI 모드: 토큰 여유 → 더 많은 컨텍스트
const MAX_TOKENS = 4000;
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

    const isCliMode = useCli;
    const systemPrompt = isCliMode
      ? `당신은 한국 주식 전문 퀀트 분석가입니다. ${mode} 전략 기반으로 종합 점수를 산출합니다.

분석 프레임워크:
1. 기술적 분석 (40%): 이동평균 배열, 거래량 추세, 가격 모멘텀, 지지/저항
2. 펀더멘털 (20%): 업종 전망, 실적 시즌, 밸류에이션 적정성
3. 시장 센티먼트 (25%): 뉴스 감성, 수급 흐름, 외국인/기관 동향
4. 리스크 조정 (15%): 변동성, 하방 리스크, 유동성

점수 기준:
- 85+: STRONG_BUY (확실한 매수 기회, 즉시 진입)
- 70-84: BUY (양호한 매수 조건)
- 50-69: HOLD (관망)
- 30-49: SELL (매도 고려)
- <30: STRONG_SELL (즉시 매도)

중요: 과도한 낙관 금지. 80+ 점수는 명확한 근거 있을 때만. 평범한 종목은 45-65점 범위.`
      : `당신은 한국 주식 퀀트 분석가입니다. ${mode} 전략으로 종목별 매수 점수(0-100)와 신호를 JSON으로 반환하세요.`;

    const userPrompt = `다음 ${batch.length}개 종목을 분석해 JSON 배열로 반환하세요.

각 항목 형식:
{"stock_code":"코드","composite_score":숫자,"fundamental_score":숫자,"technical_score":숫자,"sentiment_score":숫자,"signal":"BUY|HOLD|SELL|STRONG_BUY|STRONG_SELL","confidence":0.0-1.0,"reasoning":"핵심 근거 1-2문장"}

${isCliMode ? '각 세부 점수(fundamental/technical/sentiment)를 개별 평가하세요. composite_score는 가중 평균입니다.' : '점수 기준: 80+ 강매수, 70-79 매수, 50-69 보유, 50미만 매도'}

종목 데이터:
${stockSummaries}${sourcesBlock}

JSON 배열만 반환 (설명 없이):`;

    try {
      let text: string;

      // 재시도 로직: Premature close 등 네트워크 에러 대비 (최대 2회 재시도)
      for (let attempt = 0; ; attempt++) {
        try {
          if (useCli) {
            text = await callClaudeCli({ systemPrompt, userPrompt, model: 'sonnet' });
            const estimated = Math.ceil(text.length / 4);
            logTokenUsage({
              provider: 'claude-cli', model: 'sonnet',
              inputTokens: Math.ceil(userPrompt.length / 4), outputTokens: estimated,
              costUsd: calcClaudeCliCost(), label: 'scoring',
            });
          } else {
            const msg = await client!.messages.create({
              model: MODEL_API,
              max_tokens: MAX_TOKENS,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
            });
            text = msg.content[0].type === 'text' ? msg.content[0].text : '';
            logTokenUsage({
              provider: 'claude-api', model: MODEL_API,
              inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
              costUsd: calcClaudeApiCost(msg.usage.input_tokens, msg.usage.output_tokens),
              label: 'scoring',
            });
          }
          break; // 성공
        } catch (retryErr) {
          const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (attempt < 2 && (errMsg.includes('Premature close') || errMsg.includes('ECONNRESET') || errMsg.includes('socket hang up'))) {
            logger.warn(`Claude 배치 ${i + 1} 재시도 ${attempt + 1}/2: ${errMsg.slice(0, 100)}`, { component: COMP });
            await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
            continue;
          }
          throw retryErr;
        }
      }
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        stock_code: string;
        composite_score: number;
        fundamental_score?: number;
        technical_score?: number;
        sentiment_score?: number;
        signal: string;
        confidence: number;
        reasoning: string;
      }>;

      for (const item of parsed) {
        const wItem = batch.find((w) => w.stock_code === item.stock_code);
        if (!wItem) continue;
        const rawScore = Number(item.composite_score);
        if (!Number.isFinite(rawScore)) continue; // NaN/Infinity guard
        const clamp = (v: number | undefined, fallback: number) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(n))) : fallback;
        };
        const score = clamp(rawScore, 50);
        const rawConfidence = Number(item.confidence ?? DEFAULT_CONFIDENCE);
        results.push({
          stock_code: item.stock_code,
          composite_score: score,
          fundamental_score: clamp(item.fundamental_score, score),
          technical_score: clamp(item.technical_score, score),
          sentiment_score: clamp(item.sentiment_score, score),
          signal: (VALID_SIGNALS as readonly string[]).includes(item.signal)
            ? (item.signal as ValidSignal)
            : 'HOLD',
          confidence: Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, Number.isFinite(rawConfidence) ? rawConfidence : DEFAULT_CONFIDENCE)),
          reasoning: `[Claude/Sonnet] ${item.reasoning || ''}`,
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
