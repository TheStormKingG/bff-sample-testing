/**
 * Payload and row hashing.
 *
 * Two distinct hashes, deliberately not interchangeable:
 *
 *  - `payloadHash(x)` hashes a REQUEST, and backs the idempotency contract:
 *    same key + same payload replays the stored result, same key + different
 *    payload is a conflict (PRD §10.3, Master Prompt §10).
 *
 *  - `requestPayloadHash(operation, body, secretKeys)` is the ONLY way a
 *    request BODY becomes a `payloadHash`, and it withholds credential-bearing
 *    keys before hashing. See the long note above it: a plaintext password
 *    reached this digest once, and the digest is stored where other signed-in
 *    users can read it.
 *
 *  - `rowHash(cells)` hashes a SHEET ROW as 19/15/13/11/16 strings, and backs
 *    idempotent projection: after an unknown outcome the worker re-reads the
 *    row and compares it against what it meant to write, so a Google timeout
 *    that actually succeeded resolves to a no-op instead of a second row
 *    (Master Prompt §7).
 *
 * Both are prefixed with the algorithm so a future change is a visible,
 * migratable value rather than a silent re-interpretation of stored digests.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import { canonicalise } from './canonical.ts';
import { sha256Hex } from './sha256.ts';

export const HASH_PREFIX = 'sha256:';

/** Digest of a request payload. Stored in `idempotency_requests.payload_hash`. */
export function payloadHash(payload: unknown): string {
  return HASH_PREFIX + sha256Hex(canonicalise(payload));
}

// ---------------------------------------------------------------------------
// Request bodies: what may and may not reach the digest
//
// WHAT WENT WRONG, SO THE CONSEQUENCE IS ON THE PAGE RATHER THAN IN A TICKET.
// The mutation adapter canonicalised every key of the request body except the
// idempotency key, and hashed the result into
// `public.idempotency_requests.payload_hash`. One of those keys was
// `temporaryPassword`. So the administrator's chosen credential was stored,
// for the lifetime of the row, as an UNSALTED SINGLE-ROUND sha256, in a column
// the `authenticated` role can SELECT.
//
// That is recoverable, and the arithmetic is not close. One round of sha256
// over a 10–14 character password is a few seconds of commodity GPU work
// against a wordlist, and worse than that here: every OTHER field hashed
// alongside it — the action, the email address, the display name, the
// administrator's reason — is independently readable from the audit event the
// SAME operation writes. A digest is only as strong as the entropy of the part
// an attacker cannot already obtain, and that part was the password alone. The
// row was therefore an offline guessing oracle against the one credential in
// this system that two people know, readable by a third.
//
// The comment in `_shared/handlers/admin.ts` said "NO PASSWORD IS AUDITED,
// LOGGED OR RETURNED", and that sentence was true of the audit payloads, the
// commit summary, the stored response and the HTTP log. The enumeration was one
// layer short, and the missing layer was the one whose whole purpose — a
// one-way hash — reads as the mitigation.
//
// ---------------------------------------------------------------------------
// WHY THIS IS HERE AND NOT IN THE ADAPTER, AND WHAT KIND OF FIX IT IS
//
// Three properties were wanted, and the location delivers two of them:
//
//  1. NO PATH FROM A REQUEST BODY TO A DIGEST THAT SKIPS THE FILTER. A body is
//     hashed by `requestPayloadHash` and by nothing else; the filter is inside
//     it, not applied by its caller. A future endpoint cannot forget the step
//     because there is no step to forget — the only alternative is to call the
//     generic `payloadHash` on a hand-built object, which is a visible and
//     unusual thing to write next to forty call sites that do not.
//
//  2. EXECUTABLE BY THE TEST SUITE. This module is PURE. The adapter is not:
//     it imports `npm:@supabase/supabase-js`, which the vitest runner cannot
//     resolve, so anything placed there could only ever be asserted as SOURCE
//     TEXT. A test that greps for the presence of a filter passes whether or
//     not the filter works, and a mutation run that deletes the filter breaks
//     exactly that grep, which looks like coverage and is a tautology. Here the
//     property — the digest does not change when only the credential changes —
//     is measured.
//
//  3. and the one it does NOT deliver: TYPE-LEVEL CERTAINTY. See the
//     trade-off below.
//
// THE TRADE-OFF, STATED. This is a DENYLIST: a shape pattern plus a declared
// list of names. A denylist is one forgotten key away from the same leak, and
// a body key called `userChosenPhrase` would be hashed in full. Two stronger
// designs exist and were not chosen:
//
//   - AN ALLOWLIST PER OPERATION — hash only the keys the spec names. Nothing
//     new can leak, ever, because a new key is excluded by default. The cost
//     is that a key nobody remembers to declare silently stops participating
//     in idempotency discrimination, which turns a confidentiality failure
//     into a quiet correctness failure across all seven endpoints and about
//     forty keys. Fail-safe for secrecy, fail-open for the replay contract.
//
//   - A TYPED HASHABLE PAYLOAD — the pipeline takes a declared struct instead
//     of `Record<string, unknown>`, so the compiler enumerates what is hashed.
//     This is the real structural answer. It requires changing how every
//     handler reads its body and so touches the whole of
//     `supabase/functions/**` plus the browser's request shapes.
//
// WHAT CARRIES THE DENYLIST INSTEAD OF A COMMENT, because the next person to
// add a credential-bearing action will not read this one: a test enumerates
// EVERY body key read anywhere under `supabase/functions/**` by grepping the
// tree, classifies each through `isCredentialBearingKey`, and fails if the set
// of credential-shaped keys is not exactly the declared set. Adding
// `apiToken` to a handler turns that test red in the same commit. And
// `requestPayloadHash` returns the names it withheld, so the adapter can log a
// key that matched the shape but was never declared — the one case the test
// cannot see is a key that matches NEITHER, which is the residual above.
// ---------------------------------------------------------------------------

