/**
 * Authority, segregation of duties and the release gate.
 * Covers PRD UAT-09, FR-002, FR-010, FR-011, FR-014 and Master Prompt §10.
 *
 * These are the negative tests the Master Prompt demands: "Operator cannot
 * approve spec/clear hold; tech Administrator cannot release quality hold;
 * role escalation denied."
 */
import { describe, it, expect } from 'vitest';
import {
  can,
  permissionsFor,
  checkSeparationOfDuties,
  basePermissions,
  ROLES,
  type AuthorityContext,
  type Role,
} from '@/lib/roles';
import {
  checkTransition,
  checkDisposition,
  evaluateRelease,
  allowedTransitionsFrom,
  readyForReview,
  CAPTURE_STATES,
  DISPOSITIONS,
} from '@/lib/workflow';
import { assess, type Assessment } from '@/lib/assessment';

const actor = (roles: Role[], over: Partial<AuthorityContext> = {}): AuthorityContext => ({
  userId: `user-${roles.join('-')}`,
  roles,
  status: 'active',
  ...over,
});

const operator = actor(['operator']);
const qo = actor(['quality_officer']);
const supervisor = actor(['quality_supervisor']);
const admin = actor(['administrator']);
const auditor = actor(['auditor']);

describe('FR-001: account status gates everything', () => {
  it.each(['pending', 'suspended', 'disabled'] as const)('a %s account holds no permission at all', (status) => {
    const u = actor(['quality_supervisor'], { status });
    expect(permissionsFor(u)).toEqual([]);
    expect(can(u, 'sample.view')).toBe(false);
    expect(can(u, 'spec.approve')).toBe(false);
  });

  it('a new sign-in defaults to pending, so a supervisor role alone grants nothing', () => {
    expect(can(actor(['quality_supervisor'], { status: 'pending' }), 'hold.clear')).toBe(false);
  });

  it('an active account holds its role permissions', () => {
    expect(can(supervisor, 'hold.clear')).toBe(true);
  });
});

describe('UAT-09: operator cannot approve limits or clear holds', () => {
  it('denies spec approval', () => {
    expect(can(operator, 'spec.approve')).toBe(false);
  });
  it('denies hold clearing', () => {
    expect(can(operator, 'hold.clear')).toBe(false);
  });
  it('denies every disposition decision', () => {
    expect(can(operator, 'disposition.accept')).toBe(false);
    expect(can(operator, 'disposition.reject')).toBe(false);
    expect(can(operator, 'disposition.override_release')).toBe(false);
  });
  it('still allows the operator to raise a hold — the safe direction', () => {
    expect(can(operator, 'hold.raise')).toBe(true);
  });
  it('allows registering a sample', () => {
    expect(can(operator, 'sample.register')).toBe(true);
  });
  it('denies entering test results', () => {
    expect(can(operator, 'sample.enter_results')).toBe(false);
  });
});

describe('a technical administrator holds no quality authority', () => {
  // PRD §2: "Cannot approve a specification or material release solely because
  // of technical role." This is the test that stops the most natural and most
  // dangerous shortcut in the whole system.
  it.each([
    'spec.approve',
    'hold.clear',
    'disposition.accept',
    'disposition.reject',
    'disposition.rework',
    'disposition.override_release',
    'sample.enter_results',
    'sample.review',
  ] as const)('denies %s', (p) => {
    expect(can(admin, p)).toBe(false);
  });

  it('still holds the technical permissions it needs', () => {
    expect(can(admin, 'user.manage')).toBe(true);
    expect(can(admin, 'sync.retry')).toBe(true);
    expect(can(admin, 'audit.view')).toBe(true);
  });
});

