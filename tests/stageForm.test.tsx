/**
 * The generated stage form, rendered.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * `tests/zodSchema.test.ts` already proves the validation rules and
 * `tests/registry.test.ts` the column mapping. What neither can show is that
 * the RENDERED form obeys them: that a non-applicable column is genuinely
 * absent from the DOM, that a unit reaches the label, that an unconfirmed unit
 * says so where the operator reads it, and that an empty submission produces
 * something rather than nothing.
 *
 * `StageForm` is rendered DIRECTLY, not through the router or the app shell.
 * That is deliberate: the component's whole module graph is the registry, the
 * Zod builder and the field components, none of which touch Supabase, the
 * session or the network. Rendering it through the app would drag in the
 * client, the env allowlist and a signed-in profile, and would make a failure
 * here ambiguous between "the form is wrong" and "the harness is wrong". A
 * `fetch` spy asserts the no-network claim rather than leaving it as prose.
 *
 * Every expectation is derived from `registry.ts`. A hard-coded field list
 * would pass while the form showed the wrong columns, which is the exact
 * failure NFR-006 exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { STAGE_SCHEMAS, fieldsRequiredAt, isFieldApplicable } from '@/forms/registry';
import { SECTIONS, SECTION_LABELS, type FieldDef, type Section, type Stage } from '@/forms/types';
import { defaultStageValues, emptyStageValues } from '@/forms/defaults';
import { editableFields, type StageFormValues } from '@/forms/zodSchema';
import { StageForm, type StageFormSubmission } from '@/components/form/StageForm';
import type { FormActionAvailability } from '@/components/form/saveState';

/**
 * Field labels carry parentheses and dots — "Size spread (GSD)", "Tested by
 * (QO)", "Delivery or lot no." — so a label interpolated straight into a
 * RegExp stops being the text it came from. Escaped, every query means what it
 * reads as.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelPattern(label: string): RegExp {
  return new RegExp(escapeRegExp(label), 'i');
}

const ALL_ACTIONS: FormActionAvailability = {
  canSaveDraft: true,
  canRegister: true,
  canSaveResults: false,
  canVoid: false,
};

interface Harness {
  readonly onSubmit: ReturnType<typeof vi.fn>;
  readonly onSaveDraft: ReturnType<typeof vi.fn>;
  readonly onCancel: ReturnType<typeof vi.fn>;
  readonly onVoid: ReturnType<typeof vi.fn>;
}

function renderStage(
  stage: Stage,
  initialValues: StageFormValues,
  overrides: Partial<FormActionAvailability> = {},
): Harness {
  const handlers: Harness = {
    onSubmit: vi.fn(),
    onSaveDraft: vi.fn(),
    onCancel: vi.fn(),
    onVoid: vi.fn(),
  };

  render(
    <StageForm
      stage={stage}
      phase="registration"
      initialValues={initialValues}
      actions={{ ...ALL_ACTIONS, ...overrides }}
      saveState="editing"
      onSubmit={handlers.onSubmit}
      onSaveDraft={handlers.onSaveDraft}
      onCancel={handlers.onCancel}
      onVoid={handlers.onVoid}
    />,
  );

  return handlers;
}

/**
 * A complete registration payload, built from the registry.
 *
 * CLEARLY-MARKED TEST-ONLY FIXTURE. The numbers below are arbitrary
 * data-entry values chosen only to be well formed. None of them is, or implies,
 * an acceptance limit: 0 of the 34 workbook `Limits` entries are approved, and
 * nothing in this file may suggest otherwise.
 */
function fillRegistrationFields(stage: Stage, seed: StageFormValues): StageFormValues {
  const values: StageFormValues = { ...seed };
  for (const field of fieldsRequiredAt(stage, 'registration', values)) {
    if ((values[field.key] ?? '') !== '') continue;
    switch (field.type) {
      case 'date':
        values[field.key] = '2026-10-24';
        break;
      case 'time':
        values[field.key] = '09:30';
        break;
      case 'number':
        values[field.key] = '1';
        break;
      case 'select':
      case 'yesno': {
        const first = field.options?.[0]?.value;
        if (first !== undefined) values[field.key] = first;
        break;
      }
      default:
        values[field.key] = 'test value';
        break;
    }
  }
  return values;
}

/** The bands this stage actually has, per the registry. */
function expectedSections(stage: Stage, values: StageFormValues): readonly Section[] {
  const applicable = editableFields(stage, values);
  return SECTIONS.filter((section) => applicable.some((field) => field.section === section));
}

