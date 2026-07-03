/**
 * Analytics Hub — 통합 분석 모듈
 *
 * #4/#16: 진입소스별 승률 분석
 * #14: 성과 귀인 분석 (Performance Attribution)
 * #15: 섹터 로테이션 리포트
 * #17: 시장 상관관계 추적
 *
 * 매일 19:50 KST 실행 → overseas_state 저장 + 텔레그램 리포트
 */
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getOverseasState, setOverseasState } from '../scheduler/overseas/utils.js';

const COMP = 'ANALYTICS';

// ══════════════════════════════════════════════════════════════
// 1. 진입소스별 승률 분석 (#4, #16)
// ══════════════════════════════════════════════════════════════

interface EntrySourceStats {
  source: string;
  trades: number;
  wins: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlUsd: number;
}

async function analyzeEntrySourceWinRates(isPaper: boolean, days = 90): Promise<EntrySourceStats[]> {
  const mode = isPaper ? 'paper' : 'live';
  const { rows } = await getPool().query(
    `SELECT ai_reasoning, filled_price, avg_buy_price, quantity
     FROM orders
     WHERE trigger_source = 'OVERSEAS' AND side = 'SELL' AND status = 'FILLED'
       AND filled_price > 0 AND avg_buy_price > 0
       AND created_at >= NOW() - INTERVAL '${days} days'
       AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
     ORDER BY created_at DESC`,
    [mode],
  );

  const statsMap = new Map<string, { wins: number; losses: number; totalPnlPct: number; totalPnlUsd: number }>();

  for (const r of rows) {
    const reasoning = String(r.ai_reasoning ?? '');
    const source = extractEntrySource(reasoning);
    const avgBuy = Number(r.avg_buy_price);
    const filled = Number(r.filled_price);
    const qty = Number(r.quantity);
    if (avgBuy <= 0 || filled <= 0) continue;

    const pnlPct = ((filled - avgBuy) / avgBuy) * 100;
    const pnlUsd = (filled - avgBuy) * qty;
    const stat = statsMap.get(source) ?? { wins: 0, losses: 0, totalPnlPct: 0, totalPnlUsd: 0 };
    if (pnlPct >= 0) stat.wins++;
    else stat.losses++;
    stat.totalPnlPct += pnlPct;
    stat.totalPnlUsd += pnlUsd;
    statsMap.set(source, stat);
  }

  return [...statsMap.entries()]
    .map(([source, s]) => {
      const trades = s.wins + s.losses;
      return {
        source,
        trades,
        wins: s.wins,
        winRate: trades > 0 ? s.wins / trades : 0,
        avgPnlPct: trades > 0 ? s.totalPnlPct / trades : 0,
        totalPnlUsd: s.totalPnlUsd,
      };
    })
    .filter((s) => s.trades >= 2)
    .sort((a, b) => b.trades - a.trades);
}

function extractEntrySource(reasoning: string): string {
  if (reasoning.includes('[BIGMOVER]') || reasoning.includes('빅무버')) return 'BIGMOVER';
  if (reasoning.includes('[MOMENTUM]') || reasoning.includes('모멘텀')) return 'MOMENTUM';
  if (reasoning.includes('[BB_BREAKOUT]') || reasoning.includes('볼린저')) return 'BB_BREAKOUT';
  if (reasoning.includes('[OVERSOLD]') || reasoning.includes('과매도')) return 'OVERSOLD';
  if (reasoning.includes('[SCALP]') || reasoning.includes('스캘프')) return 'SCALP';
  if (reasoning.includes('[SNIPER]') || reasoning.includes('스나이퍼')) return 'SNIPER';
  if (reasoning.includes('[DIP_BUY]') || reasoning.includes('딥바이')) return 'DIP_BUY';
  if (reasoning.includes('[TECHNICAL]')) return 'TECHNICAL';
  return 'OTHER';
}

// ══════════════════════════════════════════════════════════════
// 2. 성과 귀인 분석 (#14)
// ══════════════════════════════════════════════════════════════

interface PerformanceAttribution {
  market: string; // 'KR' | 'OVERSEAS'
  totalPnlUsd: number;
  totalTrades: number;
  byStrategy: Array<{ strategy: string; pnlUsd: number; trades: number; winRate: number }>;
  bySector: Array<{ sector: string; pnlUsd: number; trades: number; winRate: number }>;
  bestStock: { code: string; pnlUsd: number; trades: number } | null;
  worstStock: { code: string; pnlUsd: number; trades: number } | null;
}