describe('a quality officer can raise but not clear', () => {
  it('can enter results and review', () => {
    expect(can(qo, 'sample.enter_results')).toBe(true);
    expect(can(qo, 'sample.review')).toBe(true);
  });
  it('can propose but not approve a specification', () => {
    expect(can(qo, 'spec.propose')).toBe(true);
    expect(can(qo, 'spec.approve')).toBe(false);
  });
  it('can raise a hold but not clear one', () => {
    expect(can(qo, 'hold.raise')).toBe(true);
    expect(can(qo, 'hold.clear')).toBe(false);
  });
});

describe('auditor is strictly read-only', () => {
  it('holds only view permissions', () => {
    expect(permissionsFor(auditor).sort()).toEqual(['audit.view', 'report.view', 'sample.view']);
  });
  it.each(['sample.draft', 'sample.register', 'sample.enter_results', 'sample.correct'] as const)(
    'cannot %s',
    (p) => expect(can(auditor, p)).toBe(false),
  );
});

describe('override release is delegation-only', () => {
  it('no role holds it as a base grant', () => {
    for (const role of ROLES) {
      expect(basePermissions(role), role).not.toContain('disposition.override_release');
    }
  });

  it('an active recorded delegation grants it', () => {
    const delegated = actor(['quality_officer'], {
      delegations: [
        {
          permission: 'disposition.override_release',
          grantedBy: 'supervisor-uuid',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: null,
        },
      ],
      now: new Date('2026-10-24T12:00:00Z'),
    });
    expect(can(delegated, 'disposition.override_release')).toBe(true);
  });

  it('an expired delegation does not', () => {
    const expired = actor(['quality_officer'], {
      delegations: [
        {
          permission: 'disposition.override_release',
          grantedBy: 'supervisor-uuid',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-06-01T00:00:00.000Z',
        },
      ],
      now: new Date('2026-10-24T12:00:00Z'),
    });
    expect(can(expired, 'disposition.override_release')).toBe(false);
  });

  it('a future-dated delegation does not', () => {
    const future = actor(['quality_officer'], {
      delegations: [
        {
          permission: 'disposition.override_release',
          grantedBy: 'supervisor-uuid',
          effectiveFrom: '2027-01-01T00:00:00.000Z',
          effectiveTo: null,
        },
      ],
      now: new Date('2026-10-24T12:00:00Z'),
    });
    expect(can(future, 'disposition.override_release')).toBe(false);
  });

  it('a delegation on a suspended account grants nothing', () => {
    const suspended = actor(['quality_officer'], {
      status: 'suspended',
      delegations: [
        {
          permission: 'disposition.override_release',
          grantedBy: 'supervisor-uuid',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: null,
        },
      ],
    });
    expect(can(suspended, 'disposition.override_release')).toBe(false);
  });
});

describe('segregation of duties', () => {
  it('blocks a user approving their own specification proposal', () => {
    expect(
      checkSeparationOfDuties({
        action: 'approve_specification',
        actorId: 'u1',
        subjectActorId: 'u1',
      }),
    ).toBe('self_approval_of_specification');
  });

  it('allows approval of someone else\'s proposal', () => {
    expect(
      checkSeparationOfDuties({
        action: 'approve_specification',
        actorId: 'u1',
        subjectActorId: 'u2',
      }),
    ).toBeNull();
  });

  it('blocks self-review of an exception', () => {
    expect(
      checkSeparationOfDuties({ action: 'review_exception', actorId: 'u1', subjectActorId: 'u1' }),
    ).toBe('self_review_of_own_exception');
  });

  it('accepts a logged override from a different person', () => {
    expect(
      checkSeparationOfDuties({
        action: 'approve_specification',
        actorId: 'u1',
        subjectActorId: 'u1',
        overrideApprovedBy: 'u2',
      }),
    ).toBeNull();
  });

  it('rejects a self-granted override', () => {
    // An override naming the actor is the same self-approval under a new name.
    expect(
      checkSeparationOfDuties({
        action: 'approve_specification',
        actorId: 'u1',
        subjectActorId: 'u1',
        overrideApprovedBy: 'u1',
      }),
    ).toBe('self_approval_of_specification');
  });
});

