/**
 * Every operation name an Edge Function claims must be one an RPC re-claims.
 *
 * WHY THIS EXISTS. `runMutation` claims the idempotency key in Postgres BEFORE
 * calling the RPC (`adapters/mutation.ts`). The RPC then claims the same key
 * again, from inside the transaction. `claim_mutation` (migration 0013)
 * compares the two operation names and raises
 * `BFF_IDEMPOTENCY_CONFLICT: operation_mismatch` if they differ — so the two
 * strings are a contract between TypeScript and SQL, and until this file
 * existed nothing compared them.
 *
 * They disagreed, in production, for ten of fifteen write actions. Every
 * handler that PREFIXED its operation sent `admin_action.set_roles` or
 * `sample_action.raise_hold` while its RPC claimed `set_user_roles` or
 * `raise_hold`; every handler that did not prefix happened to match. So
 * registering a sample and entering results worked, and every administrator
 * action, both hold actions and two of three specification actions were
 * refused before doing any work. The failure was invisible to the typecheck
 * (both sides are plain strings), to the linter, to the unit tests (they do
 * not touch the database) and to the migrations (they know nothing about the
 * handlers).
 *
 * This is the FOURTH instance of one failure mode in this codebase — RPC
 * names, module specifiers, column names, now operation names — each a string
 * contract between components built in parallel, each side internally
 * consistent, nothing comparing them. The other three now have gates. This is
 * the one for this pair.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const MIGRATIONS = join(REPO, 'supabase', 'migrations');
const FUNCTIONS = join(REPO, 'supabase', 'functions');

function sqlFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Read a `Readonly<Record<..., string>>` constant's entries by name. */
function mapEntries(name: string): Array<[string, string]> {
  for (const path of tsFiles(FUNCTIONS)) {
    const src = readFileSync(path, 'utf8');
    const decl = new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(src);
    if (decl === null) continue;
    const body = decl[1] ?? '';
    return [...body.matchAll(/^\s*(\w+):\s*'([^']+)',/gm)].map(
      (m) => [m[1] ?? '', m[2] ?? ''] as [string, string],
    );
  }
  return [];
}

