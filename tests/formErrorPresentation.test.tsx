/**
 * What an operator sees when a save is refused.
 *
 * ===========================================================================
 * THE THREE DEFECTS THIS FILE PINS
 * ===========================================================================
 *
 * 1. THE ERROR STATE NEVER RENDERED. `inputClass(true)` returned
 *    `INPUT_CLASS + ' ' + INPUT_ERROR_CLASS`, which leaves
 *    `border-slate-300 bg-white` in the list beside `border-red-700
 *    bg-red-50`. Both are emitted by Tailwind at the same specificity, so the
 *    winner is source order — and it is the grey one. Measured in a real
 *    browser against the compiled stylesheet, on the exact string the
 *    function returned:
 *
 *        computed border-color   rgb(203, 213, 225)   slate-300
 *        computed background     rgb(255, 255, 255)   white
 *
 *    So a field with a validation error has always drawn exactly like a field
 *    without one. The red outline was written, reviewed, shipped, and lost
 *    the cascade in silence.
 *
 * 2. THE NOTICE CAME BACK ONLY ONCE. The focus effect was keyed on the error
 *    COUNT, which is the RESULT of a submit rather than the submit. The two
 *    coincide on the first failure (0 -> N) and never again, so a second tap
 *    of Register against the same incomplete form changed nothing React could
 *    see. An operator at the bottom of a long form saw the button do nothing.
 *
 * 3. THE SERVER'S COMPLAINTS NEVER REACHED THE FIELDS. The page flattened the
 *    server's structured per-field issues into one paragraph of
 *    `column_name: message` pairs and printed it in the "Not saved" strip —
 *    naming database columns, marking no fields, and leaving the section
 *    headers reading "8 fields" instead of "4 to fix".
 *
 * ===========================================================================
 * WHAT THIS ENVIRONMENT CAN AND CANNOT PROVE
 * ===========================================================================
 * jsdom has no layout engine and no CSS cascade over the project stylesheet.
 * So: whether we ASKED to scroll, to which element, with which alignment, is
 * testable here and is a fact about this code. Whether the notice is then
 * VISIBLE is not — `window.scrollY` stays 0, `getBoundingClientRect()`
 * returns zeros. Nothing below asserts visibility, and a test that did would
 * be measuring the absence of a layout engine.
 *
 * Likewise defect 1 is asserted on the CLASS STRING, not on a computed
 * colour, because jsdom never loads the compiled stylesheet. The string is
 * the part this code controls; the browser measurement that proved the
 * consequence is recorded above and in `FieldShell.tsx`.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { STAGE_SCHEMAS } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { emptyStageValues } from '@/forms/defaults';
import type { StageFormValues } from '@/forms/zodSchema';
import { StageForm, type ServerRefusal } from '@/components/form/StageForm';
import { INPUT_CLASS, INPUT_ERROR_CLASS, inputClass } from '@/components/form/FieldShell';
import type { FormActionAvailability } from '@/components/form/saveState';

const STAGE: Stage = 'raw_materials';

const ALL_ACTIONS: FormActionAvailability = {
  canSaveDraft: true,
  canRegister: true,
  canSaveResults: false,
  canVoid: false,
};

interface RenderOptions {
  readonly values?: StageFormValues;
  readonly saveState?: 'editing' | 'saving' | 'recorded' | 'failed';
  readonly errorMessage?: string | null;
  readonly refusal?: ServerRefusal | null;
  readonly saveAttempt?: number;
}

function renderForm(options: RenderOptions = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <StageForm
      stage={STAGE}
      phase="registration"
      initialValues={options.values ?? emptyStageValues(STAGE)}
      actions={ALL_ACTIONS}
      saveState={options.saveState ?? 'editing'}
      errorMessage={options.errorMessage ?? null}
      refusal={options.refusal ?? null}
      saveAttempt={options.saveAttempt ?? 0}
      onSubmit={onSubmit}
      onSaveDraft={vi.fn()}
      onCancel={vi.fn()}
      onVoid={vi.fn()}
    />,
  );
  return { ...utils, onSubmit };
}

/** The scroll stub installed by tests/setup.ts, as a spy. */
function scrollSpy(): ReturnType<typeof vi.fn> {
  return Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
}

