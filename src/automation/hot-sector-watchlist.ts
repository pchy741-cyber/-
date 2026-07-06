/**
 * 핫 업종 자동 워치리스트 편입
 *
 * 흐름:
 * 1. KIS 업종별 지수 조회 → 당일 등락률 상위 업종 감지
 * 2. 해당 업종 구성 종목 조회 → 기본 필터 (거래량, 가격)
 * 3. AI 스코어 DB 조회 → 65점 이상인 종목만 워치리스트 편입
 * 4. 편입 시 Telegram 알림
 *
 * 실행: 10:00 (장 초반 30분 흐름 반영)
 */

import { getPool } from '../db/client.js';
import { kisRequest } from '../kis/client.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const COMPONENT = 'HOT_SECTOR';

// 핫 업종 판정 기준: 당일 등락률 +1.5% 이상
const HOT_SECTOR_CHANGE_PCT = 1.5;
// 워치리스트 편입 최소 AI 스코어 (최근 3일 평균) — 없어도 신규 발굴 허용
// v23: 60→50 하향 (신규 섹터 초기 편입률 개선, 기존 60점은 진입 절벽)
const MIN_AI_SCORE = 50;
// 편입 최대 종목 수 (1회 실행당)
const MAX_ADD_PER_RUN = 8;
// 최소 거래량 — 잡주 차단 (일 10만주 이상 거래되는 종목만)
const MIN_VOLUME = 100_000;
// 최소 시가총액 (억원) — 500억 미만 소형주/잡주 제외
const MIN_MARKET_CAP_EOK = 500;
// 가격 범위
const MIN_PRICE = 1_000;
const MAX_PRICE = 5_000_000;

// 자동 추가 종목 가지치기 기준
// v23: 7→10일로 확장 (신규 편입 종목이 Track A 분석+스코어 형성할 시간 확보)
const PRUNE_NO_TRADE_DAYS = 10;  // 10거래일 동안 시스템이 한 번도 매매 안 한 종목
const PRUNE_LOW_SCORE_DAYS = 4;  // AI 스코어 40 미만이 4일 연속이면 제거 (v23: 3→4일)
const PRUNE_LOW_SCORE_THRESHOLD = 40;

// KIS 업종 코드 → 한국어 이름
const SECTOR_NAMES: Record<string, string> = {
  '0001': '종합(KOSPI)',
  '1001': '제조업',
  '1002': '음식료품',
  '1003': '섬유의복',
  '1004': '종이목재',
  '1005': '화학',
  '1006': '의약품',
  '1007': '비금속광물',
  '1008': '철강금속',
  '1009': '기계',
  '1010': '전기전자',
  '1011': '의료정밀',
  '1012': '운수장비',
  '1013': '유통업',
  '1014': '전기가스업',
  '1015': '건설업',
  '1016': '운수창고',
  '1017': '통신업',
  '1018': '금융업',
  '1019': '은행',
  '1020': '증권',
  '1021': '보험',
  '1022': '서비스업',
  '1023': '제조업(기타)',
};

interface SectorInfo {
  code: string;
  name: string;
  changePct: number;
  indexValue: number;
}

interface SectorStock {
  stock_code: string;
  stock_name: string;
}

// v20: 매수 시점 섹터 모멘텀 체크(decision-flow.ts)용 캐시 — 업종 지수는 분단위로 안 바뀌므로
// 매 후보마다 재조회할 필요 없음 (23개 업종 × 매수후보 수만큼 API 호출 낭비 방지)
const SECTOR_INDEX_CACHE_MS = 15 * 60_000;
let _sectorIndexCache: { data: SectorInfo[]; fetchedAt: number } | null = null;

