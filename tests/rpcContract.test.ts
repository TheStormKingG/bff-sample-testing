/**
 * SQL <-> TypeScript RPC CONTRACT TEST.
 *
 * `supabase/functions/_shared/rpc.ts` declares itself the interface boundary
 * between the Edge Functions and the migrations. Nothing enforced it. Two
 * failure modes follow, and neither is caught by any other gate in this repo:
 *
 *   1. A name in `RPC` with no `create function` in any migration. Every call
 *      returns PostgREST's PGRST202 and the whole mutating path is dead. This
 *      was review finding 1 (CRITICAL) and was the real state of the tree.
 *
 *   2. A function that EXISTS but whose parameter NAMES differ from the keys
 *      the TypeScript passes. PostgREST sends named arguments, so a renamed or
 *      misspelled parameter is also a PGRST202 — an identical symptom to the
 *      function being absent, and invisible to `deno check`, to tsc, to eslint
 *      and to every unit test, because both sides are internally consistent.
 *
 * This test reads both sides as text and compares them. It is deliberately a
 * unit test rather than an integration test: it needs no database, so it runs
 * in CI on every push, which is exactly where this class of drift must be
 * caught. It cannot tell you the function BEHAVES correctly — only that the
 * call and the definition agree on name and parameters.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// process.cwd() rather than import.meta.url: under Vite the latter is a
// dev-server URL ("/@fs/...") whose path is percent-encoded, and this
// repository's directory name contains a space, so it resolves to a
// non-existent "FEED%20QUALITY". Vitest runs from the project root.
const REPO = process.cwd();
const RPC_TS = join(REPO, 'supabase/functions/_shared/rpc.ts');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const FUNCTIONS_DIR = join(REPO, 'supabase/functions');

// --- read the TypeScript side ------------------------------------------------

const rpcSource = readFileSync(RPC_TS, 'utf8');

/** `registerSample: 'rpc_register_sample',` -> key/value pairs. */
function parseRpcMap(src: string): Map<string, string> {
  const start = src.indexOf('export const RPC = {');
  if (start === -1) throw new Error('RPC map not found in rpc.ts');
  // The map ends at the first `} as const` / `};` at column 0.
  const tail = src.slice(start);
  const end = tail.search(/\n\}/);
  const body = tail.slice(0, end === -1 ? undefined : end);

  const map = new Map<string, string>();
  for (const m of body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*'(rpc_[a-z0-9_]+)'/gm)) {
    map.set(m[1]!, m[2]!);
  }
  return map;
}

/**
 * Collect `p_*` fields of an interface, following a single `extends` link.
 * Optional fields (`p_x?:`) are marked so a SQL parameter with a DEFAULT can
 * satisfy them.
 */
function parseInterfaces(src: string): Map<string, { fields: Map<string, boolean>; extendsName: string | null }> {
  const out = new Map<string, { fields: Map<string, boolean>; extendsName: string | null }>();
  const re = /export interface (\w+)(?:\s+extends\s+(\w+))?\s*\{([\s\S]*?)\n\}/g;
  for (const m of src.matchAll(re)) {
    const fields = new Map<string, boolean>();
    for (const f of m[3]!.matchAll(/^\s*(?:readonly\s+)?(p_[a-z0-9_]+)(\??):/gm)) {
      fields.set(f[1]!, f[2] === '?');
    }
    out.set(m[1]!, { fields, extendsName: m[2] ?? null });
  }
  return out;
}

const RPC_MAP = parseRpcMap(rpcSource);
const INTERFACES = parseInterfaces(rpcSource);

function resolveFields(interfaceName: string): Map<string, boolean> | null {
  const node = INTERFACES.get(interfaceName);
  if (!node) return null;
  const merged = new Map(node.fields);
  if (node.extendsName) {
    const parent = resolveFields(node.extendsName);
    if (parent) for (const [k, v] of parent) if (!merged.has(k)) merged.set(k, v);
  }
  return merged;
}

/** `registerSample` -> `RegisterSampleArgs`. */
const argsInterfaceFor = (key: string): string =>
  `${key.charAt(0).toUpperCase()}${key.slice(1)}Args`;

/**
 * Every `rpc_*` name used as a DATABASE FUNCTION NAME under supabase/functions.
 *
 * Deliberately not "every `rpc_*` string literal": the codebase also uses
 * `rpc_not_deployed` and `rpc_error` as typed ERROR CODES, and a naive literal
 * scan reported those as missing database functions. A name counts only if it
 * is a value in the RPC map or is passed directly as the first argument of a
 * `.rpc(` call.
 */
