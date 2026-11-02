/**
 * Three free-text fields become lists, one dropdown with one answer leaves
 * the form, and the gap between pressing Register and seeing a record stops
 * being a blank screen.
 *
 * The claims worth holding, in the order they would hurt if they broke:
 *
 *  1. NO STORED VALUE BECOMES UNWRITABLE. `encodeEnum` throws on a code it
 *     does not know, so putting a list on a field that was free text could
 *     have made eight live records impossible to project to the spreadsheet
 *     for the rest of time. Every value the database held on 2026-11-02 is
 *     still a legal code.
 *
 *  2. A RETIRED VALUE IS SHOWN WHERE IT IS HELD AND NOWHERE ELSE. An empty
 *     dropdown over a record that does hold an answer is how a value nobody
 *     observed replaces one somebody did.
 *
 *  3. HIDDEN IS NOT DELETED. The sieve series keeps its column, its code and
 *     its sheet cell; it only stops being asked for.
 *
 *  4. THE PROGRESS BAR NEVER CLAIMS A NUMBER. There is one request and the
 *     browser cannot see inside it.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RegisterProgress } from '@/components/form/RegisterProgress';
import { SelectField } from '@/components/form/SelectField';
import { fieldIds } from '@/components/form/FieldShell';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES, type FieldDef, type Stage } from '@/forms/types';
import { parseStageValues, editableFields } from '@/forms/zodSchema';
import { resolveOptions } from '@/lib/vocabulary';
import { toSheetRow } from '@/forms/sheetMapping';
import { validateStagePayload } from '../supabase/functions/_shared/validation.ts';
import { defaultStageValues } from '@/forms/defaults';

function fieldOn(stage: Stage, key: string): FieldDef {
  const field = STAGE_SCHEMAS[stage].fields.find((f) => f.key === key);
  if (field === undefined) throw new Error(`${stage} has no ${key}`);
  return field;
}

function stagesWith(key: string): readonly Stage[] {
  return STAGES.filter((s) => STAGE_SCHEMAS[s].fields.some((f) => f.key === key));
}

// ---------------------------------------------------------------------------
// The lists themselves
// ---------------------------------------------------------------------------

describe('the three fields that became lists', () => {
  it('are a list on every tab that carries them, not just the one that was checked', () => {
    // The defect this prevents is a half-applied change: `feed_type` a list
    // on Pellets and still free text on Mash, which nobody would notice
    // until a Mash record held a typo.
    expect(stagesWith('feed_type')).toHaveLength(5);
    expect(stagesWith('sampled_by')).toHaveLength(8);
    expect(stagesWith('tested_by_qo')).toHaveLength(8);
    for (const key of ['feed_type', 'sampled_by', 'tested_by_qo']) {
      for (const stage of stagesWith(key)) {
        const field = fieldOn(stage, key);
        expect(field.type, `${stage}.${key}`).toBe('select');
        expect((field.options ?? []).length, `${stage}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('offers exactly the people and feeds that were asked for', () => {
    const offered = (stage: Stage, key: string): string[] =>
      (fieldOn(stage, key).options ?? [])
        .filter((o) => o.retired !== true)
        .map((o) => o.value);

    expect(offered('mash', 'feed_type')).toEqual([
      'Pre-starter',
      'Starter',
      'Grower',
      'Finisher',
    ]);
    expect(offered('mash', 'sampled_by')).toEqual(['Stefan', 'Satesh', 'Kayla']);
    expect(offered('mash', 'tested_by_qo')).toEqual(['Stefan', 'Kayla']);
  });

  it('spells the code and the label the same, so no stored row has to be rewritten', () => {
    // Every other select in the registry stores a code and writes a label.
    // These three store what they display, which is the entire reason the
    // existing rows — typed as `Grower`, `Stefan`, `Kayla` — are already
    // valid against the new lists.
    for (const key of ['feed_type', 'sampled_by', 'tested_by_qo']) {
      for (const option of fieldOn('mash', key).options ?? []) {
        expect(option.value, `${key}`).toBe(option.label);
      }
    }
  });
});

describe('values recorded before the list existed', () => {
  /**
   * A snapshot of what `sample_measurements` held on 2026-11-02, taken from
   * the live database. Written out here rather than derived, because the
   * point of the assertion is that THESE PARTICULAR STRINGS still work — a
   * list that generated its own test data would pass while the records it
   * was supposed to protect could no longer be written.
   */
  const RECORDED: readonly (readonly [Stage, string, string])[] = [
    ['dgm', 'feed_type', 'Crumble'],
    ['dgm', 'feed_type', 'Pellet'],
    ['dgm', 'feed_type', 'Pellets'],
    ['dgm', 'feed_type', 'Grower'],
    ['crumble', 'feed_type', 'TEST BROILER STARTER CRUMBLE (E2E)'],
    ['mash', 'feed_type', 'TEST LAYER MASH (E2E)'],
    ['pellets', 'feed_type', 'Broiler Starter (TEST)'],
    ['conditioned', 'feed_type', 'TEST Broiler Starter'],
    ['dgm', 'sampled_by', 'Stefan'],
    ['dgm', 'sampled_by', 'Kayla'],
    ['raw_materials', 'sampled_by', 'TEST E2E (do not action)'],
    ['raw_materials', 'sampled_by', 'Autosync Check'],
    ['raw_materials', 'sampled_by', 'Live Form Check'],
    ['ground', 'sampled_by', 'TEST OPERATOR'],
    ['ground', 'sampled_by', 'TEST Quality Officer'],
    ['ground', 'sampled_by', 'TEST Quality Manager'],
    ['ground', 'sampled_by', 'Test Account (BFF QA)'],
    ['dgm', 'tested_by_qo', 'Stefan'],
    ['dgm', 'tested_by_qo', 'Kayla'],
  ];

  it.each(RECORDED)('%s.%s = "%s" is still a legal code', (stage, key, value) => {
    const codes = (fieldOn(stage, key).options ?? []).map((o) => o.value);
    expect(codes).toContain(value);
  });

  it('can still be written to the spreadsheet, which is the hazard', () => {
    // `encodeEnum` THROWS on an unknown code. Membership in the list above is
    // the premise; this is the consequence, exercised through the real
    // encoder rather than assumed to follow.
    const field = fieldOn('dgm', 'feed_type');
    const index = STAGE_SCHEMAS.dgm.fields.indexOf(field);
    const row = toSheetRow('dgm', 'DG-261102-09', { feed_type: 'Crumble' });
    expect(row[index]).toBe('Crumble');
  });

  it('CONTROL: a value that was never recorded is still refused', () => {
    // Without this the test above would pass against a list that simply
    // allowed everything.
    expect(() => toSheetRow('dgm', 'DG-261102-09', { feed_type: 'Layer mash' })).toThrow(
      /unknown code/i,
    );
  });
});

