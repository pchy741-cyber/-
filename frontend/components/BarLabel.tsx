'use client';

/**
 * Progress bar 위/아래 절대위치 라벨
 * left/right로 위치 지정, 중앙 정렬 옵션 (centered=true → -translate-x-1/2)
 */
export function BarLabel({
  position,
  centered = false,
  className = '',
  children,
}: {
  /** 'left:X%' 또는 'right:X%' 형태 */
  position: { side: 'left' | 'right'; pct: number };
  centered?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const styleVar =
    position.side === 'left'
      ? ({ '--bar-pos': `${position.pct}%`, left: 'var(--bar-pos)' } as React.CSSProperties)
      : ({ '--bar-pos': `${position.pct}%`, right: 'var(--bar-pos)' } as React.CSSProperties);
  return (
    <span className={`absolute ${centered ? '-translate-x-1/2' : ''} ${className}`} style={styleVar}>
      {children}
    </span>
  );
}
