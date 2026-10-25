/**
 * Registration: the one call that turns a filled-in form into a sample with a
 * durable identifier.
 *
 * ===========================================================================
 * WHY THIS GOES THROUGH AN EDGE FUNCTION AND NOT A TABLE WRITE
 * ===========================================================================
 * `register-sample` allocates the identifier inside a transaction, against
 * `sample_id_counters`, under a row lock, keyed on (prefix, plant-LOCAL
 * collection date). Master Prompt §5 forbids computing the sequence "by
 * COUNTIF, scanning last row or frontend counters" — all three are
 * read-then-write races that hand two operators the same ID. Nothing in the
 * browser may therefore propose an identifier, and nothing here does.
 *
 * The function also re-authorises the caller server-side, validates the
 * payload against the same registry this form was built from, writes the
 * audit event and enqueues the spreadsheet projection. Hiding a button is not
 * a control (Master Prompt §1): a denial comes back from there, and is
 * reported in the server's own words.
 *
 * ===========================================================================
 * IDEMPOTENCY IS THE CALLER'S RESPONSIBILITY, DELIBERATELY
 * ===========================================================================
 * FR-006's acceptance criterion is that "a retried request returns the
 * ORIGINAL registration". That only holds if a retry presents the SAME key,
 * so `idempotencyKey` is a required input rather than something generated per
 * call: a key minted inside the mutation would be fresh on every retry, and a
 * save that timed out after the server committed would quietly become a
 * second sample with a second identifier and a second spreadsheet row.
 *
 * So: generate one key with `newIdempotencyKey()` when the operator submits,
 * keep it for every retry of that same payload, and mint a new one only once
 * the submission succeeds or the operator changes the form.
 *
 * ===========================================================================
 * SUCCESS IS NEVER CLAIMED EARLY, AND NEVER CLAIMED FOR SHEETS
 * ===========================================================================
 * The mutation resolves only on a 200 carrying a sample id. There is no
 * optimistic update (FR-015, UAT-13). The returned `sheetSync` is the
 * server's own status object, and the spreadsheet row has NOT been written at
 * this point — it is queued. `isSheetConfirmed()` is the only sanctioned way
 * to ask whether the Sheets claim may be made, and it answers yes for exactly
 * one value (build rule 6).
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import type { Stage } from '@/forms/types';
import type { StageSubmitValues } from '@/forms/zodSchema';
import type { CaptureState } from '@/lib/workflow';

/** The deployed function name. A runtime string, so a missing deploy is a message. */
export const REGISTER_SAMPLE_FUNCTION = 'register-sample';

/**
 * Upstream traceability, declared not inferred. PRD §6.4: "A missing upstream
 * link is a recorded exception, not silent inference."
 */
export interface SampleLinkInput {
  readonly kind: string;
  readonly reference: string;
}

export interface RegisterSampleInput {
  readonly stage: Stage;
  /** The validated payload from `StageForm`, keyed by registry field key. */
  readonly values: StageSubmitValues;
  /** Field keys whose soft typo guard the operator confirmed. */
  readonly confirmedImplausible?: readonly string[];
  readonly links?: readonly SampleLinkInput[];
  readonly notes?: string;
  /** Same key for every retry of this submission. See the header comment. */
  readonly idempotencyKey: string;
  /**
   * Optimistic concurrency, for the case where registration is promoting an
   * existing record rather than creating one. A brand-new sample has no prior
   * revision, so this is normally absent and is omitted from the request
   * rather than sent as a guess.
   */
  readonly expectedRevision?: number;
}

/** The server's sync status. Only `confirmed` may be shown as being in Sheets. */
export interface SheetSyncStatus {
  readonly state: 'pending' | 'confirmed' | 'needs_attention' | 'blocked';
  /** The server's own wording. Display it; never substitute "Saved". */
  readonly label: string;
  readonly confirmedAt: string | null;
}

export interface RegisterSampleResult {
  readonly sampleUuid: string;
  /** The immutable human identifier, e.g. `RM-261024-01`. */
  readonly sampleId: string;
  readonly stage: Stage;
  readonly sheetTab: string;
  readonly revision: number;
  readonly captureState: CaptureState;
  /** ISO instant the server recorded the registration. */
  readonly recordedAt: string;
  readonly collection: {
    readonly plantLocalDate: string;
    readonly plantLocalTime: string;
    readonly instant: string;
    readonly timeZone: string;
  };
  readonly sheetSync: SheetSyncStatus;
  readonly outboxEventId: string | null;
}

/**
 * How a registration failed, in the terms a page has to act on.
 *
 * `duplicate_submission` and `already_in_progress` are the two 409s that mean
 * "do not resend this" — resending is how a double record gets created. Every
 * other kind says whether a retry of the same payload is worth offering.
 */
