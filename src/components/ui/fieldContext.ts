import { createContext, useContext } from 'react';

/**
 * What a `Field` tells the control inside it.
 *
 * Passing this down rather than asking every caller to wire `id`,
 * `aria-describedby` and `aria-invalid` by hand is what makes the accessible
 * pairing hard to forget: a label with no `for`, or an error message no
 * screen reader ever announces, is the usual outcome of leaving it to the
 * call site (PRD NFR-004).
 */
export interface FieldControl {
  readonly id: string;
  /** Space-separated ids of the hint, unit and error text, or undefined. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
}

export const FieldControlContext = createContext<FieldControl | null>(null);

/** Null when a control is used outside a `Field`, which is allowed. */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldControlContext);
}