/** `RPC.<key>` -> `rpc_<name>`, from the shared constant table. */
function rpcAliases(): Map<string, string> {
  const src = readFileSync(join(FUNCTIONS, '_shared', 'rpc.ts'), 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*(\w+):\s*'(rpc_\w+)',/gm)) {
    if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * `rpc_<name>` -> the operation literal it hands `claim_mutation`.
 *
 * An RPC absent from this map does not re-claim the key, so its caller's
 * operation name is free: nothing will compare it to anything. That is why the
 * check below is scoped by the RPCs a file actually calls rather than applied
 * to every spec — `sync-action` deliberately claims `sync_action.retry` and
 * calls no claiming RPC, and demanding correspondence there would be a false
 * finding.
 */
function claimLiteralByRpc(): Map<string, string> {
  const out = new Map<string, string>();
  for (const sql of sqlFiles()) {
    let current: string | null = null;
    for (const line of sql.split('\n')) {
      const decl = /create (?:or replace )?function public\.(rpc_\w+)/.exec(line);
      if (decl !== null) {
        current = decl[1] ?? null;
        continue;
      }
      if (current === null) continue;
      const claim = /claim_mutation\(\s*p_idempotency_key,\s*'([a-z_.]+)'/.exec(line);
      if (claim !== null && claim[1] !== undefined) {
        out.set(current, claim[1]);
        current = null;
        continue;
      }
      // The wrapped form: `claim_mutation(` then `p_idempotency_key, 'name',`.
      const wrapped = /^\s*p_idempotency_key,\s*'([a-z_.]+)'/.exec(line);
      if (wrapped !== null && wrapped[1] !== undefined) {
        out.set(current, wrapped[1]);
        current = null;
      }
    }
  }
  // `rpc_record_admin_password_set` resolves the operation FROM the claim and
  // validates it against its own array, so every member is acceptable to it.
  for (const sql of sqlFiles()) {
    for (const m of sql.matchAll(/c_operations[^;]*?array\[([\s\S]*?)\]/g)) {
      const members = [...(m[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map((x) => x[1] ?? '');
      if (members.length > 0) {
        out.set('rpc_record_admin_password_set', members.join('|'));
      }
    }
  }
  return out;
}

interface SpecClaim {
  readonly where: string;
  readonly file: string;
  readonly claims: string;
}

/**
 * Every MutationSpec's effective claim name.
 *
 * Scoped to objects that also carry `permission:` — that is what makes an
 * object a MutationSpec rather than, say, the Google Sheets adapter's HTTP
 * `operation: 'values.append'` label, which never touches the registry.
 */
function specClaims(): SpecClaim[] {
  const out: SpecClaim[] = [];
  for (const path of tsFiles(FUNCTIONS)) {
    const src = readFileSync(path, 'utf8');
    const rel = path.slice(REPO.length + 1);
    for (const m of src.matchAll(
      /operation:\s*(?:'([^']+)'|`([^`]+)`),([\s\S]{0,600}?)\bpermission:/g,
    )) {
      const operation = m[1] ?? m[2] ?? '';
      const between = m[3] ?? '';
      const lit = /claimOperation:\s*'([^']+)'/.exec(between);
      const expr = /claimOperation:\s*([A-Za-z_$][\w$]*)\[/.exec(between);
      if (lit !== null) {
        out.push({ where: `${rel} :: ${operation}`, file: rel, claims: lit[1] ?? '' });
      } else if (expr !== null) {
        for (const [action, value] of mapEntries(expr[1] ?? '')) {
          out.push({ where: `${rel} :: ${operation} (${action})`, file: rel, claims: value });
        }
      } else {
        out.push({ where: `${rel} :: ${operation}`, file: rel, claims: operation });
      }
    }
  }
  return out;
}

/** The claim literals of every claiming RPC referenced in a file. */
function literalsExpectedIn(file: string): Set<string> {
  const src = readFileSync(join(REPO, file), 'utf8');
  const aliases = rpcAliases();
  const byRpc = claimLiteralByRpc();
  const out = new Set<string>();
  for (const m of src.matchAll(/\bRPC\.(\w+)/g)) {
    const rpc = aliases.get(m[1] ?? '');
    if (rpc === undefined) continue;
    const literal = byRpc.get(rpc);
    if (literal === undefined) continue;
    for (const part of literal.split('|')) out.add(part);
  }
  return out;
}

describe('idempotency operation contract between Edge Functions and SQL', () => {
  it('finds both sides, so a pass is not vacuous', () => {
    // Without this, a broken matcher reports a clean contract in exactly the
    // same words as a correct one — which is how three earlier instances of
    // this defect class survived their own gates.
    const byRpc = claimLiteralByRpc();
    const claims = specClaims();
    expect(byRpc.size).toBeGreaterThanOrEqual(12);
    expect(claims.length).toBeGreaterThanOrEqual(10);
    expect(byRpc.get('rpc_set_user_roles')).toBe('set_user_roles');
    expect(byRpc.get('rpc_register_sample')).toBe('register_sample');
    expect(rpcAliases().size).toBeGreaterThanOrEqual(12);
  });

  it('would catch the original defect', () => {
    // The positive control, and the exact string the admin handler used to
    // send. If this ever passes, the check below has stopped discriminating.
    const expected = literalsExpectedIn('supabase/functions/_shared/handlers/admin.ts');
    expect(expected.has('set_user_roles')).toBe(true);
    expect(expected.has('admin_action.set_roles')).toBe(false);
  });

  it('claims every key under a name the RPC it calls will re-claim', () => {
    const broken: string[] = [];
    for (const spec of specClaims()) {
      const expected = literalsExpectedIn(spec.file);
      // No claiming RPC in this file: nothing re-claims the key, so the name
      // cannot conflict with anything. Correct, not merely tolerated — and
      // checked BEFORE the unresolved-name branch, because a name this test
      // cannot expand is only a problem where something would compare it.
      // `sync-action` is exactly that case: it claims `sync_action.<action>`
      // and calls no claiming RPC, by design.
      if (expected.size === 0) continue;
      if (spec.claims.includes('${')) {
        broken.push(
          `${spec.where} -> this test could not resolve the claim name, and ` +
            `this file DOES call a claiming RPC, so it is unchecked rather ` +
            `than safe. Spell the claim as a literal or a resolvable map.`,
        );
        continue;
      }
      if (!expected.has(spec.claims)) {
        broken.push(
          `${spec.where} -> claims '${spec.claims}', but the RPCs this file ` +
            `calls re-claim under {${[...expected].sort().join(', ')}}. ` +
            `claim_mutation refuses on any disagreement, so every request ` +
            `through this endpoint fails before doing any work.`,
        );
      }
    }
    expect(broken).toEqual([]);
  });
});
