import { AlertTriangle } from 'lucide-react';

import { YES_NO_OPTIONS } from '@/forms/types';
import { FieldGroupShell } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/**
 * A yes/no observation, as two large radio targets rather than a dropdown.
 *
 * These are the adverse-visual screening questions — mould, insects, foreign
 * matter, bad smell — and a Yes raises a quality hold regardless of every
 * numeric result (FR-010, UAT-08). They are too consequential to hide inside a
 * closed dropdown that an operator can scroll past: both answers are visible
 * and each is a full-width tap target.
 *
 * The stored value is the CODE (`yes` / `no`), never the label.
 */
export function YesNoField({
  field,
  ids,
  required,
  error,
  control,
  disabled,
  currentValue,
}: FieldInputProps): JSX.Element {
  const options = field.options ?? YES_NO_OPTIONS;
  const adverseSelected =
    field.adverseValue !== undefined && currentValue === field.adverseValue;

  return (
    <FieldGroupShell field={field} ids={ids} required={required} error={error}>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const optionId = `${ids.input}-${option.value}`;
          const selected = currentValue === option.value;
          return (
            <div key={option.value} className="flex-1 basis-32">
              <input
                {...control}
                id={optionId}
                type="radio"
                value={option.value}
                disabled={disabled}
                className="peer sr-only"
              />
              <label
                htmlFor={optionId}
                className={[
                  'flex min-h-[44px] cursor-pointer items-center justify-center rounded-md border-2 px-4 py-2',
                  'text-base font-semibold',
                  // The selected state is carried by a border weight, a tick
                  // and a background, not by colour alone (NFR-004).
                  selected
                    ? 'border-blue-700 bg-blue-50 text-blue-900'
                    : 'border-slate-400 bg-white text-slate-800',
                  'peer-focus-visible:ring-2 peer-focus-visible:ring-blue-700 peer-focus-visible:ring-offset-2',
                ].join(' ')}
              >
                <span aria-hidden="true" className="mr-2 font-mono">
                  {selected ? '✓' : '○'}
                </span>
                {option.label}
              </label>
            </div>
          );
        })}
      </div>

      {adverseSelected ? (
        <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-400 bg-amber-50 p-2 text-sm font-semibold text-amber-900">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This answer will put the sample on quality hold. A Quality Officer
            has to decide what happens to the material.
          </span>
        </p>
      ) : null}
    </FieldGroupShell>
  );
}
