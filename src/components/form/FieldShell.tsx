import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

import type { FieldDef } from '@/forms/types';
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
}: FieldShellProps): JSX.Element {
  return (
    <div className="py-3">
      <label
        htmlFor={ids.input}
        className="flex flex-wrap items-center gap-x-1 text-base font-semibold text-slate-900"
      >
        <span>{field.label}</span>
        <UnitBadge field={field} />
        {required ? (
          <span className="ml-1 text-sm font-medium text-slate-600">(required)</span>
        ) : null}
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
      aria-describedby={describedBy(field, ids, error !== undefined)}
    >
      <legend className="flex flex-wrap items-center gap-x-1 text-base font-semibold text-slate-900">
        <span>{field.label}</span>
        <UnitBadge field={field} />
        {required ? (
          <span className="ml-1 text-sm font-medium text-slate-600">(required)</span>
        ) : null}
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
  'block w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-neu-inset ' +
  'text-base text-slate-900 placeholder:text-slate-400 ' +
  'focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-1 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500';

export const INPUT_ERROR_CLASS = 'border-red-700 bg-red-50';

export function inputClass(hasError: boolean): string {
  return hasError ? `${INPUT_CLASS} ${INPUT_ERROR_CLASS}` : INPUT_CLASS;
}
