/**
 * THE CROSS-BOUNDARY NAMES AND ORDERINGS OF ADMINISTRATOR-MANAGED PASSWORDS.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * Migration 0019's `rpc_record_admin_password_set` refuses any idempotency key
 * whose recorded operation is not one of two endpoint names it holds in a
 * `c_operations` array. The name it compares against is written by
 * `adminSpec()` in `_shared/handlers/admin.ts` as `admin_action.<action>`. So
 * one string is produced in TypeScript and compared in PL/pgSQL, and nothing
 * in the toolchain relates the two: not tsc, not eslint, not `deno check`, not
 * PostgREST.
 *
 * THAT IS NOT A HYPOTHETICAL RISK IN THIS REPOSITORY. Every admin RPC in
 * migration 0015 is unreachable through its own Edge Function today for exactly
 * this reason: `rpc_set_user_roles` hands `claim_mutation` the bare string
 * `'set_user_roles'`, while the adapter records `'admin_action.set_roles'` — a
 * missing prefix AND a different word. `claim_mutation` raises
 * `BFF_IDEMPOTENCY_CONFLICT: operation_mismatch` on any mismatch, so the call
 * has never worked. Both halves were internally consistent and carefully
 * commented; what was missing was a test that read both and compared them.
 *
 * This suite is that comparison, for the password path. It is deliberately
 * SCOPED to the password RPC rather than generalised over every RPC that calls
 * `claim_mutation`: generalised, it would fail immediately on migration 0015,
 * which is a real pre-existing defect in files this change does not own. Making
 * the suite red on somebody else's bug would get the suite disabled, not the
 * bug fixed. The generalisation is the right next step for whoever owns 0015.
 *
 * ===========================================================================
 * WHAT ELSE IS PINNED HERE
 * ===========================================================================
 *  - the ORDER of the two non-transactional writes in each password action,
 *    because the safe order is the counter-intuitive one and a tidying refactor
 *    would invert it without changing any name;
 *  - that `change-own-password` has not acquired a permission check, which
 *    would silently convert the only escape from the gate into a permanent
 *    lock-out;
 *  - that no credential reaches an audit payload or a commit summary;
 *  - that the browser's password minimum is not weaker than the server's.
 *
 * Several assertions read SOURCE TEXT rather than calling the code. That is not
 * laziness: every module that can reach the Supabase admin API imports
 * `npm:@supabase/supabase-js`, which this test runner cannot resolve, so text
 * is the only instrument available for them. `_shared/actions.ts` and
 * `_shared/validation.ts` are pure and ARE imported and executed below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_PERMISSION,
  PASSWORD_SETTING_ADMIN_ACTIONS,
  parseAction,
} from '../supabase/functions/_shared/actions.ts';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  normaliseEmail,
  passwordByteLength,
  passwordIssues,
} from '../supabase/functions/_shared/validation.ts';

// process.cwd(), not import.meta.url: this repository's directory name
// contains a space, and `new URL(...).pathname` percent-encodes it into a path
// that does not exist. Vitest runs from the project root.
const REPO = process.cwd();
const MIGRATION_0019 = join(REPO, 'supabase/migrations/0019_admin_managed_passwords.sql');
const ADMIN_HANDLER = join(REPO, 'supabase/functions/_shared/handlers/admin.ts');
const CHANGE_OWN_PASSWORD = join(REPO, 'supabase/functions/change-own-password/index.ts');
const CLIENT_SUPABASE = join(REPO, 'src/lib/supabase.ts');

const read = (path: string): string => readFileSync(path, 'utf8');

/**
 * Remove comments, so an assertion about CODE is not satisfied or broken by
 * PROSE.
 *
 * Both directions matter here and the second is the subtle one.
 * `change-own-password/index.ts` documents at length that it must never call
 * `require_permission` — so a naive search for that string finds the warning
 * and reports the defect it was written to prevent. Equally, a banned value
 * deleted from every code path can survive in a comment and a whole-file grep
 * would call the file dirty. The question being asked is about the code, so
 * the comments are removed before asking it.
 *
 * Strings are left intact: an operation name or an RPC name IS a string
 * literal, and those are exactly what this suite compares.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * The argument text of each call to `name(` in `src`, by balanced parentheses.
 *
 * A fixed-width window after the call site would cut a long object literal in
 * half and silently stop looking exactly where a credential would be added.
 */
