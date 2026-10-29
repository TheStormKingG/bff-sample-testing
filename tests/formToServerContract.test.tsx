/**
 * The payload the FORM builds must be one the SERVER accepts.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * An operator typed `12` into Moisture and the server answered "Moisture must
 * be a number." Not a message bug: the two sides disagreed about the WIRE
 * SHAPE of every measurement.
 *
 *   client  src/forms/zodSchema.ts  numberFieldSchema emits
 *                                   { value: 12, enteredText: "12" }
 *   server  validation.ts           validateNumber accepts `number` or
 *                                   `string`, and its else-branch pushes
 *                                   `${label} must be a number.`
 *
 * So every numeric field, on all seven forms, was refused — sample
 * registration through the UI had never once accepted a measurement.
 *
 * Neither file was wrong on its own. `validation.ts` even RECONSTRUCTS the
 * pair itself (`typeof raw === 'string' ? { value, enteredText: raw.trim() }
 * : value`), which is the server saying plainly that it expects the
 * operator's text and does the parsing authoritatively — the right division
 * for a system whose rule is that the server re-validates everything. The
 * client was simply built to the other convention, and nothing compared them.
 *
 * ===========================================================================
 * THE FIFTH INSTANCE OF ONE FAILURE MODE
 * ===========================================================================
 * RPC names, module specifiers, column names, operation names — and now
 * payload shape. Each is a contract between components built in parallel,
 * each side internally consistent, with no test holding the two together. The
 * other four have gates. This is the one for the payload.
 *
 * ===========================================================================
 * WHY IT GOES THROUGH THE FORM AND NOT THROUGH A FIXTURE
 * ===========================================================================
 * This suite renders `StageForm`, fills it the way an operator does, presses
 * Register, and takes the payload from the `onSubmit` the component actually
 * calls. It does NOT hand-build a payload.
 *
 * That distinction is the whole point, and it is written here because the
 * mistake has already been made on this project: a live end-to-end run of all
 * seven stages passed, against the real server and the real spreadsheet,
 * while this bug was live — because the payloads for that run were
 * constructed by hand and therefore happened to be strings. The test skipped
 * the one component whose output was wrong. A payload a tester writes is
 * evidence about the tester's model; only a payload the form emits is
 * evidence about the form.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES, type FieldDef, type Stage } from '@/forms/types';
import { emptyStageValues } from '@/forms/defaults';
import {
  editableFields,
  parseStageValues,
  type StageFormValues,
} from '@/forms/zodSchema';
import { StageForm, type StageFormSubmission } from '@/components/form/StageForm';
import type { FormActionAvailability } from '@/components/form/saveState';

import { validateStagePayload } from '../supabase/functions/_shared/validation.ts';

const ALL_ACTIONS: FormActionAvailability = {
  canSaveDraft: true,
  canRegister: true,
  canSaveResults: false,
  canVoid: false,
};

/**
 * Well-formed text for a field, chosen only to be acceptable.
 *
 * CLEARLY-MARKED TEST-ONLY FIXTURE. None of these numbers is, or implies, an
 * acceptance limit — 0 of the 34 workbook `Limits` entries are approved, and
 * this file must never become the place one appears.
 */
function sampleText(field: FieldDef): string {
  switch (field.type) {
    case 'number':
      // A trailing zero on purpose: it is the thing the whole `enteredText`
      // design exists to protect, so it travels with every payload here.
      return '12.50';
    case 'date':
      return '2026-10-29';
    case 'time':
      return '08:00';
    case 'select':
    case 'yesno':
      return field.options?.[0]?.value ?? '';
    case 'text':
    case 'textarea':
      return 'test entry';
    default:
      return '';
  }
}

/** Every applicable field filled with acceptable text. */
function completedValues(stage: Stage): StageFormValues {
  const seed = emptyStageValues(stage);
  const values: StageFormValues = { ...seed };
  for (const field of editableFields(stage, seed)) {
    values[field.key] = sampleText(field);
  }
  // Applicability can change once a sampling point is chosen, so fill again
  // over the fields that only became relevant.
  for (const field of editableFields(stage, values)) {
    if ((values[field.key] ?? '') === '') values[field.key] = sampleText(field);
  }
  return values;
}

/**
 * Drive the real form to a submission.
 *
 * The values are seeded as `initialValues` and the operator action is the
 * Register press, because typing 98 fields across seven stages through
 * `userEvent` is minutes of wall-clock for no extra coverage: the payload is
 * built by the form's own resolver and `onValid` either way. What matters is
 * that the object under test is produced BY `StageForm`, not written here.
 */
