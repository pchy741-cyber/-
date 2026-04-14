import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { config } from '../config/index.js';
import { getPool, insertOrder, logSystem, updateOrder } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import {
  getOverseasBalance,
  getOverseasDailyChart,
  getOverseasPrice,
  placeOverseasOrder,
  type OverseasPrice,
} from '../kis/overseas.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { analyzeOverseasWithAI, type OverseasStockInput } from '../ai/overseas/analyzer.js';
import { setOverseasScores } from '../cache/overseas-scores.js';

// 글로벌 감시 목록 — 미국 + 일본 + 대만 (안정 대형주 위주)
const GLOBAL_WATCHLIST = [
  // 🇺🇸 미국 (KST 23:30~06:30)
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ', region: 'US' },
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ', region: 'US' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', region: 'US' },
  { code: 'GOOGL', name: 'Google', exchange: 'NASDAQ', region: 'US' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ', region: 'US' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ', region: 'US' },
  { code: 'META', name: 'Meta', exchange: 'NASDAQ', region: 'US' },
  // 🇯🇵 일본 (KST 09:00~11:30, 12:30~15:00)
  { code: '7203', name: 'Toyota', exchange: 'TSE', region: 'JP' },
  { code: '6758', name: 'Sony', exchange: 'TSE', region: 'JP' },
  { code: '6861', name: 'Keyence', exchange: 'TSE', region: 'JP' },
  { code: '8306', name: 'MUFG', exchange: 'TSE', region: 'JP' },
  { code: '6501', name: 'Hitachi', exchange: 'TSE', region: 'JP' },
  // 🇹🇼 대만 (KST 10:00~14:30)
  { code: '2330', name: 'TSMC', exchange: 'TPE', region: 'TW' },
  { code: '2317', name: 'Foxconn', exchange: 'TPE', region: 'TW' },
  { code: '2454', name: 'MediaTek', exchange: 'TPE', region: 'TW' },
  { code: '2308', name: 'Delta Electronics', exchange: 'TPE', region: 'TW' },
  { code: '3711', name: 'ASMedia', exchange: 'TPE', region: 'TW' },
];

// ─── 포지션 한도 (미국/아시아 공통) ───
const MAX_POSITIONS = 7;           // 최대 동시 보유 종목
const POSITION_SIZE_USD = 3000;    // 종목당 최대 투자금 (스윙 적극 투자)
const POSITION_PCT = 0.20;         // 또는 가용 현금의 20%

// ── DB 기반 보유종목 관리 (서버 재시작해도 유지) ──
async function ensureOverseasTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_holdings (
      stock_code TEXT PRIMARY KEY,
      exchange TEXT NOT NULL DEFAULT 'NASDAQ',
      quantity NUMERIC NOT NULL DEFAULT 0,
      avg_price NUMERIC NOT NULL DEFAULT 0,
      bought_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

async function getHoldings(): Promise<Map<string, { qty: number; avgPrice: number; boughtAt: string }>> {
  const map = new Map();
  try {
    const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
    for (const r of rows) {
      map.set(r.stock_code, { qty: Number(r.quantity), avgPrice: Number(r.avg_price), boughtAt: r.bought_at });
    }
  } catch { /* table might not exist yet */ }
  return map;
}

async function setHolding(code: string, qty: number, avgPrice: number): Promise<void> {
  if (qty <= 0) {
    await getPool().query('DELETE FROM overseas_holdings WHERE stock_code = $1', [code]);
  } else {
    await getPool().query(
      `INSERT INTO overseas_holdings (stock_code, quantity, avg_price, bought_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (stock_code) DO UPDATE SET quantity = $2, avg_price = $3`,
      [code, qty, avgPrice],
    );
  }
}

async function getCash(): Promise<number> {
  try {
    const { rows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'cash'");
    return rows.length > 0 ? Number(rows[0].value) : 10000;
  } catch { return 10000; }
}

async function setCash(amount: number): Promise<void> {
  // cap 제거 — 수익 누적 허용 (기존: 초기자본으로 강제 제한 → 수익 소멸 버그)
  const safe = Math.max(0, amount);
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ('cash', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [safe.toString()],
  );
}

/** 트레일링 스탑용 최고가 추적 */
async function getMaxPrice(code: string): Promise<number> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = $1",
      [`maxprice_${code}`],
    );
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

async function setMaxPrice(code: string, price: number): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`maxprice_${code}`, price.toString()],
  ).catch(() => {});
}

