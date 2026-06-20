/**
 * 급등/거래대금 실시간 감지기
 *
 * 기존 발굴 파이프라인의 구조적 결함 보완:
 * - hot-sector: 10:00 단 1회 → 이후 급등 포착 불가
 * - watchlist-rotation: 주 1회 + 기관/외국인 5일 수급 필요 → 당일 뉴스성 급등 미포착
 * - ai_scores FK 순환참조: 워치리스트 없으면 점수 없음, 점수 없으면 워치리스트 불가
 *
 * 해결책: 거래대금(price×volume) 단독 기준으로 급등주 즉시 편입
 * - 등락률 +5%+ AND 거래대금 500억원+ → 무조건 편입
 * - 삼성/하이닉스급 초대형주: +2%+ AND 거래대금 3000억+ → 편입
 *
 * 실행: 매 30분 (09:30, 10:00, ..., 15:00) 장중
 */

import { getPool } from '../db/client.js';
import { syncInterestGroups } from '../kis/interest-group.js';
import { getChangeRankingStocks, getCurrentPrice, getVolumeRankingStocks } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { getClusterFollowers } from './sector-themes.js';

const COMPONENT = 'SURGE_DETECTOR';

// 일반 급등: 등락률 +5%+ && 거래대금 500억원+
const SURGE_CHANGE_PCT = 5;
const SURGE_TRADING_VALUE = 50_000_000_000; // 500억

// 초대형주 (시총 50조+): 등락률 +2%+ && 거래대금 3000억+
const MEGA_CAP_CHANGE_PCT = 2;
const MEGA_CAP_MARKET_CAP_EOK = 500_000; // 시총 50조 = 500,000억
const MEGA_CAP_TRADING_VALUE = 300_000_000_000; // 3000억

// 1회 최대 편입
const MAX_ADD_PER_RUN = 10;

// 테마 클러스터: 후행 종목 편입 기준
const CLUSTER_MIN_CHANGE = -2.0; // 하락 중이어도 테마 파급 기대
const CLUSTER_MAX_CHANGE = 4.5; // 이미 급등한 종목은 제외
const CLUSTER_MIN_TRADING_VALUE = 10_000_000_000; // 100억 이상 (유동성 보장)
const MAX_CLUSTER_ADD_PER_SURGE = 3; // 급등 1종목당 클러스터 최대 3개

// 가격 범위
const MIN_PRICE = 1_000;
const MAX_PRICE = 2_000_000;

// 앵커 종목: 항상 워치리스트에 있어야 하는 초대형주 (삼성전자, SK하이닉스)
export const ANCHOR_STOCKS: { code: string; name: string }[] = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
];

/**
 * 앵커 종목이 워치리스트에서 빠진 경우 재편입 보장
 */