async function getPerformanceAttribution(isPaper: boolean, days = 30): Promise<PerformanceAttribution> {
  const mode = isPaper ? 'paper' : 'live';
  const { rows } = await getPool().query(
    `SELECT stock_code, trigger_source, filled_price, avg_buy_price, quantity, ai_reasoning
     FROM orders
     WHERE side = 'SELL' AND status = 'FILLED'
       AND filled_price > 0 AND avg_buy_price > 0
       AND created_at >= NOW() - INTERVAL '${days} days'
       AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
     ORDER BY created_at DESC`,
    [mode],
  );

  let totalPnlUsd = 0;
  const strategyMap = new Map<string, { pnl: number; wins: number; total: number }>();
  const sectorMap = new Map<string, { pnl: number; wins: number; total: number }>();
  const stockMap = new Map<string, { pnl: number; total: number }>();

  for (const r of rows) {
    const avgBuy = Number(r.avg_buy_price);
    const filled = Number(r.filled_price);
    const qty = Number(r.quantity);
    if (avgBuy <= 0 || filled <= 0) continue;
    const pnlUsd = (filled - avgBuy) * qty;
    const isWin = pnlUsd >= 0;
    totalPnlUsd += pnlUsd;

    // By strategy (trigger_source)
    const strategy = String(r.trigger_source ?? 'UNKNOWN');
    const ss = strategyMap.get(strategy) ?? { pnl: 0, wins: 0, total: 0 };
    ss.pnl += pnlUsd;
    ss.total++;
    if (isWin) ss.wins++;
    strategyMap.set(strategy, ss);

    // By sector (from watchlist lookup via code)
    const sector = extractSectorFromCode(String(r.stock_code));
    const sec = sectorMap.get(sector) ?? { pnl: 0, wins: 0, total: 0 };
    sec.pnl += pnlUsd;
    sec.total++;
    if (isWin) sec.wins++;
    sectorMap.set(sector, sec);

    // By stock
    const code = String(r.stock_code);
    const st = stockMap.get(code) ?? { pnl: 0, total: 0 };
    st.pnl += pnlUsd;
    st.total++;
    stockMap.set(code, st);
  }

  const byStrategy = [...strategyMap.entries()]
    .map(([strategy, s]) => ({ strategy, pnlUsd: s.pnl, trades: s.total, winRate: s.total > 0 ? s.wins / s.total : 0 }))
    .sort((a, b) => b.pnlUsd - a.pnlUsd);

  const bySector = [...sectorMap.entries()]
    .map(([sector, s]) => ({ sector, pnlUsd: s.pnl, trades: s.total, winRate: s.total > 0 ? s.wins / s.total : 0 }))
    .sort((a, b) => b.pnlUsd - a.pnlUsd);

  const stockArr = [...stockMap.entries()].map(([code, s]) => ({ code, pnlUsd: s.pnl, trades: s.total }));
  const bestStock = stockArr.length > 0 ? stockArr.reduce((a, b) => (a.pnlUsd > b.pnlUsd ? a : b)) : null;
  const worstStock = stockArr.length > 0 ? stockArr.reduce((a, b) => (a.pnlUsd < b.pnlUsd ? a : b)) : null;

  return {
    market: 'OVERSEAS',
    totalPnlUsd: totalPnlUsd,
    totalTrades: rows.length,
    byStrategy,
    bySector,
    bestStock,
    worstStock,
  };
}

function extractSectorFromCode(code: string): string {
  // Dynamic import would create circular dependency, use simple mapping
  const SECTOR_QUICK: Record<string, string> = {
    NVDA: 'AI_SEMI', AMD: 'AI_SEMI', AVGO: 'AI_SEMI', TSM: 'TW_SEMI', MRVL: 'AI_SEMI', MU: 'AI_SEMI', SMCI: 'AI_SEMI',
    AAPL: 'TECH', MSFT: 'TECH', META: 'TECH', NFLX: 'TECH',
    AMZN: 'CLOUD', GOOGL: 'CLOUD', ORCL: 'CLOUD', NOW: 'CLOUD', CRM: 'CLOUD', SNOW: 'CLOUD',
    TSLA: 'EV', COIN: 'CRYPTO',
    RTX: 'DEFENSE', LMT: 'DEFENSE', GEV: 'DEFENSE', PLTR: 'DEFENSE', GE: 'DEFENSE',
    LLY: 'HEALTH', UNH: 'HEALTH', ABBV: 'HEALTH',
    TQQQ: 'LEV_BULL', SOXL: 'LEV_BULL', UPRO: 'LEV_BULL',
    SQQQ: 'LEV_BEAR', SOXS: 'LEV_BEAR', SPXS: 'LEV_BEAR',
  };
  return SECTOR_QUICK[code] ?? 'OTHER';
}

