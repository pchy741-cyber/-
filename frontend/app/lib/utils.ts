// ═══════════════════════════════════════
// 공유 유틸리티 — 포맷팅, 색상, API
// ═══════════════════════════════════════

export const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || (window.location.port === '3000' ? 'http://localhost:8080' : window.location.origin))
    : (process.env.NEXT_PUBLIC_API_BASE_URL || '');

export async function api(path: string, opts?: RequestInit & { timeout?: number }) {
  const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
  const ms = opts?.timeout ?? (path.includes('overseas') ? 15000 : 12000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const { timeout: _, ...fetchOpts } = opts ?? {};
    const res = await fetch(`${base}/api${path}`, { ...fetchOpts, signal: controller.signal, cache: 'no-store', credentials: 'include', headers: { 'Content-Type': 'application/json', ...fetchOpts?.headers } });
    if (res.status === 401) { window.location.href = '/'; throw new Error('UNAUTHORIZED'); }
    if (!res.ok) {
      let errMsg = `API ${path} (${res.status})`;
      try { const body = await res.json(); if (body?.error) errMsg = body.error; } catch {}
      throw new Error(errMsg);
    }
    return res.json();
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
