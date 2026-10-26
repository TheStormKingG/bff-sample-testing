/**
 * NO CREDENTIAL REACHES THE IDEMPOTENCY DIGEST, measured rather than grepped.
 *
 * ===========================================================================
 * WHAT WENT WRONG
 * ===========================================================================
 * `adapters/mutation.ts` canonicalised every key of a request body except the
 * idempotency key and hashed the result into
 * `public.idempotency_requests.payload_hash`. One of those keys was
 * `temporaryPassword`. The digest is an UNSALTED SINGLE ROUND of sha256 and the
 * `authenticated` role holds SELECT on that table, so the administrator's
 * chosen credential was stored, for the lifetime of the row, in a form a GPU
 * recovers from a wordlist in seconds — and worse than that here, because every
 * other field in the hashed object (the action, the address, the display name,
 * the reason) is independently readable from the audit event the same operation
 * writes. A digest is only as strong as the entropy of the part an attacker
 * cannot already obtain, and that part was the password alone.
 *
 * ===========================================================================
 * WHY THESE ASSERTIONS ARE PROPERTIES AND NOT SOURCE-TEXT MATCHES
 * ===========================================================================
 * `tests/adminPasswordBoundary.test.ts` can only read `adapters/mutation.ts`
 * and `handlers/admin.ts` as TEXT, because both reach
 * `npm:@supabase/supabase-js` and this runner cannot resolve it. A test of the
 * form `expect(source).toContain('secretBodyKeys')` passes whether or not the
 * filter works, and a mutation run that deletes the filter breaks exactly that
 * grep — which looks like coverage and is a tautology.
 *
 * So the filter lives in `_shared/hash.ts`, which is PURE, and everything below
 * CALLS it: the measured claim is "the digest does not change when only the
 * credential changes", with its positive control "the digest does change when
 * an ordinary field changes". Deleting the filter fails the first; filtering
 * everything fails the second.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CREDENTIAL_KEY_PATTERN,
  NON_PAYLOAD_KEYS,
  isCredentialBearingKey,
  payloadHash,
  requestPayloadHash,
} from '../supabase/functions/_shared/hash.ts';

// process.cwd(), not import.meta.url: this repository's directory name contains
// a space, and `new URL(...).pathname` percent-encodes it into a path that does
// not exist. Vitest runs from the project root.
const REPO = process.cwd();
const FUNCTIONS = join(REPO, 'supabase/functions');

/** A realistic `create_account` body, in the exact shape the browser sends. */
function createAccountBody(password: string): Record<string, unknown> {
  return {
    action: 'create_account',
    email: 'j.persaud@bountyfarm.gy',
    displayName: 'Jaipaul Persaud',
    reason: 'Authorised by the plant manager; identity confirmed in person.',
    temporaryPassword: password,
    idempotencyKey: '0191f2c4-9f4b-7c19-9b8e-2f4a6c8d0e12',
  };
}

const OPERATION = 'admin_action.create_account';
const DECLARED = ['temporaryPassword'];