// ---------------------------------------------------------------------------

const within: Assessment = assess(
  {
    stage: 'conditioned',
    parameterKey: 'conditioned.temperature',
    value: 85,
    unit: '°C',
    unitConfirmed: true,
    applicable: true,
    collectionInstant: '2026-10-24T12:00:00.000Z',
  },
  [
    {
      id: 'r', version: 1, parameterKey: 'conditioned.temperature', stage: 'conditioned',
      material: null, feedType: null, samplingPoint: null, testMethod: null,
      unit: '°C', lowerBound: 84, upperBound: 86, status: 'approved',
      effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, approvedBy: 'sup',
    },
  ],
);

const notAssessable: Assessment = assess(
  {
    stage: 'conditioned', parameterKey: 'conditioned.temperature', value: 85,
    unit: '°C', unitConfirmed: true, applicable: true,
    collectionInstant: '2026-10-24T12:00:00.000Z',
  },
  [],
);

describe('capture state machine', () => {
  it('denies an undeclared transition', () => {
    const r = checkTransition({ from: 'draft', to: 'reviewed', actor: supervisor });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_allowed');
  });

  it('treats voided as terminal', () => {
    for (const to of CAPTURE_STATES) {
      const r = checkTransition({ from: 'voided', to, actor: supervisor, reason: 'x' });
      expect(r.allowed, to).toBe(false);
    }
    expect(allowedTransitionsFrom('voided')).toEqual([]);
  });

  it('lets an operator register a draft', () => {
    expect(checkTransition({ from: 'draft', to: 'registered', actor: operator }).allowed).toBe(true);
  });

  it('stops an operator entering results', () => {
    const r = checkTransition({ from: 'awaiting_results', to: 'ready_for_review', actor: operator });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_authorised');
  });

  it('stops an administrator reviewing a sample', () => {
    const r = checkTransition({ from: 'ready_for_review', to: 'reviewed', actor: admin });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_authorised');
  });

  it('requires a reason to void', () => {
    expect(checkTransition({ from: 'draft', to: 'voided', actor: supervisor }).denial).toBe('reason_required');
    expect(
      checkTransition({ from: 'draft', to: 'voided', actor: supervisor, reason: 'duplicate entry' }).allowed,
    ).toBe(true);
  });

  it('rejects whitespace as a reason', () => {
    expect(checkTransition({ from: 'draft', to: 'voided', actor: supervisor, reason: '   ' }).denial)
      .toBe('reason_required');
  });

  it('requires a reason to correct a reviewed sample', () => {
    expect(checkTransition({ from: 'reviewed', to: 'correction_required', actor: qo }).denial)
      .toBe('reason_required');
  });

  it('never reopens a reviewed sample straight back to awaiting results', () => {
    // A correction must pass through correction_required so a reasoned event
    // exists; jumping back would leave no trace of why.
    expect(checkTransition({ from: 'reviewed', to: 'awaiting_results', actor: supervisor, reason: 'x' }).allowed)
      .toBe(false);
  });
});

describe('readyForReview', () => {
  it('is blocked by a missing required result', () => {
    const notTested = assess(
      { stage: 'mash', parameterKey: 'mash.moisture', value: null, unit: '%', unitConfirmed: true, applicable: true, collectionInstant: '2026-10-24T12:00:00.000Z' },
      [],
    );
    expect(readyForReview([{ required: true, assessment: notTested }])).toBe(false);
  });

  it('is not blocked by a missing optional result', () => {
    const notTested = assess(
      { stage: 'mash', parameterKey: 'mash.moisture', value: null, unit: '%', unitConfirmed: true, applicable: true, collectionInstant: '2026-10-24T12:00:00.000Z' },
      [],
    );
    expect(readyForReview([{ required: false, assessment: notTested }])).toBe(true);
  });

  it('is not blocked by a non-applicable field (UAT-02)', () => {
    const na = assess(
      { stage: 'ground', parameterKey: 'ground.moisture', value: null, unit: '%', unitConfirmed: true, applicable: false, collectionInstant: '2026-10-24T12:00:00.000Z' },
      [],
    );
    expect(readyForReview([{ required: true, assessment: na }])).toBe(true);
  });
});

