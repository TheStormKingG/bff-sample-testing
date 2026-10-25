import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Rendered as the card's heading, at the given level. */
  readonly title?: ReactNode;
  readonly titleLevel?: 2 | 3 | 4;
  readonly description?: ReactNode;
  readonly footer?: ReactNode;
  readonly as?: 'div' | 'section' | 'article' | 'li';
}

/**
 * An uncluttered white panel with a hairline border — the standard container.
 * PRD section 11 asks for cards and strong contrast, explicitly in preference
 * to a dense spreadsheet grid.
 */
export function Card({
  children,
  className,
  title,
  titleLevel = 2,
  description,
  footer,
  as: Element = 'section',
}: CardProps) {
  const Heading = `h${titleLevel}` as 'h2' | 'h3' | 'h4';
  return (
    <Element
      className={cn(
        'rounded-xl border border-slate-200 bg-white shadow-sm',
        className,
      )}
    >
      {(title !== undefined || description !== undefined) && (
        <div className="border-b border-slate-100 px-4 py-3 sm:px-6 sm:py-4">
          {title !== undefined && (
            <Heading className="text-lg font-semibold text-slate-900">{title}</Heading>
          )}
          {description !== undefined && (
            <p className="mt-1 text-sm text-slate-600">{description}</p>
          )}
        </div>
      )}
      <div className="px-4 py-4 sm:px-6">{children}</div>
      {footer !== undefined && (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 sm:px-6">
          {footer}
        </div>
      )}
    </Element>
  );
}
