/**
 * Sample details, two fields to a line.
 *
 * The pairing is positional and stage-agnostic: fields arrive in registry
 * order and are taken two at a time. That is the whole design — a stage that
 * gains or loses a sample-details column re-pairs itself — so the tests below
 * assert the RULE against the real registry rather than a hand-written layout
 * per stage, which would only ever re-state the fixture.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PairedFields } from '@/components/form/PairedFields';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES } from '@/forms/types';
import type { FieldDef } from '@/forms/types';

/** The fields `StageForm` hands to `PairedFields` for a stage. */
function sampleDetailsOf(stage: (typeof STAGES)[number]): readonly FieldDef[] {
  // `FieldRenderer` returns null for a `system` field, so column A is present
  // in the registry but never becomes a cell. The counts below are the fields
  // an operator actually sees.
  return STAGE_SCHEMAS[stage].fields.filter(
    (field) => field.section === 'sample_details' && field.type !== 'system',
  );
}

function renderFields(fields: readonly FieldDef[]): HTMLElement {
  const { container } = render(
    <PairedFields fields={fields} renderField={(field) => <span>{field.label}</span>} />,
  );
  return container;
}

/** The row elements: the direct children of the render container. */
function rowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children) as HTMLElement[];
}

describe('sample details, two fields to a line', () => {
  it('puts every stage at two per row, in registry order', () => {
    for (const stage of STAGES) {
      const fields = sampleDetailsOf(stage);
      const container = renderFields(fields);
      const rows = rowsOf(container);

      expect(rows.length, `${stage} row count`).toBe(Math.ceil(fields.length / 2));

      // Flattening the rows must give back the registry order unchanged: the
      // operator reads the form in the order the row will be written to the
      // sheet, and a re-ordering here would silently break that.
      const flattened = rows.flatMap((row) =>
        Array.from(row.querySelectorAll('span')).map((cell) => cell.textContent),
      );
      expect(flattened, `${stage} order`).toEqual(fields.map((field) => field.label));

      for (const row of rows.slice(0, -1)) {
        expect(row.children.length, `${stage} full row`).toBe(2);
      }
    }
  });

  it('gives Ground the three rows the layout was asked for', () => {
    // The stage the request was made against, asserted by name rather than by
    // rule, so a registry change that happens to keep the pairing valid while
    // changing WHICH fields pair is still visible here.
    const rows = rowsOf(renderFields(sampleDetailsOf('ground')));
    expect(
      rows.map((row) => Array.from(row.querySelectorAll('span')).map((c) => c.textContent)),
    ).toEqual([
      ['Date', 'Time'],
      ['Sampling point', 'Material or feed type'],
      ['Batch or bin no.', 'Sampled by'],
    ]);
  });

  it('gives a lone trailing field the whole line rather than half of it', () => {
    // Five of the eight tabs have an odd number of sample-details columns, so
    // this is the normal case and not an edge one. A half-width control with
    // nothing beside it reads as a column that failed to render.
    const fields = sampleDetailsOf('mash');
    expect(fields.length % 2, 'mash is the odd-count case').toBe(1);

    const rows = rowsOf(renderFields(fields));
    const last = rows[rows.length - 1]!;
    expect(last.children.length).toBe(1);
    // Spans both columns only where there ARE two columns.
    expect((last.children[0] as HTMLElement).className).toContain('min-[375px]:col-span-2');
  });

  it('leaves the cells of a full row at half width', () => {
    const rows = rowsOf(renderFields(sampleDetailsOf('ground')));
    for (const row of rows) {
      for (const cell of Array.from(row.children) as HTMLElement[]) {
        expect(cell.className).not.toContain('col-span-2');
      }
    }
  });

  it('renders nothing at all for a stage with no sample details', () => {
    const { container } = render(<PairedFields fields={[]} renderField={() => <span />} />);
    expect(container.innerHTML).toBe('');
  });

  it('keeps every field a renderer output, never a hand-rolled input', () => {
    // Five separate mechanisms find fields by registry key — the error
    // summary, server-issue routing, per-section error counts, `revealField`'s
    // focus move and applicability clearing. `PairedFields` arranges whatever
    // `renderField` returns and never substitutes its own control, so all five
    // keep working. This asserts the component adds no inputs of its own.
    const container = renderFields(sampleDetailsOf('raw_materials'));
    expect(container.querySelectorAll('input, select, textarea').length).toBe(0);
    expect(screen.getAllByText('Sampled by').length).toBe(1);
  });
});

describe('help text in the two-column layout', () => {
  /**
   * MEASURED, NOT GUESSED. The binding width is 375px, the narrowest screen
   * that still gets two columns: a cell there is ~131px and the help renders
   * at ~18 characters per line, so two lines is about 36 characters.
   * Confirmed against the running app at 375 and 390 — every string below the
   * cap rendered on two lines, and "The date the sample was taken, in Guyana
   * local time." (52 characters) wrapped to THREE and left a 220px dead zone
   * beside "Material or feed type", which has no help at all.
   *
   * The cap is on the SOURCE STRING rather than on the rendered height,
   * because a rendered-height assertion needs a real browser and this suite
   * has jsdom, which reports every element as zero-sized. `e2e` measures the
   * real thing; this stops a long string being committed in the first place.
   */
  const TWO_LINE_LIMIT = 36;

  it('keeps every sample-details hint inside two lines', () => {
    const tooLong: string[] = [];
    for (const stage of STAGES) {
      for (const field of STAGE_SCHEMAS[stage].fields) {
        // `system` fields never render an input, so their help never shows.
        if (field.section !== 'sample_details' || field.type === 'system') continue;
        if (field.help === undefined) continue;
        if (field.help.length > TWO_LINE_LIMIT) {
          tooLong.push(`${stage}.${field.key} (${field.help.length}): ${field.help}`);
        }
      }
    }
    expect(tooLong, 'sample-details help longer than two lines at 375px').toEqual([]);
  });

  it('INSTRUMENT CHECK: the rule would catch a long string', () => {
    // Without this, a rule that silently stopped reading the registry would
    // report the same clean result as a rule that worked.
    const sampled = STAGE_SCHEMAS.ground.fields.filter(
      (f) => f.section === 'sample_details' && f.type !== 'system' && f.help !== undefined,
    );
    expect(sampled.length, 'the sweep found no help to check').toBeGreaterThan(2);
    expect('The date the sample was taken, in Guyana local time.'.length).toBeGreaterThan(
      TWO_LINE_LIMIT,
    );
  });

  it('leaves the test-results hints alone', () => {
    // The cap applies ONLY to the band that goes two to a line. A measurement
    // gets the full width of the screen, and its help explains what GSD or
    // urease mean to an operator who may never have met the word — that is
    // exactly the text this project refuses to hide or abbreviate.
    const longOnes = STAGE_SCHEMAS.raw_materials.fields.filter(
      (f) => f.section === 'test_results' && (f.help?.length ?? 0) > TWO_LINE_LIMIT,
    );
    expect(longOnes.length).toBeGreaterThan(0);
  });
});
