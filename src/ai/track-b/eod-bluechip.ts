import type { TransactionChain, TradeDecision } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

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
  blockNewBuys: boolean;
}

/**
 * EOD 블루칩 줍줍 전략 + 익일 장시작 강제 청산
 *
 * 매수: 14:50~14:59 KST, 하락장(todayDown or penalty≥1), 당일 -0.5%↓ 블루칩
 * 청산: 익일 09:05~09:25 KST, 전일 14:45↑ 매수 포지션 장시작 강제 청산
 *
 * 호출 위치: deduplicateSells() AFTER → 이미 청산 결정 있으면 중복 추가 안 함
 */
export function applyEodBluechipStrategy(decisions: TradeDecision[], ctx: EodContext): TradeDecision[] {
  const { kstH, kstM, openChains, livePrices, todayDown, kospiPenalty, adjMaxPositionKrw, blockNewBuys } = ctx;
  const result = [...decisions];

  const isEodBuyWindow = kstH === 14 && kstM >= 50;
  const isMorningExitWindow = kstH === 9 && kstM >= 5 && kstM <= 25;
  const isBearDay = todayDown || kospiPenalty >= 1;

  // 익일 오전: 전날 14:45 이후 매수한 블루칩 포지션 장시작 강제 청산
  if (isMorningExitWindow) {
    const todayKst = new Date(Date.now() + 9 * 3600000);
    const todayStr = todayKst.toISOString().split('T')[0];
    for (const chain of openChains) {
      if (!(EOD_BLUECHIP_CODES as readonly string[]).includes(chain.stock_code)) continue;
      if (Number(chain.total_quantity) <= 0) continue;
      if (!chain.opened_at) continue;
      const openedKst = new Date(new Date(chain.opened_at).getTime() + 9 * 3600000);
      const openedStr = openedKst.toISOString().split('T')[0];
      if (openedStr >= todayStr) continue; // 오늘 매수 건은 제외
      const openedH = openedKst.getUTCHours();
      const openedM = openedKst.getUTCMinutes();
      if (openedH < 14 || (openedH === 14 && openedM < 45)) continue; // 14:45 이전 매수는 일반 관리
      const alreadySelling = result.some(
        (d) => d.stock_code === chain.stock_code && ['SELL', 'FORCE_CLOSE'].includes(d.action),
      );
      if (alreadySelling) continue;
      result.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: Number(chain.total_quantity),
        price_type: 'MARKET',
        reasoning: 'EOD줍줍 익일청산: 블루칩 갭회복 매도',
        confidence: 1.0,
      });
      logger.info(`🌅 EOD줍줍 익일청산: ${chain.stock_code} x${chain.total_quantity}`, { component: 'EOD_BLUECHIP' });
    }
  }

  // EOD 매수: 하락장 블루칩 줍줍 (14:50~14:59, 당일 -0.5% 이상 하락)
  if (isEodBuyWindow && isBearDay && !blockNewBuys) {
    for (const code of EOD_BLUECHIP_CODES) {
      if (openChains.some((c) => c.stock_code === code && Number(c.total_quantity) > 0)) continue;
      const p = livePrices.get(code);
      if (!p || p.currentPrice <= 0 || p.changePct > -0.5) continue;
      const qty = Math.floor((adjMaxPositionKrw * 0.5) / p.currentPrice);
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
        confidence: 0.80,
      });
      logger.info(`🛒 EOD줍줍 매수: ${code} x${qty} @${p.currentPrice} (당일${p.changePct.toFixed(1)}%)`, { component: 'EOD_BLUECHIP' });
    }
  }

  return result;
}
