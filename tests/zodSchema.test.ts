import { describe, expect, it } from 'vitest';

import {
  buildStageSchema,
  editableFields,
  implausibleFindings,
  parseStageValues,
  requiredFieldKeys,
  type StageFormValues,
} from '@/forms/zodSchema';
import { defaultStageValues, emptyStageValues, hydrateStageValues } from '@/forms/defaults';
import { STAGE_SCHEMAS, fieldsRequiredAt } from '@/forms/registry';
import { STAGES } from '@/forms/types';
import { toSheetRow } from '@/forms/sheetMapping';

/** A complete, valid registration payload for Raw Materials. */
function rawRegistration(overrides: Partial<StageFormValues> = {}): StageFormValues {
  return {
    ...emptyStageValues('raw_materials'),
    collection_date: '2026-10-24',
    collection_time: '09:15',
    material: 'corn',
    supplier: 'Demerara Grain',
    delivery_or_lot_no: 'LOT-4471',
    truck_or_container_no: 'GXX 1234',
    quantity_received_t: '28.500',
    sampled_by: 'A. Persaud',
    mould_seen: 'no',
    insects_seen: 'no',
    foreign_matter_seen: 'no',
    bad_smell: 'no',
    ...overrides,
  };
}

/**
 * A complete, valid TESTING payload for Raw Materials. `tested_by_qo` is
 * required at testing, so a registration payload alone is legitimately
 * incomplete at that phase.
 */
function rawTesting(overrides: Partial<StageFormValues> = {}): StageFormValues {
  return rawRegistration({
    moisture_pct: '12.4',
    aflatoxin_ppb: '3',
    tested_by_qo: 'R. Singh',
    ...overrides,
  });
}

/** A complete, valid registration payload for Ground at the given point. */
function groundRegistration(
  point: 'AM' | 'BC',
  overrides: Partial<StageFormValues> = {},
): StageFormValues {
  return {
    ...emptyStageValues('ground'),
    collection_date: '2026-10-24',
    collection_time: '10:00',
    sampling_point: point,
    material_or_feed_type: 'Broiler starter',
    batch_or_bin_no: 'B-2291',
    sampled_by: 'A. Persaud',
    mill_screen_size_mm: '5',
    hammer_distance_mm: '12.5',
    ...overrides,
  };
}

describe('buildStageSchema: a draft may be incomplete (FR-005)', () => {
  it('accepts a completely empty form at draft phase for every stage', () => {
    for (const stage of STAGES) {
      const result = parseStageValues(stage, 'draft', emptyStageValues(stage));
      expect(result.ok, `${stage} empty draft`).toBe(true);
    }
  });

  it('emits no keys at all for an empty draft, rather than a row of nulls', () => {
    const result = parseStageValues('raw_materials', 'draft', emptyStageValues('raw_materials'));
    if (!result.ok) throw new Error('expected an empty draft to validate');
    expect(Object.keys(result.values)).toHaveLength(0);
  });

  it('still rejects a malformed value in a draft, so a draft cannot hold text that would fail later', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: 'twelve',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['moisture_pct']).toMatch(/numbers only/i);
  });

  it('keeps the partial work a draft does contain', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      supplier: 'Demerara Grain',
    });
    if (!result.ok) throw new Error('expected a partial draft to validate');
    expect(result.values).toEqual({ supplier: 'Demerara Grain' });
  });
});

