import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Action buttons. Put the confirming action last. */
  readonly footer?: ReactNode;
  /**
   * Block Escape and the backdrop while a request is in flight, so a
   * half-committed decision cannot be dismissed as though it never happened.
   */
  readonly dismissable?: boolean;
  readonly className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog.
 *
 * Hand-rolled rather than `<dialog>` because `showModal()` cannot be driven
 * from a React prop without an imperative effect that fights the declarative
 * `open`, and because the top-layer backdrop is awkward to theme consistently
 * on the Android tablet browsers this runs on.
 *
 * What it must get right, and does: focus moves in on open, Tab is trapped
 * inside, Escape closes, focus returns to whatever opened it, and the page
 * behind cannot be scrolled away under the operator's thumb.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissable = true,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const requestClose = useCallback(() => {
    if (dismissable) onClose();
  }, [dismissable, onClose]);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes === undefined || nodes.length === 0) return;
      const list = [...nodes];
      const firstNode = list[0];
      const lastNode = list[list.length - 1];
      if (firstNode === undefined || lastNode === undefined) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === firstNode || !panelRef.current?.contains(active))) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && active === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus();
    };
  }, [open, requestClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-900/50"
        onClick={requestClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={cn(
          'relative w-full max-w-lg rounded-t-2xl bg-white shadow-xl sm:rounded-2xl',
          'max-h-[90vh] overflow-y-auto',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3 sm:px-6">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {dismissable && (
            <Button
              variant="ghost"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-1 shrink-0 px-2"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </Button>
          )}
        </div>

        <div className="px-4 py-4 sm:px-6">
          {description !== undefined && (
            <p id={descriptionId} className="text-base text-slate-700">
              {description}
            </p>
          )}
          {children}
        </div>

        {footer !== undefined && (
          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
