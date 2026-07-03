'use client';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
type SpinnerColor = 'blue' | 'white' | 'cyan' | 'amber' | 'violet' | 'slate' | 'red' | 'current';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  xs:   'w-3 h-3 border-[1.5px]',
  sm:   'w-3.5 h-3.5 border-2',
  md:   'w-4 h-4 border-2',
  lg:   'w-5 h-5 border-2',
  xl:   'w-6 h-6 border-2',
  '2xl': 'w-8 h-8 border-2',
};

const COLOR_CLASSES: Record<SpinnerColor, string> = {
  blue:    'border-blue-400',
  white:   'border-white',
  cyan:    'border-cyan-400',
  amber:   'border-amber-400',
  violet:  'border-violet-400',
  slate:   'border-slate-400',
  red:     'border-red-400',
  current: 'border-current',
};

export function Spinner({
  size = 'lg',
  color = 'blue',
  className = '',
  as: Tag = 'div',
}: {
  size?: SpinnerSize;
  color?: SpinnerColor;
  className?: string;
  as?: 'div' | 'span';
}) {
  return (
    <Tag className={`${SIZE_CLASSES[size]} ${COLOR_CLASSES[color]} border-t-transparent rounded-full animate-spin ${className}`} />
  );
}
