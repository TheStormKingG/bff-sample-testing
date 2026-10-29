/**
 * Nudge the Sheets sync worker after a row is queued. Best effort, always.
 *
 * The decisions live in `_shared/syncKick.ts`, which is pure and tested. What
 * is here is only the wiring that cannot exist without Deno: reading secrets,
 * the fetch, and the runtime's post-response hook.
 *
 * ===========================================================================
 * THIS MUST NEVER AFFECT THE REGISTRATION. FOUR GUARANTEES.
 * ===========================================================================
 * By the time this runs the sample is COMMITTED. There is no outcome here
 * that should change what the operator is told, and no failure here that is
 * theirs to see.
 *
 *  1. IT CANNOT THROW. The whole body is inside a try/catch, including the
 *     env reads and the planning call, and the fetch runs inside its own.
 *  2. IT CANNOT DELAY. It is never awaited. The caller hands it to the
 *     runtime's post-response hook; if there is no such hook it does not run
 *     at all. `tests/syncKick.test.ts` asserts the absence of `await` in the
 *     caller's source, because that guarantee is one careless keyword from
 *     being lost and no type check would notice.
 *  3. IT CANNOT PRODUCE A FALSE GREEN. The response's `sheetSync` is computed
 *     from a literal `'pending'` before this is dispatched, and this function
 *     has no access to the response. "Recorded securely, Google Sheets sync
 *     pending" stays the honest claim; confirmation reaches the screen later,
 *     from the committed outbox state, exactly as before.
 *  4. IT HAS NO TIMEOUT, AND THAT IS THE DESIGN.
 *
 * ===========================================================================
 * WHY THERE IS NO TIMEOUT — THE POINT MOST LIKELY TO BE "FIXED" LATER
 * ===========================================================================
 * An abort here would not protect anybody. The operator's response has
 * already been sent, so there is no wall-clock budget left to defend.
 *
 * What an abort WOULD do is terminate a request to a worker that is holding
 * the workbook's single-writer lease — a lease released only in its own
 * `finally`, with a 60-second TTL. Cancelling the invocation can leak that
 * lease for the full minute, during which every other runner gets a 409 and
 * the outbox drains no further. That converts a latency optimisation into a
 * sync outage, caused by the optimisation itself.
 *
 * The response body is read and discarded rather than cancelled, for the same
 * reason: cancelling a stream signals the peer, and the peer is the process
 * holding the lease.
 *
 * If a bound is ever genuinely wanted it belongs INSIDE the worker, as a
 * wall-clock budget that exits through its own `finally` and releases the
 * lease on the way out. Never as a client-side abort.
 */

import {
  classifyKickStatus,
  planKick,
  type KickRefusal,
} from '../syncKick.ts';
import {
  REQUIRED_SHEETS_KEYS,
  SCHEDULER_SECRET_KEY,
  sheetsConfigured,
} from './env.ts';

function readEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value !== undefined && value.trim() !== '') return value;
  }
  return null;
}

/** Keys an administrator would have to set, named by the refusal. */
function missingKeysFor(refusals: readonly KickRefusal[]): readonly string[] {
  const keys: string[] = [];
  for (const refusal of refusals) {
    switch (refusal) {
      case 'platform_url_unset':
        keys.push('SUPABASE_URL');
        break;
      case 'service_role_key_unset':
        keys.push('SUPABASE_SERVICE_ROLE_KEY');
        break;
      case 'scheduler_secret_unset':
        keys.push(SCHEDULER_SECRET_KEY);
        break;
      case 'sheets_not_configured':
        keys.push(...REQUIRED_SHEETS_KEYS);
        break;
    }
  }
  return keys;
}

export interface KickArgs {
  readonly correlationId: string;
  readonly outboxEventId: string | null;
}

/**
 * Dispatch the nudge. Returns a promise the caller hands to the runtime; it
 * never rejects.
 */
export function kickSyncWorker(args: KickArgs): Promise<void> {
  const log = (record: Record<string, unknown>): void => {
    try {
      console.log(
        JSON.stringify({ fn: 'sync-kick', correlationId: args.correlationId, ...record }),
      );
    } catch {
      // Logging must not be able to disturb a committed registration.
    }
  };

  return (async (): Promise<void> => {
    try {
      const supabaseUrl = readEnv(['SUPABASE_URL', 'SB_URL']);
      const serviceRoleKey = readEnv([
        'SUPABASE_SERVICE_ROLE_KEY',
        'SB_SERVICE_ROLE_KEY',
        'SUPABASE_SECRET_KEY',
      ]);
      const schedulerSecret = readEnv([SCHEDULER_SECRET_KEY]);

      const plan = planKick({
        supabaseUrl,
        hasServiceRoleKey: serviceRoleKey !== null,
        hasSchedulerSecret: schedulerSecret !== null,
        sheetsConfigured: sheetsConfigured(),
      });

      if (!plan.ok) {
        /**
         * NOT SILENT. An unconfigured control that quietly does nothing is
         * the failure this codebase refuses elsewhere, so a refusal says what
         * is missing, by NAME — never a value, a length or a prefix — and is
         * logged at error level because somebody has to act on it.
         *
         * The registration itself is unaffected and already committed; what
         * is lost is only the nudge, and the row still drains on the next
         * periodic run.
         */
        console.error(
          JSON.stringify({
            fn: 'sync-kick',
            correlationId: args.correlationId,
            event: 'sync_kick_not_configured',
            refusals: plan.refusals,
            missing: missingKeysFor(plan.refusals),
            detail:
              'The sample is committed and queued. No nudge was sent, so the row waits for the periodic sync run.',
          }),
        );
        return;
      }

      const response = await fetch(plan.url, {
        method: 'POST',
        headers: {
          // BOTH credentials. The gateway's default `verify_jwt` sits above
          // the worker's own authorisation, so the bearer token gets the
          // request to the handler and the scheduler secret satisfies it.
          Authorization: `Bearer ${serviceRoleKey ?? ''}`,
          'x-sync-scheduler-secret': schedulerSecret ?? '',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      // Read and drop. NOT `body.cancel()` — cancelling signals the peer, and
      // the peer is holding the workbook lease.
      await response.text().catch(() => '');

      const outcome = classifyKickStatus(response.status);
      if (outcome === 'rejected') {
        console.error(
          JSON.stringify({
            fn: 'sync-kick',
            correlationId: args.correlationId,
            event: 'sync_kick_rejected',
            status: response.status,
            outboxEventId: args.outboxEventId,
            detail: 'The registration is committed and queued. The worker refused the nudge.',
          }),
        );
        return;
      }

      log({
        event: outcome === 'busy' ? 'sync_kick_busy' : 'sync_kick_sent',
        status: response.status,
        outboxEventId: args.outboxEventId,
      });
    } catch (cause) {
      // Network failure, DNS, a runtime tearing the isolate down mid-flight.
      // None of it is the operator's problem: their sample is recorded.
      try {
        console.error(
          JSON.stringify({
            fn: 'sync-kick',
            correlationId: args.correlationId,
            event: 'sync_kick_failed',
            detail: cause instanceof Error ? cause.message : 'unknown error',
          }),
        );
      } catch {
        // Deliberately empty: nothing here may surface on a committed path.
      }
    }
  })();
}
