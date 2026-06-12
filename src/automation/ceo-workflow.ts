import { getCtxIsPaper } from '../config/context.js';
import { getActiveStrategy, getActiveWatchlist, getOpenChains, logSystem } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { getPaperBalance } from '../risk/engine.js';
import { logger } from '../utils/logger.js';

/**
 * 🎯 CEO 워크플로우 자동화
 *
 * CEO의 역할:
 * 1. 괜찮다고 생각하는 기업/종목만 찝어줌 (감시 목록에 추가)
 * 2. 시장 상황에 맞는 프롬프트 가이드 설정
 * 3. 나머지는 시스템이 알아서
 *
 * 이 모듈은 CEO가 감시 목록을 바꿀 때 자동으로:
 * - 새 종목 추가 → 즉시 Track A 분석 트리거
 * - 종목 제거 → 해당 포지션 자동 정리
 * - 시장 나빠짐 → CEO의 "안전" 종목으로 자금 파킹
 * - 시장 풀림 → 파킹 해제, 공격적 재배치
 *
 * 돈의 흐름:
 *
 *   [CEO 종목 선정] → [AI 분석] → [자동 매수]
 *         ↑                              ↓
 *   [시장 회복]          [보유 중 / 수익 중]
 *         ↑                              ↓
 *   [자금 해방] ← [익절/손절/기회비용 정리]
 *         ↓
 *   [다음 기회에 자동 재투자]
 *
 *   💡 핵심: 돈이 절대 고여있지 않음
 */

/**
 * 포트폴리오 상태 요약 (CEO가 한눈에 파악)
 */
export async function getPortfolioFlowStatus() {
  const balance = getCtxIsPaper() ? await getPaperBalance() : await getAccountBalance(true);
  const chains = await getOpenChains();
  const watchlist = await getActiveWatchlist();
  const strategy = await getActiveStrategy();

  const totalPortfolio = balance.totalDeposit + balance.totalEvalAmount;
  const cashRatio = totalPortfolio > 0 ? (balance.orderableCash / totalPortfolio) * 100 : 100;
  const investedRatio = 100 - cashRatio;

  // 종목별 자금 배분 현황
  const allocation = chains.map((chain) => {
    const invested = Number(chain.avg_buy_price) * chain.total_quantity;
    const pct = totalPortfolio > 0 ? (invested / totalPortfolio) * 100 : 0;
    return {
      stockCode: chain.stock_code,
      invested,
      pct,
      status: chain.status,
      averagingCount: chain.current_averaging_count,
    };
  });

  // 감시 목록 중 아직 진입 안 한 종목
  const activeStockCodes = new Set(chains.map((c) => c.stock_code));
  const pendingStocks = watchlist.filter((w) => !activeStockCodes.has(w.stock_code));

  // 자금 흐름 상태 판단
  let flowStatus: 'FLOWING' | 'PARTIALLY_STUCK' | 'STUCK';
  let flowMessage: string;

  if (cashRatio >= 30) {
    flowStatus = 'FLOWING';
    flowMessage = `현금 ${cashRatio.toFixed(0)}% 충분 — 새 기회 즉시 진입 가능`;
  } else if (cashRatio >= 15) {
    flowStatus = 'PARTIALLY_STUCK';
    flowMessage = `현금 ${cashRatio.toFixed(0)}% — 여유 부족, 기존 포지션 정리 후 진입`;
  } else {
    flowStatus = 'STUCK';
    flowMessage = `현금 ${cashRatio.toFixed(0)}% 위험 — 자금 고여있음, 자동 재배치 필요`;
  }

  return {
    totalPortfolio,
    cash: balance.orderableCash,
    cashRatio,
    investedRatio,
    flowStatus,
    flowMessage,
    mode: strategy?.mode ?? 'SWING',
    activePositions: chains.length,
    pendingStocks: pendingStocks.length,
    allocation,
    pendingStockCodes: pendingStocks.map((s) => s.stock_code),
  };
}

/**
 * CEO가 종목을 추가했을 때 자동 트리거
 */