function referencedRpcNames(): Set<string> {
  const names = new Set<string>(RPC_MAP.values());
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\.rpc\(\s*'(rpc_[a-z0-9_]+)'/g)) names.add(m[1]!);
      }
    }
  };
  walk(FUNCTIONS_DIR);
  return names;
}

// --- read the SQL side -------------------------------------------------------

interface SqlFunction {
  readonly name: string;
  readonly params: Map<string, boolean>; // name -> hasDefault
  readonly file: string;
  /** Character offset of the definition within its file, for drop-ordering. */
  readonly index: number;
}

/** Extract the balanced parameter list that follows a function name. */
function balancedParamList(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenIndex + 1, i);
    }
  }
  throw new Error('unbalanced parameter list');
}

function parseSqlFunctions(): SqlFunction[] {
  const found: SqlFunction[] = [];
  let sqlFiles: string[] = [];
  try {
    sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    sqlFiles = [];
  }

  for (const file of sqlFiles) {
    const src = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(rpc_[a-z0-9_]+)\s*\(/gi;
    for (const m of src.matchAll(re)) {
      const openParen = m.index! + m[0]!.length - 1;
      const paramSrc = balancedParamList(src, openParen);
      const params = new Map<string, boolean>();
      // Split on top-level commas only: a type like numeric(10,2) nests.
      let depth = 0;
      let current = '';
      const chunks: string[] = [];
      for (const ch of paramSrc) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          chunks.push(current);
          current = '';
        } else current += ch;
      }
      if (current.trim()) chunks.push(current);

      for (const chunk of chunks) {
        const name = chunk.trim().match(/^(?:in|out|inout|variadic)?\s*(p_[a-z0-9_]+)/i);
        if (name) params.set(name[1]!.toLowerCase(), /\bdefault\b|:=/i.test(chunk));
      }
      found.push({ name: m[1]!.toLowerCase(), params, file, index: m.index! });
    }
  }
  return found;
}

const SQL_FUNCTIONS = parseSqlFunctions();
const SQL_BY_NAME = new Map(SQL_FUNCTIONS.map((f) => [f.name, f]));

// --- the tests ---------------------------------------------------------------

describe('RPC contract: the parsers themselves', () => {
  // An empty-looking result from either parser would make every comparison
  // below pass vacuously, so both are asserted non-empty first. This is the
  // instrument check, not the measurement.
  it('parses a non-empty RPC map from rpc.ts', () => {
    expect(RPC_MAP.size).toBeGreaterThan(20);
    expect(RPC_MAP.get('registerSample')).toBe('rpc_register_sample');
  });

  it('parses the argument interfaces, including inherited actor fields', () => {
    const register = resolveFields('RegisterSampleArgs');
    expect(register).not.toBeNull();
    expect(register!.has('p_stage')).toBe(true);
    // Inherited from RpcActorArgs — proves the `extends` link is followed.
    expect(register!.has('p_actor')).toBe(true);
    expect(register!.has('p_idempotency_key')).toBe(true);
    // Optionality is captured, so a SQL DEFAULT can satisfy an optional arg.
    expect(register!.get('p_notes')).toBe(true);
    expect(register!.get('p_stage')).toBe(false);
  });

  it('finds the migration directory and reports how many functions it parsed', () => {
    const migrationCount = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length;
    expect(migrationCount).toBeGreaterThan(0);
    // No assertion on the count itself here — the next block is where a zero
    // becomes a failure. This only proves the directory was actually read.
  });
});