/** 매수 결정 단계에서 쓰는 캐시된 업종별 등락률 조회 (15분 캐시, 네트워크 재사용) */
export async function getCachedSectorChangeMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (!_sectorIndexCache || now - _sectorIndexCache.fetchedAt > SECTOR_INDEX_CACHE_MS) {
    try {
      const data = await fetchSectorIndices();
      _sectorIndexCache = { data, fetchedAt: now };
    } catch (err) {
      logger.debug(`업종 지수 캐시 갱신 실패 (기존 캐시 유지): ${err}`, { component: COMPONENT });
      if (!_sectorIndexCache) return new Map();
    }
  }
  return new Map(_sectorIndexCache.data.map((s) => [s.code, s.changePct]));
}

/**
 * KIS 업종별 지수 조회 (FHKUP03500100)
 */
async function fetchSectorIndices(): Promise<SectorInfo[]> {
  const results: SectorInfo[] = [];

  // 주요 업종 코드만 조회 (시장 전체 제외, 종합 제외)
  const sectorCodes = Object.keys(SECTOR_NAMES).filter((c) => c !== '0001');

  // 2개씩 배치 처리 (rate limit)
  const batchSize = 3;
  for (let i = 0; i < sectorCodes.length; i += batchSize) {
    const batch = sectorCodes.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map(async (code) => {
        const res = await kisRequest<Record<string, string>>({
          path: '/uapi/domestic-stock/v1/quotations/inquire-index-price',
          trId: 'FHPUP03500100',
          useRealUrl: true,
          params: {
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: code,
          },
        });
        const o = res.output as Record<string, string>;
        return {
          code,
          name: SECTOR_NAMES[code] ?? code,
          changePct: Number(o.bstp_nmix_prdy_ctrt ?? 0),
          indexValue: Number(o.bstp_nmix_prpr ?? 0),
        };
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.indexValue > 0) {
        results.push(r.value);
      }
    }

    if (i + batchSize < sectorCodes.length) {
      await sleep(500);
    }
  }

  return results;
}

/**
 * 특정 업종의 구성 종목 조회 (FHPUP03500200)
 */
async function fetchSectorStocks(sectorCode: string): Promise<SectorStock[]> {
  try {
    const res = await kisRequest<Record<string, string>[]>({
      path: '/uapi/domestic-stock/v1/quotations/inquire-member',
      trId: 'FHPUP03500200',
      useRealUrl: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'U',
        FID_INPUT_ISCD: sectorCode,
      },
    });
    const items = (res.output ?? []) as Record<string, string>[];
    return items
      .map((o) => ({
        stock_code: o.stck_shrn_iscd ?? o.mksc_shrn_iscd ?? '',
        stock_name: o.hts_kor_isnm ?? '',
      }))
      .filter((s) => s.stock_code && !s.stock_code.startsWith('1') && s.stock_code.length === 6);
  } catch (err) {
    logger.warn(`업종 구성종목 조회 실패 (${sectorCode}): ${err}`, { component: COMPONENT });
    return [];
  }
}

/**
 * DB에서 최근 3일 평균 AI 스코어 조회
 */
async function getRecentAiScores(stockCodes: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (stockCodes.length === 0) return map;
  try {
    const { rows } = await getPool().query(
      `SELECT stock_code, AVG(composite_score)::float AS avg_score
         FROM ai_scores
        WHERE stock_code = ANY($1)
          AND score_date >= CURRENT_DATE - INTERVAL '3 days'
          AND composite_score IS NOT NULL
        GROUP BY stock_code`,
      [stockCodes],
    );
    for (const r of rows) {
      map.set(String(r.stock_code), Number(r.avg_score));
    }
  } catch (err) {
    logger.debug(`기존 AI 스코어 조회 실패: ${err}`, { component: 'HOT_SECTOR' });
  }
  return map;
}

/**
 * 워치리스트 현재 활성 종목 코드 조회
 */
async function getActiveWatchlistCodes(): Promise<Set<string>> {
  try {
    const { rows } = await getPool().query(`SELECT stock_code FROM watchlist WHERE is_active = true`);
    return new Set(rows.map((r: Record<string, unknown>) => String(r.stock_code)));
  } catch (err) {
    logger.debug(`워치리스트 조회 실패: ${err}`, { component: 'HOT_SECTOR' });
    return new Set();
  }
}

