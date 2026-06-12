import { getActiveWatchlist } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { getTodayNews } from './news-collector.js';

/**
 * 뉴스 감성 분석 모듈 (Google Cloud Natural Language AI)
 *
 * Google NL API를 사용하여 뉴스 헤드라인 및 공시 텍스트의 감성을 분석하고,
 * AI 점수 조정값을 산출합니다.
 *
 * - analyzeSentiment: 단일 텍스트 감성 분석
 * - analyzeNewsSentiment: 복수 헤드라인 배치 분석
 * - getSentimentScoreAdjustment: 감성 기반 AI 점수 조정 (-15 ~ +15)
 * - analyzeWatchlistSentiment: 감시 종목 전체 감성 분석
 */

// ── Types ──

export type SentimentLabel = 'VERY_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE';

export interface SentimentResult {
  score: number; // -1 to 1
  magnitude: number; // 0+
  label: SentimentLabel;
}

export interface NewsSentimentResult {
  average: SentimentResult;
  individual: SentimentResult[];
  headlineCount: number;
}

export interface WatchlistSentimentEntry {
  stockCode: string;
  stockName: string;
  sentiment: NewsSentimentResult;
  scoreAdjustment: number;
}

// ── Google NL API Client (lazy init) ──

let languageClient: InstanceType<typeof import('@google-cloud/language').v1.LanguageServiceClient> | null = null;
let nlApiAvailable: boolean | null = null; // null = not yet tested

async function getLanguageClient() {
  if (languageClient) return languageClient;

  try {
    const { v1 } = await import('@google-cloud/language');
    languageClient = new v1.LanguageServiceClient();
    return languageClient;
  } catch (error) {
    logger.warn(`Google NL API 클라이언트 초기화 실패: ${error}`, { component: 'SENTIMENT' });
    nlApiAvailable = false;
    return null;
  }
}

// ── Label Classification ──

function scoreToLabel(score: number): SentimentLabel {
  if (score > 0.6) return 'VERY_POSITIVE';
  if (score > 0.3) return 'POSITIVE';
  if (score < -0.6) return 'VERY_NEGATIVE';
  if (score < -0.3) return 'NEGATIVE';
  return 'NEUTRAL';
}

const NEUTRAL_RESULT: SentimentResult = { score: 0, magnitude: 0, label: 'NEUTRAL' };

// ── Core Functions ──

/**
 * Google NL API를 호출하여 텍스트 감성 분석
 *
 * API 미설정/오류 시 NEUTRAL 반환
 */
export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  if (nlApiAvailable === false) return NEUTRAL_RESULT;

  try {
    const client = await getLanguageClient();
    if (!client) return NEUTRAL_RESULT;

    const [result] = await client.analyzeSentiment({
      document: {
        content: text,
        type: 'PLAIN_TEXT' as const,
        language: 'ko',
      },
    });

    const sentiment = result.documentSentiment;
    if (!sentiment || sentiment.score == null || sentiment.magnitude == null) {
      return NEUTRAL_RESULT;
    }

    const score = sentiment.score;
    const magnitude = sentiment.magnitude;

    // API 정상 작동 확인
    nlApiAvailable = true;

    return {
      score,
      magnitude,
      label: scoreToLabel(score),
    };
  } catch (error) {
    const errMsg = String(error);

    // 인증/권한 오류 → API 비활성 처리 (반복 호출 방지)
    if (
      errMsg.includes('UNAUTHENTICATED') ||
      errMsg.includes('PERMISSION_DENIED') ||
      errMsg.includes('Could not load the default credentials')
    ) {
      logger.warn(`Google NL API 인증 오류 → 감성 분석 비활성: ${error}`, { component: 'SENTIMENT' });
      nlApiAvailable = false;
    } else {
      logger.warn(`감성 분석 실패: ${error}`, { component: 'SENTIMENT' });
    }

    return NEUTRAL_RESULT;
  }
}

/**
 * 복수 헤드라인 배치 감성 분석
 *
 * 개별 결과 + 평균 감성 반환
 */
