'use client';

import React from 'react';

// ═══════════════════════════════════════
// Panel
// ═══════════════════════════════════════

const badgeColorMap: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-400',
  red: 'bg-rose-500/15 text-rose-400',
  amber: 'bg-amber-500/15 text-amber-400',
  blue: 'bg-blue-500/15 text-blue-400',
};

export function Panel({
  title,
  badge,
  badgeColor,
  children,
}: {
  title: string;
  badge?: string;
  badgeColor?: 'green' | 'red' | 'amber' | 'blue';
  children: React.ReactNode;
}) {
  const bc = badgeColor ? badgeColorMap[badgeColor] : 'bg-white/[0.06] text-slate-400';
  return (
    <div className="bg-slate-900/60 backdrop-blur-xl rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/30">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-slate-100 tracking-tight">{title}</h3>
        {badge && (
          <span className={`text-[10px] px-2.5 py-1 rounded-full ml-auto font-medium ${bc}`}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════
// Button
// ═══════════════════════════════════════

const btnVariants: Record<string, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white',
  secondary: 'bg-slate-700 hover:bg-slate-600 text-slate-300',
  danger: 'bg-rose-600 hover:bg-rose-500 text-white',
};

export function Button({
  variant = 'primary',
  size = 'md',
  disabled = false,
  className = '',
  children,
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  const sizeClass =
    size === 'sm'
      ? 'px-3 py-1.5 text-xs'
      : size === 'lg'
        ? 'px-6 py-3 text-sm'
        : 'px-5 py-2.5 text-sm';

  return (
    <button
      disabled={disabled}
      className={`${btnVariants[variant]} ${sizeClass} rounded-lg font-medium transition-all disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ═══════════════════════════════════════
// Input
// ═══════════════════════════════════════

export function Input({
  label,
  className = '',
  ...rest
}: {
  label?: string;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return (
    <div>
      {label && <label className="text-[11px] text-slate-500 block mb-1">{label}</label>}
      <input
        className={`w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none transition-colors ${className}`}
        {...rest}
      />
    </div>
  );
}

// ═══════════════════════════════════════
// Select
// ═══════════════════════════════════════

export function Select({
  label,
  value,
  opts,
  onChange,
}: {
  label: string;
  value: any;
  opts: [any, string][];
  onChange: (v: string) => void;
}) {
  const numVal = Number(value);
  const matched = opts.find(([v]) => Number(v) === numVal)?.[0] ?? value;
  return (
    <div>
      <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
      <select
        value={matched}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none transition-colors"
      >
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

// ═══════════════════════════════════════
// Badge
// ═══════════════════════════════════════

const badgeVariants: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-400',
  red: 'bg-rose-500/15 text-rose-400',
  amber: 'bg-amber-500/15 text-amber-400',
  blue: 'bg-blue-500/15 text-blue-400',
  neutral: 'bg-white/[0.06] text-slate-400',
};

export function Badge({
  children,
  color = 'neutral',
  className = '',
}: {
  children: React.ReactNode;
  color?: 'green' | 'red' | 'amber' | 'blue' | 'neutral';
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium ${badgeVariants[color]} ${className}`}
    >
      {children}
    </span>
  );
}

// ═══════════════════════════════════════
// SideBadge (buy / sell)
// ═══════════════════════════════════════

export function SideBadge({ side }: { side: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${
        side === 'BUY'
          ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20'
          : 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/20'
      }`}
    >
      {side === 'BUY' ? '매수' : '매도'}
    </span>
  );
}

// ═══════════════════════════════════════
// Indicator (metric card)
// ═══════════════════════════════════════

const indicatorColors: Record<string, { text: string; border: string; glow: string }> = {
  emerald: { text: 'text-emerald-400', border: 'border-emerald-500/20', glow: 'shadow-[0_0_20px_rgba(16,185,129,0.15)]' },
  rose: { text: 'text-rose-400', border: 'border-rose-500/20', glow: 'shadow-[0_0_20px_rgba(244,63,94,0.15)]' },
  blue: { text: 'text-blue-400', border: 'border-blue-500/20', glow: 'shadow-[0_0_20px_rgba(59,130,246,0.1)]' },
  amber: { text: 'text-amber-400', border: 'border-white/[0.04]', glow: '' },
  default: { text: 'text-slate-300', border: 'border-white/[0.04]', glow: '' },
};

export function Indicator({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  const c = indicatorColors[color] ?? indicatorColors.default;
  return (
    <div className={`rounded-xl p-3.5 text-center bg-slate-900/60 backdrop-blur-xl border ${c.border} ${c.glow}`}>
      <div className="text-[10px] text-slate-500 mb-1.5 font-medium uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-black ${c.text}`}>{value ?? '-'}</div>
      <div className={`text-[10px] mt-1 font-medium ${c.text} opacity-80`}>{sub}</div>
    </div>
  );
}

// ═══════════════════════════════════════
// EmptyMsg
// ═══════════════════════════════════════

export function EmptyMsg({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="p-8 sm:p-10 text-center">
      {icon && <div className="text-2xl mb-2 opacity-40">{icon}</div>}
      <div className="text-slate-500 text-sm">{children}</div>
    </div>
  );
}