/**
 * 워치리스트에 종목 추가 (없으면 INSERT, 비활성이면 활성화)
 * v23: provisional_score 55점 주입 — Track A 분석 전 가지치기 방지
 */
async function addToWatchlist(stockCode: string, stockName: string, sectorName: string): Promise<boolean> {
  try {
    const pool = getPool();
    const { rowCount } = await pool.query(
      `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
       VALUES ($1, $2, 'KOSPI', true, $3)
       ON CONFLICT (stock_code) DO UPDATE
         SET is_active = true, source = $3
       WHERE watchlist.is_active = false`,
      [stockCode, stockName, `HOT_SECTOR:${sectorName}`],
    );
    const added = (rowCount ?? 0) > 0;

    // v23: 신규 편입 종목에 provisional ai_score 주입
    // AI 스코어 순환참조 문제 해결: 스코어 없으면 → 가지치기 당함 → 분석 전 제거
    // 55점(MIN_AI_SCORE 이상)으로 주입하여 최소 3~5일 생존 보장
    if (added) {
      try {
        await pool.query(
          `INSERT INTO ai_scores (stock_code, score_date, composite_score, analysis_source, reasoning)
           VALUES ($1, CURRENT_DATE, $2, 'provisional', $3)
           ON CONFLICT (stock_code, score_date) DO NOTHING`,
          [stockCode, 55, `HOT_SECTOR:${sectorName} 자동편입 잠정스코어`],
        );
      } catch {
        // provisional score 주입 실패해도 편입 자체는 성공
      }
    }

    return added;
  } catch (err) {
    logger.error(`워치리스트 추가 실패 (${stockCode}): ${err}`, { component: COMPONENT });
    return false;
  }
}

/**
 * 핫 업종 자동 워치리스트 편입 메인 함수
 */
