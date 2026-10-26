/**
 * The mutation pipeline every write endpoint runs through. DENO-ONLY.
 *
 * One place, so no endpoint can omit a step. The order is the order PRD §10.3
 * prescribes: "Backend authenticates actor, authorizes action, validates
 * schema and checks the request registry. Under a server-side lock or
 * equivalent serialized writer, it allocates ID if necessary, updates the
 * operational row and corresponding metadata, then writes an event and request
 * outcome."
 *
 *   1. parse the body and the idempotency key           (reject early, cheaply)
 *   2. AUTHENTICATE from the bearer token only
 *   3. hash the canonical payload
 *   4. consult the request registry, atomically claim the key
 *   5. AUTHORISE, logging any denial
 *   6. run the endpoint's own work (validate, then one transactional RPC)
 *   7. record the request outcome so a retry replays rather than repeats
 *
 * Step 2 before step 5 and step 5 before step 6 are both load-bearing: a
 * forbidden request must never reach validation (it would leak which fields
 * exist), and no request may reach the database before the key is claimed (two
 * clicks would then both commit).
 *
 * Step 4 before step 5 is deliberate too, and the reason is less obvious: a
 * replay of a request that SUCCEEDED must return the stored response even if
 * the actor's permission was revoked in between, because the effect has
 * already happened and the client is only asking what it was. Re-authorising a
 * replay would turn a completed registration into a 403 and invite the client
 * to resubmit under a new key.
 */

import { ApiError } from '../errors.ts';
import {
  decideIdempotency,
  isValidIdempotencyKey,
  IN_PROGRESS_TIMEOUT_MS,
} from '../idempotency.ts';
import { payloadHash } from '../hash.ts';
import type { Permission } from '../../../../src/lib/roles.ts';
import {
  authenticate,
  adminClient,
  recordAudit,
  requirePermission,
  type Actor,
} from './authorize.ts';
import { IdempotencyStore } from './store.ts';
import { jsonResponse, readJsonBody, type RequestContext } from './http.ts';
import {
  decideFailureOutcome,
  INCOMPLETE_RESPONSE_MESSAGE,
  RESPONSE_INCOMPLETE_FIELD,
  RESPONSE_INCOMPLETE_REASON_PREFIX,
} from '../commitOutcome.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

/** Keys excluded from the payload hash, because they are not payload. */
const NON_PAYLOAD_KEYS = new Set(['idempotencyKey', 'idempotency_key']);

export interface MutationArgs {
  readonly actor: Actor;
  readonly admin: SupabaseClient;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly appVersion: string;
  /**
   * Declare that the transactional RPC has COMMITTED, and hand over the
   * minimal authoritative outcome.
   *
   * Call it on the line after `callTransaction` returns, before any further
   * work. Everything after that line — a second read, a projection, the audit
   * write, building the reply — can throw, and a throw after this call is
   * classified as `completed_unreported` rather than as a failure: the key is
   * recorded as succeeded, the caller receives this summary, and the
   * serialisation fault is audited separately. See `_shared/commitOutcome.ts`.
   *
   * Pass PRIMITIVES the transaction returned — ids, revision, timestamps — and
   * nothing computed, because this object is the one thing that must still be
   * renderable when the rest of the reply is not. It is JSON-sanitised before
   * use, so an unserialisable value is dropped rather than throwing here.
   *
   * Calling it more than once replaces the summary; calling it with a stale
   * value is the only way to make this reply wrong, so it takes the result of
   * the commit directly.
   */
  readonly markCommitted: (summary: Record<string, unknown>) => void;
}

export interface MutationSpec<TResult> {
  /** Stable operation name. Part of the idempotency key's scope. */
  readonly operation: string;
  /**
   * The operation name THE RPC CLAIMS THE KEY UNDER, when it differs.
   *
   * WHY THIS EXISTS, because it looks like duplication and is not. This adapter
   * claims the idempotency key BEFORE calling the RPC, and the RPC then claims
   * the same key again from inside Postgres. `claim_mutation` compares the two
   * operation names and raises `BFF_IDEMPOTENCY_CONFLICT: operation_mismatch`
   * on any disagreement — so the two strings are a contract, and nothing used
   * to compare them.
   *
   * They disagreed for every handler that prefixes its operation. Proved by
   * execution: a key claimed as `admin_action.set_roles` and then re-claimed by
   * `rpc_set_user_roles` as `set_user_roles` is REFUSED, while the identical
   * call with matching names is accepted. Ten of fifteen write actions were
   * unreachable that way — every administrator action, both hold actions and
   * two of three specification actions — while the five whose names happened to
   * match (register_sample, update_results, review_sample, set_disposition,
   * approve_specification) worked, which is exactly why it went unnoticed.
   *
   * The fix separates two things that were conflated. `operation` stays the
   * specific, action-level name and keeps feeding the AUDIT record, because
   * `deny_access` and `set_status` call one RPC and an audit trail that cannot
   * tell them apart is worse than one that can. `claimOperation` is what the
   * registry uses, and it must equal the literal the RPC hands
   * `claim_mutation`. `tests/idempotencyOperationContract.test.ts` enumerates
   * both sides and fails if any pair drifts again.
   *
   * Omit it when the two already agree — that is the common case and the
   * default.
   */
  readonly claimOperation?: string;
  readonly permission: Permission;
  readonly subjectType: string;
  /** Subject id for the audit event, read from the body before authorisation. */
  readonly subjectId?: (body: Record<string, unknown>) => string | null;
  readonly run: (args: MutationArgs) => Promise<TResult>;
}

