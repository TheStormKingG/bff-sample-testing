/**
 * The Limits sheet was reconciled against the forms (0039), and the lifecycle
 * guard was widened by exactly one move to let that happen.
 *
 * The claims worth holding, in the order they would hurt if they broke:
 *
 *  1. THE GUARD STILL REFUSES EVERYTHING IT REFUSED BEFORE. 0039 restates
 *     `tg_specification_versions_guard` in full to add one transition. A
 *     `create or replace` is a whole-function rewrite, so a dropped line in
 *     the immutability block would make every past rule editable — and
 *     nothing else in the suite would notice, because no test reads that
 *     function. This one does, and counts the transitions.
 *
 *  2. NOTHING BECAME ASSESSABLE. Superseding two rows and adding seven
 *     drafts must change no verdict. `assess()` admits only `approved` with
 *     a recorded approver; this asserts that for the two statuses 0039
 *     actually introduced to the live data.
 *
 *  3. A WITHDRAWAL IS DATED. The schema requires an `effective_to` on a
 *     superseded row, which is what makes "this stopped applying" a fact
 *     rather than a tidy-up.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { assess, type SpecificationRule, type SpecStatus } from '@/lib/assessment';
import { partitionSpecifications } from '@/hooks/useSpecifications';
import type { SpecificationVersionRow } from '@/hooks/useSamples';
import type { MeasurementContext } from '@/lib/assessment';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

/** Every migration, in filename order — which is application order. */
const CORPUS = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), 'utf8') }));

/**
 * The guard as the LAST migration to define it leaves it.
 *
 * Deliberately not "the text in 0039": if a later migration replaces the
 * function again, this test must read that one. A test pinned to a filename
 * stops describing the database the moment someone writes 0040.
 */
function latestGuardBody(): string {
  let found: string | null = null;
  for (const { sql } of CORPUS) {
    // Anchored on the CREATE, not on the name: 0039 also carries a
    // `comment on function` line, which has no body after it and would
    // otherwise be read as the definition.
    for (const m of sql.matchAll(
      /create (?:or replace )?function public\.tg_specification_versions_guard\(\)/g,
    )) {
      const end = sql.indexOf('$$;', m.index!);
      if (end === -1) throw new Error('unterminated guard definition');
      found = sql.slice(m.index!, end);
    }
  }
  if (found === null) throw new Error('no definition of tg_specification_versions_guard found');
  return found;
}

const GUARD = latestGuardBody();

describe('the instrument works before anything it says is believed', () => {
  it('found a realistic corpus and a guard body with something in it', () => {
    expect(CORPUS.length).toBeGreaterThan(30);
    expect(GUARD.length).toBeGreaterThan(500);
  });
});

