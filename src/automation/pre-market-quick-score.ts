/**
 * 장전 초고속 스코어링 — 08:55 실행 (09:00 개장 5분 전)
 *
 * 목적: 08:50 시장발굴에서 편입된 신규 종목 + 오늘 스코어가 없는 활성 종목을
 *       Gemini에게 경량 분석시켜 09:00 Track B가 즉시 매수 판단을 내릴 수 있게 한다.
 *
 * 무료 Gemini 소모: 1~2 call (2.0-flash 1500 RPD 한도 대비 극소)
 */
import { getPool, upsertAIScore } from '../db/client.js';
import { getChangeRankingStocks, getVolumeRankingStocks, getBatchPrices } from '../kis/market.js';
import { cacheScores } from '../cache/redis.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const MAX_QUICK_STOCKS = 15;  // 경량 스코어링 최대 종목 수

// 장전 스코어 공유 캐시 — opening-bell-job이 재사용해서 Gemini 중복 호출 방지
let _sharedScores: Map<string, number> | null = null;
let _sharedScoresAt = 0;

/** opening-bell-job이 읽는 장전 스코어 (10분 내 유효) */
export function getPreMarketSharedScores(): Map<string, number> | null {
  const age = (Date.now() - _sharedScoresAt) / 60000;
  return age < 10 ? _sharedScores : null;
}