/**
 * The position of the ONE occurrence of `needle`, or a failure naming the count.
 *
 * ================================================================
 * WHY THE ORDERING ASSERTIONS BELOW CANNOT USE A BARE `indexOf`
 * ================================================================
 * They used to, and it broke the moment a helper function above `adminSpec`
 * mentioned `RPC.recordAdminPasswordSet` inside a string it interpolates into
 * an error's `internalDetail`. The execution order was unchanged and correct;
 * the FIRST TEXTUAL MENTION of the token moved 10kB up the file. One of the two
 * ordering tests went red for a reason that had nothing to do with the property
 * it names — and the other stayed GREEN while silently comparing a template
 * string's position against a real call site, which is the more dangerous of
 * the two outcomes because nothing reports it.
 *
 * So the needle must be a string only the CALL SITE can contain
 * (`admin.auth.admin.createUser`, not `createUser`), and the count must be
 * asserted rather than assumed: with exactly one occurrence, "first mention"
 * and "the call" are the same position by construction, and a future second
 * mention fails here loudly instead of quietly re-pointing the measurement.
 */
function soleIndexOf(src: string, needle: string, what: string): number {
  const count = src.split(needle).length - 1;
  expect(
    count,
    `expected exactly one occurrence of '${needle}' (${what}) so that its ` +
      `position IS the call site; found ${count}. If a second mention is ` +
      'legitimate, narrow the needle — do not fall back to indexOf, which ' +
      'would then be measuring whichever mention happens to come first.',
  ).toBe(1);
  return src.indexOf(needle);
}

function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    const open = at + needle.length - 1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(open + 1, i));
          from = i;
          break;
        }
      }
      if (i === src.length - 1) from = src.length;
    }
    if (from <= at) return out;
  }
}