async function clearMaxPrice(code: string): Promise<void> {
  await getPool().query(
    "DELETE FROM overseas_state WHERE key = $1",
    [`maxprice_${code}`],
  ).catch(() => {});
}

let isRunning = false;

interface OverseasExecutionResult {
  submitted: boolean;
  filledQty: number;
  filledPrice: number;
  finalQty: number;
  finalAvgPrice: number;
  orderNo: string;
}

async function getPendingOverseasStocks(): Promise<Set<string>> {
  const pending = new Set<string>();
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT stock_code
       FROM orders
       WHERE trigger_source = 'OVERSEAS'
         AND trading_mode = 'live'
         AND status = 'PENDING'
         AND created_at >= NOW() - INTERVAL '1 day'`,
    );
    for (const row of rows) {
      if (row.stock_code) pending.add(String(row.stock_code));
    }
  } catch (e) {
    logger.warn(`미체결 주문 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return pending;
}

async function confirmOverseasFillFromBalance(params: {
  code: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  requestedQty: number;
  previousQty: number;
  previousAvgPrice: number;
  fallbackPrice: number;
}): Promise<Pick<OverseasExecutionResult, 'filledQty' | 'filledPrice' | 'finalQty' | 'finalAvgPrice'>> {
  const { code, exchange, side, requestedQty, previousQty, previousAvgPrice, fallbackPrice } = params;
  const retryDelays = [2000, 4000, 7000];

  for (let i = 0; i < retryDelays.length; i++) {
    await new Promise((r) => setTimeout(r, retryDelays[i]));
    try {
      const balances = await getOverseasBalance(exchange);
      const position = balances.find((b) => b.stockCode === code);
      const currentQty = position?.quantity ?? 0;
      const currentAvg = position?.avgBuyPrice ?? previousAvgPrice;

      if (side === 'BUY' && currentQty > previousQty) {
        const deltaQty = Math.min(requestedQty, currentQty - previousQty);
        let inferredPrice = fallbackPrice;
        if (deltaQty > 0 && currentAvg > 0) {
          if (previousQty > 0) {
            const numer = currentAvg * currentQty - previousAvgPrice * previousQty;
            const avgFromDelta = numer / deltaQty;
            if (Number.isFinite(avgFromDelta) && avgFromDelta > 0) inferredPrice = avgFromDelta;
          } else {
            inferredPrice = currentAvg;
          }
        }
        return {
          filledQty: deltaQty,
          filledPrice: inferredPrice,
          finalQty: currentQty,
          finalAvgPrice: currentAvg,
        };
      }

      if (side === 'SELL' && currentQty < previousQty) {
        const deltaQty = Math.min(requestedQty, previousQty - currentQty);
        return {
          filledQty: deltaQty,
          filledPrice: fallbackPrice,
          finalQty: currentQty,
          finalAvgPrice: currentAvg,
        };
      }
    } catch (e) {
      logger.warn(`해외 체결 확인 실패 (${code}, 시도 ${i + 1}): ${(e as Error).message}`, { component: 'OVERSEAS' });
    }
  }

  return {
    filledQty: 0,
    filledPrice: fallbackPrice,
    finalQty: previousQty,
    finalAvgPrice: previousAvgPrice,
  };
}

/**
 * 현재 KST 시간 기준으로 열려있는 시장의 region 반환
 */
