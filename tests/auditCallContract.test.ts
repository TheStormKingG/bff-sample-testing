/**
 * Every named argument in a `record_audit_event` call is a real parameter.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * `rpc_set_sieve_series` (0032) and `rpc_set_dgm_target_ranges` (0034) both
 * called `record_audit_event` with `p_actor`, `p_basis` and `p_app_version`.
 * The real parameters are `p_actor_id`, `p_authority_basis` and
 * `p_deployment_version`. Every such call raised 42883 at the last statement
 * before the return, so NEITHER WRITER HAD EVER SUCCEEDED on any deployment —
 * `audit_events` held zero rows for both actions — and the sieve-table editor
 * had been unusable since the day it shipped.
 *
 * Nothing caught it, and the reason is structural rather than careless:
 * plpgsql resolves a called function's name at EXECUTION time, so a wrong
 * argument name is accepted by `create function`, survives deployment, and is
 * invisible to a repository whose 1280 tests are all TypeScript. The defect
 * can only be observed by running the function, and the only place it ran was
 * production.
 *
 * So this reads the SQL as text. It is a static check and it is cheap, which
 * is the point: it runs in the ordinary suite, before the migration is ever
 * applied anywhere. Migration 0035 carries the same question to the live
 * catalogue, where it can also see a function this repository did not write.
 *
 * ===========================================================================
 * THE GENERAL RULE IT ENFORCES
 * ===========================================================================
 * Named-argument syntax is the only call style in this schema that can be
 * wrong without being noticed — a positional call with too few arguments
 * fails at `create` time, a misspelled FUNCTION name fails loudly on first
 * call, but a misspelled ARGUMENT name produces a "function does not exist"
 * that names a signature nobody wrote and reads like a type problem.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * SQL with `--` comments removed.
 *
 * Needed because this project's migrations explain themselves at length, and
 * 0035's own header QUOTES the broken call it fixes. A `--` is treated as a
 * comment only when an even number of apostrophes precedes it on the line, so
 * a literal containing two dashes is left alone. Imperfect, and deliberately
 * imperfect in the safe direction: a mis-parse leaves MORE text in, which can
 * only produce a spurious failure to investigate, never a silent pass.
 */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === '-' && line[i + 1] === '-') {
          const before = line.slice(0, i);
          const quotes = (before.match(/'/g) ?? []).length;
          if (quotes % 2 === 0) return before;
        }
      }
      return line;
    })
    .join('\n');
}

/** The text between the parentheses of the call or declaration at `open`. */
function parenthesised(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  throw new Error('Unbalanced parentheses in a migration.');
}

interface Call {
  readonly file: string;
  /** The function the call sits inside, or `null` at the top level. */
  readonly owner: string | null;
  readonly args: readonly string[];
}

/**
 * Where each `create [or replace] function public.NAME(` body begins and
 * ends, so a call can be attributed to the function that contains it.
 *
 * The body is dollar-quoted (`as $$ ... $$`), which is unambiguous: there is
 * no nesting of `$$` anywhere in these migrations.
 */
function functionBodies(sql: string): { name: string; from: number; to: number }[] {
  const out: { name: string; from: number; to: number }[] = [];
  const pattern = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const open = sql.indexOf('$$', match.index);
    if (open < 0) continue;
    const close = sql.indexOf('$$', open + 2);
    if (close < 0) continue;
    out.push({ name: match[1]!.toLowerCase(), from: match.index, to: close + 2 });
  }
  return out;
}

/**
 * Every `record_audit_event(...)` in the migrations, split into the
 * declaration shapes and the call sites.
 */