/**
 * Keys that are request METADATA rather than payload.
 *
 * The idempotency key is the thing the hash is compared under; hashing it would
 * make every request its own payload and the replay guarantee vacuous.
 */
export const NON_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'idempotency_key',
]);

/**
 * Body-key names that are credential-bearing BY SHAPE, independent of any
 * declaration.
 *
 * Deny-by-default for the common case: a key whose name contains `password`,
 * `passphrase`, `secret`, `credential`, `token`, or an API/private-key spelling
 * never reaches the digest even if nobody declared it. `^key$` is anchored on
 * purpose — this project has `listKey`, `fieldKey` and `workbookKey`, none of
 * which is a secret, and an unanchored `key` would withhold all three and
 * silently destroy their idempotency discrimination.
 *
 * Checked against the complete set of body keys this tree reads, in
 * `tests/payloadSecrets.test.ts`, from both sides: every credential-shaped key
 * is withheld, and every one of the ~40 ordinary keys is NOT.
 */
export const CREDENTIAL_KEY_PATTERN =
  /pass(word|phrase)|secret|credential|token|apikey|api_key|privatekey|private_key|authorization|bearer|^key$/i;

/** Would this body key be withheld from the digest on the strength of its name? */
export function isCredentialBearingKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

export interface RequestDigest {
  /** The value for `idempotency_requests.payload_hash`. */
  readonly hash: string;
  /** Body keys that contributed to `hash`, sorted. For reporting only. */
  readonly hashedKeys: readonly string[];
  /**
   * Credential-bearing keys that were present and withheld, sorted.
   *
   * NAMES ONLY, never values — this is reported into a server log line.
   */
  readonly withheldKeys: readonly string[];
  /**
   * Withheld by `CREDENTIAL_KEY_PATTERN` while absent from the spec's own
   * declaration. Non-empty means a credential-bearing key reached this
   * pipeline without anybody declaring it: the digest is safe, and the
   * declaration needs updating. The caller logs it.
   */
  readonly undeclaredSecretKeys: readonly string[];
}

