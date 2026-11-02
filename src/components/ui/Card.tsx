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
 * The standard container: a RAISED surface sitting on the app's own ground.
 *
 * It was a white panel with a hairline border, which is a perfectly good card
 * and was the wrong one here — the shell paints `bg-neu-base` behind every
 * page precisely so that raised surfaces have something to sit against, and a
 * white sheet with a 1px edge ignores it. Same colour as the ground, depth
 * from the shadow: that is the whole material metaphor, and this is the
 * element it exists for.
 *
 * The hairline survives as the DIVIDER between header, body and footer.
 * Without the white fill there is no fill change to separate them, so the
 * rules carry it — at `slate-200` rather than `slate-100`, because a hairline
 * that was just visible against white is not against a tint.
 *
 * PRD section 11 asks for cards and strong contrast in preference to a dense
 * spreadsheet grid, and nothing here lowers contrast: the text tones are
 * unchanged and `slate-600` is 6.87:1 on this surface.
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
        'rounded-2xl bg-neu-base shadow-neu-sm',
        className,
      )}
    >
      {(title !== undefined || description !== undefined) && (
        <div className="border-b border-slate-200 px-4 py-3 sm:px-6 sm:py-4">
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
        <div className="rounded-b-2xl border-t border-slate-200 px-4 py-3 sm:px-6">
          {footer}
        </div>
      )}
    </Element>
  );
}