function getActiveRegions(): string[] {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const t = h * 60 + m;
  const day = kst.getUTCDay(); // 0=Sun, 6=Sat

  const regions: string[] = [];

  // 🇺🇸 미국: KST 22:30~05:00 (NYSE 9:30am ET = KST 22:30)
  const isUSNight = t >= 22 * 60 + 30 && day >= 1 && day <= 5;
  const isUSDawn = t <= 5 * 60 && day >= 2 && day <= 6;
  if (isUSNight || isUSDawn) regions.push('US');

  // 🇯🇵 일본: KST 09:00~11:30, 12:30~15:00 (평일)
  if (day >= 1 && day <= 5) {
    if ((t >= 9 * 60 && t <= 11 * 60 + 30) || (t >= 12 * 60 + 30 && t <= 15 * 60)) regions.push('JP');
  }

  // 🇹🇼 대만: KST 10:00~14:30 (평일)
  if (day >= 1 && day <= 5) {
    if (t >= 10 * 60 && t <= 14 * 60 + 30) regions.push('TW');
  }

  logger.info(`🌏 시장 체크: KST ${h}:${String(m).padStart(2, '0')} (day=${day}) → [${regions.join(',')}]`, { component: 'OVERSEAS' });
  return regions;
}

/**
 * 글로벌 주식 자동매매 Job
 * AI(Claude) + 기술적 지표 복합 판단
 * 최대 5종목 동시 보유, 종목당 $1,500 / 20% 중 작은 값
 */
