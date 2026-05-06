import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { logSystem } from '../../db/client.js';
import type { TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { PARK_STOCK_CODE } from './defense-park.js';

/** KOSPI 시장 국면 판별 결과 (Faber 2007 MA 기반) */
export interface KospiRegime {
  /** 0=정상, 1=조정장(포지션60%), 2=하락장(매수차단) */
  penalty: 0 | 1 | 2;
  /** 강세장: 가격 > MA20 > MA60 (골든크로스 구간) → 포지션 1.3x 확대 + TP 상향 */
  boost: boolean;
  /** 당일 -0.3%+ 하락 → 신규 매수 억제 (하락장 진입 차단) */
  todayDown: boolean;
}

/** KOSPI MA20/MA60 기반 시장 국면 판별 */
export async function fetchKospiRegime(): Promise<KospiRegime> {
  try {
    const kospiCandles = await getDailyChart('0001', 65);
    if (kospiCandles.length < 60) return { penalty: 0, boost: false, todayDown: false };
    const { analyzeTechnicals } = await import('../../analysis/indicators.js');
    const kospiTech = analyzeTechnicals(kospiCandles);
    if (!kospiTech) return { penalty: 0, boost: false, todayDown: false };
    const kospiNow = kospiCandles[0]?.close ?? 0;
    const kospiPrev = kospiCandles[1]?.close ?? 0;
    const todayChangePct = kospiPrev > 0 ? (kospiNow - kospiPrev) / kospiPrev * 100 : 0;
    const todayDown = kospiNow > 0 && todayChangePct <= -0.3;
    if (todayDown) {
      logger.info(`📉 KOSPI 당일 ${todayChangePct.toFixed(2)}% 하락 (${kospiNow.toFixed(0)} / 전일${kospiPrev.toFixed(0)}) → 신규 매수 억제`, { component: 'REGIME' });
    }
    if (kospiNow > 0 && kospiNow < kospiTech.sma60) {
      logger.warn(`⛔ KOSPI ${kospiNow.toFixed(0)} < MA60 ${kospiTech.sma60.toFixed(0)} → 하락장 신규 매수 차단`, { component: 'REGIME' });
      return { penalty: 2, boost: false, todayDown };
    }
    if (kospiNow > 0 && kospiNow < kospiTech.sma20) {
      logger.info(`⚠️ KOSPI ${kospiNow.toFixed(0)} < MA20 ${kospiTech.sma20.toFixed(0)} → 조정장 포지션 60%`, { component: 'REGIME' });
      return { penalty: 1, boost: false, todayDown };
    }
    // 강세장: 가격 > MA20 > MA60 = 골든크로스 구간 → 포지션 확대 + TP 상향
    const isBull = kospiNow > 0 && kospiTech.sma20 > kospiTech.sma60;
    if (isBull) {
      logger.info(`🚀 KOSPI 강세장: ${kospiNow.toFixed(0)} > MA20 ${kospiTech.sma20.toFixed(0)} > MA60 ${kospiTech.sma60.toFixed(0)} → 포지션 1.3x + TP 상향`, { component: 'REGIME' });
    }
    return { penalty: 0, boost: isBull, todayDown };
  } catch {
    return { penalty: 0, boost: false, todayDown: false };
  }
}

/** 일일 최대 손실 한도 체크 (-3%, 실현+미실현 합산) */
export async function checkDailyLoss(params: {
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  totalAssets: number;
}): Promise<{ blocked: boolean }> {
  try {
    const { getPool } = await import('../../db/client.js');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { rows } = await getPool().query(`
      SELECT COALESCE(SUM(
        (o.filled_price - tc.avg_buy_price) * o.filled_quantity
      ), 0) AS realized_pnl
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.side = 'SELL'
        AND o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND o.created_at >= $1
        AND o.filled_price IS NOT NULL
        AND tc.avg_buy_price IS NOT NULL
    `, [today.toISOString()]);
    const realizedPnl = Number(rows[0]?.realized_pnl ?? 0);

    const unrealizedPnl = params.openChains
      .filter(c => c.stock_code !== PARK_STOCK_CODE && c.avg_buy_price)
      .reduce((sum, c) => {
        const curPrice = params.livePrices.get(c.stock_code)?.currentPrice ?? 0;
        const avgBuy = Number(c.avg_buy_price ?? 0);
        if (curPrice <= 0 || avgBuy <= 0) return sum;
        return sum + (curPrice - avgBuy) * Number(c.total_quantity ?? 0);
      }, 0);

    const totalDailyPnl = realizedPnl + unrealizedPnl;
    if (params.totalAssets > 0) {
      const pct = (totalDailyPnl / params.totalAssets) * 100;
      if (pct <= -3) {
        logger.warn(`⛔ 일일 손실 한도(-3%) 초과: ${pct.toFixed(2)}% (실현${realizedPnl.toLocaleString()}+미실현${unrealizedPnl.toLocaleString()}원) → 신규 매수 차단`, { component: 'REGIME' });
        await logSystem('WARN', 'TRACK_B', `일일 손실 한도 초과: ${pct.toFixed(2)}%(실현+미실현) → 국내 신규 매수 차단`);
        return { blocked: true };
      }
      logger.info(`📊 일일 손익: ${pct.toFixed(2)}% (실현${realizedPnl.toLocaleString()}+미실현${unrealizedPnl.toLocaleString()}원)`, { component: 'REGIME' });
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}