export type RegisterFailureKind =
  | 'duplicate_submission'
  | 'already_in_progress'
  | 'revision_conflict'
  | 'schema_drift'
  | 'validation'
  | 'not_authorised'
  | 'not_signed_in'
  | 'account_not_active'
  | 'not_deployed'
  | 'offline'
  | 'rate_limited'
  | 'server';

export interface RegisterFieldIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Server-side error codes this module reacts to.
 *
 * This list MIRRORS `ERROR_CODES` in
 * `supabase/functions/_shared/errors.ts`, which cannot be imported here: it is
 * Deno-resolved module code, and the browser bundle must not reach into the
 * functions tree. An unrecognised code is handled as `server` with the
 * server's own message, so the two drifting apart degrades to a readable
 * error rather than to a crash.
 */
const FAILURE_BY_CODE: Readonly<Record<string, RegisterFailureKind>> = {
  idempotency_conflict: 'duplicate_submission',
  idempotency_in_progress: 'already_in_progress',
  revision_conflict: 'revision_conflict',
  schema_drift: 'schema_drift',
  validation_failed: 'validation',
  bad_request: 'validation',
  forbidden: 'not_authorised',
  separation_of_duties: 'not_authorised',
  unauthenticated: 'not_signed_in',
  account_not_active: 'account_not_active',
  rate_limited: 'rate_limited',
  rpc_not_deployed: 'not_deployed',
  configuration_missing: 'server',
  sheets_unavailable: 'server',
  not_found: 'server',
  internal: 'server',
};

/** Kinds where presenting "try again" is safe: the request did not land. */
const RETRYABLE: ReadonlySet<RegisterFailureKind> = new Set<RegisterFailureKind>([
  'offline',
  'rate_limited',
  'server',
]);

export class RegisterSampleError extends Error {
  readonly kind: RegisterFailureKind;
  /** The server's error code, when it sent one. */
  readonly code: string | null;
  readonly status: number | null;
  /** Quotable to an administrator; correlates to the server log line. */
  readonly correlationId: string | null;
  readonly issues: readonly RegisterFieldIssue[];
  /** True only when resending the identical payload cannot double-record. */
  readonly retryable: boolean;

  constructor(args: {
    readonly kind: RegisterFailureKind;
    readonly message: string;
    readonly code?: string | null;
    readonly status?: number | null;
    readonly correlationId?: string | null;
    readonly issues?: readonly RegisterFieldIssue[];
  }) {
    super(args.message);
    this.name = 'RegisterSampleError';
    this.kind = args.kind;
    this.code = args.code ?? null;
    this.status = args.status ?? null;
    this.correlationId = args.correlationId ?? null;
    this.issues = args.issues ?? [];
    this.retryable = RETRYABLE.has(args.kind);
  }
}

/**
 * A fresh idempotency key.
 *
 * `crypto.randomUUID` is absent in an insecure context, which a plant tablet
 * on a plain-http LAN will be, so `getRandomValues` is the fallback. If
 * neither exists the key is NOT faked: a predictable or colliding key is how
 * two samples end up sharing one registration, so the honest outcome is a
 * refusal that names the cause.
 */
export function newIdempotencyKey(): string {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error(
    'This browser does not provide a secure random number generator, so a unique ' +
      'save key cannot be made. Open the app over https and try again.',
  );
}

/** The one sanctioned test for "may this be shown as being in Google Sheets?". */
export function isSheetConfirmed(sync: SheetSyncStatus | null | undefined): boolean {
  return sync?.state === 'confirmed' && typeof sync.confirmedAt === 'string';
}

function readIssues(details: unknown): readonly RegisterFieldIssue[] {
  if (typeof details !== 'object' || details === null) return [];
  const raw = (details as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];
  const issues: RegisterFieldIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { field?: unknown; message?: unknown };
    if (typeof record.field !== 'string' || typeof record.message !== 'string') continue;
    issues.push({ field: record.field, message: record.message });
  }
  return issues;
}

/**
 * Turn whatever `functions.invoke` rejected with into a typed failure.
 *
 * supabase-js collapses every non-2xx into one `FunctionsHttpError` whose
 * `message` is the generic "Edge Function returned a non-2xx status code", so
 * the body has to be read to find out what actually happened. Without this
 * step an authorisation denial, a validation failure and a duplicate
 * submission are indistinguishable to the operator.
 */
