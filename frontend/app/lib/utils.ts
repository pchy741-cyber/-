// ═══════════════════════════════════════
// 공유 유틸리티 — 포맷팅, 색상, API
// ═══════════════════════════════════════

/** 환율 비상 폴백 — 백엔드 FALLBACK_FX_RATE와 동일 (서버 환율 조회 실패 시 사용) */
export const FALLBACK_FX_RATE = 1_500;

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

export const fmt = (n: number | null | undefined) => n == null ? '-' : n.toLocaleString('ko-KR');
export const fmtPct = (n: number | null | undefined) => n == null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
export const fmtWon = (n: number | null | undefined) => n == null ? '-' : Math.round(n).toLocaleString('ko-KR') + '원';
export const fmtUsd = (n: number | null | undefined) => n == null ? '-' : '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtTime = (t: string | null | undefined) => { if (!t) return '-'; const d = new Date(t); return `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; };
export const pc = (n: number | null | undefined) => n == null || n === 0 ? 'text-slate-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400';
export const pbg = (n: number | null | undefined) => n == null || n === 0 ? '' : n > 0 ? 'bg-emerald-950/30 border-emerald-900/30' : 'bg-rose-950/30 border-rose-900/30';