/** The <label> (or <legend>) text for one field, including its unit badge. */
function labelTextFor(field: FieldDef): string {
  const node = screen.getByText(field.label, { selector: 'span' });
  const owner = node.closest('label') ?? node.closest('legend');
  expect(owner, `no label or legend wraps "${field.label}"`).not.toBeNull();
  return owner?.textContent ?? '';
}

let fetchCalls = 0;

beforeEach(() => {
  // The claim is that rendering and submitting this form reaches no network at
  // all. Asserted, not assumed: any request both counts and throws, so a stray
  // call cannot pass as a quiet success either.
  fetchCalls = 0;
  if (typeof globalThis.fetch === 'function') {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((): never => {
      fetchCalls += 1;
      throw new Error('StageForm must not make a network request.');
    }) as unknown as typeof globalThis.fetch);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StageForm — section bands', () => {
  it('renders the bands Raw Materials has, and not the one it does not', () => {
    const values = defaultStageValues('raw_materials');
    renderStage('raw_materials', values);

    const expected = expectedSections('raw_materials', values);

    // The premise, asserted rather than assumed: tab 1 carries no row-3
    // "Settings when sampled" band, which is why the form must not show one.
    expect(expected).not.toContain('settings');
    expect(expected.length).toBeGreaterThan(0);

    for (const section of expected) {
      expect(
        screen.getByRole('button', { name: new RegExp(SECTION_LABELS[section], 'i') }),
      ).toBeInTheDocument();
    }

    expect(
      screen.queryByRole('button', { name: new RegExp(SECTION_LABELS.settings, 'i') }),
    ).not.toBeInTheDocument();
  });

  it('renders the settings band for a stage that has one', () => {
    const values = defaultStageValues('conditioned');
    renderStage('conditioned', values);

    expect(expectedSections('conditioned', values)).toContain('settings');
    expect(
      screen.getByRole('button', { name: new RegExp(SECTION_LABELS.settings, 'i') }),
    ).toBeInTheDocument();
  });

  it('renders every applicable field of every stage exactly once', () => {
    // A count the test asserts, so a field that silently failed to render is
    // visible instead of being absorbed by the loop's length.
    let checked = 0;
    for (const stage of Object.keys(STAGE_SCHEMAS) as Stage[]) {
      const values = defaultStageValues(stage);
      const { unmount } = render(
        <StageForm
          stage={stage}
          phase="registration"
          initialValues={values}
          actions={ALL_ACTIONS}
          saveState="editing"
          onSubmit={vi.fn()}
          onSaveDraft={vi.fn()}
          onCancel={vi.fn()}
          onVoid={vi.fn()}
        />,
      );

      for (const field of editableFields(stage, values)) {
        // Matched on the LABEL, not on a span. A field laid out in a grid
        // cell renders its label `sr-only` and without the span wrapper the
        // stacked layout uses, so a span selector silently stopped seeing the
        // fourteen sieve masses — while the label, and the association that
        // actually matters, were still there.
        expect(
          screen.getAllByText(field.label, { selector: 'span, label' }).length,
          `"${field.label}" on ${stage}`,
        ).toBe(1);
        checked += 1;
      }
      unmount();
    }
    /*
     * Two independent counts of the same quantity, which is the point: the
     * loop's own tally, and an arithmetic one taken from the verified column
     * counts. 98 verified workbook columns, minus the system column A on each
     * of the seven tabs, minus the columns that do not apply under the default
     * values (only Ground's BC-only moisture, since no sampling point is
     * chosen yet).
     */
    const columns = Object.values(STAGE_SCHEMAS).reduce((n, s) => n + s.columnCount, 0);
    const systemColumns = Object.values(STAGE_SCHEMAS).reduce(
      (n, s) => n + s.fields.filter((f) => f.type === 'system').length,
      0,
    );
    const notApplicable = Object.values(STAGE_SCHEMAS).reduce(
      (n, s) =>
        n +
        s.fields.filter(
          (f) => f.type !== 'system' && !isFieldApplicable(f, defaultStageValues(s.stage)),
        ).length,
      0,
    );
    // 98 across the original seven tabs plus 35 for `8 DGM`.
    expect(columns).toBe(133);
    // Was 7 — one column A per stage. Now 17: eight column As, plus DGM's nine
    // server-computed columns, which are `system` precisely so they never
    // render as an operator input.
    expect(systemColumns).toBe(17);
    expect(notApplicable).toBe(1);
    expect(checked).toBe(columns - systemColumns - notApplicable);
  });
});