/** The `c_operations constant text[] := array[...]` members in migration 0019. */
function sqlPasswordOperations(): string[] {
  const src = read(MIGRATION_0019);
  const match = /c_operations\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/.exec(src);
  if (match === null) {
    throw new Error(
      'c_operations not found in 0019. If the array was renamed or restructured, this ' +
        'comparison is no longer reading the SQL side and must be repointed, not deleted.',
    );
  }
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** The literal `adminSpec` builds its operation name from. */
function edgeOperationTemplate(): string {
  const src = stripComments(read(ADMIN_HANDLER));
  const match = /operation:\s*`([^`]*)`/.exec(src);
  if (match === null) throw new Error('adminSpec operation template not found in admin.ts');
  return match[1]!;
}

// ---------------------------------------------------------------------------
// The instruments, before any measurement taken with them.
//
// Every parser below would report a clean, confident, empty answer if it were
// pointed at the wrong thing — and an empty answer makes every comparison in
// this file pass vacuously. So each one is asserted to have found something
// first. This is the check that distinguishes "the names agree" from "nothing
// was compared".
// ---------------------------------------------------------------------------
describe('admin password boundary: the instruments', () => {
  it('reads all four source files non-empty', () => {
    for (const path of [MIGRATION_0019, ADMIN_HANDLER, CHANGE_OWN_PASSWORD, CLIENT_SUPABASE]) {
      expect(read(path).length, path).toBeGreaterThan(500);
    }
  });

  it('parses a non-empty operation list out of the SQL', () => {
    expect(sqlPasswordOperations().length).toBeGreaterThan(0);
  });

  it('parses the operation template out of the Edge handler', () => {
    expect(edgeOperationTemplate()).toContain('${action}');
  });

  it('strips comments without eating the code', () => {
    const stripped = stripComments(read(CHANGE_OWN_PASSWORD));
    // Positive control: real code survives.
    expect(stripped).toContain('updateUserById');
    // Negative control, chosen to carry the actual risk: this prose contains
    // the banned symbol `require_permission`, so if the stripper did nothing
    // the "never calls require_permission" test below would fail on the very
    // warning that the function must not call it.
    const warning = 'IT DOES NOT CALL `require_permission`';
    expect(read(CHANGE_OWN_PASSWORD)).toContain(warning);
    expect(stripped).not.toContain(warning);
    expect(stripped).not.toContain('require_permission');
  });

  it('extracts whole balanced argument lists, not fixed windows', () => {
    const blocks = callArguments('f(a, g(b, c), { d: 1 }) h(2)', 'f');
    expect(blocks).toEqual(['a, g(b, c), { d: 1 }']);
  });
});

// ---------------------------------------------------------------------------
// The comparison that migration 0015 never got.
// ---------------------------------------------------------------------------
describe('admin password boundary: the operation string crosses it intact', () => {
  it('prefixes every admin action with exactly `admin_action.`', () => {
    // The prefix is applied in ONE place. If it moves or changes, the SQL's
    // list stops matching and both password actions start failing as replay
    // conflicts — a symptom that reads as an idempotency bug.
    expect(edgeOperationTemplate()).toBe('admin_action.${action}');
  });

  it('produces, for each password action, an operation the SQL accepts', () => {
    const prefix = edgeOperationTemplate().replace('${action}', '');
    const accepted = sqlPasswordOperations();

    expect(PASSWORD_SETTING_ADMIN_ACTIONS.length).toBeGreaterThan(0);
    for (const action of PASSWORD_SETTING_ADMIN_ACTIONS) {
      // This is the assertion whose absence left rpc_set_user_roles dead.
      expect(
        accepted,
        `the Edge adapter will claim the idempotency key for '${action}' as ` +
          `'${prefix}${action}', and rpc_record_admin_password_set refuses any ` +
          `operation outside its c_operations list, so this action would fail ` +
          `with BFF_IDEMPOTENCY_CONFLICT: operation_mismatch on every call`,
      ).toContain(`${prefix}${action}`);
    }
  });

  it('accepts nothing in SQL that no Edge action produces', () => {
    // The complement. A member in the SQL list that no action can produce is a
    // rename that landed on one side only — the same root cause as a missing
    // one, caught from the other end. Reading the list row by row never shows
    // it, because a stale row looks exactly like a live one.
    const prefix = edgeOperationTemplate().replace('${action}', '');
    const producible = ADMIN_ACTIONS.map((a) => `${prefix}${a}`);
    const orphans = sqlPasswordOperations().filter((op) => !producible.includes(op));
    expect(orphans, `in c_operations but producible by no admin action: ${orphans.join(', ')}`)
      .toEqual([]);
  });

  it('has exactly one SQL entry per password-setting action', () => {
    const prefix = edgeOperationTemplate().replace('${action}', '');
    expect([...sqlPasswordOperations()].sort()).toEqual(
      [...PASSWORD_SETTING_ADMIN_ACTIONS].map((a) => `${prefix}${a}`).sort(),
    );
  });

  it('keeps PASSWORD_SETTING_ADMIN_ACTIONS a real subset of the vocabulary', () => {
    // A name in the subset that the router will not accept is a dead branch:
    // `parseAction` refuses it before any spec is chosen, so the action would
    // 400 rather than reach the code written for it.
    for (const action of PASSWORD_SETTING_ADMIN_ACTIONS) {
      expect(ADMIN_ACTIONS as readonly string[]).toContain(action);
      expect(parseAction(action, ADMIN_ACTIONS as readonly string[])).toBe(action);
    }
  });

  it('answers to user.manage, not to the approval permission', () => {
    // Creating an account must not be the same decision as letting it in.
    for (const action of PASSWORD_SETTING_ADMIN_ACTIONS) {
      expect(ADMIN_ACTION_PERMISSION[action]).toBe('user.manage');
    }
  });

  it('accepts every action the browser can send', () => {
    // THE OTHER END OF THE SAME BOUNDARY. `AdminActionKind` in
    // src/hooks/useAdmin.ts is the set of action strings the browser puts on
    // the wire; ADMIN_ACTIONS is the set the router will parse. A member of the
    // first that is missing from the second is refused by `parseAction` as
    // `bad_request` before any spec is chosen — a 400 on a button that looks
    // implemented on both sides, which is how three outages in this project
    // began. Only this direction is asserted: the Edge holding an action the
    // browser does not yet send is a half-built feature, not a break.
    const src = read(join(REPO, 'src/hooks/useAdmin.ts'));
    const decl = /export type AdminActionKind\s*=([\s\S]*?);\n/.exec(src);
    if (decl === null) {
      throw new Error(
        'AdminActionKind not found in src/hooks/useAdmin.ts. If it moved, this ' +
          'comparison is no longer reading the client side and must be repointed.',
      );
    }
    const clientActions = [...decl[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(clientActions.length, 'parsed no actions out of AdminActionKind')
      .toBeGreaterThan(5);

    for (const action of clientActions) {
      expect(
        parseAction(action, ADMIN_ACTIONS as readonly string[]),
        `the browser can send '${action}' and the admin-action router does not ` +
          'accept it, so that request is a 400 before any authority is checked',
      ).toBe(action);
    }
  });

  it('names both RPCs the migration defines', () => {
    const sql = read(MIGRATION_0019);
    const rpcTs = read(join(REPO, 'supabase/functions/_shared/rpc.ts'));
    for (const name of ['rpc_record_admin_password_set', 'rpc_record_password_changed']) {
      expect(sql).toContain(`function public.${name}(`);
      expect(rpcTs, `${name} is defined in 0019 but named nowhere in rpc.ts`).toContain(
        `'${name}'`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The ordering of two writes that are not in one transaction.
// ---------------------------------------------------------------------------
describe('admin password boundary: the credential never goes live unarmed', () => {
  const stripped = stripComments(read(ADMIN_HANDLER));

  it('arms the forced change BEFORE applying the administrator’s password', () => {
    // `callTransaction<RecordAdminPasswordSetResult>` and not
    // `RPC.recordAdminPasswordSet`: the latter also appears inside the error
    // templates of `reportArmingFailure`, which is declared above `adminSpec`.
    const armed = soleIndexOf(
      stripped,
      'callTransaction<RecordAdminPasswordSetResult>',
      'the arming RPC call',
    );
    const applied = soleIndexOf(
      stripped,
      'admin.auth.admin.updateUserById',
      'the call that makes the password live',
    );

    // Instrument check: a -1 would make the comparison below pass by accident.
    expect(armed, 'the arming RPC is not called in admin.ts').toBeGreaterThan(-1);
    expect(applied, 'updateUserById is not called in admin.ts').toBeGreaterThan(-1);

    expect(
      armed,
      'The arming RPC must be called BEFORE auth.admin.updateUserById. Reversed, a ' +
        'failure between the two leaves an administrator-known password live on an ' +
        'account with NO forced change — the exact attribution hole migration 0019 ' +
        'exists to close. It cannot be undone either: profiles_id_fkey and ' +
        'audit_events_actor_id_fkey are both ON DELETE RESTRICT, so the account ' +
        'cannot be deleted once its provisioning audit event exists.',
    ).toBeLessThan(applied);
  });

  it('creates a new account with a password nobody is told', () => {
    const [created] = callArguments(stripped, 'admin.auth.admin.createUser');
    expect(created, 'createUser is not called in admin.ts').toBeDefined();
    // The chosen temporary password must NOT be what the account is created
    // with: the account has to exist, and be armed, before it goes live.
    expect(created!).toContain('unknowablePassword()');
    expect(created!).not.toContain('temporaryPassword');
  });

  it('creates the account before arming it, since arming needs the profile', () => {
    const created = soleIndexOf(
      stripped,
      'admin.auth.admin.createUser',
      'the call that creates the account',
    );
    const armed = soleIndexOf(
      stripped,
      'callTransaction<RecordAdminPasswordSetResult>',
      'the arming RPC call',
    );
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(armed);
  });

  it('reports the created account truthfully when arming fails', () => {
    // `create_account` performs THREE writes that are not in one transaction,
    // and the middle one had no catch: a failure in the arming RPC surfaced as
    // the default `internal` message, "Nothing was saved", which is false once
    // `createUser` has returned. The administrator is then told to retry,
    // `refuseIfAddressTaken` refuses the retry, and the two messages
    // contradict each other over an account that really exists.
    const [handler] = callArguments(stripped, 'reportArmingFailure');
    expect(handler, 'the arming call is not wrapped — a failure still says nothing was saved')
      .toBeDefined();

    const armed = soleIndexOf(
      stripped,
      'callTransaction<RecordAdminPasswordSetResult>',
      'the arming RPC call',
    );
    const guard = stripped.indexOf('try {', stripped.lastIndexOf('let armed', armed));
    expect(guard, 'no try precedes the arming call').toBeGreaterThan(-1);
    expect(guard, 'the try does not open before the arming call').toBeLessThan(armed);

    // The message states the OBSERVED state and names no cause. More than one
    // thing produces this state, and a confident wrong cause is worse than
    // none: it ends the search with the system's authority behind it.
    //
    // SCOPED TO THE HELPER'S OWN BODY, not grepped over the file. A sweep for
    // "Nothing was saved" near "create_account" flags the `createUser` failure
    // branch, where that sentence is TRUE — the account really was not created
    // there. A whole-file text rule cannot tell the two branches apart, and
    // the one it would flag is the correct one.
    const src = read(ADMIN_HANDLER);
    const from = src.indexOf('function reportArmingFailure');
    const to = src.indexOf('export function adminSpec');
    expect(from, 'reportArmingFailure is not defined in admin.ts').toBeGreaterThan(-1);
    expect(to, 'adminSpec is not defined in admin.ts').toBeGreaterThan(from);
    const helper = src.slice(from, to);

    // THE OPERATOR-VISIBLE SENTENCE ONLY, extracted from its own assignment.
    // Asserting over the helper's whole text — doc comment included — made the
    // cause-word sweep below fail on prose that EXPLAINS the rule ("it tells
    // the administrator to try again, and the retry is refused"). A rule about
    // what a message says must read the message, not the commentary around it;
    // the first word list tried here was chosen for how well it illustrated
    // the rule, by an author who had not run it against the text.
    const assigned = /const observed =([\s\S]*?);\n/.exec(helper);
    expect(assigned, 'the arming-failure message is not in a `const observed` assignment')
      .not.toBeNull();
    const message = assigned![1]!;

    expect(message, 'the message does not say the account exists').toMatch(/WAS created/);
    expect(message, 'the message does not say the typed password was not applied')
      .toMatch(/never applied/);
    expect(
      message,
      'the arming-failure message still claims nothing was saved, which is ' +
        'false once createUser has returned',
    ).not.toContain('Nothing was saved');

    // It must name no CAUSE. At least four things produce this state — a
    // transient database error, an unapplied migration, a refused self-target,
    // an idempotency conflict — so naming one of them as fact would send the
    // reader to fix the wrong thing with the system's authority behind it. The
    // cause is not lost: it reaches the server log through `internalDetail`.
    for (const cause of ['migration', 'permission', 'database', 'conflict', 'network']) {
      expect(message.toLowerCase(), `the message names a cause it did not test ("${cause}")`)
        .not.toContain(cause);
    }
    // Positive control for the extractor and for the sweep above: the cause IS
    // recorded, in the half of the helper that only the log sees.
    expect(helper).toMatch(/internalDetail:/);
  });

  it('confirms the address, because there is no SMTP to confirm it later', () => {
    const [created] = callArguments(stripped, 'admin.auth.admin.createUser');
    expect(created!).toMatch(/email_confirm:\s*true/);
  });

  it('passes full_name, which is what gives the profile a real display name', () => {
    // Verified against tg_handle_new_auth_user by execution: without this the
    // trigger falls back to the email's local part and every quality record
    // that account signs is attributed to "j.persaud".
    const [created] = callArguments(stripped, 'admin.auth.admin.createUser');
    expect(created!).toMatch(/user_metadata:\s*\{\s*full_name:/);
  });
});

describe('admin password boundary: no credential is recorded anywhere', () => {
  const sources: readonly [string, string][] = [
    ['admin.ts', stripComments(read(ADMIN_HANDLER))],
    ['change-own-password/index.ts', stripComments(read(CHANGE_OWN_PASSWORD))],
  ];

  it.each(sources)('%s: no audit or commit payload references the password', (_name, src) => {
    const blocks = [...callArguments(src, 'recordAudit'), ...callArguments(src, 'markCommitted')];
    expect(blocks.length, 'no recordAudit/markCommitted calls found to inspect')
      .toBeGreaterThan(0);

    for (const block of blocks) {
      // The identifiers holding the secret. `must_change_password` is a boolean
      // field name and is expected to appear — the check is deliberately on
      // the variables, not on the substring "password".
      expect(block).not.toContain('temporaryPassword');
      expect(block).not.toContain('newPassword');
    }
  });

  it('records the obligation it arms, so the trail is readable', () => {
    // Positive control for the extractor above: it really is reading the audit
    // payloads of the password actions, not an empty list.
    const blocks = callArguments(stripComments(read(ADMIN_HANDLER)), 'recordAudit');
    expect(blocks.some((b) => b.includes('must_change_password'))).toBe(true);
  });

  it('does not hand the RPC a password argument', () => {
    // rpc_record_admin_password_set has no password parameter. Passing one
    // would be a PGRST202 rather than a leak, but the leak is the reason the
    // parameter does not exist.
    const rpcTs = read(join(REPO, 'supabase/functions/_shared/rpc.ts'));
    const iface = /export interface RecordAdminPasswordSetArgs[\s\S]*?\n\}/.exec(rpcTs);
    expect(iface, 'RecordAdminPasswordSetArgs not declared').not.toBeNull();
    expect(iface![0]).not.toMatch(/p_password|p_temporary/);
  });
});

// ---------------------------------------------------------------------------
// The one endpoint whose caller holds no permission.
// ---------------------------------------------------------------------------
describe('change-own-password: the escape from the gate stays reachable', () => {
  const stripped = stripComments(read(CHANGE_OWN_PASSWORD));

  it.each([
    ['requirePermission', 'the Edge permission check would refuse an account that holds none'],
    ['require_permission', 'the SQL gate is raising for this very actor at this moment'],
    ['runMutation', 'that pipeline demands a Permission and an idempotency claim'],
    ['authenticate(', 'it refuses any account that is not active, including a new pending one'],
  ])('never calls %s — %s', (symbol) => {
    expect(
      stripped,
      `change-own-password must not call ${symbol}. Doing so makes the only way out of ` +
        'BFF_PASSWORD_CHANGE_REQUIRED unreachable, which locks every ' +
        'administrator-created account out of the system permanently while every ' +
        'individual line looks prudent. This is the "hardening" the function\'s own ' +
        'header warns a later reader will add by reflex.',
    ).not.toContain(symbol);
  });

  it('verifies the bearer token instead', () => {
    expect(stripped).toContain('auth.getUser(ctx.bearerToken)');
  });

  it('acts only on the verified uid and accepts no user id from the body', () => {
    expect(stripped).toContain('p_actor: user.id');
    // A body-supplied subject is the one thing this endpoint must not have.
    expect(stripped).not.toMatch(/body\[\s*'(userId|user_id|targetUser|p_actor)'\s*\]/);
  });

  it('refuses a new password equal to the current one', () => {
    expect(stripped).toContain('isSameAsCurrentPassword');
    expect(stripped).toContain("verdict === 'same'");
  });

  it('changes the credential before recording it', () => {
    const applied = soleIndexOf(
      stripped,
      'admin.auth.admin.updateUserById',
      'the call that changes the credential',
    );
    // `RPC.recordPasswordChanged` appears three times in this file — the two
    // retry calls and the failure detail — so the needle is the retry's first
    // call expression. See `soleIndexOf` for why a bare indexOf is not used.
    const recorded = stripped.indexOf('callTransaction<string>(admin, RPC.recordPasswordChanged');
    expect(applied).toBeGreaterThan(-1);
    expect(
      recorded,
      'the recording call was not found by its call expression; if it was ' +
        'reformatted, repoint this needle rather than widening it to the bare ' +
        'RPC name, which also matches the error detail below it',
    ).toBeGreaterThan(-1);
    expect(
      applied,
      'The password must change BEFORE the change is recorded. Reversed, a failure ' +
        'between the two clears the forced change while the administrator-set ' +
        'password is still in force: the gate reports itself satisfied over a ' +
        'credential two people know.',
    ).toBeLessThan(recorded);
  });

  it('enforces the length policy on the server, not only in the browser', () => {
    expect(stripped).toContain('passwordIssues(');
  });
});

// ---------------------------------------------------------------------------
// The number neither side of the contract fixed.
// ---------------------------------------------------------------------------
describe('password policy: the client is not weaker than the server', () => {
  /** The browser's own floor, read as text to avoid its module-load env check. */
  function clientMinimum(): number {
    const match = /export const MIN_PASSWORD_LENGTH\s*=\s*(\d+)/.exec(read(CLIENT_SUPABASE));
    if (match === null) {
      throw new Error(
        'MIN_PASSWORD_LENGTH not found in src/lib/supabase.ts. If it moved, this ' +
          'comparison is no longer reading the client side and must be repointed.',
      );
    }
    return Number(match[1]);
  }

  it('reads a plausible client minimum', () => {
    expect(clientMinimum()).toBeGreaterThan(0);
  });

  it('never promises in the browser what the server refuses', () => {
    // MIN_PASSWORD_LENGTH is absent from the cross-agent contract, so the
    // frontend and the Edge Function each chose a number independently — the
    // defect class the contract exists to prevent, arrived at by omission
    // rather than by disagreement. The browser's rule is stated to the
    // operator BEFORE they type; a server minimum above it turns that stated
    // rule into a lie that only surfaces on submit.
    expect(
      clientMinimum(),
      `src/lib/supabase.ts accepts ${clientMinimum()} characters and the Edge ` +
        `Functions require ${MIN_PASSWORD_LENGTH}. The client must be at least as ` +
        'strict as the server.',
    ).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });
});

describe('password policy: what it accepts and refuses', () => {
  const codes = (value: unknown): string[] =>
    passwordIssues('newPassword', value).map((i) => i.code);

  it('requires a password at all', () => {
    for (const absent of [undefined, null, '']) {
      expect(codes(absent)).toEqual(['required']);
    }
  });

  it('requires text', () => {
    for (const wrong of [12345678901, true, {}, []]) {
      expect(codes(wrong)).toEqual(['not_a_string']);
    }
  });

  it('refuses one character below the floor and accepts the floor itself', () => {
    // The boundary, from both sides. A minimum tested only well inside its
    // range cannot tell `<` from `<=`.
    //
    // THE PROBE VALUE IS NO LONGER `'x'.repeat(n)`. It used to be, and the
    // assertion recorded `xxxxxxxxxx` as a VALID password — one character, ten
    // times. It is now refused by the variety rules, so a single-character
    // string can no longer isolate the length boundary: it trips three rules at
    // once and tells you nothing about which. `floorValue(n)` is a string of
    // exactly `n` characters that breaks nothing else, so a change in the
    // length rule is the only thing that can move these two lines.
    const floorValue = (length: number): string =>
      'varied-9k'.repeat(Math.ceil(length / 9)).slice(0, length);
    expect(floorValue(MIN_PASSWORD_LENGTH)).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(codes(floorValue(MIN_PASSWORD_LENGTH - 1))).toEqual(['too_short']);
    expect(codes(floorValue(MIN_PASSWORD_LENGTH))).toEqual([]);
  });

  it('counts BYTES against the bcrypt ceiling, not characters', () => {
    // bcrypt discards everything past the 72nd byte, so a password measured in
    // characters can be truncated without anyone being told — and two
    // different passwords would then both sign in, including the temporary one
    // that was supposedly replaced.
    //
    // EIGHTEEN DIFFERENT 4-byte emoji, not one repeated eighteen times. The
    // repeated form was 72 bytes of a single character, which the variety rules
    // now refuse — correctly, and uselessly for this test, because a
    // `not_varied` code says nothing about the byte ceiling. Distinct
    // characters keep the byte arithmetic exactly as it was and leave the
    // ceiling as the only rule in play.
    const emoji = [...'😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑']; // 4 bytes each, 2 UTF-16 units each
    expect(emoji).toHaveLength(MAX_PASSWORD_BYTES / 4);
    expect(new Set(emoji).size).toBe(emoji.length);

    const under = emoji.join('');
    expect(passwordByteLength(under)).toBe(MAX_PASSWORD_BYTES);
    expect(codes(under)).toEqual([]);

    const over = `${under}x`;
    expect(passwordByteLength(over)).toBeGreaterThan(MAX_PASSWORD_BYTES);
    expect(codes(over)).toEqual(['too_long']);

    // The point of counting bytes: this is SHORTER than the ceiling in
    // characters and longer in bytes, so a character count would wave it
    // through and bcrypt would silently drop the end.
    expect(over.length).toBeLessThan(MAX_PASSWORD_BYTES);
  });

  it('refuses surrounding whitespace instead of trimming it away', () => {
    // THE ANSWER HERE CHANGED, AND THE PRINCIPLE DID NOT. This assertion used
    // to record a space-padded password as VALID, on the ground that trimming
    // would approve a credential different from the one GoTrue then stores.
    // That ground still holds — nothing here alters the value — but "accept it
    // unchanged" was the wrong conclusion from it. A space at either end of a
    // credential that gets read down a plant telephone and typed on a tablet is
    // invisible on screen and unspeakable out loud, and it fails at the
    // keyboard with no symptom to explain why. So the value is REFUSED, by its
    // own code, and still never modified.
    const padded = ` ${'varied-9k'} `;
    expect(codes(padded)).toEqual(['surrounding_whitespace']);
    // Interior whitespace is fine and is not the same thing: a spoken
    // passphrase is one of the better credentials for this setting.
    expect(codes('red tractor nine')).toEqual([]);
  });

  it('refuses a password made only of spaces', () => {
    // Named in the audit: ten spaces satisfied a length-only rule, and this
    // suite recorded it as valid. It is refused by its OWN code rather than
    // falling through to the variety rule, so the reply says what is wrong.
    expect(codes(' '.repeat(MIN_PASSWORD_LENGTH))).toEqual([
      'blank',
      'not_varied',
      'repeated_run',
    ]);
    expect(codes(' '.repeat(MIN_PASSWORD_LENGTH - 1))).toEqual([
      'too_short',
      'blank',
      'not_varied',
      'repeated_run',
    ]);
    // Not only U+0020: a tab-and-space string is whitespace-only too.
    expect(codes('\t \t \t \t \t ')).toContain('blank');
  });

  it('reports every broken rule at once', () => {
    // Short AND over the byte ceiling is impossible, so the multi-issue case is
    // checked by construction rather than pretended: one call, all findings.
    expect(passwordIssues('temporaryPassword', 'x'.repeat(3))[0]?.field).toBe(
      'temporaryPassword',
    );
  });
});

describe('email normalisation agrees with the column it is compared against', () => {
  it('lowercases and trims, the way the provisioning trigger stores it', () => {
    // profiles_email_lower_key is unique on lower(email) and
    // tg_handle_new_auth_user stores lower(btrim(email)). A duplicate check
    // against the raw input would treat '  Ada@Example.com ' as a new account.
    const parsed = normaliseEmail('  Ada@Example.COM ');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.email).toBe('ada@example.com');
  });

  it('refuses what the database would refuse', () => {
    // Mirrors the SQL shape test `like '%_@_%._%'`, so nothing this accepts
    // can be rejected one statement later by a CHECK constraint.
    for (const bad of ['', '   ', 'ada', 'ada@example', '@example.com', 'ada@.com', 'a b@c.com']) {
      const parsed = normaliseEmail(bad);
      expect(parsed.ok, `expected '${bad}' to be refused`).toBe(false);
    }
    for (const bad of [undefined, null, 42, {}]) {
      expect(normaliseEmail(bad).ok).toBe(false);
    }
  });

  it('accepts an ordinary plant address', () => {
    expect(normaliseEmail('j.persaud@bountyfarm.gy').ok).toBe(true);
  });
});