// ---------------------------------------------------------------------------
// What the dropdown shows
// ---------------------------------------------------------------------------

describe('the dropdown', () => {
  function show(value: string) {
    return render(
      <SelectField
        field={fieldOn('dgm', 'feed_type')}
        ids={fieldIds('t', 'feed_type')}
        required
        error={undefined}
        disabled={false}
        currentValue={value}
        control={{
          name: 'feed_type',
          onChange: async () => {},
          onBlur: async () => {},
          ref: () => {},
        }}
      />,
    );
  }

  it('does not offer a retired value on a fresh record', () => {
    show('');
    expect(screen.getByRole('option', { name: 'Starter' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Crumble/ })).toBeNull();
  });

  it('shows it, named, on the record that holds it', () => {
    // THE ASSERTION THAT MATTERS. Without it the control renders "Choose…"
    // over a record that has an answer, and the operator picks something —
    // replacing an observation with a guess.
    show('Crumble');
    expect(screen.getByRole('option', { name: 'Crumble (no longer offered)' }))
      .toBeInTheDocument();

    // The whole option list, so "it appears" cannot be satisfied by a
    // control that simply stopped filtering. Deliberately NOT asserting that
    // the option is `selected`: these inputs are uncontrolled and react-hook-
    // form's ref sets the DOM value, so a `selected` assertion here would be
    // testing this file's stub rather than the component.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose…',
      'Pre-starter',
      'Starter',
      'Grower',
      'Finisher',
      'Crumble (no longer offered)',
    ]);
  });

  it('still does not offer the OTHER retired values on that record', () => {
    show('Crumble');
    expect(screen.queryByRole('option', { name: /^Pellets/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The field that left the form without leaving the record
// ---------------------------------------------------------------------------

describe('the sieve series', () => {
  const SIEVE_STAGES = stagesWith('sieve_series');

  it('is on the five tabs that weigh a stack', () => {
    expect([...SIEVE_STAGES]).toEqual(['ground', 'pellets', 'crumble', 'mash', 'dgm']);
  });

  it.each(SIEVE_STAGES)('%s: is hidden, but still a column with a code and a default', (stage) => {
    const field = fieldOn(stage, 'sieve_series');
    expect(field.hidden).toBe(true);
    // Hidden with no default would be a field nothing can ever fill.
    expect(field.defaultValue).toBe('abnt-standard-7');
    expect((field.options ?? []).map((o) => o.value)).toContain(field.defaultValue);
    // Still a real column: deleting it would make "which stack was this
    // weighed on" unanswerable the day a second series exists.
    expect(field.columnLetter).toMatch(/^[A-Z]+$/);
    expect(field.sheetHeader).toBe('Sieve series');
  });

  it.each(SIEVE_STAGES)('%s: a new form carries it without asking', (stage) => {
    expect(defaultStageValues(stage)['sieve_series']).toBe('abnt-standard-7');
  });

  it('is still submitted and still validated — hidden is not dropped', () => {
    // The distinction the implementation turns on: `editableFields` keeps it
    // (so it is validated and sent), and only the render layer filters it.
    const keys = editableFields('dgm', defaultStageValues('dgm')).map((f) => f.key);
    expect(keys).toContain('sieve_series');

    const bad = parseStageValues('dgm', 'registration', {
      ...defaultStageValues('dgm'),
      sieve_series: 'not-a-stack',
    });
    expect(bad.ok).toBe(false);
  });

  it('still writes its label to the sheet cell, exactly as before', () => {
    const field = fieldOn('dgm', 'sieve_series');
    const index = STAGE_SCHEMAS.dgm.fields.indexOf(field);
    const row = toSheetRow('dgm', 'DG-261102-09', { sieve_series: 'abnt-standard-7' });
    expect(row[index]).toBe('ABNT 5 / 10 / 16 / 30 / 50 / 400 / Fundo');
  });
});

// ---------------------------------------------------------------------------
// The wait
// ---------------------------------------------------------------------------

describe('the screen between Register and the record', () => {
  it('says what is happening and tells the operator not to press again', () => {
    render(<RegisterProgress label="Recording the ground sample" />);
    expect(screen.getByText('Recording the ground sample')).toBeInTheDocument();
    expect(screen.getByText(/Do not press Register again/)).toBeInTheDocument();
  });

  it('announces itself as busy, not as a problem', () => {
    render(<RegisterProgress />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never puts a number on the bar', () => {
    /*
      THE RULE THIS FILE EXISTS TO HOLD. There is one request and the browser
      cannot see inside it, so any percentage would be invented — on the
      screen of a quality system, which is the one place a made-up figure
      must never appear. No digits, and no `progressbar` role, because that
      role invites `aria-valuenow`.
    */
    const { container } = render(<RegisterProgress initialProgress={0.5} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });

  it('draws a bar that has not reached the end', () => {
    const { container } = render(<RegisterProgress initialProgress={0.5} />);
    const fill = container.querySelector('.bg-blue-700') as HTMLElement | null;
    expect(fill).not.toBeNull();
    const width = Number.parseFloat((fill?.style.width ?? '0').replace('%', ''));
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100);
  });

  it('covers the form, so a second press cannot reach it', () => {
    const { container } = render(<RegisterProgress />);
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className).toContain('fixed');
    expect(overlay.className).toContain('inset-0');
  });
});

// ---------------------------------------------------------------------------
// The administrator's lists
// ---------------------------------------------------------------------------

describe('a list an administrator owns', () => {
  const field = fieldOn('mash', 'feed_type');

  it('is declared on exactly the three fields that were asked for', () => {
    const tagged = STAGES.flatMap((s) =>
      STAGE_SCHEMAS[s].fields
        .filter((f) => f.optionsListKey !== undefined)
        .map((f) => `${f.key}:${f.optionsListKey}`),
    );
    expect(new Set(tagged)).toEqual(
      new Set(['feed_type:feed_types', 'sampled_by:samplers', 'tested_by_qo:testers']),
    );
  });

  it('leaves the code-driven selects alone, and sampling_point above all', () => {
    // Its codes drive the sample-ID PREFIX and the BC-only moisture rule, so
    // a code an administrator invented would have no prefix and no rule.
    expect(fieldOn('ground', 'sampling_point').optionsListKey).toBeUndefined();
    expect(fieldOn('ground', 'mill_screen_size_mm').optionsListKey).toBeUndefined();
    expect(fieldOn('ground', 'sieve_series').optionsListKey).toBeUndefined();
  });

  it('uses the stored list when there is one', () => {
    const resolved = resolveOptions(field, {
      feed_types: [
        { code: 'Layer', label: 'Layer', active: true, sortOrder: 10 },
        { code: 'Broiler', label: 'Broiler', active: true, sortOrder: 5 },
      ],
    });
    // Sorted by the administrator's own order, not by arrival...
    expect(resolved.filter((o) => o.retired !== true).map((o) => o.value)).toEqual([
      'Broiler',
      'Layer',
    ]);
    // ...and the shipped values the table does not have are still there,
    // retired, so the records holding them stay writable. See the net below.
    expect(resolved.find((o) => o.value === 'Starter')?.retired).toBe(true);
  });

  it('carries an inactive row through as retired, not as absent', () => {
    // Retiring is a toggle on the admin screen. An inactive value must stay
    // ENCODABLE — records hold it — while leaving the dropdown.
    const resolved = resolveOptions(field, {
      feed_types: [
        { code: 'Starter', label: 'Starter', active: true, sortOrder: 10 },
        { code: 'Crumble', label: 'Crumble', active: false, sortOrder: 900 },
      ],
    });
    expect(resolved.find((o) => o.value === 'Crumble')?.retired).toBe(true);
    expect(resolved.find((o) => o.value === 'Starter')?.retired).toBeUndefined();
  });

  it('falls back to the shipped list when the table is empty or unread', () => {
    /*
      THE ASSERTION THAT KEEPS THE PLANT WORKING. An empty list on a REQUIRED
      field is a form nobody can submit, so a configuration fault would stop
      samples being recorded. Empty and absent must both mean "use the list
      the application was tested with".
    */
    for (const [name, vocab] of [
      ['no document', null],
      ['no entry for this list', {}],
      ['an empty table', { feed_types: [] }],
    ] as const) {
      const resolved = resolveOptions(field, vocab);
      /*
        THE WHOLE OPTION, not just its code. Comparing values alone was not
        enough and a deliberate control proved it: remove the `length === 0`
        arm and an empty table still returns every shipped value — as
        RETIRED, through the net below — so the codes matched while the
        dropdown would have offered nothing at all, leaving a required field
        unfillable with no visible cause.

        Deep equality against the shipped list is the precise statement: the
        same values AND the same retirement, which is what "fall back to the
        list the application was tested with" actually means.
      */
      expect(resolved, name).toEqual(field.options);
      expect(resolved.filter((o) => o.retired !== true).length, name).toBeGreaterThan(0);
    }
  });

  it('keeps a shipped value the table has lost, retired', () => {
    // The net under a row being deleted straight out of the database, which
    // the admin screen does not offer but psql does. Those records must stay
    // writable.
    const resolved = resolveOptions(field, {
      feed_types: [{ code: 'Starter', label: 'Starter', active: true, sortOrder: 10 }],
    });
    expect(resolved.find((o) => o.value === 'Crumble')?.retired).toBe(true);
  });

  it('validates and encodes against the stored list, not the shipped one', () => {
    /*
      The whole point of reading the lists on BOTH sides. A value an
      administrator added must pass validation and reach the sheet; without
      the vocabulary threaded through, each of these would refuse it.
    */
    const vocabulary = {
      samplers: [{ code: 'Anita', label: 'Anita', active: true, sortOrder: 10 }],
    };
    const values = { ...defaultStageValues('mash'), sampled_by: 'Anita' };
    expect(parseStageValues('mash', 'draft', values, vocabulary).ok).toBe(true);
    // CONTROL: the same value without the list is refused, which is what the
    // server would have done to the operator's own choice.
    expect(parseStageValues('mash', 'draft', values).ok).toBe(false);

    const index = STAGE_SCHEMAS.mash.fields.findIndex((f) => f.key === 'sampled_by');
    expect(toSheetRow('mash', 'MS-1', { sampled_by: 'Anita' }, vocabulary)[index]).toBe('Anita');
    expect(() => toSheetRow('mash', 'MS-1', { sampled_by: 'Anita' })).toThrow(/unknown code/i);
  });

  it('is enforced by the SERVER against the stored list too', () => {
    /*
      The gate that actually decides. `parseStageValues` above runs in the
      browser and is not a control; `validateStagePayload` is the one the
      Edge Function calls, and a deliberate control proved this needed its
      own test — reverting the server to `field.options` left every
      assertion in this file green while the server refused exactly the
      values an administrator had just added.
    */
    const vocabulary = {
      samplers: [{ code: 'Anita', label: 'Anita', active: true, sortOrder: 10 }],
    };
    // `raw_materials`, not a sieve tab: those carry a derivation-completeness
    // rule that would refuse this payload for an unrelated reason and make
    // the test pass for the wrong one.
    const values = { sampled_by: 'Anita' };

    // `review`, the one server phase that requires nothing: this test is
    // about whether the CODE is accepted, and a phase that also demands
    // other fields would fail for a reason that has nothing to do with it.
    const withList = validateStagePayload({
      stage: 'raw_materials',
      phase: 'review',
      values,
      vocabulary,
    });
    expect(
      withList.ok ? [] : withList.issues.filter((i) => i.field === 'sampled_by'),
      'the administrator\u2019s own value was refused',
    ).toEqual([]);

    const without = validateStagePayload({ stage: 'raw_materials', phase: 'review', values });
    expect(without.ok).toBe(false);
    if (without.ok) return;
    expect(without.issues.some((i) => i.field === 'sampled_by')).toBe(true);
  });
});

describe('the action-taken box', () => {
  it('is gone from all three forms that had it, and its column is not', () => {
    const stages = STAGES.filter((s) =>
      STAGE_SCHEMAS[s].fields.some((f) => f.key === 'action_taken'),
    );
    expect([...stages]).toEqual(['ground', 'conditioned', 'pellets']);
    for (const stage of stages) {
      const field = fieldOn(stage, 'action_taken');
      expect(field.hidden, stage).toBe(true);
      // Hidden is not deleted: the column, its heading and its place in the
      // row are untouched, so no workbook tab has to be restructured.
      expect(field.columnLetter, stage).toMatch(/^[A-Z]+$/);
      expect(field.sheetHeader, stage).toBe('Action taken');
      // Satisfiable without the operator, which is what makes hiding it safe.
      expect(field.required, stage).toBe('optional');
    }
  });

  it('no longer claims a hold requires it, because nothing ever enforced that', () => {
    expect(fieldOn('ground', 'action_taken').help).toBeUndefined();
  });
});

describe('every hidden field can be satisfied without the operator', () => {
  it.each(STAGES)('%s', (stage) => {
    // The rule `FieldDef.hidden` states. A hidden field that is required and
    // has no default is a form that can never be submitted, and nothing on
    // the screen would say why.
    for (const field of STAGE_SCHEMAS[stage].fields.filter((f) => f.hidden === true)) {
      const satisfiable = field.required === 'optional' || field.defaultValue !== undefined;
      expect(satisfiable, `${stage}.${field.key}`).toBe(true);
      if (field.defaultValue !== undefined && field.options !== undefined) {
        expect(field.options.map((o) => o.value)).toContain(field.defaultValue);
      }
    }
  });
});
