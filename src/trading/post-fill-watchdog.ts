/**
 * Post-Fill Watchdog — 체결 즉시 포지션 보호
 *
 * 근거:
 * - NautilusTrader/MMR 등 주요 알고 프레임워크의 bracket order 표준 패턴
 * - KIS API에 조건부/트레일링/브라켓 주문 미지원 → 앱 레이어 구현
 * - 기존 0-180초 무보호 갭 제거 (Track B 2분 + holding-check 10분 사이클 사이)
 *
 * 동작:
 * 1. BUY 체결 직후 → TP가에 KIS LIMIT SELL 등록 (브로커 측 보호)
 * 2. 10초 간격 SL 폴링 (첫 5분) → 15초 (30분까지)
 * 3. 30분 후 holding-check-job 인계
 * 4. SL 트리거 시: TP 주문 취소 → MARKET SELL 즉시 실행
 */
import { getCtxIsPaper, runWithMode } from '../config/context.js';
import { getPool } from '../db/client.js';
import { getCurrentPrice } from '../kis/market.js';
import { cancelOrder, placeOrder } from '../kis/order.js';
import { OrderType, type StrategyMode } from '../config/constants.js';
import { adjustToTickSize } from '../utils/money.js';
import { logger } from '../utils/logger.js';
import { getCachedPriceMemory } from '../cache/memory.js';
import { calculateATR } from '../automation/position-sizer.js';

// ── Types ──

interface WatchdogEntry {
  chainId: string;
  stockCode: string;
  avgBuyPrice: number;
  quantity: number;
  stopLossPct: number;
  takeProfitPct: number;
  tpOrderNo: string | null;
  startedAt: number;
  isPaper: boolean;
  strategyMode: StrategyMode;
  // v23: Chandelier Exit 트레일링 (근거: 승률 51.3%, PF 1.61 — stratbase.ai backtest)
  peakPrice: number; // 진입 후 최고가 추적
  atrValue: number; // ATR(14) 값 (원) — 진입 시 계산
}

// ── State ──

const _watchdogs = new Map<string, { entry: WatchdogEntry; timer: ReturnType<typeof setInterval> }>();

const PHASE1_MS = 5 * 60_000; // 5분: 10초 간격 급속 모니터링
const TOTAL_MS = 30 * 60_000; // 30분: 워치독 총 운영 시간

// ── Public API ──

/**
 * 체결 직후 워치독 시작
 * executor.ts의 chainManager.openChain() 직후 호출
 */
export async function startWatchdog(params: {
  chainId: string;
  stockCode: string;
  avgBuyPrice: number;
  quantity: number;
  stopLossPct: number;
  takeProfitPct: number;
  isPaper: boolean;
  strategyMode: StrategyMode;
}): Promise<void> {
  // 이미 동일 체인에 워치독이 있으면 중복 방지
  if (_watchdogs.has(params.chainId)) return;

  // 1. TP가에 LIMIT SELL 주문 등록 (실거래만 — paper는 시뮬레이션)
  const tpPrice = adjustToTickSize(Math.round(params.avgBuyPrice * (1 + params.takeProfitPct / 100)));
  let tpOrderNo: string | null = null;

  if (!params.isPaper && tpPrice > 0) {
    try {
      const result = await placeOrder({
        stockCode: params.stockCode,
        side: 'SELL',
        quantity: params.quantity,
        price: tpPrice,
        orderType: OrderType.LIMIT,
      });
      if (result.success) {
        tpOrderNo = result.orderNo;
        logger.info(
          `🛡️ 워치독 TP 주문: ${params.stockCode} ${tpPrice.toLocaleString()}원 (${params.takeProfitPct}%) #${result.orderNo}`,
          { component: 'WATCHDOG' },
        );
      }
    } catch (e) {
      logger.warn(`워치독 TP 주문 실패 (무시): ${params.stockCode} ${(e as Error).message}`, {
        component: 'WATCHDOG',
      });
    }
  }

  // 2. v23: Chandelier Exit용 ATR 계산 + 고점 초기화
  let atrValue = 0;
  try {
    atrValue = await calculateATR(params.stockCode);
  } catch { /* ATR 실패 시 0 → Chandelier 비활성, 기존 SL만 사용 */ }
  const entry: WatchdogEntry = {
    ...params,
    tpOrderNo,
    startedAt: Date.now(),
    peakPrice: params.avgBuyPrice,
    atrValue,
  };
  await saveState(entry);

  // 3. 폴링 타이머 시작
  startTimer(entry);

  logger.info(
    `🛡️ 워치독 시작: ${params.stockCode} SL=${params.stopLossPct}% TP=${params.takeProfitPct}% ` +
      `(${params.isPaper ? 'PAPER' : 'LIVE'})`,
    { component: 'WATCHDOG' },
  );
}