export async function runHotSectorWatchlist(): Promise<void> {
  logger.info('🔥 핫 업종 자동 워치리스트 편입 시작', { component: COMPONENT });

  try {
    // 1. 업종별 지수 조회
    const sectors = await fetchSectorIndices();
    if (sectors.length === 0) {
      logger.warn('업종 지수 조회 결과 없음 — 스킵', { component: COMPONENT });
      return;
    }

    // 2. 핫 업종 필터 (+HOT_SECTOR_CHANGE_PCT% 이상)
    const hotSectors = sectors
      .filter((s) => s.changePct >= HOT_SECTOR_CHANGE_PCT)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 3); // 상위 3개 업종만

    if (hotSectors.length === 0) {
      logger.info(
        `핫 업종 없음 (기준: +${HOT_SECTOR_CHANGE_PCT}%). 최고 업종: ${sectors[0]?.name} ${sectors[0]?.changePct.toFixed(2)}%`,
        { component: COMPONENT },
      );
      return;
    }

    logger.info(`🔥 핫 업종 감지: ${hotSectors.map((s) => `${s.name}(${s.changePct.toFixed(1)}%)`).join(', ')}`, {
      component: COMPONENT,
    });

    // 3. 기존 워치리스트 조회
    const activeCodes = await getActiveWatchlistCodes();

    // 4. 핫 업종 구성종목 수집 + 필터링
    const candidates: Array<{ stock_code: string; stock_name: string; sectorName: string }> = [];

    for (const sector of hotSectors) {
      const stocks = await fetchSectorStocks(sector.code);
      await sleep(300);

      // 이미 워치리스트에 있으면 스킵
      const newStocks = stocks.filter((s) => !activeCodes.has(s.stock_code));
      for (const s of newStocks) {
        candidates.push({ ...s, sectorName: sector.name });
      }
    }

    if (candidates.length === 0) {
      logger.info('핫 업종 구성종목 모두 이미 워치리스트에 존재', { component: COMPONENT });
      return;
    }

    // 5. 현재가 조회 → 가격/거래량 필터
    const validCandidates: typeof candidates = [];
    const batchSize = 3;
    for (let i = 0; i < candidates.slice(0, 30).length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const settled = await Promise.allSettled(
        batch.map(async (cand) => {
          const price = await getCurrentPrice(cand.stock_code);
          return { cand, price };
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          const { cand, price } = r.value;
          // 잡주/상폐 필터: 가격·거래량·시총·시장경보 모두 통과해야 편입
          const isJunk =
            price.currentPrice < MIN_PRICE ||
            price.currentPrice > MAX_PRICE ||
            price.volume < MIN_VOLUME ||
            (price.marketCapEok > 0 && price.marketCapEok < MIN_MARKET_CAP_EOK) ||
            (price.mrktWarnClsCode && price.mrktWarnClsCode !== '00'); // 투자경고/위험/정리매매 제외
          if (!isJunk) validCandidates.push(cand);
        }
      }
      await sleep(300);
    }

    if (validCandidates.length === 0) {
      logger.info('가격/거래량 필터 통과 종목 없음', { component: COMPONENT });
      return;
    }

    // 6. AI 스코어 조회 → MIN_AI_SCORE 이상만
    const codes = validCandidates.map((c) => c.stock_code);
    const aiScores = await getRecentAiScores(codes);

    const scoredCandidates = validCandidates
      .map((c) => ({ ...c, score: aiScores.get(c.stock_code) ?? 0 }))
      .filter((c) => c.score >= MIN_AI_SCORE)
      .sort((a, b) => b.score - a.score);

    // AI 스코어 없는 종목도 적극 포함 — 씨앗 미등록 우량주 발굴
    const unscored = validCandidates
      .filter((c) => !aiScores.has(c.stock_code))
      .slice(0, 5)
      .map((c) => ({ ...c, score: 0 }));

    const finalList = [...scoredCandidates, ...unscored].slice(0, MAX_ADD_PER_RUN);

    if (finalList.length === 0) {
      logger.info(`AI 스코어 ${MIN_AI_SCORE}점 미달 — 편입 종목 없음 (후보 ${validCandidates.length}개)`, {
        component: COMPONENT,
      });
      return;
    }

    // 7. 워치리스트 편입
    const added: string[] = [];
    for (const cand of finalList) {
      const ok = await addToWatchlist(cand.stock_code, cand.stock_name, cand.sectorName);
      if (ok) {
        added.push(`${cand.stock_name}(${cand.stock_code})${cand.score > 0 ? ` ${cand.score.toFixed(0)}점` : ' 신규'}`);
        logger.info(
          `✅ 워치리스트 편입: ${cand.stock_name}(${cand.stock_code}) — ${cand.sectorName} 업종, AI ${cand.score.toFixed(0)}점`,
          { component: COMPONENT },
        );
      }
    }

    if (added.length === 0) {
      logger.info('새로 편입된 종목 없음 (이미 활성 상태)', { component: COMPONENT });
      return;
    }

    // 8. Telegram 알림
    const sectorSummary = hotSectors.map((s) => `${s.name} +${s.changePct.toFixed(1)}%`).join(' | ');
    const msg =
      `🔥 *핫 업종 자동 편입*\n` +
      `업종: ${sectorSummary}\n\n` +
      `편입 종목:\n${added.map((s) => `• ${s}`).join('\n')}`;

    await sendTelegramMessage(msg).catch(() => {});
  } catch (err) {
    logger.error(`핫 업종 자동 편입 실패: ${err instanceof Error ? err.message : String(err)}`, {
      component: COMPONENT,
    });
  }
}

/**
 * 자동 추가 종목 자동 가지치기 (16:00 실행)
 *
 * 대상: source LIKE 'HOT_SECTOR%' — CEO 직접 추가(MANUAL) 종목은 절대 건드리지 않음
 * 제거 조건 (하나라도 해당):
 *   1. 최근 7거래일 동안 시스템 매매 기록 없음 + AI 스코어 40 미만 3일 연속
 *   2. 시장경보 코드 ≠ '00' (투자경고/위험/정리매매 진입)
 *   3. 시가총액 < 200억 (시총이 급락해 잡주화)
 */
