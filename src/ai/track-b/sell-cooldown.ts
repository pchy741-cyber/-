/**
 * 인메모리 매도 쿨다운 상태 머신
 * (pipeline.ts에서 추출)
 *
 * v10.4: DB 반영 전에도 재매수 차단 (churning 방지)
 * v10.5: paper/live 모드별 분리 (크로스오염 방지)
 */
import { getCtxIsPaper } from '../../config/context.js';

// paper/live 모드별 분리 (크로스오염 방지 — Paper 매도가 Live 차단하던 버그 수정)
const _recentSellTimestamps = new Map<string, Map<string, number>>(); // mode → (stock_code → epoch ms)
const MEMORY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // v15 Hyper: 4h→2h (국내 수수료 저렴 → 빠른 재진입)

function _getSellMap(): Map<string, number> {
  const mode = getCtxIsPaper() ? 'paper' : 'live';
  if (!_recentSellTimestamps.has(mode)) _recentSellTimestamps.set(mode, new Map());
  return _recentSellTimestamps.get(mode)!;
}

/** 매도 실행 시 호출 — 인메모리 쿨다운 기록 */
export function recordSellForCooldown(stockCode: string): void {
  _getSellMap().set(stockCode, Date.now());
}

/** 인메모리 쿨다운 중인 종목 Set 반환 (현재 모드 전용) */
export function getMemoryCooldownCodes(): Set<string> {
  const now = Date.now();
  const map = _getSellMap();
  const result = new Set<string>();
  for (const [code, ts] of map) {
    if (now - ts < MEMORY_COOLDOWN_MS) {
      result.add(code);
    } else {
      map.delete(code); // 만료 정리
    }
  }
  return result;
}