async function toRegisterError(error: unknown): Promise<RegisterSampleError> {
  if (error instanceof FunctionsFetchError) {
    return new RegisterSampleError({
      kind: 'offline',
      message:
        'The sample could not be sent. Nothing has been saved. Check the connection and try again.',
    });
  }

  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response | undefined;
    const status = typeof response?.status === 'number' ? response.status : null;

    let body: unknown = null;
    if (response !== undefined && typeof response.json === 'function') {
      try {
        body = await response.json();
      } catch {
        // A non-JSON body is itself information: the platform answered, not
        // our function. Handled by the 404 branch below.
        body = null;
      }
    }

    const envelope =
      typeof body === 'object' && body !== null
        ? ((body as { error?: unknown }).error as
            | { code?: unknown; message?: unknown; details?: unknown; correlationId?: unknown }
            | undefined)
        : undefined;

    const code = typeof envelope?.code === 'string' ? envelope.code : null;

    if (code === null) {
      // Our functions ALWAYS answer with `{ error: { code, ... } }`. A reply
      // without one came from the platform, and at 404 that means the function
      // is not deployed to this project.
      if (status === 404) {
        return new RegisterSampleError({
          kind: 'not_deployed',
          status,
          message:
            `The "${REGISTER_SAMPLE_FUNCTION}" service is not deployed to this project, so no ` +
            'sample can be registered. Nothing has been saved. An administrator must deploy ' +
            'the Edge Functions.',
        });
      }
      return new RegisterSampleError({
        kind: 'server',
        status,
        message:
          'The server refused the save and gave no reason that can be shown. Nothing has ' +
          'been saved. Try again, and tell an administrator if it keeps happening.',
      });
    }

    const kind = FAILURE_BY_CODE[code] ?? 'server';
    const message =
      typeof envelope?.message === 'string' && envelope.message !== ''
        ? envelope.message
        : 'The save was refused. Nothing has been saved.';

    return new RegisterSampleError({
      kind,
      code,
      status,
      message,
      correlationId:
        typeof envelope?.correlationId === 'string' ? envelope.correlationId : null,
      issues: readIssues(envelope?.details),
    });
  }

  return new RegisterSampleError({
    kind: 'server',
    message:
      error instanceof Error && error.message !== ''
        ? error.message
        : 'Something went wrong and nothing was saved. Please try again.',
  });
}

function isResult(value: unknown): value is RegisterSampleResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['sampleUuid'] === 'string' &&
    typeof record['sampleId'] === 'string' &&
    record['sampleId'] !== '' &&
    typeof record['recordedAt'] === 'string'
  );
}

function requestBody(input: RegisterSampleInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    stage: input.stage,
    values: input.values,
    // The header is the primary carrier; this is the documented fallback for a
    // proxy that strips custom headers. It is excluded from the server's
    // payload hash, so sending both cannot cause an idempotency conflict.
    idempotencyKey: input.idempotencyKey,
  };
  if (input.confirmedImplausible !== undefined && input.confirmedImplausible.length > 0) {
    body['confirmedImplausible'] = [...input.confirmedImplausible];
  }
  if (input.links !== undefined && input.links.length > 0) body['links'] = [...input.links];
  if (input.notes !== undefined && input.notes !== '') body['notes'] = input.notes;
  if (input.expectedRevision !== undefined) body['expectedRevision'] = input.expectedRevision;
  return body;
}

export function useRegisterSample() {
  const client = useQueryClient();

  const mutation = useMutation<RegisterSampleResult, RegisterSampleError, RegisterSampleInput>({
    mutationFn: async (input) => {
      const { data, error } = await supabase.functions.invoke(REGISTER_SAMPLE_FUNCTION, {
        body: requestBody(input),
        headers: { 'Idempotency-Key': input.idempotencyKey },
      });

      if (error !== null) throw await toRegisterError(error);

      if (!isResult(data)) {
        // A 200 without an identifier is not a registration. Reporting it as
        // success would tell an operator to write an ID on a bag that does
        // not exist (FR-015, UAT-13).
        throw new RegisterSampleError({
          kind: 'server',
          message:
            'The server replied without a sample ID, so the registration cannot be ' +
            'confirmed. Check the sample list before sending it again.',
        });
      }

      return data;
    },

    // No retry. A resend is only safe with the same key, and whether to offer
    // one at all depends on the failure kind, which is the page's decision.
    retry: false,

    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['samples'] });
      void client.invalidateQueries({ queryKey: ['sample', result.sampleUuid] });
      void client.invalidateQueries({ queryKey: ['reports'] });
    },
  });

  const { mutate, reset } = mutation;

  const register = useCallback(
    (input: RegisterSampleInput) => {
      mutate(input);
    },
    [mutate],
  );

  return useMemo(
    () => ({
      register,
      reset,
      /** True only after the server confirmed and returned an identifier. */
      result: mutation.data ?? null,
      error: mutation.error ?? null,
      isSaving: mutation.isPending,
      isRegistered: mutation.isSuccess,
    }),
    [mutation.data, mutation.error, mutation.isPending, mutation.isSuccess, register, reset],
  );
}
