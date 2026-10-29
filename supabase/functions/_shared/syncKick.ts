/**
 * Whether a registration may nudge the Sheets sync worker, and how.
 *
 * PURE: no Deno, no npm/jsr, no I/O. Every decision this module makes is a
 * function of values passed in, so the vitest suite exercises both branches of
 * each one without a network, a database, or an Edge Runtime.
 *
 * ===========================================================================
 * WHAT THIS IS FOR, AND WHAT IT IS EMPHATICALLY NOT
 * ===========================================================================
 * A registered sample lands in `sheet_sync_outbox` as `pending`, and until
 * something invokes `sheets-sync-worker` it stays there. `docs/setup.md`
 * section 7 says so in as many words: "Nothing schedules it today (D-18)."
 * So an operator submits a form and watches "Google Sheets sync pending"
 * indefinitely.
 *
 * The kick closes the LATENCY half of that: the worker is nudged as soon as a
 * row is queued, so the row appears in the workbook in seconds instead of
 * waiting for whatever runs next.
 *
 * IT IS NOT A SCHEDULER, AND MUST NEVER BE DESCRIBED AS ONE. An edge-triggered
 * kick fires when a registration happens, and the outbox's own retry policy
 * schedules work for INSTANTS IN THE FUTURE: a transient failure becomes
 * `retry_scheduled` with a `next_retry_at`, which the claim query will not
 * return until that moment arrives. Nothing in an edge-triggered design fires
 * at a future instant. So the last sample of a shift, if its first attempt
 * fails transiently, waits for the next registration — which may be the next
 * morning. A periodic runner remains the mechanism of record; this only makes
 * the common case fast.
 *
 * ===========================================================================
 * WHY A KICK CAN BE REFUSED, AND WHY EACH REASON IS CHECKED HERE
 * ===========================================================================
 * Dispatching a request that is certain to be refused is worse than not
 * dispatching one: it burns an invocation, writes a confusing log line, and
 * teaches whoever reads the logs to ignore them. Each refusal below names a
 * precondition the WORKER itself enforces, so this module declines rather
 * than discovering the refusal over the network.
 *
 *  - `platform_url_unset`      there is no address to post to.
 *  - `service_role_key_unset`  the worker sits behind the platform gateway's
 *                              default `verify_jwt` — `supabase/config.toml`
 *                              has no `[functions.*]` block, and the README,
 *                              architecture and setup docs all record the
 *                              consequence. So a kick needs TWO credentials:
 *                              a bearer token the gateway accepts, and the
 *                              scheduler secret the handler checks. Sending
 *                              only the secret is refused above the code that
 *                              would have honoured it.
 *  - `scheduler_secret_unset`  the handler's own check. There is deliberately
 *                              no "allow when unconfigured" branch, so an
 *                              unset secret is a refusal and never an opening.
 *  - `sheets_not_configured`   the worker's FIRST act, before authorisation
 *                              and before the lease, is to refuse with a 500
 *                              when `SHEETS_SPREADSHEET_ID` or
 *                              `GOOGLE_SERVICE_ACCOUNT_JSON` is unset. On a
 *                              deployment where Sheets is not set up, every
 *                              registration would otherwise fire a doomed
 *                              request.
 */

/** Why a kick was not dispatched. Names only — never a secret's value. */
export type KickRefusal =
  | 'platform_url_unset'
  | 'service_role_key_unset'
  | 'scheduler_secret_unset'
  | 'sheets_not_configured';

export type KickPlan =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly refusals: readonly KickRefusal[] };

export interface KickEnvironment {
  readonly supabaseUrl: string | null;
  readonly hasServiceRoleKey: boolean;
  readonly hasSchedulerSecret: boolean;
  readonly sheetsConfigured: boolean;
}

/** The worker's address, derived from the platform URL. */
export function workerUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/functions/v1/sheets-sync-worker`;
}

/**
 * Decide whether to kick, collecting EVERY reason not to.
 *
 * All refusals are gathered rather than short-circuiting on the first,
 * because an administrator reading the log wants the whole list — finding
 * three missing secrets one deployment at a time is the slowest possible way
 * to configure this.
 */
export function planKick(env: KickEnvironment): KickPlan {
  const trimmed = env.supabaseUrl === null ? '' : env.supabaseUrl.trim();
  const url = trimmed === '' ? null : trimmed;

  const refusals: KickRefusal[] = [];
  if (url === null) refusals.push('platform_url_unset');
  if (!env.hasServiceRoleKey) refusals.push('service_role_key_unset');
  if (!env.hasSchedulerSecret) refusals.push('scheduler_secret_unset');
  if (!env.sheetsConfigured) refusals.push('sheets_not_configured');

  if (url === null || refusals.length > 0) return { ok: false, refusals };
  return { ok: true, url: workerUrl(url) };
}

/**
 * How a kick's HTTP result should be reported.
 *
 * THREE OUTCOMES, NOT TWO. Filing a busy response under the same name as a
 * rejected one — or, worse, under the same name as a success — is how a log
 * stops being read.
 *
 *  - `sent`      the worker accepted the nudge.
 *  - `busy`      another worker holds the workbook lease. This is the
 *                DOCUMENTED CORRECT OUTCOME of two triggers overlapping: the
 *                lease is a single-writer guarantee, and the loser having
 *                nothing to do is the guarantee working. Not an error.
 *  - `rejected`  anything else — a 500 because configuration is missing, a
 *                401 at the gateway, a 403 from the handler. A deployment
 *                fault an administrator has to act on.
 */
export type KickOutcome = 'sent' | 'busy' | 'rejected';

/**
 * 409 is the worker's `lease_conflict`. 423 is included because "locked" is
 * the other status a future lease implementation might reasonably use, and
 * misreporting a healthy loser as a fault is the error that matters here.
 */
export function classifyKickStatus(status: number): KickOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 409 || status === 423) return 'busy';
  return 'rejected';
}

/**
 * The runtime's "finish this after the response has been sent" hook, if it
 * exists.
 *
 * FEATURE-DETECTED, NEVER ASSUMED. `EdgeRuntime` appears nowhere else in this
 * codebase — no function here has ever done background work — so there is no
 * local precedent to follow and nothing to infer availability from. A bare
 * `EdgeRuntime.waitUntil(...)` throws `ReferenceError` where the global is
 * absent, and it would throw inside a handler whose transaction has ALREADY
 * COMMITTED: the sample is registered, and the operator would be told the save
 * failed. So the lookup is guarded and the fallback is a deliberate choice
 * rather than a crash.
 *
 * Returns `null` when the runtime offers no such hook. The caller then does
 * not dispatch at all, rather than starting work the runtime is about to kill
 * — see the comment at the call site.
 */
export function resolveWaitUntil(
  globals: Readonly<Record<string, unknown>>,
): ((task: Promise<unknown>) => void) | null {
  const runtime = globals['EdgeRuntime'];
  if (typeof runtime !== 'object' || runtime === null) return null;
  const hook = (runtime as { waitUntil?: unknown }).waitUntil;
  if (typeof hook !== 'function') return null;
  return (task: Promise<unknown>): void => {
    (hook as (t: Promise<unknown>) => void).call(runtime, task);
  };
}
