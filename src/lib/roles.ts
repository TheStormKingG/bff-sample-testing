/**
 * Roles, permissions and segregation of duties.
 *
 * This matrix is mirrored by `role_permissions` in migration 0001 and enforced
 * by RLS and Edge Functions. The copy here drives the UI and is unit-tested;
 * it is NOT the security boundary. Master Prompt §1: "Security must reside in
 * Supabase, RLS, Edge Functions and locked-down Google Sheet sharing — not in
 * hidden UI buttons."
 */

export const ROLES = [
  'operator',
  'quality_officer',
  'quality_supervisor',
  'administrator',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  operator: 'Operator / Sampler',
  quality_officer: 'Quality Officer / Tester',
  quality_supervisor: 'Quality Supervisor / Approver',
  administrator: 'Administrator',
  auditor: 'Auditor / Management Viewer',
};

/** Account lifecycle. A new Google sign-in lands on `pending`, not `active`. */
export const USER_STATUSES = ['pending', 'active', 'suspended', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PERMISSIONS = [
  'sample.view',
  'sample.draft',
  'sample.register',
  'sample.enter_results',
  'sample.correct',
  'sample.void',
  'sample.review',
  'disposition.accept',
  'disposition.reject',
  'disposition.rework',
  'hold.raise',
  'hold.clear',
  'disposition.override_release',
  'spec.propose',
  'spec.approve',
  'user.manage',
  'user.approve_access',
  'sync.view',
  'sync.retry',
  'audit.view',
  'report.view',
  'export.run',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Base grants per role.
 *
 * Two deliberate exclusions, both required by PRD §2 and Master Prompt §1:
 *
 *  - `administrator` has NO quality authority. It cannot approve a
 *    specification, clear a hold, or release material. "An Administrator is
 *    not automatically a quality-release approver."
 *  - `quality_officer` can RAISE a hold but cannot CLEAR one, and cannot
 *    approve a specification. Clearing and approval sit with the supervisor
 *    unless an explicitly recorded delegation exists.
 */
const BASE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  operator: ['sample.view', 'sample.draft', 'sample.register', 'hold.raise'],

  quality_officer: [
    'sample.view',
    'sample.draft',
    'sample.register',
    'sample.enter_results',
    'sample.correct',
    'sample.review',
    'hold.raise',
    'spec.propose',
    'report.view',
    'sync.view',
  ],

  quality_supervisor: [
    'sample.view',
    'sample.draft',
    'sample.register',
    'sample.enter_results',
    'sample.correct',
    'sample.void',
    'sample.review',
    'disposition.accept',
    'disposition.reject',
    'disposition.rework',
    'hold.raise',
    'hold.clear',
    'spec.propose',
    'spec.approve',
    'report.view',
    'export.run',
    'audit.view',
    'sync.view',
  ],

  administrator: [
    'sample.view',
    'user.manage',
    'user.approve_access',
    'sync.view',
    'sync.retry',
    'audit.view',
    'report.view',
  ],

  auditor: ['sample.view', 'audit.view', 'report.view'],
};

/**
 * A delegation recorded and approved in the database. This is how a Quality
 * Officer may be granted disposition authority without widening the role for
 * everyone (PRD §2: "Segregation of duties is configurable").
 */
export interface Delegation {
  readonly permission: Permission;
  readonly grantedBy: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface AuthorityContext {
  readonly userId: string;
  readonly roles: readonly Role[];
  readonly status: UserStatus;
  readonly delegations?: readonly Delegation[];
  /** Evaluation instant; delegations are time-bounded. */
  readonly now?: Date;
}

/** `override_release` is never a base grant for any role — only a delegation. */
export const DELEGATION_ONLY_PERMISSIONS: readonly Permission[] = [
  'disposition.override_release',
];

function delegationActive(d: Delegation, now: Date): boolean {
  if (new Date(d.effectiveFrom) > now) return false;
  if (d.effectiveTo !== null && new Date(d.effectiveTo) <= now) return false;
  return true;
}

/**
 * Does this actor hold the permission?
 *
 * A non-active account holds nothing at all, which is what makes the pending
 * gate real rather than cosmetic (FR-001).
 */
export function can(ctx: AuthorityContext, permission: Permission): boolean {
  if (ctx.status !== 'active') return false;

  const now = ctx.now ?? new Date();
  const viaDelegation = (ctx.delegations ?? []).some(
    (d) => d.permission === permission && delegationActive(d, now),
  );
  if (viaDelegation) return true;

  if (DELEGATION_ONLY_PERMISSIONS.includes(permission)) return false;

  return ctx.roles.some((r) => BASE_PERMISSIONS[r]?.includes(permission));
}

export function permissionsFor(ctx: AuthorityContext): Permission[] {
  return PERMISSIONS.filter((p) => can(ctx, p));
}

/** Base permissions of a role, for the admin screen and for DB seeding. */
export function basePermissions(role: Role): readonly Permission[] {
  return BASE_PERMISSIONS[role];
}

export type SeparationFailure =
  | 'self_approval_of_specification'
  | 'self_review_of_own_exception'
  | 'self_access_approval';

/**
 * Segregation of duties. PRD §2: "a user must not approve their own limit
 * change, and self-review of an exception is prohibited unless an authorized,
 * logged override exists."
 *
 * Returns null when the action is permitted, or the failure reason.
 */
export function checkSeparationOfDuties(args: {
  readonly action: 'approve_specification' | 'review_exception' | 'approve_access';
  readonly actorId: string;
  readonly subjectActorId: string | null;
  readonly overrideApprovedBy?: string | null;
}): SeparationFailure | null {
  const samePerson =
    args.subjectActorId !== null && args.actorId === args.subjectActorId;
  if (!samePerson) return null;

  // An override must come from a DIFFERENT person, otherwise it is the same
  // self-approval wearing a second name.
  const overrideValid =
    args.overrideApprovedBy != null && args.overrideApprovedBy !== args.actorId;
  if (overrideValid) return null;

  switch (args.action) {
    case 'approve_specification':
      return 'self_approval_of_specification';
    case 'review_exception':
      return 'self_review_of_own_exception';
    case 'approve_access':
      return 'self_access_approval';
  }
}
