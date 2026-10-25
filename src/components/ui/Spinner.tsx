import { cn } from '@/lib/cn';

export interface SpinnerProps {
  readonly className?: string;
  /** Announced to screen readers. Describe the wait, not the animation. */
  readonly label?: string;
  readonly size?: 'sm' | 'md' | 'lg';
}

const SIZES: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-10 w-10 border-[3px]',
};

/**
 * A busy indicator. The spin is decoration; the text in `label` is what
 * actually conveys the state, so the component is still understandable with
 * animation suppressed (see the reduced-motion rule in index.css).
 */
export function Spinner({ className, label = 'Loading', size = 'md' }: SpinnerProps) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'inline-block animate-spin rounded-full border-slate-300 border-t-bff-600',
          SIZES[size],
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
