/**
 * Sample lifecycle, disposition authority and the release gate.
 *
 * Three concepts are kept strictly separate, as the Concept Note §9 requires:
 *   - CAPTURE STATE    — is the record complete?
 *   - ASSESSMENT       — does a measurement sit inside an approved limit?
 *   - DISPOSITION      — what did an authorised person decide about the material?
 *
 * Collapsing these into a single "Pass" field is explicitly forbidden
 * (PRD §6.2). Nothing in this module can produce an acceptance on its own:
 * every disposition requires a named, authorised actor.
 */

import { can, type AuthorityContext, type Permission } from './roles.ts';
import type { Assessment } from './assessment.ts';

export const CAPTURE_STATES = [
  'draft',
  'registered',
  'awaiting_results',
  'ready_for_review',
  'reviewed',
  'correction_required',
  'voided',
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

export const CAPTURE_STATE_LABELS: Record<CaptureState, string> = {
  draft: 'Draft',
  registered: 'Registered',
  awaiting_results: 'Awaiting results',
  ready_for_review: 'Ready for review',
  reviewed: 'Reviewed',
  correction_required: 'Correction required',
  voided: 'Voided',
};

export const DISPOSITIONS = [
  'undetermined',
  'on_hold',
  'accepted',
  'rejected',
  'rework_required',
  'released_by_authorized_override',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  undetermined: 'Undetermined',
  on_hold: 'On hold',
  accepted: 'Accepted',
  rejected: 'Rejected',
  rework_required: 'Rework required',
  released_by_authorized_override: 'Released by authorised override',
};

interface TransitionRule {
  readonly from: CaptureState;
  readonly to: CaptureState;
  readonly permission: Permission;
  /** Whether a written reason is mandatory for the audit event. */
  readonly requiresReason: boolean;
}

/**
 * The complete allowed transition set. Anything absent is denied — the
 * function is a whitelist, so a new state cannot accidentally become
 * reachable by every actor.
 */
const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'draft', to: 'registered', permission: 'sample.register', requiresReason: false },
  { from: 'draft', to: 'voided', permission: 'sample.void', requiresReason: true },

  // Registration moves straight on to awaiting results; a registered sample
  // always has outstanding tests unless the QO filled them in the same visit.
  { from: 'registered', to: 'awaiting_results', permission: 'sample.register', requiresReason: false },
  { from: 'registered', to: 'ready_for_review', permission: 'sample.enter_results', requiresReason: false },

  { from: 'awaiting_results', to: 'ready_for_review', permission: 'sample.enter_results', requiresReason: false },
  { from: 'awaiting_results', to: 'correction_required', permission: 'sample.review', requiresReason: true },
  { from: 'awaiting_results', to: 'voided', permission: 'sample.void', requiresReason: true },

  { from: 'ready_for_review', to: 'reviewed', permission: 'sample.review', requiresReason: false },
  { from: 'ready_for_review', to: 'correction_required', permission: 'sample.review', requiresReason: true },
  { from: 'ready_for_review', to: 'awaiting_results', permission: 'sample.enter_results', requiresReason: true },
  { from: 'ready_for_review', to: 'voided', permission: 'sample.void', requiresReason: true },

  // A reviewed sample is corrected through a NEW reasoned event, never by
  // silently reopening it (PRD §11, FR-013).
  { from: 'reviewed', to: 'correction_required', permission: 'sample.correct', requiresReason: true },
  { from: 'reviewed', to: 'voided', permission: 'sample.void', requiresReason: true },

  { from: 'correction_required', to: 'awaiting_results', permission: 'sample.enter_results', requiresReason: true },
  { from: 'correction_required', to: 'ready_for_review', permission: 'sample.enter_results', requiresReason: true },
  { from: 'correction_required', to: 'voided', permission: 'sample.void', requiresReason: true },
];

export type TransitionDenial =
  | 'not_allowed'
  | 'not_authorised'
  | 'reason_required'
  | 'terminal_state';

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly denial?: TransitionDenial;
  readonly message?: string;
}

export function allowedTransitionsFrom(state: CaptureState): readonly CaptureState[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.to);
}

