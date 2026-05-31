'use client';

import React from 'react';

interface ToggleGroupItem<T extends string> {
  value: T;
  label: string;
}

export function ToggleGroup<T extends string>({
  value, items, onChange, className = '',
}: {
  value: T;
  items: ToggleGroupItem<T>[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex rounded-xl overflow-hidden border border-white/[0.06] text-[12px] w-fit ${className}`}>
      {items.map(item => (
        <button
          key={item.value}
          onClick={() => onChange(item.value)}
          className={`px-3 py-1.5 transition-all ${
            value === item.value
              ? 'bg-blue-500/20 text-blue-400 font-semibold'
              : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
