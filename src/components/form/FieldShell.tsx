import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

import type { FieldDef } from '@/forms/types';
import { cn } from '@/lib/cn';
import { HelpHint } from './HelpHint';
import { UnitBadge, UnitNote } from './UnitBadge';

/** The stable id set for one field, so every label and description can bind. */
export interface FieldIds {
  readonly input: string;
  readonly help: string;
  readonly unitNote: string;
  readonly error: string;
}

export function fieldIds(prefix: string, key: string): FieldIds {
  return {
    input: `${prefix}-${key}`,
    help: `${prefix}-${key}-help`,
    unitNote: `${prefix}-${key}-unit`,
    error: `${prefix}-${key}-error`,
  };
}

/**
 * The list of description ids an input should point `aria-describedby` at.
 * Only ids that will actually be rendered are included — a dangling reference
 * makes some screen readers announce nothing at all.
 */
export function describedBy(field: FieldDef, ids: FieldIds, hasError: boolean): string | undefined {
  const parts: string[] = [];
  if (field.help !== undefined && field.help.trim() !== '') parts.push(ids.help);
  if (field.unitConfirmed === false) parts.push(ids.unitNote);
  if (hasError) parts.push(ids.error);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export interface FieldShellProps {
  readonly field: FieldDef;
  readonly ids: FieldIds;
  readonly required: boolean;
  readonly error: string | undefined;
  /** The input, select or textarea itself. */
  readonly children: ReactNode;
  /**
   * Lay the field out for a table cell: no visible label, no help text, no
   * vertical padding — the surrounding grid supplies all three in its column
   * headers and row headings.
   *
   * THE LABEL IS STILL RENDERED, as `sr-only`. A grid's column header is not
   * programmatically associated with the inputs beneath it, so deleting the
   * `<label>` would leave fourteen boxes a screen-reader user hears as
   * "edit text" with no way to tell the empty-sieve column from the
   * sieve-plus-sample one. Hiding it visually costs a sighted operator
   * nothing and keeps the accessible name exact.
   */
  readonly compact?: boolean;
}

/**
 * The required marker: a red asterisk AND the word, never one or the other.
 *
 * The word was here first, with a comment saying an asterisk means nothing to
 * somebody who has not been told what it means. That is true, and it is why
 * the word stays. But it answers a different question from the one the
 * asterisk answers.
 *
 * The asterisk is a SCANNING aid. An operator in gloves, holding a phone at
 * arm's length over a mixer, needs to find the four fields that still want
 * something among twenty-six — without reading any of them. A glyph at a
 * fixed position in every label does that; a word in brackets does not,
 * because reading it is the work being avoided.
 *
 * The word is the SEMANTIC carrier. It is what a screen reader announces and
 * what somebody who has never met the convention understands.
 *
 * Swapping the word for the asterisk — which is the literal reading of the
 * request — would trade a text signal for a glyph signal, and a glyph whose
 * meaning is purely conventional is barely better than colour alone under
 * NFR-004. So both, with the asterisk `aria-hidden` so the announcement is
 * "(required)" and not "star (required)".
 */
function RequiredMark(): JSX.Element {
  return (
    <>
      <span aria-hidden="true" className="ml-0.5 font-bold text-red-700">
        *
      </span>
      <span className="ml-1 text-sm font-medium text-slate-600">(required)</span>
    </>
  );
}

/**
 * The label's colour when the field is in error.
 *
 * `text-red-900` (#7F1D1D) on white measures 10.9:1, and on the `red-50` the
 * errored input carries it is still 9.9:1 — both far above the 4.5 floor.
 *
 * This exists because the error message sits BELOW the control: on a phone,
 * an operator scrolling a twenty-six field form to find what is wrong reads
 * labels, and a label is the one part of a field that is always above the
 * fold of its own block. A left rail was the obvious alternative and does not
 * work here — `FormSection` puts `divide-y divide-slate-200` on the field
 * container, which compiles to a four-side `border-color` shorthand at higher
 * specificity than a child utility, so a red rail renders grey.
 */
function labelClass(hasError: boolean): string {
  return cn(
    'flex flex-wrap items-center gap-x-1 text-base font-semibold',
    hasError ? 'text-red-900' : 'text-slate-900',
  );
}

/**
 * Label, unit, help and error scaffolding shared by every input type.
 *
 * Centralising it is what makes the accessibility contract hold for all 98
 * columns at once: one `<label for>`, one `aria-describedby` wiring, one error
 * presentation. A per-input copy of this markup would drift field by field.
 *
 * Requiredness and error state are both conveyed in TEXT as well as colour and
 * icon (NFR-004: no colour-only signals). "Required" is a word, not a red
 * asterisk, because an asterisk means nothing to someone who has not been told
 * what it means.
 */
export function FieldShell({
  field,
  ids,
  required,
  error,
  children,
  compact = false,
}: FieldShellProps): JSX.Element {
  if (compact) {
    return (
      <div>
        {/* Exactly the label, nothing appended: requiredness is already on
            the input as `aria-required`, and repeating it here would make the
            accessible name differ from the visible one for no gain. */}
        <label htmlFor={ids.input} className="sr-only">
          {field.label}
        </label>
        {/* The unit note still has to exist: `describedBy` points at its id
            for any field whose unit is unconfirmed, and an aria-describedby
            aiming at a missing element announces nothing at all. */}
        <UnitNote field={field} id={ids.unitNote} />
        {children}
        {error !== undefined ? (
          <p id={ids.error} className="mt-1 text-xs font-semibold text-red-800">
            <span className="sr-only">Problem: </span>
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="py-3">
      <label htmlFor={ids.input} className={labelClass(error !== undefined)}>
        <span>{field.label}</span>
        <UnitBadge field={field} />
        {required ? <RequiredMark /> : null}
      </label>

      <HelpHint id={ids.help} text={field.help} />
      <UnitNote field={field} id={ids.unitNote} />

      <div className="mt-2">{children}</div>

      {error !== undefined ? (
        <p
          id={ids.error}
          className="mt-2 flex items-start gap-1.5 text-sm font-semibold text-red-800"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="sr-only">Problem: </span>
            {error}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The same scaffolding for a group of radios.
 *
 * A radio group cannot use `<label for>` for the group itself — a label points
 * at one control, and here there are two. The accessible construction is
 * `<fieldset>` + `<legend>`, with each radio carrying its own `<label for>`.
 * The fieldset is focusable (`tabIndex={-1}`) purely so the error summary can
 * move focus to it, which announces the legend and the error together.
 */
export function FieldGroupShell({
  field,
  ids,
  required,
  error,
  children,
}: FieldShellProps): JSX.Element {
  return (
    <fieldset
      id={ids.input}
      tabIndex={-1}
      className="py-3 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
      aria-invalid={error !== undefined}
      aria-required={required}
      aria-describedby={describedBy(field, ids, error !== undefined)}
    >
      <legend className={labelClass(error !== undefined)}>
        <span>{field.label}</span>
        <UnitBadge field={field} />
        {required ? <RequiredMark /> : null}
      </legend>

      <HelpHint id={ids.help} text={field.help} />
      <UnitNote field={field} id={ids.unitNote} />

      <div className="mt-2">{children}</div>

      {error !== undefined ? (
        <p
          id={ids.error}
          className="mt-2 flex items-start gap-1.5 text-sm font-semibold text-red-800"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="sr-only">Problem: </span>
            {error}
          </span>
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Shared input styling. 44px minimum height is the tap-target floor from
 * NFR-004; the focus ring is deliberately thick and offset because the app is
 * used in bright daylight on a scratched phone screen.
 */
/**
 * AN INPUT IS CONCAVE. That is the one place the neumorphic metaphor earns
 * its keep rather than decorating: a surface you put something INTO is
 * pressed in, while a control you push is raised. The home screen's tiles and
 * the action bar's buttons are extruded for the same reason, from the same
 * tokens.
 *
 * The border stays. A purely shadow-defined edge is the standard neumorphism
 * failure — the style is flagged as a low-contrast risk, and this form is
 * read in daylight on a scratched phone by someone wearing gloves, so the
 * field's boundary may not depend on a soft shadow being visible. The shadow
 * is added TO the border, never instead of it.
 *
 * `focus:ring-offset-1` and the thick ring are unchanged for the same reason
 * the original comment gives: the focus ring must survive bright sunlight.
 */
export const INPUT_CLASS =
  'block w-full min-w-0 max-w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-neu-inset ' +
  'text-base text-slate-900 placeholder:text-slate-400 ' +
  'focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-1 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500';

export const INPUT_ERROR_CLASS = 'border-red-700 bg-red-50';

/**
 * THE ERROR STATE NEVER RENDERED. This function used to join the two strings
 * with a space:
 *
 *     `${INPUT_CLASS} ${INPUT_ERROR_CLASS}`
 *
 * which leaves `border-slate-300 bg-white` sitting in the class list beside
 * `border-red-700 bg-red-50`. Both utilities are emitted by Tailwind at the
 * same specificity, so the winner is whichever comes LATER in the stylesheet
 * — and it is not the red one.
 *
 * Measured, in a real browser, against the compiled stylesheet, on the exact
 * string this function used to return:
 *
 *     computed border-color  rgb(203, 213, 225)   slate-300, not red-700
 *     computed background    rgb(255, 255, 255)   white, not red-50
 *
 * and in the compiled CSS `.border-slate-300` sits 444 bytes AFTER
 * `.border-red-700`, `.bg-white` 763 bytes after `.bg-red-50`. So a field
 * with a validation error has always drawn exactly like a field without one.
 * That is why an operator reported that nothing goes red: the code for it was
 * written, reviewed and shipped, and silently lost the cascade.
 *
 * `cn()` is tailwind-merge, which resolves the conflict by INTENT rather than
 * by source order — a later utility in the same group replaces the earlier
 * one. Measured on these two exact strings:
 *
 *     cn(INPUT_CLASS) === INPUT_CLASS                 true
 *     cn(INPUT_CLASS, INPUT_ERROR_CLASS) drops        border-slate-300, bg-white
 *     ...and keeps                                    border-red-700, bg-red-50,
 *                                                     disabled:bg-slate-100
 *
 * The first line is what makes this safe: every field that is NOT in error
 * renders a byte-identical class string, so there is no visual change to the
 * clean form at all.
 */
export function inputClass(hasError: boolean): string {
  return hasError ? cn(INPUT_CLASS, INPUT_ERROR_CLASS) : INPUT_CLASS;
}
