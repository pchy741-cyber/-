'use client';

/**
 * 가로로 여러 segment를 나란히 표시 — flex 기반
 * 각 segment width %를 받아 비율로 렌더
 *
 * 사용:
 *   <SegmentedBar segments={[
 *     { widthPct: 30, className: 'bg-blue-500/70' },
 *     { widthPct: 70, className: 'bg-indigo-500/70' },
 *   ]} />
 */
export interface BarSegmentSpec {
  widthPct: number;
  className: string;
  /** 선택: 추가 transition 클래스 (기본: transition-all duration-500) */
  transition?: string;
}

export function SegmentedBar({
  segments,
  height = 'h-2',
  bgClass = 'bg-white/[0.04]',
  rounded = 'rounded-full',
  className = '',
}: {
  segments: BarSegmentSpec[];
  height?: string;
  bgClass?: string;
  rounded?: string;
  className?: string;
}) {
  return (
    <div className={`${height} ${rounded} overflow-hidden ${bgClass} flex ${className}`}>
      {segments.map((seg, i) => (
        <div
          key={i}
          className={`h-full w-[var(--seg-w)] ${seg.className} ${seg.transition ?? 'transition-all duration-500'}`}
          style={{ '--seg-w': `${seg.widthPct}%` } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