describe('the payload digest cannot carry a credential', () => {
  it('produces the same digest for two different passwords', () => {
    // THE DEFECT, stated as the property that was false. Nothing else about
    // the request differs.
    const a = requestPayloadHash(OPERATION, createAccountBody('acdf-h3k9-mn7r'), DECLARED);
    const b = requestPayloadHash(OPERATION, createAccountBody('tuwx-4m7p-ejkn'), DECLARED);
    expect(a.hash).toBe(b.hash);
  });

  it('still distinguishes two requests that differ in an ordinary field', () => {
    // POSITIVE CONTROL. Without it, a filter that withheld EVERY key would
    // satisfy the assertion above and destroy the idempotency contract: same
    // key plus a wholly different request would replay instead of conflicting.
    const base = createAccountBody('acdf-h3k9-mn7r');
    const other = { ...base, email: 'r.khan@bountyfarm.gy' };
    expect(requestPayloadHash(OPERATION, base, DECLARED).hash).not.toBe(
      requestPayloadHash(OPERATION, other, DECLARED).hash,
    );

    // And in every other ordinary field, one at a time, so a filter that
    // happened to keep only `email` would not pass.
    for (const [key, changed] of [
      ['action', 'set_password'],
      ['displayName', 'Someone Else'],
      ['reason', 'a different reason'],
    ] as const) {
      expect(
        requestPayloadHash(OPERATION, { ...base, [key]: changed }, DECLARED).hash,
        `changing '${key}' did not change the digest, so it no longer discriminates`,
      ).not.toBe(requestPayloadHash(OPERATION, base, DECLARED).hash);
    }
  });

  it('reports exactly which keys it hashed and which it withheld', () => {
    const digest = requestPayloadHash(OPERATION, createAccountBody('acdf-h3k9-mn7r'), DECLARED);
    expect(digest.hashedKeys).toEqual(['action', 'displayName', 'email', 'reason']);
    expect(digest.withheldKeys).toEqual(['temporaryPassword']);
    // Declared, so nothing to report as a gap.
    expect(digest.undeclaredSecretKeys).toEqual([]);
  });

  it('leaves a digest whose every remaining field is in the audit event anyway', () => {
    // WHY THE FIX IS SUFFICIENT AND NOT MERELY NARROWER. The row now holds a
    // digest over the action, the address, the display name and the reason —
    // all four of which `identity.password_set_by_administrator` records in
    // plaintext for the same operation. A digest over values the reader already
    // has is a checksum; it narrows nothing down. That is the difference
    // between this fix and, say, salting.
    const digest = requestPayloadHash(OPERATION, createAccountBody('acdf-h3k9-mn7r'), DECLARED);
    const auditedInPlaintext = new Set(['action', 'displayName', 'email', 'reason']);
    for (const key of digest.hashedKeys) {
      expect(
        auditedInPlaintext.has(key),
        `'${key}' is hashed into payload_hash but is NOT independently readable ` +
          'from the audit event, so the digest still narrows it down',
      ).toBe(true);
    }
  });

  it('withholds the credential even when nothing declared it', () => {
    // DENY BY SHAPE. Forgetting `secretBodyKeys` must not be able to cause the
    // leak the declaration exists to prevent.
    const undeclared = requestPayloadHash(OPERATION, createAccountBody('acdf-h3k9-mn7r'), []);
    expect(undeclared.withheldKeys).toEqual(['temporaryPassword']);
    // And the gap is REPORTED, so the pipeline can log the key's name. A rule
    // whose only enforcement is a comment is a rule the next author never sees.
    expect(undeclared.undeclaredSecretKeys).toEqual(['temporaryPassword']);
    // Same digest either way: the declaration changes the reporting, not the
    // hash. Otherwise the two paths would conflict with each other.
    expect(undeclared.hash).toBe(
      requestPayloadHash(OPERATION, createAccountBody('acdf-h3k9-mn7r'), DECLARED).hash,
    );
  });

  it('gives a retry that carries NO password the same digest as the first attempt', () => {
    // AN INTERACTION WORTH PINNING, because it is load-bearing for a change in
    // another slice and neither side would notice it breaking.
    //
    // `src/hooks/useAdmin.ts` now holds the plaintext in a stash keyed by the
    // idempotency key and TAKES IT OUT — get-then-delete — when the request is
    // built, so the credential never enters the mutation cache. The
    // consequence is that a SECOND send under the same key carries no
    // `temporaryPassword` field at all.
    //
    // Under the old canonicaliser those two bodies hashed differently, so a
    // retry after a transient failure would have been refused as
    // `idempotency_conflict` — the retry path broken outright, by two correct
    // changes meeting. With the credential withheld, the digest is computed
    // over the same four fields either way, so the retry is correctly
    // recognised as the same request. Asserted rather than reasoned, because
    // the property belongs to neither slice alone.
    const withCredential = createAccountBody('acdf-h3k9-mn7r');
    const withoutCredential: Record<string, unknown> = { ...withCredential };
    delete withoutCredential['temporaryPassword'];
    expect('temporaryPassword' in withoutCredential).toBe(false);

    expect(requestPayloadHash(OPERATION, withoutCredential, DECLARED).hash).toBe(
      requestPayloadHash(OPERATION, withCredential, DECLARED).hash,
    );
    // The retry reports nothing withheld, because nothing credential-bearing
    // was present — not because the filter stopped working.
    expect(requestPayloadHash(OPERATION, withoutCredential, DECLARED).withheldKeys).toEqual([]);
    expect(requestPayloadHash(OPERATION, withCredential, DECLARED).withheldKeys).toEqual([
      'temporaryPassword',
    ]);
  });

  it('keeps withholding the idempotency key itself', () => {
    // The pre-existing rule, which the new filter must not have dropped: the
    // key is what the digest is compared UNDER, so hashing it would make every
    // request its own payload and the replay guarantee vacuous.
    const base = createAccountBody('acdf-h3k9-mn7r');
    const reKeyed = { ...base, idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    expect(requestPayloadHash(OPERATION, base, DECLARED).hash).toBe(
      requestPayloadHash(OPERATION, reKeyed, DECLARED).hash,
    );
    expect([...NON_PAYLOAD_KEYS].sort()).toEqual(['idempotencyKey', 'idempotency_key']);
  });

  it('folds the operation in, so one body sent to two endpoints is a conflict', () => {
    const base = createAccountBody('acdf-h3k9-mn7r');
    expect(requestPayloadHash('admin_action.create_account', base, DECLARED).hash).not.toBe(
      requestPayloadHash('admin_action.set_password', base, DECLARED).hash,
    );
  });

  it('is a plain payloadHash of the filtered object, not a second algorithm', () => {
    // The column is `sha256:`-prefixed hex and migration 0010 constrains its
    // shape. A new digest function here would have been a silent format change.
    const digest = requestPayloadHash(OPERATION, createAccountBody('x'), DECLARED);
    expect(digest.hash).toBe(
      payloadHash({
        _operation: OPERATION,
        action: 'create_account',
        displayName: 'Jaipaul Persaud',
        email: 'j.persaud@bountyfarm.gy',
        reason: 'Authorised by the plant manager; identity confirmed in person.',
      }),
    );
    expect(digest.hash.startsWith('sha256:')).toBe(true);
  });
});

describe('what the exclusion costs the idempotency contract', () => {
  it('turns a same-key different-password request from a conflict into a replay', () => {
    // PINNED SO THE NEXT READER FINDS THE ANSWER RATHER THAN THE QUESTION.
    //
    // The digest is the discriminator: same key + same digest replays the
    // stored outcome, same key + a different digest is refused as
    // `idempotency_conflict`. The credential was one of the discriminated
    // fields. So this request pair — one key, one target, two passwords — used
    // to be REFUSED and now REPLAYS: the second caller receives the first
    // request's stored 200 with `idempotent-replay: true`, and the password it
    // carried is never applied.
    const first = requestPayloadHash(OPERATION, createAccountBody('acdf-h3k9-mn7r'), DECLARED);
    const second = requestPayloadHash(OPERATION, createAccountBody('tuwx-4m7p-ejkn'), DECLARED);
    expect(second.hash).toBe(first.hash); // => decideIdempotency returns 'replay', not 'conflict'

    // THAT IS THE CORRECT TRADE AND IT IS INHERENT, not an artefact of this
    // filter. To discriminate on a value you must retain something that varies
    // with it; to stop retaining a function of the value you must stop
    // discriminating on it. A salt does not help, because it would live in the
    // same readable row; only a keyed digest whose key sits outside that store
    // would, which is a different design with its own key management for a
    // discrimination nothing has ever needed.
    //
    // AND IT IS UNREACHABLE THROUGH THE APPLICATION, which is what makes it
    // acceptable rather than merely defensible. Both password screens call
    // `newIdempotencyKey()` inside the submit handler and bind the password to
    // that key, so a changed password always travels under a new key.
    //
    // THAT CLAIM IS NOT ASSERTED HERE, DELIBERATELY. It is a property of
    // `src/pages/AdminPage.tsx` and `src/hooks/useAdmin.ts`, which belong to a
    // different ownership slice and were being rewritten while this suite was
    // written — an earlier version of this test matched on their source text
    // and went red within the hour for a refactor that changed nothing about
    // the property. A cross-boundary text assertion over a file somebody else
    // is actively editing fails in THEIR commit for a reason that looks like
    // ours, which gets the suite disabled rather than the bug fixed. The
    // dependency is recorded as prose for the owner of those files, and what
    // is asserted here is only what this slice controls.
    //
    // IF THAT CLIENT BEHAVIOUR EVER CHANGES, the consequence is bounded and
    // recoverable rather than dangerous: the credential in force is still one
    // an administrator chose, the account is still armed and holds no
    // authority, and the remedy is Reset password. It is a confusing dead end,
    // not an attribution hole.
  });
});

// ---------------------------------------------------------------------------
// THE ENFORCEMENT THAT IS NOT A COMMENT.
//
// The filter is a denylist — a shape pattern plus a declared list — and a
// denylist is one forgotten key away from the same leak. What carries it
// instead of a comment nobody will read: this block derives EVERY request-body
// key the whole tree reads, classifies each one through the real predicate, and
// fails if the credential-shaped set is not exactly the declared set. Adding
// `apiToken` to a handler turns it red in the same commit.
// ---------------------------------------------------------------------------

/**
 * Comments out, strings in.
 *
 * The sweeps below look for credential IDENTIFIERS, and a comment explaining
 * that no credential is recorded contains the word "credential" — so without
 * this the documentation of the rule trips the check for the rule. String
 * literals are left intact: an action name or an operation name IS a literal.
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
function callArgumentText(src: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    const open = at + needle.length - 1;
    let closed = false;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(open + 1, i));
          from = i;
          closed = true;
          break;
        }
      }
    }
    if (!closed) return out;
  }
}

/**
 * Credential-shaped identifiers appearing in a VALUE position inside a call to
 * `recordAudit`, `console.log`, `console.error` or `markCommitted`.
 *
 * Value position, not key position: `must_change_password: true` is a column
 * name recording an obligation and is not a credential, while
 * `{ detail: newPassword }`, `{ pw }` and `` `${newPassword}` `` all are. That
 * is why the lookahead is `[,})\n]` — the characters that follow a value.
 *
 * WHAT IT CANNOT SEE, so the clean verdict is not read as more than it is: an
 * alias. `const p = newPassword; recordAudit({ after: { p } })` defeats any
 * identifier sweep, and only a type- or dataflow-level check would catch it.
 * Also returns the number of sink argument blocks it examined, because a zero
 * from an extractor that matched nothing is indistinguishable from a zero from
 * a clean tree.
 */
function sinkCredentialIdentifiers(source: string): {
  readonly identifiers: string[];
  readonly blocks: number;
} {
  const identifiers: string[] = [];
  let blocks = 0;
  const src = stripComments(source);
  for (const sink of ['recordAudit', 'console.error', 'console.log', 'markCommitted']) {
    for (const block of callArgumentText(src, sink)) {
      blocks++;
      for (const m of block.matchAll(/(?:^|[^.\w'"])([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,})\n])/g)) {
        if (isCredentialBearingKey(m[1]!)) identifiers.push(m[1]!);
      }
    }
  }
  return { identifiers, blocks };
}

/** Every `.ts` file under `supabase/functions`, recursively. */
function functionModules(dir: string = FUNCTIONS): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...functionModules(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Every request-body key any Edge module reads.
 *
 * Two spellings, because the tree uses two: `body['x']` and the
 * `readString(body, 'x')` / `readInteger(body, 'x')` helpers. A sweep over only
 * the first would miss `displayName`, `reason` and fourteen others — which is
 * most of the surface, and all of it would have read as a clean result.
 */
function bodyKeys(): Set<string> {
  const keys = new Set<string>();
  for (const path of functionModules()) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/body\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) {
      keys.add(m[1]!);
    }
    for (const m of src.matchAll(
      /read(?:String|Integer)\(\s*body\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    )) {
      keys.add(m[1]!);
    }
  }
  return keys;
}

describe('the credential-key denylist is checked against the whole tree', () => {
  const modules = functionModules();
  const keys = bodyKeys();

  it('reads the tree it claims to read', () => {
    // RECONCILE THE DENOMINATOR, by a means the extractor does not share. A
    // precise non-zero count reads as proof the instrument works; what matters
    // is how many units it SHOULD have examined. 47 modules and ~40 keys as of
    // this change — asserted as floors, so growth does not fail the suite but
    // a collapse to a handful does.
    expect(modules.length, 'the module sweep found almost nothing').toBeGreaterThanOrEqual(40);
    expect(keys.size, 'the body-key extractor found almost nothing').toBeGreaterThanOrEqual(35);
    // Positive control for each of the two spellings separately: a regex that
    // silently stopped matching one of them would still clear the floors above.
    expect(keys.has('temporaryPassword'), "the body['x'] spelling is not being read").toBe(true);
    expect(keys.has('displayName'), 'the readString(body, "x") spelling is not being read')
      .toBe(true);
  });

  it('classifies exactly the credential-bearing keys and nothing else', () => {
    const flagged = [...keys].filter(isCredentialBearingKey).sort();

    // THE DECLARED SET. `newPassword` is here and is NOT declared on any
    // MutationSpec, deliberately: it only reaches `change-own-password`, which
    // does not use `runMutation` and writes no digest at all. It is still
    // withheld by shape, so if that endpoint were ever moved onto the pipeline
    // the credential would not leak in the move.
    expect(flagged).toEqual(['newPassword', 'temporaryPassword']);

    // NEGATIVE CONTROL over every other key the tree reads. This is the half
    // that fails if the pattern is widened carelessly: an unanchored `key`
    // would withhold `listKey`, `fieldKey` and `workbookKey` and silently
    // destroy their idempotency discrimination, with no test red anywhere else.
    for (const key of keys) {
      if (flagged.includes(key)) continue;
      expect(
        isCredentialBearingKey(key),
        `'${key}' is an ordinary payload field and would be withheld from the ` +
          'digest, which removes it from idempotency discrimination',
      ).toBe(false);
    }
  });

  it('is declared on the only spec whose endpoint carries a credential', () => {
    const admin = readFileSync(join(FUNCTIONS, '_shared/handlers/admin.ts'), 'utf8');
    expect(admin).toContain('secretBodyKeys:');
    for (const key of DECLARED) expect(admin).toContain(`'${key}'`);

    // Every OTHER spec factory must be free of a credential-bearing body key,
    // so an absent declaration there is correct rather than forgotten.
    for (const path of modules) {
      if (path.endsWith('handlers/admin.ts')) continue;
      if (path.endsWith('change-own-password/index.ts')) continue;
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/body\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) {
        expect(
          isCredentialBearingKey(m[1]!),
          `${path} reads a credential-bearing body key '${m[1]}' and its spec ` +
            'declares no secretBodyKeys',
        ).toBe(false);
      }
    }
  });

  it('refuses the names a future credential is likely to arrive under', () => {
    // Positive side of the pattern, with values chosen to span the spellings
    // rather than to illustrate one.
    for (const name of [
      'password',
      'newPassword',
      'temporaryPassword',
      'passphrase',
      'clientSecret',
      'secret',
      'apiKey',
      'api_key',
      'accessToken',
      'refreshToken',
      'privateKey',
      'private_key',
      'credential',
      'credentials',
      'authorization',
      'bearerToken',
      'key',
    ]) {
      expect(isCredentialBearingKey(name), `'${name}' would reach the digest`).toBe(true);
    }
  });

  it('lets no credential identifier reach any audit, log or commit payload', () => {
    // THE WHOLE-TREE VERSION OF THE PER-FILE SWEEP in
    // tests/adminPasswordBoundary.test.ts. That one reads the two files that
    // handle a credential today; this reads EVERY module and every one of four
    // sinks, so an endpoint that starts handling one tomorrow is covered
    // without anybody remembering to extend a list. A sweep framed as "the
    // files I know carry a secret" has already excluded whichever file acquires
    // one next.
    // VALIDATE THE INSTRUMENT FIRST. A zero from a sweep whose regex matched
    // nothing reads exactly like a zero from a clean tree, and the extractor
    // below has already been wrong once: an earlier version matched an
    // identifier only in VALUE position, which is correct, and I had exempted
    // `must_change_password` on the assumption it matched in KEY position,
    // which it never did. The exemption was unnecessary and its symmetric
    // check caught that — but only because the check existed.
    const fixture = `
      recordAudit({ actorId: id, after: { pw: newPassword } });
      console.error(JSON.stringify({ event: 'x', detail: temporaryPassword }));
      markCommitted({ ok: true, secret: clientSecret });
      recordAudit({ after: { must_change_password: true, status: s } });
      console.log(JSON.stringify({ fn: 'f', ms: 1 }));
    `;
    const found = sinkCredentialIdentifiers(fixture);
    expect(
      found.identifiers.sort(),
      'the sink extractor cannot see a credential in a value position, so a ' +
        'zero over the real tree would mean nothing',
    ).toEqual(['clientSecret', 'newPassword', 'temporaryPassword']);
    expect(found.blocks, 'the extractor found no sink call sites in the fixture')
      .toBeGreaterThanOrEqual(5);
    // Negative half: a field NAME that matches the pattern is not a credential
    // and must not be reported. `must_change_password: true` is the obligation
    // being recorded, and it appears in the real audit payload.
    expect(found.identifiers).not.toContain('must_change_password');

    // ONE NAME in the real tree matches the pattern and is not a credential:
    // an audit ACTION name. Checked from both sides, so a stale exemption
    // fails here rather than standing as a hole with a comment on it.
    const exempt = new Map([
      ['PASSWORD_CHANGED_ACTION', 'an audit action name, not a credential'],
    ]);

    let scanned = 0;
    const seenExempt = new Set<string>();
    const hits: string[] = [];

    for (const path of modules) {
      const result = sinkCredentialIdentifiers(readFileSync(path, 'utf8'));
      scanned += result.blocks;
      for (const id of result.identifiers) {
        if (exempt.has(id)) {
          seenExempt.add(id);
          continue;
        }
        hits.push(`${path} -> ${id}`);
      }
    }

    // Reconcile the denominator by a means the extractor does not share: 59
    // sink argument blocks as of this change.
    expect(scanned, 'the sink sweep found almost no call sites').toBeGreaterThanOrEqual(45);
    expect(hits).toEqual([]);

    for (const [id, why] of exempt) {
      expect(
        seenExempt.has(id),
        `'${id}' is exempted (${why}) but no longer appears in any sink, so the ` +
          'exemption is stale and should be removed rather than left standing',
      ).toBe(true);
    }
  });

  it('leaves the project’s own non-secret "key"-suffixed names alone', () => {
    // The anchoring, from the other side. These three are real names in this
    // codebase and all three MUST keep discriminating.
    for (const name of ['listKey', 'fieldKey', 'workbookKey', 'idempotencyKey', 'monkey']) {
      expect(isCredentialBearingKey(name), `'${name}' is not a credential`).toBe(false);
    }
    // And the pattern is anchored rather than merely happening to miss them.
    expect(CREDENTIAL_KEY_PATTERN.source).toContain('^key$');
  });
});
