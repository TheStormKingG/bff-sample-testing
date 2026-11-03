/**
 * Approving a limit re-judges the records it applies to (0040).
 *
 * ===========================================================================
 * WHAT THIS FILE CAN AND CANNOT PROVE
 * ===========================================================================
 * The sweep is plpgsql. Its BEHAVIOUR is proved by the rolled-back
 * end-to-end probe inside migration 0040 itself, which registers a sample,
 * records a measurement, approves a rule by a second person, and asserts
 * that the stored verdict moved from `not_assessable` to `within_limit`,
 * that the evidence row says `controlled_reassessment` and names what it
 * replaces, and that approving an unrelated parameter writes nothing. That
 * probe runs against a real database every time the migration is applied,
 * which is a stronger instrument than anything available here.
 *
 * What this file does is guard the three properties a later edit would
 * plausibly break without any of that firing:
 *
 *  1. THE TWO CALLERS OF THE ENGINE STAY IN STEP. `apply_measurement` judges
 *     a value at entry and the sweep re-judges it later. If their argument
 *     lists drift, the same measurement gets two different answers depending
 *     on when it was looked at — and the one in the database would be the
 *     wrong one.
 *
 *  2. THE TRIGGER STAYS NARROW. It must fire on a transition INTO approved
 *     and nothing else. Widened to every update, it would rewrite quality
 *     verdicts on edits that decided nothing.
 *
 *  3. THE PRIOR ASSESSMENT IS FOUND BY CHAIN POSITION, NOT BY CLOCK. This is
 *     the bug the first run actually hit, and it is the kind a reader
 *     "simplifies" back in.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

const CORPUS = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), 'utf8') }));

const ALL = CORPUS.map((c) => c.sql).join('\n');
const SWEEP = CORPUS.find((c) => c.file.startsWith('0040'))?.sql ?? '';

/**
 * The body of the LAST definition of a function in the corpus.
 *
 * Not "every occurrence in every migration". `apply_measurement` has been
 * redefined several times, and a scan over the concatenated corpus finds
 * nine calls to the engine — eight of them in superseded bodies that no
 * longer run. Comparing those would be comparing history.
 */
function latestFunctionBody(name: string): string {
  let found: string | null = null;
  for (const { sql } of CORPUS) {
    for (const m of sql.matchAll(
      new RegExp(`create (?:or replace )?function public\\.${name}\\(`, 'g'),
    )) {
      const end = sql.indexOf('$$;', m.index!);
      if (end === -1) throw new Error(`unterminated definition of ${name}`);
      found = sql.slice(m.index!, end);
    }
  }
  if (found === null) throw new Error(`no definition of ${name} found`);
  return found;
}