function scan(): { declarations: string[][]; calls: Call[] } {
  const declarations: string[][] = [];
  const calls: Call[] = [];

  for (const file of migrationFiles()) {
    const sql = withoutComments(readFileSync(join(MIGRATIONS, file), 'utf8'));
    const bodies = functionBodies(sql);
    const pattern = /record_audit_event\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      const open = match.index + match[0].length - 1;
      const head = sql.slice(Math.max(0, match.index - 60), match.index);
      const inside = parenthesised(sql, open);

      if (/create\s+(or\s+replace\s+)?function\s+public\.$/i.test(head)) {
        declarations.push(
          [...inside.matchAll(/(\bp_[a-z_]+)\s+[a-z]/gi)].map((m) => m[1]!),
        );
        continue;
      }
      // `comment on function`, `revoke`, `grant` and `drop` name the function
      // with its argument TYPES, never with `=>`, so they contribute nothing
      // and need no special case.
      const args = [...inside.matchAll(/(\bp_[a-z_]+)\s*=>/g)].map((m) => m[1]!);
      if (args.length === 0) continue;
      const owner = bodies.find((b) => match!.index > b.from && match!.index < b.to);
      calls.push({ file, owner: owner?.name ?? null, args });
    }
  }
  return { declarations, calls };
}

/**
 * The call sites that are actually in force.
 *
 * ===========================================================================
 * A MIGRATION THAT HAS RUN IS A RECORD OF WHAT HAPPENED
 * ===========================================================================
 * This project does not edit applied migrations; a defective function is
 * corrected by a LATER migration that replaces it. 0035 does exactly that for
 * the two broken writers, so the wrong argument names still stand in 0032 and
 * 0034 and always will. Checking every call site in file order would make
 * this test permanently red and teach the next reader to edit history.
 *
 * So the last definition of each function wins, exactly as it does in the
 * database — the same reasoning as the seed model in `registryDatabaseContract`,
 * which had to learn that replaying a change log in anything but statement
 * order is wrong as soon as two changes touch the same thing.
 */
function liveCalls(all: readonly Call[]): Call[] {
  const byOwner = new Map<string, Call>();
  const loose: Call[] = [];
  for (const call of all) {
    if (call.owner === null) loose.push(call);
    else byOwner.set(call.owner, call);
  }
  return [...loose, ...byOwner.values()];
}

const { declarations, calls } = scan();

describe('calls to record_audit_event', () => {
  it('finds the declaration and a realistic number of call sites', () => {
    // The guard on the parser itself. A regex that quietly matched nothing
    // would make every assertion below vacuously true, which is exactly the
    // failure mode that let the original defect through.
    expect(declarations.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('declares the three parameters the broken calls got wrong', () => {
    // Named explicitly, so this file still means something if the parser is
    // ever rewritten: these are the real names, and the wrong ones were
    // p_actor, p_basis and p_app_version.
    const latest = declarations[declarations.length - 1]!;
    expect(latest).toContain('p_actor_id');
    expect(latest).toContain('p_authority_basis');
    expect(latest).toContain('p_deployment_version');
    expect(latest).not.toContain('p_actor');
    expect(latest).not.toContain('p_basis');
    expect(latest).not.toContain('p_app_version');
  });

  it('attributes every call to the function that contains it', () => {
    // Without this the supersession rule below is silent: a call with no
    // owner is never superseded, so a parser that failed to find the
    // enclosing function would check everything in file order and go red on
    // history that a later migration already corrected.
    expect(calls.every((call) => call.owner !== null)).toBe(true);
  });

  it('uses only argument names the function actually has, in the definitions that are in force', () => {
    // The union across declarations, because 0012 redeclares the function
    // with one parameter more than 0006 and a migration is a record of what
    // happened: an older call site was correct against the shape of its day.
    const known = new Set(declarations.flat());
    const wrong = liveCalls(calls).flatMap((call) =>
      call.args.filter((arg) => !known.has(arg)).map((arg) => `${call.file}: ${arg}`),
    );
    expect(
      wrong,
      'a migration calls record_audit_event with an argument name it does not have. ' +
        'plpgsql resolves this at execution time, so the function will deploy, ' +
        'type-check and then raise 42883 the first time somebody uses it. ' +
        'Correct it in a NEW migration that replaces the function: the one ' +
        'that is wrong has already been applied.',
    ).toEqual([]);
  });
});