// ══════════════════════════════════════════════════════════════
// 3. 섹터 로테이션 리포트 (#15)
// ══════════════════════════════════════════════════════════════

interface SectorRotation {
  sector: string;
  recentWinRate: number; // 최근 14일
  olderWinRate: number; // 15~30일
  momentum: number; // recent - older (양수 = 개선)
  recentTrades: number;
  olderTrades: number;
}

async function analyzeSectorRotation(isPaper: boolean): Promise<SectorRotation[]> {
  const mode = isPaper ? 'paper' : 'live';

  const query = (interval1: string, interval2: string) => getPool().query(
    `SELECT stock_code, filled_price, avg_buy_price
     FROM orders
     WHERE trigger_source = 'OVERSEAS' AND side = 'SELL' AND status = 'FILLED'
       AND filled_price > 0 AND avg_buy_price > 0
       AND created_at >= NOW() - INTERVAL '${interval1}'
       AND created_at < NOW() - INTERVAL '${interval2}'
       AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))`,
    [mode],
  );

  const [recentResult, olderResult] = await Promise.all([
    query('14 days', '0 days'),
    query('30 days', '14 days'),
  ]);

  const calcSectorStats = (rows: any[]) => {
    const map = new Map<string, { wins: number; total: number }>();
    for (const r of rows) {
      const sector = extractSectorFromCode(String(r.stock_code));
      const pnl = Number(r.filled_price) - Number(r.avg_buy_price);
      const s = map.get(sector) ?? { wins: 0, total: 0 };
      s.total++;
      if (pnl >= 0) s.wins++;
      map.set(sector, s);
    }
    return map;
  };

  const recentStats = calcSectorStats(recentResult.rows);
  const olderStats = calcSectorStats(olderResult.rows);

  const allSectors = new Set([...recentStats.keys(), ...olderStats.keys()]);
  const rotations: SectorRotation[] = [];

  for (const sector of allSectors) {
    const recent = recentStats.get(sector);
    const older = olderStats.get(sector);
    const recentWinRate = recent && recent.total > 0 ? recent.wins / recent.total : 0;
    const olderWinRate = older && older.total > 0 ? older.wins / older.total : 0;
    const recentTrades = recent?.total ?? 0;
    const olderTrades = older?.total ?? 0;
    if (recentTrades + olderTrades < 2) continue;

    rotations.push({
      sector,
      recentWinRate,
      olderWinRate,
      momentum: recentWinRate - olderWinRate,
      recentTrades,
      olderTrades,
    });
  }

  return rotations.sort((a, b) => b.momentum - a.momentum);
}

// ══════════════════════════════════════════════════════════════
// 4. 시장 상관관계 추적 (#17)
// ══════════════════════════════════════════════════════════════

interface CorrelationPair {
  codeA: string;
  codeB: string;
  correlation: number; // -1 ~ 1
  coMoveDays: number;
  totalDays: number;
}

async function trackCorrelations(isPaper: boolean): Promise<CorrelationPair[]> {
  const mode = isPaper ? 'paper' : 'live';
  // 최근 30일 매도 기록에서 같은 날 매매된 종목 쌍의 손익 방향 일치도 계산
  const { rows } = await getPool().query(
    `SELECT stock_code, filled_price, avg_buy_price, DATE(created_at) as trade_date
     FROM orders
     WHERE trigger_source = 'OVERSEAS' AND side = 'SELL' AND status = 'FILLED'
       AND filled_price > 0 AND avg_buy_price > 0
       AND created_at >= NOW() - INTERVAL '60 days'
       AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))`,
    [mode],
  );

  // 날짜별 종목 손익 방향
  const dailyResults = new Map<string, Map<string, boolean>>(); // date → code → isWin
  for (const r of rows) {
    const date = String(r.trade_date).slice(0, 10);
    const code = String(r.stock_code);
    const isWin = Number(r.filled_price) >= Number(r.avg_buy_price);
    if (!dailyResults.has(date)) dailyResults.set(date, new Map());
    dailyResults.get(date)!.set(code, isWin);
  }

  // 코드 쌍별 동시 거래일 상관관계
  const pairMap = new Map<string, { coMove: number; total: number }>();
  for (const [, dayMap] of dailyResults) {
    const codes = [...dayMap.keys()];
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const key = [codes[i], codes[j]].sort().join(':');
        const s = pairMap.get(key) ?? { coMove: 0, total: 0 };
        s.total++;
        if (dayMap.get(codes[i]) === dayMap.get(codes[j])) s.coMove++;
        pairMap.set(key, s);
      }
    }
  }

  return [...pairMap.entries()]
    .filter(([, s]) => s.total >= 3)
    .map(([key, s]) => {
      const [codeA, codeB] = key.split(':');
      return {
        codeA,
        codeB,
        correlation: (2 * s.coMove / s.total) - 1, // -1 ~ 1 scale
        coMoveDays: s.coMove,
        totalDays: s.total,
      };
    })
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
    .slice(0, 10);
}

