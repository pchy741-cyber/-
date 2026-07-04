// ═══════════════════════════════════════
// 공유 유틸리티 — 포맷팅, 색상, API
// ═══════════════════════════════════════

/** 환율 비상 폴백 — 백엔드 FALLBACK_FX_RATE와 동일 (서버 환율 조회 실패 시 사용) */
export const FALLBACK_FX_RATE = 1_520;

export const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || (window.location.port === '3000' ? 'http://localhost:8080' : window.location.origin))
    : (process.env.NEXT_PUBLIC_API_BASE_URL || '');

// DB 연결 에러 패턴 — raw 에러 대신 친절한 메시지로 교체
const DB_ERROR_PATTERNS = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'connection refused',
  'Connection terminated', 'no pg_hba.conf', 'the database system is starting up',
  'could not connect', 'connect ECONNRESET', 'memory mode'];

function isDbError(msg: string): boolean {
  return DB_ERROR_PATTERNS.some(p => msg.includes(p));
}

/** DB 에러 발생 시 전역 이벤트 발생 → Dashboard에서 워밍 오버레이 재표시 */
export function emitDbUnavailable() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('db-unavailable'));
}

export async function api(path: string, opts?: RequestInit & { timeout?: number }) {
  const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
  const ms = opts?.timeout ?? (path.includes('overseas') ? 15000 : 12000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const { timeout: _, ...fetchOpts } = opts ?? {};
    const res = await fetch(`${base}/api${path}`, { ...fetchOpts, signal: controller.signal, cache: 'no-store', credentials: 'include', headers: { 'Content-Type': 'application/json', ...fetchOpts?.headers } });
    if (res.status === 401) {
      // DB 에러 상태에서 401이면 리다이렉트하지 않음 (세션 유효하지만 서버 문제)
      try { const b = await res.clone().json(); if (b?.error && isDbError(b.error)) { emitDbUnavailable(); throw new Error('DB 연결 중입니다.'); } } catch (e) { if (e instanceof Error && e.message.includes('DB')) throw e; }
      window.location.href = '/'; throw new Error('UNAUTHORIZED');
    }
    if (!res.ok) {
      let errMsg = `API ${path} (${res.status})`;
      try { const body = await res.json(); if (body?.error) errMsg = body.error; } catch {}
      if (isDbError(errMsg)) {
        emitDbUnavailable();
        throw new Error('DB 연결 중입니다. 잠시 후 자동으로 재시도합니다.');
      }
      throw new Error(errMsg);
    }
    return res.json();
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      emitDbUnavailable();
      throw new Error('서버에 연결할 수 없습니다. 잠시 후 재시도합니다.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const fmt = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '-' : n.toLocaleString('ko-KR');
export const fmtPct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '-' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
export const fmtWon = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '-' : Math.round(n).toLocaleString('ko-KR') + '원';
export const fmtUsd = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '-' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** KST Date 객체 반환 (UTC 기반 getUTC* 메서드로 KST 시각 접근) */
export function toKST(d: Date): Date { return new Date(d.getTime() + 9 * 3600_000); }
/** 날짜 문자열 → KST YYYY-MM-DD */
export function toKSTDateStr(t: string | Date): string { return toKST(new Date(t)).toISOString().slice(0, 10); }
/** KST 현재 시각의 시/분 (분 단위) */
export function getKSTMinutes(): number { const k = toKST(new Date()); return k.getUTCHours() * 60 + k.getUTCMinutes(); }
export const fmtTime = (t: string | null | undefined) => { if (!t) return '-'; const k = toKST(new Date(t)); return `${(k.getUTCMonth()+1).toString().padStart(2,'0')}/${k.getUTCDate().toString().padStart(2,'0')} ${k.getUTCHours().toString().padStart(2,'0')}:${k.getUTCMinutes().toString().padStart(2,'0')}`; };
/** 상대 시간 표시 ("5초 전", "3분 전", "2시간 전", "1일 전") */
export function timeAgo(dateStr: string): string {
  const sec = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

// ── 한국 원화 포맷 (배당/세금 패널 공용) ──
export const fmtManWon = (n: number) => {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
  if (n >= 10_000_000) return (n / 10_000_000).toFixed(0) + '천만';
  if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
  return Math.round(n).toLocaleString();
};
export const fmtKrwFull = (n: number) => '₩' + Math.round(n).toLocaleString('ko-KR');

export const pc = (n: number | null | undefined) => n == null || n === 0 ? 'text-slate-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400';
export const pbg = (n: number | null | undefined) => n == null || n === 0 ? '' : n > 0 ? 'bg-emerald-950/30 border-emerald-900/30' : 'bg-rose-950/30 border-rose-900/30';
