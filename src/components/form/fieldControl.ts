import type { UseFormRegisterReturn } from 'react-hook-form';

import type { FieldDef } from '@/forms/types';
import type { FieldIds } from './FieldShell';

/**
 * The props every input type takes.
 *
 * `control` is react-hook-form's own `register()` return value, passed straight
 * through. Spreading it onto the native element is what keeps the inputs
 * uncontrolled: the browser holds the operator's literal keystrokes, so
 * `12.50` keeps its trailing zero and no React re-render can normalise it away.
 */
export interface FieldInputProps {
  readonly field: FieldDef;
  readonly ids: FieldIds;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly control: UseFormRegisterReturn;
  readonly disabled: boolean;
  /**
   * The current value, for DISPLAY decisions only — highlighting a selected
   * option, or warning that the chosen answer will raise a quality hold. The
   * input's actual value still lives in the DOM, so this never round-trips the
   * operator's text through React.
   */
  readonly currentValue: string;
  /** Render for a grid cell: see `FieldShell`'s `compact`. */
  readonly compact?: boolean;
}
