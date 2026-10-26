/**
 * Every client call into a `runMutation`-backed Edge Function carries an
 * idempotency key the SERVER will accept.
 *
 * ===========================================================================
 * WHY THIS IS NOT A GREP
 * ===========================================================================
 * The obvious check is to search `src/` for `Idempotency-Key`. That assertion
 * is a tautology: deleting the header makes a search for the header fail, so
 * it passes a mutation probe with full marks while measuring nothing about
 * whether the server would accept the request. What decides the outcome is
 * one expression at the top of `runMutation`:
 *
 *     const key = ctx.idempotencyKey ?? body['idempotencyKey'] ?? body['idempotency_key'];
 *     if (!isValidIdempotencyKey(key)) throw new ApiError('bad_request', ...)
 *
 * — evaluated BEFORE `authenticate()`, before the permission check and before
 * the handler. So this suite drives each real hook, captures the real
 * `functions.invoke` arguments, and replays that exact expression against them
 * using the server's own `isValidIdempotencyKey`. The function is imported from
 * `supabase/functions/_shared/` rather than restated here, because a probe that
 * re-expresses the rule in a second copy validates the author's model of the
 * rule and not the rule.
 *
 * ===========================================================================
 * WHAT THE MISSING KEY ACTUALLY DID
 * ===========================================================================
 * Not "a replay could create a duplicate". The key check is the FIRST thing
 * `runMutation` does, so a keyless request was refused with HTTP 400
 * `bad_request` before the caller was even authenticated — the feature never
 * worked at all. `useAdminAction` carries a comment recording the identical
 * discovery for the seven administrative actions. This suite exists so the
 * eighth, ninth and tenth cannot be found the same way.
 *
 * ===========================================================================
 * THE DENOMINATOR
 * ===========================================================================
 * A suite that exercises the call sites it happens to know about certifies its
 * own sample. `the sweep` below therefore derives the population mechanically
 * from the source tree — every `functions.invoke` in `src/`, including the ones
 * in the files this change edited — and fails if any is neither exercised here
 * nor carried by a declared exemption with a reason. Each exemption is paired
 * with an assertion that it matches something, so an exemption that silently
 * grew to swallow the rule announces itself.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';

import { isValidIdempotencyKey } from '../supabase/functions/_shared/idempotency.ts';

vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

const invoke = vi.fn();

vi.mock('@/lib/supabase', () => {
  function builder() {
    const settle = () => Promise.resolve({ data: [], error: null, count: 0 });
    const chain = {
      select: () => chain,
      order: () => chain,
      in: () => chain,
      eq: () => chain,
      ilike: () => chain,
      gte: () => chain,
      lt: () => chain,
      limit: () => chain,
      range: () => chain,
      maybeSingle: () => settle(),
      single: () => settle(),
      then: (...args: Parameters<Promise<unknown>['then']>) => settle().then(...args),
    };
    return chain;
  }
  return { supabase: { from: () => builder(), functions: { invoke } } };
});

const { useAdminAction, useSyncRetry } = await import('@/hooks/useAdmin');
const { useSampleAction } = await import('@/hooks/useSampleDetail');
const { useSpecificationAction } = await import('@/hooks/useSpecifications');
const { useRegisterSample } = await import('@/hooks/useRegisterSample');

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, message: 'Done.' }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `runMutation`'s own key resolution, in the order it reads them, applied to
 * the arguments `functions.invoke` was actually given.
 */
