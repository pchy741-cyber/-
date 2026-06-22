import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { getKSTNow } from '../../utils/time.js';

// 삼성전자, SK하이닉스, 한화에어로스페이스
export const EOD_BLUECHIP_CODES = ['005930', '000660', '012450'] as const;

interface EodContext {
  kstH: number;
  kstM: number;
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  todayDown: boolean;
  kospiPenalty: number;
  adjMaxPositionKrw: number;
  totalAssets: number; // 총자산 (cascading multiplier 미적용 원본)
  blockNewBuys: boolean;
  watchlistCodes?: string[]; // 워치리스트 종목 코드 (시간외 줍줍용)
  scannedStocks?: Array<{ stock_code: string; stock_name: string }>; // 바닥낚시 스캐너 결과
}

/**
 * EOD 블루칩 줍줍 전략 + 장후 시간외 줍줍 + 익일 장시작 강제 청산
 *
 * 매수 1: 14:50~14:59 KST, 하락장(todayDown or penalty≥1), 당일 -0.5%↓ 블루칩
 * 매수 2: 15:40~15:55 KST, 장후 시간외 — 당일 -1.5%↓ 워치리스트/블루칩 (더 보수적)
 * 청산:   익일 09:05~09:25 KST, 전일 14:45↑ 매수 포지션 장시작 강제 청산
 *
 * 호출 위치: deduplicateSells() AFTER → 이미 청산 결정 있으면 중복 추가 안 함
 */