function canonicalPayload(
  operation: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { _operation: operation };
  for (const [key, value] of Object.entries(body)) {
    if (NON_PAYLOAD_KEYS.has(key)) continue;
    payload[key] = value;
  }
  return payload;
}

export function readString(
  body: Record<string, unknown>,
  key: string,
  options?: { readonly required?: boolean; readonly maxLength?: number },
): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') {
    if (options?.required === true) {
      throw new ApiError('validation_failed', {
        details: { issues: [{ field: key, code: 'required', message: `${key} is required.` }] },
      });
    }
    return null;
  }
  if (typeof value !== 'string') {
    throw new ApiError('validation_failed', {
      details: { issues: [{ field: key, code: 'not_a_string', message: `${key} must be text.` }] },
    });
  }
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new ApiError('validation_failed', {
      details: {
        issues: [{ field: key, code: 'too_long', message: `${key} is too long.` }],
      },
    });
  }
  return value;
}

export function readInteger(
  body: Record<string, unknown>,
  key: string,
  options?: { readonly required?: boolean; readonly min?: number },
): number | null {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options?.required === true) {
      throw new ApiError('validation_failed', {
        details: { issues: [{ field: key, code: 'required', message: `${key} is required.` }] },
      });
    }
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || (options?.min !== undefined && n < options.min)) {
    throw new ApiError('validation_failed', {
      details: {
        issues: [{ field: key, code: 'not_a_number', message: `${key} must be a whole number.` }],
      },
    });
  }
  return n;
}

export function readValues(body: Record<string, unknown>): Record<string, unknown> {
  const values = body['values'];
  if (values === undefined || values === null) return {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    throw new ApiError('bad_request', { message: '"values" must be an object of field keys.' });
  }
  return values as Record<string, unknown>;
}

/**
 * `expectedRevision` for an update.
 *
 * Mandatory, with no default. PRD §6.1 requires optimistic concurrency with a
 * monotonic revision, and a missing expectation would mean "overwrite whatever
 * is there" — exactly the silent overwrite FR-013 forbids.
 */
export function requireExpectedRevision(body: Record<string, unknown>): number {
  const value = readInteger(body, 'expectedRevision', { required: true, min: 1 });
  if (value === null) {
    throw new ApiError('bad_request', {
      message: 'expectedRevision is required so a stale edit can be detected.',
    });
  }
  return value;
}

/** Map a thrown Postgres error from a transactional RPC onto a typed error. */
export function mapPostgresError(name: string, error: { code?: string; message: string }): ApiError {
  const message = error.message;

  // The RPCs raise these with a recognisable prefix so the edge can classify
  // them without parsing free text from the driver.
  if (message.includes('BFF_REVISION_CONFLICT')) {
    const match = /current_revision=(\d+)/.exec(message);
    return new ApiError('revision_conflict', {
      details: { currentRevision: match === null ? null : Number(match[1]) },
      internalDetail: `${name}: ${message}`,
    });
  }
  if (message.includes('BFF_NOT_FOUND')) {
    return new ApiError('not_found', { internalDetail: `${name}: ${message}` });
  }
  if (message.includes('BFF_FORBIDDEN')) {
    return new ApiError('forbidden', { internalDetail: `${name}: ${message}` });
  }
  if (message.includes('BFF_SEPARATION_OF_DUTIES')) {
    return new ApiError('separation_of_duties', { internalDetail: `${name}: ${message}` });
  }
  if (message.includes('BFF_TRANSITION_NOT_ALLOWED')) {
    return new ApiError('validation_failed', {
      message: 'That change is not allowed from the sample’s current state.',
      internalDetail: `${name}: ${message}`,
    });
  }
  if (error.code === 'PGRST202') {
    return new ApiError('rpc_not_deployed', { internalDetail: `${name}: ${message}` });
  }
  return new ApiError('internal', { internalDetail: `${name}: ${message}` });
}