describe('the lifecycle guard', () => {
  it('still refuses a delete and still freezes a version in place', () => {
    /*
      Not a spot check on one column. 0039 restates the whole function to add
      one line, so the thing to verify is that the rest survived verbatim —
      and the most dangerous omission is silent: a missing column in the
      immutability test makes exactly that column editable, for ever, on
      every rule the plant has ever recorded an assessment against.
    */
    expect(GUARD).toContain('cannot be deleted');
    expect(GUARD).toContain('is immutable. Propose a new version');
    expect(GUARD).toContain('The approver of a specification version cannot be changed');

    for (const frozen of [
      'id',
      'specification_id',
      'version',
      'parameter_key',
      'stage',
      'material_code',
      'feed_type_code',
      'sampling_point',
      'test_method',
      'unit',
      'lower_bound',
      'upper_bound',
      'effective_from',
      'proposed_by',
      'source_evidence',
      'workbook_entry_no',
      'created_at',
    ]) {
      expect(
        GUARD,
        `the immutability test no longer covers ${frozen}: it can now be edited after insert`,
      ).toContain(`new.${frozen} is distinct from old.${frozen}`);
    }
  });

  it('permits exactly six transitions, the last two added for a reason stated in SQL', () => {
    // Parsed rather than grepped, so a SIXTH move slipped in beside the
    // intended one fails here. "Contains reference_only -> superseded" would
    // pass on a guard that also permitted draft -> approved.
    const moves: string[] = [];
    for (const m of GUARD.matchAll(
      /old\.status\s*=\s*'(\w+)'\s*and\s*new\.status\s*(?:=\s*'(\w+)'|in\s*\(([^)]*)\))/g,
    )) {
      const from = m[1]!;
      const tos =
        m[2] !== undefined
          ? [m[2]]
          : (m[3] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
      for (const to of tos) moves.push(`${from} -> ${to}`);
    }
    expect(moves.sort()).toEqual(
      [
        'approved -> superseded',
        'draft -> proposed',
        'draft -> rejected',
        'proposed -> approved',
        'proposed -> rejected',
        'reference_only -> superseded',
        // 0043. A draft holding figures the plant has decided against sits
        // one proposal and one approval away from colouring a quality
        // record, and a rejection would have to name a rejector who never
        // decided anything.
        'draft -> superseded',
      ].sort(),
    );
  });

  it('0039 is where the fifth move came from, and it says why', () => {
    const m = CORPUS.find((c) => c.file.startsWith('0039'));
    expect(m, '0039 is missing from the corpus').toBeDefined();
    expect(m!.sql).toContain("old.status = 'reference_only' and new.status = 'superseded'");
    // A widened guard with no stated reason is the one a later reader
    // narrows again because it looks like an oversight.
    expect(m!.sql).toMatch(/Not a rejection/);
  });
});

