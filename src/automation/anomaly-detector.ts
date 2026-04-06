import { getActiveWatchlist } from '../db/client.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 이상 거래량 / 급등락 자동 감지
 *
 * 장중 5분마다 실행 → 감시 종목에서 비정상 움직임 포착 시 즉시 알림
 * Track B 판단에 추가 컨텍스트로 활용 가능
 */

// 이전 체크 시점의 가격 캐시 (메모리 릭 방지: 매일 리셋)
const priceHistory = new Map<string, { price: number; volume: number; checkedAt: Date }>();
let lastCleanupDate = '';

function cleanupPriceHistory() {
  const today = new Date().toISOString().split('T')[0];
  if (lastCleanupDate !== today) {
    priceHistory.clear();
    lastCleanupDate = today;
  }
}

export interface AnomalyAlert {
  stockCode: string;
  stockName: string;
  type: 'VOLUME_SPIKE' | 'PRICE_SURGE' | 'PRICE_CRASH' | 'GAP_UP' | 'GAP_DOWN';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  currentPrice: number;
  changePct: number;
}

export async function detectAnomalies(): Promise<AnomalyAlert[]> {
  cleanupPriceHistory(); // 메모리 릭 방지

  const watchlist = await getActiveWatchlist();
  if (watchlist.length === 0) return [];

  const alerts: AnomalyAlert[] = [];

  for (const stock of watchlist) {
    try {
      const price = await getCurrentPrice(stock.stock_code);
      const prev = priceHistory.get(stock.stock_code);

      // 1. 급등 감지 (전일 대비 +5% 이상)
      if (price.changePct >= 5) {
        alerts.push({
          stockCode: stock.stock_code,
          stockName: stock.stock_name,
          type: 'PRICE_SURGE',
          severity: price.changePct >= 10 ? 'CRITICAL' : 'WARNING',
          message: `${stock.stock_name} +${price.changePct.toFixed(1)}% 급등!`,
          currentPrice: price.currentPrice,
          changePct: price.changePct,
        });
      }

      // 2. 급락 감지 (전일 대비 -5% 이상)
      if (price.changePct <= -5) {
        alerts.push({
          stockCode: stock.stock_code,
          stockName: stock.stock_name,
          type: 'PRICE_CRASH',
          severity: price.changePct <= -10 ? 'CRITICAL' : 'WARNING',
          message: `${stock.stock_name} ${price.changePct.toFixed(1)}% 급락!`,
          currentPrice: price.currentPrice,
          changePct: price.changePct,
        });
      }

      // 3. 5분 내 급변 감지 (이전 체크 대비 ±2%)
      if (prev) {
        const shortTermChange = ((price.currentPrice - prev.price) / prev.price) * 100;
        if (Math.abs(shortTermChange) >= 2) {
          alerts.push({
            stockCode: stock.stock_code,
            stockName: stock.stock_name,
            type: shortTermChange > 0 ? 'PRICE_SURGE' : 'PRICE_CRASH',
            severity: 'WARNING',
            message: `${stock.stock_name} 5분 내 ${shortTermChange > 0 ? '+' : ''}${shortTermChange.toFixed(1)}% 급변`,
            currentPrice: price.currentPrice,
            changePct: shortTermChange,
          });
        }

        // 4. 거래량 급증 (이전 체크 대비 3배)
        if (prev.volume > 0 && price.volume > prev.volume * 3) {
          alerts.push({
            stockCode: stock.stock_code,
            stockName: stock.stock_name,
            type: 'VOLUME_SPIKE',
            severity: 'INFO',
            message: `${stock.stock_name} 거래량 급증 (${(price.volume / prev.volume).toFixed(0)}배)`,
            currentPrice: price.currentPrice,
            changePct: price.changePct,
          });
        }
      }

      // 가격 히스토리 업데이트
      priceHistory.set(stock.stock_code, {
        price: price.currentPrice,
        volume: price.volume,
        checkedAt: new Date(),
      });

      // rate limit
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      // 개별 종목 실패는 무시
    }
  }

  // 알림 발송 (WARNING 이상만)
  const importantAlerts = alerts.filter((a) => a.severity !== 'INFO');
  if (importantAlerts.length > 0) {
    const msg = importantAlerts.map((a) => `${a.severity === 'CRITICAL' ? '🚨' : '⚠️'} ${a.message}`).join('\n');
    await sendTelegramMessage(`📡 *이상 감지*\n${msg}`);
    logger.warn(`이상 감지 ${importantAlerts.length}건`, { component: 'ANOMALY' });
  }

  return alerts;
}
