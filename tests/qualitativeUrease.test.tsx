/**
 * The urease test becomes a thing you look at, and one column leaves the tab.
 *
 * The claims worth holding, in the order they would hurt if they broke:
 *
 *  1. THE PHOTOGRAPHS ARE THE RIGHT WAY ROUND. This is the one failure that
 *     is invisible: the form still works, the record still saves, and a
 *     properly cooked batch is recorded as undercooked for as long as nobody
 *     checks. So the mapping is asserted against the MEASURED red content of
 *     the four files, which is the same evidence it was decided from.
 *
 *  2. A PICTURE CANNOT INTRODUCE A VALUE. The gallery is presentation. The
 *     option list is the contract, and it is still enforced by the browser
 *     schema, the Edge validator and `toSheetRow` — tested here one layer at
 *     a time, because a check that only exercises the client proves the
 *     client.
 *
 *  3. NOTHING RENDERS BLANK. Every offered option has a photograph and every
 *     photograph names an option, so a fifth code added without a file fails
 *     here rather than drawing an empty tile on a phone in the mill.
 *
 *  4. THE GRADE IS NOT A MEASUREMENT. No unit, no parameter key, no number.
 *     The pH-rise bands on the card belong to the OTHER method and are shown
 *     as orientation; storing one would be recording a reading nobody took.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ImageChoiceField } from '@/components/form/ImageChoiceField';
import { fieldIds } from '@/components/form/FieldShell';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES, type FieldDef } from '@/forms/types';
import { parseStageValues, editableFields } from '@/forms/zodSchema';
import { toSheetRow } from '@/forms/sheetMapping';
import { columnLetterToIndex } from '@/forms/columns';
import { validateStagePayload } from '../supabase/functions/_shared/validation.ts';
import { UREASE_DISH_EVIDENCE } from './support/ureaseEvidence';

const UREASE: FieldDef = (() => {
  const field = STAGE_SCHEMAS.extruded_soya.fields.find((f) => f.key === 'urease_qualitative');
  if (field === undefined) throw new Error('extruded_soya has no urease_qualitative');
  return field;
})();

const CODES = ['over_cooked', 'properly_cooked_slight', 'properly_cooked_moderate', 'under_cooked'];

/** A complete registration payload for this tab, so `draft` is not the only phase tested. */
const REGISTRATION = {
  collection_date: '2026-11-02',
  collection_time: '08:30',
  run_no: 'R-1',
  raw_soya_lot_no: 'LOT-1',
  sampled_by: 'Stefan',
  crusher_roller_gap_mm: '1.2',
  steam_line_pct: '40',
  steam_line_temperature_c: '95',
  extruder_temperature_c: '130',
  amount_ton_hr: '4',
};

// ---------------------------------------------------------------------------
// 1. The photographs
// ---------------------------------------------------------------------------

