/**
 * Every column the dashboard queries by name exists on the table.
 *
 * ===========================================================================
 * THE BUG THIS EXISTS FOR, WHICH LIVED FROM THE FIRST COMMIT TO 2026-11-03
 * ===========================================================================
 * `DashboardPage` filtered "samples collected today" on `collected_at`. The
 * column is `collection_instant` and always has been. Every one of those
 * requests came back 400, and the page rendered "Count not available" for
 * every stage — which is its CORRECT behaviour for a failed query, and is
 * indistinguishable from a plant that has not recorded anything yet.
 *
 * So the failure mode was: a wrong string, a 400 on every load, an honest
 * dash on screen, and nobody with a reason to look. It survived a typed
 * codebase because a PostgREST column name is a string; it survived the
 * test suite because the suite mocks Supabase, and a mock answers whatever
 * it is asked; and it survived e2e because those runs have no real project
 * and intercept the network. Three layers of checking, none of which could
 * see it — the check has to compare the name against the SCHEMA.
 *
 * ===========================================================================
 * WHY THE MIGRATIONS ARE THE SOURCE
 * ===========================================================================
 * They are the only description of the table available offline, they are in
 * the repository, and they are what the live database was built from. A test
 * that reached the real project would be more direct and would also need
 * credentials in CI, which is a worse trade for a string comparison.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

const SOURCE = readFileSync(join(process.cwd(), 'src/pages/DashboardPage.tsx'), 'utf8');

/**
 * Columns on `public.samples`: those declared in its CREATE TABLE, plus
 * every one added later by ALTER TABLE.
 *
 * A later DROP COLUMN is deliberately NOT subtracted. This asserts that a
 * name was never invented, and a dropped column would still be wrong to
 * query — but it would be wrong in a way the 0046-style migrations already
 * assert directly, and modelling drops here would mean modelling the whole
 * schema's history to catch nothing new.
 */
function samplesColumns(): Set<string> {
  const create = /create table (?:if not exists )?public\.samples\s*\(([\s\S]*?)\n\);/i.exec(SQL);
  if (create === null) throw new Error('no CREATE TABLE public.samples found in the migrations');

  const columns = new Set<string>();
  for (const line of create[1]!.split('\n')) {
    const m = /^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
    // Skips table-level constraints, which start with `constraint`/`primary`
    // etc. — they match the shape, so they are excluded by name.
    if (m !== null && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(m[1]!)) {
      columns.add(m[1]!);
    }
  }
  for (const m of SQL.matchAll(
    /alter table (?:only )?public\.samples\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)/gi,
  )) {
    columns.add(m[1]!);
  }
  return columns;
}

describe('the instrument works before anything it says is believed', () => {
  it('found the table and a plausible set of columns', () => {
    const columns = samplesColumns();
    expect(columns.size).toBeGreaterThan(10);
    // Three spot checks: one from the original table, one added later, and
    // one that must NOT be there — the name the bug used.
    expect(columns).toContain('capture_state');
    expect(columns).toContain('outside_limit_flag');
    expect(columns.has('collected_at')).toBe(false);
  });

  it('found the column constants in the page', () => {
    expect([...SOURCE.matchAll(/^const COL_[A-Z_]+ = '([a-z_]+)';$/gm)]).not.toHaveLength(0);
  });
});

describe('every samples column the dashboard names exists', () => {
  it('matches the schema, constant for constant', () => {
    const columns = samplesColumns();
    const wrong: string[] = [];
    for (const m of SOURCE.matchAll(/^const (COL_[A-Z_]+) = '([a-z_]+)';$/gm)) {
      if (!columns.has(m[2]!)) wrong.push(`${m[1]} = '${m[2]}'`);
    }
    expect(
      wrong,
      'the dashboard filters on a column `public.samples` does not have. Every such ' +
        'request returns 400 and the page renders an honest dash, which looks exactly ' +
        'like a plant with no samples yet — so this will not be noticed on screen.',
    ).toEqual([]);
  });

  it('CONTROL: an invented column name is caught', () => {
    // Without this, a regex that matched nothing would pass the test above
    // for the same reason the bug survived three other layers of checking.
    const columns = samplesColumns();
    expect(columns.has('collected_at')).toBe(false);
    expect(columns.has('not_a_real_column')).toBe(false);
  });
});