describe('nothing 0039 touched can decide anything', () => {
  const rule = (over: Partial<SpecificationRule>): SpecificationRule => ({
    id: 'r',
    version: 1,
    parameterKey: 'extruded_soya.urease',
    stage: 'extruded_soya',
    material: null,
    feedType: null,
    samplingPoint: null,
    testMethod: null,
    unit: '%',
    lowerBound: 1,
    upperBound: 10,
    status: 'reference_only',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    approvedBy: null,
    ...over,
  });

  const ctx: MeasurementContext = {
    stage: 'extruded_soya',
    parameterKey: 'extruded_soya.urease',
    value: 5,
    unit: '%',
    unitConfirmed: true,
    applicable: true,
    material: null,
    feedType: null,
    samplingPoint: null,
    testMethod: null,
    collectionInstant: '2026-11-02T12:00:00.000Z',
  };

  // The two statuses 0039 actually put into the live data. A value of 5
  // sits inside the 1-10 bounds, so a rule that could decide anything would
  // return `within_limit` here — which is exactly what must not happen.
  it.each<SpecStatus>(['superseded', 'draft'])('a %s rule assesses nothing', (status) => {
    const a = assess(ctx, [rule({ status })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('no_approved_rule');
  });

  it('the control: the same rule DOES decide once approved', () => {
    // Without this, the three assertions above would pass on a context the
    // engine rejects for some unrelated reason — a wrong stage, a unit
    // mismatch, a value outside the effective window.
    const a = assess(ctx, [rule({ status: 'approved', approvedBy: 'someone' })]);
    expect(a.result).toBe('within_limit');
  });
});

describe('a withdrawal is dated', () => {
  it('the schema will not accept a superseded row with no end', () => {
    const ddl = CORPUS.find((c) => c.file.startsWith('0003'))!.sql;
    expect(ddl).toContain('specification_versions_superseded_has_end');
    expect(ddl).toMatch(/status <> 'superseded' or effective_to is not null/);
  });

  it('0039 supplies one on both rows it withdraws', () => {
    const m = CORPUS.find((c) => c.file.startsWith('0039'))!.sql;
    const supersedes = [...m.matchAll(/set status = 'superseded',\s*\n\s*effective_to = now\(\)/g)];
    expect(supersedes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The screen's own arithmetic
// ---------------------------------------------------------------------------

describe('the limits screen counts the IMPORT, not what survived it', () => {
  /*
    THE DEFECT THIS EXISTS FOR, found on the live site minutes after 0039.

    The screen splits versions by STATUS: `reference_only` on one side,
    everything else on the other. The moment two workbook entries were
    withdrawn, both moved to the "rules inside the approval workflow" side —
    which they are not and never were — and the import check saw 32 of 34 and
    announced, in red, that the import was incomplete or duplicated.

    It was neither. Nothing was missing; two entries had been retired on
    purpose. A false alarm on a quality screen is worse than no alarm: it
    teaches the reader that the red text is noise, and the next one is real.

    What identifies an imported row is `workbook_entry_no` — set at import,
    frozen by the guard. Status says what has happened since. So the split is
    by provenance and the count is over every row that came from the
    workbook, withdrawn or not.
  */
  const row = (over: Partial<SpecificationVersionRow>): SpecificationVersionRow =>
    ({
      id: Math.random().toString(36).slice(2),
      specification_id: 's',
      version: 1,
      parameter_key: 'x.y',
      stage: 'ground',
      material: null,
      feed_type: null,
      sampling_point: null,
      test_method: null,
      unit: null,
      lower_bound: null,
      upper_bound: null,
      status: 'reference_only',
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_to: null,
      proposed_by: null,
      proposed_by_name: null,
      approved_by: null,
      approved_by_name: null,
      approved_at: null,
      decision_reason: null,
      source_note: 's',
      workbook_entry_no: 1,
      workbook_status: 'To set',
      sample_label: null,
      test_label: null,
      // The spread was missing here on the first attempt, and `as` swallowed
      // it: every row came back with the defaults, three assertions failed
      // loudly, and had they happened to agree with the defaults they would
      // have passed while testing one fixed row four times over.
      ...over,
    }) as SpecificationVersionRow;

  it('keeps a withdrawn workbook entry out of the approval workflow', () => {
    const set = partitionSpecifications([
      row({ workbook_entry_no: 25, status: 'superseded' }),
      row({ workbook_entry_no: 26, status: 'superseded' }),
      row({ workbook_entry_no: 1, status: 'reference_only' }),
      row({ workbook_entry_no: null, status: 'draft' }),
    ]);
    expect(set.reference).toHaveLength(1);
    expect(set.withdrawn).toHaveLength(2);
    // The one row with no workbook provenance. A withdrawn IMPORT is not a
    // rule somebody is drafting, and listing it as one is how the screen
    // came to claim the import was broken.
    expect(set.rules).toHaveLength(1);
    expect(set.rules[0]!.status).toBe('draft');
  });

  it('the import total is unchanged by a withdrawal', () => {
    const imported = [
      row({ workbook_entry_no: 1 }),
      row({ workbook_entry_no: 2 }),
      row({ workbook_entry_no: 3 }),
    ];
    const before = partitionSpecifications(imported);
    const after = partitionSpecifications([
      imported[0]!,
      imported[1]!,
      { ...imported[2]!, status: 'superseded' },
    ]);
    expect(before.reference.length + before.withdrawn.length).toBe(3);
    expect(after.reference.length + after.withdrawn.length).toBe(3);
    // And the control: the figure the screen USED to compute does move, which
    // is precisely the false alarm.
    expect(before.reference.length).toBe(3);
    expect(after.reference.length).toBe(2);
  });

  it('a locally authored draft is never counted as an import', () => {
    // The six parameters 0039 added have no workbook entry number. If they
    // were counted, the import check would read 40 of 34 and cry wolf in the
    // other direction.
    const set = partitionSpecifications([
      row({ workbook_entry_no: 1 }),
      row({ workbook_entry_no: null, status: 'draft' }),
      row({ workbook_entry_no: null, status: 'draft' }),
    ]);
    expect(set.reference.length + set.withdrawn.length).toBe(1);
    expect(set.rules).toHaveLength(2);
  });

  it('only an approved rule with a recorded approver is counted as approved', () => {
    const set = partitionSpecifications([
      row({ workbook_entry_no: null, status: 'approved', approved_by: 'p1' }),
      row({ workbook_entry_no: null, status: 'approved', approved_by: null }),
      row({ workbook_entry_no: null, status: 'draft' }),
    ]);
    expect(set.approvedCount).toBe(1);
  });
});