describe('the four reference dishes', () => {
  it('are ordered least red to most red, which is over cooked to under cooked', () => {
    /*
      THE CLAIM THAT MATTERS, AND WHY IT IS A SEAL RATHER THAN A MEASUREMENT.

      The four photographs arrived in an order, and the order they arrived
      in was the REVERSE of the assessments they belong to. Nothing about a
      filename, a position in an array or a comment would have caught that:
      every one of those is a restatement of the same assumption. What
      distinguishes the dishes is how much of each is strongly red, so that
      is what was measured — by `scripts/measure-urease-dishes.py`, which is
      what the mapping was decided from.

      This suite cannot re-run that. Decoding WebP needs an image library
      the repository does not have and does not otherwise need, and adding
      one so a single assertion can re-derive a constant would be a
      dependency the product never uses. So the measurement is sealed to the
      bytes it came from, and what is checked here is the seal: these are
      still the files that were measured. A photograph swapped, replaced or
      reordered fails loudly, instead of leaving the recorded evidence
      describing a file that is gone.

      Said plainly, because a test that overstates itself is worse than one
      that does less: this proves the evidence is about the shipped files,
      not that the evidence is right. `scripts/measure-urease-dishes.py` is
      what proves the second, and it refuses to print an evidence block for
      four dishes that are not in increasing order of redness.
    */
    const sealed = UREASE_DISH_EVIDENCE;
    expect(sealed.map((e) => e.image)).toEqual(
      (UREASE.optionGallery ?? []).map((e) => e.image),
    );

    for (const entry of sealed) {
      const bytes = readFileSync(join(process.cwd(), 'public', entry.image));
      expect(createHash('sha256').update(bytes).digest('hex'), entry.image).toBe(entry.sha256);
    }

    // And the sealed figures are what the mapping claims: strictly
    // increasing, over cooked to under cooked.
    const percents = sealed.map((e) => e.redPercent);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]!, `${sealed[i]!.image} is not redder than ${sealed[i - 1]!.image}`)
        .toBeGreaterThan(percents[i - 1]!);
    }
    // The ends are far apart, not merely sorted: an over-cooked dish has no
    // red at all and an under-cooked one is covered in it. Two nearly
    // identical photographs could satisfy the ordering above by noise.
    expect(percents[0]!).toBeLessThan(1);
    expect(percents[3]!).toBeGreaterThan(30);
  });

  it('are the order the options are declared in', () => {
    // The ordering above is a property of the FILES. This is the one that
    // ties it to the assessments: swapping two entries' `value` fields would
    // leave every photograph in place and every file measurement unchanged.
    expect((UREASE.optionGallery ?? []).map((e) => e.value)).toEqual(CODES);
    expect((UREASE.options ?? []).map((o) => o.value)).toEqual(CODES);
  });

  it('exist, and every offered option has one', () => {
    const offered = (UREASE.options ?? []).filter((o) => o.retired !== true).map((o) => o.value);
    const pictured = (UREASE.optionGallery ?? []).map((e) => e.value);
    expect(pictured).toEqual(offered);
    for (const entry of UREASE.optionGallery ?? []) {
      // Not an absolute path: the app is served from a sub-path, and a
      // leading slash would 404 in production while passing every test that
      // only looked at the string.
      expect(entry.image.startsWith('/'), entry.image).toBe(false);
      expect(existsSync(join(process.cwd(), 'public', entry.image)), entry.image).toBe(true);
      expect(entry.imageAlt.length).toBeGreaterThan(10);
      expect(entry.observation.length).toBeGreaterThan(0);
      expect(entry.reference).toMatch(/pH rise/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. It is a grade, not a reading
// ---------------------------------------------------------------------------

describe('the field itself', () => {
  it('is a select with no unit, no bounds and no parameter key', () => {
    expect(UREASE.type).toBe('select');
    expect(UREASE.columnLetter).toBe('M');
    expect(UREASE.sheetHeader).toBe('Qualitative urease');
    expect(UREASE.required).toBe('testing');
    // A visual grade cannot be assessed against a numeric acceptance limit.
    // `extruded_soya.urease` still carries a draft 0.05-0.20 band, and a
    // link to it here would make the engine return `not_assessable` forever
    // on a screen that reads as a broken rule rather than a deliberate gap.
    expect(UREASE.parameterKey).toBeUndefined();
    expect(UREASE.unit).toBeUndefined();
    expect(UREASE.min).toBeUndefined();
    expect(UREASE.decimals).toBeUndefined();
  });

  it('reads the reference bands as the other method’s figures, not as this one’s', () => {
    // Printed beside the photograph, never stored. If one of these ever
    // became a `defaultValue` or a `min`, the record would start carrying a
    // number the operator never measured.
    expect(UREASE.optionGallery?.map((e) => e.reference)).toEqual([
      'pH rise about 0.00',
      'pH rise about 0.05 to 0.10',
      'pH rise about 0.10 to 0.20',
      'pH rise above 0.20',
    ]);
  });
});

describe('what left the tab', () => {
  it('has no protein solubility column anywhere, and no pH-rise number', () => {
    for (const stage of STAGES) {
      const keys = STAGE_SCHEMAS[stage].fields.map((f) => f.key);
      expect(keys, stage).not.toContain('protein_solubility_pct');
      expect(keys, stage).not.toContain('urease_ph_rise');
    }
    // And the schema agrees, which is the half that decides what a payload
    // may carry. A registry entry removed without the schema following would
    // leave the field submittable and invisible.
    const keys = editableFields('extruded_soya', REGISTRATION).map((f) => f.key);
    expect(keys).not.toContain('protein_solubility_pct');
    expect(keys).toContain('urease_qualitative');
  });

  it('is one column narrower, and the follow-up pair moved left', () => {
    expect(STAGE_SCHEMAS.extruded_soya.columnCount).toBe(15);
    expect(STAGE_SCHEMAS.extruded_soya.lastColumn).toBe('O');
    const letter = (key: string): string | undefined =>
      STAGE_SCHEMAS.extruded_soya.fields.find((f) => f.key === key)?.columnLetter;
    expect(letter('tested_by_qo')).toBe('N');
    expect(letter('comments')).toBe('O');
  });
});

// ---------------------------------------------------------------------------
// 3. The option list is still the contract, on all three layers
// ---------------------------------------------------------------------------

describe('the four codes are enforced, and not only in the browser', () => {
  it.each(CODES)('the browser schema accepts %s', (code) => {
    const result = parseStageValues('extruded_soya', 'registration', {
      ...REGISTRATION,
      urease_qualitative: code,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.values['urease_qualitative']).toBe(code);
  });

  it('the browser schema refuses a code that is not on the card', () => {
    const result = parseStageValues('extruded_soya', 'registration', {
      ...REGISTRATION,
      urease_qualitative: 'burnt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors['urease_qualitative']).toBeDefined();
  });

  it('the SERVER refuses it too, which is the layer that matters', () => {
    // Reverting `validateStagePayload` to trust the client would leave every
    // assertion above green. This is the one that notices.
    const refused = validateStagePayload({
      stage: 'extruded_soya',
      phase: 'registration',
      values: { ...REGISTRATION, urease_qualitative: 'burnt' },
    });
    // The REASON, not just the refusal. `ok: false` would also be satisfied
    // by a payload that happened to be missing a required field, which is a
    // green test for a validator that never looked at the option list at
    // all — exactly the regression this exists to catch.
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.issues).toEqual([
        {
          field: 'urease_qualitative',
          code: 'unknown_option',
          message:
            'Qualitative urease must be one of: over_cooked, properly_cooked_slight, ' +
            'properly_cooked_moderate, under_cooked.',
        },
      ]);
    }

    const accepted = validateStagePayload({
      stage: 'extruded_soya',
      phase: 'registration',
      values: { ...REGISTRATION, urease_qualitative: 'under_cooked' },
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  });

  it('the sheet receives the assessment in words, and the code stays in the database', () => {
    const row = toSheetRow('extruded_soya', 'ES-261102-01', {
      urease_qualitative: 'properly_cooked_moderate',
    });
    expect(row[columnLetterToIndex('M')]).toBe('Properly cooked (moderately active)');
    // The column after it is now `Tested by (QO)`, not protein solubility.
    expect(() =>
      toSheetRow('extruded_soya', 'ES-261102-01', { urease_qualitative: 'burnt' }),
    ).toThrow(/unknown code/i);
  });
});

// ---------------------------------------------------------------------------
// 4. What the operator sees
// ---------------------------------------------------------------------------

describe('the control on the screen', () => {
  function renderField(currentValue = ''): void {
    render(
      <ImageChoiceField
        field={UREASE}
        ids={fieldIds('es', UREASE.key)}
        required={true}
        error={undefined}
        control={{ name: UREASE.key, onChange: async () => true, onBlur: async () => true, ref: () => {} }}
        disabled={false}
        currentValue={currentValue}
      />,
    );
  }

  it('offers four radio buttons carrying the codes, not the labels', () => {
    renderField();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(CODES);
  });

  it('describes each photograph by what it SHOWS, so the answer survives without it', () => {
    renderField();
    for (const entry of UREASE.optionGallery ?? []) {
      const image = screen.getByAltText(entry.imageAlt);
      // The alt text is the observation, never the object. "A petri dish"
      // four times over is alt text that technically exists and tells a
      // screen-reader user nothing they can choose between.
      expect(entry.imageAlt.toLowerCase()).not.toContain('petri dish');
      expect(image.getAttribute('src')).toContain(entry.image);
      // And the same observation is on the screen as text, for a reader on a
      // connection that dropped the images.
      expect(screen.getByText(entry.observation)).toBeTruthy();
    }
  });

  it('marks the held answer and only the held answer', () => {
    renderField('under_cooked');
    const ticks = screen.getAllByText('✓');
    expect(ticks).toHaveLength(1);
  });
});