describe('release gate', () => {
  const base = { requireSheetConfirmation: false, sheetConfirmed: true, holdActive: false };

  it('offers a clean accept when everything is within approved limits', () => {
    const e = evaluateRelease({
      ...base,
      assessments: [{ fieldKey: 'mash_temperature_c', label: 'Mash temperature', required: true, assessment: within }],
    });
    expect(e.cleanAcceptAvailable).toBe(true);
    expect(e.blockers).toEqual([]);
  });

  it('blocks on an active hold', () => {
    const e = evaluateRelease({ ...base, holdActive: true, assessments: [] });
    expect(e.cleanAcceptAvailable).toBe(false);
    expect(e.blockers[0]!.kind).toBe('active_hold');
  });

  it('blocks on a not_assessable result — no approved limit means no pass', () => {
    const e = evaluateRelease({
      ...base,
      assessments: [{ fieldKey: 'mash_temperature_c', label: 'Mash temperature', required: true, assessment: notAssessable }],
    });
    expect(e.cleanAcceptAvailable).toBe(false);
    expect(e.blockers[0]!.kind).toBe('not_assessable');
  });

  it('blocks on a missing required result', () => {
    const notTested = assess(
      { stage: 'mash', parameterKey: 'mash.moisture', value: null, unit: '%', unitConfirmed: true, applicable: true, collectionInstant: '2026-10-24T12:00:00.000Z' },
      [],
    );
    const e = evaluateRelease({
      ...base,
      assessments: [{ fieldKey: 'moisture_pct', label: 'Moisture', required: true, assessment: notTested }],
    });
    expect(e.blockers.some((b) => b.kind === 'missing_required_result')).toBe(true);
  });

  it('blocks when sheet confirmation is required and absent', () => {
    const e = evaluateRelease({ ...base, requireSheetConfirmation: true, sheetConfirmed: false, assessments: [] });
    expect(e.blockers.some((b) => b.kind === 'sheet_sync_unconfirmed')).toBe(true);
  });
});