describe('the error state actually renders (defect 1)', () => {
  it('drops the clean border and fill, instead of leaving both in the class list', () => {
    const errored = inputClass(true);

    // THE ASSERTIONS THAT FAIL AGAINST THE OLD CODE. The old implementation
    // concatenated, so both of these were present and both of these lines
    // would fail.
    expect(
      errored,
      'border-slate-300 survives into the error state and wins on source order',
    ).not.toMatch(/(^| )border-slate-300( |$)/);
    expect(
      errored,
      'bg-white survives into the error state and wins on source order',
    ).not.toMatch(/(^| )bg-white( |$)/);

    // And the red is genuinely there to win.
    expect(errored).toMatch(/(^| )border-red-700( |$)/);
    expect(errored).toMatch(/(^| )bg-red-50( |$)/);
  });

  it('leaves a clean field byte-identical, so nothing else moved', () => {
    // This is what makes the change safe rather than merely correct: every
    // field that is NOT in error renders exactly the string it rendered
    // before.
    expect(inputClass(false)).toBe(INPUT_CLASS);
  });

  it('keeps the disabled treatment, which a careless merge would drop', () => {
    expect(inputClass(true)).toMatch(/disabled:bg-slate-100/);
  });

  it('POSITIVE CONTROL: the two source strings really do conflict', () => {
    // Without this, the assertions above would still pass if somebody emptied
    // INPUT_ERROR_CLASS, and the suite would certify a form with no error
    // styling at all.
    expect(INPUT_CLASS).toMatch(/(^| )border-slate-300( |$)/);
    expect(INPUT_CLASS).toMatch(/(^| )bg-white( |$)/);
    expect(INPUT_ERROR_CLASS).toMatch(/border-red-700/);
    expect(INPUT_ERROR_CLASS).toMatch(/bg-red-50/);
  });

  it('marks the erroring input in the rendered form, not just in the helper', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: /register sample/i }));

    const quantity = screen.getByLabelText(/quantity received/i);
    expect(quantity.className).not.toMatch(/(^| )border-slate-300( |$)/);
    expect(quantity.className).toMatch(/border-red-700/);
    expect(quantity).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('the notice comes back on every attempt (defect 2)', () => {
  it('re-focuses the summary on a SECOND failed Register, not only the first', async () => {
    const user = userEvent.setup();
    renderForm();
    const register = screen.getByRole('button', { name: /register sample/i });

    await user.click(register);
    const heading = within(await screen.findByRole('alert')).getByRole('heading');
    expect(document.activeElement).toBe(heading);

    // Put focus back where tapping the button leaves it, then tap again with
    // the form in exactly the same state. THIS IS THE ASSERTION THAT FAILS
    // AGAINST THE OLD CODE: the error count is unchanged, so the old effect
    // never re-ran and focus stayed on the button.
    register.focus();
    expect(document.activeElement).toBe(register);

    await user.click(register);
    expect(
      document.activeElement,
      'a second failed submit left focus on the button, so the operator saw nothing happen',
    ).toBe(heading);
  });

  it('scrolls the notice region into view on every failed attempt', async () => {
    const user = userEvent.setup();
    const spy = scrollSpy();
    spy.mockClear();
    renderForm();
    const register = screen.getByRole('button', { name: /register sample/i });

    await user.click(register);
    expect(spy, 'nothing scrolled on the first failure').toHaveBeenCalledTimes(1);

    await user.click(register);
    expect(spy, 'nothing scrolled on the second failure').toHaveBeenCalledTimes(2);
  });

  it('scrolls to the element that CONTAINS the notice, aligned to its top', async () => {
    const user = userEvent.setup();
    const spy = scrollSpy();
    spy.mockClear();
    renderForm();

    await user.click(screen.getByRole('button', { name: /register sample/i }));

    const alert = await screen.findByRole('alert');
    const receiver = spy.mock.contexts[0] as Element;
    // The occupant assertion: it distinguishes "we scrolled to the right
    // thing" from "something, somewhere, scrolled".
    expect(receiver.contains(alert)).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toEqual({ block: 'start' });
  });

  it('never animates the scroll, so the reduced-motion policy is not overridden', async () => {
    const user = userEvent.setup();
    const spy = scrollSpy();
    spy.mockClear();
    renderForm();

    await user.click(screen.getByRole('button', { name: /register sample/i }));

    // `index.css` forces `scroll-behavior: auto !important` under
    // prefers-reduced-motion, and an explicit `behavior` argument overrides
    // the CSS property rather than being overridden by it. Omitting the key
    // is the only way the policy survives.
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('behavior');
  });

  it('does not steal focus while the operator is correcting a field', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: /register sample/i }));

    const quantity = screen.getByLabelText(/quantity received/i);
    await user.type(quantity, '12.5');

    // Keying on the error COUNT made this fail: re-validation on each
    // keystroke dropped the tally, the effect re-ran, and focus jumped to the
    // top of the form — which on a phone also closes the keyboard.
    expect(
      document.activeElement,
      'focus was pulled out of the field being corrected',
    ).toBe(quantity);
  });
});