export async function runPreMarketQuickScore(): Promise<void> {
  logger.info('⚡ 장전 빠른 스코어링 시작 (08:55)', { component: 'PRE_MARKET_QS' });

  try {
    const pool = getPool();
    const today = new Date().toISOString().split('T')[0];

    // 1. 오늘 이미 스코어가 있는 종목 확인
    const { rows: scoredRows } = await pool.query(
      `SELECT stock_code FROM ai_scores WHERE score_date = $1`,
      [today],
    );
    const alreadyScored = new Set(scoredRows.map((r: any) => String(r.stock_code)));

    // 2. 활성 워치리스트 중 오늘 스코어 없는 종목
    const { rows: activeRows } = await pool.query(
      `SELECT stock_code, stock_name FROM watchlist WHERE is_active = true`,
    );
    const unscoredActive = activeRows
      .filter((r: any) => !alreadyScored.has(String(r.stock_code)))
      .map((r: any) => ({ stock_code: String(r.stock_code), stock_name: String(r.stock_name ?? r.stock_code) }));

    // 3. 오늘 거래량·급등 상위 종목 (모멘텀 후보) — 이미 활성이거나 스코어 없는 것
    const [volTop, chgTop] = await Promise.allSettled([
      getVolumeRankingStocks('J', 30).catch(() => [] as any[]),
      getChangeRankingStocks(20).catch(() => [] as any[]),
    ]);
    const momentumCandidates = [
      ...(volTop.status === 'fulfilled' ? volTop.value : []),
      ...(chgTop.status === 'fulfilled' ? chgTop.value : []),
    ].filter((s: any) => !alreadyScored.has(String(s.stock_code)));

    // 합산 후 중복 제거 (활성 미스코어 우선, 이후 모멘텀 신규)
    const combinedMap = new Map<string, { stock_code: string; stock_name: string }>();
    for (const s of [...unscoredActive, ...momentumCandidates]) {
      if (!s.stock_code || combinedMap.has(s.stock_code)) continue;
      combinedMap.set(s.stock_code, s);
    }
    const targets = [...combinedMap.values()].slice(0, MAX_QUICK_STOCKS);

    if (targets.length === 0) {
      logger.info('⚡ 빠른 스코어링: 스코어링 대상 없음 (오늘 이미 전체 스코어링 완료)', { component: 'PRE_MARKET_QS' });
      return;
    }

    logger.info(`⚡ 빠른 스코어링 대상: ${targets.length}개 — ${targets.map(s => s.stock_code).join(', ')}`, { component: 'PRE_MARKET_QS' });

    // 4. 현재가 일괄 조회
    const priceMap = await getBatchPrices(targets.map(s => s.stock_code)).catch(() => new Map());

    // 5. Gemini 경량 분석 요청
    const stockLines = targets.map(s => {
      const p = priceMap.get(s.stock_code);
      if (!p) return `${s.stock_name}(${s.stock_code}): 가격정보없음`;
      const chgSign = p.changeRate >= 0 ? '+' : '';
      return `${s.stock_name}(${s.stock_code}): ${p.currentPrice.toLocaleString()}원 ${chgSign}${p.changeRate.toFixed(2)}% | 거래량${p.volume.toLocaleString()}주`;
    }).join('\n');

    const userMsg = `오늘 개장 직전(08:55 KST) 한국 주식 장전 데이터입니다. 각 종목을 단타/스윙 관점에서 빠르게 평가해주세요.

## 오늘 장전 시세
${stockLines}

## 스코어링 기준 (기본 50점)
- 당일 +2%이상 상승중: +15 (모멘텀)
- 당일 -2%이하 하락중: -15 (약세)
- 거래량 상위권: +10
- 뚜렷한 방향없음: ±0
- 가격정보없음: score=0, signal=NO_DATA

빠른 판단 — JSON만 출력:
{"scores":[{"stock_code":"코드","stock_name":"종목명","composite_score":65,"fundamental_score":50,"technical_score":70,"sentiment_score":60,"confidence":0.65,"signal":"BUY","target_price":0,"stop_loss_price":0,"reasoning":"장전모멘텀 +3.2% 거래량급증"}]}`;

    const raw = await callVertexGemini(
      '당신은 한국 주식 단타 전문가입니다. JSON 형식으로만 응답합니다.',
      userMsg,
      { temperature: 0.1, maxOutputTokens: 2048 },
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Gemini 응답에서 JSON 없음');

    const parsed = JSON.parse(jsonMatch[0]) as { scores: Array<{
      stock_code: string; stock_name: string; composite_score: number;
      fundamental_score: number; technical_score: number; sentiment_score: number;
      confidence: number; signal: string; target_price: number; stop_loss_price: number;
      reasoning: string;
    }> };

    const scores = parsed.scores ?? [];
    logger.info(`⚡ Gemini 빠른 스코어링 완료: ${scores.length}개`, { component: 'PRE_MARKET_QS' });

    // 점수 정규화 헬퍼 (|| 50 버그 수정: undefined/null만 50 기본값, 0은 그대로)
    const safeScore = (v: unknown, def = 50) => {
      const n = Number(v);
      return isNaN(n) ? def : Math.max(0, Math.min(100, n));
    };
    const safeConf = (v: unknown) => {
      const n = Number(v);
      return isNaN(n) ? 0.5 : Math.max(0, Math.min(1, n));
    };

    // 6. DB + Redis 캐싱
    const validSignals = new Set(['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL', 'NO_DATA']);
    const upsertResults = await Promise.allSettled(scores.map(async s => {
      const signal = validSignals.has(s.signal) ? s.signal as any : 'HOLD';
      await upsertAIScore({
        stock_code: s.stock_code,
        score_date: today,
        gemini_summary: null,
        composite_score: safeScore(s.composite_score),
        fundamental_score: safeScore(s.fundamental_score),
        technical_score: safeScore(s.technical_score),
        sentiment_score: safeScore(s.sentiment_score),
        confidence: safeConf(s.confidence),
        reasoning: `[장전빠른스코어] ${s.reasoning || ''}`,
        signal,
        target_price: s.target_price ? Number(s.target_price) : null,
        stop_loss_price: s.stop_loss_price ? Number(s.stop_loss_price) : null,
      });
      return s;
    }));

    const saved = upsertResults.filter(r => r.status === 'fulfilled').length;

    // 공유 캐시 갱신 — opening-bell-job이 재사용 (Gemini 중복 호출 방지)
    _sharedScores = new Map(scores.map(s => [s.stock_code, safeScore(s.composite_score)]));
    _sharedScoresAt = Date.now();

    // Redis 캐시 갱신
    const cacheItems = scores.map(s => ({
      id: '',
      stock_code: s.stock_code,
      score_date: today,
      gemini_summary: null,
      composite_score: safeScore(s.composite_score),
      fundamental_score: safeScore(s.fundamental_score),
      technical_score: safeScore(s.technical_score),
      sentiment_score: safeScore(s.sentiment_score),
      confidence: safeConf(s.confidence),
      reasoning: `[장전빠른스코어] ${s.reasoning || ''}`,
      signal: validSignals.has(s.signal) ? s.signal as any : 'HOLD',
      target_price: s.target_price ? Number(s.target_price) : null,
      stop_loss_price: s.stop_loss_price ? Number(s.stop_loss_price) : null,
      created_at: new Date().toISOString(),
    }));
    await cacheScores(cacheItems).catch(e => logger.warn(`Redis 캐시 실패: ${e}`, { component: 'PRE_MARKET_QS' }));

    // 7. 텔레그램 알림 (매수 후보만)
    const buyCandidates = scores.filter(s => ['BUY', 'STRONG_BUY'].includes(s.signal) && (s.confidence ?? 0) >= 0.6);
    if (buyCandidates.length > 0) {
      const msg = [
        `⚡ 장전 빠른 스코어링 완료 (${saved}개)`,
        `🟢 09:00 매수후보(${buyCandidates.length}): ${buyCandidates.map(s => `${s.stock_code}(${s.composite_score}점/${(s.confidence*100).toFixed(0)}%)`).join(', ')}`,
      ].join('\n');
      await sendTelegramMessage(msg).catch(() => {});
    } else {
      logger.info(`⚡ 빠른 스코어링: 매수후보 없음 (${saved}개 스코어 저장)`, { component: 'PRE_MARKET_QS' });
    }
  } catch (error) {
    logger.error(`⚡ 장전 빠른 스코어링 실패: ${error}`, { component: 'PRE_MARKET_QS' });
  }
}