describe('RPC contract: every called function is defined (review finding 1)', () => {
  it('defines every name in the RPC map', () => {
    const missing = [...RPC_MAP.entries()]
      .filter(([, sqlName]) => !SQL_BY_NAME.has(sqlName))
      .map(([key, sqlName]) => `${sqlName} (RPC.${key})`);

    expect(
      missing,
      missing.length === 0
        ? ''
        : `${missing.length} of ${RPC_MAP.size} RPCs are called but never defined in supabase/migrations/**.\n` +
          `Every call to one of these returns PostgREST PGRST202 and the mutating path is dead.\n` +
          `This is review finding 1, not a regression introduced by a test.\n` +
          `Missing:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('defines every rpc_* literal referenced anywhere under supabase/functions', () => {
    const referenced = referencedRpcNames();
    expect(referenced.size).toBeGreaterThan(20); // instrument check
    const missing = [...referenced].filter((n) => !SQL_BY_NAME.has(n)).sort();
    expect(missing, `referenced but undefined: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not define an rpc_* function nothing calls', () => {
    // A dead RPC is not dangerous, but it usually means a rename landed on one
    // side only — the same root cause as a missing one, caught from the other end.
    const referenced = referencedRpcNames();
    const orphans = SQL_FUNCTIONS.map((f) => f.name)
      .filter((n) => !referenced.has(n))
      .sort();
    expect(orphans, `defined but never called: ${orphans.join(', ')}`).toEqual([]);
  });

  it('redefines an rpc_* name only after explicitly dropping it', () => {
    // Redefining a name is legitimate — a later migration may widen a return
    // type, which is the one change `create or replace` CANNOT make (Postgres
    // refuses with "cannot change return type of existing function", and a
    // bare `create function` fails with "function already exists" because an
    // identical argument list does not overload). The safe idiom is an
    // explicit `drop function` immediately before the new definition.
    //
    // So a duplicate is only a defect when that drop is absent. The first
    // version of this test flagged the duplicate itself and produced a false
    // finding against SQL that was already correct.
    const byName = new Map<string, Array<{ file: string; index: number }>>();
    for (const f of SQL_FUNCTIONS) {
      byName.set(f.name, [...(byName.get(f.name) ?? []), { file: f.file, index: f.index }]);
    }

    const unprotected: string[] = [];
    for (const [name, defs] of byName) {
      if (defs.length < 2) continue;
      // Every definition after the first needs a drop of that name earlier in
      // its own file.
      for (const def of defs.slice(1)) {
        const src = readFileSync(join(MIGRATIONS_DIR, def.file), 'utf8');
        const dropRe = new RegExp(`drop\\s+function\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${name}\\s*\\(`, 'gi');
        const hasPrecedingDrop = [...src.matchAll(dropRe)].some((m) => m.index! < def.index);
        if (!hasPrecedingDrop) {
          unprotected.push(
            `${name} is redefined in ${def.file} with no preceding "drop function ${name}(...)": on a fresh migration run this aborts, because an identical argument list cannot overload and a changed return type cannot be replaced`,
          );
        }
      }
    }
    expect(unprotected, unprotected.join('\n')).toEqual([]);
  });
});

describe('RPC contract: parameter names agree (the silent-404 class)', () => {
  it('every TypeScript argument has a matching SQL parameter', () => {
    const problems: string[] = [];
    let compared = 0;
    const skipped: string[] = [];

    for (const [key, sqlName] of RPC_MAP) {
      const fields = resolveFields(argsInterfaceFor(key));
      if (!fields || fields.size === 0) {
        // No declared Args interface. Recorded rather than ignored: a silent
        // skip here would let an unchecked RPC look covered.
        skipped.push(`${sqlName} (no ${argsInterfaceFor(key)})`);
        continue;
      }
      const sql = SQL_BY_NAME.get(sqlName);
      if (!sql) continue; // already reported by the previous block

      compared++;
      for (const [field, optional] of fields) {
        if (!sql.params.has(field)) {
          problems.push(
            `${sqlName}: TypeScript passes "${field}"${optional ? ' (optional)' : ''} but the SQL function in ${sql.file} has no such parameter (has: ${[...sql.params.keys()].join(', ') || 'none'})`,
          );
        }
      }
      // A required SQL parameter the TypeScript never sends will fail at call
      // time unless it has a DEFAULT.
      for (const [param, hasDefault] of sql.params) {
        if (!fields.has(param) && !hasDefault) {
          problems.push(
            `${sqlName}: SQL parameter "${param}" (${sql.file}) is required but never supplied by ${argsInterfaceFor(key)}`,
          );
        }
      }
    }

    // Report what was NOT compared, so a green result cannot be read as
    // covering more than it did.
    if (skipped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `RPC contract: ${skipped.length} RPC(s) have no declared Args interface and were not parameter-checked:\n  ${skipped.join('\n  ')}`,
      );
    }

    expect(problems, problems.join('\n')).toEqual([]);
    // Only meaningful once there is something to compare.
    if (SQL_FUNCTIONS.length > 0) expect(compared).toBeGreaterThan(0);
  });
});