export async function pruneAutoWatchlist(): Promise<void> {
  logger.info('✂️ 자동 워치리스트 가지치기 시작', { component: COMPONENT });
  const pool = getPool();

  try {
    // 자동 편입 활성 종목만 대상 (CEO MANUAL 제외)
    const { rows: autoStocks } = await pool.query<{ stock_code: string; stock_name: string }>(
      `SELECT stock_code, stock_name FROM watchlist
       WHERE is_active = true AND source LIKE 'HOT_SECTOR%'`,
    );

    if (autoStocks.length === 0) {
      logger.info('가지치기 대상 자동 편입 종목 없음', { component: COMPONENT });
      return;
    }

    const pruned: string[] = [];

    for (const stock of autoStocks) {
      try {
        // 조건 1: 최근 N일 매매 기록 확인
        const { rows: tradeRows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM transaction_chains
           WHERE stock_code = $1
             AND created_at >= CURRENT_DATE - INTERVAL '${PRUNE_NO_TRADE_DAYS} days'`,
          [stock.stock_code],
        );
        const recentTrades = Number(tradeRows[0]?.cnt ?? 0);

        // 조건 2: AI 스코어 연속 저점
        const { rows: scoreRows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM ai_scores
           WHERE stock_code = $1
             AND score_date >= CURRENT_DATE - INTERVAL '${PRUNE_LOW_SCORE_DAYS} days'
             AND composite_score < $2`,
          [stock.stock_code, PRUNE_LOW_SCORE_THRESHOLD],
        );
        const lowScoreDays = Number(scoreRows[0]?.cnt ?? 0);
        const poorPerformer = recentTrades === 0 && lowScoreDays >= PRUNE_LOW_SCORE_DAYS;

        // 조건 3: 상폐/잡주 실시간 체크 (KIS API — 이미 율 제한 없음)
        let warnFail = false;
        try {
          const price = await getCurrentPrice(stock.stock_code);
          if (price.mrktWarnClsCode && price.mrktWarnClsCode !== '00') {
            warnFail = true;
            logger.warn(`⛔ 경보종목 감지 → 제거: ${stock.stock_name}(${stock.stock_code}) 경보코드=${price.mrktWarnClsCode}`, {
              component: COMPONENT,
            });
          } else if (price.marketCapEok > 0 && price.marketCapEok < 200) {
            warnFail = true;
            logger.warn(`⛔ 시총 급락 잡주 감지 → 제거: ${stock.stock_name}(${stock.stock_code}) 시총=${price.marketCapEok}억`, {
              component: COMPONENT,
            });
          }
        } catch {
          // 가격 조회 실패는 제거 사유 아님 — 보수적으로 유지
        }

        if (poorPerformer || warnFail) {
          const reason = warnFail ? '상폐/잡주위험' : `${PRUNE_NO_TRADE_DAYS}일무매매+저점수`;
          await pool.query(
            `UPDATE watchlist SET is_active = false, source = $1 WHERE stock_code = $2`,
            [`PRUNED:${reason}`, stock.stock_code],
          );
          pruned.push(`${stock.stock_name}(${stock.stock_code}): ${reason}`);
          logger.info(`✂️ 워치리스트 제거: ${stock.stock_name}(${stock.stock_code}) — ${reason}`, { component: COMPONENT });
        }

        await sleep(200); // rate limit 여유
      } catch (err) {
        logger.warn(`가지치기 실패 (${stock.stock_code}): ${err}`, { component: COMPONENT });
      }
    }

    if (pruned.length > 0) {
      await sendTelegramMessage(
        `✂️ *자동 워치리스트 가지치기*\n제거 ${pruned.length}개:\n${pruned.map((s) => `• ${s}`).join('\n')}`,
      ).catch(() => {});
    } else {
      logger.info('✂️ 가지치기 대상 없음 — 모든 자동 편입 종목 유지', { component: COMPONENT });
    }
  } catch (err) {
    logger.error(`자동 워치리스트 가지치기 실패: ${err instanceof Error ? err.message : String(err)}`, {
      component: COMPONENT,
    });
  }
}
