/**
 * Track B 파이프라인 데이터 로더
 * (pipeline.ts에서 추출)
 *
 * DB + KIS 잔고 병렬 로드, 네트워크 장애 시 인메모리 폴백
 */
import { INVERSE_ETF_CODES } from '../../automation/crash-profit.js';
import { getCtxIsPaper } from '../../config/context.js';
import {
  enableMemoryMode,
  getActiveWatchlist,
  getActiveStrategy,
  getBigLossBlockedStocks,
  getLossHistory,
  getOpenChains,
  getPool,
  getRecentLossStocks,
  getRecentlySoldStocks,
  getRecentManuallySoldStocks,
  getTodayRepeatStopCodes,
} from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getPaperBalance } from '../../risk/paper-balance.js';
import { logger } from '../../utils/logger.js';
import { getMemoryCooldownCodes } from './sell-cooldown.js';

export interface PipelineData {
  watchlist: Awaited<ReturnType<typeof getActiveWatchlist>>;
  openChains: Awaited<ReturnType<typeof getOpenChains>>;
  strategy: Awaited<ReturnType<typeof getActiveStrategy>>;
  recentLossCodes: Awaited<ReturnType<typeof getRecentLossStocks>>;
  manuallySoldCodes: Awaited<ReturnType<typeof getRecentManuallySoldStocks>>;
  todayRepeatStopCodes: Awaited<ReturnType<typeof getTodayRepeatStopCodes>>;
  bigLossBlocked: Awaited<ReturnType<typeof getBigLossBlockedStocks>>;
  recentlySoldCodes: Awaited<ReturnType<typeof getRecentlySoldStocks>>;
  balance: any;
  lossHistory: Awaited<ReturnType<typeof getLossHistory>>;
  ctxIsPaper: boolean;
  /** 동시호가 PENDING 주문 종목 — Track B 중복매수 방지 */
  pendingPreMarketCodes: Set<string>;
}

/**
 * DB + KIS 데이터 병렬 로드
 *
 * 1차: watchlist, openChains, strategy, recentLossCodes, manuallySoldCodes
 * 2차: todayRepeatStopCodes, bigLossBlocked, recentlySoldCodes, balance, lossHistory
 * + 인메모리 쿨다운 병합 + 인버스 ETF 쿨다운 예외 처리
 */
export async function loadPipelineData(): Promise<PipelineData> {
  // ── 1차 쿼리: DB 연결 실패 시 인메모리 폴백 ──
  const dbLoadWithFallback = async () => {
    try {
      return await Promise.all([
        getActiveWatchlist(),
        getOpenChains(getCtxIsPaper()),
        getActiveStrategy(),
        getRecentLossStocks(getCtxIsPaper() ? 1 : 5), // Paper: 1일 쿨다운 (7일 → 적극적 데이터 수집)
        getRecentManuallySoldStocks(24),
      ]);
    } catch (dbErr: unknown) {
      const errObj = dbErr as { message?: string; code?: string };
      const msg = String(errObj?.message ?? dbErr).toLowerCase();
      const code = String(errObj?.code ?? '');
      const isNetworkErr =
        ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code) ||
        msg.includes('timeout') ||
        msg.includes('terminated') ||
        msg.includes('econnrefused') ||
        msg.includes('connection') ||
        msg.includes('enotfound');
      if (isNetworkErr) {
        logger.warn(`⚡ DB 연결 실패 → 인메모리 모드로 전환: [${code}] ${msg}`, { component: 'TRACK_B' });
        enableMemoryMode();
        return await Promise.all([
          getActiveWatchlist(),
          getOpenChains(getCtxIsPaper()),
          getActiveStrategy(),
          getRecentLossStocks(getCtxIsPaper() ? 1 : 5), // Paper: 1일 쿨다운
          getRecentManuallySoldStocks(24),
        ]);
      }
      throw dbErr;
    }
  };

  const [watchlist, openChains, strategy, recentLossCodes, manuallySoldCodes] = await dbLoadWithFallback();
  const ctxIsPaper = getCtxIsPaper();

  // ── 2차 쿼리 병렬 실행 ──
  const [todayRepeatStopCodes, bigLossBlocked, recentlySoldCodes, balanceRaw, lossHistory, pendingPreMarketCodes] = await Promise.all([
    getTodayRepeatStopCodes(ctxIsPaper ? 3 : 1),  // paper: 3회 이상만 차단 (오전 손절→오후 회복 재진입 허용)
    getBigLossBlockedStocks(),        // -5% 초과 손실 → 30일 절대 차단 (레거시 폴백)
    getRecentlySoldStocks(4),          // v10.3: 최근 4시간 매도 → 재진입 쿨다운 (반복매매=적자 주범)
    ctxIsPaper ? getPaperBalance() : getAccountBalance(true),
    getLossHistory(),                 // 90일 손실 이력 → 스마트 재진입
    // 동시호가 PENDING 주문 종목 조회 — Track B 중복매수 방지
    getPool().query(
      `SELECT DISTINCT stock_code FROM orders
       WHERE trigger_source = 'PRE_MARKET_ORDER' AND status IN ('PENDING', 'FILLED')
         AND is_paper = $1 AND created_at >= CURRENT_DATE
       `,
      [ctxIsPaper],
    ).then(({ rows }) => new Set(rows.map((r: any) => r.stock_code as string))).catch(() => new Set<string>()),
  ]);

  // v10.4: 인메모리 쿨다운 병합 (DB 반영 전 매도도 차단)
  for (const code of getMemoryCooldownCodes(ctxIsPaper)) recentlySoldCodes.add(code);
  // 인버스 ETF는 쿨다운 예외 — 하락장 지속 시 즉시 재진입 가능해야 함
  for (const code of INVERSE_ETF_CODES) recentlySoldCodes.delete(code);
  if (todayRepeatStopCodes.size > 0) {
    logger.warn(`🚫 당일 반복손절 재진입 차단: ${[...todayRepeatStopCodes].join(', ')}`, { component: 'TRACK_B' });
  }

  return {
    watchlist,
    openChains,
    strategy,
    recentLossCodes,
    manuallySoldCodes,
    todayRepeatStopCodes,
    bigLossBlocked,
    recentlySoldCodes,
    balance: balanceRaw as any,
    lossHistory,
    ctxIsPaper,
    pendingPreMarketCodes,
  };
}
