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

import { useMemo, useState } from 'react';
import {
  Database,
  FileSearch,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TableProperties,
  UserCheck,
  UserCog,
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

/** A mutation waiting for its written reason. */
interface PendingAction {
  readonly input: Omit<AdminActionInput, 'reason'>;
  readonly title: string;
  readonly prompt: string;
  readonly confirmLabel: string;
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
// Users and access
// ---------------------------------------------------------------------------

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
          <p className="text-xs text-slate-500">
            Account created {instant(user.created_at)} · last signed in{' '}
            {instant(user.last_sign_in_at)}
          </p>
        </div>
        <StatusChip
          label={USER_STATUS_LABELS[user.status]}
          tone={USER_STATUS_TONE[user.status]}
          srPrefix="Account status:"
        />
      </div>

      {user.status === 'pending' ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-base font-medium text-amber-900">
            This account has signed in with Google but can see no data at all until it is
            approved. Approving it does not give it any role — grant roles below, deliberately.
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
    </li>
  );
}

function AccessTab({
  actorId,
  canApproveAccess,
  onRequest,
}: {
  actorId: string;
  canApproveAccess: boolean;
  onRequest: (action: PendingAction) => void;
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
      <Card
        title={`Waiting for approval (${pending.length})`}
        description="A new Google sign-in lands here with no role and no data access. Nothing is granted by signing in."
      >
        {pending.length === 0 ? (
          <EmptyState
            title="No account is waiting for approval."
            hint="A new sign-in appears here immediately, before it can read anything."
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

function DelegationsTab({ onRequest }: { onRequest: (action: PendingAction) => void }) {
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
                  {(users.data ?? [])
                    .filter((u) => u.status === 'active')
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
                    <p className="text-sm text-slate-700">
                      From {d.effective_from}
                      {d.effective_to === null ? ' with no end date' : ` until ${d.effective_to}`}{' '}
                      (Guyana dates) · granted by {d.granted_by_name ?? d.granted_by ?? 'not recorded'}
                    </p>
                    {d.reason !== null && d.reason !== '' ? (
                      <p className="mt-1 text-base text-slate-800">
                        <span className="font-medium">Reason: </span>
                        {d.reason}
                      </p>
                    ) : null}
                  </div>
                  {DELEGATION_ONLY_PERMISSIONS.includes(d.permission) ? (
                    <StatusChip label="Delegation-only authority" tone="warning" size="sm" />
                  ) : null}
                </div>
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
            <Labelled
              id="audit-actor"
              label="Person"
              hint="Part of a name is enough. Press Search."
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
    setPending(next);
  }

  function confirm(reason: string) {
    const current = pending;
    if (current === null) return;
    setPending(null);
    action.mutate(
      { ...current.input, reason },
      {
        onSuccess: (result) => {
          setSuccess(result.message);
          setFailure(null);
        },
        onError: (error: unknown) => {
          setFailure(
            `${current.title} did not go through: ${
              error instanceof Error ? error.message : String(error)
            }. Nothing was changed.`,
          );
          setSuccess(null);
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
        />
      ) : null}

      {tab === 'delegations' ? <DelegationsTab onRequest={request} /> : null}

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
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
