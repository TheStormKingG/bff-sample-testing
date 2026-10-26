/**
 * Administration — accounts, delegations, controlled lists, sync health,
 * schema verification and the audit query.
 *
 * ===========================================================================
 * WHAT AN ADMINISTRATOR IS NOT
 * ===========================================================================
 *
 * The Administrator role maintains users, configuration and technical health.
 * It carries NO quality authority: it cannot approve a specification, cannot
 * clear a quality hold and cannot release material. PRD §2 — "Cannot approve a
 * specification or material release solely because of technical role" — and
 * Master Prompt §1 — "An Administrator is not automatically a quality-release
 * approver".
 *
 * That is stated on the screen, and it is also CHECKED on the screen: the
 * banner below reads the permission matrix at render time and lists what the
 * role actually holds. If a future edit ever granted the role a quality
 * permission, this page would report it as a fault rather than quietly
 * offering the control.
 *
 * Every action here goes through the `admin-action` Edge Function with a
 * written reason, which re-checks authority server-side and writes its own
 * audit event. Nothing on this page writes to a table directly, and nothing
 * here is a security control — the controls are RLS and the functions
 * (Master Prompt §1).
 * ===========================================================================
 */

import { useMemo, useRef, useState } from 'react';
import {
  ClipboardCopy,
  Database,
  FileSearch,
  KeyRound,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TableProperties,
  UserCheck,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';

import {
  PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  USER_STATUSES,
  DELEGATION_ONLY_PERMISSIONS,
  basePermissions,
  checkSeparationOfDuties,
  type Permission,
  type Role,
  type UserStatus,
} from '@/lib/roles';
import { formatPlantDateTimeLabelled, plantLocalDate } from '@/lib/time';
import { useAuthority } from '@/hooks/useSamples';
import {
  EMPTY_AUDIT_QUERY,
  TEMPORARY_PASSWORD_LENGTH,
  carriesCredential,
  clearTemporaryPassword,
  generateTemporaryPassword,
  spellTemporaryPassword,
  stashTemporaryPassword,
  useAdminAction,
  useAdminDelegations,
  useAdminUsers,
  useAuditDeadLetters,
  useAuditEvents,
  useControlledValues,
  useSchemaVerification,
  useSyncHealth,
  useSyncRetry,
  type AdminActionInput,
  type AdminUser,
  type AuditQuery,
} from '@/hooks/useAdmin';
import { newIdempotencyKey } from '@/hooks/useRegisterSample';
import { StatusChip, type Tone } from '@/components/ui';
import { ReasonDialog } from '@/components/form/ReasonDialog';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  INPUT_CLASS,
  InfoNote,
  Labelled,
  LoadingBlock,
  NotPermitted,
  PageHeader,
} from '@/components/records/common';
import { AuditTimeline } from '@/components/records/AuditTimeline';
import { Pagination } from '@/components/records/Pagination';
import { SchemaVerificationPanel } from '@/components/records/SchemaVerificationPanel';
import { SyncHealthTable } from '@/components/records/SyncHealthTable';

/**
 * The permissions that decide the fate of material or of a limit. An
 * Administrator must hold none of them as a base grant.
 */
const QUALITY_AUTHORITY_PERMISSIONS: readonly Permission[] = [
  'spec.approve',
  'hold.clear',
  'disposition.accept',
  'disposition.reject',
  'disposition.rework',
  'disposition.override_release',
];

const USER_STATUS_TONE: Record<UserStatus, Tone> = {
  pending: 'warning',
  active: 'success',
  suspended: 'danger',
  disabled: 'neutral',
};

const USER_STATUS_LABELS: Record<UserStatus, string> = {
  pending: 'Awaiting approval — sees no data',
  active: 'Active',
  suspended: 'Suspended',
  disabled: 'Disabled',
};

/**
 * A temporary password an administrator is about to be shown, once.
 *
 * It travels with the pending action rather than being read back from
 * anywhere, because there is nowhere to read it back from: the server stores a
 * hash of the credential, never the credential, and this application keeps no
 * copy once the panel is dismissed.
 */
interface Credential {
  readonly password: string;
  readonly personLabel: string;
  readonly emailLabel: string;
  readonly isNewAccount: boolean;
}

/** A mutation waiting for its written reason. */
interface PendingAction {
  readonly input: Omit<AdminActionInput, 'reason'>;
  readonly title: string;
  readonly prompt: string;
  readonly confirmLabel: string;
  /**
   * Present only for `create_account` and `set_password`. Its presence is what
   * makes `AdminPage` show the one-time panel and scrub the mutation's
   * retained variables afterwards.
   */
  readonly credential?: Credential;
}

/** A credential being shown, plus whether the server confirmed the act. */
interface Revealed extends Credential {
  readonly confirmed: boolean;
}

// ---------------------------------------------------------------------------
// The one-time temporary-password panel
// ---------------------------------------------------------------------------

/**
 * Show a temporary password once, and mean it.
 *
 * "Shown once" is a claim about the whole system, not about this component, so
 * every place a second look could come from is closed:
 *
 *  - It is NOT in the audit trail. The two actions send the password to the
 *    Edge Function, which hands the database only the instant of the reset;
 *    `identity.password_set_by_administrator` records who, when and why.
 *  - It is NOT in the query cache. Nothing reads it back, and the mutation's
 *    retained variables are reset once the action settles.
 *  - It is NOT in localStorage, sessionStorage or any draft. Only
 *    `useSampleDraft` touches storage in this app and it stores stage forms.
 *  - It is NOT in a log. The Edge wrapper logs the function name, correlation
 *    id, status and duration; no path logs a request body.
 *  - It is NOT in this component after Done: the state holding it is cleared,
 *    and the form that produced it is remounted empty.
 *
 * What is left, stated on the screen rather than hidden here: the device
 * clipboard if Copy is used, and whatever the administrator writes down.
 */