export function applyEodBluechipStrategy(decisions: TradeDecision[], ctx: EodContext): TradeDecision[] {
  const {
    kstH,
    kstM,
    openChains,
    livePrices,
    todayDown,
    kospiPenalty,
    totalAssets,
    blockNewBuys,
    watchlistCodes,
    scannedStocks,
  } = ctx;
  const result = [...decisions];

  const isEodBuyWindow = kstH === 14 && kstM >= 50;
  const isAfterHoursBuyWindow = kstH === 15 && kstM >= 40 && kstM <= 55;
  const isMorningExitWindow = kstH === 9 && kstM >= 5 && kstM <= 25;
  const isBearDay = todayDown || kospiPenalty >= 1;

  // ── 익일 오전: 전날 14:45 이후 매수한 포지션 장시작 강제 청산 ──
  if (isMorningExitWindow) {
    const todayKst = getKSTNow();
    const todayStr = todayKst.toISOString().split('T')[0];
    for (const chain of openChains) {
      if (Number(chain.total_quantity) <= 0) continue;
      if (!chain.opened_at) continue;
      const openedKst = new Date(new Date(chain.opened_at).getTime() + 9 * 3_600_000); // UTC+9 (KST offset)
      const openedStr = openedKst.toISOString().split('T')[0];
      if (openedStr >= todayStr) continue; // 오늘 매수 건은 제외
      const openedH = openedKst.getUTCHours();
      const openedM = openedKst.getUTCMinutes();
      if (openedH < 14 || (openedH === 14 && openedM < 45)) continue; // 14:45 이전 매수는 일반 관리
      // BOTTOM_FISHING 체인은 TP/SL로 관리 — 익일 강제청산 제외
      if (chain.strategy_mode === 'BOTTOM_FISHING') continue;
      // EOD/시간외 줍줍 종목인지 확인 (줍줍 아닌 종목은 일반 전략이 관리)
      const isEodTarget =
        (EOD_BLUECHIP_CODES as readonly string[]).includes(chain.stock_code) ||
        (watchlistCodes ?? []).includes(chain.stock_code);
      if (!isEodTarget) continue;
      const alreadySelling = result.some(
        (d) => d.stock_code === chain.stock_code && ['SELL', 'FORCE_CLOSE'].includes(d.action),
      );
      if (alreadySelling) continue;
      result.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: Number(chain.total_quantity),
        price_type: 'MARKET',
        reasoning: 'EOD줍줍 익일청산: 갭회복 매도',
        confidence: 1.0,
      });
      logger.info(`🌅 EOD줍줍 익일청산: ${chain.stock_code} x${chain.total_quantity}`, { component: 'EOD_BLUECHIP' });
    }
  }

  // ── EOD 매수: 하락장 블루칩 줍줍 (14:50~14:59, 당일 -0.5% 이상 하락) ──
  if (isEodBuyWindow && isBearDay && !blockNewBuys) {
    for (const code of EOD_BLUECHIP_CODES) {
      if (openChains.some((c) => c.stock_code === code && Number(c.total_quantity) > 0)) continue;
      const p = livePrices.get(code);
      if (!p || p.currentPrice <= 0 || p.changePct > -0.5) continue;
      // 총자산 10% 직접 사용 (pipeline cascading multiplier 우회 — EOD 단타는 별도 사이징)
      const eodPositionKrw = Math.round(totalAssets * 0.1);
      const qty = Math.floor(eodPositionKrw / p.currentPrice);
      if (qty <= 0) continue;
      const alreadyBuying = result.some(
        (d) => d.stock_code === code && (d.action === 'BUY' || d.action === 'AVERAGE_DOWN'),
      );
      if (alreadyBuying) continue;
      result.push({
        action: 'BUY',
        stock_code: code,
        quantity: qty,
        price_type: 'MARKET',
        limit_price: p.currentPrice,
        reasoning: `EOD줍줍: 하락장 블루칩 (당일${p.changePct.toFixed(1)}%) → 익일 장시작 청산 예정`,
        confidence: 0.8,
        trigger_source: 'EOD_BLUECHIP',
      });
      logger.info(`🛒 EOD줍줍 매수: ${code} x${qty} @${p.currentPrice} (당일${p.changePct.toFixed(1)}%)`, {
        component: 'EOD_BLUECHIP',
      });
    }
  }

  // ── 장후 시간외 줍줍 (15:40~15:55, 당일 -1.5% 이상 급락) ──
  // 시간외 단일가(ORD_DVSN '06')로 체결 — 16:00 일괄 체결
  // 블루칩 + 워치리스트 + 바닥낚시 스캔 종목 중 급락한 것만
  if (isAfterHoursBuyWindow && !blockNewBuys) {
    const scannedCodeSet = new Set((scannedStocks ?? []).map((s) => s.stock_code));
    const afterHoursCodes = new Set([...EOD_BLUECHIP_CODES, ...(watchlistCodes ?? []), ...scannedCodeSet]);
    let afterHoursBuyCount = 0;
    const maxAfterHoursBuys = 4; // 시간외 최대 4종목 (바닥낚시 확장)

    for (const code of afterHoursCodes) {
      if (afterHoursBuyCount >= maxAfterHoursBuys) break;
      if (openChains.some((c) => c.stock_code === code && Number(c.total_quantity) > 0)) continue;
      const p = livePrices.get(code);
      if (!p || p.currentPrice <= 0) continue;
      // 시간외는 더 보수적: -1.5% 이상 급락만 (장중 EOD는 -0.5%)
      if (p.changePct > -1.5) continue;
      // 총자산 7% 직접 사용 (장중 10%보다 보수적, cascading multiplier 우회)
      const afterHoursPositionKrw = Math.round(totalAssets * 0.07);
      const qty = Math.floor(afterHoursPositionKrw / p.currentPrice);
      if (qty <= 0) continue;
      const alreadyBuying = result.some(
        (d) => d.stock_code === code && (d.action === 'BUY' || d.action === 'AVERAGE_DOWN'),
      );
      if (alreadyBuying) continue;

      const isScanned = scannedCodeSet.has(code);
      result.push({
        action: 'BUY',
        stock_code: code,
        quantity: qty,
        price_type: 'LIMIT', // 시간외 단일가 — 종가 기준 (executor가 ORD_DVSN '06' 자동 적용)
        limit_price: p.currentPrice,
        reasoning: isScanned
          ? `바닥낚시: RSI과매도 급락종목 (당일${p.changePct.toFixed(1)}%) → TP/SL 기계적 청산`
          : `시간외줍줍: 장후 급락종목 (당일${p.changePct.toFixed(1)}%) → 익일 장시작 갭회복 매도 예정`,
        confidence: 0.75,
        ...(isScanned && { strategy_mode: 'BOTTOM_FISHING' }),
        trigger_source: isScanned ? 'BOTTOM_FISHING' : 'AFTER_HOURS',
      });
      afterHoursBuyCount++;
      logger.info(
        `${isScanned ? '🎣' : '🌙'} ${isScanned ? '바닥낚시' : '시간외줍줍'} 매수: ${code} x${qty} @${p.currentPrice} (당일${p.changePct.toFixed(1)}%)`,
        { component: 'EOD_BLUECHIP' },
      );
    }
  }

  return result;
}
