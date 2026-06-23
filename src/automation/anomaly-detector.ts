import { getActiveWatchlist } from '../db/client.js';
import { getBatchPrices } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

/**
 * 이상 거래량 / 급등락 자동 감지
 *
 * 장중 5분마다 실행 → 감시 종목에서 비정상 움직임 포착 시 즉시 알림
 * Track B 판단에 추가 컨텍스트로 활용 가능
 */

// ── 이상 감지 기준 상수 ──
const SURGE_THRESHOLD_PCT = 5; // 전일 대비 급등 기준 (%)
const CRITICAL_SURGE_THRESHOLD_PCT = 10; // CRITICAL 등급 급등 기준 (%)
const SHORT_TERM_CHANGE_PCT = 2; // 5분 내 급변 기준 (%)
const VOLUME_SPIKE_MULTIPLIER = 3; // 거래량 급증 배수

// 이전 체크 시점의 가격 캐시 (메모리 릭 방지: 매일 리셋)
const priceHistory = new Map<string, { price: number; volume: number; checkedAt: Date }>();
let lastCleanupDate = '';

function cleanupPriceHistory() {
  const today = getKSTNow().toISOString().split('T')[0];
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

  // 배치 조회 — 개별 루프 대비 API 호출 횟수 대폭 감소
  const codes = watchlist.map((s) => s.stock_code);
  const priceMap = await getBatchPrices(codes);

  for (const stock of watchlist) {
    const price = priceMap.get(stock.stock_code);
    if (!price) continue;

    const prev = priceHistory.get(stock.stock_code);

    // 1. 급등 감지 (전일 대비 +5% 이상)
    if (price.changePct >= SURGE_THRESHOLD_PCT) {
      alerts.push({
        stockCode: stock.stock_code,
        stockName: stock.stock_name,
        type: 'PRICE_SURGE',
        severity: price.changePct >= CRITICAL_SURGE_THRESHOLD_PCT ? 'CRITICAL' : 'WARNING',
        message: `${stock.stock_name} +${price.changePct.toFixed(1)}% 급등!`,
        currentPrice: price.currentPrice,
        changePct: price.changePct,
      });
    }

    // 2. 급락 감지 (전일 대비 -5% 이상)
    if (price.changePct <= -SURGE_THRESHOLD_PCT) {
      alerts.push({
        stockCode: stock.stock_code,
        stockName: stock.stock_name,
        type: 'PRICE_CRASH',
        severity: price.changePct <= -CRITICAL_SURGE_THRESHOLD_PCT ? 'CRITICAL' : 'WARNING',
        message: `${stock.stock_name} ${price.changePct.toFixed(1)}% 급락!`,
        currentPrice: price.currentPrice,
        changePct: price.changePct,
      });
    }

    // 3. 5분 내 급변 감지 (이전 체크 대비 ±2%)
    if (prev && prev.price > 0) {
      const shortTermChange = ((price.currentPrice - prev.price) / prev.price) * 100;
      if (Number.isFinite(shortTermChange) && Math.abs(shortTermChange) >= SHORT_TERM_CHANGE_PCT) {
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

      // 4. 거래량 급증 (이전 체크 대비 N배)
      if (prev.volume > 0 && price.volume > prev.volume * VOLUME_SPIKE_MULTIPLIER) {
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
  }

  // 알림 발송 (WARNING 이상만)
  const importantAlerts = alerts.filter((a) => a.severity !== 'INFO');
  if (importantAlerts.length > 0) {
    const msg = importantAlerts.map((a) => `${a.severity === 'CRITICAL' ? '🚨' : '⚠️'} ${a.message}`).join('\n');
    await sendTelegramMessage(`📡 *이상 감지*\n${msg}`).catch((e) =>
      logger.warn(`이상감지 알림 실패: ${e}`, { component: 'ANOMALY' }),
    );
    logger.warn(`이상 감지 ${importantAlerts.length}건`, { component: 'ANOMALY' });
  }

  return alerts;
}