// ══════════════════════════════════════════════════════════════
// 5. 통합 실행 + 리포트
// ══════════════════════════════════════════════════════════════

export async function runAnalyticsHub(isPaper = true): Promise<void> {
  const mode = isPaper ? 'paper' : 'live';
  logger.info(`📊 Analytics Hub 시작 (${mode})`, { component: COMP });

  try {
    const [entrySources, attribution, rotation, correlations] = await Promise.all([
      analyzeEntrySourceWinRates(isPaper).catch(() => [] as EntrySourceStats[]),
      getPerformanceAttribution(isPaper).catch(() => null),
      analyzeSectorRotation(isPaper).catch(() => [] as SectorRotation[]),
      trackCorrelations(isPaper).catch(() => [] as CorrelationPair[]),
    ]);

    // overseas_state 저장
    const stateKey = `analytics_hub_${mode}`;
    const payload = { entrySources, attribution, rotation, correlations, analyzedAt: new Date().toISOString() };
    await setOverseasState(stateKey, JSON.stringify(payload));

    // 텔레그램 리포트
    const lines = [`📊 Analytics Hub (${mode})`];

    // 진입소스별 승률
    if (entrySources.length > 0) {
      lines.push('', '🎯 진입소스별 승률:');
      for (const s of entrySources.slice(0, 6)) {
        const emoji = s.winRate >= 0.6 ? '✅' : s.winRate >= 0.4 ? '➖' : '❌';
        lines.push(`  ${emoji} ${s.source}: ${(s.winRate * 100).toFixed(0)}% (${s.trades}건) avg${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}%`);
      }
    }

    // 성과 귀인
    if (attribution && attribution.totalTrades > 0) {
      lines.push('', `💰 30일 성과 귀인: $${attribution.totalPnlUsd.toFixed(0)} (${attribution.totalTrades}건)`);
      if (attribution.bestStock) lines.push(`  🏆 최고: ${attribution.bestStock.code} $${attribution.bestStock.pnlUsd.toFixed(0)}`);
      if (attribution.worstStock) lines.push(`  💀 최악: ${attribution.worstStock.code} $${attribution.worstStock.pnlUsd.toFixed(0)}`);
      if (attribution.bySector.length > 0) {
        const top = attribution.bySector[0];
        const bottom = attribution.bySector[attribution.bySector.length - 1];
        lines.push(`  📈 최고섹터: ${top.sector} $${top.pnlUsd.toFixed(0)} | 최악: ${bottom.sector} $${bottom.pnlUsd.toFixed(0)}`);
      }
    }

    // 섹터 로테이션
    const improving = rotation.filter((r) => r.momentum > 0.1 && r.recentTrades >= 2);
    const declining = rotation.filter((r) => r.momentum < -0.1 && r.olderTrades >= 2);
    if (improving.length > 0 || declining.length > 0) {
      lines.push('', '🔄 섹터 로테이션 (14일 vs 이전):');
      for (const s of improving.slice(0, 3)) {
        lines.push(`  📈 ${s.sector}: ${(s.olderWinRate * 100).toFixed(0)}%→${(s.recentWinRate * 100).toFixed(0)}% (+${(s.momentum * 100).toFixed(0)}%p)`);
      }
      for (const s of declining.slice(0, 3)) {
        lines.push(`  📉 ${s.sector}: ${(s.olderWinRate * 100).toFixed(0)}%→${(s.recentWinRate * 100).toFixed(0)}% (${(s.momentum * 100).toFixed(0)}%p)`);
      }
    }

    // 상관관계
    const highCorr = correlations.filter((c) => Math.abs(c.correlation) >= 0.5);
    if (highCorr.length > 0) {
      lines.push('', '🔗 상관관계 (|r|≥0.5):');
      for (const c of highCorr.slice(0, 5)) {
        const dir = c.correlation > 0 ? '동행' : '역행';
        lines.push(`  ${c.codeA}↔${c.codeB}: r=${c.correlation.toFixed(2)} (${dir}, ${c.totalDays}일)`);
      }
    }

    const report = lines.join('\n');
    logger.info(report, { component: COMP });
    await sendTelegramMessage(report).catch(() => {});
  } catch (e: any) {
    logger.error(`Analytics Hub 실패: ${e.message}`, { component: COMP });
  }
}