describe('disposition authority (FR-011)', () => {
  const clean = evaluateRelease({
    holdActive: false, requireSheetConfirmation: false, sheetConfirmed: true,
    assessments: [{ fieldKey: 'f', label: 'Mash temperature', required: true, assessment: within }],
  });
  const blocked = evaluateRelease({
    holdActive: false, requireSheetConfirmation: false, sheetConfirmed: true,
    assessments: [{ fieldKey: 'f', label: 'Mash temperature', required: true, assessment: notAssessable }],
  });
  const held = evaluateRelease({
    holdActive: true, holdDetail: 'Mould seen', requireSheetConfirmation: false, sheetConfirmed: true,
    assessments: [],
  });

  it('lets a supervisor accept a clean sample with a reason', () => {
    const r = checkDisposition({ decision: 'accepted', actor: supervisor, evaluation: clean, reason: 'All results within approved limits.' });
    expect(r.allowed).toBe(true);
    expect(r.recordsOverride).toBe(false);
  });

  it('requires a reason even on a clean acceptance', () => {
    expect(checkDisposition({ decision: 'accepted', actor: supervisor, evaluation: clean }).denial)
      .toBe('reason_required');
  });

  it('denies an operator accepting anything', () => {
    const r = checkDisposition({ decision: 'accepted', actor: operator, evaluation: clean, reason: 'looks fine' });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_authorised');
  });

  it('denies an administrator accepting anything (UAT-09)', () => {
    const r = checkDisposition({ decision: 'accepted', actor: admin, evaluation: clean, reason: 'ok' });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_authorised');
  });

  it('refuses acceptance of a held sample even from a supervisor', () => {
    // The hold must be cleared through its own audited action; acceptance is
    // not a back door around hold-clearing authority.
    const r = checkDisposition({ decision: 'accepted', actor: supervisor, evaluation: held, reason: 'urgent' });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('hold_must_be_cleared_first');
  });

  it('refuses acceptance over unresolved findings without override delegation', () => {
    const r = checkDisposition({ decision: 'accepted', actor: supervisor, evaluation: blocked, reason: 'proceeding' });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('override_not_authorised');
  });

  it('records an acceptance over findings as an OVERRIDE, not a clean pass', () => {
    const delegated = actor(['quality_supervisor'], {
      delegations: [{ permission: 'disposition.override_release', grantedBy: 'other', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null }],
      now: new Date('2026-10-24T12:00:00Z'),
    });
    const r = checkDisposition({ decision: 'accepted', actor: delegated, evaluation: blocked, reason: 'Approved concession ref QA-118.' });
    expect(r.allowed).toBe(true);
    expect(r.recordsOverride).toBe(true);
  });

  it('always allows the safe direction: rejecting with a reason', () => {
    expect(checkDisposition({ decision: 'rejected', actor: supervisor, evaluation: blocked, reason: 'Aflatoxin above tolerance.' }).allowed)
      .toBe(true);
  });

  it('lets a quality officer raise a hold but not clear it by accepting', () => {
    expect(checkDisposition({ decision: 'on_hold', actor: qo, evaluation: blocked, reason: 'Mould seen on intake.' }).allowed)
      .toBe(true);
    expect(checkDisposition({ decision: 'accepted', actor: qo, evaluation: clean, reason: 'ok' }).denial)
      .toBe('not_authorised');
  });

  it('requires a reason to reject or hold', () => {
    expect(checkDisposition({ decision: 'rejected', actor: supervisor, evaluation: blocked }).denial).toBe('reason_required');
    expect(checkDisposition({ decision: 'on_hold', actor: qo, evaluation: blocked }).denial).toBe('reason_required');
  });

  it('refuses "undetermined" as a recordable decision, and fails closed', () => {
    // Regression guard. `undetermined` maps to no permission, which let it skip
    // the authority check and fall through to a trailing allow: an actor with
    // ZERO permissions could push a hold-blocked sample back to undetermined
    // with no reason and no hold check. The absence of a decision is not a
    // decision, and an unhandled Disposition must deny rather than permit.
    const nobody = actor([], { status: 'active' });
    const r = checkDisposition({ decision: 'undetermined', actor: nobody, evaluation: held });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_authorised');
    expect(r.recordsOverride).toBe(false);
  });

  it('refuses "undetermined" even from a supervisor with a reason', () => {
    expect(
      checkDisposition({
        decision: 'undetermined',
        actor: supervisor,
        evaluation: clean,
        reason: 'resetting the decision',
      }).allowed,
    ).toBe(false);
  });

  it('every disposition is either recordable by someone or refused for everyone', () => {
    // Exhaustiveness: no member of DISPOSITIONS may reach a default allow.
    // A new member added without its own branch must land in the refusal.
    for (const decision of DISPOSITIONS) {
      const r = checkDisposition({
        decision,
        actor: actor([], { status: 'active' }),
        evaluation: clean,
        reason: 'x',
      });
      expect(r.allowed, `${decision} must not be allowed for a permissionless actor`).toBe(false);
    }
  });

  it('denies an explicit override release to an undelegated supervisor', () => {
    const r = checkDisposition({ decision: 'released_by_authorized_override', actor: supervisor, evaluation: blocked, reason: 'x' });
    expect(r.allowed).toBe(false);
    expect(r.denial).toBe('not_authorised');
  });
});