async function submitThroughForm(stage: Stage): Promise<StageFormSubmission> {
  const user = userEvent.setup();
  const onSubmit = vi.fn();

  render(
    <StageForm
      stage={stage}
      phase="registration"
      initialValues={completedValues(stage)}
      actions={ALL_ACTIONS}
      saveState="editing"
      onSubmit={onSubmit}
      onSaveDraft={vi.fn()}
      onCancel={vi.fn()}
      onVoid={vi.fn()}
    />,
  );

  await user.click(screen.getByRole('button', { name: /register sample|save results/i }));

  // An implausible-value confirmation can stand between the press and the
  // submission. It is a question, not a refusal, so answer it.
  const confirm = screen.queryByRole('button', { name: /yes, that is what i measured|confirm/i });
  if (confirm !== null) await user.click(confirm);

  expect(
    onSubmit,
    `the ${stage} form refused its own completed values, so no payload exists to check`,
  ).toHaveBeenCalledTimes(1);

  return onSubmit.mock.calls[0]?.[0] as StageFormSubmission;
}

describe('every stage form emits a payload the server accepts', () => {
  for (const stage of STAGES) {
    it(`${stage}: the server raises no issue with what the form sent`, async () => {
      const submission = await submitThroughForm(stage);

      const verdict = validateStagePayload({
        stage,
        phase: 'registration',
        values: submission.values as Readonly<Record<string, unknown>>,
        confirmedImplausible: submission.confirmedImplausible,
      });

      // THE ASSERTION THAT FAILS AGAINST THE BROKEN CONTRACT. Before the fix
      // this reported one `not_a_number` per measurement — plus a `required`
      // for every required one — with the message the operator was shown:
      // "Moisture must be a number."
      if (!verdict.ok) {
        const detail = verdict.issues
          .map((issue) => `${issue.field} [${issue.code}] ${issue.message}`)
          .join('\n  ');
        expect.fail(
          `The ${stage} form built a payload its own server refuses:\n  ${detail}`,
        );
      }
      expect(verdict.ok).toBe(true);
    }, 20_000);
  }
});

