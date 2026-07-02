/**
 * 인메모리 매도 쿨다운 상태 머신
 * (pipeline.ts에서 추출)
 *
 * v10.4: DB 반영 전에도 재매수 차단 (churning 방지)
 * v10.5: paper/live 모드별 분리 (크로스오염 방지)
 */
// paper/live 모드별 분리 (크로스오염 방지 — Paper 매도가 Live 차단하던 버그 수정)
const _recentSellTimestamps = new Map<string, Map<string, number>>(); // mode → (stock_code → epoch ms)
const MEMORY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // v15 Hyper: 4h→2h (국내 수수료 저렴 → 빠른 재진입)

function _getSellMapFor(isPaper: boolean): Map<string, number> {
  const mode = isPaper ? 'paper' : 'live';
  if (!_recentSellTimestamps.has(mode)) _recentSellTimestamps.set(mode, new Map());
  return _recentSellTimestamps.get(mode)!;
}

/**
 * 매도 실행 시 호출 — 인메모리 쿨다운 기록.
 * CEO 지적(2026-07-02): 매도 체결부터 기록까지 여러 await를 거치는 실행 경로에서
 * 앰비언트 AsyncLocalStorage(getCtxIsPaper())에 의존하면 컨텍스트 유실 시 잘못된
 * 모드로 기록될 수 있음(006340 대원전선 21분만에 재진입 허용 사례) — 호출부가
 * 캡처해둔 isPaper 값을 명시적으로 넘기도록 강제.
 */
export function recordSellForCooldown(stockCode: string, isPaper: boolean): void {
  _getSellMapFor(isPaper).set(stockCode, Date.now());
}

/** 인메모리 쿨다운 중인 종목 Set 반환 (명시적 모드 전용) */
export function getMemoryCooldownCodes(isPaper: boolean): Set<string> {
  const now = Date.now();
  const map = _getSellMapFor(isPaper);
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
