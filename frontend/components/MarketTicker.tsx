'use client';

import { useEffect, useState } from 'react';

/**
 * 📊 상단 실시간 시장 헤더 — KOSPI / VKOSPI / USD / Fed
 *
 * 학술 근거 (Korean Stock Market, KOSPI 변동성 U자형 패턴):
 *   - 개장/마감 변동성 높음 → 시장 흐름 즉시 인지 필요
 *   - VKOSPI = 한국판 VIX, 25↑ = 공포, 18↓ = 안정
 *   - 매시간 갱신 (FRED 24h 캐시 + 시장 데이터 30분)
 */

interface MarketSnapshot {
  kospi?: { value: number; changePct: number };
  vkospi?: number;
  usdKrw?: number;
  fedFunds?: number;
  cpi?: number;
}

export function MarketTicker({ apiBase = '' }: { apiBase?: string }) {
  const [data, setData] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // 매크로 + 환율 병렬
        const [macroRes, fxRes] = await Promise.allSettled([
          fetch(`${apiBase}/api/macro/snapshot`, { credentials: 'include' }).then((r) => r.json()),
          fetch(`${apiBase}/api/dashboard?viewMode=live`, { credentials: 'include' }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        const m = macroRes.status === 'fulfilled' ? macroRes.value : {};
        const d = fxRes.status === 'fulfilled' ? fxRes.value : {};
        setData({
          kospi: m?.kospi != null ? { value: Number(m.kospi), changePct: Number(m.kospiChange ?? 0) } : undefined,
          vkospi: m?.vkospi != null ? Number(m.vkospi) : undefined,
          usdKrw: d?.fxRate ?? m?.usdKrw,
          fedFunds: m?.fedFunds,
          cpi: m?.cpiYoY,
        });
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 5 * 60_000); // 5분마다 갱신
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiBase]);

  if (loading || !data) {
    return (
      <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
        <span className="text-[10px] text-slate-600 animate-pulse">시장 정보 로딩...</span>
      </div>
    );
  }

  const items: Array<{ label: string; value: string; color: string; emoji?: string }> = [];
  if (data.kospi) {
    const up = data.kospi.changePct >= 0;
    items.push({
      emoji: '🇰🇷',
      label: 'KOSPI',
      value: `${data.kospi.value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${up ? '▲' : '▼'}${Math.abs(data.kospi.changePct).toFixed(2)}%`,
      color: up ? 'text-emerald-400' : 'text-rose-400',
    });
  }
  if (data.vkospi != null) {
    const fear = data.vkospi >= 25;
    const calm = data.vkospi <= 18;
    items.push({
      emoji: '😨',
      label: 'VKOSPI',
      value: data.vkospi.toFixed(1),
      color: fear ? 'text-rose-400' : calm ? 'text-emerald-400' : 'text-amber-400',
    });
  }
  if (data.usdKrw) {
    items.push({
      emoji: '💵',
      label: 'USD',
      value: `₩${data.usdKrw.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`,
      color: 'text-blue-300',
    });
  }
  if (data.fedFunds != null) {
    items.push({
      emoji: '🏦',
      label: 'Fed',
      value: `${data.fedFunds.toFixed(2)}%`,
      color: 'text-slate-300',
    });
  }
  if (data.cpi != null) {
    items.push({
      emoji: '📈',
      label: 'CPI YoY',
      value: `${data.cpi.toFixed(1)}%`,
      color: data.cpi >= 4 ? 'text-rose-400' : data.cpi >= 2.5 ? 'text-amber-400' : 'text-emerald-400',
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04] overflow-x-auto">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1 shrink-0 text-[11px]">
          <span>{it.emoji}</span>
          <span className="text-slate-500">{it.label}</span>
          <span className={`tabular-nums font-semibold ${it.color}`}>{it.value}</span>
          {i < items.length - 1 && <span className="text-slate-700 ml-2">·</span>}
        </span>
      ))}
    </div>
  );
}