export async function runOverseasJob(): Promise<void> {
  if (isRunning) return;

  if (isKillSwitchActive()) {
    logger.warn('🛑 Kill Switch 활성 — 해외주식 스킵', { component: 'OVERSEAS' });
    return;
  }

  isRunning = true;

  try {
    const activeRegions = getActiveRegions();
    if (activeRegions.length === 0) {
      logger.info('🌏 열린 해외 시장 없음 → 스킵', { component: 'OVERSEAS' });
      return;
    }

    const activeStocks = GLOBAL_WATCHLIST.filter(s => activeRegions.includes(s.region));
    const regionFlags = activeRegions.map(r => r === 'US' ? '🇺🇸' : r === 'JP' ? '🇯🇵' : '🇹🇼').join('');
    logger.info(`${regionFlags} 해외주식 자동매매 시작 (${activeStocks.length}종목)`, { component: 'OVERSEAS' });

    await ensureOverseasTable();

    const holdings = await getHoldings();
    const pendingOrderStocks = await getPendingOverseasStocks();
    let cash = await getCash();

    // ── 1. 시세 + 차트 병렬 수집 (배치 5개씩, rate limit 준수) ──
    const techResults: Array<{
      code: string; name: string; exchange: string;
      price: OverseasPrice; signal: string; score: number;
      rsi: number; adx: number; trendStrength: string;
      dayRangePct: number; // 0=저가, 100=고가 위치
      isMomentum: boolean; // 당일 강한 상승 모멘텀
    }> = [];

    // 배치 처리: 5개씩 병렬 → rate limit 안전
    const BATCH = 5;
    for (let i = 0; i < activeStocks.length; i += BATCH) {
      const batch = activeStocks.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const price = await getOverseasPrice(stock.code, stock.exchange);
          const chart = await getOverseasDailyChart(stock.code, stock.exchange, 65);
          return { stock, price, chart };
        })
      );

      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const { stock, price, chart } = result.value;
        if (chart.length < 30 || price.currentPrice <= 0) continue;

        const candles: OHLCV[] = chart.map(c => ({
          date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
        const tech = analyzeTechnicals(candles);
        if (!tech) continue;

        // 일중 위치: 0=저가, 100=고가
        const dayRange = price.dayHigh - price.dayLow;
        const dayRangePct = dayRange > 0
          ? ((price.currentPrice - price.dayLow) / dayRange) * 100
          : 50;
        // 모멘텀: 당일 +3% 이상 상승 + 고가 근처(상위 40%)
        const isMomentum = price.changePct >= 3 && dayRangePct >= 60;

        techResults.push({
          code: stock.code, name: stock.name, exchange: stock.exchange,
          price, signal: tech.overallSignal, score: tech.score,
          rsi: tech.rsi14, adx: tech.adx14, trendStrength: tech.trendStrength,
          dayRangePct, isMomentum,
        });
        logger.info(
          `  ${stock.code}: $${price.currentPrice} ${price.changePct >= 0 ? '+' : ''}${price.changePct}% | ${tech.overallSignal}(${tech.score}) RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)} 일중${dayRangePct.toFixed(0)}%${isMomentum ? ' 🚀모멘텀' : ''}`,
          { component: 'OVERSEAS' },
        );
      }

      // 배치 간 300ms 간격 (rate limit)
      if (i + BATCH < activeStocks.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (techResults.length === 0) {
      logger.warn('해외주식 분석 데이터 없음 (장 외?)', { component: 'OVERSEAS' });
      return;
    }

    // ── 1-b. 대시보드용 점수 캐시 갱신 ──
    const regionMap = new Map(GLOBAL_WATCHLIST.map(s => [s.code, s.region as 'US' | 'JP' | 'TW']));
    setOverseasScores(techResults.map(t => ({
      code: t.code,
      name: t.name,
      exchange: t.exchange,
      region: regionMap.get(t.code) ?? 'US',
      score: t.score,
      signal: t.signal,
      price: t.price.currentPrice,
      changePct: t.price.changePct,
      rsi: t.rsi,
      cachedAt: Date.now(),
    })));

    // ── 2. AI(Claude) 판단 ──
    const aiInputs: OverseasStockInput[] = techResults.map(t => {
      const holding = holdings.get(t.code);
      const pnlPct = holding
        ? ((t.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100
        : undefined;
      return {
        code: t.code, name: t.name, exchange: t.exchange,
        currentPrice: t.price.currentPrice, changePct: t.price.changePct,
        rsi: t.rsi, adx: t.adx, score: t.score,
        signal: t.signal, trendStrength: t.trendStrength,
        isHolding: !!holding,
        holdingPnlPct: pnlPct,
        dayRangePct: t.dayRangePct,
        isMomentum: t.isMomentum,
      };
    });

    const aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size);

    // AI 결과를 코드 → 판단 맵으로 변환
    const aiMap = new Map(aiDecisions.map(d => [d.code, d]));

    // ── 3. 매도 판단 ──
    const sellOrders: string[] = [];
    for (const [code, holding] of holdings) {
      if (pendingOrderStocks.has(code)) {
        logger.info(`⏳ 미체결 주문 존재 → ${code} 추가 주문 스킵`, { component: 'OVERSEAS' });
        continue;
      }
      const tech = techResults.find(t => t.code === code);
      if (!tech) continue;

      const curPrice = tech.price.currentPrice;
      const pnlPct = ((curPrice - holding.avgPrice) / holding.avgPrice) * 100;
      const ai = aiMap.get(code);

      // 트레일링 스탑: 최고가 갱신
      const prevMax = await getMaxPrice(code);
      const newMax = Math.max(prevMax || holding.avgPrice, curPrice);
      if (newMax > prevMax) await setMaxPrice(code, newMax);
      const maxPnlPct = ((newMax - holding.avgPrice) / holding.avgPrice) * 100;
      const drawdownFromPeak = ((curPrice - newMax) / newMax) * 100;

      let sellReason = '';

      // 1) 손절: -3% (하드 룰)
      if (pnlPct <= -3) {
        sellReason = `손절: ${pnlPct.toFixed(1)}%`;
      }
      // 2) 트레일링 스탑: 최고점 대비 -2.5% 하락 (최소 +2% 이상 수익 구간에서만)
      else if (maxPnlPct >= 2 && drawdownFromPeak <= -2.5) {
        sellReason = `트레일링 스탑: 최고 +${maxPnlPct.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}%`;
      }
      // 3) 하드 익절: +10% (모멘텀 상관없이 확정)
      else if (pnlPct >= 10) {
        sellReason = `익절(10%): +${pnlPct.toFixed(1)}%`;
      }
      // 4) 소프트 익절: +5% BUT 모멘텀 강하면 홀딩
      else if (pnlPct >= 5) {
        const stillMomentum = tech.rsi < 68 && tech.adx >= 18 && tech.score > 20;
        if (!stillMomentum) {
          sellReason = `익절(+${pnlPct.toFixed(1)}%): 모멘텀 약화 RSI=${tech.rsi.toFixed(0)} ADX=${tech.adx.toFixed(0)} score=${tech.score}`;
        } else {
          logger.info(`  ⏳ ${code} +${pnlPct.toFixed(1)}% — 모멘텀 지속 홀딩 (RSI=${tech.rsi.toFixed(0)} ADX=${tech.adx.toFixed(0)}, 목표 10%)`, { component: 'OVERSEAS' });
        }
      }
      // 5) AI SELL 신뢰도 65% 이상 (수익 구간에서만)
      else if (ai?.action === 'SELL' && ai.confidence >= 0.65 && pnlPct > -1) {
        sellReason = `AI 매도: ${ai.reasoning}`;
      }
      // 6) 기술적 강매도 (AI 없을 때 fallback)
      else if (!ai && tech.signal === 'STRONG_SELL' && tech.score < -30) {
        sellReason = `기술적 매도: score=${tech.score}`;
      }

      if (sellReason) {
        const exec = await executeOverseasOrder(
          code,
          'SELL',
          holding.qty,
          curPrice,
          tech.exchange,
          sellReason,
          holding.qty,
          holding.avgPrice,
        );
        if (!exec.submitted) continue;

        if (exec.filledQty <= 0) {
          pendingOrderStocks.add(code);
          sellOrders.push(`매도 접수 ${code} x${holding.qty} (체결 대기)`);
          continue;
        }

        await setHolding(code, exec.finalQty, exec.finalAvgPrice);
        if (exec.finalQty <= 0) {
          await clearMaxPrice(code);
        }

        // 수수료 0.25% 차감 (해외주식 매도: 브로커 수수료 + 거래세 합산)
        const proceeds = exec.filledPrice * exec.filledQty * (1 - 0.0025);
        cash += proceeds;
        await setCash(cash);
        sellOrders.push(`매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason})`);
      }
    }

    // ── 4. 리스크 관리: 일간 손실 한도 체크 ──
    const INITIAL_OVERSEAS_CASH = 10000; // $10,000 초기 자본
    const dailyLossPct = ((cash - INITIAL_OVERSEAS_CASH) / INITIAL_OVERSEAS_CASH) * 100;
    const riskBlocked = dailyLossPct <= -8; // 8% 손실 시 당일 매수 중단
    if (riskBlocked) {
      logger.warn(`⛔ 리스크 한도 초과: 포트폴리오 ${dailyLossPct.toFixed(1)}% → 당일 신규 매수 차단`, { component: 'OVERSEAS' });
    }

    // ── 5. 매수 판단 ──
    const buyOrders: string[] = [];
    const updatedHoldings = await getHoldings();
    const currentHoldingCount = updatedHoldings.size;

    if (!riskBlocked && currentHoldingCount < MAX_POSITIONS && cash >= 200) {
      const buyTargets = techResults
        .filter(t => !updatedHoldings.has(t.code) && !pendingOrderStocks.has(t.code))
        .map(t => {
          const ai = aiMap.get(t.code);
          const aiScore = ai?.action === 'BUY' ? ai.confidence * 100 : 0;
          // 모멘텀 보너스: 당일 강한 상승 중이면 점수 가산
          const momentumBonus = t.isMomentum ? 40 : 0;
          const techScore = (t.signal === 'STRONG_BUY' ? 80 : t.signal === 'BUY' ? 60 : 0)
            + (t.adx >= 20 ? 20 : t.adx >= 15 ? 10 : 0)
            + momentumBonus;
          return { ...t, ai, combinedScore: aiScore + techScore };
        })
        .filter(t => {
          const ai = aiMap.get(t.code);

          // ── 모멘텀 매수: 당일 +3% 이상, 일중 상위 60%, ADX 강세 ──
          // (저점 반등이 아니라 이미 달리는 종목에 올라타기)
          if (t.isMomentum && t.adx >= 18 && t.rsi < 72) {
            if (ai?.action === 'BUY' || ai?.action === 'HOLD' || !ai) return true;
          }

          // ── 저점 반등 매수 (기존 로직) ──
          if (ai?.action === 'BUY' && ai.confidence >= 0.50 && t.adx >= 12) return true;
          if (ai?.action === 'HOLD' && t.signal === 'STRONG_BUY' && t.score > 40 && t.adx >= 15) return true;
          if (!ai) return (t.signal === 'STRONG_BUY' || t.signal === 'BUY') && t.trendStrength !== 'WEAK' && t.adx >= 12;
          return false;
        })
        .sort((a, b) => b.combinedScore - a.combinedScore);

      const slotsAvailable = MAX_POSITIONS - currentHoldingCount;
      for (const target of buyTargets.slice(0, slotsAvailable)) {
        // 모멘텀 매수는 포지션 크기 1.3배 (추세 강할 때 더 태우기)
        const sizeMult = target.isMomentum ? 1.3 : 1.0;
        const positionSize = Math.min(cash * POSITION_PCT * sizeMult, POSITION_SIZE_USD * sizeMult);
        if (positionSize < 50) break;

        const qty = Math.floor(positionSize / target.price.currentPrice);
        if (qty <= 0) continue;

        const buyMode = target.isMomentum ? '🚀모멘텀' : '📉저점반등';
        const reason = target.ai
          ? `${buyMode} AI(${(target.ai.confidence * 100).toFixed(0)}%): ${target.ai.reasoning}`
          : `${buyMode} 기술적: score=${target.score} RSI=${target.rsi.toFixed(0)} ADX=${target.adx.toFixed(0)} 일중${target.dayRangePct.toFixed(0)}%`;

        const exec = await executeOverseasOrder(
          target.code,
          'BUY',
          qty,
          target.price.currentPrice,
          target.exchange,
          reason,
          0,
          0,
        );
        if (!exec.submitted) continue;

        if (exec.filledQty <= 0) {
          pendingOrderStocks.add(target.code);
          buyOrders.push(`매수 접수 ${target.code} x${qty} ${buyMode} (체결 대기)`);
          continue;
        }

        const cost = exec.filledQty * exec.filledPrice;
        await setHolding(target.code, exec.finalQty, exec.finalAvgPrice);
        cash -= cost;
        await setCash(cash);
        buyOrders.push(`매수 ${target.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} ${buyMode} (score=${target.combinedScore.toFixed(0)})`);
      }
    }

    // ── 5. 결과 로그 ──
    const totalActions = buyOrders.length + sellOrders.length;
    const finalHoldings = await getHoldings();
    const holdingList = Array.from(finalHoldings.entries()).map(([code, h]) => {
      const tech = techResults.find(t => t.code === code);
      const pnl = tech ? ((tech.price.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1) : '?';
      return `${code} x${h.qty} @$${h.avgPrice.toFixed(2)} (${Number(pnl) >= 0 ? '+' : ''}${pnl}%)`;
    });

    const summary = [
      `${regionFlags} 해외주식 자동매매 완료`,
      `분석: ${techResults.length}종목 | AI판단: ${aiDecisions.length}건 | 실행: ${totalActions}건`,
      `잔고: $${cash.toFixed(2)} | 보유: ${finalHoldings.size}/${MAX_POSITIONS}종목`,
      ...buyOrders.map(o => `🟢 ${o}`),
      ...sellOrders.map(o => `🔴 ${o}`),
      holdingList.length > 0 ? `\n포트폴리오: ${holdingList.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    logger.info(summary, { component: 'OVERSEAS' });
    await logSystem('INFO', 'OVERSEAS', summary);

    if (totalActions > 0) {
      await sendTelegramMessage(summary);
    }

    reportSuccess();
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`해외주식 자동매매 실패: ${msg}`, { component: 'OVERSEAS' });
    await reportError('OVERSEAS', msg);
  } finally {
    isRunning = false;
  }
}

/**
 * 미국주식 주문 실행 (Paper / Live)
 */
async function executeOverseasOrder(
  code: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  exchange: string,
  reasoning: string,
  previousQty: number,
  previousAvgPrice: number,
): Promise<OverseasExecutionResult> {
  if (config.isPaper) {
    const slippage = side === 'BUY' ? 0.001 : -0.001;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    await insertOrder({
      chain_id: null, stock_code: code, side, order_type: '01',
      quantity: qty, price: fillPrice, kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED', filled_quantity: qty, filled_price: fillPrice,
      status: 'FILLED', trading_mode: 'paper', trigger_source: 'OVERSEAS',
      ai_reasoning: reasoning,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, { component: 'OVERSEAS' });

    const { sendPushNotification } = await import('../notifications/web-push.js');
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    await sendPushNotification({
      title: `${emoji} 해외 ${side === 'BUY' ? '매수' : '매도'}: ${code}`,
      body: `${qty}주 × $${fillPrice.toFixed(2)}\n${reasoning}`,
      tag: `overseas-${side.toLowerCase()}`,
      url: '/',
    }).catch(() => {});
    const finalQty = side === 'BUY' ? previousQty + qty : Math.max(0, previousQty - qty);
    const finalAvgPrice = side === 'BUY' && finalQty > 0
      ? (previousAvgPrice * previousQty + fillPrice * qty) / finalQty
      : (finalQty > 0 ? previousAvgPrice : 0);
    return {
      submitted: true,
      filledQty: qty,
      filledPrice: fillPrice,
      finalQty,
      finalAvgPrice,
      orderNo: fakeOrderNo,
    };
  } else {
    try {
      const result = await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });
      const orderId = await insertOrder({
        chain_id: null, stock_code: code, side, order_type: '01',
        quantity: qty, price, kis_order_no: result.orderNo,
        kis_status: result.success ? 'SUBMITTED' : 'FAILED',
        filled_quantity: 0, filled_price: null,
        status: result.success ? 'PENDING' : 'FAILED', trading_mode: 'live',
        trigger_source: 'OVERSEAS', ai_reasoning: reasoning,
      });
      if (result.success) {
        logger.info(`🌍 [LIVE] 주문 접수: ${side} ${code} x${qty} @$${price.toFixed(2)} (${result.orderNo})`, { component: 'OVERSEAS' });
        const confirmed = await confirmOverseasFillFromBalance({
          code,
          exchange,
          side,
          requestedQty: qty,
          previousQty,
          previousAvgPrice,
          fallbackPrice: price,
        });

        if (confirmed.filledQty > 0) {
          await updateOrder(orderId, {
            filled_quantity: confirmed.filledQty,
            filled_price: confirmed.filledPrice,
            status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
            kis_status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
          });
        } else {
          logger.warn(`⏳ 체결 미확인: ${code} (${result.orderNo}) → PENDING 유지`, { component: 'OVERSEAS' });
        }

        return {
          submitted: true,
          filledQty: confirmed.filledQty,
          filledPrice: confirmed.filledPrice,
          finalQty: confirmed.finalQty,
          finalAvgPrice: confirmed.finalAvgPrice,
          orderNo: result.orderNo,
        };
      } else {
        logger.error(`🌍 주문 실패: ${code} - ${result.message}`, { component: 'OVERSEAS' });
        return {
          submitted: false,
          filledQty: 0,
          filledPrice: price,
          finalQty: previousQty,
          finalAvgPrice: previousAvgPrice,
          orderNo: result.orderNo,
        };
      }
    } catch (e) {
      logger.error(`🌍 주문 에러: ${code} - ${(e as Error).message}`, { component: 'OVERSEAS' });
      return {
        submitted: false,
        filledQty: 0,
        filledPrice: price,
        finalQty: previousQty,
        finalAvgPrice: previousAvgPrice,
        orderNo: '',
      };
    }
  }
}