function TemporaryPasswordPanel({
  revealed,
  onDismiss,
}: {
  revealed: Revealed;
  onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle');

  function copy() {
    // `navigator.clipboard` is absent in an insecure context, which a plant
    // tablet on a plain-http LAN is. Saying so is the point: a Copy button
    // that silently did nothing would have an administrator paste an old
    // clipboard entry into a message and believe they had sent the password.
    const target = globalThis.navigator?.clipboard;
    if (target === undefined || typeof target.writeText !== 'function') {
      setCopyState('unavailable');
      return;
    }
    target.writeText(revealed.password).then(
      () => setCopyState('copied'),
      () => setCopyState('unavailable'),
    );
  }

  return (
    <section
      // `alert` rather than a quiet region: this is the only moment the
      // password exists on screen, so it must reach a screen-reader user
      // without them going looking for it.
      role="alert"
      aria-label="Temporary password, shown once"
      className="mb-6 rounded-md border-2 border-bff-700 bg-white p-4"
    >
      <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
        <KeyRound aria-hidden className="h-6 w-6" />
        Temporary password for {revealed.personLabel}
      </h2>

      {revealed.confirmed ? (
        <p className="mt-1 text-base text-slate-800">
          {revealed.isNewAccount
            ? 'The account has been created.'
            : 'The password on this account has been replaced.'}{' '}
          Give this password to <strong>{revealed.emailLabel}</strong> and to nobody else.
        </p>
      ) : (
        <p className="mt-1 text-base font-semibold text-red-900">
          The server did not confirm this. It is shown because it was sent, not because it
          works. Check <strong>{revealed.emailLabel}</strong> in the list below before you
          act: if the account is there, use <em>Reset password</em> on it rather than
          creating it again.
        </p>
      )}

      <p
        className="mt-3 select-all break-all rounded-md border border-slate-300 bg-slate-50 px-3 py-3 font-mono text-2xl tracking-wider text-slate-900"
        // The password is the only content of this element, so its accessible
        // name is the password itself; the readout below is what a listener
        // actually needs, and is announced with it.
        aria-label={`Temporary password: ${spellTemporaryPassword(revealed.password)}`}
      >
        {revealed.password}
      </p>

      <p className="mt-2 text-sm text-slate-700">
        <span className="font-medium">To read out: </span>
        {spellTemporaryPassword(revealed.password)}. The dashes are part of the password and
        must be typed.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={copy}>
          <ClipboardCopy aria-hidden className="h-4 w-4" />
          Copy the password
        </Button>
        <Button variant="primary" onClick={onDismiss}>
          I have given it to them — hide it now
        </Button>
      </div>

      {copyState === 'copied' ? (
        <p role="status" className="mt-2 text-sm text-slate-700">
          Copied to this device&rsquo;s clipboard. Clear the clipboard when you are finished —
          this page cannot do that for you.
        </p>
      ) : null}
      {copyState === 'unavailable' ? (
        <p role="status" className="mt-2 text-sm font-medium text-red-900">
          This device will not let the page copy to the clipboard, so <strong>nothing was
          copied</strong>. Read the password out using the words above, or write it down.
        </p>
      ) : null}

      <div className="mt-3">
        <InfoNote tone="warning">
          <span>
            <strong>This is the only time this password is shown.</strong> Nothing in this
            application keeps a copy — not the audit log, not the browser, not the server —
            so once this panel is hidden it cannot be recovered and the only way to give this
            person a password is to reset it again. The holder{' '}
            <strong>must choose their own password the next time they sign in</strong> and can
            do nothing at all until they have, which is what makes their records attributable
            to them rather than to you.
          </span>
        </InfoNote>
      </div>
    </section>
  );
}

type AdminTab = 'access' | 'delegations' | 'lists' | 'sync' | 'schema' | 'audit';

const TABS: readonly { id: AdminTab; label: string; icon: typeof Users }[] = [
  { id: 'access', label: 'Users and access', icon: Users },
  { id: 'delegations', label: 'Delegated authority', icon: ShieldCheck },
  { id: 'lists', label: 'Controlled lists', icon: ListChecks },
  { id: 'sync', label: 'Google Sheets sync health', icon: RefreshCw },
  { id: 'schema', label: 'Workbook schema check', icon: TableProperties },
  { id: 'audit', label: 'Audit query', icon: FileSearch },
];

function instant(value: string | null): string {
  if (value === null) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatPlantDateTimeLabelled(parsed);
}

/**
 * A key that changes when the server's roles for this account change.
 *
 * `UserRow` holds the checkbox selection in local state seeded from props,
 * which React keeps across re-renders for the same key. Without the roles in
 * the key, a refetch that brought DIFFERENT roles would leave the old
 * selection on screen — an administrator would be looking at roles the
 * account no longer has. Sorted, so the key does not change on row order.
 */
function roleKey(user: AdminUser): string {
  return `${user.id}:${[...user.roles].sort().join(',')}`;
}

function describeName(user: AdminUser): string {
  return user.full_name ?? user.email ?? user.id;
}

// ---------------------------------------------------------------------------
// Temporary-password entry, shared by the create form and every account row
// ---------------------------------------------------------------------------

/**
 * A hand-typed temporary password is allowed, and held to the same length as a
 * generated one.
 *
 * The number is `TEMPORARY_PASSWORD_LENGTH` rather than a second constant, so
 * the floor cannot drift away from what the generator produces. The server has
 * its own minimum, which this does not know and does not guess at: a refusal
 * from the server is shown verbatim rather than pre-empted with a rule that
 * might not be the real one.
 */
function passwordProblem(value: string): string | null {
  if (value === '') return 'Type a temporary password, or press Generate one.';
  if (/\s/.test(value)) {
    return 'A temporary password must not contain a space — a space read aloud is invisible.';
  }
  if (value.length < TEMPORARY_PASSWORD_LENGTH) {
    return `A temporary password needs at least ${TEMPORARY_PASSWORD_LENGTH} characters. Press Generate one.`;
  }
  return null;
}

/**
 * `forWhom` is not decoration.
 *
 * This field appears once for the create form and once for EVERY account row,
 * so a page with four accounts has five identically-named password boxes and
 * five identically-named Generate buttons. Sighted use disambiguates them by
 * position; a screen reader reads the name, and five "Temporary password,
 * edit text" in a row is a form nobody can fill correctly. Naming each one
 * after the account it belongs to is the fix, and it has the useful side
 * effect of making each one addressable in a test.
 */
function TemporaryPasswordField({
  id,
  forWhom,
  value,
  onChange,
  onGenerateError,
}: {
  id: string;
  forWhom: string;
  value: string;
  onChange: (next: string) => void;
  onGenerateError: (message: string) => void;
}) {
  function generate() {
    try {
      onChange(generateTemporaryPassword());
    } catch (cause) {
      onChange('');
      onGenerateError(
        cause instanceof Error ? cause.message : 'No temporary password could be generated.',
      );
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Labelled
        id={id}
        label={`Temporary password for ${forWhom}`}
        hint="It is shown to you once, after the account is saved, and the holder must replace it before they can do anything. Avoid inventing one — a generated one has no words in it to mishear."
      >
        {/* `type="text"`, not `type="password"`: the administrator has to READ
            this out or write it down, and a field of dots cannot be read out.
            Autofill and autocorrect are off so a browser does not offer to
            save it as the administrator's own credential, and so a tablet
            keyboard does not capitalise the first character into something
            that is no longer the password that was sent. */}
        <input
          id={id}
          type="text"
          className={`${INPUT_CLASS} font-mono`}
          value={value}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </Labelled>
      <div>
        <Button onClick={generate} ariaLabel={`Generate a temporary password for ${forWhom}`}>
          <KeyRound aria-hidden className="h-4 w-4" />
          Generate one
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users and access
// ---------------------------------------------------------------------------

/**
 * The password controls for one existing account.
 *
 * Deliberately in its own bordered block, with no `danger` variant anywhere in
 * it. Resetting a password is NOT a destructive act — the account, its roles
 * and every record it has ever signed keep standing — and placing it among
 * Deny access and the status dropdown would invite the wrong kind of care: an
 * administrator avoiding a legitimate reset, or treating one as equivalent to
 * disabling someone.
 */
function PasswordRow({
  user,
  onRequest,
}: {
  user: AdminUser;
  onRequest: (action: PendingAction) => void;
}) {
  // Never rendered for the actor's own account — `UserRow` does not mount it.
  // See `SELF_ADMINISTRATION_NOTICE` for why, and for the other three controls
  // the same refusal governs.
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function submit() {
    const problem = passwordProblem(password);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    // Generated here, not in the transport, so that confirming this exact
    // reset twice replays the first outcome instead of setting a second
    // password the administrator was never shown. It can refuse — same
    // generator, same insecure-context cause as the password itself — and a
    // throw out of an event handler would take the screen down, so it is
    // reported where the other refusals are.
    let key: string;
    try {
      key = newIdempotencyKey();
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? `${cause.message} Nothing was sent and the password was not changed.`
          : 'No unique save key could be made, so nothing was sent.',
      );
      return;
    }
    setFormError(null);
    const person = describeName(user);
    // THE CREDENTIAL LEAVES THE REACT TREE HERE, and not through the mutation
    // input. Anything in `input` becomes `mutation.state.variables`, which the
    // MutationCache keeps until a garbage-collection timer removes it — five
    // minutes, and `reset()` does not shorten it. Stashed against the key
    // instead, and taken out by `useAdminAction` as it builds the body.
    stashTemporaryPassword(key, password);
    onRequest({
      input: {
        action: 'set_password',
        userId: user.id,
        idempotencyKey: key,
      },
      title: `Set a temporary password for ${person}`,
      prompt: `State why this password is being reset — who asked, and how you confirmed it was ${person}. Until they choose their own password this account's actions are not attributable to one person, so the reason is recorded permanently.`,
      confirmLabel: 'Set this temporary password',
      credential: {
        password,
        personLabel: person,
        emailLabel: user.email ?? person,
        isNewAccount: false,
      },
    });
    // Cleared the moment it is handed over, so the password lives in exactly
    // one place on screen — the one-time panel — and the claim that panel
    // makes is true.
    setPassword('');
  }

  return (
    <fieldset className="mt-3 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium text-slate-800">Password</legend>

      {user.password_change_outstanding ? (
        <p className="mt-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-base text-amber-900">
          <strong>This account is still using a password an administrator knows.</strong> It
          was set on their behalf {instant(user.password_set_by_admin_at)} and the holder has
          not chosen their own since
          {user.password_changed_at === null
            ? ' — they have never chosen one'
            : ` (last chosen ${instant(user.password_changed_at)})`}
          . Until they do, anything this account records is not attributable to one person, so
          the server allows it nothing: every request is refused until the password is
          changed. Signing in and reaching the change-password screen still work.
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-700">
          {user.password_set_by_admin_at === null
            ? 'No administrator has set a password for this account through this application, so it has only ever signed in with Google.'
            : `The holder chose their own password ${instant(user.password_changed_at)}, after the reset on ${instant(user.password_set_by_admin_at)}. No administrator knows it.`}
        </p>
      )}

      <p className="mt-2 text-sm text-slate-700">
        Use this when someone has forgotten their password. There is no emailed reset link in
        this system — no mail is sent at all — so a reset is you giving them a password face
        to face or on the telephone.{' '}
        <strong>
          They will be required to choose a new one the next time they sign in, before they
          can do anything.
        </strong>{' '}
        Their account, roles and records are untouched.
      </p>

      <div className="mt-3">
        <TemporaryPasswordField
          id={`password-${user.id}`}
          forWhom={describeName(user)}
          value={password}
          onChange={(next) => {
            setPassword(next);
            setFormError(null);
          }}
          onGenerateError={setFormError}
        />
      </div>

      {formError !== null ? (
        <p role="alert" className="mt-2 text-base font-medium text-red-900">
          {formError}
        </p>
      ) : null}

      <div className="mt-3">
        <Button onClick={submit}>
          <KeyRound aria-hidden className="h-4 w-4" />
          Reset password
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * Everything on an account row that the server refuses when the account is the
 * signed-in administrator's own.
 *
 * `public.assert_administers_other(p_actor, p_target_user)` raises
 * `BFF_SELF_ADMINISTRATION` whenever actor and target are the same id. It is
 * unconditional, has no override, and is performed before anything else by
 * five RPCs: `rpc_approve_account`, `rpc_set_user_status`,
 * `rpc_set_user_roles`, `rpc_grant_delegation` and
 * `rpc_record_admin_password_set` (`rpc_revoke_delegation` deliberately does
 * NOT, so withdrawing your own delegation stays possible).
 *
 * `fetchAdminUsers` selects every profile with no filter, so the actor's own
 * row is in this list like anybody else's. Rendering those controls on it
 * offers four acts whose only reachable outcome is a refusal — and for the
 * password reset the refusal arrives AFTER the screen has displayed a
 * generated password and told the administrator to hand it over. The Edge
 * handler arms the forced change through the RPC first and sets the password
 * only afterwards, so the RPC raises and the password is never set on any
 * account: a credential that exists on a sticky note and nowhere else.
 *
 * The controls are therefore not disabled, they are not rendered. A disabled
 * control invites an administrator to hunt for the permission that would
 * enable it; an absent one with a stated reason answers the question instead.
 * Approve/Deny was already handled this way through `checkSeparationOfDuties`,
 * and this follows that precedent rather than inventing a second idiom.
 */
const SELF_ADMINISTRATION_NOTICE =
  'This is your own account, so nothing here can be administered by you — not your ' +
  'roles, not your status and not your password. The server refuses any administrative ' +
  'act aimed at the account making it, so a second person is always in the record. ' +
  'If you have forgotten your own password you cannot reset it yourself and there is ' +
  'no emailed reset link in this system: another administrator has to set you a ' +
  'temporary one, which you then replace.';

function UserRow({
  user,
  actorId,
  canApproveAccess,
  onRequest,
}: {
  user: AdminUser;
  actorId: string;
  canApproveAccess: boolean;
  onRequest: (action: PendingAction) => void;
}) {
  const [roles, setRoles] = useState<readonly Role[]>(user.roles);
  const selfApproval = checkSeparationOfDuties({
    action: 'approve_access',
    actorId,
    subjectActorId: user.id,
  });
  /**
   * Compared on the id and nothing else, because that is what the SQL compares.
   * Not routed through `checkSeparationOfDuties`: that function answers a
   * different question — separation of duties for three named decisions, with
   * an override by a second person — whereas this refusal admits no override
   * and covers acts that are not quality decisions at all. Borrowing it would
   * also mean editing `src/lib/roles.ts`, which the Edge Functions import.
   */
  const isOwnAccount = user.id === actorId;

  const rolesChanged =
    roles.length !== user.roles.length || roles.some((r) => !user.roles.includes(r));

  function toggleRole(role: Role) {
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  }

  return (
    <li className="border-b border-slate-100 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900">{describeName(user)}</p>
          <p className="text-sm text-slate-600">{user.email ?? 'No email recorded'}</p>
          {/* Account creation is the only instant `profiles` records for an
              account. There is no sign-in or last-activity timestamp in the
              schema — see the comment on `fetchAdminUsers` — so none is
              claimed here. */}
          <p className="text-xs text-slate-500">Account created {instant(user.created_at)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusChip
            label={USER_STATUS_LABELS[user.status]}
            tone={USER_STATUS_TONE[user.status]}
            srPrefix="Account status:"
          />
          {/* The fact an auditor asks for, in the words they would use. Not
              "must change password", which describes a screen the holder sees:
              what matters on an administrator's screen is that a second person
              knows this account's credential, so its records are not yet
              attributable to one person. */}
          {user.password_change_outstanding ? (
            <StatusChip
              label="Password an administrator knows"
              tone="warning"
              size="sm"
              srPrefix="Credential:"
            />
          ) : null}
        </div>
      </div>

      {user.status === 'pending' ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          {/* TWO WAYS TO ARRIVE HERE, and they are not interchangeable. The
              wording used to say "has signed in with Google", which became
              false the moment an administrator could create an account with a
              password: such an account is pending before anybody has signed
              in to it at all. `password_set_by_admin_at` is the one column
              that distinguishes them, so it is what this branches on rather
              than a guess from the status. */}
          <p className="text-base font-medium text-amber-900">
            {user.password_set_by_admin_at === null
              ? 'This account has signed in with Google but can see no data at all until it is approved.'
              : 'This account was created here with a temporary password and can see no data at all until it is approved.'}{' '}
            Approving it does not give it any role — grant roles below, deliberately.
          </p>
          {!canApproveAccess ? (
            <div className="mt-2">
              <NotPermitted reason="Approving an account needs the approve-access permission." />
            </div>
          ) : selfApproval !== null ? (
            <div className="mt-2">
              <NotPermitted reason="This is your own account. You cannot approve your own access — a second person has to do it (PRD §2, separation of duties)." />
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() =>
                  onRequest({
                    input: { action: 'approve_access', userId: user.id },
                    title: `Approve access for ${describeName(user)}`,
                    prompt:
                      'State who authorised this account and how the identity was confirmed. The reason is written to the audit log permanently.',
                    confirmLabel: 'Approve this account',
                  })
                }
              >
                <UserCheck aria-hidden className="h-4 w-4" />
                Approve access
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  onRequest({
                    input: { action: 'deny_access', userId: user.id },
                    title: `Deny access for ${describeName(user)}`,
                    prompt:
                      'State why this account is not being approved. The account keeps seeing no data.',
                    confirmLabel: 'Deny this account',
                  })
                }
              >
                Deny access
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {isOwnAccount ? (
        /**
         * THE OWN ROW. No controls, and the roles and status restated as facts
         * rather than dropped — this screen is the only place an administrator
         * can read their own roles, and a row that went blank would read as a
         * failed query rather than as a deliberate refusal.
         */
        <div className="mt-3">
          <InfoNote tone="warning">
            <span>
              <strong>{SELF_ADMINISTRATION_NOTICE}</strong>
            </span>
          </InfoNote>
          <dl className="mt-3 rounded-md border border-slate-200 p-3 text-sm">
            <dt className="font-medium text-slate-800">Your roles</dt>
            <dd className="mt-0.5 text-slate-700">
              {user.roles.length === 0
                ? 'No role. A role grants base permissions only; anything beyond them needs a recorded delegation.'
                : user.roles.map((role) => ROLE_LABELS[role]).join(', ')}
            </dd>
            <dt className="mt-2 font-medium text-slate-800">Your account status</dt>
            <dd className="mt-0.5 text-slate-700">{USER_STATUS_LABELS[user.status]}</dd>
          </dl>
        </div>
      ) : (
        <>
      <fieldset className="mt-3 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium text-slate-800">Roles</legend>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4">
          {ROLES.map((role) => (
            <label
              key={role}
              className="inline-flex min-h-tap items-center gap-2 text-base text-slate-800"
            >
              <input
                type="checkbox"
                className="h-5 w-5 rounded border-slate-400 text-bff-700 focus:ring-bff-600"
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-600">
          A role grants base permissions only. Anything beyond them needs a recorded delegation.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!rolesChanged}
            onClick={() =>
              onRequest({
                input: { action: 'set_roles', userId: user.id, roles },
                title: `Change roles for ${describeName(user)}`,
                prompt: `State why these roles are being set (${
                  roles.length === 0 ? 'no roles' : roles.map((r) => ROLE_LABELS[r]).join(', ')
                }). Roles decide what the server will allow, so the reason is recorded.`,
                confirmLabel: 'Save these roles',
              })
            }
          >
            <UserCog aria-hidden className="h-4 w-4" />
            {rolesChanged ? 'Save role changes' : 'No role changes to save'}
          </Button>
          {rolesChanged ? (
            <Button onClick={() => setRoles(user.roles)}>Undo my changes</Button>
          ) : null}
        </div>
      </fieldset>

      <PasswordRow user={user} onRequest={onRequest} />

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Labelled
          id={`status-${user.id}`}
          label="Account status"
          hint="A suspended or disabled account holds no permission at all, whatever its roles say. This box shows what the server currently holds; a change takes effect only once it is confirmed."
        >
          {/* Controlled on the SERVER's value, not on a local draft. The
              dropdown therefore snaps back until the change is confirmed and
              refetched, so it can never display a status the server refused. */}
          <select
            id={`status-${user.id}`}
            className={INPUT_CLASS}
            value={user.status}
            onChange={(event) => {
              const next = event.target.value as UserStatus;
              if (next === user.status) return;
              onRequest({
                input: { action: 'set_status', userId: user.id, status: next },
                title: `Set ${describeName(user)} to ${USER_STATUS_LABELS[next]}`,
                prompt: 'State why this account status is changing.',
                confirmLabel: 'Change the status',
              });
            }}
          >
            {USER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {USER_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Labelled>
      </div>
        </>
      )}
    </li>
  );
}

/**
 * Make an account for somebody who has no Google account.
 *
 * This is the only way into the system for a plant-floor operator: there is no
 * self-service signup and no "forgot password" link, because the project has
 * no mail sender at all. An administrator types an address and a temporary
 * password, says both to the person, and the person is forced to replace the
 * password before the server will let them do anything.
 *
 * `email` and `displayName` are both required here although only the first is
 * required by the database. `tg_handle_new_auth_user` derives the profile's
 * display name from `full_name` in the user metadata, then `name`, then the
 * EMAIL LOCAL PART — so an account created without a name lands in the user
 * list as "jsmith", and a quality record signed by "jsmith" names nobody.
 */
function CreateAccountCard({ onRequest }: { onRequest: (action: PendingAction) => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function submit() {
    const address = email.trim();
    const person = displayName.trim();
    // Shape only. The real address rules belong to the auth service, and a
    // stricter pattern here would refuse addresses it will accept — so this
    // checks the one thing whose absence is certainly a typing mistake.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setFormError('Type the email address this person will sign in with.');
      return;
    }
    if (person === '') {
      setFormError(
        'Type the person’s full name. It is the name that will appear on every record they sign, and without it the account is listed by the first part of its address.',
      );
      return;
    }
    const problem = passwordProblem(password);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    // See the matching comment in `PasswordRow`: this can refuse, and a throw
    // out of a click handler would take the screen down with it.
    let key: string;
    try {
      key = newIdempotencyKey();
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? `${cause.message} Nothing was sent and no account was created.`
          : 'No unique save key could be made, so nothing was sent.',
      );
      return;
    }
    setFormError(null);
    // See the matching comment in `PasswordRow`: out of the React tree and out
    // of the mutation variables, into the keyed stash the request body is built
    // from.
    stashTemporaryPassword(key, password);
    onRequest({
      input: {
        action: 'create_account',
        email: address,
        displayName: person,
        idempotencyKey: key,
      },
      title: `Create an account for ${person}`,
      prompt: `State who authorised this account and how you confirmed the identity of ${person} (${address}). Creating an account is recorded against your name permanently.`,
      confirmLabel: 'Create the account',
      credential: { password, personLabel: person, emailLabel: address, isNewAccount: true },
    });
    // Two mechanisms clear this field and both are wanted. The remount in
    // `AccessTab` covers the path where the action completes; this covers the
    // path where the administrator presses Go back in the reason dialog, after
    // which no reveal and no remount ever happen. Cancelling a
    // credential-bearing action discards the credential, deliberately: the
    // password was composed for a hand-over that did not take place, and
    // `tests/adminPasswordScreen.test.tsx` enters exactly that path so this
    // line cannot be removed as redundant with the remount.
    setPassword('');
  }

  return (
    <Card
      title="Create an account"
      description="For someone who has no Google account. The account is created with a temporary password you read out, and it starts with no role and no data access until it is approved below."
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Labelled
            id="create-email"
            label="Email address"
            hint="What they will type to sign in. No message is sent to it — this system sends no email at all."
          >
            <input
              id="create-email"
              type="email"
              className={INPUT_CLASS}
              value={email}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                setEmail(event.target.value);
                setFormError(null);
              }}
            />
          </Labelled>
          <Labelled
            id="create-name"
            label="Full name"
            hint="As it should appear on the records they sign."
          >
            <input
              id="create-name"
              className={INPUT_CLASS}
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setFormError(null);
              }}
            />
          </Labelled>
        </div>

        <TemporaryPasswordField
          id="create-password"
          forWhom="the new account"
          value={password}
          onChange={(next) => {
            setPassword(next);
            setFormError(null);
          }}
          onGenerateError={setFormError}
        />

        {formError !== null ? (
          <p role="alert" className="text-base font-medium text-red-900">
            {formError}
          </p>
        ) : null}

        <InfoNote>
          The password you set here is shown to you <strong>once</strong>, after the account
          is saved, and is kept nowhere afterwards. The holder cannot use the system with it:
          the server refuses every request from an account whose password an administrator
          set, until the holder has chosen their own. Signing in and reaching the
          change-password screen are the two things that still work.
        </InfoNote>

        <div>
          <Button variant="primary" onClick={submit}>
            <UserPlus aria-hidden className="h-4 w-4" />
            Continue and state the reason
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AccessTab({
  actorId,
  canApproveAccess,
  onRequest,
  formGeneration,
}: {
  actorId: string;
  canApproveAccess: boolean;
  onRequest: (action: PendingAction) => void;
  /**
   * Bumped by `AdminPage` whenever a temporary password has been handed to the
   * one-time panel. It is the create form's `key`, so the form REMOUNTS and
   * every field it held — including the credential — is discarded by React
   * rather than by a cleanup somebody has to remember to write. The same
   * device as `roleKey` below.
   */
  formGeneration: number;
}) {
  const users = useAdminUsers();

  const pending = useMemo(
    () => (users.data ?? []).filter((u) => u.status === 'pending'),
    [users.data],
  );
  const rest = useMemo(
    () => (users.data ?? []).filter((u) => u.status !== 'pending'),
    [users.data],
  );
  /**
   * Every account whose password an administrator still knows.
   *
   * The per-row chip answers "is this one of them"; this answers "how many are
   * there", which is the question an auditor asks and the one a long list
   * cannot be scanned for. Not filtered by status: a suspended account with an
   * outstanding change is still an account whose credential a second person
   * holds.
   */
  const administratorKnows = useMemo(
    () => (users.data ?? []).filter((u) => u.password_change_outstanding),
    [users.data],
  );

  if (users.isPending) return <LoadingBlock label="Loading accounts" />;
  if (users.isError) {
    return (
      <ErrorNotice
        error={users.error}
        what="The account list"
        onRetry={() => void users.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* States the limit rather than leaving it to be inferred from an absent
          field.

          BE PRECISE HERE, and do not restore the shorter wording this replaced.
          That version said no last-activity time existed "anywhere in the
          schema", which is false: `profiles.last_seen_at` exists. What does not
          exist is a WRITER for it — nothing in any migration, RPC, Edge
          Function or trigger ever sets it, so it is NULL for every account
          including the one reading this screen. "The column is absent" and "the
          column is never populated" are different claims, and asserting the
          stronger one on a quality screen is the same defect this note exists
          to avoid.

          Nor does this list claim to be everything the ledger holds: `profiles`
          also records approval_basis, approved_by, approved_at and
          last_access_review_at, none of which is rendered. PRD §81 asks the
          Users register for approval authority and last access review, so that
          is an outstanding gap, not a thing to paper over with a note. */}
      <InfoNote>
        This list shows when an account was created, its status and its roles. It does not
        show a last sign-in: nothing in this system records one, and the single activity
        field the database has is never written to, so any time shown here would be invented.
        Dormancy is therefore not answerable on this screen. What a person has actually done
        is in the audit log — search it by their email address under <strong>Audit query</strong>.
      </InfoNote>

      {/*
        THE CONSEQUENCE OF THE SELF-ADMINISTRATION RULE, STATED BEFORE IT BITES.

        The rule itself is on the administrator's own row, where the missing
        controls raise the question. This is the same fact in the one place it
        is useful IN ADVANCE: an administrator who discovers at the moment they
        are locked out that there is no self-service reset and no emailed link
        has discovered it too late, and the remedy — a second administrator
        account that exists and whose holder is reachable — has to be arranged
        while everything still works.

        Not conditional on the actor's own row being visible or scrolled to.
        The fact is true whether or not the list has loaded.
      */}
      <InfoNote tone="warning">
        <span>
          <strong>You cannot reset your own password here, and nobody can reset it for you by
          email.</strong>{' '}
          The server refuses every administrative act aimed at the account making it, so a
          forgotten administrator password is cleared only by{' '}
          <strong>another administrator</strong> setting you a temporary one face to face.
          Make sure a second administrator account exists and that you know who holds it
          before you need it — this system sends no mail at all, so there is no other way
          back in.
        </span>
      </InfoNote>

      {/* The `key` is what makes "shown once" true for this form: once a
          temporary password has gone to the one-time panel, the form is a
          different element and React throws the old one's state away. */}
      <CreateAccountCard key={`create-account-${formGeneration}`} onRequest={onRequest} />

      {/* Silent when there is nothing to say, and silent while the list is
          unknown — `users.isPending` and `users.isError` have already
          returned above, so reaching here means the list was read. A
          reassuring "0 accounts" built from a failed query would be worse
          than no line at all. */}
      {administratorKnows.length > 0 ? (
        <InfoNote tone="warning">
          <span>
            <strong>
              {administratorKnows.length === 1
                ? '1 account is still using a password an administrator knows'
                : `${administratorKnows.length} accounts are still using a password an administrator knows`}
              :
            </strong>{' '}
            {administratorKnows.map((u) => describeName(u)).join(', ')}. Until each holder
            chooses their own password, what those accounts record is not attributable to one
            person — so the server allows them nothing at all, and they are listed here rather
            than left to be noticed.
          </span>
        </InfoNote>
      ) : null}

      <Card
        title={`Waiting for approval (${pending.length})`}
        description="A new Google sign-in and an account created above both land here with no role and no data access. Nothing is granted by signing in, and nothing by being created."
      >
        {pending.length === 0 ? (
          <EmptyState
            title="No account is waiting for approval."
            hint="A new sign-in, or an account created above, appears here immediately, before it can read anything."
          />
        ) : (
          <ul className="list-none">
            {pending.map((user) => (
              <UserRow
                // The role checkboxes are a local draft seeded from the
                // server's roles, so the key carries those roles: if another
                // administrator changes them, this row remounts and the
                // checkboxes re-seed instead of showing a stale selection.
                key={roleKey(user)}
                user={user}
                actorId={actorId}
                canApproveAccess={canApproveAccess}
                onRequest={onRequest}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={`All other accounts (${rest.length})`}
        description="Roles and status. Changing either is an audited action and needs a reason."
      >
        {rest.length === 0 ? (
          <EmptyState title="No approved account exists yet." />
        ) : (
          <ul className="list-none">
            {rest.map((user) => (
              <UserRow
                // The role checkboxes are a local draft seeded from the
                // server's roles, so the key carries those roles: if another
                // administrator changes them, this row remounts and the
                // checkboxes re-seed instead of showing a stale selection.
                key={roleKey(user)}
                user={user}
                actorId={actorId}
                canApproveAccess={canApproveAccess}
                onRequest={onRequest}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delegated authority
// ---------------------------------------------------------------------------

function DelegationsTab({
  actorId,
  onRequest,
}: {
  actorId: string;
  onRequest: (action: PendingAction) => void;
}) {
  const delegations = useAdminDelegations();
  const users = useAdminUsers();

  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<Permission | ''>('');
  const [effectiveFrom, setEffectiveFrom] = useState(plantLocalDate(new Date()));
  const [effectiveTo, setEffectiveTo] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function submit() {
    if (userId === '') {
      setFormError('Choose the person this authority is being delegated to.');
      return;
    }
    if (permission === '') {
      setFormError('Choose which authority is being delegated.');
      return;
    }
    if (effectiveFrom === '') {
      setFormError('State the date the delegation starts.');
      return;
    }
    if (effectiveTo !== '' && effectiveTo < effectiveFrom) {
      setFormError('The end date cannot be before the start date.');
      return;
    }
    setFormError(null);
    const target = (users.data ?? []).find((u) => u.id === userId);
    onRequest({
      input: {
        action: 'create_delegation',
        userId,
        permission,
        effectiveFrom,
        effectiveTo: effectiveTo === '' ? null : effectiveTo,
      },
      title: `Delegate ${permission}`,
      prompt: `State the authority for delegating "${permission}" to ${
        target ? describeName(target) : userId
      } from ${effectiveFrom}${effectiveTo === '' ? ' with no end date' : ` until ${effectiveTo}`}. A delegation widens what the server will allow, so the reason is recorded permanently.`,
      confirmLabel: 'Record this delegation',
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <InfoNote tone="warning">
        <span>
          <strong>disposition.override_release</strong> is granted to no role at all. It exists
          only as a delegation, so an override release is always traceable to a named person who
          granted it, for a stated period, with a reason. Delegating it does not make the holder a
          Quality Supervisor; it authorises one specific act.
        </span>
      </InfoNote>

      <Card
        title="Record a delegation"
        description="Delegated authority is time-bounded. It starts on the date given and ends when the end date is reached — leave the end date blank only when the authority is genuinely open-ended."
      >
        {users.isError ? (
          <ErrorNotice
            error={users.error}
            what="The account list"
            onRetry={() => void users.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Labelled id="delegate-user" label="Delegate to">
                <select
                  id="delegate-user"
                  className={INPUT_CLASS}
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                >
                  <option value="">Choose a person…</option>
                  {/*
                    THE ACTOR IS NOT IN THIS LIST. `rpc_grant_delegation`
                    performs `assert_administers_other`, which refuses a
                    self-target unconditionally, so offering yourself here
                    offers an act that can only fail — and a delegation is
                    exactly the thing an administrator would most want to grant
                    themselves, which is why the server forbids it. Filtered
                    out rather than refused on submit: the refusal would arrive
                    after the reason had been typed.
                  */}
                  {(users.data ?? [])
                    .filter((u) => u.status === 'active' && u.id !== actorId)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {describeName(u)}
                      </option>
                    ))}
                </select>
              </Labelled>

              <Labelled
                id="delegate-permission"
                label="Authority"
                hint="Delegation-only authorities are marked. They cannot be obtained from any role."
              >
                <select
                  id="delegate-permission"
                  className={INPUT_CLASS}
                  value={permission}
                  onChange={(event) => setPermission(event.target.value as Permission)}
                >
                  <option value="">Choose an authority…</option>
                  {PERMISSIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                      {DELEGATION_ONLY_PERMISSIONS.includes(p) ? ' — delegation only' : ''}
                    </option>
                  ))}
                </select>
              </Labelled>

              <Labelled id="delegate-from" label="Effective from (Guyana date)">
                <input
                  id="delegate-from"
                  type="date"
                  className={INPUT_CLASS}
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                />
              </Labelled>

              <Labelled
                id="delegate-to"
                label="Effective to (Guyana date, optional)"
                hint="The delegation stops applying at the start of this date."
              >
                <input
                  id="delegate-to"
                  type="date"
                  className={INPUT_CLASS}
                  value={effectiveTo}
                  onChange={(event) => setEffectiveTo(event.target.value)}
                />
              </Labelled>
            </div>

            {formError !== null ? (
              <p role="alert" className="text-base font-medium text-red-900">
                {formError}
              </p>
            ) : null}

            <div>
              <Button variant="primary" onClick={submit}>
                <ShieldCheck aria-hidden className="h-4 w-4" />
                Continue and state the reason
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Recorded delegations"
        description="Every delegation ever recorded, newest first. A delegation is not deleted when it is revoked — revoking writes its own event."
      >
        {delegations.isPending ? (
          <LoadingBlock label="Loading delegations" />
        ) : delegations.isError ? (
          <ErrorNotice
            error={delegations.error}
            what="The delegation list"
            onRetry={() => void delegations.refetch()}
          />
        ) : delegations.data.length === 0 ? (
          <EmptyState
            title="No authority has been delegated."
            hint="Until something is delegated here, override release is available to nobody at all."
          />
        ) : (
          <ul className="list-none">
            {delegations.data.map((d) => (
              <li key={d.id} className="border-b border-slate-100 py-3 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-slate-900">
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm">
                        {d.permission}
                      </code>{' '}
                      to {d.user_email ?? d.user_id}
                    </p>
                    {/* `effective_from` and `effective_to` are timestamptz, not
                        date columns: the raw value is a UTC instant, and it used
                        to be printed verbatim under the words "(Guyana dates)",
                        which is two claims the column does not support. The
                        formatter converts to plant-local time and labels it. */}
                    <p className="text-sm text-slate-700">
                      In force from {instant(d.effective_from)}
                      {d.effective_to === null
                        ? ' with no end date'
                        : ` until ${instant(d.effective_to)}`}{' '}
                      · granted by {d.granted_by_name ?? d.granted_by ?? 'not recorded'}
                    </p>
                    {d.reason !== null && d.reason !== '' ? (
                      <p className="mt-1 text-base text-slate-800">
                        <span className="font-medium">Reason: </span>
                        {d.reason}
                      </p>
                    ) : null}
                    {d.revoked_at !== null ? (
                      <p className="mt-1 text-base font-medium text-slate-900">
                        Revoked {instant(d.revoked_at)}
                        {d.revoke_reason !== null && d.revoke_reason !== ''
                          ? ` — ${d.revoke_reason}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {DELEGATION_ONLY_PERMISSIONS.includes(d.permission) ? (
                      <StatusChip label="Delegation-only authority" tone="warning" size="sm" />
                    ) : null}
                    {d.revoked_at !== null ? (
                      <StatusChip label="Revoked" tone="neutral" size="sm" />
                    ) : null}
                  </div>
                </div>
                {/* No Revoke on an already-revoked row: `rpc_revoke_delegation`
                    refuses a second revocation (BFF_ALREADY_REVOKED), so the
                    button would offer an act the server rejects. */}
                {d.revoked_at === null ? (
                  <div className="mt-2">
                    <Button
                      variant="danger"
                      onClick={() =>
                        onRequest({
                          input: { action: 'revoke_delegation', delegationId: d.id },
                          title: 'Revoke this delegation',
                          prompt: `State why "${d.permission}" is being revoked. The delegation record is kept; revoking adds an event.`,
                          confirmLabel: 'Revoke the delegation',
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controlled lists
// ---------------------------------------------------------------------------

function ListsTab({ onRequest }: { onRequest: (action: PendingAction) => void }) {
  const values = useControlledValues();
  const [listKey, setListKey] = useState('');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, { id: string; value: string; label: string; active: boolean }[]>();
    for (const row of values.data ?? []) {
      const list = map.get(row.list_key);
      const entry = { id: row.id, value: row.value, label: row.label, active: row.active };
      if (list) list.push(entry);
      else map.set(row.list_key, [entry]);
    }
    return map;
  }, [values.data]);

  function submit() {
    if (listKey.trim() === '' || value.trim() === '') {
      setFormError('Both the list and the code are needed. The label may repeat the code.');
      return;
    }
    setFormError(null);
    onRequest({
      input: {
        action: 'upsert_controlled_value',
        listKey: listKey.trim(),
        value: value.trim(),
        label: label.trim() === '' ? value.trim() : label.trim(),
        active: true,
      },
      title: `Add "${value.trim()}" to ${listKey.trim()}`,
      prompt:
        'State why this value is being added. Controlled lists decide what operators can choose, so additions are audited.',
      confirmLabel: 'Add the value',
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <InfoNote>
        Controlled lists are the vocabulary operators choose from — materials, suppliers and the
        like. Values come from the workbook&rsquo;s own wording and are not reworded here, because
        an operator reading the screen and an operator reading the paper log have to see the same
        words.
      </InfoNote>

      <Card title="Add or re-activate a value">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Labelled id="list-key" label="List" hint="e.g. material, supplier">
              <input
                id="list-key"
                className={INPUT_CLASS}
                value={listKey}
                onChange={(event) => setListKey(event.target.value)}
              />
            </Labelled>
            <Labelled id="list-value" label="Stored code">
              <input
                id="list-value"
                className={INPUT_CLASS}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Labelled>
            <Labelled id="list-label" label="Shown to operators (optional)">
              <input
                id="list-label"
                className={INPUT_CLASS}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Labelled>
          </div>
          {formError !== null ? (
            <p role="alert" className="text-base font-medium text-red-900">
              {formError}
            </p>
          ) : null}
          <div>
            <Button variant="primary" onClick={submit}>
              <Database aria-hidden className="h-4 w-4" />
              Continue and state the reason
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Existing values">
        {values.isPending ? (
          <LoadingBlock label="Loading controlled lists" />
        ) : values.isError ? (
          <ErrorNotice
            error={values.error}
            what="The controlled lists"
            onRetry={() => void values.refetch()}
          />
        ) : grouped.size === 0 ? (
          <EmptyState
            title="No controlled value has been configured."
            hint="Until a list has values, the matching form field accepts free text and the filter dropdown is empty."
          />
        ) : (
          <div className="flex flex-col gap-5">
            {[...grouped.entries()].map(([key, entries]) => (
              <section key={key}>
                <h3 className="text-base font-bold text-slate-900">{key}</h3>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <StatusChip
                        label={`${entry.label}${entry.label === entry.value ? '' : ` (${entry.value})`}${
                          entry.active ? '' : ' — not offered'
                        }`}
                        tone={entry.active ? 'info' : 'neutral'}
                        size="sm"
                      />
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-2">
                  {entries
                    .filter((entry) => entry.active)
                    .map((entry) => (
                      <Button
                        key={entry.id}
                        onClick={() =>
                          onRequest({
                            input: {
                              action: 'upsert_controlled_value',
                              listKey: key,
                              value: entry.value,
                              label: entry.label,
                              active: false,
                            },
                            title: `Stop offering "${entry.label}"`,
                            prompt:
                              'State why this value should no longer be offered. Existing records that already use it are unchanged — this only affects new entries.',
                            confirmLabel: 'Stop offering it',
                          })
                        }
                      >
                        Stop offering {entry.label}
                      </Button>
                    ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync health
// ---------------------------------------------------------------------------

/**
 * Audit-trail gaps.
 *
 * Rendered above the sync queue because it is a different and worse class of
 * problem: a failed sync means a record is in the ledger and not yet in the
 * sheet, which is recoverable and visible. A failed AUDIT write means an action
 * happened and the trail does not say so — and the request itself succeeded, so
 * nothing else anywhere reports it.
 */
function AuditTrailGaps() {
  const deadLetters = useAuditDeadLetters();

  // Say nothing while unknown, and nothing when genuinely clean. A reassuring
  // "0 gaps" rendered from a failed query would be worse than silence.
  if (deadLetters.isPending || deadLetters.isError) return null;
  const held = deadLetters.data.held;
  if (held.length === 0) return null;

  const oldest = deadLetters.data.oldestHeldAt;
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border-2 border-amber-400 bg-amber-50 p-4"
    >
      <p className="text-base font-semibold text-amber-900">
        {held.length === 1
          ? '1 action was carried out but could not be written to the audit trail.'
          : `${held.length} actions were carried out but could not be written to the audit trail.`}
      </p>
      <p className="mt-1 text-sm text-amber-900">
        The decisions themselves took effect. Each held entry keeps the whole original
        event, so the trail can be completed once the cause is fixed.
        {oldest !== null ? ` Oldest outstanding: ${formatPlantDateTimeLabelled(new Date(oldest))}.` : ''}
      </p>
      <ul className="mt-3 space-y-1 text-sm text-amber-900">
        {held.slice(0, 5).map((row) => (
          <li key={row.id}>
            <span className="font-medium">{row.action}</span> on {row.subject_type}
            {row.subject_id !== null ? ` ${row.subject_id}` : ''} — {row.outcome}
            {', '}
            {row.failure_stage === 'threw'
              ? 'the audit write was never reached'
              : 'the database refused the audit write'}
            {row.attempts > 0 ? ` (${row.attempts} replay attempt${row.attempts === 1 ? '' : 's'})` : ''}
          </li>
        ))}
      </ul>
      {held.length > 5 ? (
        <p className="mt-2 text-sm text-amber-900">
          and {held.length - 5} more.
        </p>
      ) : null}
    </div>
  );
}

function SyncTab({ canRetry }: { canRetry: boolean }) {
  const health = useSyncHealth();
  const retry = useSyncRetry();
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  function runRetry(jobId: string) {
    setRetryingJobId(jobId);
    setRetryError(null);
    setRetryMessage(null);
    retry.mutate(
      { jobId },
      {
        onSuccess: (result) => setRetryMessage(result.message),
        onError: (error: unknown) =>
          setRetryError(error instanceof Error ? error.message : String(error)),
        onSettled: () => setRetryingJobId(null),
      },
    );
  }

  return (
    <Card
      title="Google Sheets sync health"
      description="Supabase is the ledger; the workbook is the operational record written from it. A job listed as failed means the record is safe in the ledger and absent from the sheet — never the other way round."
    >
      <AuditTrailGaps />

      {!canRetry ? (
        <div className="mb-4">
          <NotPermitted reason="You can see the sync queue but not retry a job. Retrying needs the sync-retry permission." />
        </div>
      ) : null}

      {retryError !== null ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900"
        >
          The retry was not accepted: {retryError}. The job is unchanged and can be retried again.
        </p>
      ) : null}

      {retryMessage !== null ? (
        <div className="mb-4">
          <InfoNote>{retryMessage}</InfoNote>
        </div>
      ) : null}

      {health.isPending ? (
        <LoadingBlock label="Reading the sync queue" />
      ) : health.isError ? (
        <ErrorNotice
          error={health.error}
          what="The sync queue"
          onRetry={() => void health.refetch()}
        />
      ) : (
        <SyncHealthTable
          health={health.data}
          onRetry={runRetry}
          retryingJobId={retryingJobId}
          canRetry={canRetry}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

function SchemaTab() {
  const verification = useSchemaVerification();

  return (
    <Card
      title="Workbook schema check"
      description="Row 4 of each operational tab is the header row, and the app writes by column position. A header that has drifted is therefore a write-blocking fault, not a cosmetic difference."
    >
      <SchemaVerificationPanel
        report={verification.data}
        loading={verification.isFetching}
        error={verification.error}
        onRecheck={() => void verification.refetch()}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

function AuditTab() {
  const [query, setQuery] = useState<AuditQuery>(EMPTY_AUDIT_QUERY);
  const [page, setPage] = useState(0);
  // Free text is committed on submit, not on every keystroke — the same
  // convention as the sample filters, and the reason is not only efficiency:
  // each distinct query object is its own cache key and its own request.
  const [actor, setActor] = useState(query.actor);
  const [action, setAction] = useState(query.action);
  const pageSize = 50;
  const events = useAuditEvents(query, page, pageSize);

  function update(patch: Partial<AuditQuery>) {
    setQuery((current) => ({ ...current, ...patch }));
    setPage(0);
  }

  const filtered =
    query.actor !== '' || query.action !== '' || query.fromDate !== '' || query.toDate !== '';

  return (
    <Card
      title="Audit query"
      description="Every consequential action, append-only. Nothing on this screen can edit or delete an event — the table refuses it, not the UI."
    >
      <div className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            update({ actor, action });
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* `actor_email` is the only text identity `audit_events` keeps, so
                this searches an address and says so. A surname still matches
                most addresses, but a display name that differs from the
                address will never be found here. */}
            <Labelled
              id="audit-actor"
              label="Email address"
              hint="Part of an email address is enough — events record the address, not a display name. Press Search."
            >
              <input
                id="audit-actor"
                type="search"
                className={INPUT_CLASS}
                value={actor}
                onChange={(event) => setActor(event.target.value)}
              />
            </Labelled>
            <Labelled
              id="audit-action"
              label="Action code"
              hint="Exact match, e.g. hold_raised. Press Search."
            >
              <input
                id="audit-action"
                type="search"
                className={INPUT_CLASS}
                value={action}
                onChange={(event) => setAction(event.target.value)}
              />
            </Labelled>
            <Labelled id="audit-from" label="From (Guyana date)">
              <input
                id="audit-from"
                type="date"
                className={INPUT_CLASS}
                value={query.fromDate}
                onChange={(event) => update({ fromDate: event.target.value })}
              />
            </Labelled>
            <Labelled id="audit-to" label="To (Guyana date, inclusive)">
              <input
                id="audit-to"
                type="date"
                className={INPUT_CLASS}
                value={query.toDate}
                onChange={(event) => update({ toDate: event.target.value })}
              />
            </Labelled>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary">
              <FileSearch aria-hidden className="h-4 w-4" />
              Search the audit log
            </Button>
            {filtered ? (
              <Button
                onClick={() => {
                  setActor('');
                  setAction('');
                  setQuery(EMPTY_AUDIT_QUERY);
                  setPage(0);
                }}
              >
                Clear the filters
              </Button>
            ) : null}
          </div>
        </form>

        <p className="text-sm text-slate-600">
          Dates are plant-local calendar days and are converted to their UTC instant bounds before
          the query runs, so an event recorded at 21:00 Guyana is found on its own Guyana day.
        </p>

        {events.isPending ? (
          <LoadingBlock label="Searching the audit log" />
        ) : events.isError ? (
          <ErrorNotice
            error={events.error}
            what="The audit log"
            onRetry={() => void events.refetch()}
          />
        ) : events.data.rows.length === 0 ? (
          <EmptyState
            title="No audit event matches this search."
            hint="Widen the dates or clear the filters. An empty result here is a genuine absence of matching events, not a failed query — a failed query is reported as an error."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <AuditTimeline events={events.data.rows} />
            <Pagination
              page={page}
              pageSize={pageSize}
              total={events.data.total}
              totalUnknown={false}
              rowsOnPage={events.data.rows.length}
              onPageChange={setPage}
              busy={events.isFetching}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { user, allows } = useAuthority();
  const action = useAdminAction();

  const [tab, setTab] = useState<AdminTab>('access');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /**
   * The temporary password currently on screen, and nothing else anywhere.
   *
   * Ordinary component state, so it dies with the component: a navigation away
   * from this page, a reload or a sign-out all take it with them. That is the
   * intended lifetime — there is nowhere to put it that would survive, and
   * nowhere it should.
   */
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  /**
   * The credential the mutation callbacks will need, held so they do not have
   * to close over it. See the note in `confirm`: `mutate`'s per-call options
   * are retained by the MutationObserver for the life of this component and
   * `reset()` does not clear them, so a closure over the plaintext would
   * outlive the panel that displays it.
   */
  const credentialRef = useRef<Credential | null>(null);
  const [formGeneration, setFormGeneration] = useState(0);

  const canApproveAccess = allows('user.approve_access');
  const canViewSync = allows('sync.view');
  const canRetrySync = allows('sync.retry');
  const canViewAudit = allows('audit.view');

  /**
   * Read the matrix rather than repeat the claim. If an edit ever gave the
   * Administrator role a quality permission, this list is how it is found.
   */
  const adminQualityGrants = useMemo(
    () => basePermissions('administrator').filter((p) => QUALITY_AUTHORITY_PERMISSIONS.includes(p)),
    [],
  );

  function request(next: PendingAction) {
    setFailure(null);
    setSuccess(null);
    // A password already on screen is withdrawn before a new action starts, so
    // two credentials are never shown at once and the older one cannot be read
    // off a stale panel after it has been superseded.
    setRevealed(null);
    setPending(next);
  }

  /**
   * The reason dialog was dismissed, so the act never happens.
   *
   * The stashed credential has to go with it. `stashTemporaryPassword` is
   * called when the form is submitted and the entry is removed by
   * `useAdminAction` when it builds the request — on this path no request is
   * ever built, so nothing else would delete it.
   */
  function cancel() {
    const current = pending;
    setPending(null);
    if (current?.input.idempotencyKey !== undefined) {
      clearTemporaryPassword(current.input.idempotencyKey);
    }
  }

  function confirm(reason: string) {
    const current = pending;
    if (current === null) return;
    setPending(null);
    const credential = current.credential;
    /**
     * Two independent reasons to expect a credential, deliberately OR-ed
     * rather than one derived from the other.
     *
     * `credential` says a password is about to be shown; `carriesCredential`
     * says the ACTION is one that sends a password. They should always agree,
     * and if a later edit adds a password-bearing action and forgets the panel,
     * the form is still remounted — the failure is then a missing readout,
     * which somebody notices immediately, rather than a password left sitting
     * in a field on an unattended plant tablet, which nobody does.
     */
    const hadCredential = credential !== undefined || carriesCredential(current.input.action);
    /**
     * The password is put where the callbacks can reach it WITHOUT capturing
     * it. `mutate(variables, options)` stores those options on the
     * MutationObserver (`#mutateOptions`), which `reset()` does not clear and
     * which lives as long as this component — so a closure over
     * `credential.password` would be a second retention site with a longer
     * lifetime than the panel that is showing it on purpose. A ref is one
     * object the closures capture instead, and its contents are dropped when
     * the panel is dismissed.
     */
    credentialRef.current = credential ?? null;
    /**
     * Copied out BEFORE the closures are written, and this is not style.
     *
     * The callbacks below need the action's title for their message. Reading
     * `current.title` inside one of them captures `current` — the whole
     * `PendingAction`, `credential.password` included — in the retained
     * `#mutateOptions`, which is exactly the retention site the ref above
     * exists to avoid. A closure's reach is the whole object it dereferences,
     * not the property it reads, so the string is lifted out here and nothing
     * in the callbacks refers to `current` at all.
     */
    const title = current.title;
    action.mutate(
      { ...current.input, reason },
      {
        onSuccess: (result) => {
          setSuccess(result.message);
          setFailure(null);
          const shown = credentialRef.current;
          if (shown !== null) setRevealed({ ...shown, confirmed: true });
        },
        onError: (error: unknown) => {
          const shown = credentialRef.current;
          setFailure(
            shown === null
              ? `${title} did not go through: ${
                  error instanceof Error ? error.message : String(error)
                }. Nothing was changed.`
              : // "Nothing was changed" is not a claim that can be made about
                // these two. The password reached the server; whether an
                // account was created or a credential replaced before the
                // failure is not knowable from here, and saying otherwise
                // would send an administrator to create a second account for
                // a person who already has one.
                `${title} was not confirmed: ${
                  error instanceof Error ? error.message : String(error)
                }. It may or may not have taken effect — check the account in the list below before trying again.`,
          );
          setSuccess(null);
          if (shown !== null) setRevealed({ ...shown, confirmed: false });
        },
        onSettled: () => {
          if (!hadCredential) return;
          /**
           * NOT A SCRUB, AND THE COMMENT HERE USED TO SAY IT WAS.
           *
           * It claimed `reset()` "puts the mutation back to its default state,
           * which has no variables, so the only remaining copy is the one in
           * `revealed`". That is false. `MutationObserver.reset()` removes the
           * OBSERVER from the mutation and clears its own pointer; the
           * Mutation stays in the MutationCache with `state.variables` intact,
           * and is removed by a garbage-collection timer `gcTime` later —
           * five minutes by default. A twelve-line probe reads the plaintext
           * out of the cache after `reset()` has run
           * (`tests/adminCredentialCache.test.tsx` does exactly that).
           *
           * The credential is no longer in the variables at all, so there is
           * nothing here to scrub. `reset()` is kept because it still does
           * what it says — detach this observer, letting the settled mutation
           * be collected — and the remount clears the form field, which is a
           * copy in the DOM and a real one.
           */
          action.reset();
          setFormGeneration((current) => current + 1);
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <PageHeader
        title="Administration"
        description="Accounts, delegated authority, controlled lists and technical health."
      />

      {/* The one thing an administrator must not be allowed to believe. */}
      <div
        role="region"
        aria-label="Limits of the Administrator role"
        className="mb-6 rounded-md border-2 border-slate-400 bg-slate-50 p-4"
      >
        <p className="flex items-center gap-2 text-lg font-bold text-slate-900">
          <ShieldAlert aria-hidden className="h-6 w-6" />
          An Administrator has no quality authority
        </p>
        <p className="mt-1 text-base text-slate-800">
          This role maintains accounts and technical configuration. It <strong>cannot</strong>{' '}
          approve a specification limit, <strong>cannot</strong> clear a quality hold and{' '}
          <strong>cannot</strong> release, reject or rework material. Those decisions belong to a
          Quality Supervisor, and no amount of administrative access substitutes for one
          (PRD §2). A Quality Officer can raise a hold but not clear one.
        </p>
        <p className="mt-1 text-base text-slate-800">
          Granting yourself a role here does not grant quality authority either: the server
          re-checks the matrix on every request, and <code>disposition.override_release</code> is
          not in any role&rsquo;s base grant at all — only a recorded, time-bounded delegation can
          confer it.
        </p>
        {adminQualityGrants.length > 0 ? (
          <p role="alert" className="mt-2 text-base font-bold text-red-900">
            Fault: the permission matrix currently grants the Administrator role{' '}
            {adminQualityGrants.join(', ')}. That contradicts PRD §2 and must be corrected in{' '}
            <code>src/lib/roles.ts</code> and the matching database migration before this
            deployment is used.
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            Checked against the permission matrix in this build: the Administrator role holds none
            of {QUALITY_AUTHORITY_PERMISSIONS.join(', ')}.
          </p>
        )}
      </div>

      {failure !== null ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900"
        >
          {failure}
        </p>
      ) : null}

      {success !== null ? (
        <div className="mb-4">
          <InfoNote>{success}</InfoNote>
        </div>
      ) : null}

      {/* Above the tabs, so switching tab does not hide the one moment a
          temporary password is readable. */}
      {revealed !== null ? (
        <TemporaryPasswordPanel
          revealed={revealed}
          onDismiss={() => {
            // Both copies, in the one handler. `revealed` is what the panel
            // renders; `credentialRef` is what the mutation callbacks read
            // instead of closing over the plaintext. Clearing one and not the
            // other would leave the credential reachable after the panel says
            // it is gone.
            credentialRef.current = null;
            setRevealed(null);
          }}
        />
      ) : null}

      <nav aria-label="Administration sections" className="mb-5">
        <ul className="flex flex-wrap gap-2">
          {TABS.map((entry) => {
            const Icon = entry.icon;
            const current = tab === entry.id;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => setTab(entry.id)}
                  className={
                    current
                      ? 'inline-flex min-h-tap items-center gap-2 rounded-lg border border-bff-800 bg-bff-700 px-4 py-2.5 text-base font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600 focus-visible:ring-offset-2'
                      : 'inline-flex min-h-tap items-center gap-2 rounded-lg border border-bff-300 bg-white px-4 py-2.5 text-base font-medium text-bff-800 hover:bg-bff-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600 focus-visible:ring-offset-2'
                  }
                >
                  <Icon aria-hidden className="h-4 w-4" />
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {tab === 'access' ? (
        <AccessTab
          actorId={user.id}
          canApproveAccess={canApproveAccess}
          onRequest={request}
          formGeneration={formGeneration}
        />
      ) : null}

      {tab === 'delegations' ? (
        <DelegationsTab actorId={user.id} onRequest={request} />
      ) : null}

      {tab === 'lists' ? <ListsTab onRequest={request} /> : null}

      {tab === 'sync' ? (
        canViewSync ? (
          <SyncTab canRetry={canRetrySync} />
        ) : (
          <NotPermitted reason="Seeing the Google Sheets sync queue needs the sync-view permission." />
        )
      ) : null}

      {tab === 'schema' ? <SchemaTab /> : null}

      {tab === 'audit' ? (
        canViewAudit ? (
          <AuditTab />
        ) : (
          <NotPermitted reason="Querying the audit log needs the audit-view permission. The log itself is append-only and is never editable from this screen." />
        )
      ) : null}

      <ReasonDialog
        open={pending !== null}
        title={pending?.title ?? 'Record a reason'}
        prompt={pending?.prompt ?? ''}
        confirmLabel={pending?.confirmLabel ?? 'Confirm'}
        busy={action.isPending}
        onConfirm={confirm}
        onCancel={cancel}
      />
    </div>
  );
}
