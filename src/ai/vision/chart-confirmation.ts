/**
 * Vision 차트 확인 시스템
 *
 * 85점+ 고확신 종목 매수 전 캔들스틱 차트 이미지를 Gemini Vision에 전송하여
 * 시각적 패턴 기반 2차 확인. score 0-100 반환.
 *
 * - 무료: Gemini 2.0 Flash (AI Studio)
 * - 캐시: 30분 TTL (동일 종목 재호출 방지)
 * - 타임아웃: 5초 (초과 시 null → 매수 허용, fail-open)
 */

import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { renderCandlestickChart } from './chart-renderer.js';

const AI_STUDIO_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const COMPONENT = 'VISION';

export interface VisionConfirmation {
  score: number;
  reasoning: string;
  patterns: string[];
  cached: boolean;
}

// ── 캐시 (30분 TTL) ──
const _cache = new Map<string, { result: VisionConfirmation; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now >= entry.expiresAt) _cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

const CHART_PROMPT = (rsi: number, adx: number) => `당신은 한국 주식 기술적 차트 분석 전문가입니다.
이 캔들스틱 차트 이미지를 분석하여 매수 적합성을 평가하세요.

차트 구성:
- 일봉 캔들스틱 (녹색=양봉, 빨강=음봉)
- 하단: 거래량 막대
- 파란선: MA5 (5일 이동평균)
- 주황선: MA20 (20일 이동평균)

분석 항목:
1. 추세: 상승/하락/횡보 + 추세 강도
2. 패턴: 이중바닥, 헤드앤숄더, 삼각수렴, 컵앤핸들, 깃발 등
3. 이동평균 배열: 정배열(매수)/역배열(매도)/수렴
4. 거래량: 증가(매집)/감소(관심이탈)/급증(돌파)
5. 최근 3-5일 캔들: 망치형, 장악형, 도지 등
6. 지지/저항: 현재가 대비 주요 가격대

참고 지표: RSI=${rsi.toFixed(0)}, ADX=${adx.toFixed(0)}

매수 확인 점수 (0-100):
- 0-30: 강한 매도 신호 (하락추세, 역배열, 데드크로스)
- 30-50: 불확실 (횡보, 혼합 신호)
- 50-70: 중립-긍정 (상승 초기, 패턴 형성)
- 70-85: 긍정 (확인된 상승, 정배열)
- 85-100: 강한 매수 확인 (강한 상승, 돌파, 매집 완료)

반드시 JSON만 반환:
{"score":75,"reasoning":"정배열 진행 중, 거래량 증가","patterns":["골든크로스","거래량 증가"]}`;

export async function getVisionChartConfirmation(
  stockCode: string,
  candles: DailyCandle[],
  tech: { rsi14: number; adx14: number },
): Promise<VisionConfirmation | null> {
  // 캐시 체크
  const cached = _cache.get(stockCode);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.result, cached: true };
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    logger.warn(`🖼️ ${stockCode}: GEMINI_API_KEY 미설정 → Vision 스킵`, { component: COMPONENT });
    return null;
  }

  if (candles.length < 30) {
    logger.info(`🖼️ ${stockCode}: 캔들 ${candles.length}개 < 30 → Vision 스킵`, { component: COMPONENT });
    return null;
  }

  try {
    // 차트 렌더링
    const startRender = Date.now();
    const pngBuffer = renderCandlestickChart(candles, { stockCode });
    const renderMs = Date.now() - startRender;
    logger.info(`🖼️ ${stockCode}: 차트 렌더링 ${renderMs}ms (${candles.length}봉)`, { component: COMPONENT });

    // Gemini Vision API 호출 (5초 타임아웃)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const body = {
        contents: [{
          role: 'user',
          parts: [
            { text: CHART_PROMPT(tech.rsi14, tech.adx14) },
            { inlineData: { mimeType: 'image/png', data: pngBuffer.toString('base64') } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      };

      const res = await fetch(`${AI_STUDIO_ENDPOINT}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        logger.warn(`🖼️ ${stockCode}: Gemini ${res.status} → Vision 스킵: ${errText.slice(0, 100)}`, { component: COMPONENT });
        return null;
      }

      const data = (await res.json()) as any;
      const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) {
        logger.warn(`🖼️ ${stockCode}: Gemini 응답 비어있음 → Vision 스킵`, { component: COMPONENT });
        return null;
      }

      // JSON 파싱
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        logger.warn(`🖼️ ${stockCode}: JSON 파싱 실패 → Vision 스킵: ${text.slice(0, 100)}`, { component: COMPONENT });
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const result: VisionConfirmation = {
        score: Math.max(0, Math.min(100, Number(parsed.score) || 50)),
        reasoning: String(parsed.reasoning || ''),
        patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
        cached: false,
      };

      // 캐시 저장
      _cache.set(stockCode, { result, expiresAt: Date.now() + CACHE_TTL_MS });

      return result;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.warn(`🖼️ ${stockCode}: Vision 타임아웃 (5초) → 허용`, { component: COMPONENT });
    } else {
      logger.warn(`🖼️ ${stockCode}: Vision 오류 → 허용: ${err?.message ?? err}`, { component: COMPONENT });
    }
    return null;
  }
}
