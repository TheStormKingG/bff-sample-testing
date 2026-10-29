/**
 * Google Sheets mapping contract tests — written before the mapping code.
 *
 * Covers Master Prompt §10: "All seven forms render, validate and map values
 * exactly to the intended columns in seven correct tabs; never mutate adjacent
 * columns/tabs; zero vs empty remains distinct."
 */
import { describe, it, expect } from 'vitest';
import {
  toSheetRow,
  expectedHeaders,
  rangeForRow,
  rangeForHeaderRow,
  columnLetterToIndex,
  indexToColumnLetter,
  quoteTabName,
  looksLikeFormula,
  escapeForCsvExport,
  SHEETS_VALUE_INPUT_OPTION,
} from '@/forms/sheetMapping';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES } from '@/forms/types';

describe('column letter arithmetic', () => {
  it.each([
    ['A', 0], ['B', 1], ['K', 10], ['M', 12], ['O', 14], ['P', 15], ['S', 18], ['Z', 25],
  ] as const)('%s <-> %i', (letter, index) => {
    expect(columnLetterToIndex(letter)).toBe(index);
    expect(indexToColumnLetter(index)).toBe(letter);
  });

  it('round-trips beyond Z so the 300-row/26-column template is not a ceiling', () => {
    expect(indexToColumnLetter(26)).toBe('AA');
    expect(indexToColumnLetter(27)).toBe('AB');
    expect(columnLetterToIndex('AA')).toBe(26);
    expect(columnLetterToIndex('AB')).toBe(27);
  });

  it('rejects a non-letter column reference', () => {
    expect(() => columnLetterToIndex('')).toThrow();
    expect(() => columnLetterToIndex('A1')).toThrow();
    expect(() => columnLetterToIndex('a')).toThrow();
  });
});

describe('A1 range construction', () => {
  it('quotes tab names, which all contain spaces', () => {
    expect(quoteTabName('1 Raw materials')).toBe("'1 Raw materials'");
    expect(quoteTabName('7 Mash')).toBe("'7 Mash'");
  });

  it("escapes an apostrophe in a tab name rather than breaking the range", () => {
    expect(quoteTabName("Bob's tab")).toBe("'Bob''s tab'");
  });

  it.each(STAGES)('%s: a data-row range is bounded at the legacy last column', (stage) => {
    const s = STAGE_SCHEMAS[stage];
    expect(rangeForRow(stage, 5)).toBe(`${quoteTabName(s.sheetTab)}!A5:${s.lastColumn}5`);
  });

  it.each(STAGES)('%s: header verification reads row 4 only', (stage) => {
    const s = STAGE_SCHEMAS[stage];
    expect(rangeForHeaderRow(stage)).toBe(`${quoteTabName(s.sheetTab)}!A4:${s.lastColumn}4`);
  });

  it('refuses to build a range over the protected header rows 1-4', () => {
    // A write addressed at row <= 4 would destroy the merged band row or the
    // header row. This must be impossible to express, not merely discouraged.
    for (const row of [0, 1, 2, 3, 4]) {
      expect(() => rangeForRow('raw_materials', row)).toThrow(/protected|row/i);
    }
    expect(() => rangeForRow('raw_materials', 5)).not.toThrow();
  });
});

describe('expectedHeaders', () => {
  it.each(STAGES)('%s: returns the row-4 contract in column order', (stage) => {
    const headers = expectedHeaders(stage);
    expect(headers).toHaveLength(STAGE_SCHEMAS[stage].columnCount);
    expect(headers[0]).toBe('Sample ID');
    expect(headers[headers.length - 1]).toBe('Comments');
  });
});

describe('toSheetRow: width and isolation', () => {
  it.each(STAGES)('%s: emits exactly columnCount cells', (stage) => {
    const row = toSheetRow(stage, 'XX-261024-01', {});
    expect(row).toHaveLength(STAGE_SCHEMAS[stage].columnCount);
  });

  it('cannot write past the last legacy column', () => {
    // 19 cells into A5:S5 is exactly full. A 20th cell would spill into T and
    // silently create an application field inside the legacy log.
    const row = toSheetRow('raw_materials', 'RM-261024-01', {
      comments: 'x',
      not_a_real_field: 'should be ignored',
    });
    expect(row).toHaveLength(19);
    expect(row[18]).toBe('x');
  });

  it('ignores unknown keys instead of appending them', () => {
    const row = toSheetRow('mash', 'MS-261024-01', { injected_column: 'boom' });
    expect(row).toHaveLength(11);
    expect(row).not.toContain('boom');
  });

  it('places the sample ID in column A', () => {
    expect(toSheetRow('raw_materials', 'RM-261024-01', {})[0]).toBe('RM-261024-01');
  });
});

