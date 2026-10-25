/**
 * The three pure policies the Edge Function slice gained while fixing the
 * adversarial review's findings 2, 5 and 8.
 *
 *   commitOutcome.ts  "the work did not happen" vs "the work happened and the
 *                      reply could not be built"            (finding 2)
 *   auditDelivery.ts  a swallowed audit-write failure that something can see
 *                                                            (finding 5)
 *   actions.ts        the action vocabularies and permission tables of the
 *                      four routers that did not exist       (finding 8)
 *
 * Only the PURE modules are imported. The adapters and entrypoints call
 * `Deno.serve`, `Deno.env` and `npm:@supabase/supabase-js`, none of which
 * exists under vitest — which is the reason each of these policies was put in
 * a module of its own rather than left inline in the adapter. A policy that
 * cannot be loaded by a test is a policy nobody can show to be right, and
 * finding 2 is precisely what that costs: the classification the pipeline
 * needed was absent, and no test could have noticed.
 */

import { describe, expect, it } from 'vitest';

import {
  decideFailureOutcome,
  incompleteResponse,
  INCOMPLETE_RESPONSE_MESSAGE,
  isIncompleteResponse,
  jsonSafe,
  KEY_HELD_ELSEWHERE_CODES,
  RESPONSE_INCOMPLETE_FIELD,
} from '../supabase/functions/_shared/commitOutcome.ts';
import {
  auditHealth,
  auditProblems,
} from '../supabase/functions/_shared/auditDelivery.ts';
import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_PERMISSION,
  delegationGrantRefusal,
  parseAction,
  SAMPLE_ACTIONS,
  SAMPLE_ACTION_PERMISSION,
  SCHEMA_DRIFT_LATCH_PERMISSION,
  SCHEMA_VERIFY_ACTIONS,
  SCHEMA_VERIFY_ACTION_PERMISSION,
  SPECIFICATION_ACTIONS,
  SPECIFICATION_ACTION_PERMISSION,
  SYNC_ACTIONS,
  SYNC_ACTION_PERMISSION,
  UNDELEGATABLE_PERMISSIONS,
} from '../supabase/functions/_shared/actions.ts';
import { FORBIDDEN_SYNC_PHRASES } from '../supabase/functions/_shared/syncStatus.ts';
import { PERMISSIONS, basePermissions, ROLES, type Permission } from '@/lib/roles';

// ---------------------------------------------------------------------------
// Finding 2 — the post-commit classification
// ---------------------------------------------------------------------------

describe('commitOutcome: a failure after the transaction committed', () => {
  const summary = {
    sampleUuid: 'a1b2',
    sampleId: 'RM-2026-0007',
    revision: 3,
    captureState: 'results_entered',
  };

  it('records the key as SUCCEEDED, not failed, when the reply could not be built', () => {
    const outcome = decideFailureOutcome({
      committed: true,
      committedSummary: summary,
      errorCode: 'internal',
      errorStatus: 500,
    });

    // This is the whole defect. Before the commit point existed, this case
    // was indistinguishable from the one below and the key was marked failed
    // and retryable while the ledger had already committed.
    expect(outcome.kind).toBe('completed_unreported');
    expect(outcome.registry).toBe('succeeded');
    expect(outcome.respond).not.toBeNull();
  });

  it('leaves the key RETRYABLE when the work did not happen', () => {
    const outcome = decideFailureOutcome({
      committed: false,
      committedSummary: null,
      errorCode: 'internal',
      errorStatus: 500,
    });

    expect(outcome.kind).toBe('not_performed');
    expect(outcome.registry).toBe('failed');
    expect(outcome.respond).toBeNull();
  });

  it('distinguishes the two for the SAME error code and status', () => {
    // The error carries no information about whether the commit happened, so
    // if the flag were ignored these two would be identical. Asserted as a
    // pair because that is the discrimination the fix adds.
    const before = decideFailureOutcome({
      committed: false,
      committedSummary: null,
      errorCode: 'internal',
      errorStatus: 500,
    });
    const after = decideFailureOutcome({
      committed: true,
      committedSummary: summary,
      errorCode: 'internal',
      errorStatus: 500,
    });
    expect(before.registry).not.toBe(after.registry);
  });

  it.each(KEY_HELD_ELSEWHERE_CODES)(
    'never rebinds a key held elsewhere (%s), even if the commit flag is set',
    (code) => {
      // Ordering assertion. These codes are raised before the endpoint's work
      // begins so the flag cannot really be set — but if the commit branch
      // were matched first, a conflicting payload could take over a key that
      // another payload owns. Checked with the flag deliberately wrong.
      const outcome = decideFailureOutcome({
        committed: true,
        committedSummary: summary,
        errorCode: code,
        errorStatus: 409,
      });
      expect(outcome.kind).toBe('not_performed');
      expect(outcome.registry).toBe('leave');
    },
  );

  it('treats a commit with no summary as having nothing to report', () => {
    // Fails toward the safe side: with no authoritative outcome to hand back
    // there is nothing to store against the key, so it must not claim success.
    const outcome = decideFailureOutcome({
      committed: true,
      committedSummary: null,
      errorCode: 'internal',
      errorStatus: 500,
    });
    expect(outcome.registry).toBe('failed');
  });

  it('audits a post-commit failure as an error naming the code, not as allowed', () => {
    const outcome = decideFailureOutcome({
      committed: true,
      committedSummary: summary,
      errorCode: 'internal',
      errorStatus: 500,
    });
    expect(outcome.auditOutcome).toBe('error');
    expect(outcome.auditReason).toContain('internal');
  });

  it('keeps a denial audited as denied rather than as an error', () => {
    const outcome = decideFailureOutcome({
      committed: false,
      committedSummary: null,
      errorCode: 'forbidden',
      errorStatus: 403,
    });
    expect(outcome.auditOutcome).toBe('denied');
  });
});

