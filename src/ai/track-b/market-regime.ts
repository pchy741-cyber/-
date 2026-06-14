import { KR_FEE, STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { logSystem } from '../../db/client.js';
import type { TransactionChain } from '../../db/models.js';
import type { CurrentPrice, DailyCandle } from '../../kis/market.js';
import { getCurrentPrice, getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { PARK_STOCK_CODE } from './defense-park.js';

/** 전략 모드별 시장 상황 최적화 파라미터 */
export interface AdaptiveStrategyParams {
  buyThreshold: number;
  takeProfitPct: number;
  stopLossPct: number;
}

/** KOSPI 시장 국면 판별 결과 (Faber 2007 MA 기반) */
export interface KospiRegime {
  /** 0=정상, 1=조정장(포지션60%), 2=하락장(매수차단) */
  penalty: 0 | 1 | 2;
  /** 강세장: 가격 > MA20 > MA60 (골든크로스 구간) → 포지션 1.3x 확대 + TP 상향 */
  boost: boolean;
  /** 당일 -0.3%+ 하락 → 신규 매수 억제 (하락장 진입 차단) */
  todayDown: boolean;
  /** 5분 이내 KOSPI -1%+ 급락 → 해당 사이클 신규 매수 전면 차단 */
  flashCrash: boolean;
  /** ATR 기반 시장 변동성 적응형 전략 파라미터 (모드별) */
  adaptive: Partial<Record<StrategyMode, AdaptiveStrategyParams>>;
  /** KOSPI 14일 평균 ATR % */
  atrPct: number;
}

// ── KOSPI ATR 계산 (True Range 기반 변동성) ──
function calcAtrPct(candles: DailyCandle[], period = 14): number {
  if (candles.length < period + 1) return 1.0;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i + 1]?.close;
    if (!prevClose || prevClose <= 0) continue;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sum += (tr / prevClose) * 100;
  }
  return period > 0 ? sum / period : 1.0;
}

// ── 변동성 + 레짐 기반 전략 파라미터 동적 최적화 ──
function buildAdaptive(
  candles: DailyCandle[],
  regime: { penalty: 0 | 1 | 2; boost: boolean },
): { adaptive: Partial<Record<StrategyMode, AdaptiveStrategyParams>>; atrPct: number } {
  const atrPct = calcAtrPct(candles);
  const adaptiveModes: StrategyMode[] = ['SWING', 'SCALPING', 'DEFENSE', 'SNIPER'];
  const adaptive: Partial<Record<StrategyMode, AdaptiveStrategyParams>> = {};
  const notes: string[] = [];

  for (const m of adaptiveModes) {
    const base = STRATEGY_PARAMS[m] as { buyThreshold: number; takeProfitPct: number; stopLossPct: number };
    let { buyThreshold, takeProfitPct, stopLossPct } = base;

    // ATR 변동성 적응 — SL 확장 제거 (고변동성 SL×1.3으로 -12.9% 손실 발생했던 원인)
    // 진입 기준(buyThreshold)만 높이고 SL은 DB 고정값 유지
    if (atrPct > 1.8) {
      buyThreshold = Math.min(95, buyThreshold + 4);
      takeProfitPct = Math.min(12, takeProfitPct * 1.2); // TP 소폭 확장만
      if (m === 'SWING') notes.push(`극고변동성(ATR ${atrPct.toFixed(1)}%) → threshold+4, TP×1.2`);
    } else if (atrPct > 1.3) {
      buyThreshold = Math.min(93, buyThreshold + 2);
      if (m === 'SWING') notes.push(`고변동성(ATR ${atrPct.toFixed(1)}%) → threshold+2`);
    } else if (atrPct < 0.7) {
      takeProfitPct = Math.max(1.0, takeProfitPct * 0.9);
      if (m === 'SWING') notes.push(`저변동성(ATR ${atrPct.toFixed(1)}%) → TP×0.9`);
    }

    // KOSPI 레짐 적응
    if (regime.boost) {
      // 강세장: 진입 문턱 낮추고 TP 상향
      buyThreshold = Math.max(70, buyThreshold - 2);
      takeProfitPct = Math.min(12, takeProfitPct + 1.0);
    }
    if (regime.penalty >= 2) {
      // 하락장: 진입 극도로 제한, SL 타이트
      buyThreshold = Math.min(95, buyThreshold + 5);
      stopLossPct = Math.max(-6, stopLossPct * 0.8);
    } else if (regime.penalty === 1) {
      // 조정장: 진입 소폭 제한
      buyThreshold = Math.min(93, buyThreshold + 2);
    }

    adaptive[m] = {
      buyThreshold: Math.round(buyThreshold),
      takeProfitPct: Math.round(takeProfitPct * 10) / 10,
      stopLossPct: Math.round(stopLossPct * 10) / 10,
    };
  }

  if (notes.length > 0) {
    logger.info(`⚙️ 전략 파라미터 자동최적화 [ATR ${atrPct.toFixed(2)}%]: ${notes.join(' | ')}`, {
      component: 'REGIME',
    });
  }
  return { adaptive, atrPct };
}