describe('toSheetRow: zero is not blank (Master Prompt §10, PRD §6.1)', () => {
  it('writes a real zero as "0"', () => {
    const row = toSheetRow('raw_materials', 'RM-261024-01', { aflatoxin_ppb: 0 });
    expect(row[columnLetterToIndex('K')]).toBe('0');
  });

  it('writes a missing value as an empty string', () => {
    const row = toSheetRow('raw_materials', 'RM-261024-01', {});
    expect(row[columnLetterToIndex('K')]).toBe('');
  });

  it('treats null and undefined as not measured, never as zero', () => {
    const r1 = toSheetRow('raw_materials', 'RM-261024-01', { aflatoxin_ppb: null });
    const r2 = toSheetRow('raw_materials', 'RM-261024-01', { aflatoxin_ppb: undefined });
    expect(r1[columnLetterToIndex('K')]).toBe('');
    expect(r2[columnLetterToIndex('K')]).toBe('');
  });

  it('distinguishes 0 from "" for every numeric column on every tab', () => {
    // Conditional fields need their precondition satisfied, otherwise they are
    // correctly blank for a reason unrelated to the zero/blank distinction, and
    // the sweep would report them as covered while asserting nothing about it.
    const enabling: Record<string, string> = { sampling_point: 'BC' };
    let checked = 0;
    for (const stage of STAGES) {
      for (const f of STAGE_SCHEMAS[stage].fields) {
        if (f.type !== 'number') continue;
        const zero = toSheetRow(stage, 'X', { ...enabling, [f.key]: 0 })[columnLetterToIndex(f.columnLetter)];
        const blank = toSheetRow(stage, 'X', enabling)[columnLetterToIndex(f.columnLetter)];
        expect(zero, `${stage}.${f.key} zero`).toBe('0');
        expect(blank, `${stage}.${f.key} blank`).toBe('');
        checked++;
      }
    }
    // The coverage claim is asserted, not implied by the loop: if a schema change
    // drops a numeric column out of the sweep, this fails instead of passing quietly.
    //
    // 45 is the count of registry fields with type 'number'. It is deliberately
    // NOT the 34 entries on the workbook `Limits` tab — those are two different
    // sets and conflating them is easy: `Mill screen size (mm)` is a select, and
    // several limit entries describe equipment settings with no numeric field of
    // their own. Breakdown: raw 4, ground 4, conditioned 4, pellets 2,
    // extruded soya 8, crumble 5, mash 3, DGM 15.
    //
    // DGM's 15 are the seven tare masses, the seven gross masses and `mill_rpm`.
    // Its nine DERIVED columns are `type: 'system'` and so are correctly absent
    // from this sweep: `toSheetRow` never reads a client value for them.
    expect(checked).toBe(45);
  });
});

describe('toSheetRow: decimal precision is preserved as entered', () => {
  it('keeps a trailing zero the operator typed', () => {
    // 84.0 and 84 are the same number but not the same measurement record:
    // the trailing zero states the resolution of the instrument reading.
    const row = toSheetRow('conditioned', 'AC-261024-01', {
      mash_temperature_c: { value: 84, enteredText: '84.0' },
    });
    expect(row[columnLetterToIndex('I')]).toBe('84.0');
  });

  it('falls back to the numeric value when no entered text was captured', () => {
    const row = toSheetRow('conditioned', 'AC-261024-01', { mash_temperature_c: 84.5 });
    expect(row[columnLetterToIndex('I')]).toBe('84.5');
  });

  it('does not reformat or round a numeric value', () => {
    const row = toSheetRow('extruded_soya', 'ES-261024-01', { urease_ph_rise: 0.055 });
    expect(row[columnLetterToIndex('M')]).toBe('0.055');
  });

  it('rejects a non-finite measurement rather than writing "NaN" or "Infinity"', () => {
    expect(() => toSheetRow('mash', 'MS-261024-01', { moisture_pct: NaN })).toThrow(/finite/i);
    expect(() => toSheetRow('mash', 'MS-261024-01', { moisture_pct: Infinity })).toThrow(/finite/i);
  });
});

describe('toSheetRow: coded values become their workbook labels', () => {
  it('writes the Yes/No label, not the internal code', () => {
    const row = toSheetRow('raw_materials', 'RM-261024-01', {
      mould_seen: 'yes',
      insects_seen: 'no',
    });
    expect(row[columnLetterToIndex('N')]).toBe('Yes');
    expect(row[columnLetterToIndex('O')]).toBe('No');
  });

  it('writes the material label with workbook capitalisation', () => {
    const row = toSheetRow('raw_materials', 'RM-261024-01', { material: 'corn' });
    expect(row[columnLetterToIndex('D')]).toBe('Corn');
  });

  it('writes the full sampling-point label while the code drives the prefix', () => {
    const am = toSheetRow('ground', 'AM-261024-01', { sampling_point: 'AM' });
    const bc = toSheetRow('ground', 'BC-261024-01', { sampling_point: 'BC' });
    expect(am[columnLetterToIndex('D')]).toBe('AM after mill');
    expect(bc[columnLetterToIndex('D')]).toBe('BC before conditioning');
  });

  it('writes the mill screen size as its numeric label', () => {
    const row = toSheetRow('ground', 'AM-261024-01', { mill_screen_size_mm: '5' });
    expect(row[columnLetterToIndex('H')]).toBe('5');
  });

  it('rejects an unknown enum code rather than writing it through', () => {
    expect(() => toSheetRow('raw_materials', 'RM-1', { material: 'sawdust' })).toThrow(/material/);
    expect(() => toSheetRow('raw_materials', 'RM-1', { mould_seen: 'maybe' })).toThrow(/mould_seen/);
    expect(() => toSheetRow('ground', 'AM-1', { mill_screen_size_mm: '6' })).toThrow(/mill_screen/);
  });
});

