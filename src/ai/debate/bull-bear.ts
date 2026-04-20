import { GoogleGenerativeAI } from '@google/generative-ai';
import type { TechnicalSummary } from '../../analysis/indicators.js';
import { config } from '../../config/index.js';
import { logSystem } from '../../db/client.js';
import type { AIScore } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

function getGenAI(): GoogleGenerativeAI | null {
  const key = config.ai.geminiKey || process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 10) return null;
  return new GoogleGenerativeAI(key);
}

/**
 * 🐂🐻 Bull vs Bear AI 토론 시스템
 *
 * TradingAgents 논문(ICML 2025) 방식 적용:
 * 1. Bull(강세) AI가 매수 논거 제시
 * 2. Bear(약세) AI가 매도 논거 + 반박
 * 3. Bull이 재반박
 * 4. Judge(심판) AI가 양측 논거를 평가하여 최종 결정
 *
 * 일반 Track B보다 한 단계 높은 의사결정 품질
 * → 고액 매매나 스나이퍼 시그널 검증 시 사용
 */

export interface DebateResult {
  stockCode: string;
  finalVerdict: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  bullScore: number; // Bull 논거 점수 (0~100)
  bearScore: number; // Bear 논거 점수 (0~100)
  bullArguments: string[];
  bearArguments: string[];
  judgeReasoning: string;
  rounds: number;
}

interface DebateContext {
  stockCode: string;
  stockName: string;
  aiScore: AIScore | null;
  technicals: TechnicalSummary | null;
  currentPrice: CurrentPrice;
}

/**
 * Bull vs Bear 토론 실행
 */
export async function runBullBearDebate(ctx: DebateContext): Promise<DebateResult> {
  const { stockCode, stockName } = ctx;

  logger.info(`🐂🐻 토론 시작: ${stockName} (${stockCode})`, { component: 'DEBATE' });

  const marketContext = buildMarketContext(ctx);

  // ── Round 1: Bull 초기 논거 ──
  const bullR1 = await callAgent(
    'BULL',
    `
당신은 강세론자(Bull)입니다. ${stockName}을 매수해야 하는 이유를 강력하게 주장하세요.

${marketContext}

3가지 핵심 매수 논거를 제시하고, 각각에 대해 구체적 수치와 근거를 들어주세요.
JSON 형식으로 응답: {"arguments": ["논거1", "논거2", "논거3"], "conviction": 0~100}
`,
  );

  // ── Round 1: Bear 초기 논거 + Bull 반박 ──
  const bearR1 = await callAgent(
    'BEAR',
    `
당신은 약세론자(Bear)입니다. ${stockName}을 매수하면 안 되는 이유를 주장하세요.

${marketContext}

Bull측 주장:
${bullR1.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Bull의 각 논거를 반박하고, 추가로 3가지 매도/회피 논거를 제시하세요.
JSON 형식으로 응답: {"arguments": ["논거1", "논거2", "논거3"], "rebuttals": ["반박1", "반박2", "반박3"], "conviction": 0~100}
`,
  );

  // ── Round 2: Bull 재반박 ──
  const bullR2 = await callAgent(
    'BULL',
    `
당신은 강세론자입니다. Bear의 반박에 대해 재반박하세요.

Bear의 논거:
${bearR1.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Bear의 반박:
${(bearR1 as any).rebuttals?.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n') ?? '없음'}

최종 매수 확신도와 함께 가장 강력한 논거 2개를 선별하세요.
JSON 형식으로 응답: {"final_arguments": ["최종논거1", "최종논거2"], "conviction": 0~100}
`,
  );

  // ── Judge: 최종 판결 ──
  const judgment = await callJudge(stockName, bullR1, bearR1, bullR2, marketContext);

  const result: DebateResult = {
    stockCode,
    finalVerdict: judgment.verdict,
    confidence: judgment.confidence,
    bullScore: bullR1.conviction,
    bearScore: bearR1.conviction,
    bullArguments: bullR1.arguments,
    bearArguments: bearR1.arguments,
    judgeReasoning: judgment.reasoning,
    rounds: 2,
  };

  await logSystem(
    'INFO',
    'DEBATE',
    `${stockName} 토론 완료: ${result.finalVerdict} (Bull ${result.bullScore} vs Bear ${result.bearScore})`,
    { result },
  );

  logger.info(
    `🏛️ 판결: ${stockName} → ${result.finalVerdict} (신뢰도 ${(result.confidence * 100).toFixed(0)}%, Bull ${result.bullScore} vs Bear ${result.bearScore})`,
    { component: 'DEBATE' },
  );

  return result;
}

// ── AI 에이전트 호출 ──