describe('SECURITY DEFINER hardening, per function and across all migrations', () => {
  /**
   * Comments MUST be stripped before any of this.
   *
   * These migrations document the SECURITY DEFINER hazard at length in prose,
   * so a naive count of "security definer" reads 37 where only 17 functions
   * are declared — that produced a confident false finding of 8 unprotected
   * functions on the first run of this test. The reverse error is worse: a
   * comment explaining `revoke ... from public` would make a MISSING revoke
   * look present, turning a real privilege hole into a green check.
   */
  const stripComments = (sql: string): string =>
    sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

  const migrationFiles = (): Array<{ file: string; sql: string }> => {
    try {
      return readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => ({ file: f, sql: stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')) }));
    } catch {
      return [];
    }
  };

  interface DefinedFunction {
    readonly file: string;
    readonly name: string;
    readonly isDefiner: boolean;
    readonly hasSearchPath: boolean;
  }

  /** Every function in every migration, paired with its own header options. */
  const allFunctions = (): DefinedFunction[] => {
    const out: DefinedFunction[] = [];
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    for (const { file, sql } of migrationFiles()) {
      const starts = [...sql.matchAll(re)];
      starts.forEach((m, i) => {
        const block = sql.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index! : sql.length);
        // Options sit between the parameter list and the body delimiter.
        const body = block.search(/\bas\s*\$|\bbegin\b/i);
        const header = body === -1 ? block : block.slice(0, body);
        out.push({
          file,
          name: m[1]!.toLowerCase(),
          isDefiner: /security\s+definer/i.test(header),
          hasSearchPath: /set\s+search_path\s*=/i.test(header),
        });
      });
    }
    return out;
  };

  it('parses at least one function definition (instrument check)', () => {
    // Without this, every assertion below passes vacuously on an empty parse —
    // which is exactly how the first version of the revoke test went green
    // while zero rpc_* functions existed.
    const fns = allFunctions();
    expect(fns.length, 'no function definitions parsed from supabase/migrations/**').toBeGreaterThan(0);
  });

  it('sets an explicit search_path on every SECURITY DEFINER function', () => {
    // A SECURITY DEFINER function without a pinned search_path can be hijacked
    // by a caller-controlled schema shadowing an unqualified object reference.
    const unprotected = allFunctions()
      .filter((f) => f.isDefiner && !f.hasSearchPath)
      .map((f) => `${f.file} :: ${f.name}()`);
    expect(unprotected, `SECURITY DEFINER without search_path:\n  ${unprotected.join('\n  ')}`).toEqual([]);
  });

  it('revokes EXECUTE from PUBLIC for every SECURITY DEFINER function', () => {
    // `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ... FROM PUBLIC` is inert:
    // a revoke can only delete a grant that was actually recorded, and the
    // PUBLIC execute grant on a new function is implicit, not a recorded
    // default. So the revoke has to name each function explicitly.
    const sql = migrationFiles().map((f) => f.sql).join('\n');
    const definers = allFunctions().filter((f) => f.isDefiner);
    expect(definers.length, 'no SECURITY DEFINER functions parsed').toBeGreaterThan(0);

    const missing = definers
      .filter((f) => {
        const re = new RegExp(
          `revoke\\s+(?:all|execute)[\\s\\S]{0,200}?on\\s+function\\s+(?:public\\.)?${f.name}\\s*\\(`,
          'i',
        );
        return !re.test(sql);
      })
      .map((f) => `${f.file} :: ${f.name}()`);

    expect(
      missing,
      `${missing.length} of ${definers.length} SECURITY DEFINER function(s) lack an explicit per-signature "revoke ... from public":\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('does not rely on ALTER DEFAULT PRIVILEGES alone for function execute', () => {
    const sql = migrationFiles().map((f) => f.sql).join('\n');
    const usesDefaultPrivRevoke = /alter\s+default\s+privileges[\s\S]{0,200}?revoke[\s\S]{0,120}?execute/i.test(sql);
    const usesExplicitRevoke = /revoke\s+(?:all|execute)[\s\S]{0,200}?on\s+function/i.test(sql);
    if (usesDefaultPrivRevoke) {
      expect(
        usesExplicitRevoke,
        'migrations use ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE, which is inert, without any explicit per-function revoke',
      ).toBe(true);
    }
  });
});