describe('toSheetRow: non-applicable fields', () => {
  it('leaves BC moisture blank at AM and never writes a zero there', () => {
    const row = toSheetRow('ground', 'AM-261024-01', {
      sampling_point: 'AM',
      moisture_pct_bc: 12.4, // stale value from a switched point
    });
    expect(row[columnLetterToIndex('L')]).toBe('');
  });

  it('writes BC moisture at BC', () => {
    const row = toSheetRow('ground', 'BC-261024-01', {
      sampling_point: 'BC',
      moisture_pct_bc: 12.4,
    });
    expect(row[columnLetterToIndex('L')]).toBe('12.4');
  });
});

describe('spreadsheet formula injection (PRD §6.1, UAT-14)', () => {
  it('uses RAW so a formula string is never evaluated by Sheets', () => {
    // RAW stores the text literally; USER_ENTERED would parse "=" as a formula.
    // This is the primary control and is asserted, not assumed.
    expect(SHEETS_VALUE_INPUT_OPTION).toBe('RAW');
  });

  it.each(['=SUM(A1:A9)', '+1+1', '-1+1', '@A1', '=HYPERLINK("http://x","y")', '\t=1'])(
    'flags %s as formula-like',
    (v) => {
      expect(looksLikeFormula(v)).toBe(true);
    },
  );

  it.each(['84.0', 'Corn', 'Lot 2026-10-24', 'held pending QO', ''])(
    'does not flag %s',
    (v) => {
      expect(looksLikeFormula(v)).toBe(false);
    },
  );

  it('rejects formula-like text in an identity field', () => {
    expect(() =>
      toSheetRow('raw_materials', 'RM-1', { supplier: '=IMPORTRANGE("x","y")' }),
    ).toThrow(/supplier/);
  });

  it('stores formula-like free text literally rather than silently altering it', () => {
    // A comment may legitimately begin with "-". Under RAW it cannot execute,
    // so the record keeps exactly what the operator wrote.
    const row = toSheetRow('raw_materials', 'RM-1', { comments: '-held pending QO' });
    expect(row[columnLetterToIndex('S')]).toBe('-held pending QO');
  });

  it('escapes formula-like text on CSV export, where RAW gives no protection', () => {
    expect(escapeForCsvExport('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(escapeForCsvExport('Corn')).toBe('Corn');
  });
});

describe('toSheetRow: no cross-tab or cross-column bleed', () => {
  it('a value set on one tab never appears on another', () => {
    // `moisture_pct` exists on five tabs at five different column letters.
    // A mapping keyed by field name rather than (stage, column) would smear.
    const expectations: Array<[Parameters<typeof toSheetRow>[0], string]> = [
      ['raw_materials', 'J'],
      ['conditioned', 'J'],
      ['extruded_soya', 'L'],
      ['crumble', 'H'],
      ['mash', 'G'],
    ];
    const idColumn = columnLetterToIndex('A');
    for (const [stage, letter] of expectations) {
      const row = toSheetRow(stage, 'X', { moisture_pct: 11.5 });
      const idx = columnLetterToIndex(letter);
      expect(row[idx], `${stage} ${letter}`).toBe('11.5');
      row.forEach((cell, i) => {
        // Column A legitimately carries the sample ID.
        if (i === idColumn) return;
        if (i !== idx) expect(cell, `${stage} leak at ${indexToColumnLetter(i)}`).toBe('');
      });
    }
  });

  it('a full raw-material record lands in exactly the intended 19 columns (UAT-01)', () => {
    const row = toSheetRow('raw_materials', 'RM-261024-07', {
      collection_date: '2026-10-24',
      collection_time: '08:15',
      material: 'soya',
      supplier: 'Acme Grain',
      delivery_or_lot_no: 'LOT-5512',
      truck_or_container_no: 'GAB 1234',
      quantity_received_t: 27.5,
      sampled_by: 'A. Persaud',
      moisture_pct: 11.8,
      aflatoxin_ppb: 0,
      other_mycotoxin_name: 'Zearalenone',
      other_mycotoxin_result: 42.5,
      mould_seen: 'no',
      insects_seen: 'no',
      foreign_matter_seen: 'yes',
      bad_smell: 'no',
      tested_by_qo: 'R. Singh',
      comments: 'Foreign matter: twine fragments.',
    });
    expect(row).toEqual([
      'RM-261024-07', '2026-10-24', '08:15', 'Soya', 'Acme Grain', 'LOT-5512',
      'GAB 1234', '27.5', 'A. Persaud', '11.8', '0', 'Zearalenone', '42.5',
      'No', 'No', 'Yes', 'No', 'R. Singh', 'Foreign matter: twine fragments.',
    ]);
  });
});