export async function onStockAdded(stockCode: string, stockName: string): Promise<void> {
  logger.info(`CEO 종목 추가: ${stockName} (${stockCode})`, { component: 'CEO_FLOW' });

  await sendTelegramMessage(`📌 *종목 추가됨*: ${stockName} (${stockCode})\n즉시 AI 분석 시작합니다 (2~5분 소요)`);

  // Track A 즉시 트리거 (fire-and-forget — isRunning 가드가 중복 실행 방지)
  try {
    const { runTrackAJob } = await import('../scheduler/track-a-job.js');
    runTrackAJob().catch((err) => {
      logger.warn(`CEO 종목 추가 후 즉시 Track A 실패: ${err}`, { component: 'CEO_FLOW' });
    });
    logger.info(`CEO 종목 추가 → Track A 즉시 트리거`, { component: 'CEO_FLOW' });
  } catch (err) {
    logger.warn(`Track A 트리거 실패 (다음 스케줄에서 분석): ${err}`, { component: 'CEO_FLOW' });
  }

  await logSystem('INFO', 'CEO_FLOW', `종목 추가: ${stockName} (${stockCode}) → Track A 즉시 실행`);
}

/**
 * CEO가 종목을 제거했을 때 → 포지션 자동 정리
 */
export async function onStockRemoved(stockCode: string): Promise<void> {
  const chains = await getOpenChains();
  const activeChain = chains.find((c) => c.stock_code === stockCode && c.total_quantity > 0);

  if (activeChain) {
    logger.warn(`CEO 종목 제거: ${stockCode} — 보유 중이므로 자동 청산`, { component: 'CEO_FLOW' });

    const { tradeExecutor } = await import('../trading/executor.js');
    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as any;

    await tradeExecutor.processDecisions(
      [
        {
          action: 'FORCE_CLOSE',
          stock_code: stockCode,
          quantity: activeChain.total_quantity,
          price_type: 'MARKET',
          reasoning: `CEO가 감시 목록에서 제거 → 자동 청산`,
          confidence: 1.0,
        },
      ],
      mode,
      'CEO_FLOW',
    );

    await sendTelegramMessage(
      `🔓 *종목 제거 + 자동 청산*: ${stockCode}\n` + `보유 ${activeChain.total_quantity}주 시장가 매도 실행`,
    );
  } else {
    await sendTelegramMessage(`📤 종목 제거: ${stockCode} (보유 없음, 분석만 중단)`);
  }
}

/**
 * 시장 모드 전환 시 자금 재배치 가이드
 */
export async function onModeSwitch(fromMode: string, toMode: string): Promise<void> {
  if (fromMode === toMode) return;

  const chains = await getOpenChains();
  const balance = getCtxIsPaper() ? await getPaperBalance() : await getAccountBalance(true);

  if (toMode === 'DEFENSE') {
    // 시장 나빠짐 → 기존 포지션 중 손실 종목 빠르게 정리
    const losingPositions = [];
    for (const chain of chains) {
      if (chain.total_quantity <= 0) continue;
      try {
        const price = await getCurrentPriceSafe(chain.stock_code);
        if (price) {
          const pnlPct = ((price - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100;
          if (pnlPct < -1) {
            losingPositions.push({ stockCode: chain.stock_code, pnlPct });
          }
        }
      } catch {
        /* skip */
      }
    }

    if (losingPositions.length > 0) {
      await sendTelegramMessage(
        `🔴 *방어 모드 전환*\n\n` +
          `손실 포지션 ${losingPositions.length}개 감지:\n` +
          losingPositions.map((p) => `  ${p.stockCode}: ${p.pnlPct.toFixed(1)}%`).join('\n') +
          `\n\n자동 자금흐름 최적화가 다음 주기에 정리합니다.`,
      );
    }
  } else if (toMode === 'SWING' && fromMode === 'DEFENSE') {
    // 시장 풀림 → 현금 비율 확인, 재투자 준비
    const totalPortfolio = balance.totalDeposit + balance.totalEvalAmount;
    const cashRatio = totalPortfolio > 0 ? (balance.orderableCash / totalPortfolio) * 100 : 100;

    await sendTelegramMessage(
      `🟢 *스윙 모드 복귀!*\n\n` +
        `현금 ${cashRatio.toFixed(0)}% (${balance.orderableCash.toLocaleString()}원) 투자 대기 중\n` +
        `다음 Track B에서 매수 후보 자동 진입 시작`,
    );
  }
}

async function getCurrentPriceSafe(stockCode: string): Promise<number | null> {
  try {
    const { getCurrentPrice } = await import('../kis/market.js');
    const price = await getCurrentPrice(stockCode);
    return price.currentPrice;
  } catch {
    return null;
  }
}