export async function analyzeNewsSentiment(headlines: string[]): Promise<NewsSentimentResult> {
  if (headlines.length === 0) {
    return {
      average: NEUTRAL_RESULT,
      individual: [],
      headlineCount: 0,
    };
  }

  // 배치 처리 (3개씩, rate limit 대응)
  const individual: SentimentResult[] = [];
  const batchSize = 3;

  for (let i = 0; i < headlines.length; i += batchSize) {
    const batch = headlines.slice(i, i + batchSize);

    const results = await Promise.allSettled(batch.map((h) => analyzeSentiment(h)));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        individual.push(result.value);
      } else {
        individual.push(NEUTRAL_RESULT);
      }
    }

    // rate limit
    if (i + batchSize < headlines.length) {
      await sleep(300);
    }
  }

  // 평균 산출
  const avgScore = individual.reduce((sum, r) => sum + r.score, 0) / individual.length;
  const avgMagnitude = individual.reduce((sum, r) => sum + r.magnitude, 0) / individual.length;

  return {
    average: {
      score: Math.round(avgScore * 1000) / 1000,
      magnitude: Math.round(avgMagnitude * 1000) / 1000,
      label: scoreToLabel(avgScore),
    },
    individual,
    headlineCount: headlines.length,
  };
}

/**
 * 뉴스 감성 기반 AI 점수 조정값 반환 (-15 ~ +15)
 *
 * VERY_POSITIVE: +15
 * POSITIVE: +8
 * NEUTRAL: 0
 * NEGATIVE: -8
 * VERY_NEGATIVE: -15
 */
export async function getSentimentScoreAdjustment(stockCode: string, headlines: string[]): Promise<number> {
  if (headlines.length === 0) return 0;

  const result = await analyzeNewsSentiment(headlines);
  const label = result.average.label;

  const adjustmentMap: Record<SentimentLabel, number> = {
    VERY_POSITIVE: 15,
    POSITIVE: 8,
    NEUTRAL: 0,
    NEGATIVE: -8,
    VERY_NEGATIVE: -15,
  };

  const adjustment = adjustmentMap[label];

  if (adjustment !== 0) {
    logger.info(
      `📊 [${stockCode}] 뉴스 감성: ${label} (score=${result.average.score}) → 점수 조정 ${adjustment > 0 ? '+' : ''}${adjustment}`,
      {
        component: 'SENTIMENT',
        stockCode,
        label,
        score: result.average.score,
        adjustment,
      },
    );
  }

  return adjustment;
}

/**
 * 감시 종목 전체 뉴스 감성 분석
 *
 * 1. news-collector 캐시에서 오늘 수집된 뉴스 조회
 * 2. 종목별 헤드라인 감성 분석
 * 3. Map<stockCode, WatchlistSentimentEntry> 반환
 */
export async function analyzeWatchlistSentiment(): Promise<Map<string, WatchlistSentimentEntry>> {
  const results = new Map<string, WatchlistSentimentEntry>();

  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) {
    logger.info('감시 종목 없음 → 감성 분석 스킵', { component: 'SENTIMENT' });
    return results;
  }

  // news-collector 캐시에서 오늘 뉴스 가져오기
  const todayNews = getTodayNews();

  for (const stock of watchlist) {
    const newsItems = todayNews.get(stock.stock_code) ?? [];
    const headlines = newsItems.map((item) => item.title);

    // 뉴스가 없으면 종목명으로 빈 결과 생성
    if (headlines.length === 0) {
      results.set(stock.stock_code, {
        stockCode: stock.stock_code,
        stockName: stock.stock_name,
        sentiment: {
          average: NEUTRAL_RESULT,
          individual: [],
          headlineCount: 0,
        },
        scoreAdjustment: 0,
      });
      continue;
    }

    const sentiment = await analyzeNewsSentiment(headlines);
    const scoreAdjustment = await getSentimentScoreAdjustment(stock.stock_code, headlines);

    results.set(stock.stock_code, {
      stockCode: stock.stock_code,
      stockName: stock.stock_name,
      sentiment,
      scoreAdjustment,
    });
  }

  const analyzedCount = [...results.values()].filter((r) => r.sentiment.headlineCount > 0).length;
  logger.info(`📊 감시 종목 감성 분석 완료: ${analyzedCount}/${watchlist.length}개 종목 (뉴스 보유)`, {
    component: 'SENTIMENT',
    total: watchlist.length,
    analyzed: analyzedCount,
  });

  return results;
}