/** The argument list of a `public.evaluate_measurement(...)` call, normalised. */
function evaluateCallArgs(sql: string): string[][] {
  const out: string[][] = [];
  for (const m of sql.matchAll(/public\.evaluate_measurement\(/g)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    const start = i + 1;
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = sql.slice(start, i);
    // Split on top-level commas, drop comments, collapse whitespace.
    const args: string[] = [];
    let cur = '';
    let d = 0;
    for (const ch of body) {
      if (ch === '(') d++;
      else if (ch === ')') d--;
      if (ch === ',' && d === 0) {
        args.push(cur);
        cur = '';
      } else cur += ch;
    }
    args.push(cur);
    out.push(
      args.map((a) =>
        a
          .replace(/--[^\n]*/g, '')
          .trim()
          .replace(/\s+/g, ' '),
      ),
    );
  }
  return out;
}

describe('the instrument works before anything it says is believed', () => {
  it('found the migration and both call sites', () => {
    expect(CORPUS.length).toBeGreaterThan(30);
    expect(SWEEP.length).toBeGreaterThan(1000);
    expect(latestFunctionBody('apply_measurement').length).toBeGreaterThan(500);
    expect(latestFunctionBody('reassess_parameter').length).toBeGreaterThan(500);
    // The corpus as a whole holds many historical calls. That is exactly why
    // the comparison below reads the latest definitions instead.
    expect(evaluateCallArgs(ALL).length).toBeGreaterThan(2);
  });
});

describe('the sweep judges a value exactly as recording it would', () => {
  it('passes the engine the same eleven arguments as apply_measurement', () => {
    /*
      THE DIVERGENCE THIS PREVENTS, which this codebase has already been
      bitten by once in a different form (0035, where a called function's
      argument NAMES had drifted and two writers silently recorded nothing).

      `evaluate_measurement` takes eleven positional arguments. Its two
      callers answer the same question — "what is the verdict on this
      value?" — at different moments. Let one start passing the sample's
      feed type where the other passes null, and a measurement's verdict
      depends on whether anybody has approved a limit since it was typed.
      That is not a cosmetic inconsistency: it is the database disagreeing
      with itself about a quality decision.

      Compared by SHAPE rather than by text, because the two sites legitimately
      name their row variables differently — `v_sample.stage` against
      `v_row.stage`. What must match is the count, and which positions are
      hard-coded `null`.
    */
    const atEntry = evaluateCallArgs(latestFunctionBody('apply_measurement'));
    const onSweep = evaluateCallArgs(latestFunctionBody('reassess_parameter'));
    expect(atEntry, 'apply_measurement no longer calls the engine').toHaveLength(1);
    expect(onSweep, 'the sweep no longer calls the engine').toHaveLength(1);

    const first = atEntry[0]!;
    const second = onSweep[0]!;
    expect(first).toHaveLength(11);
    expect(second).toHaveLength(11);

    const nullPositions = (args: string[]): number[] =>
      args.map((a, i) => (a === 'null' ? i : -1)).filter((i) => i >= 0);
    expect(
      nullPositions(first),
      'the two callers hard-code null in different positions, so the same value ' +
        'would be judged against a different context at entry and on reassessment',
    ).toEqual(nullPositions(second));

    // Positions 7 and 9 are feed type and test method: null at both sites
    // today, and the comparison above is meaningless if neither has any.
    expect(nullPositions(first).length).toBeGreaterThan(0);
  });
});

describe('the trigger stays narrow', () => {
  it('fires after update, and returns early unless the row has just become approved', () => {
    expect(SWEEP).toMatch(/after update on public\.specification_versions/);
    // Both halves of the guard. `new.status <> 'approved'` alone would fire
    // on every later edit of an approved row; the `old.status` half alone
    // would fire on a rejection.
    expect(SWEEP).toContain("if new.status <> 'approved'");
    expect(SWEEP).toContain("old.status is not distinct from 'approved'");
  });

  it('the sweep is callable by the trigger and by nobody else', () => {
    // `security definer` without a revoke is a function any signed-in
    // account can call to rewrite every stored quality verdict.
    expect(SWEEP).toMatch(
      /revoke all on function public\.reassess_parameter\(text, uuid\) from public, anon, authenticated/,
    );
    expect(SWEEP).toContain('security definer');
    expect(SWEEP).toContain("set search_path = ''");
  });

  it('writes nothing when the verdict did not move', () => {
    // The `continue` is what keeps the evidence table readable. Without it
    // every approval appends a row per measurement saying nothing happened.
    expect(SWEEP).toMatch(/is not distinct from v_row\.assessment_result/);
    expect(SWEEP).toMatch(/\bcontinue;/);
  });
});

describe('the prior assessment is found by chain position, not by clock', () => {
  it('does not order assessments by evaluated_at to pick the one to supersede', () => {
    /*
      `evaluated_at` defaults to now(), which is the TRANSACTION start time.
      Two assessments written in one transaction share it exactly, so
      ordering by it picks between them arbitrarily — and the loser is a
      decision silently dropped out of the supersession chain.

      The first run of 0040 hit this in its own assertion and reported a
      working sweep as broken. The fix is to take the row nothing else
      supersedes, which is unique by construction and needs no clock.
    */
    const fn = SWEEP.slice(
      SWEEP.indexOf('function public.reassess_parameter'),
      SWEEP.indexOf('revoke all on function public.reassess_parameter'),
    );
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).toContain('not exists (select 1 from public.assessments b where b.supersedes = a.id)');
    expect(
      fn,
      'the prior-assessment lookup orders by evaluated_at again: two rows written in ' +
        'one transaction share that instant, so this picks arbitrarily',
    ).not.toMatch(/order by a\.evaluated_at/);
  });
});

describe('the migration proves itself against a real database', () => {
  it('carries a rolled-back end-to-end probe, and rolls it back', () => {
    // Text, because the probe cannot run here. What is guarded is that it
    // exists and that it undoes itself — a probe that committed would leave
    // a fake sample and an approved limit in a production project.
    expect(SWEEP).toContain('BFF_0040_PRECONDITION');
    expect(SWEEP).toContain('BFF_0040_SWEEP');
    expect(SWEEP).toContain('BFF_0040_EVIDENCE');
    expect(SWEEP).toContain('BFF_0040_NOOP');
    expect(SWEEP).toContain('BFF_0040_ROLLBACK');
    expect(SWEEP).toMatch(/raise exception 'BFF_0040_ROLLBACK'/);
  });
});
