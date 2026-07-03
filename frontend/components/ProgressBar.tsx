'use client';

export function ProgressBar({
  value,
  colorClass = 'bg-cyan-500',
  height = 'h-1.5',
  bgClass = 'bg-white/[0.04]',
  transition = 'transition-all duration-700',
}: {
  value: number;
  colorClass?: string;
  height?: string;
  bgClass?: string;
  transition?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={`${height} ${bgClass} rounded-full overflow-hidden`}>
      <div
        className={`h-full rounded-full ${colorClass} ${transition} w-[var(--w)]`}
        style={{ '--w': `${clamped}%` } as React.CSSProperties}
      />
    </div>
  );
}