describe('StageForm — conditional applicability (UAT-02)', () => {
  /**
   * The conditional column, found through the registry rather than named.
   * Observation: a sweep that leaves a conditional member in its default state
   * tests the default, not the property, so this one is deliberately placed in
   * both of its states below.
   */
  const conditional = STAGE_SCHEMAS.ground.fields.find((field) => field.appliesWhen !== undefined);

  it('the premise holds: Ground has exactly one BC-only column', () => {
    const gated = STAGE_SCHEMAS.ground.fields.filter((field) => field.appliesWhen !== undefined);
    expect(gated.map((field) => field.key)).toEqual(['moisture_pct_bc']);
    expect(gated[0]?.appliesWhen?.equals).toEqual(['BC']);
  });

  it('does not render the BC-only column at sampling point AM', () => {
    expect(conditional).toBeDefined();
    renderStage('ground', { ...defaultStageValues('ground'), sampling_point: 'AM' });

    expect(
      screen.queryByText(conditional?.label ?? '—', { selector: 'span' }),
    ).not.toBeInTheDocument();
  });

  it('renders the BC-only column at sampling point BC', () => {
    expect(conditional).toBeDefined();
    renderStage('ground', { ...defaultStageValues('ground'), sampling_point: 'BC' });

    expect(screen.getByText(conditional?.label ?? '—', { selector: 'span' })).toBeInTheDocument();
  });

  it('clears a BC reading when the operator switches to AM, and never submits it', async () => {
    const user = userEvent.setup();
    const key = conditional?.key ?? 'moisture_pct_bc';

    const seeded = fillRegistrationFields('ground', {
      ...defaultStageValues('ground'),
      sampling_point: 'BC',
    });
    const { onSubmit } = renderStage('ground', seeded);

    const moisture = screen.getByLabelText(labelPattern(conditional?.label ?? '—'));
    await user.type(moisture, '13.25');
    expect(moisture).toHaveValue('13.25');

    const point = screen.getByLabelText(/sampling point/i);
    await user.selectOptions(point, 'AM');

    // Gone from the screen...
    expect(
      screen.queryByText(conditional?.label ?? '—', { selector: 'span' }),
    ).not.toBeInTheDocument();

    // ...and gone from the payload, which is the part that would otherwise
    // reach the spreadsheet as a reading taken at the wrong point.
    await user.click(screen.getByRole('button', { name: /register sample/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0]?.[0] as StageFormSubmission;
    expect(Object.keys(submission.values)).not.toContain(key);
    expect(submission.values['sampling_point']).toBe('AM');

    // Switching back shows an empty box, not the stale 13.25.
    await user.selectOptions(point, 'BC');
    expect(screen.getByLabelText(labelPattern(conditional?.label ?? '—'))).toHaveValue('');
  });
});

describe('StageForm — units', () => {
  it('shows the stated unit beside every measurement that has one', () => {
    const stage: Stage = 'raw_materials';
    const values = defaultStageValues(stage);
    renderStage(stage, values);

    let checked = 0;
    for (const field of editableFields(stage, values)) {
      if (field.unit === undefined || field.unitConfirmed === false) continue;
      expect(labelTextFor(field), `unit missing for "${field.label}"`).toContain(field.unit);
      checked += 1;
    }
    // Guard: a sweep that checked nothing would otherwise pass.
    expect(checked).toBeGreaterThan(0);
  });

  it('shows no unit for a dimensionless column', () => {
    // GSD has no unit by definition and the workbook `Limits` unit cell is
    // blank, so inventing one would be a fabricated technical fact.
    const values = { ...defaultStageValues('ground'), sampling_point: 'BC' };
    renderStage('ground', values);

    const gsd = STAGE_SCHEMAS.ground.fields.find((field) => field.key === 'size_spread_gsd');
    expect(gsd?.unit).toBeUndefined();
    expect(gsd?.unitConfirmed).toBeUndefined();
    // The label is the label and nothing else: no invented unit, and no
    // "unit not confirmed" warning either, because the absence of a unit here
    // is correct rather than outstanding.
    const labelText = labelTextFor(gsd as FieldDef);
    expect(labelText.replace(/\(required\)\s*$/, '')).toBe(gsd?.label);
  });
});

describe('StageForm — unconfirmed unit (PRD §5.3, UAT-07)', () => {
  it('marks the Conditioned steam pressure reading as having no confirmed unit', () => {
    const values = defaultStageValues('conditioned');
    renderStage('conditioned', values);

    const unconfirmed = editableFields('conditioned', values).filter(
      (field) => field.unitConfirmed === false,
    );
    // The verified workbook fact this marker exists for: `Limits` row 13's
    // Unit cell literally reads "to confirm".
    expect(unconfirmed.map((field) => field.key)).toEqual(['steam_pressure_reading']);

    const field = unconfirmed[0] as FieldDef;
    expect(labelTextFor(field)).toContain('unit not confirmed');

    // The consequence, in words, and wired to the input so it is heard with
    // the field rather than having to be found.
    const input = screen.getByLabelText(labelPattern(field.label));
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');

    const noteTexts = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(noteTexts).toMatch(/cannot be checked against a limit/i);
  });

  it('does not mark a field whose unit is confirmed', () => {
    const values = defaultStageValues('conditioned');
    renderStage('conditioned', values);

    const water = STAGE_SCHEMAS.conditioned.fields.find(
      (field) => field.key === 'water_added_pct',
    );
    expect(water?.unitConfirmed).toBe(true);
    expect(labelTextFor(water as FieldDef)).not.toContain('unit not confirmed');
  });
});

describe('StageForm — empty submission (FR-008, NFR-004)', () => {
  it('surfaces an accessible error summary instead of doing nothing', async () => {
    const user = userEvent.setup();
    const stage: Stage = 'raw_materials';
    // Entirely blank: not even the seeded collection date and time, so this is
    // the "pressed Register on an untouched form" case.
    const values = emptyStageValues(stage);
    const { onSubmit } = renderStage(stage, values);

    const expectedMissing = fieldsRequiredAt(stage, 'registration', values);
    // Guard: if this were 0 the assertion below would be vacuous.
    expect(expectedMissing.length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /register sample/i }));

    // Nothing was submitted.
    expect(onSubmit).not.toHaveBeenCalled();

    // And the operator is told, in one place, how many things and which.
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent(
      new RegExp(`there (is|are) ${expectedMissing.length} thing`, 'i'),
    );
    expect(summary).toHaveTextContent(/nothing has been saved yet/i);

    for (const field of expectedMissing) {
      // `button`, not `link`. This assertion used to say `link`, which pinned
      // a defect as correct: the entries were anchors with a bare `#id` href,
      // and App.tsx states that "nothing in the app may link using a bare
      // `#id` fragment anchor, because that is a route change" — this app
      // routes with HashRouter, so the fragment is the address. A
      // `preventDefault()` masked it for a plain tap and not for a
      // long-press, middle-click or cmd-click, each of which navigated to a
      // nonexistent route and discarded the half-filled form.
      expect(
        within(summary).getByRole('button', { name: labelPattern(field.label) }),
        `"${field.label}" is missing from the error summary`,
      ).toBeInTheDocument();
    }

    // And the rule itself, so this cannot regress to an anchor silently.
    expect(
      within(summary).queryAllByRole('link'),
      'the summary must not use fragment anchors — HashRouter reads them as routes',
    ).toHaveLength(0);

    // Focus moved to the summary, so a screen-reader user is not left on a
    // button that appeared to do nothing.
    const heading = within(summary).getByRole('heading');
    expect(document.activeElement).toBe(heading);

    // A required measurement reports "not measured", never a 0 the operator
    // did not enter (build rule 8).
    const quantity = screen.getByLabelText(/quantity received/i);
    expect(quantity).toHaveValue('');
  });

  it('refuses malformed text in a draft but does not demand completeness', async () => {
    const user = userEvent.setup();
    const stage: Stage = 'raw_materials';
    const { onSaveDraft } = renderStage(stage, emptyStageValues(stage));

    // A draft may be incomplete (FR-005): a blank form saves.
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);

    // But text that could never be a measurement is refused rather than
    // stored to fail later.
    await user.type(screen.getByLabelText(/quantity received/i), 'abc');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent(/numbers only/i);
  });

  it('submits a complete registration, and reaches no network to do it', async () => {
    const user = userEvent.setup();
    const stage: Stage = 'raw_materials';
    const values = fillRegistrationFields(stage, emptyStageValues(stage));
    const { onSubmit } = renderStage(stage, values);

    await user.click(screen.getByRole('button', { name: /register sample/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0]?.[0] as StageFormSubmission;
    expect(submission.phase).toBe('registration');
    for (const field of fieldsRequiredAt(stage, 'registration', values)) {
      expect(Object.keys(submission.values), `"${field.key}" missing from payload`).toContain(
        field.key,
      );
    }
    // An untouched optional measurement is ABSENT, not zero.
    expect(Object.keys(submission.values)).not.toContain('other_mycotoxin_result');

    expect(fetchCalls).toBe(0);
  });
});
