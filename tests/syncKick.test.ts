/**
 * The nudge that makes a submitted form reach the spreadsheet by itself.
 *
 * WHY THIS EXISTS. A registered sample lands in `sheet_sync_outbox` as
 * `pending`, and nothing in this codebase drained it — `docs/setup.md`
 * section 7 records the gap as D-18, "Nothing schedules it today". So an
 * operator submitted a form and watched "Google Sheets sync pending"
 * indefinitely.
 *
 * WHAT IS ASSERTED HERE, AND WHAT CANNOT BE. The decisions are in
 * `_shared/syncKick.ts`, which is pure, so every branch is exercised below
 * with no network and no Edge Runtime. The dispatch itself lives in an
 * adapter that needs Deno and a real runtime hook; that half is checked by
 * reading its source for the properties a type check cannot see, and the rest
 * is deployment-only. Each is labelled.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyKickStatus,
  planKick,
  resolveWaitUntil,
  workerUrl,
} from '../supabase/functions/_shared/syncKick.ts';

const REPO = process.cwd();

const CONFIGURED = {
  supabaseUrl: 'https://example.supabase.co',
  hasServiceRoleKey: true,
  hasSchedulerSecret: true,
  sheetsConfigured: true,
} as const;

describe('a kick is only dispatched when it can possibly succeed', () => {
  it('plans one when everything it needs is present', () => {
    const plan = planKick(CONFIGURED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.url).toBe('https://example.supabase.co/functions/v1/sheets-sync-worker');
  });

  it('refuses without the platform URL, because there is nowhere to post', () => {
    const plan = planKick({ ...CONFIGURED, supabaseUrl: null });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toContain('platform_url_unset');
  });

  it('refuses without a service-role key, because the GATEWAY checks first', () => {
    // The worker sits behind the platform gateway's default `verify_jwt` —
    // supabase/config.toml has no [functions.*] block, and the README,
    // architecture and setup docs all record the consequence. A kick carrying
    // only the scheduler secret is refused ABOVE the handler that would have
    // honoured it, so both credentials are required.
    const plan = planKick({ ...CONFIGURED, hasServiceRoleKey: false });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toContain('service_role_key_unset');
  });

  it('refuses without the scheduler secret, with no allow-when-unconfigured branch', () => {
    const plan = planKick({ ...CONFIGURED, hasSchedulerSecret: false });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toContain('scheduler_secret_unset');
  });

  it('refuses when Sheets itself is not configured, rather than burning an invocation', () => {
    // The worker's FIRST act, before authorisation and before the lease, is
    // to refuse with a 500 when SHEETS_SPREADSHEET_ID or
    // GOOGLE_SERVICE_ACCOUNT_JSON is unset. Dispatching into that is a
    // guaranteed-failed request per registration.
    const plan = planKick({ ...CONFIGURED, sheetsConfigured: false });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toContain('sheets_not_configured');
  });

  it('reports EVERY reason at once, not the first', () => {
    // Finding three missing secrets one deployment at a time is the slowest
    // possible way to configure this.
    const plan = planKick({
      supabaseUrl: '   ',
      hasServiceRoleKey: false,
      hasSchedulerSecret: false,
      sheetsConfigured: false,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect([...plan.refusals].sort()).toEqual([
      'platform_url_unset',
      'scheduler_secret_unset',
      'service_role_key_unset',
      'sheets_not_configured',
    ]);
  });

  it('treats whitespace as unset', () => {
    expect(planKick({ ...CONFIGURED, supabaseUrl: '  \t ' }).ok).toBe(false);
  });

  it('does not double the slash when the platform URL has a trailing one', () => {
    const plan = planKick({ ...CONFIGURED, supabaseUrl: 'https://example.supabase.co/' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.url).not.toContain('co//');
    expect(workerUrl('https://x.co///')).toBe('https://x.co/functions/v1/sheets-sync-worker');
  });
});

describe('a busy worker is not an error', () => {
  it('reads 2xx as sent', () => {
    expect(classifyKickStatus(200)).toBe('sent');
    expect(classifyKickStatus(202)).toBe('sent');
  });

  it('reads the lease conflict as busy, which is the guarantee working', () => {
    // Two triggers overlapping is exactly what the single-writer lease exists
    // to handle. Filing the loser as a fault would train whoever reads these
    // logs to ignore them.
    expect(classifyKickStatus(409)).toBe('busy');
    expect(classifyKickStatus(423)).toBe('busy');
  });

  it('reads a refusal as rejected, so somebody acts on it', () => {
    expect(classifyKickStatus(500)).toBe('rejected');
    expect(classifyKickStatus(401)).toBe('rejected');
    expect(classifyKickStatus(403)).toBe('rejected');
  });
});

describe('the runtime hook is detected, never assumed', () => {
  it('returns null when the runtime has no EdgeRuntime at all', () => {
    // This is the case that would otherwise throw a ReferenceError on a path
    // where the sample is already committed — telling an operator the save
    // failed when it did not.
    expect(resolveWaitUntil({})).toBeNull();
  });

  it('returns null when EdgeRuntime exists but offers no waitUntil', () => {
    expect(resolveWaitUntil({ EdgeRuntime: {} })).toBeNull();
    expect(resolveWaitUntil({ EdgeRuntime: { waitUntil: 'not a function' } })).toBeNull();
  });

  it('returns null when EdgeRuntime is not an object', () => {
    expect(resolveWaitUntil({ EdgeRuntime: 'oneshot' })).toBeNull();
    expect(resolveWaitUntil({ EdgeRuntime: null })).toBeNull();
  });

  it('hands the task to the hook, bound to its own runtime', () => {
    const seen: unknown[] = [];
    const runtime = {
      marker: 'me',
      waitUntil(this: { marker: string }, task: Promise<unknown>) {
        seen.push({ task, thisMarker: this.marker });
      },
    };
    const hook = resolveWaitUntil({ EdgeRuntime: runtime });
    expect(hook).not.toBeNull();
    const task = Promise.resolve('x');
    hook?.(task);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { task: unknown }).task).toBe(task);
    // `this` matters: a detached function reference would lose the runtime.
    expect((seen[0] as { thisMarker: string }).thisMarker).toBe('me');
  });
});

describe('properties of the dispatch that no type check can see', () => {
  const adapter = readFileSync(
    join(REPO, 'supabase/functions/_shared/adapters/syncKickAdapter.ts'),
    'utf8',
  );
  const caller = readFileSync(
    join(REPO, 'supabase/functions/register-sample/index.ts'),
    'utf8',
  );

  /** Source with block and line comments removed, so prose cannot satisfy a check. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('the registration never awaits the kick', () => {
    // THE GUARANTEE THAT PROTECTS THE OPERATOR'S WALL CLOCK, and it is one
    // careless keyword from being lost with no type error. Checked against
    // comment-stripped source so the sentence explaining the rule cannot
    // satisfy the rule.
    expect(code(caller)).not.toMatch(/await\s+kickSyncWorker/);
  });

  it('the kick is only dispatched when a post-response hook exists', () => {
    // A fetch torn down mid-flight can leave the worker's 60-second lease
    // leaked, and a leaked lease blocks every other runner. Not kicking is
    // strictly better than kicking unsafely.
    expect(code(caller)).toMatch(/resolveWaitUntil/);
    expect(code(caller)).toMatch(/waitUntil\s*!==\s*null/);
  });

  it('there is no abort signal or timeout on the kick', () => {
    /**
     * THE FATAL ONE, PINNED. A timeout here protects nobody — the operator's
     * response has already been sent — while an abort terminates a request to
     * a worker holding the workbook's single-writer lease, released only in
     * its own `finally`. Cancelling can leak that lease for its full
     * 60-second TTL, during which every other runner gets a 409 and the
     * outbox drains no further: the latency optimisation becomes a sync
     * outage, caused by itself.
     *
     * This test exists because "add a timeout to a fetch" is exactly the
     * tidy-up a later reader would make, and it is wrong here for a reason
     * that is not visible at the call site.
     */
    const body = code(adapter);
    expect(body).not.toMatch(/AbortController/);
    expect(body).not.toMatch(/AbortSignal/);
    expect(body).not.toMatch(/\bsignal\s*:/);
    expect(body).not.toMatch(/setTimeout/);
  });

  it('the response body is read, never cancelled', () => {
    // Cancelling a stream signals the peer, and the peer is the process
    // holding the lease.
    const body = code(adapter);
    expect(body).not.toMatch(/body\?\.\s*cancel/);
    expect(body).toMatch(/response\.text\(\)/);
  });

  it('a refusal is logged at error level, not swallowed', () => {
    // An unconfigured control that quietly does nothing is the failure this
    // codebase refuses everywhere else.
    expect(adapter).toMatch(/sync_kick_not_configured/);
    expect(code(adapter)).toMatch(/console\.error/);
  });

  it('secrets are reported by NAME and never by value', () => {
    const body = code(adapter);
    // The log carries key names from a fixed list; no secret value, length or
    // prefix is ever interpolated.
    expect(body).toMatch(/missingKeysFor/);
    expect(body).not.toMatch(/serviceRoleKey\s*\}/);
    expect(body).not.toMatch(/schedulerSecret\s*\}/);
  });

  it('VACUITY CHECK: the source really was loaded and stripped', () => {
    // Without this, an empty read would make every assertion above pass.
    expect(adapter.length).toBeGreaterThan(2000);
    expect(caller.length).toBeGreaterThan(2000);
    expect(code(adapter)).toMatch(/kickSyncWorker/);
    expect(code(caller)).toMatch(/kickSyncWorker/);
    // And the stripper genuinely removes comments, so the checks above are
    // testing code rather than prose.
    expect(code('/* AbortController */ const x = 1;')).not.toMatch(/AbortController/);
    expect(code('// setTimeout\nconst y = 2;')).not.toMatch(/setTimeout/);
  });
});
