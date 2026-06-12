/**
 * 해외 종목 점수 인메모리 캐시
 * overseas-job.ts → 쓰기, dashboard.ts → 읽기
 * paper/live 모드별 분리 — 각 모드가 독립적인 점수 캐시 유지
 */

export interface OverseasScoreEntry {
  code: string;
  name: string;
  exchange: string;
  region: 'US' | 'JP' | 'TW';
  score: number; // analyzeTechnicals score (-100~100)
  signal: string; // STRONG_BUY / BUY / HOLD / SELL / STRONG_SELL
  price: number; // 현재가 (USD/JPY/TWD)
  changePct: number; // 당일 등락률
  rsi: number;
  cachedAt: number; // Date.now()
}

const _cache = new Map<'paper' | 'live', OverseasScoreEntry[]>([
  ['paper', []],
  ['live', []],
]);
const TTL_MS = 30 * 60 * 1000; // 30분 TTL

export function setOverseasScores(scores: OverseasScoreEntry[], isPaper?: boolean): void {
  const key = isPaper ? 'paper' : 'live';
  _cache.set(key, scores);
}

/** 특정 종목의 캐시된 점수 제거 (매매 체결 후 호출) */
export function invalidateOverseasScoreForStock(stockCode: string): void {
  for (const [key, entries] of _cache) {
    _cache.set(
      key,
      entries.filter((s) => s.code !== stockCode),
    );
  }
}

/** 30분 이내 캐시만 반환. 빈 배열이면 해외 시장 닫힘 */
export function getOverseasScores(isPaper?: boolean): OverseasScoreEntry[] {
  // isPaper 미지정 시 양쪽 캐시 병합 (대시보드용)
  const cutoff = Date.now() - TTL_MS;
  if (isPaper === undefined) {
    const paper = _cache.get('paper') ?? [];
    const live = _cache.get('live') ?? [];
    // live 우선, paper 폴백
    const merged = live.length > 0 ? live : paper;
    return merged.filter((s) => s.cachedAt > cutoff);
  }
  const key = isPaper ? 'paper' : 'live';
  return (_cache.get(key) ?? []).filter((s) => s.cachedAt > cutoff);
}
