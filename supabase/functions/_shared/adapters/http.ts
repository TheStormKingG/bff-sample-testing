/**
 * Request plumbing shared by every function entrypoint. DENO-ONLY.
 *
 * One `serve()` wrapper so that method checking, body limits, CORS, the
 * correlation id and — most importantly — error mapping cannot be forgotten by
 * an individual endpoint. Master Prompt §12 and PRD §11 require typed,
 * plain-language failures; a handler that threw straight out of `Deno.serve`
 * would return a stack trace to a public static client.
 */

import {
  ApiError,
  toErrorBody,
  toLogRecord,
  type ErrorCode,
} from '../errors.ts';
import { SheetsConfigurationError } from '../sheets.ts';
import { optionalEnv } from './env.ts';

/** 256 KiB. The largest legitimate payload is one 19-column row plus context. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface RequestContext {
  readonly request: Request;
  readonly correlationId: string;
  readonly appVersion: string;
  /** Raw bearer token, for building a user-scoped Supabase client. */
  readonly bearerToken: string | null;
  readonly idempotencyKey: string | null;
}

function corsHeaders(request: Request): Record<string, string> {
  const configured = optionalEnv('ALLOWED_ORIGINS', '').trim();
  const origin = request.headers.get('origin');

  // Authority comes from the Authorization header, never from a cookie, so a
  // permissive CORS policy is not a CSRF vector here. It is still narrowed
  // when ALLOWED_ORIGINS is configured, which the deploy checklist requires
  // for production.
  let allowOrigin = '*';
  if (configured !== '') {
    const list = configured.split(',').map((s) => s.trim()).filter((s) => s !== '');
    allowOrigin = origin !== null && list.includes(origin) ? origin : list[0] ?? '*';
  }

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-headers':
      'authorization, x-client-info, apikey, content-type, idempotency-key, x-sync-scheduler-secret',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; request: Request; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Quality decisions must never be served from a cache (Master Prompt §9:
      // "no stale quality decisions as current").
      'cache-control': 'no-store',
      ...corsHeaders(init.request),
      ...(init.headers ?? {}),
    },
  });
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = match[1];
  if (token === undefined) return null;
  const trimmed = token.trim();
  return trimmed === '' ? null : trimmed;
}

/** Read and parse the JSON body, enforcing a size limit before parsing. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError('bad_request', { message: 'The request is too large.' });
  }

  const raw = await request.text();
  // Checked again after reading: `content-length` is client-supplied.
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    throw new ApiError('bad_request', { message: 'The request is too large.' });
  }
  if (raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('bad_request', { message: 'The request body is not valid JSON.' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('bad_request', { message: 'The request body must be a JSON object.' });
  }
  return parsed as Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Promise<Response>;

export interface ServeOptions {
  /** Methods the endpoint accepts. `OPTIONS` is always handled. */
  readonly methods: readonly ('GET' | 'POST')[];
  /** Function name, for the log line. */
  readonly name: string;
}

/**
 * Wrap a handler.
 *
 * `SheetsConfigurationError` is mapped explicitly rather than falling through
 * to `internal`: an unset secret is an administrator's task, and "the system
 * is not fully configured" sends them to the setup checklist, while
 * "something went wrong" sends them nowhere.
 */
export function serveFunction(options: ServeOptions, handler: Handler): void {
  Deno.serve(async (request: Request) => {
    const correlationId = crypto.randomUUID();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const started = Date.now();
    try {
      if (!options.methods.includes(request.method as 'GET' | 'POST')) {
        throw new ApiError('method_not_allowed', {
          internalDetail: `${request.method} ${new URL(request.url).pathname}`,
        });
      }

      const response = await handler({
        request,
        correlationId,
        appVersion: optionalEnv('APP_VERSION', 'unknown'),
        bearerToken: bearerToken(request),
        idempotencyKey:
          request.headers.get('idempotency-key') ?? request.headers.get('x-idempotency-key'),
      });

      console.log(
        JSON.stringify({
          fn: options.name,
          correlationId,
          status: response.status,
          ms: Date.now() - started,
        }),
      );
      return response;
    } catch (error) {
      const mapped =
        error instanceof SheetsConfigurationError
          ? new ApiError('configuration_missing', {
              // Names only. `env.ts` never puts a value in this array.
              details: { missing: error.missing },
              internalDetail: error.message,
            })
          : error;

      const record = toLogRecord(mapped, correlationId);
      console.error(JSON.stringify({ fn: options.name, ms: Date.now() - started, ...record }));

      const body = toErrorBody(mapped, correlationId);
      const status = mapped instanceof ApiError ? mapped.status : 500;
      return jsonResponse(body, { status, request });
    }
  });
}

/** Shorthand for throwing a typed error from a handler. */
export function fail(code: ErrorCode, options?: { message?: string; details?: unknown; internalDetail?: string }): never {
  throw new ApiError(code, options);
}
