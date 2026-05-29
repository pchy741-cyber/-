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
 * 장후 시간외 잡 (15:42 1회 실행)
 *
 * Track B는 15:30 이후 isMarketOpen()=false로 스킵됨.
 * 이 잡은 시간외 단일가(15:40~16:00)에:
 * 1. 보유종목 수익확정 매도 (수익 +0.3% 이상만, 손실/보합은 패스)
 * 2. 급락 종목 매수 (줍줍/바닥낚시)
 *
 * 서버비 절감: 15:42에 1회만 실행 (15:52는 매수만)
 */
export async function runAfterHoursJob(): Promise<void> {
  const kst = new Date(Date.now() + 9 * 3600000);
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();

  // 15:40~15:55 에서만 실행 (Paper 모드: 시간 제한 없이 테스트 가능)
  if (!config.isPaper && (kstH !== 15 || kstM < 40 || kstM > 55)) {
    logger.debug('시간외: 시간 범위 밖 — 스킵', { component: 'AFTER_HOURS' });
    return;
  }

  logger.info('🌙 시간외 잡 시작', { component: 'AFTER_HOURS' });

  try {
    // ═══════════════════════════════════════════════════════════
    //  STEP 0: 보유종목 수익확정 매도 (15:42 첫 실행에서 1회만)
    //  - 수익 +0.3% 이상 → 시간외 단일가 매도 (수수료 0.21% 커버)
    //  - 손실/보합 → 패스 (익일 장중에 판단)
    //  - Kill Switch 무관 (매도=탈출이므로 항상 실행)
    // ═══════════════════════════════════════════════════════════
    const openChains = await getOpenChains();

    if (openChains.length > 0) {
      const holdingCodes = openChains.map((c) => c.stock_code);
      const holdingPrices = await getBatchPrices(holdingCodes);

      const sellDecisions: import('../db/models.js').TradeDecision[] = [];

      for (const chain of openChains) {
        if (chain.total_quantity <= 0) continue;
        const avgBuy = Number(chain.avg_buy_price);
        if (avgBuy <= 0) continue;

        const priceData = holdingPrices.get(chain.stock_code);
        const curPrice = priceData?.currentPrice ?? 0;
        if (curPrice <= 0) continue;

        const pnlPct = ((curPrice - avgBuy) / avgBuy) * 100;

        // 수익 +1.0% 이상만 매도 (수수료 0.21% + 시간외 슬리피지 + 실질 이익 확보)
        if (pnlPct >= 1.0) {
          logger.info(
            `🌙 시간외 수익확정: ${chain.stock_code} +${pnlPct.toFixed(2)}% (평단 ${avgBuy.toLocaleString()} → 현재 ${curPrice.toLocaleString()}) → 전량 매도`,
            { component: 'AFTER_HOURS' },
          );
          sellDecisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `시간외 수익확정: +${pnlPct.toFixed(2)}% (장마감 후 단일가 매도)`,
            confidence: 0.9,
          });
        } else {
          logger.info(
            `🌙 시간외 패스: ${chain.stock_code} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% → 손실/보합 유지 (익일 판단)`,
            { component: 'AFTER_HOURS' },
          );
        }
      }

      if (sellDecisions.length > 0) {
        const strategy = await getActiveStrategy();
        const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
        await tradeExecutor.processDecisions(sellDecisions, mode);
        reportSuccess();

        const sellSummary = sellDecisions
          .map((d) => `  • ${d.stock_code} x${d.quantity} — ${d.reasoning}`)
          .join('\n');
        await sendTelegramMessage(`🌙 시간외 수익확정 매도 ${sellDecisions.length}건\n${sellSummary}`).catch(() => {});
        await logSystem('INFO', 'AFTER_HOURS', `시간외 수익확정: ${sellDecisions.length}건 매도`);
      } else {
        logger.info('시간외 수익확정: 매도 대상 없음 (수익종목 없음)', { component: 'AFTER_HOURS' });
      }
    }

    // ═══════════════════════════════════════════════════════════
    //  STEP 1: 시간외 줍줍 매수 (기존 로직)
    //  - Kill Switch 활성 시 매수만 차단 (위 매도는 이미 실행됨)
    // ═══════════════════════════════════════════════════════════
    if (isKillSwitchActive()) {
      logger.debug('🛑 Kill Switch 활성 — 시간외 매수 스킵 (매도는 이미 실행됨)', { component: 'AFTER_HOURS' });
      return;
    }

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
    const [watchlist, latestChains] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
    ]);

    const watchlistCodes = watchlist.map((w) => w.stock_code);
    const scannedCodes = scannedStocks.map((s) => s.stock_code);
    const allCodes = [...new Set([
      ...EOD_BLUECHIP_CODES,
      ...watchlistCodes,
      ...scannedCodes,
      ...latestChains.map((c) => c.stock_code),
    ])];

    // 2. 시세 조회
    const livePrices = await getBatchPrices(allCodes);

    // 3. 코스피 상태 확인
    const kospiRegime = await fetchKospiRegime().catch(() => ({
      penalty: 0, boost: false, todayDown: false, flashCrash: false,
    }));

    // 4. 포지션 크기 계산 (보수적: 총자산의 10% 이내)
    const balance = latestChains.reduce((sum, c) => {
      const price = livePrices.get(c.stock_code)?.currentPrice ?? Number(c.avg_buy_price ?? 0);
      return sum + price * Number(c.total_quantity ?? 0);
    }, 0);
    const adjMaxPositionKrw = Math.max(500_000, balance * 0.10);

    // 5. 시간외 줍줍 전략 실행
    const decisions = applyEodBluechipStrategy([], {
      kstH, kstM, openChains: latestChains, livePrices,
      todayDown: kospiRegime.todayDown,
      kospiPenalty: kospiRegime.penalty,
      adjMaxPositionKrw,
      blockNewBuys: false,
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
    logger.error(`시간외 잡 실패: ${msg}`, { component: 'AFTER_HOURS' });
    await logSystem('ERROR', 'AFTER_HOURS', `시간외 잡 실패: ${msg}`);
  }
}
