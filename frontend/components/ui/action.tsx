'use client';

import React from 'react';

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
