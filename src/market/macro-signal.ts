/**
 * 거시경제 신호 — 무료 API 기반
 *
 * 수집 항목:
 *   1. USD/KRW 환율 (open.er-api.com — 키 없음)
 *   2. 미국 Nasdaq 등락 (Yahoo Finance 비공식 — 키 없음)
 *   3. FRED 미국 기준금리 DFF (fredgraph.csv — 키 없음)
 *
 * 결과: KOSPI에 대한 macro 방향 신호 (-20~+20 점수 보정값)
 */

import { logger } from '../utils/logger.js';

export interface MacroSignal {
  usdKrw: number | null;          // 현재 환율
  usdKrwChange1d: number | null;  // 1일 변동 (원)
  nasdaqChange1d: number | null;  // Nasdaq 등락률 %
  fedRate: number | null;         // 미국 기준금리 %
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  scoreAdj: number;               // Gemini 점수 보정 (-20~+20)
  summary: string;
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4시간
let _cache: { data: MacroSignal; fetchedAt: number } | null = null;

// ── 1. USD/KRW 환율 ────────────────────────────────────────────────
async function fetchUsdKrw(): Promise<{ rate: number; change1d: number | null }> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', {
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`ExchangeRate API HTTP ${res.status}`);
  const data = (await res.json()) as { rates?: Record<string, number> };
  const krw = data.rates?.KRW;
  if (!krw) throw new Error('KRW rate not found');
  return { rate: krw, change1d: null };
}

// ── 2. Nasdaq 1일 등락 ──────────────────────────────────────────────
async function fetchNasdaqChange(): Promise<number | null> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1d&range=2d';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantOps/1.0)' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> };
  };
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice || !meta?.chartPreviousClose) return null;
  return ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
}

// ── 3. FRED 기준금리 ───────────────────────────────────────────────
async function fetchFedRate(): Promise<number | null> {
  const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantOps/1.0)' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split('\n').filter((l) => !l.startsWith('DATE'));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const val = parseFloat(last.split(',')[1] ?? '');
  return isFinite(val) ? val : null;
}

// ── 종합 신호 계산 ─────────────────────────────────────────────────
function computeSignal(
  usdKrw: number | null,
  nasdaqChange: number | null,
  fedRate: number | null,
): Pick<MacroSignal, 'direction' | 'scoreAdj' | 'summary'> {
  let adj = 0;
  const notes: string[] = [];

  // USD/KRW: 원화 약세(환율 상승) → KOSPI 외국인 이탈 → 악재
  if (usdKrw) {
    if (usdKrw > 1420) { adj -= 8; notes.push(`환율 ${usdKrw.toFixed(0)}원(고위험)`); }
    else if (usdKrw > 1380) { adj -= 4; notes.push(`환율 ${usdKrw.toFixed(0)}원(주의)`); }
    else if (usdKrw < 1320) { adj += 5; notes.push(`환율 ${usdKrw.toFixed(0)}원(호재)`); }
    else { notes.push(`환율 ${usdKrw.toFixed(0)}원(중립)`); }
  }

  // Nasdaq: 미국 증시 등락 → KOSPI 연동
  if (nasdaqChange !== null) {
    if (nasdaqChange >= 1.5) { adj += 10; notes.push(`Nasdaq +${nasdaqChange.toFixed(1)}%(강세)`); }
    else if (nasdaqChange >= 0.5) { adj += 5; notes.push(`Nasdaq +${nasdaqChange.toFixed(1)}%(호재)`); }
    else if (nasdaqChange <= -1.5) { adj -= 12; notes.push(`Nasdaq ${nasdaqChange.toFixed(1)}%(급락)`); }
    else if (nasdaqChange <= -0.5) { adj -= 6; notes.push(`Nasdaq ${nasdaqChange.toFixed(1)}%(약세)`); }
    else { notes.push(`Nasdaq ${nasdaqChange.toFixed(1)}%(중립)`); }
  }

  // Fed Rate: 고금리 지속 = 성장주 밸류에이션 압박
  if (fedRate !== null) {
    if (fedRate >= 5.0) { adj -= 3; notes.push(`Fed ${fedRate}%(고금리)`); }
    else if (fedRate <= 2.0) { adj += 3; notes.push(`Fed ${fedRate}%(저금리)`); }
    else { notes.push(`Fed ${fedRate}%`); }
  }

  const clamped = Math.max(-20, Math.min(20, adj));
  const direction: MacroSignal['direction'] = clamped >= 5 ? 'BULLISH' : clamped <= -5 ? 'BEARISH' : 'NEUTRAL';
  return { direction, scoreAdj: clamped, summary: notes.join(' | ') || '매크로 데이터 없음' };
}

export async function getMacroSignal(): Promise<MacroSignal> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.data;

  const [usdResult, nasdaqResult, fredResult] = await Promise.allSettled([
    fetchUsdKrw(),
    fetchNasdaqChange(),
    fetchFedRate(),
  ]);

  const usdKrw = usdResult.status === 'fulfilled' ? usdResult.value.rate : null;
  const nasdaqChange = nasdaqResult.status === 'fulfilled' ? nasdaqResult.value : null;
  const fedRate = fredResult.status === 'fulfilled' ? fredResult.value : null;

  const { direction, scoreAdj, summary } = computeSignal(usdKrw, nasdaqChange, fedRate);

  const signal: MacroSignal = { usdKrw, usdKrwChange1d: null, nasdaqChange1d: nasdaqChange, fedRate, direction, scoreAdj, summary };
  _cache = { data: signal, fetchedAt: Date.now() };
  logger.info(`📊 매크로 신호: ${direction} (보정${scoreAdj > 0 ? '+' : ''}${scoreAdj}점) — ${summary}`, { component: 'MACRO' });
  return signal;
}
