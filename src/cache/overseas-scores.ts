/**
 * 해외 종목 점수 인메모리 캐시
 * overseas-job.ts → 쓰기, dashboard.ts → 읽기
 */

export interface OverseasScoreEntry {
  code: string;
  name: string;
  exchange: string;
  region: 'US' | 'JP' | 'TW';
  score: number;        // analyzeTechnicals score (-100~100)
  signal: string;       // STRONG_BUY / BUY / HOLD / SELL / STRONG_SELL
  price: number;        // 현재가 (USD/JPY/TWD)
  changePct: number;    // 당일 등락률
  rsi: number;
  cachedAt: number;     // Date.now()
}

let _cache: OverseasScoreEntry[] = [];
const TTL_MS = 30 * 60 * 1000; // 30분 TTL

export function setOverseasScores(scores: OverseasScoreEntry[]): void {
  _cache = scores;
}

/** 30분 이내 캐시만 반환. 빈 배열이면 해외 시장 닫힘 */
export function getOverseasScores(): OverseasScoreEntry[] {
  const cutoff = Date.now() - TTL_MS;
  return _cache.filter((s) => s.cachedAt > cutoff);
}
