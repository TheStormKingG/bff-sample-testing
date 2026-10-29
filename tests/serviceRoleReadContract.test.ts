/**
 * Every table an Edge Function reads directly must be one service_role may read.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * An administrator could not create an account. It failed with a bare
 * `internal`, and had never worked — there was no successful
 * `admin_action.create_account` anywhere in the live audit log.
 *
 * `refuseIfAddressTaken` checks the address with a direct PostgREST read,
 * `admin.from('profiles')…`, on the service-role client. Measured on the live
 * database by impersonation:
 *
 *     set local role service_role; select count(*) from public.profiles;
 *       -> ERROR: permission denied for table profiles
 *
 * `service_role` held REFERENCES, TRIGGER and TRUNCATE on every table in
 * `public` and nothing else, except SELECT on `audit_events`. The same probe
 * refused all five tables the Edge Functions read directly and returned
 * `audit_events` as readable, so the measurement discriminated rather than
 * failing uniformly.
 *
 * ===========================================================================
 * WHAT THIS GATE IS, AND WHAT IT HONESTLY IS NOT
 * ===========================================================================
 * It compares two things that are both IN THE REPOSITORY: the set of tables
 * the functions read, and the set the migration declares and grants. It does
 * NOT read the live database, and it cannot — vitest has no connection, CI
 * provisions no Postgres, and the live grant state was established partly by
 * the platform rather than by any migration in this repo.
 *
 * So this gate proves the migration's list matches the code. The claim that
 * the GRANT actually took effect is proved on the other side, by
 * `assert_service_role_reads()`, which runs inside migration 0023 and fails
 * the migration if any declared table is unreadable. Neither half is
 * sufficient alone, and saying so is the point: a repo-only test that claimed
 * to verify live privileges would be the exact false confidence that let this
 * defect ship.
 *
 * The pairing matters a second way. CI runs `npm test` and no database gate at
 * all — `verify:schema`, `verify:sql`, `verify:rls` and `verify:db` are
 * declared in package.json and appear in no workflow. A check placed only in
 * SQL would run when somebody remembered to apply migrations; this half runs
 * on every push.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const FUNCTIONS = join(REPO, 'supabase', 'functions');
const MIGRATION = join(REPO, 'supabase', 'migrations', '0023_service_role_table_reads.sql');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Source with comments stripped, so prose about a table cannot satisfy a check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface DirectRead {
  readonly table: string;
  readonly where: string;
}

/** Every `.from('<table>')` in the Edge Functions, with where it is. */
function directReads(): readonly DirectRead[] {
  const out: DirectRead[] = [];
  for (const path of tsFiles(FUNCTIONS)) {
    const src = code(readFileSync(path, 'utf8'));
    const rel = path.slice(REPO.length + 1);
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)/g)) {
        const table = m[1];
        if (table !== undefined) out.push({ table, where: `${rel}:${i + 1}` });
      }
    });
  }
  return out;
}

/** The tables migration 0023 declares in `c_tables`. */
function declaredTables(): readonly string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = /c_tables\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/.exec(sql);
  if (block === null) return [];
  return [...(block[1] ?? '').matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1] ?? '');
}

/** The tables migration 0023 actually grants SELECT on. */
function grantedTables(): readonly string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  return [
    ...sql.matchAll(/grant\s+select\s+on\s+public\.([a-z_][a-z0-9_]*)\s+to\s+service_role/gi),
  ].map((m) => m[1] ?? '');
}

describe('the service-role read contract', () => {
  it('finds both sides, so a pass is not vacuous', () => {
    // Without this, a broken matcher reports a clean contract in exactly the
    // same words as a correct one — which is how earlier instances of this
    // defect class survived their own gates.
    const reads = directReads();
    expect(reads.length, 'no direct reads found — the matcher is broken').toBeGreaterThanOrEqual(5);
    expect(declaredTables().length).toBeGreaterThanOrEqual(5);
    expect(
      reads.some((r) => r.table === 'profiles' && r.where.includes('admin.ts')),
      'the read that caused the incident was not found',
    ).toBe(true);
  });

  it('declares every table an Edge Function reads directly', () => {
    const declared = new Set(declaredTables());
    const undeclared = directReads().filter((r) => !declared.has(r.table));

    // THE ASSERTION THAT FAILS BEFORE THE FIX. Against the code as it stood,
    // all five reads were undeclared and ungranted, and the message names the
    // file, the line and the consequence.
    expect(
      undeclared.map(
        (r) =>
          `${r.where} reads '${r.table}' directly on the service-role client, ` +
          `and nothing grants service_role SELECT on it. The request fails with ` +
          `a bare "internal" and the operator is told nothing they can act on.`,
      ),
    ).toEqual([]);
  });

  it('grants SELECT on every table it declares', () => {
    // The declaration and the grant are two statements in one file, and a
    // declaration without its grant would pass the check above while leaving
    // the table unreadable.
    const granted = new Set(grantedTables());
    const missing = declaredTables().filter(
      (t) => !granted.has(t) && t !== 'audit_events', // granted by 0006, deliberately
    );
    expect(missing).toEqual([]);
  });

  it('declares nothing it does not read, so the grant cannot quietly widen', () => {
    // A stale entry here is a privilege nobody needs. `audit_events` is read
    // through the RPC layer rather than `.from()`, and is in the list as the
    // positive control for the SQL assertion, so it is exempt by name.
    const read = new Set(directReads().map((r) => r.table));
    const unused = declaredTables().filter((t) => !read.has(t) && t !== 'audit_events');
    expect(
      unused.map((t) => `'${t}' is granted to service_role but no function reads it directly`),
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: an undeclared table would be caught', () => {
    // Proves the comparison discriminates, rather than passing because both
    // sides are empty or because the matcher never rejects anything.
    const declared = new Set(declaredTables());
    expect(declared.has('profiles')).toBe(true);
    expect(declared.has('a_table_nobody_declared')).toBe(false);
  });

  it('the SQL half asserts the live state, and says so', () => {
    // This file cannot see the database. The claim that the grant took effect
    // belongs to the migration, and it must actually be invoked there — a
    // function defined and never called would assert nothing.
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/create or replace function public\.assert_service_role_reads/);
    expect(sql).toMatch(/has_table_privilege\(\s*'service_role'/);
    expect(sql).toMatch(/select public\.assert_service_role_reads\(\);/);
    // And the project's existing one-directional guard is still re-run.
    expect(sql).toMatch(/select public\.assert_function_privileges\(\);/);
  });
});