function serverWouldAcceptTheKey(call: readonly unknown[]): boolean {
  const options = (call[1] ?? {}) as {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  const body = options.body ?? {};
  const header = options.headers?.['Idempotency-Key'];
  const key = header ?? body['idempotencyKey'] ?? body['idempotency_key'];
  return isValidIdempotencyKey(key);
}

/** The function name `invoke` was called with, for the coverage ledger below. */
function invokedFunction(call: readonly unknown[]): string {
  return String(call[0]);
}

const exercised = new Set<string>();

async function driveOnce(
  run: () => void,
  expectedFunction: string,
): Promise<readonly unknown[]> {
  run();
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const call = invoke.mock.calls[0] as readonly unknown[];
  expect(invokedFunction(call)).toBe(expectedFunction);
  exercised.add(expectedFunction);
  return call;
}

describe('the server would accept the key every mutating hook sends', () => {
  it('sample-action — a sample decision', async () => {
    const { result } = renderHook(() => useSampleAction(), { wrapper });
    const call = await driveOnce(
      () =>
        result.current.mutate({
          action: 'raise_hold',
          sampleUuid: 'sample-1',
          expectedRevision: 3,
          reason: 'Moisture out of specification.',
        }),
      'sample-action',
    );

    expect(serverWouldAcceptTheKey(call)).toBe(true);
  });

  it('specification-action — proposing a limit', async () => {
    const { result } = renderHook(() => useSpecificationAction(), { wrapper });
    const call = await driveOnce(
      () =>
        result.current.mutate({
          action: 'propose',
          reason: 'New supplier.',
        }),
      'specification-action',
    );

    expect(serverWouldAcceptTheKey(call)).toBe(true);
  });

  it('sync-action — retrying one dead-lettered job', async () => {
    const { result } = renderHook(() => useSyncRetry(), { wrapper });
    const call = await driveOnce(
      () => result.current.mutate({ jobId: 'job-1' }),
      'sync-action',
    );

    expect(serverWouldAcceptTheKey(call)).toBe(true);
  });

  it('admin-action — the call site that was fixed first, as the positive control', async () => {
    // Not redundant with the three above. This one was already correct, so if
    // `serverWouldAcceptTheKey` or `isValidIdempotencyKey` were broken in a way
    // that answered `true` for everything, nothing else in this file would
    // notice. The negative control is below.
    const { result } = renderHook(() => useAdminAction(), { wrapper });
    const call = await driveOnce(
      () =>
        result.current.mutate({
          action: 'approve_access',
          userId: 'user-1',
          reason: 'Authorised by the plant manager.',
        }),
      'admin-action',
    );

    expect(serverWouldAcceptTheKey(call)).toBe(true);
  });

  it('register-sample — the one site that always had a caller-supplied key', async () => {
    // Covered here rather than declared covered elsewhere. Before this suite no
    // test asserted the header on this call site at all; the sweep below counts
    // it as accounted for, so it has to actually be driven.
    const { result } = renderHook(() => useRegisterSample(), { wrapper });
    invoke.mockResolvedValue({
      data: { sampleId: 'BFF-1', sampleUuid: 'uuid-1', revision: 1, sheetSync: null },
      error: null,
    });
    const call = await driveOnce(
      () =>
        result.current.register({
          stage: 'raw_material',
          values: {},
          idempotencyKey: 'caller-supplied-key-0000000002',
        } as never),
      'register-sample',
    );

    expect(serverWouldAcceptTheKey(call)).toBe(true);
  });

  it('refuses the shapes the server refuses, so a pass above means something', () => {
    // The negative half. Without it, every assertion in this file is
    // satisfied by a predicate that returns `true` unconditionally.
    expect(serverWouldAcceptTheKey(['sample-action', { body: { action: 'raise_hold' } }])).toBe(
      false,
    );
    expect(serverWouldAcceptTheKey(['sample-action', {}])).toBe(false);
    expect(serverWouldAcceptTheKey(['sample-action', { body: {}, headers: {} }])).toBe(false);
    // Present but too short for the server's pattern: "a header is set" is not
    // the same claim as "the server accepts it".
    expect(
      serverWouldAcceptTheKey(['sample-action', { headers: { 'Idempotency-Key': 'short' } }]),
    ).toBe(false);
  });

  it('sends the same key in the header and in the documented body fallback', async () => {
    // Both carriers, because a proxy that strips custom headers is the reason
    // the body fallback exists, and two DIFFERENT keys would make the fallback
    // a second act rather than the same one.
    for (const [hook, args, fn] of [
      [
        useSampleAction,
        {
          action: 'raise_hold',
          sampleUuid: 'sample-1',
          expectedRevision: 1,
          reason: 'Moisture out of specification.',
        },
        'sample-action',
      ],
      [useSpecificationAction, { action: 'propose', reason: 'New supplier.' }, 'specification-action'],
      [useSyncRetry, { jobId: 'job-1' }, 'sync-action'],
    ] as readonly [() => { mutate: (a: never) => void }, unknown, string][]) {
      invoke.mockClear();
      const { result } = renderHook(() => hook(), { wrapper });
      const call = await driveOnce(() => result.current.mutate(args as never), fn);
      const options = call[1] as {
        body: Record<string, unknown>;
        headers: Record<string, string>;
      };
      expect(options.headers['Idempotency-Key']).toBeTypeOf('string');
      expect(options.body['idempotencyKey']).toBe(options.headers['Idempotency-Key']);
    }
  });

  it('lets a caller supply its own key, so a retry replays instead of repeating', async () => {
    // The capability `useAdminAction` already documents, extended to the three
    // sites fixed here: a caller that cannot regenerate its act — one carrying
    // a credential, or one the operator has already been told succeeded —
    // passes its own key and the server replays the first outcome.
    const mine = 'caller-supplied-key-0000000001';
    expect(isValidIdempotencyKey(mine)).toBe(true);

    const { result } = renderHook(() => useSampleAction(), { wrapper });
    const call = await driveOnce(
      () =>
        result.current.mutate({
          action: 'raise_hold',
          sampleUuid: 'sample-1',
          expectedRevision: 1,
          reason: 'Moisture out of specification.',
          idempotencyKey: mine,
        }),
      'sample-action',
    );
    const options = call[1] as { body: Record<string, unknown>; headers: Record<string, string> };
    expect(options.headers['Idempotency-Key']).toBe(mine);
    expect(options.body['idempotencyKey']).toBe(mine);
    // And the key is not smuggled in twice under two spellings.
    expect('idempotency_key' in options.body).toBe(false);
  });

  it('generates a different key per call when the caller supplies none', async () => {
    // Deliberate, and the opposite of deriving the key from the subject. A key
    // derived from `jobId` or `sampleUuid` would be permanent, so a LEGITIMATE
    // second attempt on the same subject — the first retry having failed again
    // — would replay the stale outcome and report a success that did not
    // happen. A fresh key per call makes each press its own act; the UI's own
    // in-flight guard is what stops a double press.
    const { result } = renderHook(() => useSyncRetry(), { wrapper });
    result.current.mutate({ jobId: 'job-1' });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    result.current.mutate({ jobId: 'job-1' });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    const keyOf = (i: number) =>
      (invoke.mock.calls[i]![1] as { headers: Record<string, string> }).headers[
        'Idempotency-Key'
      ];
    expect(keyOf(0)).not.toBe(keyOf(1));
    expect(isValidIdempotencyKey(keyOf(0))).toBe(true);
    expect(isValidIdempotencyKey(keyOf(1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The sweep: is the population above the whole population?
// ---------------------------------------------------------------------------

/**
 * Call sites that legitimately send no key, each with the reason, read from the
 * server entrypoint rather than asserted.
 *
 * `schema-verify` and `change-own-password` do not route through `runMutation`
 * at all, so there is no key check to satisfy. `change-own-password` says so in
 * its own header comment, and must never be "hardened" into that pipeline:
 * `runMutation` requires a permission, and the caller holds none at the moment
 * it runs — that is the whole point of the screen.
 */
const KEYLESS_BY_DESIGN: readonly { readonly file: string; readonly fn: string }[] = [
  { file: 'src/hooks/useAdmin.ts', fn: 'schemaVerify' },
  { file: 'src/lib/supabase.ts', fn: 'CHANGE_OWN_PASSWORD_FUNCTION' },
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe('the sweep over every Edge call site in src/', () => {
  const callSites = sourceFiles('src').flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ file, line: index + 1, text: line }))
      .filter(({ text }) => /functions\s*\.\s*invoke\s*\(/.test(text)),
  );

  it('finds call sites at all, so an empty sweep is not read as a clean one', () => {
    // The guard that separates "no call site has this defect" from "the sweep
    // did not run". A regex that stopped matching would otherwise report a
    // clean tree.
    expect(callSites.length).toBeGreaterThanOrEqual(5);
  });

  it('accounts for every one of them — exercised above, or keyless by design', () => {
    /**
     * The source token each exercised Edge Function is named by at its call
     * site. Keyed on the function name this suite actually drove, so a hook
     * that stops being exercised here stops being accounted for.
     */
    const TOKEN_FOR: Record<string, string> = {
      'sample-action': 'FUNCTIONS.sampleAction',
      'specification-action': 'FUNCTIONS.specificationAction',
      'sync-action': 'FUNCTIONS.syncAction',
      'admin-action': 'FUNCTIONS.adminAction',
      'register-sample': 'REGISTER_SAMPLE_FUNCTION',
    };

    const unaccounted = callSites.filter(({ file, text }) => {
      const normalised = file.replace(/\\/g, '/');
      if (
        KEYLESS_BY_DESIGN.some((row) => row.file === normalised && text.includes(row.fn))
      ) {
        return false;
      }
      return ![...exercised].some((fn) => {
        const token = TOKEN_FOR[fn];
        return token !== undefined && text.includes(token);
      });
    });

    expect(
      unaccounted.map(({ file, line, text }) => `${file}:${line} ${text.trim()}`),
    ).toEqual([]);
  });

  it('every declared exemption still matches a real call site', () => {
    // An exemption whose population is empty is a stale loophole, and it reads
    // exactly like a sound one. If a call site is deleted or moved into the
    // `runMutation` pipeline, this fails rather than quietly widening.
    for (const row of KEYLESS_BY_DESIGN) {
      const hits = callSites.filter(
        ({ file, text }) => file.replace(/\\/g, '/') === row.file && text.includes(row.fn),
      );
      expect(hits, `exemption ${row.file} ${row.fn} matches nothing`).toHaveLength(1);
    }
  });
});
