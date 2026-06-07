'use client';

import React from 'react';

const COLOR = {
  emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', ring: 'ring-emerald-500/20', border: 'border-emerald-500/20', glow: 'glow-green' },
  rose:    { text: 'text-rose-400',    bg: 'bg-rose-500/15',    ring: 'ring-rose-500/20',    border: 'border-rose-500/20',    glow: 'glow-red'   },
  amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/15',   ring: 'ring-amber-500/20',   border: 'border-white/[0.04]',   glow: ''           },
  blue:    { text: 'text-blue-400',    bg: 'bg-blue-500/15',    ring: 'ring-blue-500/20',    border: 'border-blue-500/20',    glow: 'glow-blue'  },
  neutral: { text: 'text-slate-400',   bg: 'bg-white/[0.05]',   ring: 'ring-white/[0.08]',   border: 'border-white/[0.04]',   glow: ''           },
} as const;
export type ColorKey = keyof typeof COLOR;
export { COLOR };

export function Panel({
  title, badge, badgeColor = 'neutral', children,
}: {
  title: string;
  badge?: string;
  badgeColor?: ColorKey;
  children: React.ReactNode;
}) {
  const c = COLOR[badgeColor];
  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40 animate-in">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center gap-3">
        <h3 className="text-sm font-bold text-slate-100 tracking-tight">{title}</h3>
        {badge && (
          <span className={`text-xs px-2.5 py-0.5 rounded-full ml-auto font-semibold ${c.bg} ${c.text}`}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function Card({
  label, value, color, bg, big,
}: {
  label: string; value: string; color?: string; bg?: string; big?: boolean;
}) {
  return (
    <div className={`rounded-2xl border border-white/[0.04] p-4 sm:p-5 shadow-xl shadow-black/20 transition-transform hover:scale-[1.01] ${bg || 'glass'}`}>
      <div className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">{label}</div>
      <div className={`${big ? 'text-xl sm:text-2xl' : 'text-base sm:text-lg'} font-bold tracking-tight ${color || 'text-slate-100'}`}>
        {value}
      </div>
    </div>
  );
}

export function Indicator({
  label, value, sub, color,
}: {
  label: string; value: string; sub: string; color: string;
}) {
  const c = COLOR[color as ColorKey] ?? COLOR.neutral;
  return (
    <div className={`rounded-xl p-3.5 text-center glass border ${c.border} ${c.glow}`}>
      <div className="text-[10px] text-slate-500 mb-1.5 font-medium uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-black ${c.text}`}>{value ?? '-'}</div>
      <div className={`text-xs mt-1 font-medium ${c.text} opacity-80`}>{sub}</div>
    </div>
  );
}

export function EmptyMsg({ children, icon }: { children: React.ReactNode; icon?: string }) {
  return (
    <div className="p-8 sm:p-10 text-center">
      {icon && <div className="text-2xl mb-2 opacity-40">{icon}</div>}
      <div className="text-slate-500 text-sm">{children}</div>
    </div>
  );
}