export async function ensureAnchorStocks(): Promise<void> {
  const pool = getPool();
  try {
    for (const anchor of ANCHOR_STOCKS) {
      const { rowCount } = await pool.query(
        `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
         VALUES ($1, $2, 'KOSPI', true, 'ANCHOR')
         ON CONFLICT (stock_code) DO UPDATE
           SET is_active = true
           WHERE watchlist.is_active = false`,
        [anchor.code, anchor.name],
      );
      if (rowCount && rowCount > 0) {
        logger.info(`⚓ 앵커 종목 워치리스트 재편입: ${anchor.name}(${anchor.code})`, { component: COMPONENT });
        await sendTelegramMessage(`⚓ 앵커 종목 재편입: ${anchor.name}(${anchor.code})`).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn(`앵커 종목 보장 실패: ${err}`, { component: COMPONENT });
  }
}

/**
 * 급등/거래대금 기반 실시간 워치리스트 편입
 * - 등락률 상위 + 거래량 상위 중복 포함하여 폭넓게 스캔
 * - AI 스코어 불필요: 거래대금이 품질 필터
 */
export async function runSurgeDetector(): Promise<void> {
  logger.info('급등/거래대금 감지 시작', { component: COMPONENT });

  try {
    // 앵커 종목 보장 (항상 실행)
    await ensureAnchorStocks();

    // KIS 즐겨찾기 → 워치리스트 동기화 (30분마다 재확인)
    // CEO가 KIS 앱에 추가한 종목이 즉시 감시목록에 반영됨
    try {
      const kisSync = await syncInterestGroups();
      if (kisSync.added.length > 0) {
        logger.info(`📲 KIS 즐겨찾기 신규 동기화: ${kisSync.added.join(', ')}`, { component: COMPONENT });
        await sendTelegramMessage(`📲 KIS 즐겨찾기 자동 편입: ${kisSync.added.join(', ')}`).catch(() => {});
      }
    } catch (kisErr) {
      logger.debug(`KIS 즐겨찾기 동기화 스킵: ${kisErr}`, { component: COMPONENT });
    }

    // KOSPI + KOSDAQ 등락률 상위 + 거래량 상위 병렬 조회
    const [kospiChg, kosdaqChg, kospiVol, kosdaqVol] = await Promise.all([
      getChangeRankingStocks(40, 'J').catch(() => []),
      getChangeRankingStocks(40, 'Q').catch(() => []),
      getVolumeRankingStocks('J', 30).catch(() => []),
      getVolumeRankingStocks('Q', 30).catch(() => []),
    ]);

    // 중복 제거
    const seen = new Set<string>();
    const candidates: { stock_code: string; stock_name: string }[] = [];
    for (const s of [...kospiChg, ...kosdaqChg, ...kospiVol, ...kosdaqVol]) {
      if (!s.stock_code || seen.has(s.stock_code)) continue;
      seen.add(s.stock_code);
      candidates.push(s);
    }

    if (candidates.length === 0) {
      logger.info('급등 후보 없음 (KIS 데이터 없음)', { component: COMPONENT });
      return;
    }

    // 현재 워치리스트 활성 종목
    const pool = getPool();
    const { rows: wlRows } = await pool.query(`SELECT stock_code FROM watchlist WHERE is_active = true`);
    const activeSet = new Set(wlRows.map((r: Record<string, unknown>) => String(r.stock_code)));

    // 이미 활성인 종목 제외
    const newCandidates = candidates.filter((s) => !activeSet.has(s.stock_code));

    if (newCandidates.length === 0) {
      logger.info('급등 후보 전원 이미 워치리스트 활성', { component: COMPONENT });
      return;
    }

    // 현재가/거래대금 조회 (병렬, 최대 40개)
    type SurgeCandidate = {
      stock_code: string;
      stock_name: string;
      changePct: number;
      tradingValue: number;
      reason: string;
    };

    const surgeList: SurgeCandidate[] = [];
    await Promise.allSettled(
      newCandidates.slice(0, 40).map(async (s) => {
        try {
          const p = await getCurrentPrice(s.stock_code);

          // 가격 범위 필터
          if (p.currentPrice < MIN_PRICE || p.currentPrice > MAX_PRICE) return;
          // 상폐 리스크 제외
          if (p.haltYn === 'Y' || p.mrktWarnClsCode >= '02') return;

          const tradingValue = p.currentPrice * p.volume; // 거래대금 추정 (원)
          const isMegaCap = p.marketCapEok >= MEGA_CAP_MARKET_CAP_EOK;

          const isSurge = p.changePct >= SURGE_CHANGE_PCT && tradingValue >= SURGE_TRADING_VALUE;
          const isMegaSurge = isMegaCap && p.changePct >= MEGA_CAP_CHANGE_PCT && tradingValue >= MEGA_CAP_TRADING_VALUE;

          if (isSurge || isMegaSurge) {
            const tVal = Math.round(tradingValue / 100_000_000); // 억원
            const mktCap = Math.round(p.marketCapEok / 10000); // 조원
            const reason = isMegaSurge
              ? `초대형주 ${p.changePct.toFixed(1)}% 시총${mktCap}조 거래대금${tVal}억`
              : `급등 ${p.changePct.toFixed(1)}% 거래대금${tVal}억`;

            surgeList.push({
              stock_code: s.stock_code,
              stock_name: p.stockName || s.stock_name,
              changePct: p.changePct,
              tradingValue,
              reason,
            });
          }
        } catch (err) {
          logger.debug(`급등감지 개별 시세 조회 실패: ${err}`, { component: COMPONENT });
        }
      }),
    );

    if (surgeList.length === 0) {
      logger.info(
        `급등 기준 미충족 — 후보 ${newCandidates.length}개 중 없음 (기준: +${SURGE_CHANGE_PCT}% & 거래대금 ${SURGE_TRADING_VALUE / 100_000_000}억+)`,
        { component: COMPONENT },
      );
      return;
    }

    // 거래대금 내림차순 정렬 (큰 돈이 몰린 종목 우선)
    surgeList.sort((a, b) => b.tradingValue - a.tradingValue);

    const toAdd = surgeList.slice(0, MAX_ADD_PER_RUN);
    const added: string[] = [];
    const clusterAdded: string[] = [];

    for (const item of toAdd) {
      try {
        const { rowCount } = await pool.query(
          `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
           VALUES ($1, $2, 'KOSPI', true, 'SURGE')
           ON CONFLICT (stock_code) DO UPDATE
             SET is_active = true, stock_name = EXCLUDED.stock_name, source = 'SURGE'
             WHERE watchlist.is_active = false`,
          [item.stock_code, item.stock_name],
        );
        if (rowCount && rowCount > 0) {
          added.push(`${item.stock_name}(${item.stock_code}) ${item.reason}`);
          logger.info(`⚡ 급등 편입: ${item.stock_name}(${item.stock_code}) — ${item.reason}`, {
            component: COMPONENT,
          });
          activeSet.add(item.stock_code); // 즉시 activeSet 갱신 (중복 방지)
        }
      } catch (err) {
        logger.warn(`편입 실패 ${item.stock_code}: ${err}`, { component: COMPONENT });
      }

      // 테마 클러스터 확장: 같은 테마 후행 종목 스윙 편입
      await expandThemeCluster(item.stock_code, item.stock_name, activeSet, pool, clusterAdded);

      await sleep(100);
    }

    if (added.length > 0) {
      await sendTelegramMessage(
        `⚡ 급등 워치리스트 편입 (${added.length}개)\n` + added.map((s) => `• ${s}`).join('\n'),
      ).catch(() => {});
    }
    if (clusterAdded.length > 0) {
      await sendTelegramMessage(
        `🔗 테마 클러스터 2차 편입 (${clusterAdded.length}개)\n` +
          clusterAdded.map((s) => `• ${s}`).join('\n'),
      ).catch(() => {});
    }

    logger.info(
      `급등 감지 완료 — 편입 ${added.length}개 / 클러스터 ${clusterAdded.length}개 / 후보 ${surgeList.length}개`,
      { component: COMPONENT },
    );
  } catch (err) {
    logger.error(`급등 감지 실패: ${err}`, { component: COMPONENT });
  }
}

/**
 * 급등 종목의 테마 클러스터 내 후행 종목 워치리스트 자동 편입
 *
 * 조건:
 *   - 같은 테마에 속해 있지만 아직 미급등 (changePct < 4.5%)
 *   - 유동성 확보 (거래대금 100억원+)
 *   - 가격 범위 정상
 *   - 1 급등주당 최대 3개
 *
 * 목적: 주도주 급등 → 테마 파급 수일 내 스윙 매매 공략
 */
async function expandThemeCluster(
  surgedCode: string,
  surgedName: string,
  activeSet: Set<string>,
  pool: ReturnType<typeof getPool>,
  clusterAdded: string[],
): Promise<void> {
  const followers = getClusterFollowers(surgedCode, activeSet);
  if (followers.length === 0) return;

  // Collect validated candidates first, then process sequentially to avoid race condition
  // on shared addedCount across Promise.allSettled callbacks
  type ClusterCandidate = {
    code: string;
    name: string;
    clusterName: string;
    changePct: number;
    tradingValue: number;
  };
  const validatedCandidates: ClusterCandidate[] = [];

  await Promise.allSettled(
    followers.map(async (f) => {
      try {
        const p = await getCurrentPrice(f.code);

        if (p.currentPrice < MIN_PRICE || p.currentPrice > MAX_PRICE) return;
        if (p.haltYn === 'Y' || p.mrktWarnClsCode >= '02') return;

        const tradingValue = p.currentPrice * p.volume;
        if (tradingValue < CLUSTER_MIN_TRADING_VALUE) return;

        if (p.changePct < CLUSTER_MIN_CHANGE || p.changePct >= CLUSTER_MAX_CHANGE) return;

        if (activeSet.has(f.code)) return;

        validatedCandidates.push({
          code: f.code,
          name: p.stockName || f.name,
          clusterName: f.clusterName,
          changePct: p.changePct,
          tradingValue,
        });
      } catch (err) {
        logger.debug(`클러스터 후보 시세 조회 실패: ${err}`, { component: COMPONENT });
      }
    }),
  );

  // Process sequentially — no race condition on addedCount
  let addedCount = 0;
  for (const candidate of validatedCandidates) {
    if (addedCount >= MAX_CLUSTER_ADD_PER_SURGE) break;
    if (activeSet.has(candidate.code)) continue;

    const tVal = Math.round(candidate.tradingValue / 100_000_000);
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
         VALUES ($1, $2, 'KOSPI', true, 'THEME_CLUSTER')
         ON CONFLICT (stock_code) DO UPDATE
           SET is_active = true, stock_name = EXCLUDED.stock_name, source = 'THEME_CLUSTER'
           WHERE watchlist.is_active = false`,
        [candidate.code, candidate.name],
      );

      if (rowCount && rowCount > 0) {
        addedCount++;
        activeSet.add(candidate.code);
        const label = `${candidate.name}(${candidate.code}) [${candidate.clusterName}] ${candidate.changePct.toFixed(1)}% 거래대금${tVal}억 ← ${surgedName} 파급`;
        clusterAdded.push(label);
        logger.info(`🔗 테마클러스터 편입: ${label}`, { component: COMPONENT });
      }
    } catch (err) {
      logger.debug(`클러스터 워치리스트 추가 실패: ${err}`, { component: COMPONENT });
    }
  }
}
