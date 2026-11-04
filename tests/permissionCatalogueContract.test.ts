/**
 * SQL <-> TypeScript PERMISSION CATALOGUE CONTRACT.
 *
 * `src/lib/roles.ts` carries a list of permission names and a map of which
 * role holds which. The database carries the same two facts, in the
 * `app_permission` enum and the `role_permissions` table, and the database is
 * the one that decides: every write goes through an RPC that calls
 * `require_permission`, and every read is filtered by an RLS policy calling
 * `has_permission`.
 *
 * Nothing enforced that the two agreed, and the drift is silent in both
 * directions:
 *
 *   1. A permission in the enum that `roles.ts` has never heard of. The UI
 *      cannot offer the action, cannot show the button, and cannot explain the
 *      refusal when somebody reaches the path another way. The feature exists
 *      in the database and is invisible.
 *
 *   2. A permission in `roles.ts` that the enum does not have. The UI shows
 *      the control, the person uses it, and the RPC refuses with a cast error
 *      on a value that is not a member of the type — a 500 rather than a
 *      stated denial.
 *
 *   3. A grant the two disagree about. Worse than either: the UI says you may
 *      and the database says you may not, or the reverse. The second shape is
 *      a control that exists only in the interface, which is the one failure
 *      an audit cares about.
 *
 * This reads both sides as text — the migrations and the TypeScript — and
 * compares them. It needs no database, so it runs on every push, which is
 * where this class of drift has to be caught.
 *
 * WHAT IT CANNOT TELL YOU: whether the live project's `role_permissions` rows
 * match the migrations. A row inserted by hand into the hosted project is
 * invisible here. `scripts/verify-rls.sh` is the check for that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSIONS, ROLES, basePermissions, type Role } from '@/lib/roles';

const REPO = process.cwd();
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

const SQL = migrationSql();

/**
 * Every member of `public.app_permission`, from the CREATE TYPE and from every
 * later `ADD VALUE`.
 *
 * Both forms matter. A new enum member cannot be used in the same transaction
 * that adds it, so this schema adds permissions in a migration of their own
 * (0049 contains three `add value` statements and nothing else). A parser that
 * read only the CREATE TYPE would report those three as absent from the
 * database and send somebody looking for a bug in `roles.ts`.
 */
function enumMembers(): Set<string> {
  const members = new Set<string>();

  const created = /create\s+type\s+(?:public\.)?app_permission\s+as\s+enum\s*\(([\s\S]*?)\)\s*;/i.exec(
    SQL,
  );
  if (created) {
    for (const m of created[1]!.matchAll(/'([^']+)'/g)) members.add(m[1]!);
  }

  for (const m of SQL.matchAll(
    /alter\s+type\s+(?:public\.)?app_permission\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'/gi,
  )) {
    members.add(m[1]!);
  }

  return members;
}

/**
 * The role -> permission grants, as the migrations leave them.
 *
 * `role_permissions` is written by INSERT and amended by DELETE, so the net
 * grant is the inserts minus the deletes, in file order. A parser that read
 * only the inserts would assert that a permission deliberately withdrawn from
 * a role is still held — and would then demand `roles.ts` grant it back.
 */
function sqlGrants(): Map<string, Set<string>> {
  const grants = new Map<string, Set<string>>();
  const add = (role: string, permission: string) => {
    const set = grants.get(role) ?? new Set<string>();
    set.add(permission);
    grants.set(role, set);
  };

  for (const block of SQL.matchAll(
    /insert\s+into\s+(?:public\.)?role_permissions\s*\([^)]*\)\s*values([\s\S]*?);/gi,
  )) {
    for (const pair of block[1]!.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) {
      add(pair[1]!, pair[2]!);
    }
  }

  // `delete from role_permissions where role = 'x' and permission = 'y'`,
  // in either field order.
  for (const d of SQL.matchAll(
    /delete\s+from\s+(?:public\.)?role_permissions\s+where([\s\S]*?);/gi,
  )) {
    const where = d[1]!;
    const role = /role\s*=\s*'([^']+)'/i.exec(where)?.[1];
    const permission = /permission\s*=\s*'([^']+)'/i.exec(where)?.[1];
    if (role && permission) grants.get(role)?.delete(permission);
  }

  return grants;
}