export function checkTransition(args: {
  readonly from: CaptureState;
  readonly to: CaptureState;
  readonly actor: AuthorityContext;
  readonly reason?: string | null;
}): TransitionCheck {
  if (args.from === 'voided') {
    return {
      allowed: false,
      denial: 'terminal_state',
      message: 'A voided sample cannot change state. Register a new sample instead.',
    };
  }

  const rule = TRANSITIONS.find((t) => t.from === args.from && t.to === args.to);
  if (!rule) {
    return {
      allowed: false,
      denial: 'not_allowed',
      message: `${CAPTURE_STATE_LABELS[args.from]} cannot move directly to ${CAPTURE_STATE_LABELS[args.to]}.`,
    };
  }

  if (!can(args.actor, rule.permission)) {
    return {
      allowed: false,
      denial: 'not_authorised',
      message: `You are not authorised to move a sample to ${CAPTURE_STATE_LABELS[args.to]}.`,
    };
  }

  if (rule.requiresReason && !args.reason?.trim()) {
    return {
      allowed: false,
      denial: 'reason_required',
      message: 'A reason is required and will be recorded in the sample history.',
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

export type ReleaseBlocker =
  | { kind: 'active_hold'; detail: string }
  | { kind: 'outside_approved_limit'; fieldKey: string; detail: string }
  | { kind: 'missing_required_result'; fieldKey: string; detail: string }
  | { kind: 'not_assessable'; fieldKey: string; detail: string }
  | { kind: 'sheet_sync_unconfirmed'; detail: string };

export interface ReleaseEvaluation {
  /** True only when nothing stands in the way of a plain acceptance. */
  readonly cleanAcceptAvailable: boolean;
  readonly blockers: readonly ReleaseBlocker[];
}

export interface ReleaseInput {
  readonly holdActive: boolean;
  readonly holdDetail?: string;
  readonly assessments: readonly {
    fieldKey: string;
    label: string;
    required: boolean;
    assessment: Assessment;
  }[];
  /**
   * Whether the operational row is confirmed in Google Sheets. Only a blocker
   * when the organisation has chosen to gate release on it (Master Prompt §7).
   */
  readonly requireSheetConfirmation: boolean;
  readonly sheetConfirmed: boolean;
}

/**
 * Enumerate everything standing between this sample and a clean acceptance.
 *
 * On the seeded production dataset every assessable measurement is
 * `not_assessable`, because 0 of 34 workbook limits are approved. So
 * `cleanAcceptAvailable` is false for essentially every sample until Quality
 * approves rules. That is deliberate: it forces an authorised human decision
 * instead of manufacturing a pass (R-01).
 */
export function evaluateRelease(input: ReleaseInput): ReleaseEvaluation {
  const blockers: ReleaseBlocker[] = [];

  // A hold outranks every permissive signal (Master Prompt §5).
  if (input.holdActive) {
    blockers.push({
      kind: 'active_hold',
      detail: input.holdDetail ?? 'The sample is on quality hold.',
    });
  }

  for (const a of input.assessments) {
    switch (a.assessment.result) {
      case 'outside_limit':
        blockers.push({
          kind: 'outside_approved_limit',
          fieldKey: a.fieldKey,
          detail: `${a.label}: ${a.assessment.explanation}`,
        });
        break;
      case 'not_tested':
        if (a.required) {
          blockers.push({
            kind: 'missing_required_result',
            fieldKey: a.fieldKey,
            detail: `${a.label} has no recorded result.`,
          });
        }
        break;
      case 'not_assessable':
        blockers.push({
          kind: 'not_assessable',
          fieldKey: a.fieldKey,
          detail: `${a.label}: ${a.assessment.explanation}`,
        });
        break;
      case 'within_limit':
      case 'not_applicable':
        break;
    }
  }

  if (input.requireSheetConfirmation && !input.sheetConfirmed) {
    blockers.push({
      kind: 'sheet_sync_unconfirmed',
      detail: 'The operational row is not yet confirmed in Google Sheets.',
    });
  }

  return { cleanAcceptAvailable: blockers.length === 0, blockers };
}

export type DispositionDenial =
  | 'not_authorised'
  | 'reason_required'
  | 'override_required'
  | 'override_not_authorised'
  | 'hold_must_be_cleared_first';

export interface DispositionCheck {
  readonly allowed: boolean;
  readonly denial?: DispositionDenial;
  readonly message?: string;
  /** True when the decision will be recorded as an authorised override. */
  readonly recordsOverride: boolean;
}

const DISPOSITION_PERMISSION: Record<Disposition, Permission | null> = {
  undetermined: null,
  on_hold: 'hold.raise',
  accepted: 'disposition.accept',
  rejected: 'disposition.reject',
  rework_required: 'disposition.rework',
  released_by_authorized_override: 'disposition.override_release',
};

/**
 * Authorise a disposition decision.
 *
 * The important asymmetry: REJECTING or holding material is always available
 * to someone with the base permission, because the safe direction needs no
 * override. ACCEPTING material over an outstanding blocker requires the
 * delegation-only `disposition.override_release` permission and a reason.
 */
export function checkDisposition(args: {
  readonly decision: Disposition;
  readonly actor: AuthorityContext;
  readonly evaluation: ReleaseEvaluation;
  readonly reason?: string | null;
}): DispositionCheck {
  const permission = DISPOSITION_PERMISSION[args.decision];

  if (permission !== null && !can(args.actor, permission)) {
    return {
      allowed: false,
      denial: 'not_authorised',
      recordsOverride: false,
      message: `You are not authorised to record "${DISPOSITION_LABELS[args.decision]}".`,
    };
  }

  // Rejecting, reworking or holding never needs an override; it only needs a
  // reason so the decision is traceable.
  if (args.decision === 'rejected' || args.decision === 'rework_required' || args.decision === 'on_hold') {
    if (!args.reason?.trim()) {
      return {
        allowed: false,
        denial: 'reason_required',
        recordsOverride: false,
        message: 'A reason is required and will be recorded in the sample history.',
      };
    }
    return { allowed: true, recordsOverride: false };
  }

  if (args.decision === 'accepted') {
    const hold = args.evaluation.blockers.find((b) => b.kind === 'active_hold');
    if (hold) {
      // An acceptance must not be a back door around hold-clearing authority.
      return {
        allowed: false,
        denial: 'hold_must_be_cleared_first',
        recordsOverride: false,
        message:
          'This sample is on hold. The hold must be cleared by an authorised approver before the material can be accepted.',
      };
    }

    if (args.evaluation.blockers.length > 0) {
      if (!can(args.actor, 'disposition.override_release')) {
        return {
          allowed: false,
          denial: 'override_not_authorised',
          recordsOverride: false,
          message:
            'Outstanding quality findings mean this acceptance would be an authorised override, which you are not delegated to record.',
        };
      }
      if (!args.reason?.trim()) {
        return {
          allowed: false,
          denial: 'reason_required',
          recordsOverride: true,
          message: 'An override acceptance requires a recorded justification.',
        };
      }
      // Accepting over blockers is recorded as an override, never as a plain
      // acceptance, so the audit trail cannot be read as a clean pass.
      return { allowed: true, recordsOverride: true };
    }

    if (!args.reason?.trim()) {
      return {
        allowed: false,
        denial: 'reason_required',
        recordsOverride: false,
        message: 'Record who authorised acceptance and on what basis.',
      };
    }
    return { allowed: true, recordsOverride: false };
  }

  if (args.decision === 'released_by_authorized_override') {
    if (!args.reason?.trim()) {
      return {
        allowed: false,
        denial: 'reason_required',
        recordsOverride: true,
        message: 'An authorised override release requires a recorded justification.',
      };
    }
    return { allowed: true, recordsOverride: true };
  }

  // FAIL CLOSED. Every decision that is genuinely recordable is handled above,
  // so reaching here means one of two things, and both must be a refusal:
  //
  //  - `undetermined`, which is the ABSENCE of a decision and so cannot be
  //    "decided". It maps to no permission, which previously let it skip the
  //    authority check entirely and fall through to an allow — an unauthorised
  //    actor could clear a hold-blocked sample back to undetermined with no
  //    permission, no reason and no hold check.
  //  - a Disposition member added later without its own branch. The default for
  //    an unhandled decision must be denial, not permission.
  return {
    allowed: false,
    denial: 'not_authorised',
    recordsOverride: false,
    message: `"${DISPOSITION_LABELS[args.decision]}" is not a decision that can be recorded. A sample starts undetermined; record Accepted, Rejected, Rework required or On hold instead.`,
  };
}

/**
 * Does the sample have every result needed to move to review? Non-applicable
 * fields are excluded, so an AM ground sample is not held back by the
 * BC-only moisture column.
 */
export function readyForReview(
  assessments: readonly { required: boolean; assessment: Assessment }[],
): boolean {
  return assessments.every(
    (a) => !a.required || a.assessment.result !== 'not_tested',
  );
}
