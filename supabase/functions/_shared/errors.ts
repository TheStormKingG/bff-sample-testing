/**
 * Typed error taxonomy for every Edge Function response.
 *
 * PRD §11 requires failures the operator can act on — "Not saved — check
 * connection and retry" rather than an exception trace — and Master Prompt §1
 * forbids leaking internals to a public static client. So this module is the
 * only place that turns a thrown value into a response body, and it emits a
 * fixed code, a plain-language message and optional structured details. A
 * stack trace never reaches the client; it is logged server-side against a
 * correlation id that the client can quote to an administrator.
 *
 * PURE: no Deno, no npm/jsr, no I/O. Imported by both the function
 * entrypoints and the vitest suite.
 */

export const ERROR_CODES = [
  /** No usable bearer token, or `auth.getUser()` rejected it. */
  'unauthenticated',
  /** Identity proven, but the profile is pending/suspended/disabled (FR-001). */
  'account_not_active',
  /** Authenticated and active, but the role lacks the permission (FR-002). */
  'forbidden',
  /** The actor may not act on this particular subject (roles.ts §SoD). */
  'separation_of_duties',
  /** Payload failed registry-derived validation (FR-008). */
  'validation_failed',
  /** Same idempotency key presented with a different payload or actor. */
  'idempotency_conflict',
  /** An earlier request with this key is still running; poll, do not resend. */
  'idempotency_in_progress',
  /** `expectedRevision` did not match the stored revision (PRD §6.1). */
  'revision_conflict',
  'not_found',
  /** Row-4 headers no longer match the registry; the writer is fenced off. */
  'schema_drift',
  /** Google Sheets is unreachable or returned an unknown outcome. */
  'sheets_unavailable',
  /** A required Edge Function secret is absent. Refuse rather than default. */
  'configuration_missing',
  /** Sheets API quota or our own rate limiter. */
  'rate_limited',
  'bad_request',
  'method_not_allowed',
  /** The database RPC this function depends on is not deployed. */
  'rpc_not_deployed',
  /** Another worker holds the workbook lease, or our fence is stale. */
  'lease_conflict',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  account_not_active: 403,
  forbidden: 403,
  separation_of_duties: 403,
  validation_failed: 422,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  revision_conflict: 409,
  not_found: 404,
  schema_drift: 409,
  sheets_unavailable: 503,
  configuration_missing: 500,
  rate_limited: 429,
  bad_request: 400,
  method_not_allowed: 405,
  rpc_not_deployed: 500,
  lease_conflict: 409,
  internal: 500,
};

/**
 * Operator-facing default text. A caller may override it, but never with
 * interpolated internals: these strings are shown to a plant operator.
 */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  unauthenticated: 'Please sign in again.',
  account_not_active:
    'Your account is waiting for approval. A supervisor must approve it before you can record samples.',
  forbidden: 'You are not authorised to do this.',
  separation_of_duties:
    'The same person cannot both propose and approve this. Ask a second authorised person.',
  validation_failed: 'Some entries need to be corrected before this can be saved.',
  idempotency_conflict:
    'This request was already sent with different details. Reload the sample and try again.',
  idempotency_in_progress: 'This save is still being processed. Please wait a moment.',
  revision_conflict:
    'Somebody else changed this sample while you were editing. Review their changes before saving.',
  not_found: 'That record could not be found.',
  schema_drift:
    'The Google Sheet column headings no longer match the system. Writing has been stopped until an administrator checks the workbook.',
  sheets_unavailable:
    'Recorded securely in the system. The Google Sheets copy is still pending.',
  configuration_missing:
    'The system is not fully configured. An administrator must finish setup.',
  rate_limited: 'Too many requests at once. Please wait a moment and try again.',
  bad_request: 'The request could not be understood.',
  method_not_allowed: 'That action is not available here.',
  rpc_not_deployed:
    'The system is not fully installed. An administrator must apply the database migrations.',
  lease_conflict: 'Another synchronisation run is already in progress.',
  internal: 'Something went wrong. Nothing was saved. Please try again.',
};

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    /** Structured, non-sensitive context: field issues, conflicting revision. */
    readonly details?: unknown;
    /** Quotable by the user; correlates to the server log line. */
    readonly correlationId: string;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  /** Server-only. Never serialised into the response. */
  readonly internalDetail: string | undefined;

  constructor(
    code: ErrorCode,
    options?: {
      message?: string;
      details?: unknown;
      internalDetail?: string;
      cause?: unknown;
    },
  ) {
    super(options?.message ?? ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options?.details;
    this.internalDetail = options?.internalDetail;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Build the response body. An unrecognised throw collapses to `internal` with
 * the generic message, so a driver-level string or a Postgres error text can
 * never become the operator-visible message.
 */
export function toErrorBody(value: unknown, correlationId: string): ApiErrorBody {
  if (isApiError(value)) {
    const base = {
      code: value.code,
      message: value.message,
      correlationId,
    };
    return {
      error: value.details === undefined ? base : { ...base, details: value.details },
    };
  }
  return {
    error: {
      code: 'internal',
      message: ERROR_MESSAGES.internal,
      correlationId,
    },
  };
}

/**
 * What to write to the server log. Keeps the detail that was withheld from the
 * client, and nothing that could be a secret value — callers pass names, never
 * contents, of configuration keys.
 */
export function toLogRecord(
  value: unknown,
  correlationId: string,
): Record<string, unknown> {
  if (isApiError(value)) {
    return {
      correlationId,
      code: value.code,
      status: value.status,
      message: value.message,
      internalDetail: value.internalDetail ?? null,
      cause: value.cause instanceof Error ? value.cause.message : null,
    };
  }
  return {
    correlationId,
    code: 'internal',
    status: 500,
    message: value instanceof Error ? value.message : String(value),
    stack: value instanceof Error ? value.stack : null,
  };
}
