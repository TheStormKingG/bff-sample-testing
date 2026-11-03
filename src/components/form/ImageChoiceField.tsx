import { FieldGroupShell } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/**
 * A controlled vocabulary chosen by LOOKING, not by reading.
 *
 * ===========================================================================
 * WHY THIS IS NOT A DROPDOWN WITH PICTURES BOLTED ON
 * ===========================================================================
 * The qualitative urease test has no number in it. An operator wets 0.2 g of
 * meal with urea-phenol red, waits, and then compares the dish in front of
 * them against four reference dishes. The photographs ARE the instrument —
 * the words under them are a summary of what the picture shows, not the other
 * way round. A dropdown reading "Properly cooked (moderately active)" asks
 * someone holding a speckled petri dish to translate it into a phrase before
 * they can answer, which is precisely the step the reference card exists to
 * remove, and the step where a tired reader at the end of a run picks wrong.
 *
 * So the options are laid out side by side, every one visible at once, in the
 * order the source table lists them — least red to most red. Nothing is
 * hidden behind a tap.
 *
 * ===========================================================================
 * WHAT IS STORED IS STILL THE CODE
 * ===========================================================================
 * This changes the presentation and nothing else. The field is
 * `type: 'select'`, the radio group writes the option's CODE, and the same
 * list is enforced by the browser schema, `validateStagePayload` and
 * `assert_measurement_in_options`. A picture cannot introduce a value: an
 * option with no gallery entry still renders, as a card with no photograph,
 * because dropping an answer from the form would be worse than showing it
 * plainly.
 *
 * ===========================================================================
 * AND IT IS ANSWERABLE WITHOUT SEEING THE PHOTOGRAPHS
 * ===========================================================================
 * Each image carries alt text describing the OBSERVATION, not the object —
 * "a few scattered red specks", never "a petri dish" — and the same
 * observation is printed as text under every card. A screen-reader user, or
 * anyone on a connection that drops the images, reads the same four
 * descriptions a sighted operator is matching against. The selected state is
 * carried by a border weight, a tick and a background, never colour alone
 * (NFR-004).
 */
export function ImageChoiceField({
  field,
  ids,
  required,
  error,
  control,
  disabled,
  currentValue,
}: FieldInputProps): JSX.Element {
  const gallery = field.optionGallery ?? [];
  const base = import.meta.env.BASE_URL;

  return (
    <FieldGroupShell field={field} ids={ids} required={required} error={error}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(field.options ?? [])
          // Retired options follow `SelectField`'s rule exactly: still legal,
          // still encodable, but offered only on the record that holds one.
          .filter((option) => option.retired !== true || option.value === currentValue)
          .map((option) => {
            const optionId = `${ids.input}-${option.value}`;
            const selected = currentValue === option.value;
            const picture = gallery.find((entry) => entry.value === option.value);
            return (
              <div key={option.value}>
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
                    'flex h-full cursor-pointer flex-col gap-2 rounded-xl border-2 p-2',
                    selected
                      ? 'border-blue-700 bg-blue-50'
                      : 'border-slate-400 bg-neu-base shadow-neu-sm',
                    'peer-focus-visible:ring-2 peer-focus-visible:ring-blue-700 peer-focus-visible:ring-offset-2',
                  ].join(' ')}
                >
                  {picture !== undefined ? (
                    <img
                      src={`${base}${picture.image}`}
                      alt={picture.imageAlt}
                      width={480}
                      height={480}
                      loading="lazy"
                      // `aspect-square` with explicit dimensions so the row
                      // does not reflow as the four files arrive.
                      className="aspect-square w-full rounded-lg object-cover"
                    />
                  ) : null}

                  <span className="flex items-start gap-1.5 text-sm font-semibold text-slate-900">
                    <span aria-hidden="true" className="font-mono leading-5">
                      {selected ? '✓' : '○'}
                    </span>
                    <span>
                      {option.retired === true ? `${option.label} (no longer offered)` : option.label}
                    </span>
                  </span>

                  {picture !== undefined ? (
                    <span className="text-xs text-slate-700">
                      {picture.observation}
                      {/*
                        The reference figure is what the QUANTITATIVE method
                        would report for a dish that looks like this. It is
                        not what was measured here and it is not stored — see
                        `UREASE_QUALITATIVE_OPTIONS` — so it is set apart from
                        the observation rather than printed as a result.
                      */}
                      <span className="mt-0.5 block text-slate-600">{picture.reference}</span>
                    </span>
                  ) : null}
                </label>
              </div>
            );
          })}
      </div>
    </FieldGroupShell>
  );
}