describe('buildStageSchema: registration requiredness per stage', () => {
  it('accepts a complete raw-materials registration', () => {
    const result = parseStageValues('raw_materials', 'registration', rawRegistration());
    if (!result.ok) throw new Error(`expected valid, got ${JSON.stringify(result.errors)}`);
    expect(result.values['material']).toBe('corn');
  });

  it('reports every registration-required field that is blank, and only those', () => {
    const blank = emptyStageValues('raw_materials');
    const result = parseStageValues('raw_materials', 'registration', blank);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const expected = fieldsRequiredAt('raw_materials', 'registration', blank).map((f) => f.key);
    expect(new Set(Object.keys(result.errors))).toEqual(new Set(expected));
  });

  it('derives the required set from the registry for all seven stages', () => {
    for (const stage of STAGES) {
      // Ground's requiredness depends on the point code, so give it one.
      const seed =
        stage === 'ground'
          ? { ...emptyStageValues(stage), sampling_point: 'AM' }
          : emptyStageValues(stage);
      const required = requiredFieldKeys(stage, 'registration', seed);
      const fromRegistry = fieldsRequiredAt(stage, 'registration', seed).map((f) => f.key);
      expect([...required].sort(), stage).toEqual([...fromRegistry].sort());
    }
  });

  it('does not require a testing-phase field at registration', () => {
    // Moisture is required at testing, so a registration with no moisture is fine.
    const result = parseStageValues('raw_materials', 'registration', rawRegistration());
    expect(result.ok).toBe(true);
  });

  it('requires registration fields cumulatively at testing phase', () => {
    const missingSupplier = rawRegistration({ supplier: '' });
    const result = parseStageValues('raw_materials', 'testing', missingSupplier);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['supplier']).toBeDefined();
  });
});

describe('zero is a value, blank is not a value (PRD §6.1)', () => {
  it('accepts 0 for every numeric field whose hard bounds allow it', () => {
    for (const stage of STAGES) {
      for (const field of STAGE_SCHEMAS[stage].fields) {
        if (field.type !== 'number') continue;
        if (field.min !== undefined && field.min > 0) continue;

        const values: StageFormValues = {
          ...emptyStageValues(stage),
          ...(stage === 'ground' ? { sampling_point: 'BC' } : {}),
          [field.key]: '0',
        };
        const result = parseStageValues(stage, 'draft', values);
        if (!result.ok) {
          throw new Error(
            `${stage}.${field.key} rejected 0: ${JSON.stringify(result.errors)}`,
          );
        }
        // The operator's own text. A measurement crosses to the server as
        // the characters that were typed, and the server parses it and
        // rebuilds the { value, enteredText } pair — see numberFieldSchema.
        expect(result.values[field.key], `${stage}.${field.key}`).toBe('0');
      }
    }
  });

  it('never turns an empty number input into 0', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: '',
    });
    if (!result.ok) throw new Error('expected empty moisture to validate at draft');
    expect('moisture_pct' in result.values).toBe(false);
  });

  it('distinguishes 0 from blank all the way through to the sheet row', () => {
    const zero = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: '0',
    });
    const blank = parseStageValues('raw_materials', 'draft', emptyStageValues('raw_materials'));
    if (!zero.ok || !blank.ok) throw new Error('expected both to validate');

    const zeroRow = toSheetRow('raw_materials', 'RM-261024-01', zero.values);
    const blankRow = toSheetRow('raw_materials', 'RM-261024-01', blank.values);
    // Column J is moisture.
    expect(zeroRow[9]).toBe('0');
    expect(blankRow[9]).toBe('');
  });

  it('treats a blank required number as missing, not as 0', () => {
    const result = parseStageValues('raw_materials', 'testing', rawRegistration());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['moisture_pct']).toMatch(/enter a value/i);
  });
});

