'use client';

import React from 'react';

// ─── colour tokens ────────────────────────────────────────────────────────────
const COLOR = {
  emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', ring: 'ring-emerald-500/20', border: 'border-emerald-500/20', glow: 'glow-green' },
  rose:    { text: 'text-rose-400',    bg: 'bg-rose-500/15',    ring: 'ring-rose-500/20',    border: 'border-rose-500/20',    glow: 'glow-red'   },
  amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/15',   ring: 'ring-amber-500/20',   border: 'border-white/[0.04]',   glow: ''           },
  blue:    { text: 'text-blue-400',    bg: 'bg-blue-500/15',    ring: 'ring-blue-500/20',    border: 'border-blue-500/20',    glow: 'glow-blue'  },
  neutral: { text: 'text-slate-400',   bg: 'bg-white/[0.05]',   ring: 'ring-white/[0.08]',   border: 'border-white/[0.04]',   glow: ''           },
} as const;
type ColorKey = keyof typeof COLOR;

// ─── Panel ────────────────────────────────────────────────────────────────────
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

// ─── Card ─────────────────────────────────────────────────────────────────────
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

// ─── Indicator (metric tile) ──────────────────────────────────────────────────
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

// ─── Button ───────────────────────────────────────────────────────────────────
const BTN_VARIANT = {
  primary:   'bg-blue-600 hover:bg-blue-500 text-white shadow-sm',
  secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-300',
  danger:    'bg-rose-600 hover:bg-rose-500 text-white shadow-sm',
  ghost:     'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400',
  success:   'bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-400',
  amber:     'bg-amber-600 hover:bg-amber-500 text-white',
  violet:    'bg-violet-600 hover:bg-violet-500 text-white',
} as const;

const BTN_SIZE = {
  sm: 'px-3 py-1.5 text-xs rounded-lg',
  md: 'px-4 py-2.5 text-sm rounded-xl',
  lg: 'px-6 py-3 text-sm rounded-xl',
} as const;

export function Button({
  variant = 'primary', size = 'md', disabled = false, className = '', children, ...rest
}: {
  variant?: keyof typeof BTN_VARIANT;
  size?: keyof typeof BTN_SIZE;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  return (
    <button
      disabled={disabled}
      className={`${BTN_VARIANT[variant]} ${BTN_SIZE[size]} font-medium transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ─── Badge ────────────────────────────────────────────────────────────────────
export function Badge({
  children, color = 'neutral', className = '',
}: {
  children: React.ReactNode;
  color?: ColorKey;
  className?: string;
}) {
  const c = COLOR[color];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${c.bg} ${c.text} ${className}`}>
      {children}
    </span>
  );
}

// ─── SideBadge ────────────────────────────────────────────────────────────────
export function SideBadge({ side, isAverageDown, pnl }: { side: string; isAverageDown?: boolean; pnl?: number | null }) {
  let key: ColorKey;
  let label: string;
  if (isAverageDown) {
    key = 'blue'; label = '추가매수';
  } else if (side === 'BUY') {
    key = 'emerald'; label = '매수';
  } else if (pnl != null) {
    key = pnl >= 0 ? 'emerald' : 'rose';
    label = pnl >= 0 ? '익절' : '손절';
  } else {
    key = 'rose'; label = '매도';
  }
  const c = COLOR[key];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold tracking-wide ${c.bg} ${c.text} ring-1 ${c.ring}`}>
      {label}
    </span>
  );
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { FILLED: '체결', FAILED: '실패', PENDING: '대기', CANCELLED: '취소' };
  const label = map[status] ?? status;
  const cls =
    status === 'FILLED' ? 'bg-emerald-500/10 text-emerald-400' :
    status === 'FAILED' ? 'bg-rose-500/10 text-rose-400' :
    'bg-white/[0.04] text-slate-500';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ─── ModeBadge ────────────────────────────────────────────────────────────────
export function ModeBadge({ mode }: { mode: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${mode === 'paper' ? 'bg-amber-900/40 text-amber-300' : 'bg-blue-900/40 text-blue-300'}`}>
      {mode === 'paper' ? '연습' : '실전'}
    </span>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────
export function Modal({
  open, onClose, children, maxWidth = 'max-w-sm',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className={`${maxWidth} w-full bg-[#0f1422] border border-white/[0.08] rounded-2xl shadow-2xl`} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ─── ConfirmModal ─────────────────────────────────────────────────────────────
export function ConfirmModal({
  open, onClose, onConfirm,
  title, description, confirmLabel = '확인', confirmVariant = 'danger',
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: keyof typeof BTN_VARIANT;
  children?: React.ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="p-5">
        <div className="flex items-start gap-3 mb-4">
          <span className="text-2xl shrink-0">⚠️</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-100 mb-1">{title}</p>
            {description && <p className="text-[11px] text-slate-400 leading-relaxed">{description}</p>}
          </div>
        </div>
        {children && <div className="mb-4">{children}</div>}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="flex-1 py-2.5" onClick={onClose}>취소</Button>
          <Button variant={confirmVariant} size="sm" className="flex-1 py-2.5" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── EmptyMsg ─────────────────────────────────────────────────────────────────
export function EmptyMsg({ children, icon }: { children: React.ReactNode; icon?: string }) {
  return (
    <div className="p-8 sm:p-10 text-center">
      {icon && <div className="text-2xl mb-2 opacity-40">{icon}</div>}
      <div className="text-slate-500 text-sm">{children}</div>
    </div>
  );
}

// ─── Select (form field) ──────────────────────────────────────────────────────
export function Sel({
  label, value, opts, onChange,
}: {
  label: string; value: any; opts: [any, string][]; onChange: (v: string) => void;
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

// ─── NumInput (form field) ────────────────────────────────────────────────────
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

// ─── Input (form field) ───────────────────────────────────────────────────────
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

// ─── LoadBtn ──────────────────────────────────────────────────────────────────
export function LoadBtn({
  children, onClick, className = '', disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => Promise<void>;
  className?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      disabled={busy || disabled}
      onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}
      className={`${className} ${busy ? 'opacity-60 cursor-wait' : ''}`}
    >
      {busy ? (
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          {children}
        </span>
      ) : children}
    </button>
  );
}
