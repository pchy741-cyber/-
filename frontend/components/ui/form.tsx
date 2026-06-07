'use client';

import React from 'react';

export function Sel({
  label, value, opts, onChange,
}: {
  label: string; value: string | number; opts: [string | number, string][]; onChange: (v: string) => void;
}) {
  const numVal = Number(value);
  const matched = opts.find(([v]) => Number(v) === numVal)?.[0] ?? value;
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-slate-400 block">{label}</label>
      <select
        value={matched}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all appearance-none cursor-pointer"
      >
        {opts.map(([v, l]) => <option key={v} value={v} className="bg-slate-900">{l}</option>)}
      </select>
    </div>
  );
}

export function NumInput({
  label, value, suffix, min, max, step, onCommit,
}: {
  label: string; value: number; suffix?: string; min?: number; max?: number; step?: number; onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [local, setLocal] = React.useState(String(value));
  React.useEffect(() => { if (!editing) setLocal(String(value)); }, [value, editing]);

  const commit = () => {
    const n = parseFloat(local);
    if (!isNaN(n)) {
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
      onCommit(clamped);
      setLocal(String(clamped));
    } else {
      setLocal(String(value));
    }
    setEditing(false);
  };

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-slate-400 block">{label}</label>
      <div className="flex items-center bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 gap-1 focus-within:ring-2 focus-within:ring-blue-500/50 transition-all">
        <input
          type="number" inputMode="decimal"
          value={local} min={min} max={max} step={step ?? 1}
          onFocus={() => setEditing(true)}
          onChange={e => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="w-full bg-transparent text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {suffix && <span className="text-xs text-slate-500 shrink-0">{suffix}</span>}
      </div>
    </div>
  );
}

export function Input({
  label, className = '', ...rest
}: {
  label?: string; className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return (
    <div className="space-y-1.5">
      {label && <label className="text-xs font-medium text-slate-400 block">{label}</label>}
      <input
        className={`w-full bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all ${className}`}
        {...rest}
      />
    </div>
  );
}
