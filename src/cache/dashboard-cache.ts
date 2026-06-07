/**
 * 대시보드 캐시 관리 — 비즈니스/스케줄러 레이어에서 안전하게 import 가능
 *
 * 기존 api/routes/dashboard/helpers.ts 에 있던 캐시 무효화 함수를
 * 여기로 이동하여 의존방향 수정: scheduler → cache (O), scheduler → api (X)
 */

// ── 대시보드 응답 캐시 (30초 TTL, Stale-While-Revalidate, 모드별 독립 Map) ──
const _dashCacheByMode = new Map<string, { data: unknown; ts: number }>();
const _dashBuildingByMode = new Map<string, Promise<unknown>>();

export function getDashCache(mode: string) { return _dashCacheByMode.get(mode) ?? null; }
export function setDashCache(mode: string, data: unknown) { _dashCacheByMode.set(mode, { data, ts: Date.now() }); }
export function getDashBuildingByMode() { return _dashBuildingByMode; }

export function getDashCacheTTL(): number {
  const now = new Date();
  const kstMins = ((now.getUTCHours() + 9) % 24) * 60 + now.getUTCMinutes();
  // 장중(09:00~15:30 KST): 30초, 장외: 3분
  // 매매 후 hard invalidate이므로 TTL은 폴링 갱신 주기 역할만
  return (kstMins >= 540 && kstMins < 930) ? 30_000 : 180_000;
}

// Soft invalidate: TTL만 만료시키고 데이터는 보존 (SWR: 다음 요청 시 재빌드하되, 빌드 중에는 stale 데이터 반환)
function _softInvalidate(mode: string): void {
  const entry = _dashCacheByMode.get(mode);
  if (entry) entry.ts = 0; // 만료시키되 데이터는 보존 → 다음 요청에서 재빌드
}

// 현재 모드 캐시만 무효화 (매도/매수 후) — 양쪽 hard invalidate (정합성 우선)
export function invalidateCurrentModeCache(): void { _dashCacheByMode.delete('live'); _dashCacheByMode.delete('paper'); }

// 전체 무효화 — 외부 호출용 (하위 호환) — hard invalidate (매매 후 stale 데이터 방지)
export function invalidateDashboardCache(): void { _dashCacheByMode.clear(); }

// 특정 모드 캐시 무효화 (모드 전환 시 — 새 모드 캐시만 제거)
export function invalidateModeCache(mode: string): void { _softInvalidate(mode); }

// Hard invalidate — 캐시 데이터 완전 삭제 (DB 복구 후 stale 데이터 제거)
export function hardInvalidateDashboardCache(): void { _dashCacheByMode.clear(); }
