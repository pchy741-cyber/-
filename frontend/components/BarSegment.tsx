'use client';

/**
 * 절대위치 progress bar 세그먼트 — left/width %로 위치/폭 지정
 * 인라인 style 제거를 위해 CSS variable 사용
 */
export function BarSegment({
  startPct,
  widthPct,
  bgClass,
  className = '',
}: {
  startPct: number;
  widthPct: number;
  bgClass: string;
  className?: string;
}) {
  return (
    <div
      className={`absolute top-0 h-full ${bgClass} ${className}`}
      style={
        {
          '--seg-left': `${startPct}%`,
          '--seg-width': `${widthPct}%`,
          left: 'var(--seg-left)',
          width: 'var(--seg-width)',
        } as React.CSSProperties
      }
    />
  );
}

/**
 * 진행 오버레이 — left 0, width 동적
 */
export function BarOverlay({
  progressPct,
  className = 'bg-white/20',
  transition = 'transition-all duration-1000',
}: {
  progressPct: number;
  className?: string;
  transition?: string;
}) {
  return (
    <div
      className={`absolute top-0 left-0 h-full rounded-full ${className} ${transition}`}
      style={{ '--bar-progress': `${progressPct}%`, width: 'var(--bar-progress)' } as React.CSSProperties}
    />
  );
}
