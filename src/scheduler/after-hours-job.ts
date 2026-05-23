import { getActiveWatchlist, getOpenChains, logSystem } from '../db/client.js';
import { getBatchPrices } from '../kis/market.js';
import { isKillSwitchActive, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { applyEodBluechipStrategy, EOD_BLUECHIP_CODES } from '../ai/track-b/eod-bluechip.js';
import { fetchKospiRegime } from '../ai/track-b/market-regime.js';
import { config } from '../config/index.js';
import type { StrategyMode } from '../config/constants.js';
import { getActiveStrategy } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { runBottomFishingScanner } from '../automation/bottom-fishing-scanner.js';

/**
 * 장후 시간외 줍줍 잡 (15:42, 15:52 실행)
 *
 * Track B는 15:30 이후 isMarketOpen()=false로 스킵됨.
 * 이 잡은 시간외 단일가(15:40~16:00)에 급락 종목 매수 전용.
 * - 블루칩 + 워치리스트 종목 중 당일 -1.5% 이상 급락
 * - executor가 시간외 ORD_DVSN '06' 자동 적용
 * - 익일 09:05~09:25 Track B의 EOD 익일청산에서 자동 매도
 */
export async function runAfterHoursJob(): Promise<void> {
  if (isKillSwitchActive()) {
    logger.debug('🛑 Kill Switch 활성 — 시간외 줍줍 스킵', { component: 'AFTER_HOURS' });
    return;
  }

  const kst = new Date(Date.now() + 9 * 3600000);
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();

  // 15:40~15:55 에서만 실행
  if (kstH !== 15 || kstM < 40 || kstM > 55) {
    logger.debug('시간외 줍줍: 시간 범위 밖 — 스킵', { component: 'AFTER_HOURS' });
    return;
  }

  logger.info('🌙 시간외 줍줍 잡 시작', { component: 'AFTER_HOURS' });

  try {
    // 0. 바닥낚시 스캐너 실행 (시장 전체 RSI 과매도 스캔)
    let scannedStocks: Awaited<ReturnType<typeof runBottomFishingScanner>> = [];
    try {
      scannedStocks = await runBottomFishingScanner();
      if (scannedStocks.length > 0) {
        logger.info(
          `🎣 바닥낚시 스캐너: ${scannedStocks.length}종목 발견 — ${scannedStocks.map((s) => `${s.stock_name}(${s.changePct.toFixed(1)}%)`).join(', ')}`,
          { component: 'AFTER_HOURS' },
        );
      }
    } catch (err) {
      logger.warn(`바닥낚시 스캐너 실패 (무시): ${err}`, { component: 'AFTER_HOURS' });
    }

    // 1. 워치리스트 + 보유 종목 + 블루칩 + 스캔 종목 코드 수집
    const [watchlist, openChains] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
    ]);

    const watchlistCodes = watchlist.map((w) => w.stock_code);
    const scannedCodes = scannedStocks.map((s) => s.stock_code);
    const allCodes = [...new Set([
      ...EOD_BLUECHIP_CODES,
      ...watchlistCodes,
      ...scannedCodes,
      ...openChains.map((c) => c.stock_code),
    ])];

    // 2. 시세 조회
    const livePrices = await getBatchPrices(allCodes);

    // 3. 코스피 상태 확인
    const kospiRegime = await fetchKospiRegime().catch(() => ({
      penalty: 0, boost: false, todayDown: false, flashCrash: false,
    }));

    // 4. 포지션 크기 계산 (보수적: 총자산의 10% 이내)
    const balance = openChains.reduce((sum, c) => {
      const price = livePrices.get(c.stock_code)?.currentPrice ?? Number(c.avg_buy_price ?? 0);
      return sum + price * Number(c.total_quantity ?? 0);
    }, 0);
    const adjMaxPositionKrw = Math.max(500_000, balance * 0.10); // 최소 50만, 최대 총자산 10%

    // 5. 시간외 줍줍 전략 실행
    const decisions = applyEodBluechipStrategy([], {
      kstH, kstM, openChains, livePrices,
      todayDown: kospiRegime.todayDown,
      kospiPenalty: kospiRegime.penalty,
      adjMaxPositionKrw,
      blockNewBuys: false, // 시간외 전용 잡이므로 매수 허용
      watchlistCodes,
      scannedStocks,
    });

    if (decisions.length === 0) {
      logger.info('시간외 줍줍: 매수 조건 불충족 (급락 종목 없음)', { component: 'AFTER_HOURS' });
      return;
    }

    // 6. 전략 모드 확인 + 매매 실행
    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
    await tradeExecutor.processDecisions(decisions, mode);
    reportSuccess();

    // 7. 텔레그램 알림
    const buys = decisions.filter((d) => d.action === 'BUY');
    if (buys.length > 0) {
      const fishingCount = buys.filter((d) => d.strategy_mode === 'BOTTOM_FISHING').length;
      const eodCount = buys.length - fishingCount;
      const msg = buys
        .map((d) => `  • ${d.strategy_mode === 'BOTTOM_FISHING' ? '🎣' : '🌙'} ${d.stock_code} x${d.quantity} — ${d.reasoning}`)
        .join('\n');
      const label = [
        eodCount > 0 ? `줍줍 ${eodCount}건` : '',
        fishingCount > 0 ? `바닥낚시 ${fishingCount}건` : '',
      ].filter(Boolean).join(' + ');
      await sendTelegramMessage(`🌙 시간외 ${label}\n${msg}`).catch(() => {});
    }

    await logSystem('INFO', 'AFTER_HOURS', `시간외 줍줍: ${decisions.length}건 실행`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`시간외 줍줍 실패: ${msg}`, { component: 'AFTER_HOURS' });
    await logSystem('ERROR', 'AFTER_HOURS', `시간외 줍줍 실패: ${msg}`);
  }
}
