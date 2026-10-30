/**
 * The registry and the database seed must describe the same workbook.
 *
 * ===========================================================================
 * WHY THIS EXISTS — AND WHY ITS ABSENCE WAS INVISIBLE
 * ===========================================================================
 * `supabase/migrations/0002_samples.sql` states the contract and names its
 * enforcement, in its own header:
 *
 *     "A value that exists on one side and not the other is a defect, so
 *      these are asserted against the registry by the dry-run harness and by
 *      CI rather than being trusted to stay aligned."
 *
 * That was not true. There was no such assertion anywhere — not in `tests/`,
 * not in `scripts/`, not in any workflow. `grep -rn 'sample_stage\|
 * stage_definitions' tests/ scripts/ e2e/` returned nothing at all, and the
 * only "dry run" in the repository is an unrelated boolean on the
 * sheet-reconciliation endpoint. Four copies of one contract — the TypeScript
 * registry, the `sample_stage` enum, the `stage_definitions` seed and the
 * `stage_fields` seed — were held in step by hand-editing, and the clearest
 * description of the risk was the thing that stopped anyone checking.
 *
 * `stage_fields`'s own header makes the second half of the claim: "Generated
 * from src/forms/registry.ts, which is the single source of truth (NFR-006)".
 * Nothing verified the generation either.
 *
 * ===========================================================================
 * WHAT THIS GATE IS, AND WHAT IT IS NOT
 * ===========================================================================
 * It compares two things that are both IN THE REPOSITORY: the registry, and
 * the SQL that seeds the database. It does NOT connect to a database and
 * cannot — vitest has no connection and CI provisions no Postgres. So it
 * proves the migrations SAY the same thing as the registry; that the
 * migrations were actually applied is a different claim, owned by
 * `npm run verify:sql`.
 *
 * That split is deliberate and worth stating, because the pairing is the only
 * reason this gate runs at all: `verify:sql`, `verify:rls`, `verify:schema`
 * and `verify:db` are declared in package.json and appear in NO workflow,
 * while this file runs under `npm test` on every push. A check placed only in
 * SQL would run when somebody remembered.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_SCHEMAS, ALL_PREFIXES } from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';

const REPO = process.cwd();
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

const SQL = migrationSql();

type SqlValue = string | number | boolean | null | string[];

/**
 * Split a SQL fragment on commas that are at bracket depth zero and outside a
 * quoted string. Needed because the two seeds are formatted differently —
 * 0002 writes one row per line, 0025 wraps each row over four — so nothing
 * line-based can read both, and because `array['a', 'b']` contains commas
 * that are not separators.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      current += c;
      if (c === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          quoted = false;
        }
      }
      continue;
    }
    if (c === "'") {
      quoted = true;
      current += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function parseValue(raw: string): SqlValue {
  const text = raw.trim().replace(/::\s*text\[\]$/i, '').trim();
  if (/^null$/i.test(text)) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^array\s*\[/i.test(text)) {
    const inner = text.slice(text.indexOf('[') + 1, text.lastIndexOf(']'));
    if (inner.trim() === '') return [];
    return splitTopLevel(inner).map((v) => String(parseValue(v)));
  }
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  const n = Number(text);
  return Number.isNaN(n) ? text : n;
}

/**
 * Every row of every `insert into public.<table> (cols) values (...), (...);`
 * across all migrations, as objects keyed by the INSERT's own column list.
 *
 * The column names are read from the statement rather than hardcoded here, so
 * a reordered or renamed column in the seed cannot quietly line up against the
 * wrong field.
 */