/**
 * Call a transactional RPC and map its errors.
 *
 * `args` is `object`, not `Record<string, unknown>`. An interface declared in
 * `_shared/rpc.ts` — the file that exists to be the single authority on each
 * RPC's argument list — has no index signature, so it is NOT assignable to
 * `Record<string, unknown>` and the only way to pass one was to spread it into
 * an anonymous literal, which discards the very checking the interface was
 * declared for. A caller can now build `const args: HoldArgs = {...}` and have
 * a misspelt or missing `p_` argument fail at compile time instead of becoming
 * a `function not found` at run time. Nothing is lost: the old type permitted
 * any key with any value.
 */
export async function callTransaction<T>(
  admin: SupabaseClient,
  name: string,
  args: object,
): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error !== null) throw mapPostgresError(name, error);
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || row === undefined) {
    throw new ApiError('internal', { internalDetail: `${name} returned no row` });
  }
  return row as T;
}

/**
 * A spec, or a function that picks one once the body has been read.
 *
 * The factory form is what makes an action router possible. A router cannot
 * choose its spec before `runMutation` runs, because the action is IN the
 * body and a `Request` body can only be read once — reading it in the router
 * and again here would fail. Passing a factory keeps one body read and one
 * pipeline: the action is parsed, the spec selected, and every later step
 * (idempotency claim, authorisation, audit) is the same code every
 * single-purpose endpoint runs.
 *
 * The factory may throw a typed `ApiError` for an unrecognised action, and
 * that throw happens BEFORE the idempotency key is claimed — a malformed
 * request must not consume a key.
 */
export type MutationSpecSource<TResult> =
  | MutationSpec<TResult>
  | ((body: Record<string, unknown>) => MutationSpec<TResult>);

