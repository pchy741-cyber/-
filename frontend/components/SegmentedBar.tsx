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
          className={`h-full ${seg.className} ${seg.transition ?? 'transition-all duration-500'}`}
          style={{ '--seg-w': `${seg.widthPct}%`, width: 'var(--seg-w)' } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

/**
 * 단일 비중 표시 bar — ProgressBar의 가벼운 버전
 * 색상 클래스만 props로
 */
export function WeightBar({
  pct,
  colorClass,
  height = 'h-1.5',
  bgClass = 'bg-white/[0.04]',
}: {
  pct: number;
  colorClass: string;
  height?: string;
  bgClass?: string;
}) {
  return (
    <div className={`${height} ${bgClass} rounded-full overflow-hidden`}>
      <div
        className={`h-full rounded-full ${colorClass}`}
        style={{ '--wb-w': `${Math.max(0, Math.min(100, pct))}%`, width: 'var(--wb-w)' } as React.CSSProperties}
      />
    </div>
  );
}