function insertedRows(table: string): Array<Record<string, SqlValue>> {
  const rows: Array<Record<string, SqlValue>> = [];
  const re = new RegExp(`insert\\s+into\\s+public\\.${table}\\s*\\(([^)]*)\\)\\s*values`, 'gi');
  for (const match of SQL.matchAll(re)) {
    const columns = match[1]!.split(',').map((c) => c.trim());
    // Walk forward from the end of `values` to the statement's `;`, tracking
    // depth and quotes so a `;` inside a string cannot end it early.
    let i = match.index! + match[0].length;
    let depth = 0;
    let quoted = false;
    const start = i;
    for (; i < SQL.length; i++) {
      const c = SQL[i]!;
      if (quoted) {
        if (c === "'") {
          if (SQL[i + 1] === "'") i++;
          else quoted = false;
        }
        continue;
      }
      if (c === "'") quoted = true;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ';' && depth === 0) break;
    }
    const body = SQL.slice(start, i);
    for (const tuple of splitTopLevel(body)) {
      const trimmed = tuple.trim();
      if (!trimmed.startsWith('(')) continue;
      const values = splitTopLevel(trimmed.slice(1, -1)).map(parseValue);
      const row: Record<string, SqlValue> = {};
      columns.forEach((name, idx) => {
        row[name] = values[idx] ?? null;
      });
      rows.push(row);
    }
  }
  return rows;
}

/** Enum labels, from the CREATE plus every later ADD VALUE. */
function stageEnumLabels(): string[] {
  const labels: string[] = [];
  const created = /create\s+type\s+public\.sample_stage\s+as\s+enum\s*\(([^)]*)\)/i.exec(SQL);
  if (created !== null) {
    for (const m of created[1]!.matchAll(/'([a-z_]+)'/g)) labels.push(m[1]!);
  }
  const added = /alter\s+type\s+public\.sample_stage\s+add\s+value(?:\s+if\s+not\s+exists)?\s+'([a-z_]+)'/gi;
  for (const m of SQL.matchAll(added)) labels.push(m[1]!);
  return labels;
}

const STAGE_FIELD_ROWS = insertedRows('stage_fields');
const STAGE_DEFINITION_ROWS = insertedRows('stage_definitions');
const PREFIX_ROWS = insertedRows('sample_prefixes');

describe('the instrument works before anything it says is believed', () => {
  // Ordered first on purpose. A parser that silently reads nothing reports a
  // clean contract in exactly the same words as a correct one, and every
  // assertion below would pass vacuously. This is the input assertion; the
  // positive control is the discrimination test at the end of the file.
  it('found the SQL at all', () => {
    expect(SQL.length, 'no migration SQL was read').toBeGreaterThan(50_000);
    expect(SQL).toContain('create table public.stage_fields');
  });

  it('parsed every seeded column row, not some of them', () => {
    // 98 across the original seven tabs + 35 for DGM. Stated as the sum so a
    // change names which side moved.
    expect(STAGE_FIELD_ROWS).toHaveLength(133);
    expect(STAGE_DEFINITION_ROWS).toHaveLength(8);
    expect(PREFIX_ROWS).toHaveLength(9);
  });

  it('parsed the awkward value shapes rather than skipping them', () => {
    // `array['corn', 'rice', ...]::text[]` contains commas that are not
    // separators and a cast that is not part of the value; `'Moisture (%)'`
    // contains brackets. If any of those broke the tokenizer it would drop
    // values silently, which is the failure this whole file guards against.
    const material = STAGE_FIELD_ROWS.find(
      (r) => r['stage'] === 'raw_materials' && r['field_key'] === 'material',
    );
    expect(material?.['select_options']).toEqual(['corn', 'rice', 'soya', 'other']);

    const conditional = STAGE_FIELD_ROWS.find((r) => r['field_key'] === 'moisture_pct_bc');
    expect(conditional?.['applies_when_field']).toBe('sampling_point');
    expect(conditional?.['applies_when_values']).toEqual(['BC']);
    expect(conditional?.['hard_max']).toBe(100);
    expect(conditional?.['unit_confirmed']).toBe(true);

    const micro = STAGE_FIELD_ROWS.find(
      (r) => r['stage'] === 'dgm' && r['field_key'] === 'dgm_um',
    );
    expect(micro?.['sheet_header']).toBe('DGM (µm)');
  });
});

describe('the stage list', () => {
  it('is the same set in TypeScript and in the enum', () => {
    expect([...stageEnumLabels()].sort()).toEqual([...STAGES].sort());
  });

  it('has one stage_definitions row per stage and no orphans', () => {
    expect(STAGE_DEFINITION_ROWS.map((r) => String(r['stage'])).sort()).toEqual(
      [...STAGES].sort(),
    );
  });
});