describe('hard bounds reject impossibilities', () => {
  it('rejects a percentage above 100', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: '100.1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['moisture_pct']).toMatch(/more than 100/i);
  });

  it('accepts exactly 100 for a percentage', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: '100',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a negative value where min is 0', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      quantity_received_t: '-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['quantity_received_t']).toMatch(/less than zero/i);
  });

  it('rejects every percentage field above 100 across all stages', () => {
    for (const stage of STAGES) {
      for (const field of STAGE_SCHEMAS[stage].fields) {
        if (field.type !== 'number' || field.unit !== '%') continue;
        const result = parseStageValues(stage, 'draft', {
          ...emptyStageValues(stage),
          ...(stage === 'ground' ? { sampling_point: 'BC' } : {}),
          [field.key]: '101',
        });
        expect(result.ok, `${stage}.${field.key} accepted 101%`).toBe(false);
      }
    }
  });

  it('rejects NaN, Infinity and exponent notation', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', '1e5', 'abc', '1.2.3', '--3', '']) {
      const result = parseStageValues('raw_materials', 'testing', rawTesting({
        moisture_pct: bad,
      }));
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('rejects a non-finite number arriving as a raw number rather than text', () => {
    // A hostile payload can reach the schema without going through the form.
    const schema = buildStageSchema('raw_materials', 'draft', {});
    expect(schema.safeParse({ moisture_pct: Number.NaN }).success).toBe(false);
    expect(schema.safeParse({ moisture_pct: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});

describe('implausibleAbove is a soft guard, never a validation failure', () => {
  it('validates a value above the soft guard', () => {
    // Aflatoxin's soft guard is 1000 ppb. A reading above it is suspicious,
    // not impossible, and the operator is asked to confirm instead of blocked.
    const result = parseStageValues('raw_materials', 'testing', rawTesting({
      aflatoxin_ppb: '5000',
    }));
    if (!result.ok) throw new Error(`soft guard rejected the value: ${JSON.stringify(result.errors)}`);
    expect(result.values['aflatoxin_ppb']).toBe('5000');
  });

  it('never produces an error message mentioning the soft guard for any field', () => {
    for (const stage of STAGES) {
      for (const field of STAGE_SCHEMAS[stage].fields) {
        const threshold = field.implausibleAbove;
        if (threshold === undefined) continue;
        const result = parseStageValues(stage, 'draft', {
          ...emptyStageValues(stage),
          ...(stage === 'ground' ? { sampling_point: 'BC' } : {}),
          [field.key]: String(threshold + 1),
        });
        expect(result.ok, `${stage}.${field.key} failed validation above its soft guard`).toBe(true);
      }
    }
  });

  it('reports the finding so the UI can ask for confirmation', () => {
    const parsed = parseStageValues('raw_materials', 'testing', rawTesting({
      aflatoxin_ppb: '5000',
    }));
    if (!parsed.ok) throw new Error('expected valid');
    const findings = implausibleFindings('raw_materials', parsed.values);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field.key).toBe('aflatoxin_ppb');
    expect(findings[0]?.threshold).toBe(1000);
    expect(findings[0]?.entered).toBe('5000');
  });

  it('reports nothing when every value sits at or below its guard', () => {
    const parsed = parseStageValues('raw_materials', 'testing', rawTesting({
      aflatoxin_ppb: '1000',
    }));
    if (!parsed.ok) throw new Error('expected valid');
    expect(implausibleFindings('raw_materials', parsed.values)).toHaveLength(0);
  });
});

describe('controlled codes', () => {
  it('rejects an unknown enum code', () => {
    const result = parseStageValues('raw_materials', 'registration', rawRegistration({
      material: 'platinum',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['material']).toMatch(/choose one of the options/i);
  });

  it('rejects an unknown yes/no code', () => {
    const result = parseStageValues('raw_materials', 'registration', rawRegistration({
      mould_seen: 'maybe',
    }));
    expect(result.ok).toBe(false);
  });

  it('rejects the display label where a code is expected', () => {
    // "Corn" is the label; "corn" is the stored code. Accepting the label
    // would put human text in the database column the enum guards.
    const result = parseStageValues('raw_materials', 'registration', rawRegistration({
      material: 'Corn',
    }));
    expect(result.ok).toBe(false);
  });

  it('stores the code, and the sheet encoder turns it into the label', () => {
    const result = parseStageValues('raw_materials', 'registration', rawRegistration());
    if (!result.ok) throw new Error('expected valid');
    expect(result.values['material']).toBe('corn');
    const row = toSheetRow('raw_materials', 'RM-261024-01', result.values);
    expect(row[3]).toBe('Corn');
  });

  it('rejects an unknown sampling point, so no prefix can be minted from it', () => {
    const result = parseStageValues('ground', 'registration', groundRegistration('AM', {
      sampling_point: 'XX',
    }));
    expect(result.ok).toBe(false);
  });
});

describe('conditional applicability: AM versus BC (UAT-02)', () => {
  it('omits BC moisture from the editable field list at AM', () => {
    const keys = editableFields('ground', groundRegistration('AM')).map((f) => f.key);
    expect(keys).not.toContain('moisture_pct_bc');
  });

  it('includes BC moisture in the editable field list at BC', () => {
    const keys = editableFields('ground', groundRegistration('BC')).map((f) => f.key);
    expect(keys).toContain('moisture_pct_bc');
  });

  it('does not require BC moisture at testing when the point is AM', () => {
    const result = parseStageValues('ground', 'testing', groundRegistration('AM', {
      avg_particle_size_um: '880',
      size_spread_gsd: '1.9',
      tested_by_qo: 'R. Singh',
    }));
    if (!result.ok) throw new Error(`expected valid: ${JSON.stringify(result.errors)}`);
    expect('moisture_pct_bc' in result.values).toBe(false);
  });

  it('requires BC moisture at testing when the point is BC', () => {
    const result = parseStageValues('ground', 'testing', groundRegistration('BC', {
      avg_particle_size_um: '880',
      size_spread_gsd: '1.9',
      tested_by_qo: 'R. Singh',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['moisture_pct_bc']).toMatch(/enter a value/i);
  });

  it('strips a stale BC moisture value once the point is switched to AM', () => {
    // The operator entered a BC reading, then corrected the point to AM. The
    // reading must not reach the server, let alone the sheet.
    const result = parseStageValues('ground', 'testing', groundRegistration('AM', {
      moisture_pct_bc: '13.2',
      avg_particle_size_um: '880',
      size_spread_gsd: '1.9',
      tested_by_qo: 'R. Singh',
    }));
    if (!result.ok) throw new Error(`expected valid: ${JSON.stringify(result.errors)}`);
    expect('moisture_pct_bc' in result.values).toBe(false);

    const row = toSheetRow('ground', 'AM-261024-01', result.values);
    // Column L is moisture at BC.
    expect(row[11]).toBe('');
  });

  it('does not let an invalid stale BC value fail an AM submission', () => {
    const result = parseStageValues('ground', 'registration', groundRegistration('AM', {
      moisture_pct_bc: 'rubbish',
    }));
    expect(result.ok).toBe(true);
  });
});

describe('formula injection: identity fields refuse it, narrative fields allow it', () => {
  const identityCases: readonly [string, string][] = [
    ['supplier', '=HYPERLINK("http://evil","click")'],
    ['delivery_or_lot_no', '+1+1'],
    ['truck_or_container_no', '-2'],
    ['sampled_by', '@SUM(A1)'],
  ];

  for (const [key, payload] of identityCases) {
    it(`rejects formula-like text in ${key}`, () => {
      const result = parseStageValues('raw_materials', 'registration', rawRegistration({
        [key]: payload,
      }));
      expect(result.ok, `${key} accepted ${payload}`).toBe(false);
      if (result.ok) return;
      expect(result.errors[key]).toMatch(/cannot start with/i);
    });
  }

  it('allows formula-like text in comments', () => {
    const result = parseStageValues('raw_materials', 'registration', rawRegistration({
      comments: '-2 bags rejected at the gate',
    }));
    if (!result.ok) throw new Error(`comments rejected: ${JSON.stringify(result.errors)}`);
    expect(result.values['comments']).toBe('-2 bags rejected at the gate');
  });

  it('allows formula-like text in action_taken', () => {
    const result = parseStageValues('ground', 'registration', groundRegistration('AM', {
      action_taken: '= adjusted screen to 5mm',
    }));
    if (!result.ok) throw new Error(`action_taken rejected: ${JSON.stringify(result.errors)}`);
    expect(result.values['action_taken']).toBe('= adjusted screen to 5mm');
  });

  it('agrees with the sheet encoder about which fields are narrative', () => {
    // If validation accepted text the encoder refuses, the sample would pass
    // the form and then fail at write time with no field to point at.
    const payload = '-2 bags rejected at the gate';
    const result = parseStageValues('raw_materials', 'registration', rawRegistration({
      comments: payload,
    }));
    if (!result.ok) throw new Error('expected valid');
    expect(() => toSheetRow('raw_materials', 'RM-261024-01', result.values)).not.toThrow();
  });

  it('rejects formula-like text hidden behind leading whitespace', () => {
    const result = parseStageValues('raw_materials', 'registration', rawRegistration({
      supplier: '   =1+1',
    }));
    expect(result.ok).toBe(false);
  });
});

describe('entered precision survives, from the keystroke to the sheet cell', () => {
  it('keeps a trailing zero', () => {
    const result = parseStageValues('raw_materials', 'testing', rawTesting({
      moisture_pct: '12.50',
      aflatoxin_ppb: '3.00',
    }));
    if (!result.ok) throw new Error(`expected valid: ${JSON.stringify(result.errors)}`);
    // The payload carries the characters, not a parsed pair: 12.5 and 12.50
    // are the same number and a different record, so the text is the thing
    // that must travel.
    expect(result.values['moisture_pct']).toBe('12.50');
    expect(result.values['aflatoxin_ppb']).toBe('3.00');
  });

  it('carries the entered text through to the sheet cell unchanged', () => {
    const result = parseStageValues('raw_materials', 'testing', rawTesting({
      moisture_pct: '12.50',
    }));
    if (!result.ok) throw new Error('expected valid');
    const row = toSheetRow('raw_materials', 'RM-261024-01', result.values);
    expect(row[9]).toBe('12.50');
  });

  it('keeps 0.0 distinct from 0 in the record', () => {
    const a = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: '0.0',
    });
    if (!a.ok) throw new Error('expected valid');
    expect(a.values['moisture_pct']).toBe('0.0');
  });

  it('trims surrounding whitespace without altering the digits', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      moisture_pct: '  12.50  ',
    });
    if (!result.ok) throw new Error('expected valid');
    expect(result.values['moisture_pct']).toBe('12.50');
  });

  it('survives a hydrate round trip, so reopening a record shows what was typed', () => {
    const result = parseStageValues('raw_materials', 'testing', rawTesting({
      moisture_pct: '12.50',
    }));
    if (!result.ok) throw new Error('expected valid');
    const rehydrated = hydrateStageValues('raw_materials', result.values);
    expect(rehydrated['moisture_pct']).toBe('12.50');
  });
});

describe('date and time validation', () => {
  it('accepts the seeded plant-local defaults', () => {
    const values = defaultStageValues('raw_materials', new Date('2026-10-24T13:15:00Z'));
    expect(values['collection_date']).toBe('2026-10-24');
    expect(values['collection_time']).toBe('09:15');
    const result = parseStageValues('raw_materials', 'draft', values);
    expect(result.ok).toBe(true);
  });

  it('rejects a date that does not exist', () => {
    const result = parseStageValues('raw_materials', 'draft', {
      ...emptyStageValues('raw_materials'),
      collection_date: '2026-02-30',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['collection_date']).toMatch(/does not exist/i);
  });

  it('rejects a malformed time', () => {
    for (const bad of ['25:00', '9:15', '09:60', 'noon']) {
      const result = parseStageValues('raw_materials', 'draft', {
        ...emptyStageValues('raw_materials'),
        collection_time: bad,
      });
      expect(result.ok, `accepted time ${bad}`).toBe(false);
    }
  });

  it('accepts midnight and the last minute of the day', () => {
    for (const good of ['00:00', '23:59']) {
      const result = parseStageValues('raw_materials', 'draft', {
        ...emptyStageValues('raw_materials'),
        collection_time: good,
      });
      expect(result.ok, `rejected time ${good}`).toBe(true);
    }
  });
});

describe('no operational acceptance limit is encoded anywhere in validation', () => {
  it('accepts a conditioned mash temperature far outside the vendor reference range', () => {
    // The Polinutri reference for conditioned mash temperature is 84-86 degC and
    // it is NOT approved. Validation must not enforce it; only an approved rule
    // in specification_versions may ever assess it (FR-009, R-01).
    for (const temperature of ['20', '84', '86', '150']) {
      const result = parseStageValues('conditioned', 'draft', {
        ...emptyStageValues('conditioned'),
        mash_temperature_c: temperature,
      });
      expect(result.ok, `rejected ${temperature} degC`).toBe(true);
    }
  });

  it('accepts a steam pressure reading despite its unconfirmed unit', () => {
    // An unconfirmed unit blocks ASSESSMENT, not capture. The reading is a fact
    // worth recording; what it cannot do is produce a conformity verdict.
    const result = parseStageValues('conditioned', 'draft', {
      ...emptyStageValues('conditioned'),
      steam_pressure_reading: '2.5',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a crumble roll gap outside the vendor reference range', () => {
    const result = parseStageValues('crumble', 'draft', {
      ...emptyStageValues('crumble'),
      crumbler_roll_gap_mm: '9.9',
    });
    expect(result.ok).toBe(true);
  });
});

describe('the schema is generated, not hand-written per stage', () => {
  it('covers every operator-editable registry field for every stage', () => {
    let checked = 0;
    for (const stage of STAGES) {
      const seed =
        stage === 'ground'
          ? { ...emptyStageValues(stage), sampling_point: 'BC' }
          : emptyStageValues(stage);
      const fields = editableFields(stage, seed);

      // Every editable field must be reachable by the schema: give each one an
      // invalid value and require a message against that exact key.
      for (const field of fields) {
        if (field.type === 'number') {
          const result = parseStageValues(stage, 'draft', { ...seed, [field.key]: 'xx' });
          expect(result.ok, `${stage}.${field.key}`).toBe(false);
          if (!result.ok) expect(result.errors[field.key], `${stage}.${field.key}`).toBeDefined();
          checked++;
        } else if (field.type === 'select' || field.type === 'yesno') {
          const result = parseStageValues(stage, 'draft', { ...seed, [field.key]: 'xx' });
          expect(result.ok, `${stage}.${field.key}`).toBe(false);
          if (!result.ok) expect(result.errors[field.key], `${stage}.${field.key}`).toBeDefined();
          checked++;
        }
      }

      // The schema's field set equals the registry's, minus column A.
      const expectedKeys = STAGE_SCHEMAS[stage].fields
        .filter((f) => f.type !== 'system')
        .filter((f) => f.key !== 'moisture_pct_bc' || stage !== 'ground')
        .map((f) => f.key);
      const actualKeys = fields.map((f) => f.key);
      expect(new Set(actualKeys).size, stage).toBe(actualKeys.length);
      for (const key of expectedKeys) expect(actualKeys, `${stage} missing ${key}`).toContain(key);
    }
    // 30 number fields + 7 controlled-code fields across the seven tabs.
    // The 7 are: raw materials `material`, `mould_seen`, `insects_seen`,
    // `foreign_matter_seen`, `bad_smell`; ground `sampling_point` and
    // `mill_screen_size_mm`. No other tab has a select or yes/no column.
    // Asserted so that a registry change dropping fields out of the sweep
    // fails here rather than passing quietly with less coverage than claimed.
    expect(checked).toBe(37);
  });

  it('never emits a key the registry does not define for the stage', () => {
    const result = parseStageValues('mash', 'draft', {
      ...emptyStageValues('mash'),
      // Mash has no steam pressure column; a stray key must be dropped.
      steam_pressure_reading: '2.5',
      urease_ph_rise: '0.1',
    });
    if (!result.ok) throw new Error('expected valid');
    expect('steam_pressure_reading' in result.values).toBe(false);
    expect('urease_ph_rise' in result.values).toBe(false);
  });

  it('never emits the server-assigned sample_id', () => {
    const result = parseStageValues('raw_materials', 'registration', {
      ...rawRegistration(),
      sample_id: 'RM-261024-99',
    });
    if (!result.ok) throw new Error('expected valid');
    expect('sample_id' in result.values).toBe(false);
  });
});