describe('the operator\'s entered precision survives the whole journey', () => {
  it('keeps a trailing zero from the form all the way to the sheet row', async () => {
    // 12.50 is not 12.5: the trailing zero states the instrument's
    // resolution and is part of the quality record (PRD §6.1). It is the one
    // thing a shape change could quietly destroy, so it is asserted on the
    // SERVER's output rather than on the client's.
    const stage: Stage = 'raw_materials';
    const submission = await submitThroughForm(stage);
    const verdict = validateStagePayload({
      stage,
      phase: 'registration',
      values: submission.values as Readonly<Record<string, unknown>>,
      confirmedImplausible: submission.confirmedImplausible,
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const measurement = STAGE_SCHEMAS[stage].fields.find((f) => f.type === 'number');
    expect(measurement, 'this stage has no measurement, so the check is vacuous').toBeDefined();
    if (measurement === undefined) return;

    const stored = verdict.values[measurement.key];
    expect(stored).toBeDefined();
    const enteredText =
      typeof stored === 'object' && stored !== null && 'enteredText' in stored
        ? (stored as { enteredText: unknown }).enteredText
        : stored;
    expect(
      enteredText,
      'the trailing zero was normalised away, so the record no longer states the resolution',
    ).toBe('12.50');

    // And the Sheets row the server built carries the same text.
    expect(verdict.row.join('\u0001')).toContain('12.50');
  }, 20_000);
});

describe('the two sides accept the same numbers', () => {
  /**
   * A NAME contract is checked by comparing two literals. A SHAPE contract
   * cannot be: the client's commitment is a type and the server's is a set of
   * runtime `typeof` branches, so there is nothing to compare textually. What
   * has to hold is CONTAINMENT — every text the form accepts, the server
   * accepts — and the only way to establish it is to run both sides over the
   * same enumerated domain.
   *
   * This found a second live defect. The client's grammar was
   * `/^-?(?:\d+(?:\.\d*)?|\.\d+)$/` and the server's is `/^-?\d+(\.\d+)?$/`,
   * so `.5`, `12.`, `-.5` and `5.` passed the form and were refused by the
   * server — invisible while the client sent an object, and a live
   * "must be a number" the moment the text became what travels.
   */
  const DOMAIN = [
    '12', '12.5', '12.50', '0', '0.0', '-3', '-3.25', '000.5', '1000000',
    '.5', '12.', '-.5', '5.', '', ' ', '12 ', ' 12', '1e5', '0x10', '12abc',
    'abc', '-', '.', '--3', '12.5.6', '+12', 'Infinity', 'NaN', '１２',
  ];

  const stage: Stage = 'raw_materials';
  const measurement = STAGE_SCHEMAS[stage].fields.find((f) => f.type === 'number');

  it('accepts no text the server would refuse', () => {
    expect(measurement).toBeDefined();
    if (measurement === undefined) return;

    const divergent: string[] = [];
    for (const text of DOMAIN) {
      const parsed = parseStageValues(stage, 'draft', {
        ...emptyStageValues(stage),
        [measurement.key]: text,
      });
      if (!parsed.ok) continue; // the form refused it; nothing reaches the server
      // A blank box is "not measured", so the form legitimately omits the
      // key. The server then raises `required`, which is a requiredness
      // question and not a disagreement about what a number looks like.
      // Only a value the form actually PRODUCED can diverge.
      if (parsed.values[measurement.key] === undefined) continue;

      const verdict = validateStagePayload({
        stage,
        // 'registration', not 'draft': the server has no draft phase at all
        // (ValidationPhase is registration | testing | review), because a
        // draft never leaves the device. The client parse above uses 'draft'
        // so requiredness does not mask the grammar question being asked.
        phase: 'registration',
        values: parsed.values as Readonly<Record<string, unknown>>,
      });
      if (verdict.ok) continue;

      /**
       * `implausible_unconfirmed` is NOT a divergence. It is the soft typo
       * guard, and it is a QUESTION rather than a refusal: the form answers
       * it through `ImplausibleValueDialog` and resubmits with the key in
       * `confirmedImplausible`. Counting it here would report a designed
       * conversation as a broken contract.
       *
       * It is excluded by NAME, not by ignoring every failure, so a genuine
       * refusal of a form-accepted value still fails this test. Verified
       * against the live domain: `1000000` tonnes is the only member that
       * reaches it, and it reaches it for that reason.
       */
      const refusedThisField = verdict.issues.some(
        (issue) => issue.field === measurement.key && issue.code !== 'implausible_unconfirmed',
      );
      if (refusedThisField) {
        divergent.push(
          `${JSON.stringify(text)} — the form accepted it and the server ` +
            `refused it, so the operator sees a box with a number in it and ` +
            `the message "${measurement.label} must be a number."`,
        );
      }
    }

    expect(divergent).toEqual([]);
  });

  it('VACUITY CHECK: the domain actually exercises both outcomes', () => {
    // If the form refused everything, or accepted everything, the check above
    // would pass while comparing nothing.
    expect(measurement).toBeDefined();
    if (measurement === undefined) return;

    let accepted = 0;
    let refused = 0;
    for (const text of DOMAIN) {
      const parsed = parseStageValues(stage, 'draft', {
        ...emptyStageValues(stage),
        [measurement.key]: text,
      });
      if (parsed.ok && parsed.values[measurement.key] !== undefined) accepted += 1;
      else refused += 1;
    }
    expect(accepted, 'the form refused the entire domain').toBeGreaterThanOrEqual(6);
    expect(refused, 'the form accepted the entire domain').toBeGreaterThanOrEqual(6);
  });
});

describe('the gate itself is sound', () => {
  it('VACUITY CHECK: the forms really do carry measurements', () => {
    // Without this, a registry with no numeric fields would make every
    // assertion above pass while proving nothing at all.
    const counts = STAGES.map(
      (stage) => STAGE_SCHEMAS[stage].fields.filter((f) => f.type === 'number').length,
    );
    expect(counts.every((n) => n > 0), 'a stage has no measurement to check').toBe(true);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20);
  });

  it('POSITIVE CONTROL: the server still refuses a genuinely wrong shape', () => {
    // The check above is only meaningful if the server would have complained.
    // This feeds it the exact shape the client used to send and requires the
    // refusal — so if the server is ever loosened to accept anything at all,
    // this fails and says so.
    const stage: Stage = 'raw_materials';
    const measurement = STAGE_SCHEMAS[stage].fields.find((f) => f.type === 'number');
    expect(measurement).toBeDefined();
    if (measurement === undefined) return;

    const verdict = validateStagePayload({
      stage,
      phase: 'registration',
      values: { [measurement.key]: { value: 12, enteredText: '12' } },
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(
      verdict.issues.some(
        (issue) => issue.field === measurement.key && issue.code === 'not_a_number',
      ),
      'the server accepted the object shape, so this gate can no longer discriminate',
    ).toBe(true);
  });
});