// 5분 사이클 간 KOSPI 가격 추적 (서킷브레이커용)
let _prevKospiPrice = 0;
let _prevKospiTime = 0;

// ── 레짐 캐시 (risk-engine, alloc-risk 등 외부 모듈에서 조회) ──
let _lastKnownPenalty: 0 | 1 | 2 = 0;
let _lastKnownBoost = false;
/** 마지막으로 감지된 KOSPI 레짐 반환 (Track B 파이프라인이 3분마다 갱신) */
export function getLastKnownRegime(): { penalty: 0 | 1 | 2; boost: boolean } {
  return { penalty: _lastKnownPenalty, boost: _lastKnownBoost };
}

/** KOSPI MA20/MA60 기반 시장 국면 판별 + 5분 서킷브레이커 */
export async function fetchKospiRegime(): Promise<KospiRegime> {
  const _fallback: KospiRegime = {
    penalty: 0,
    boost: false,
    todayDown: false,
    flashCrash: false,
    adaptive: {},
    atrPct: 1.0,
  };
  try {
    const kospiCandles = await getDailyChart('0001', 65);
    if (kospiCandles.length < 60) return _fallback;
    const { analyzeTechnicals } = await import('../../analysis/indicators.js');
    const kospiTech = analyzeTechnicals(kospiCandles);
    if (!kospiTech) return _fallback;
    const kospiNow = kospiCandles[0]?.close ?? 0;
    const kospiPrev = kospiCandles[1]?.close ?? 0;
    const todayChangePct = kospiPrev > 0 ? ((kospiNow - kospiPrev) / kospiPrev) * 100 : 0;
    const todayDown = kospiNow > 0 && todayChangePct <= -0.3;
    if (todayDown) {
      logger.info(
        `📉 KOSPI 당일 ${todayChangePct.toFixed(2)}% 하락 (${kospiNow.toFixed(0)} / 전일${kospiPrev.toFixed(0)}) → 신규 매수 억제`,
        { component: 'REGIME' },
      );
    }

    // 5분 서킷브레이커: 실시간 가격 vs 직전 사이클 가격 비교
    let flashCrash = false;
    try {
      const liveKospi = await getCurrentPrice('0001');
      const livePrice = liveKospi?.currentPrice ?? 0;
      const now = Date.now();
      if (livePrice > 0 && _prevKospiPrice > 0) {
        const cycleDrop = ((livePrice - _prevKospiPrice) / _prevKospiPrice) * 100;
        if (cycleDrop <= -2.0) {
          flashCrash = true;
          logger.warn(
            `🚨 KOSPI 급락 서킷브레이커: 5분 내 ${cycleDrop.toFixed(2)}% 하락 (${_prevKospiPrice.toFixed(0)}→${livePrice.toFixed(0)}) → 신규 매수 전면 차단`,
            { component: 'REGIME' },
          );
          await logSystem(
            'WARN',
            'REGIME',
            `KOSPI 급락 서킷브레이커: ${cycleDrop.toFixed(2)}% (${_prevKospiPrice.toFixed(0)}→${livePrice.toFixed(0)})`,
          );
        }
      }
      if (livePrice > 0 && now - _prevKospiTime > 60_000) {
        _prevKospiPrice = livePrice;
        _prevKospiTime = now;
      }
    } catch {
      /* 실시간 시세 실패 시 무시 */
    }

    if (kospiNow > 0 && kospiNow < kospiTech.sma60) {
      logger.warn(`⛔ KOSPI ${kospiNow.toFixed(0)} < MA60 ${kospiTech.sma60.toFixed(0)} → 하락장 신규 매수 차단`, {
        component: 'REGIME',
      });
      const { adaptive, atrPct } = buildAdaptive(kospiCandles, { penalty: 2, boost: false });
      _lastKnownPenalty = 2; _lastKnownBoost = false;
      return { penalty: 2, boost: false, todayDown, flashCrash, adaptive, atrPct };
    }
    if (kospiNow > 0 && kospiNow < kospiTech.sma20) {
      logger.info(`⚠️ KOSPI ${kospiNow.toFixed(0)} < MA20 ${kospiTech.sma20.toFixed(0)} → 조정장 포지션 60%`, {
        component: 'REGIME',
      });
      const { adaptive, atrPct } = buildAdaptive(kospiCandles, { penalty: 1, boost: false });
      _lastKnownPenalty = 1; _lastKnownBoost = false;
      return { penalty: 1, boost: false, todayDown, flashCrash, adaptive, atrPct };
    }
    // 강세장: 가격 > MA20 > MA60 = 골든크로스 구간 → 포지션 확대 + TP 상향
    const isBull = kospiNow > 0 && kospiTech.sma20 > kospiTech.sma60;
    if (isBull) {
      logger.info(
        `🚀 KOSPI 강세장: ${kospiNow.toFixed(0)} > MA20 ${kospiTech.sma20.toFixed(0)} > MA60 ${kospiTech.sma60.toFixed(0)} → 포지션 1.3x + TP 상향`,
        { component: 'REGIME' },
      );
    }
    const { adaptive, atrPct } = buildAdaptive(kospiCandles, { penalty: 0, boost: isBull });
    _lastKnownPenalty = 0; _lastKnownBoost = isBull;
    logger.info(
      `⚙️ 현재 ATR ${atrPct.toFixed(2)}% | SWING: threshold=${adaptive.SWING?.buyThreshold} TP=${adaptive.SWING?.takeProfitPct}% SL=${adaptive.SWING?.stopLossPct}%`,
      { component: 'REGIME' },
    );
    return { penalty: 0, boost: isBull, todayDown, flashCrash, adaptive, atrPct };
  } catch {
    return { penalty: 0, boost: false, todayDown: false, flashCrash: false, adaptive: {}, atrPct: 1.0 };
  }
}