async function callAgent(role: 'BULL' | 'BEAR', prompt: string): Promise<{ arguments: string[]; conviction: number }> {
  const genAI = getGenAI();
  if (!genAI) {
    logger.warn(`${role} 에이전트: Gemini 키 없음`, { component: 'DEBATE' });
    return { arguments: ['분석 불가'], conviction: 50 };
  }

  try {
    const systemInstruction =
      role === 'BULL'
        ? '당신은 월가의 낙관적 애널리스트입니다. 매수 기회를 적극적으로 찾되, 근거 없는 낙관은 금지합니다. 반드시 JSON으로만 응답하세요.'
        : '당신은 월가의 비관적 리스크 매니저입니다. 모든 리스크를 날카롭게 지적하되, 근거 없는 비관은 금지합니다. 반드시 JSON으로만 응답하세요.';

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction,
      generationConfig: {
        temperature: role === 'BULL' ? 0.3 : 0.4,
      },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('No JSON found');

    const parsed = JSON.parse(json);
    return {
      arguments: parsed.arguments ?? parsed.final_arguments ?? [],
      conviction: Math.min(100, Math.max(0, parsed.conviction ?? 50)),
    };
  } catch (error) {
    logger.warn(`${role} 에이전트 호출 실패: ${error}`, { component: 'DEBATE' });
    return { arguments: ['분석 실패'], conviction: 50 };
  }
}

async function callJudge(
  stockName: string,
  bull: { arguments: string[]; conviction: number },
  bear: { arguments: string[]; conviction: number },
  bullFinal: { arguments: string[]; conviction: number },
  context: string,
): Promise<{ verdict: DebateResult['finalVerdict']; confidence: number; reasoning: string }> {
  const genAI = getGenAI();
  if (!genAI) {
    return { verdict: 'HOLD', confidence: 0.3, reasoning: 'Gemini 키 없음 → 안전하게 HOLD' };
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction:
        '당신은 공정한 투자 심판입니다. Bull과 Bear 양측의 논거를 객관적으로 평가하여 최종 판결을 내리세요. 감정이 아닌 데이터와 논리만으로 판단합니다. 반드시 JSON으로만 응답하세요.',
      generationConfig: {
        temperature: 0.1,
      },
    });

    const judgePrompt = `## ${stockName} 투자 토론 판결

${context}

### Bull측 (매수 찬성, 확신도 ${bull.conviction}점)
${bull.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}

최종 보강: ${bullFinal.arguments.join(', ')} (확신도 ${bullFinal.conviction}점)

### Bear측 (매수 반대, 확신도 ${bear.conviction}점)
${bear.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}

양측 논거를 종합하여 판결하세요.
JSON 형식: {"verdict": "STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL", "confidence": 0.0~1.0, "reasoning": "판결 이유 2줄"}`;

    const result = await model.generateContent(judgePrompt);
    const text = result.response.text();

    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('No JSON');

    const parsed = JSON.parse(json);
    return {
      verdict: parsed.verdict ?? 'HOLD',
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      reasoning: parsed.reasoning ?? '판단 불가',
    };
  } catch (error) {
    logger.warn(`Judge 호출 실패: ${error}`, { component: 'DEBATE' });
    return { verdict: 'HOLD', confidence: 0.3, reasoning: '토론 실패 → 안전하게 HOLD' };
  }
}

function buildMarketContext(ctx: DebateContext): string {
  const { stockName, stockCode, aiScore, technicals, currentPrice } = ctx;
  const lines = [
    `## ${stockName} (${stockCode}) 현재 상태`,
    `현재가: ${currentPrice.currentPrice.toLocaleString()}원 (${currentPrice.changePct > 0 ? '+' : ''}${currentPrice.changePct}%)`,
    `거래량: ${currentPrice.volume.toLocaleString()}`,
  ];

  if (aiScore) {
    lines.push(`AI 스코어: ${aiScore.composite_score}점 (${aiScore.signal})`);
    lines.push(`분석: ${aiScore.reasoning ?? '없음'}`);
  }

  if (technicals) {
    lines.push(`\n## 기술적 지표`);
    lines.push(`RSI(14): ${technicals.rsi14.toFixed(1)} (${technicals.stochasticSignal})`);
    lines.push(`MACD: ${technicals.macdCrossover} (히스토그램 ${technicals.macdHistogram.toFixed(0)})`);
    lines.push(`볼린저: ${technicals.bollingerPosition} (폭 ${technicals.bollingerWidth.toFixed(1)}%)`);
    lines.push(
      `이평선: 5MA=${technicals.sma5.toFixed(0)}, 20MA=${technicals.sma20.toFixed(0)}, 60MA=${technicals.sma60.toFixed(0)}`,
    );
    lines.push(`종합: ${technicals.overallSignal} (점수 ${technicals.score})`);
    if (technicals.goldenCross) lines.push(`⭐ 골든크로스 발생!`);
    if (technicals.deathCross) lines.push(`⚠️ 데드크로스 발생!`);
  }

  return lines.join('\n');
}
