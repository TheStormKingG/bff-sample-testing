import type { ReactNode } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

import { SECTION_LABELS, type Section } from '@/forms/types';

export interface FormSectionProps {
  readonly section: Section;
  readonly open: boolean;
  readonly onToggle: (section: Section, open: boolean) => void;
  /** Number of fields in this section with a validation error. */
  readonly errorCount: number;
  readonly fieldCount: number;
  readonly children: ReactNode;
}

/**
 * One of the four collapsible bands, labelled from `SECTION_LABELS`.
 *
 * The labels are the row-3 merged band names read verbatim from the live
 * workbook — "Sample details", "Settings when sampled", "Test results",
 * "Follow-up" — so the screen and the spreadsheet use the same words for the
 * same group of columns.
 *
 * Built from a button and a region rather than `<details>`, because a section
 * must be forced open when it contains an error: the error summary links to a
 * field, and a field inside a collapsed container cannot receive focus. A
 * `<details>` element's open state is owned by the browser and fights that.
 *
 * Sections start OPEN. Collapsing is there for an operator who wants to skip
 * past a band they have already filled, not a default that hides the work.
 */
export function FormSection({
  section,
  open,
  onToggle,
  errorCount,
  fieldCount,
  children,
}: FormSectionProps): JSX.Element {
  const headingId = `section-${section}-heading`;
  const regionId = `section-${section}-region`;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section className="mb-4 overflow-hidden rounded-lg border-2 border-slate-300 bg-white">
      <h2 id={headingId} className="m-0">
        <button
          type="button"
          onClick={() => onToggle(section, !open)}
          aria-expanded={open}
          aria-controls={regionId}
          className="flex min-h-[44px] w-full items-center gap-2 bg-slate-50 px-4 py-3 text-left text-lg font-bold text-slate-900 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-700"
        >
          <Chevron aria-hidden="true" className="h-5 w-5 shrink-0" />
          <span className="flex-1">{SECTION_LABELS[section]}</span>

          {errorCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded border border-red-700 bg-red-50 px-2 py-0.5 text-sm font-semibold text-red-800">
              <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
              {errorCount} to fix
            </span>
          ) : (
            <span className="text-sm font-normal text-slate-600">
              {fieldCount} {fieldCount === 1 ? 'field' : 'fields'}
            </span>
          )}
        </button>
      </h2>

      {/* Kept mounted and hidden, so react-hook-form keeps every field
          registered and a collapsed section cannot drop values on submit. */}
      <div
        id={regionId}
        role="group"
        aria-labelledby={headingId}
        hidden={!open}
        className="divide-y divide-slate-200 px-4 pb-2"
      >
        {children}
      </div>
    </section>
  );
}