/**
 * Digest a REQUEST BODY for the idempotency registry, withholding credentials.
 *
 * `operation` is folded in as `_operation`, so the same body sent to two
 * different endpoints under one key is a conflict rather than a replay.
 *
 * WHAT THIS CHANGES ABOUT IDEMPOTENCY, because it is not only a confidentiality
 * fix. The digest is the discriminator of the replay contract: same key + same
 * digest replays the stored outcome, same key + a different digest is refused
 * as `idempotency_conflict`. The credential was one of the fields being
 * discriminated on. Withholding it means two requests carrying the SAME
 * idempotency key, the same target and DIFFERENT passwords now produce the same
 * digest, so the second one REPLAYS the first — it returns the first request's
 * stored 200 with `idempotent-replay: true`, and the password it carried is
 * never applied. Before, it was refused with a conflict that told the caller to
 * retry under a new key.
 *
 * THAT IS THE CORRECT TRADE, and it is inherent rather than an artefact. To
 * discriminate on a value you must retain something that varies with it; to
 * stop retaining a function of the value you must stop discriminating on it. A
 * salt does not rescue it, because the salt would be stored in the same
 * readable row; only a keyed digest whose key lives outside that store would,
 * and that is a different design with its own key-management cost for a
 * discrimination nothing has ever needed.
 *
 * AND THE REPLAY IS UNREACHABLE THROUGH THE APPLICATION, which is what makes it
 * acceptable rather than merely defensible. Both password screens mint a fresh
 * key inside the submit handler (`newIdempotencyKey()` in `PasswordRow` and in
 * the create-account form, `src/pages/AdminPage.tsx`) and clear the password
 * field afterwards, so a changed password always travels under a new key. The
 * only way to reach the collapsed case is a scripted client that deliberately
 * reuses a key with a different password — and for that client the outcome is
 * recoverable, not dangerous: the credential in force is still one an
 * administrator chose, the account is still armed, and the remedy is Reset
 * password. It is pinned by `tests/payloadSecrets.test.ts` so the next reader
 * finds the answer rather than the question.
 *
 * WHAT IS LEFT IN THE ROW AFTERWARDS, for the record: for `create_account`, a
 * digest over `{_operation, action, displayName, email, reason}`. Every one of
 * those is independently readable from the `identity.password_set_by_administrator`
 * audit event the same operation writes, so the digest no longer narrows
 * anything down. That is what turns it from an oracle back into a checksum.
 */
export function requestPayloadHash(
  operation: string,
  body: Record<string, unknown>,
  declaredSecretKeys: readonly string[] = [],
): RequestDigest {
  const declared = new Set(declaredSecretKeys);
  const payload: Record<string, unknown> = { _operation: operation };
  const hashedKeys: string[] = [];
  const withheldKeys: string[] = [];
  const undeclaredSecretKeys: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (NON_PAYLOAD_KEYS.has(key)) continue;
    const byShape = isCredentialBearingKey(key);
    if (declared.has(key) || byShape) {
      withheldKeys.push(key);
      if (byShape && !declared.has(key)) undeclaredSecretKeys.push(key);
      continue;
    }
    payload[key] = value;
    hashedKeys.push(key);
  }

  return {
    hash: payloadHash(payload),
    hashedKeys: hashedKeys.sort(),
    withheldKeys: withheldKeys.sort(),
    undeclaredSecretKeys: undeclaredSecretKeys.sort(),
  };
}

/**
 * Normalise a sheet row to exactly `width` cells.
 *
 * The Sheets API truncates trailing empty cells on read, so a row written as
 * 19 cells ending in three blanks comes back as 16. Comparing the raw arrays
 * would report a difference that does not exist and trigger a pointless
 * rewrite on every single pass. Only TRAILING absence is normalised: an
 * interior blank is real data ("not measured") and is preserved, because
 * rule 8 forbids conflating blank with zero.
 */
export function normaliseRow(
  cells: readonly (string | null | undefined)[],
  width: number,
): string[] {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`Row width must be a positive integer, received ${width}`);
  }
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    out.push(cells[i] ?? '');
  }
  return out;
}

/** Digest of an operational row, normalised to the stage's column count. */
export function rowHash(
  cells: readonly (string | null | undefined)[],
  width: number,
): string {
  return HASH_PREFIX + sha256Hex(canonicalise(normaliseRow(cells, width)));
}

/**
 * Do these two rows carry the same operational content?
 *
 * Compared cell by cell after width normalisation rather than by digest, so a
 * caller that wants to show the operator WHICH column drifted can use
 * `rowDifferences` without recomputing anything.
 */
export function rowsEqual(
  a: readonly (string | null | undefined)[],
  b: readonly (string | null | undefined)[],
  width: number,
): boolean {
  const left = normaliseRow(a, width);
  const right = normaliseRow(b, width);
  for (let i = 0; i < width; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export interface CellDifference {
  readonly index: number;
  readonly expected: string;
  readonly actual: string;
}

/** Every differing column, for a drift report an administrator can read. */
export function rowDifferences(
  expected: readonly (string | null | undefined)[],
  actual: readonly (string | null | undefined)[],
  width: number,
): CellDifference[] {
  const left = normaliseRow(expected, width);
  const right = normaliseRow(actual, width);
  const diffs: CellDifference[] = [];
  for (let i = 0; i < width; i++) {
    if (left[i] !== right[i]) {
      diffs.push({ index: i, expected: left[i]!, actual: right[i]! });
    }
  }
  return diffs;
}