export interface DailyLossResult {
  /** -3% 이상 손실 → 신규 매수 전면 차단 */
  blocked: boolean;
  /** -2% ~ -3% 구간 → 조기경고 (신규 매수 포지션 50% 축소) */
  earlyWarning: boolean;
  /** 일일 손익률 (%) */
  dailyPnlPct: number;
}

/** 일일 최대 손실 한도 체크 (-2% 조기경고 / -3% 차단, 실현+미실현 합산) */
export async function checkDailyLoss(params: {
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  totalAssets: number;
}): Promise<DailyLossResult> {
  try {
    const { getPool } = await import('../../db/client.js');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { rows } = await getPool().query(
      `
      SELECT COALESCE(SUM(
        -- 국내 매도: 수수료(0.195%) 차감 후 실현손익 (trigger_source!=OVERSEAS 필터로 국내만)
        (o.filled_price * o.filled_quantity
         - ROUND(o.filled_price * o.filled_quantity * ${KR_FEE.SELL_FEE_PCT}))
        - (tc.avg_buy_price * o.filled_quantity)
      ), 0) AS realized_pnl
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.side = 'SELL'
        AND o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND o.created_at >= $1
        AND o.filled_price IS NOT NULL
        AND tc.avg_buy_price IS NOT NULL
        AND tc.is_paper = $2
        AND o.trading_mode = $3
    `,
      [today.toISOString(), getCtxIsPaper(), getCtxIsPaper() ? 'paper' : 'live'],
    );
    const realizedPnl = Number(rows[0]?.realized_pnl ?? 0);

    const unrealizedPnl = params.openChains
      .filter((c) => c.stock_code !== PARK_STOCK_CODE && c.avg_buy_price)
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
        logger.warn(
          `⛔ 일일 손실 한도(-3%) 초과: ${pct.toFixed(2)}% (실현${realizedPnl.toLocaleString()}+미실현${unrealizedPnl.toLocaleString()}원) → 신규 매수 차단`,
          { component: 'REGIME' },
        );
        await logSystem(
          'WARN',
          'TRACK_B',
          `일일 손실 한도 초과: ${pct.toFixed(2)}%(실현+미실현) → 국내 신규 매수 차단`,
        );
        return { blocked: true, earlyWarning: false, dailyPnlPct: pct };
      }
      if (pct <= -2) {
        logger.warn(`⚠️ 일일 손실 조기경고(-2%): ${pct.toFixed(2)}% → 신규 매수 포지션 50% 축소`, {
          component: 'REGIME',
        });
        return { blocked: false, earlyWarning: true, dailyPnlPct: pct };
      }
      logger.info(
        `📊 일일 손익: ${pct.toFixed(2)}% (실현${realizedPnl.toLocaleString()}+미실현${unrealizedPnl.toLocaleString()}원)`,
        { component: 'REGIME' },
      );
      return { blocked: false, earlyWarning: false, dailyPnlPct: pct };
    }
    return { blocked: false, earlyWarning: false, dailyPnlPct: 0 };
  } catch {
    return { blocked: false, earlyWarning: false, dailyPnlPct: 0 };
  }
}