const ENUM = enumMembers();
const GRANTS = sqlGrants();

describe('permission catalogue: the parsers themselves', () => {
  // Without these, every assertion below passes against an empty parse, which
  // is the one result that looks identical to agreement.
  it('parsed the app_permission enum', () => {
    expect(ENUM.size).toBeGreaterThan(15);
    expect(ENUM.has('sample.view')).toBe(true);
  });

  it('picked up members added by a later ALTER TYPE, not just the CREATE TYPE', () => {
    const created = /create\s+type\s+(?:public\.)?app_permission\s+as\s+enum\s*\(([\s\S]*?)\)\s*;/i.exec(
      SQL,
    );
    const inCreate = new Set(
      [...(created?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!),
    );
    const added = [...ENUM].filter((p) => !inCreate.has(p));
    expect(added.length, 'no ALTER TYPE ... ADD VALUE was parsed').toBeGreaterThan(0);
  });

  it('parsed the role grants for every role the application knows', () => {
    const missing = ROLES.filter((r) => !GRANTS.has(r));
    expect(missing, `no role_permissions rows parsed for: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('permission catalogue: the two sides list the same permissions', () => {
  it('has no database permission the application has never heard of', () => {
    const unknown = [...ENUM].filter((p) => !(PERMISSIONS as readonly string[]).includes(p)).sort();
    expect(
      unknown,
      `in app_permission but not in src/lib/roles.ts PERMISSIONS: ${unknown.join(', ')}. ` +
        'The UI cannot offer the action or explain a refusal about it.',
    ).toEqual([]);
  });

  it('declares no permission the database enum does not have', () => {
    const invented = PERMISSIONS.filter((p) => !ENUM.has(p)).sort();
    expect(
      invented,
      `in src/lib/roles.ts but not in app_permission: ${invented.join(', ')}. ` +
        'An RPC given one of these fails on the enum cast — a 500, not a stated denial.',
    ).toEqual([]);
  });
});

describe('permission catalogue: the two sides agree on who holds what', () => {
  it('grants each role exactly what the migrations grant it', () => {
    const problems: string[] = [];

    for (const role of ROLES) {
      const sql = GRANTS.get(role) ?? new Set<string>();
      const ts = new Set<string>(basePermissions(role as Role));

      for (const p of [...sql].sort()) {
        if (!ts.has(p)) {
          problems.push(
            `${role}: the database grants "${p}" but basePermissions() does not — ` +
              'the action is permitted and unreachable.',
          );
        }
      }
      for (const p of [...ts].sort()) {
        if (!sql.has(p)) {
          problems.push(
            `${role}: basePermissions() grants "${p}" but the database does not — ` +
              'the UI offers an action the RPC will refuse.',
          );
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('keeps the administrator out of quality authority', () => {
    // PRD §2: "An Administrator is not automatically a quality-release
    // approver." Asserted against the DATABASE rather than against roles.ts,
    // because the database is what refuses.
    const admin = GRANTS.get('administrator') ?? new Set<string>();
    const quality = [...admin].filter(
      (p) =>
        p.startsWith('disposition.') ||
        p.startsWith('spec.') ||
        p.startsWith('nc.') ||
        p === 'hold.clear' ||
        p === 'sample.review',
    );
    expect(quality, `administrator holds quality authority: ${quality.join(', ')}`).toEqual([]);
  });

  it('puts nonconformity verification above the people who do the work', () => {
    // Spec §4. Raising is for whoever sees the problem; closing is the
    // control, so it does not sit with whoever did the investigation.
    const officer = GRANTS.get('quality_officer') ?? new Set<string>();
    const supervisor = GRANTS.get('quality_supervisor') ?? new Set<string>();
    const operator = GRANTS.get('operator') ?? new Set<string>();

    expect(operator.has('nc.raise')).toBe(true);
    expect(operator.has('nc.act')).toBe(false);
    expect(officer.has('nc.raise')).toBe(true);
    expect(officer.has('nc.act')).toBe(true);
    expect(officer.has('nc.close'), 'an officer must not verify their own corrective action').toBe(
      false,
    );
    expect(supervisor.has('nc.close')).toBe(true);
  });
});