/**
 * 특정 종목의 TP 주문 취소 (다른 매도 메커니즘 실행 전 호출)
 * executor.ts의 executeClose() 앞에서 호출
 */
export async function cancelWatchdogTpOrder(stockCode: string): Promise<void> {
  for (const [chainId, w] of _watchdogs) {
    if (w.entry.stockCode === stockCode && w.entry.tpOrderNo) {
      try {
        await cancelOrder({
          orderNo: w.entry.tpOrderNo,
          stockCode,
          quantity: w.entry.quantity,
        });
        logger.info(`🛡️ 워치독 TP 취소: ${stockCode} #${w.entry.tpOrderNo}`, { component: 'WATCHDOG' });
      } catch (e) {
        logger.warn(`워치독 TP 취소 실패 (무시): ${stockCode} ${(e as Error).message}`, {
          component: 'WATCHDOG',
        });
      }
      w.entry.tpOrderNo = null;
      stopWatchdog(chainId, 'TP 취소 (외부 매도)');
    }
  }
}

/**
 * 서버 재시작 후 워치독 복구
 * runner.ts 시작 시 호출
 */
export async function recoverWatchdogs(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ key: string; value: string }>(
      `SELECT key, value FROM system_state WHERE key LIKE 'watchdog_%'`,
    );

    let recovered = 0;
    for (const row of rows) {
      try {
        const entry = JSON.parse(row.value) as WatchdogEntry;
        // v23: 이전 형식 호환 (peakPrice/atrValue 없는 기존 상태)
        if (entry.peakPrice == null) entry.peakPrice = entry.avgBuyPrice;
        if (entry.atrValue == null) entry.atrValue = 0;
        const elapsed = Date.now() - entry.startedAt;

        if (elapsed >= TOTAL_MS) {
          // 만료 → 정리
          await removeState(entry.chainId);
          continue;
        }

        startTimer(entry);
        recovered++;
      } catch {
        // 손상된 엔트리 무시
        await getPool()
          .query(`DELETE FROM system_state WHERE key = $1`, [row.key])
          .catch(() => {});
      }
    }

    if (recovered > 0) {
      logger.info(`🛡️ 워치독 복구: ${recovered}개 재시작`, { component: 'WATCHDOG' });
    }
  } catch (e) {
    logger.warn(`워치독 복구 실패 (무시): ${(e as Error).message}`, { component: 'WATCHDOG' });
  }
}

// ── Internal ──

function startTimer(entry: WatchdogEntry): void {
  // 이미 있으면 중복 방지
  if (_watchdogs.has(entry.chainId)) return;

  const intervalMs = (Date.now() - entry.startedAt) < PHASE1_MS ? 10_000 : 15_000;
  const timer = setInterval(() => {
    void runWithMode(entry.isPaper, () => checkSL(entry));
  }, intervalMs);
  timer.unref();

  _watchdogs.set(entry.chainId, { entry, timer });

  // Phase 전환: 5분 후 15초 간격으로 변경
  const remaining1 = PHASE1_MS - (Date.now() - entry.startedAt);
  if (remaining1 > 0) {
    const phaseTimer = setTimeout(() => {
      const w = _watchdogs.get(entry.chainId);
      if (!w) return;
      clearInterval(w.timer);
      const newTimer = setInterval(() => {
        void runWithMode(entry.isPaper, () => checkSL(entry));
      }, 15_000);
      newTimer.unref();
      _watchdogs.set(entry.chainId, { entry: w.entry, timer: newTimer });
    }, remaining1);
    phaseTimer.unref();
  }

  // 30분 후 자동 종료
  const remaining = TOTAL_MS - (Date.now() - entry.startedAt);
  if (remaining > 0) {
    const autoStop = setTimeout(() => stopWatchdog(entry.chainId, '30분 인계'), remaining);
    autoStop.unref();
  }
}

