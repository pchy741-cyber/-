import { Hono } from 'hono';
import { getInvestorFlow } from '../../../automation/investor-flow.js';
import { fetchShortSellingData } from '../../../automation/short-selling.js';
import { getActiveWatchlist, getOpenChains, getPool } from '../../../db/client.js';
import { getDailyChart } from '../../../kis/market.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const marketDataRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── 52주 신고가 스캐너 (워치리스트) ──
let _highCache: { data: any[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
let _highRefreshing = false;
async function _refreshHighs() {
  const watchlist = await getActiveWatchlist();
  const targets = watchlist.slice(0, 20);
  const results = await Promise.allSettled(
    targets.map(async (w) => {
      const candles = await getDailyChart(w.stock_code, 252).catch(() => []);
      if (candles.length < 10) return null;
      const high52w = Math.max(...candles.map((c: any) => c.high ?? c.close));
      const current = candles[0]?.close ?? 0;
      const dropFromHigh = high52w > 0 ? ((current - high52w) / high52w) * 100 : 0;
      const isNearHigh = dropFromHigh >= -3;
      return { stock_code: w.stock_code, stock_name: w.stock_name, current, high52w, dropFromHigh, isNearHigh };
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value)
    .sort((a, b) => b.dropFromHigh - a.dropFromHigh);
}
marketDataRoutes.get('/market/52w-highs', async (c) => {
  try {
    const stale = Date.now() - _highCache.fetchedAt >= 10 * 60 * 1000;
    if (_highCache.data.length > 0) {
      if (stale && !_highRefreshing) {
        _highRefreshing = true;
        _refreshHighs()
          .then((items) => {
            _highCache = { data: items, fetchedAt: Date.now() };
          })
          .catch(() => {})
          .finally(() => {
            _highRefreshing = false;
          });
      }
      return c.json({ items: _highCache.data });
    }
    if (_highRefreshing) return c.json({ items: [] });
    _highRefreshing = true;
    const items = await _refreshHighs().finally(() => {
      _highRefreshing = false;
    });
    _highCache = { data: items, fetchedAt: Date.now() };
    return c.json({ items });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 공매도 비율 (보유종목) — paper/live 분리 캐시 ──
const _shortCache: Record<'paper' | 'live', { data: any[]; fetchedAt: number }> = {
  paper: { data: [], fetchedAt: 0 },
  live: { data: [], fetchedAt: 0 },
};
const _shortRefreshing: Record<'paper' | 'live', boolean> = { paper: false, live: false };
async function _refreshShorts(isPaper: boolean) {
  const openChains = await getOpenChains(isPaper);
  const targets = openChains.filter((ch: any) => Number(ch.total_quantity) > 0);
  const results = await Promise.allSettled(
    targets.map(async (ch: any) => {
      const s = await fetchShortSellingData(ch.stock_code, 5).catch(() => null);
      if (!s) return null;
      return {
        stock_code: ch.stock_code,
        stock_name: (ch as any).stock_name ?? ch.stock_code,
        shortRatio: s.shortRatio,
        isIncreasing: s.isIncreasing,
        riskLevel: s.riskLevel,
        trend: s.shortTrend,
      };
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value)
    .sort((a, b) => b.shortRatio - a.shortRatio);
}
marketDataRoutes.get('/market/short-selling', async (c) => {
  try {
    const isPaper = resolveViewIsPaper(c);
    const key = isPaper ? 'paper' : 'live';
    const stale = Date.now() - _shortCache[key].fetchedAt >= 10 * 60 * 1000;
    if (_shortCache[key].data.length > 0) {
      if (stale && !_shortRefreshing[key]) {
        _shortRefreshing[key] = true;
        _refreshShorts(isPaper)
          .then((items) => {
            _shortCache[key] = { data: items, fetchedAt: Date.now() };
          })
          .catch(() => {})
          .finally(() => {
            _shortRefreshing[key] = false;
          });
      }
      return c.json({ items: _shortCache[key].data });
    }
    if (_shortRefreshing[key]) return c.json({ items: [] });
    _shortRefreshing[key] = true;
    const items = await _refreshShorts(isPaper).finally(() => {
      _shortRefreshing[key] = false;
    });
    _shortCache[key] = { data: items, fetchedAt: Date.now() };
    return c.json({ items });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 업종 히트맵 (네이버 금융 스크래핑) ──
let _sectorCache: { data: any[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
marketDataRoutes.get('/market/sector-heatmap', async (c) => {
  try {
    if (Date.now() - _sectorCache.fetchedAt < 5 * 60 * 1000 && _sectorCache.data.length > 0)
      return c.json({ items: _sectorCache.data });
    const res = await fetch('https://finance.naver.com/sise/sise_group.naver?type=upjong', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko' },
      signal: AbortSignal.timeout(8000),
    });
    // 네이버 파이낸스는 EUC-KR 인코딩 — text()는 UTF-8 기본값이라 한글 깨짐
    const buf = await res.arrayBuffer();
    const html = new TextDecoder('euc-kr').decode(buf);
    const rows: any[] = [];
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/g;
    let m: RegExpExecArray | null = rowRe.exec(html);
    while (m !== null) {
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      const tds: string[] = [];
      let td: RegExpExecArray | null = tdRe.exec(m[0]);
      while (td !== null) {
        tds.push(td[1].replace(/<[^>]+>/g, '').trim());
        td = tdRe.exec(m[0]);
      }
      if (tds.length >= 3 && tds[0] && !Number.isNaN(parseFloat(tds[2]?.replace(/[^-0-9.]/g, '')))) {
        rows.push({ name: tds[0], pct: parseFloat(tds[2].replace(/[^-0-9.]/g, '')) || 0 });
      }
      m = rowRe.exec(html);
    }
    const items = rows.filter((r) => r.name && r.name.length > 1).slice(0, 20);
    if (items.length > 0) _sectorCache = { data: items, fetchedAt: Date.now() };
    return c.json({ items });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 포트폴리오 상관관계 경고 ──
const SECTOR_MAP: Record<string, string> = {
  '000660': '반도체',
  '005930': '반도체',
  '042700': '반도체',
  '005290': '반도체',
  '357780': '반도체',
  '403870': '반도체',
  '051910': '배터리',
  '006400': '배터리',
  '247540': '배터리',
  '373220': '배터리',
  '336260': '배터리',
  '003670': '배터리',
  '012450': '방산',
  '079550': '방산',
  '034020': '방산',
  '035420': '인터넷',
  '035720': '인터넷',
  '377300': '인터넷',
  '207940': '바이오',
  '068270': '바이오',
  '328130': '바이오',
  '196170': '바이오',
  '028300': '바이오',
  '055550': '금융',
  '105560': '금융',
  '316140': '금융',
  '267260': '전력',
  '009540': '조선',
  '066570': '가전',
};
marketDataRoutes.get('/market/correlation', async (c) => {
  try {
    const isPaper = resolveViewIsPaper(c);
    const openChains = await getOpenChains(isPaper);
    const held = openChains.filter((ch: any) => Number(ch.total_quantity) > 0);
    const sectorGroups: Record<string, string[]> = {};
    for (const ch of held) {
      const sector = SECTOR_MAP[ch.stock_code] ?? '기타';
      if (!sectorGroups[sector]) sectorGroups[sector] = [];
      sectorGroups[sector].push((ch as any).stock_name ?? ch.stock_code);
    }
    const warnings = Object.entries(sectorGroups)
      .filter(([, names]) => names.length >= 2)
      .map(([sector, names]) => ({ sector, count: names.length, stocks: names }));
    return c.json({ warnings, sectorGroups });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── 워치리스트 외국인/기관 순매매 동향 ──
let _flowCache: { data: any[]; fetchedAt: number } = { data: [], fetchedAt: 0 };
const FLOW_CACHE_TTL = 5 * 60 * 1000;
let _flowRefreshing = false;
async function _refreshFlow() {
  const watchlist = await getActiveWatchlist();
  const targets = watchlist.slice(0, 15);
  const results = await Promise.allSettled(
    targets.map(async (w) => {
      const flow = await getInvestorFlow(w.stock_code, 5);
      return {
        stock_code: w.stock_code,
        stock_name: w.stock_name,
        foreignNet: flow.foreignNet,
        institutionNet: flow.institutionNet,
        foreignStreak: flow.foreignStreak,
        trend: flow.trend,
      };
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => b.foreignNet + b.institutionNet - (a.foreignNet + a.institutionNet));
}
marketDataRoutes.get('/market/investor-flow', async (c) => {
  try {
    const stale = Date.now() - _flowCache.fetchedAt >= FLOW_CACHE_TTL;
    if (_flowCache.data.length > 0) {
      if (stale && !_flowRefreshing) {
        _flowRefreshing = true;
        _refreshFlow()
          .then((items) => {
            _flowCache = { data: items, fetchedAt: Date.now() };
          })
          .catch(() => {})
          .finally(() => {
            _flowRefreshing = false;
          });
      }
      return c.json({ items: _flowCache.data, cached: true });
    }
    if (_flowRefreshing) return c.json({ items: [], cached: true });
    _flowRefreshing = true;
    const items = await _refreshFlow().finally(() => {
      _flowRefreshing = false;
    });
    _flowCache = { data: items, fetchedAt: Date.now() };
    return c.json({ items, cached: false });
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── [10] 성과 분석: 전략모드별 어트리뷰션 ──
// 각 전략 모드별 실현 손익, 수수료, 슬리피지 추정, 순손익, 승률, 평균 보유시간
marketDataRoutes.get('/performance/attribution', async (c) => {
  try {
    const isPaper = resolveViewIsPaper(c);
    const { rows } = await getPool().query(
      `
      SELECT
        tc.strategy_mode                                            AS mode,
        COUNT(*)                                                    AS trades,
        SUM(
          (o.filled_price - tc.avg_buy_price) * o.filled_quantity
        )                                                           AS gross_pnl,
        -- 왕복 수수료 추정: 매도금액×0.0025 (국내 0.015%+증권사 0.015%+거래세 0.2%)
        SUM(o.filled_price * o.filled_quantity * 0.0025)           AS est_commission,
        COUNT(*) FILTER (
          WHERE (o.filled_price - tc.avg_buy_price) > 0
        )                                                           AS wins,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (o.created_at - tc.opened_at)) / 3600
        )::numeric, 1)                                             AS avg_hold_hours
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.side = 'SELL'
        AND o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND tc.is_paper = $1
        AND o.created_at >= NOW() - INTERVAL '90 days'
        AND o.filled_price IS NOT NULL
        AND tc.avg_buy_price IS NOT NULL
      GROUP BY tc.strategy_mode
      ORDER BY gross_pnl DESC
    `,
      [isPaper],
    );

    const result = rows.map((r: any) => {
      const trades = Number(r.trades);
      const grossPnl = Number(r.gross_pnl ?? 0);
      const commission = Number(r.est_commission ?? 0);
      return {
        mode: r.mode ?? 'UNKNOWN',
        trades,
        grossPnl: Math.round(grossPnl),
        estCommission: Math.round(commission),
        netPnl: Math.round(grossPnl - commission),
        winRate: trades > 0 ? Math.round((Number(r.wins) / trades) * 100) : 0,
        avgHoldHours: Number(r.avg_hold_hours ?? 0),
      };
    });

    return c.json(result);
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ── [10] 성과 분석: 거래내역 CSV 내보내기 ──
// 쿼리파라미터: days=90 (기본값), mode= (필터)
marketDataRoutes.get('/performance/export-csv', async (c) => {
  try {
    const rawDays = Number(c.req.query('days') ?? 90);
    const days = Math.min(365, Math.max(1, Number.isFinite(rawDays) ? rawDays : 90));
    const modeFilter = c.req.query('mode') ?? '';

    const isPaper = resolveViewIsPaper(c);
    const params: unknown[] = [days, isPaper];
    const modeClause = modeFilter ? 'AND tc.strategy_mode = $3' : '';
    if (modeFilter) params.push(modeFilter);

    const { rows } = await getPool().query(
      `
      SELECT
        o.created_at                                      AS "체결일시",
        tc.stock_code                                     AS "종목코드",
        o.side                                            AS "매수매도",
        tc.strategy_mode                                  AS "전략모드",
        o.filled_quantity                                 AS "수량",
        tc.avg_buy_price                                  AS "평균매수가",
        o.filled_price                                    AS "체결가",
        ROUND(
          (o.filled_price - tc.avg_buy_price) * o.filled_quantity
        )                                                 AS "손익(원)",
        ROUND(
          (o.filled_price - tc.avg_buy_price)
          / NULLIF(tc.avg_buy_price, 0) * 100, 2
        )                                                 AS "수익률(%)",
        o.kis_order_no                                    AS "KIS주문번호"
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.side = 'SELL'
        AND o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND tc.is_paper = $2
        AND o.created_at >= NOW() - ($1 || ' days')::INTERVAL
        ${modeClause}
        AND o.filled_price IS NOT NULL
        AND tc.avg_buy_price IS NOT NULL
      ORDER BY o.created_at DESC
    `,
      params,
    );

    if (rows.length === 0) {
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', 'attachment; filename="trades.csv"');
      return c.body('﻿체결일시,종목코드,매수매도,전략모드,수량,평균매수가,체결가,손익(원),수익률(%),KIS주문번호\n');
    }

    const headers = Object.keys(rows[0]);
    const csvEscape = (v: unknown) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvLines = [
      `﻿${headers.join(',')}`,
      ...rows.map((row: any) => headers.map((h) => csvEscape(row[h])).join(',')),
    ];

    const filename = `trades_${new Date().toISOString().slice(0, 10)}.csv`;
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(csvLines.join('\n'));
  } catch (err: any) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});