describe('commitOutcome: the incomplete reply', () => {
  it('preserves the identifiers the transaction returned', () => {
    const response = incompleteResponse(
      { sampleUuid: 'a1b2', sampleId: 'RM-2026-0007', revision: 3 },
      'internal',
    );
    expect(response['sampleId']).toBe('RM-2026-0007');
    expect(response['revision']).toBe(3);
  });

  it('marks itself incomplete so a client can tell it from a full reply', () => {
    const response = incompleteResponse({ sampleUuid: 'a1b2' }, 'internal');
    expect(response[RESPONSE_INCOMPLETE_FIELD]).toBe(true);
    expect(isIncompleteResponse(response)).toBe(true);
    expect(isIncompleteResponse({ sampleUuid: 'a1b2' })).toBe(false);
  });

  it('never tells the operator that nothing was saved', () => {
    // `ERROR_MESSAGES.internal` is "Something went wrong. Nothing was saved."
    // — which is FALSE on this path and was what the caller used to receive.
    expect(INCOMPLETE_RESPONSE_MESSAGE.toLowerCase()).not.toContain('nothing was saved');
    expect(INCOMPLETE_RESPONSE_MESSAGE.toLowerCase()).toContain('recorded securely');
  });

  it('claims nothing about Google Sheets', () => {
    // This path is reached precisely when the code that computes the sync
    // label did not run, so the message must not imply a sheet state
    // (build rule 6).
    const lower = INCOMPLETE_RESPONSE_MESSAGE.toLowerCase();
    for (const phrase of FORBIDDEN_SYNC_PHRASES) {
      expect(lower).not.toContain(phrase);
    }
    expect(lower).not.toContain('google sheets');
  });

  it('survives a summary JSON.stringify would reject', () => {
    // The fallback is built on the failure path, so it must not be able to
    // fail the same way. A second throw here would reach serveFunction and
    // answer 500 "Nothing was saved" about committed work.
    const circular: Record<string, unknown> = { sampleId: 'RM-2026-0007' };
    circular['self'] = circular;
    const response = incompleteResponse(
      {
        ...circular,
        when: new Date('2026-10-24T10:00:00Z'),
        big: 10n,
        fn: () => 1,
        nope: Number.NaN,
        nested: { deep: { deeper: { ok: 1 } } },
      },
      'internal',
    );
    expect(() => JSON.stringify(response)).not.toThrow();
    expect(response['sampleId']).toBe('RM-2026-0007');
    expect(response['nope']).toBeNull();
  });

  it('jsonSafe keeps zero and false, which are real values', () => {
    const safe = jsonSafe({ count: 0, held: false, note: '' }) as Record<string, unknown>;
    expect(safe['count']).toBe(0);
    expect(safe['held']).toBe(false);
    expect(safe['note']).toBe('');
  });

  it('jsonSafe bounds depth rather than recursing for ever', () => {
    let deep: Record<string, unknown> = { end: 'yes' };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => JSON.stringify(jsonSafe(deep))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — the audit trail's delivery state
// ---------------------------------------------------------------------------

describe('auditDelivery: a failed audit write is observable', () => {
  it('reports a real zero as clear, with no problem raised', () => {
    const health = auditHealth({
      snapshotRead: true,
      deadLetters: 0,
      oldestDeadLetterAt: null,
    });
    expect(health.state).toBe('clear');
    expect(health.deadLetters).toBe(0);
    expect(auditProblems(health)).toHaveLength(0);
  });

  it('raises a problem when events are held', () => {
    const health = auditHealth({
      snapshotRead: true,
      deadLetters: 3,
      oldestDeadLetterAt: '2026-10-24T09:00:00Z',
    });
    expect(health.state).toBe('needs_attention');
    expect(health.deadLetters).toBe(3);
    const problems = auditProblems(health);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2026-10-24T09:00:00Z');
  });

  it('NEVER reports zero for a count it did not measure', () => {
    // Three different facts would all render as "0" if they were allowed to
    // collapse, and only one of them is good news. This is the assertion that
    // keeps them apart.
    const unread = auditHealth({
      snapshotRead: false,
      deadLetters: undefined,
      oldestDeadLetterAt: undefined,
    });
    expect(unread.state).toBe('unread');
    expect(unread.deadLetters).toBeNull();
    expect(unread.read).toBe(false);

    const absent = auditHealth({
      snapshotRead: true,
      deadLetters: undefined,
      oldestDeadLetterAt: undefined,
    });
    expect(absent.state).toBe('unavailable');
    expect(absent.deadLetters).toBeNull();
    expect(absent.read).toBe(false);
  });

  it('raises a problem when the counter itself is unavailable', () => {
    // A deployment that cannot report the counter cannot notice a lost audit
    // event, so silence here would be the false clean the module exists to
    // prevent.
    for (const snapshotRead of [false, true]) {
      const health = auditHealth({
        snapshotRead,
        deadLetters: undefined,
        oldestDeadLetterAt: undefined,
      });
      expect(auditProblems(health)).toHaveLength(1);
    }
  });

  it('accepts a bigint count rendered as a string by PostgREST', () => {
    const health = auditHealth({
      snapshotRead: true,
      deadLetters: '7',
      oldestDeadLetterAt: null,
    });
    expect(health.state).toBe('needs_attention');
    expect(health.deadLetters).toBe(7);
  });

  it.each([-1, 1.5, Number.NaN, 'many', null, {}, []])(
    'treats an unusable count (%s) as unavailable rather than as a number',
    (value) => {
      const health = auditHealth({
        snapshotRead: true,
        deadLetters: value,
        oldestDeadLetterAt: null,
      });
      expect(health.deadLetters).toBeNull();
      expect(health.state).toBe('unavailable');
    },
  );
});

// ---------------------------------------------------------------------------
// Finding 8 — the routers' vocabularies and permission tables
// ---------------------------------------------------------------------------

describe('actions: every action names a permission', () => {
  const tables: readonly [string, readonly string[], Readonly<Record<string, Permission>>][] = [
    ['sample', SAMPLE_ACTIONS, SAMPLE_ACTION_PERMISSION],
    ['specification', SPECIFICATION_ACTIONS, SPECIFICATION_ACTION_PERMISSION],
    ['admin', ADMIN_ACTIONS, ADMIN_ACTION_PERMISSION],
    ['sync', SYNC_ACTIONS, SYNC_ACTION_PERMISSION],
    ['schemaVerify', SCHEMA_VERIFY_ACTIONS, SCHEMA_VERIFY_ACTION_PERMISSION],
  ];

  it.each(tables)('%s: the table is total over its action list', (_name, actions, table) => {
    // Enumerated by class rather than spot-checked: the member nobody
    // classified is exactly the one a permission table gets wrong.
    expect(Object.keys(table).sort()).toEqual([...actions].sort());
    for (const action of actions) {
      expect(table[action]).toBeDefined();
      expect(PERMISSIONS).toContain(table[action]);
    }
  });

  it.each(tables)('%s: rejects an unknown action', (_name, actions) => {
    for (const bogus of ['', 'nope', 'REVIEW', 'review ', 'approve_everything', 42, null]) {
      expect(parseAction(bogus, actions as readonly string[])).toBeNull();
    }
  });

  it('does not accept one router’s action at another router', () => {
    // A valid-looking action from the wrong vocabulary is the near-miss a
    // substring or prefix check would wave through.
    expect(parseAction('approve', SAMPLE_ACTIONS as readonly string[])).toBeNull();
    expect(parseAction('clear_hold', ADMIN_ACTIONS as readonly string[])).toBeNull();
    expect(parseAction('set_roles', SYNC_ACTIONS as readonly string[])).toBeNull();
  });
});

describe('actions: an administrator gets no quality authority', () => {
  const adminBase = basePermissions('administrator');

  it.each([
    ['sample', SAMPLE_ACTIONS, SAMPLE_ACTION_PERMISSION],
    ['specification', SPECIFICATION_ACTIONS, SPECIFICATION_ACTION_PERMISSION],
  ] as const)(
    '%s: every action except the disposition gate is outside the administrator’s grants',
    (_name, actions, table) => {
      for (const action of actions) {
        const permission = table[action as keyof typeof table] as Permission;
        if (permission === 'sample.view') {
          // `disposition` maps to the weak pipeline gate on purpose: which
          // permission a disposition needs is not knowable until the decision
          // is parsed, and the disposition spec performs that check itself.
          // Covered by tests/authority.test.ts, not restated here.
          continue;
        }
        expect(adminBase, `administrator must not hold ${permission}`).not.toContain(permission);
      }
    },
  );

  it('confirms the premise: the administrator role does hold the operational ones', () => {
    // Negative control for the assertion above. If `basePermissions` returned
    // an empty list the previous test would pass vacuously.
    expect(adminBase).toContain('user.manage');
    expect(adminBase).toContain('sync.retry');
    expect(adminBase.length).toBeGreaterThan(0);
  });

  it('keeps clearing a hold away from the quality officer', () => {
    expect(basePermissions('quality_officer')).toContain(SAMPLE_ACTION_PERMISSION.raise_hold);
    expect(basePermissions('quality_officer')).not.toContain(
      SAMPLE_ACTION_PERMISSION.clear_hold,
    );
    expect(basePermissions('quality_supervisor')).toContain(
      SAMPLE_ACTION_PERMISSION.clear_hold,
    );
  });

  it('keeps approving a limit away from the quality officer', () => {
    expect(basePermissions('quality_officer')).toContain(
      SPECIFICATION_ACTION_PERMISSION.propose,
    );
    expect(basePermissions('quality_officer')).not.toContain(
      SPECIFICATION_ACTION_PERMISSION.approve,
    );
  });

  it('authorises a sync or verification write with a write permission, never a read one', () => {
    for (const action of SYNC_ACTIONS) {
      expect(SYNC_ACTION_PERMISSION[action]).toBe('sync.retry');
    }
    // Reading the headers is a read; latching drift stops every sheet write in
    // the deployment and is therefore separated.
    expect(SCHEMA_VERIFY_ACTION_PERMISSION.verify_headers).toBe('sync.view');
    expect(SCHEMA_DRIFT_LATCH_PERMISSION).toBe('sync.retry');
    expect(SCHEMA_DRIFT_LATCH_PERMISSION).not.toBe(
      SCHEMA_VERIFY_ACTION_PERMISSION.verify_headers,
    );
  });
});

describe('actions: a delegation cannot manufacture authority', () => {
  it('refuses the delegation-only release permission outright', () => {
    // No role holds `disposition.override_release`, and nothing in the matrix
    // says who may create that delegation. An administrator holds
    // `user.manage` and no quality power, so allowing it would let
    // administration mint release authority.
    expect(UNDELEGATABLE_PERMISSIONS).toContain('disposition.override_release');
    expect(
      delegationGrantRefusal({
        permission: 'disposition.override_release',
        grantorHoldsPermission: true,
        grantorId: 'admin-1',
        targetUserId: 'officer-1',
      }),
    ).toBe('permission_not_delegatable_through_api');
  });

  it('refuses a self-delegation', () => {
    expect(
      delegationGrantRefusal({
        permission: 'hold.clear',
        grantorHoldsPermission: true,
        grantorId: 'same-person',
        targetUserId: 'same-person',
      }),
    ).toBe('self_delegation');
  });

  it('refuses a grantor who does not hold the permission', () => {
    expect(
      delegationGrantRefusal({
        permission: 'hold.clear',
        grantorHoldsPermission: false,
        grantorId: 'admin-1',
        targetUserId: 'officer-1',
      }),
    ).toBe('grantor_does_not_hold_permission');
  });

  it('allows a supervisor to delegate what they hold', () => {
    // The permissive branch exists and is reachable — otherwise the three
    // refusals above would be a function that always refuses.
    expect(
      delegationGrantRefusal({
        permission: 'hold.clear',
        grantorHoldsPermission: true,
        grantorId: 'supervisor-1',
        targetUserId: 'officer-1',
      }),
    ).toBeNull();
  });

  it('no role could satisfy the grantor test for an undelegatable permission anyway', () => {
    // Belt and braces, and it documents WHY the outright refusal is needed
    // rather than merely convenient: the grantor rule alone would deadlock,
    // because nobody holds the permission to begin with.
    for (const permission of UNDELEGATABLE_PERMISSIONS) {
      for (const role of ROLES) {
        expect(basePermissions(role)).not.toContain(permission);
      }
    }
  });
});
