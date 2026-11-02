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
    expect((last.children[0] as HTMLElement).className).toContain('col-span-2');
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