async function checkSL(entry: WatchdogEntry): Promise<void> {
  try {
    // 현재가 조회 (paper: 메모리 캐시, live: KIS API)
    let currentPrice: number;
    if (entry.isPaper) {
      const cached = getCachedPriceMemory(entry.stockCode);
      if (!cached || cached <= 0) return; // 캐시 없으면 스킵 (API 호출 안 함)
      currentPrice = cached;
    } else {
      const p = await getCurrentPrice(entry.stockCode).catch(() => null);
      if (!p || p.currentPrice <= 0) return;
      currentPrice = p.currentPrice;
    }

    const pnlPct = ((currentPrice - entry.avgBuyPrice) / entry.avgBuyPrice) * 100;

    // v23: Chandelier Exit 트레일링 — 고점 갱신 + ATR 3x 동적 SL
    // 근거: Chandelier Exit 승률 51.3%, PF 1.61 (stratbase.ai backtest)
    if (currentPrice > entry.peakPrice) {
      entry.peakPrice = currentPrice;
    }
    if (entry.atrValue > 0 && entry.peakPrice > entry.avgBuyPrice) {
      const chandelierStop = entry.peakPrice - 3.0 * entry.atrValue;
      const chandelierPct = ((chandelierStop - entry.avgBuyPrice) / entry.avgBuyPrice) * 100;
      // SL은 위로만 이동 (더 타이트하게만 조정 — 기존 SL보다 높을 때만)
      if (chandelierPct > entry.stopLossPct) {
        const oldSl = entry.stopLossPct;
        entry.stopLossPct = chandelierPct;
        await saveState(entry);
        logger.info(
          `🛡️ Chandelier 트레일링: ${entry.stockCode} SL ${oldSl.toFixed(1)}%→${chandelierPct.toFixed(1)}% (peak=${entry.peakPrice.toLocaleString()}, ATR=${entry.atrValue.toFixed(0)})`,
          { component: 'WATCHDOG' },
        );
      }
    }

    // SL 트리거
    if (pnlPct <= entry.stopLossPct) {
      const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
      logger.warn(
        `🛡️ 워치독 SL 트리거: ${entry.stockCode} ${pnlPct.toFixed(2)}% ≤ ${entry.stopLossPct}% (${elapsed}초 경과)`,
        { component: 'WATCHDOG' },
      );

      // TP 주문 먼저 취소
      if (entry.tpOrderNo && !entry.isPaper) {
        await cancelOrder({ orderNo: entry.tpOrderNo, stockCode: entry.stockCode, quantity: entry.quantity }).catch(
          () => {},
        );
        entry.tpOrderNo = null;
      }

      // 시장가 매도 — executor의 processDecisions 재사용
      const { tradeExecutor } = await import('./executor.js');
      await tradeExecutor.processDecisions(
        [
          {
            action: 'FORCE_CLOSE',
            stock_code: entry.stockCode,
            quantity: entry.quantity,
            price_type: 'MARKET',
            reasoning: `🛡️ 워치독 SL: ${pnlPct.toFixed(2)}% (임계 ${entry.stopLossPct}%, ${elapsed}초 경과)`,
            confidence: 1.0,
          },
        ],
        entry.strategyMode,
        'WATCHDOG',
      );

      stopWatchdog(entry.chainId, `SL ${pnlPct.toFixed(1)}%`);
      return;
    }

    // BreakEven Guard (근거: 인트라데이 BE는 수익성 저하 → +2.0% 임계, SL=-0.3%)
    // SWING만 SL=0% (장기 보유에서는 BE 유효 — 연구 근거)
    if (pnlPct >= 2.0 && entry.stopLossPct < 0) {
      const newSl = entry.strategyMode === 'SWING' ? 0 : -0.3;
      entry.stopLossPct = newSl;
      await saveState(entry);
      logger.info(
        `🛡️ 워치독 BE: ${entry.stockCode} SL → ${newSl}% (pnl +${pnlPct.toFixed(1)}%, ${entry.strategyMode})`,
        { component: 'WATCHDOG' },
      );
    }
  } catch (e) {
    // 개별 체크 실패는 무시 (다음 사이클에서 재시도)
    logger.debug(`워치독 체크 오류: ${entry.stockCode} ${(e as Error).message}`, { component: 'WATCHDOG' });
  }
}

function stopWatchdog(chainId: string, reason: string): void {
  const w = _watchdogs.get(chainId);
  if (w) {
    clearInterval(w.timer);
    _watchdogs.delete(chainId);
  }
  removeState(chainId).catch(() => {});
  logger.info(`🛡️ 워치독 종료: ${chainId.slice(0, 8)}… — ${reason}`, { component: 'WATCHDOG' });
}

async function saveState(entry: WatchdogEntry): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await getPool().query(
        `INSERT INTO system_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`watchdog_${entry.chainId}`, JSON.stringify(entry)],
      );
      return;
    } catch (e) {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      else logger.error(`워치독 상태 저장 2회 실패 (재시작 시 SL/TP 보호 손실 위험): ${(e as Error).message}`, { component: 'WATCHDOG' });
    }
  }
}

async function removeState(chainId: string): Promise<void> {
  await getPool()
    .query(`DELETE FROM system_state WHERE key = $1`, [`watchdog_${chainId}`])
    .catch(() => {});
}
