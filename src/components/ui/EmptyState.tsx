import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  readonly title: string;
  /** Say what this list would contain and what to do next. */
  readonly description?: ReactNode;
  readonly icon?: LucideIcon;
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * "There is nothing here" — stated as a fact, never as a zero in a figure.
 *
 * PRD section 12 asks for "insufficient data" in preference to a misleading
 * zero. An empty queue and a query that has not answered are different things,
 * and this component is only for the first.
 */
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('px-4 py-10 text-center', className)}>
      <Icon aria-hidden="true" className="mx-auto h-10 w-10 text-slate-400" />
      <p className="mt-3 text-base font-semibold text-slate-900">{title}</p>
      {description !== undefined && (
        <p className="mx-auto mt-1 max-w-prose text-sm text-slate-600">{description}</p>
      )}
      {action !== undefined && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