describe('stage_definitions matches the registry, field for field', () => {
  it.each(STAGES)('%s', (stage: Stage) => {
    const schema = STAGE_SCHEMAS[stage];
    const row = STAGE_DEFINITION_ROWS.find((r) => r['stage'] === stage);
    expect(row, `no stage_definitions row for ${stage}`).toBeDefined();
    if (row === undefined) return;

    expect(row['ordinal'], `${stage}.ordinal`).toBe(schema.ordinal);
    expect(row['title'], `${stage}.title`).toBe(schema.title);
    expect(row['sheet_tab'], `${stage}.sheet_tab`).toBe(schema.sheetTab);
    expect(row['last_column'], `${stage}.last_column`).toBe(schema.lastColumn);
    expect(row['column_count'], `${stage}.column_count`).toBe(schema.columnCount);
    expect(row['default_prefix'], `${stage}.default_prefix`).toBe(schema.prefix);
    expect(row['frequency'], `${stage}.frequency`).toBe(schema.frequency);
    expect(row['frequency_approved'], `${stage}.frequency_approved`).toBe(
      schema.frequencyApproved,
    );
  });
});

describe('stage_fields matches the registry, column for column', () => {
  it.each(STAGES)('%s: the same columns, in the same order', (stage: Stage) => {
    const seeded = STAGE_FIELD_ROWS.filter((r) => r['stage'] === stage);
    const schema = STAGE_SCHEMAS[stage];

    // Order matters and is asserted: `toSheetRow` places cells by their INDEX
    // in `schema.fields`, not by `columnLetter`, so a field in the wrong
    // position writes to the wrong cell with no error anywhere.
    expect(
      seeded.map((r) => String(r['column_letter'])),
      `${stage}: seeded column letters`,
    ).toEqual(schema.fields.map((f) => f.columnLetter));
    expect(seeded.map((r) => String(r['field_key']))).toEqual(schema.fields.map((f) => f.key));
  });

  it.each(STAGES)('%s: every property of every column agrees', (stage: Stage) => {
    const schema = STAGE_SCHEMAS[stage];
    const problems: string[] = [];

    for (const field of schema.fields) {
      const row = STAGE_FIELD_ROWS.find(
        (r) => r['stage'] === stage && r['field_key'] === field.key,
      );
      if (row === undefined) {
        problems.push(`${stage}.${field.key}: no stage_fields row`);
        continue;
      }
      const check = (name: string, sqlValue: SqlValue, tsValue: unknown): void => {
        const normalised = tsValue === undefined ? null : tsValue;
        if (JSON.stringify(sqlValue) !== JSON.stringify(normalised)) {
          problems.push(
            `${stage}.${field.key}.${name}: seed has ${JSON.stringify(sqlValue)}, ` +
              `registry has ${JSON.stringify(normalised)}`,
          );
        }
      };

      check('sheet_header', row['sheet_header'] ?? null, field.sheetHeader);
      check('field_type', row['field_type'] ?? null, field.type);
      check('section', row['section'] ?? null, field.section);
      check('requiredness', row['requiredness'] ?? null, field.required);
      check('unit', row['unit'] ?? null, field.unit);
      check('unit_confirmed', row['unit_confirmed'] ?? null, field.unitConfirmed);
      check('parameter_key', row['parameter_key'] ?? null, field.parameterKey);
      check('hard_min', row['hard_min'] ?? null, field.min);
      check('hard_max', row['hard_max'] ?? null, field.max);
      check('implausible_above', row['implausible_above'] ?? null, field.implausibleAbove);
      check('decimals', row['decimals'] ?? null, field.decimals);
      check('adverse_value', row['adverse_value'] ?? null, field.adverseValue);
      check('applies_when_field', row['applies_when_field'] ?? null, field.appliesWhen?.field);
      check(
        'applies_when_values',
        row['applies_when_values'] ?? null,
        // `equals`, not `values`: the SQL column and the TypeScript property
        // are named differently for the same thing, which is exactly the kind
        // of seam this file exists to hold together. Reading the wrong one
        // here produced a false positive against `ground.moisture_pct_bc` on
        // this gate's first run — the right failure for the wrong reason.
        field.appliesWhen?.equals === undefined ? undefined : [...field.appliesWhen.equals],
      );
      check(
        'select_options',
        row['select_options'] ?? null,
        field.options === undefined ? undefined : field.options.map((o) => o.value),
      );
    }

    expect(problems, `${stage}: registry and seed disagree`).toEqual([]);
  });

  it('seeds no column the registry does not declare', () => {
    // The other direction. A stale seed row is a `field_key` the composite
    // foreign key will happily accept from a client that knows it exists.
    const orphans = STAGE_FIELD_ROWS.filter((row) => {
      const stage = String(row['stage']) as Stage;
      const schema = STAGE_SCHEMAS[stage] as typeof STAGE_SCHEMAS[Stage] | undefined;
      return schema === undefined || !schema.fields.some((f) => f.key === row['field_key']);
    }).map((r) => `${String(r['stage'])}.${String(r['field_key'])}`);
    expect(orphans).toEqual([]);
  });
});

