import type { UseFormRegisterReturn } from 'react-hook-form';

import type { FieldDef } from '@/forms/types';
import { fieldIds } from './FieldShell';
import { DateField } from './DateField';
import { NumberField } from './NumberField';
import { SelectField } from './SelectField';
import { TextField } from './TextField';
import { TimeField } from './TimeField';
import { YesNoField } from './YesNoField';
import type { FieldInputProps } from './fieldControl';

export interface FieldRendererProps {
  readonly field: FieldDef;
  readonly idPrefix: string;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly control: UseFormRegisterReturn;
  readonly disabled: boolean;
  readonly currentValue: string;
}

/**
 * The single dispatch point from a registry `FieldDef` to a rendered input.
 *
 * This switch is the whole reason there are seven forms and one renderer. No
 * stage names a field here, no column index appears, and adding a column to
 * `registry.ts` makes it appear in the right section of the right form with
 * the right keyboard, unit, help text and validation — with no change to this
 * file (PRD NFR-006).
 */
export function FieldRenderer({
  field,
  idPrefix,
  required,
  error,
  control,
  disabled,
  currentValue,
}: FieldRendererProps): JSX.Element | null {
  const props: FieldInputProps = {
    field,
    ids: fieldIds(idPrefix, field.key),
    required,
    error,
    control,
    disabled,
    currentValue,
  };

  switch (field.type) {
    case 'number':
      return <NumberField {...props} />;
    case 'yesno':
      return <YesNoField {...props} />;
    case 'select':
      return <SelectField {...props} />;
    case 'date':
      return <DateField {...props} />;
    case 'time':
      return <TimeField {...props} />;
    case 'text':
    case 'textarea':
      return <TextField {...props} />;
    case 'system':
      // Column A is issued by the server at registration. It is shown on the
      // confirmation screen and the sample detail view, never as an input.
      return null;
    default: {
      const exhaustive: never = field.type;
      throw new Error(`Unhandled field type ${String(exhaustive)}`);
    }
  }
}