export async function runMutation<TResult>(
  ctx: RequestContext,
  source: MutationSpecSource<TResult>,
): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  const spec = typeof source === 'function' ? source(body) : source;

  // 1. The key. Header first, body as a fallback for clients that cannot set
  //    custom headers through a proxy.
  const key = ctx.idempotencyKey ?? body['idempotencyKey'] ?? body['idempotency_key'];
  if (!isValidIdempotencyKey(key)) {
    throw new ApiError('bad_request', {
      message:
        'Every save must carry an Idempotency-Key header so a retry cannot create a second record.',
      details: { header: 'Idempotency-Key', expected: '16-128 characters, e.g. a UUID' },
    });
  }

  // 2. Identity, from the token and nothing else.
  const actor = await authenticate(ctx.bearerToken);
  const admin = adminClient();
  const registry = new IdempotencyStore(admin);
  const now = new Date();

  // 3. Canonical payload hash.
  const hash = payloadHash(canonicalPayload(spec.operation, body));
  // The registry is keyed by the name the RPC will re-claim under; the audit
  // record below still uses the specific `spec.operation`. See `claimOperation`.
  const claimOperation = spec.claimOperation ?? spec.operation;

  const incoming = {
    key,
    operation: claimOperation,
    actorId: actor.userId,
    payloadHash: hash,
  };

  // 4. Fast path: an already-completed identical request replays without
  //    touching anything else.
  const existing = await registry.read(key, claimOperation);
  const firstDecision = decideIdempotency(existing, incoming, now);

  if (firstDecision.action === 'replay') {
    return jsonResponse(firstDecision.response, {
      request: ctx.request,
      headers: { 'idempotent-replay': 'true' },
    });
  }
  if (firstDecision.action === 'conflict') {
    throw new ApiError('idempotency_conflict', { details: { reason: firstDecision.reason } });
  }
  if (firstDecision.action === 'in_progress') {
    throw new ApiError('idempotency_in_progress', {
      details: { sinceMs: firstDecision.sinceMs },
    });
  }

  // Atomic claim. Between the read above and here, a concurrent request with
  // the same key may have won, so the returned row is re-decided rather than
  // assumed.
  const claim = await registry.begin({
    key,
    operation: claimOperation,
    actorId: actor.userId,
    payloadHash: hash,
    staleAfterMs: IN_PROGRESS_TIMEOUT_MS,
  });

  if (!claim.claimed) {
    const second = decideIdempotency(claim.record, incoming, new Date());
    switch (second.action) {
      case 'replay':
        return jsonResponse(second.response, {
          request: ctx.request,
          headers: { 'idempotent-replay': 'true' },
        });
      case 'conflict':
        throw new ApiError('idempotency_conflict', { details: { reason: second.reason } });
      default:
        // Someone else owns the key right now. Poll; do not resend.
        throw new ApiError('idempotency_in_progress', { details: { sinceMs: 0 } });
    }
  }

  // 5. Authorisation, with the denial logged (FR-002).
  const subjectId = spec.subjectId?.(body) ?? null;
  await requirePermission({
    actor,
    permission: spec.permission,
    action: spec.operation,
    subjectType: spec.subjectType,
    subjectId,
    appVersion: ctx.appVersion,
  });

  // 6/7. Run, then record the outcome either way.
  //
  // The commit point is tracked here, outside the `try`, so the `catch` can
  // tell "the work did not happen" from "the work happened and the reply could
  // not be built". Those two need opposite entries in the request registry and
  // opposite answers to the caller; before this flag existed they shared one.
  let committed = false;
  let committedSummary: Record<string, unknown> | null = null;

  try {
    const result = await spec.run({
      actor,
      admin,
      body,
      idempotencyKey: key,
      payloadHash: hash,
      appVersion: ctx.appVersion,
      markCommitted: (summary) => {
        committed = true;
        committedSummary = summary;
      },
    });

    await registry.complete({
      key,
      operation: claimOperation,
      actorId: actor.userId,
      state: 'succeeded',
      response: result,
    });

    return jsonResponse(result, { request: ctx.request, status: 200 });
  } catch (error) {
    const apiError =
      error instanceof ApiError
        ? error
        : new ApiError('internal', {
            internalDetail: error instanceof Error ? error.message : String(error),
            cause: error,
          });

    // Which of the three outcomes is this? The classification is a pure
    // function in `_shared/commitOutcome.ts` so it can be tested exhaustively;
    // this block only carries it out.
    //
    //   leave     the key belongs to another payload or another in-flight
    //             caller — do not rebind it;
    //   failed    the work did not happen — the key stays retryable with the
    //             same payload;
    //   succeeded the work DID happen and only the reply failed — the key
    //             records the real outcome so a replay returns it.
    const outcome = decideFailureOutcome({
      committed,
      committedSummary,
      errorCode: apiError.code,
      errorStatus: apiError.status,
    });

    if (outcome.registry !== 'leave') {
      await registry.complete({
        key,
        operation: claimOperation,
        actorId: actor.userId,
        state: outcome.registry,
        response:
          outcome.respond === null ? { error: { code: apiError.code } } : outcome.respond,
      });
    }

    await recordAudit({
      actorId: actor.userId,
      action: spec.operation,
      subjectType: spec.subjectType,
      subjectId,
      outcome: outcome.auditOutcome,
      reason: outcome.auditReason,
      // On the post-commit path this is the only record of WHAT went wrong,
      // since the caller is answered 200. The internal detail stays in the
      // server log line below; the audit event carries the code.
      after:
        outcome.kind === 'completed_unreported'
          ? { [RESPONSE_INCOMPLETE_FIELD]: true, failed_after_commit: apiError.code }
          : undefined,
      appVersion: ctx.appVersion,
    });

    if (outcome.kind === 'completed_unreported') {
      // Loud in the log, because a 200 is otherwise indistinguishable from a
      // clean one. This is a real fault in this function's own code: the
      // transaction committed and the handler could not describe it.
      console.error(
        JSON.stringify({
          event: 'mutation_response_incomplete',
          operation: spec.operation,
          correlationId: ctx.correlationId,
          subjectType: spec.subjectType,
          subjectId,
          code: apiError.code,
          detail: apiError.internalDetail ?? apiError.message,
        }),
      );

      try {
        return jsonResponse(outcome.respond, {
          request: ctx.request,
          status: 200,
          headers: { 'response-incomplete': 'true' },
        });
      } catch (serialisationError) {
        // Last resort. `commitOutcome.jsonSafe` makes this unreachable for any
        // summary an endpoint can pass, but the one thing this path may never
        // do is fall through to a 500 saying nothing was saved. So the
        // identifiers are dropped and the FACT is still reported truthfully.
        console.error(
          JSON.stringify({
            event: 'mutation_incomplete_response_unserialisable',
            operation: spec.operation,
            correlationId: ctx.correlationId,
            detail:
              serialisationError instanceof Error
                ? serialisationError.message
                : String(serialisationError),
          }),
        );
        return jsonResponse(
          {
            [RESPONSE_INCOMPLETE_FIELD]: true,
            responseIncompleteReason: `${RESPONSE_INCOMPLETE_REASON_PREFIX}:${apiError.code}`,
            message: INCOMPLETE_RESPONSE_MESSAGE,
          },
          {
            request: ctx.request,
            status: 200,
            headers: { 'response-incomplete': 'true' },
          },
        );
      }
    }

    throw apiError;
  }
}
