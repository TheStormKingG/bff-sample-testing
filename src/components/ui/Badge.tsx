import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface BadgeProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Spoken instead of the visible content, e.g. "4 samples awaiting results". */
  readonly srLabel?: string;
}

/**
 * A small count or label pill. Carries no status meaning of its own — a status
 * uses `StatusChip` or `AssessmentChip`, which always include words.
 */
export function Badge({ children, className, srLabel }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[1.75rem] items-center justify-center rounded-full',
        'bg-bff-100 px-2 py-0.5 text-sm font-semibold text-bff-800 tabular',
        className,
      )}
    >
      {srLabel === undefined ? (
        children
      ) : (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="sr-only">{srLabel}</span>
        </>
      )}
    </span>
  );
}