describe('the server speaks through the fields (defect 3)', () => {
  const submitted: StageFormValues = {
    ...emptyStageValues(STAGE),
    quantity_received_t: 'abc',
  };

  const refusal: ServerRefusal = {
    issues: [{ field: 'quantity_received_t', message: 'Quantity received must be a number.' }],
    submitted,
  };

  it('marks the field the server named, and says so in words on the field', () => {
    renderForm({
      values: submitted,
      saveState: 'failed',
      errorMessage: 'Some entries need to be corrected before this can be saved.',
      refusal,
      saveAttempt: 1,
    });

    const quantity = screen.getByLabelText(/quantity received/i);
    expect(quantity).toHaveAttribute('aria-invalid', 'true');
    expect(quantity.className).toMatch(/border-red-700/);

    // NFR-004: the message is TEXT, not only a colour — and it is ON the
    // field, wired through aria-describedby, not only in the summary at the
    // top. Scoped to the described element rather than the whole document,
    // because it correctly appears in BOTH places: the summary lists it, the
    // field states it. A bare `getByText` finds two and proves neither.
    const describedBy = quantity.getAttribute('aria-describedby') ?? '';
    const onField = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(onField).toMatch(/quantity received must be a number/i);

    // And the summary carries it too, as its own entry.
    const summary = screen.getByRole('alert');
    expect(
      within(summary).getByRole('button', { name: /quantity received/i }),
    ).toBeInTheDocument();
  });

  it('counts it in the section header, which used to read "8 fields"', () => {
    renderForm({ values: submitted, saveState: 'failed', refusal, saveAttempt: 1 });
    const label = STAGE_SCHEMAS[STAGE].fields.find(
      (f) => f.key === 'quantity_received_t',
    )?.section;
    expect(label).toBeDefined();
    expect(screen.getByText(/1 to fix/i)).toBeInTheDocument();
  });

  it('NEVER prints the raw column name at the operator', () => {
    renderForm({
      values: submitted,
      saveState: 'failed',
      errorMessage: 'Some entries need to be corrected before this can be saved.',
      refusal,
      saveAttempt: 1,
    });

    // The reported symptom, as an assertion. `quantity_received_t` is a
    // database column; it is not a thing on the operator's screen.
    expect(document.body.textContent).not.toMatch(/quantity_received_t/);
  });

  it('clears the mark when that field is edited, and not before', async () => {
    const user = userEvent.setup();
    renderForm({ values: submitted, saveState: 'failed', refusal, saveAttempt: 1 });

    const quantity = screen.getByLabelText(/quantity received/i);
    expect(quantity.className).toMatch(/border-red-700/);

    // Editing a DIFFERENT field must not clear it — the server has not been
    // asked again about this one.
    await user.type(screen.getByLabelText(/^date/i), '2026-10-29');
    expect(
      screen.getByLabelText(/quantity received/i).className,
      'editing another field cleared a complaint the server still holds',
    ).toMatch(/border-red-700/);

    await user.clear(quantity);
    await user.type(quantity, '12.5');
    expect(screen.getByLabelText(/quantity received/i).className).not.toMatch(
      /border-red-700/,
    );
  });

  it('shows an issue it cannot place, rather than dropping it', () => {
    renderForm({
      saveState: 'failed',
      errorMessage: 'Not saved.',
      refusal: {
        issues: [
          { field: 'some_column_not_on_this_form', message: 'The sampling point is unknown.' },
        ],
        submitted: emptyStageValues(STAGE),
      },
      saveAttempt: 1,
    });

    // A refusal nobody can see is worse than an ugly one.
    expect(screen.getByText(/the sampling point is unknown/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/some_column_not_on_this_form/);
  });

  it('brings the banner on screen again on an identical repeat refusal', () => {
    const spy = scrollSpy();
    spy.mockClear();

    const { rerender } = renderForm({
      saveState: 'failed',
      errorMessage: 'Not saved.',
      saveAttempt: 1,
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // Byte-identical state except the attempt counter. THIS IS WHY THE
    // COUNTER EXISTS: without it React sees no change at all, and the
    // operator's second tap produces nothing on screen.
    rerender(
      <StageForm
        stage={STAGE}
        phase="registration"
        initialValues={emptyStageValues(STAGE)}
        actions={ALL_ACTIONS}
        saveState="failed"
        errorMessage="Not saved."
        refusal={null}
        saveAttempt={2}
        onSubmit={vi.fn()}
        onSaveDraft={vi.fn()}
        onCancel={vi.fn()}
        onVoid={vi.fn()}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('required fields are marked in more than one way (NFR-004)', () => {
  it('carries the asterisk, the word, and aria-required together', () => {
    renderForm();
    const quantity = screen.getByLabelText(/quantity received/i);

    // The machine-readable carrier, which did not exist anywhere in the app.
    expect(quantity).toHaveAttribute('aria-required', 'true');

    const label = document.querySelector(`label[for="${quantity.id}"]`);
    expect(label).not.toBeNull();
    // The word survives: an asterisk alone means nothing to somebody who has
    // not been told what it means.
    expect(label?.textContent).toMatch(/\(required\)/);
    // And the asterisk is present for scanning, hidden from the announcement
    // so it is not read as "star (required)".
    const star = label?.querySelector('[aria-hidden="true"]');
    expect(star?.textContent).toBe('*');
  });
});