describe('sample_prefixes matches ALL_PREFIXES', () => {
  it('seeds exactly the prefixes the client can issue', () => {
    // `StageSchema.prefix` is `string | null`, not `SamplePrefix`, so these
    // two lists are joined by nothing but agreement.
    expect(PREFIX_ROWS.map((r) => String(r['prefix'])).sort()).toEqual([...ALL_PREFIXES].sort());
  });

  it('points every prefix at a stage the registry knows', () => {
    const problems = PREFIX_ROWS.filter(
      (r) => !(STAGES as readonly string[]).includes(String(r['stage'])),
    ).map((r) => `${String(r['prefix'])} -> ${String(r['stage'])}`);
    expect(problems).toEqual([]);
  });

  it("agrees with each stage's declared default prefix", () => {
    const problems: string[] = [];
    for (const stage of STAGES) {
      const declared = STAGE_SCHEMAS[stage].prefix;
      if (declared === null) continue; // ground issues AM/BC from the sampling point
      const row = PREFIX_ROWS.find((r) => r['prefix'] === declared);
      if (row === undefined) {
        problems.push(`${stage}: prefix ${declared} is not seeded`);
      } else if (row['stage'] !== stage) {
        problems.push(`${stage}: prefix ${declared} is seeded against ${String(row['stage'])}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('POSITIVE CONTROL: the comparison can actually fail', () => {
  it('reports a disagreement when one is introduced', () => {
    // The whole file asserts that two lists are equal, and the cheapest way
    // for that to be worthless is for the comparison never to reject
    // anything. This runs the same `check` shape over a deliberately wrong
    // value and requires it to be caught.
    const row = STAGE_FIELD_ROWS.find(
      (r) => r['stage'] === 'dgm' && r['field_key'] === 'sieve1_tare_g',
    );
    expect(row).toBeDefined();
    expect(row?.['sheet_header']).toBe('ABNT 5 empty sieve (g)');
    expect(row?.['sheet_header']).not.toBe('ABNT 5 empty sieve (G)');
    expect(row?.['requiredness']).toBe('registration');
    expect(row?.['requiredness']).not.toBe('testing');
  });

  it('would notice a stage missing from the seed', () => {
    const seededStages = new Set(STAGE_DEFINITION_ROWS.map((r) => String(r['stage'])));
    expect(seededStages.has('dgm')).toBe(true);
    expect(seededStages.has('a_stage_nobody_seeded')).toBe(false);
  });
});

/**
 * Every stage reaches the registration projection.
 *
 * ===========================================================================
 * THE DEFECT THIS WOULD HAVE CAUGHT
 * ===========================================================================
 * `rpc_register_sample` denormalises two columns onto `samples` for the search
 * screen — `sample_label` (feed type) and `test_label` (batch number) — each
 * filled by a `case p_stage` written when there were seven stages. Adding an
 * eighth left both CASEs untouched, and a CASE with no matching WHEN and no
 * ELSE is NULL, so every DGM registration stored NULL in both: a blank
 * subtitle in the Samples list and a batch number the search box cannot match.
 *
 * Nothing mechanical noticed. The checks above compare the DECLARATIVE tables
 * — `stage_definitions`, `stage_fields`, `sample_prefixes` — and this
 * projection is procedural, a CASE buried in a 130-line function in a
 * migration that predates the stage. Two human-style review lenses found it
 * independently; no test did.
 *
 * So the contract is now read out of the function text. A stage that declares
 * a feed-type field must have an arm filling `sample_label`, and every stage
 * must have an arm filling `test_label`.
 */
function latestRegisterSampleBody(): string {
  // Anchored on the DEFINITION, not on the name. The name also appears in a
  // `drop function`, a `revoke all on function` and a `grant execute on
  // function` — 0026 carries all three — so searching for the bare name finds
  // the trailing grant and reads no body at all. The first version of this
  // helper did exactly that and the suite stopped collecting, which is the
  // cheap way to learn it.
  const defs = [...SQL.matchAll(/create (?:or replace )?function public\.rpc_register_sample\(/g)];
  const last = defs[defs.length - 1];
  if (last === undefined) throw new Error('rpc_register_sample is not defined in any migration');
  const start = last.index;
  const end = SQL.indexOf('\n$$;', start);
  if (end === -1) throw new Error('rpc_register_sample has no terminating $$;');
  return SQL.slice(start, end);
}

/**
 * The stage labels in each `case p_stage` block, in source order.
 *
 * Only `case p_stage` — the `case when p_stage = 'raw_materials'` forms that
 * fill the material and supplier columns are single-stage by construction and
 * cannot go stale when a stage is added.
 */
function stageCaseArms(body: string): string[][] {
  const blocks: string[][] = [];
  let at = body.indexOf('case p_stage');
  while (at !== -1) {
    const end = body.indexOf('end', at);
    const arms = [...body.slice(at, end).matchAll(/when\s+'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((s): s is string => s !== undefined);
    blocks.push(arms);
    at = body.indexOf('case p_stage', end);
  }
  return blocks;
}

describe('the registration projection covers every stage', () => {
  const body = latestRegisterSampleBody();
  const blocks = stageCaseArms(body);

  it('INSTRUMENT: finds exactly the two stage-dispatched projections', () => {
    // Without this the assertions below could pass by reading nothing, which
    // is how the declarative checks missed this defect in the first place.
    expect(blocks).toHaveLength(2);
    for (const arms of blocks) expect(arms.length).toBeGreaterThan(4);
  });

  /** Keys the two projections are fed from, per the function body. */
  const LABEL_KEYS = new Set(['feed_type', 'material_or_feed_type']);
  const TEST_KEYS = new Set(['batch_no', 'batch_or_bin_no', 'run_no', 'delivery_or_lot_no']);

  const declares = (stage: Stage, keys: Set<string>): boolean =>
    STAGE_SCHEMAS[stage].fields.some((f) => keys.has(f.key));

  it('fills sample_label for every stage that has a feed type', () => {
    const want = STAGES.filter((s) => declares(s, LABEL_KEYS)).sort();
    const got = [...(blocks[0] ?? [])].sort();
    expect(
      got,
      'a stage declaring a feed type with no arm here stores NULL and shows a blank subtitle',
    ).toEqual(want);
  });

  it('fills test_label for every stage, because every stage has a batch, lot or run number', () => {
    const want = STAGES.filter((s) => declares(s, TEST_KEYS)).sort();
    const got = [...(blocks[1] ?? [])].sort();
    expect(want, 'every stage should declare one of these').toHaveLength(STAGES.length);
    expect(
      got,
      'a stage with no arm here cannot be found by the search box, which queries this column',
    ).toEqual(want);
  });

  it('POSITIVE CONTROL: dropping an arm is detected', () => {
    const withoutDgm = stageCaseArms(
      body.replace("when 'dgm'           then p_values ->> 'batch_no'\n", ''),
    );
    expect(withoutDgm[1]).not.toContain('dgm');
    expect(blocks[1]).toContain('dgm');
  });
});
