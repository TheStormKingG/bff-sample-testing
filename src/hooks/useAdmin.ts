/**
 * Administration data: user access, roles, delegations, controlled lists,
 * sync health, schema verification and the audit query.
 *
 * An Administrator has no quality authority anywhere in here. Approving a
 * specification, clearing a hold and releasing material are deliberately
 * absent from the admin surface because they are absent from the role
 * (Master Prompt §1, PRD §2).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Stage } from '@/forms/types';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { expectedHeaders, type HeaderMismatch } from '@/forms/sheetMapping';
import type { Permission, Role, UserStatus } from '@/lib/roles';
import { plantDayEnd, plantDayStart } from '@/lib/time';
import { FUNCTIONS, TABLES, type AuditEventRow } from '@/hooks/useSamples';

const db = supabase as unknown as SupabaseClient;

/**
 * PostgREST carries an `in` filter in the query string, so one unbounded list
 * of uuids can outgrow a proxy's request-line limit. The two id lookups below
 * resolve in batches for that reason, not for database cost.
 */
const ID_BATCH = 100;

function batches<T>(values: readonly T[], size = ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Users, roles and delegations
// ---------------------------------------------------------------------------

export interface AdminUser {
  readonly id: string;
  readonly email: string | null;
  readonly full_name: string | null;
  readonly status: UserStatus;
  readonly created_at: string;
  readonly roles: readonly Role[];
}

export interface AdminDelegation {
  readonly id: string;
  readonly user_id: string;
  readonly user_email: string | null;
  readonly permission: Permission;
  readonly granted_by: string | null;
  readonly granted_by_name: string | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly reason: string | null;
  /**
   * `user_delegations` keeps a revoked row and stamps it, and
   * `rpc_revoke_delegation` REFUSES a second revocation
   * (`BFF_ALREADY_REVOKED`). Both are read because a list that shows every
   * delegation ever recorded without its revocation reads as live authority,
   * and because offering Revoke on a revoked row offers an act the server will
   * reject.
   */
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
}

/** The three columns a uuid can be resolved to a readable person with. */
interface ProfileNameRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
}

interface ProfileRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly status: UserStatus;
  readonly created_at: string;
}

/**
 * NO SIGN-IN AND NO LAST-ACTIVITY INSTANT IS READ HERE, DELIBERATELY.
 *
 * `profiles` has no sign-in timestamp at all. It does have `last_seen_at`
 * (`0001_identity.sql`, nullable, no default), and this hook used to pipe that
 * column to a field the screen printed as "last signed in". NOTHING WRITES IT:
 * no migration, trigger, RPC body, Edge Function or frontend path assigns it.
 * Checked three ways — a repository-wide grep for the name (declaration and
 * this file only), `pg_trigger` on `public.profiles` (just
 * `profiles_set_updated_at`), and every `pg_proc.prosrc` in the database (no
 * match) — and in `bff_migration_check` the column is NULL on every row. The
 * label therefore read "last signed in Never" for an account that was signed
 * in at that moment.
 *
 * It was removed rather than filled because both ways to fill it are worse
 * than silence. Mirroring GoTrue's `auth.users.last_sign_in_at` cannot even be
 * created against the verification database (that column does not exist in the
 * local auth shim, so the migration would fail `verify-migrations.sh`) and
 * would couple a public migration to an internal auth table. Writing the
 * column from the request path is per-request activity telemetry rather than a
 * sign-in time, and it would fire `profiles_set_updated_at` on every page
 * load, so `updated_at` would stop meaning "this record was changed" — in a
 * system whose audit trail is a regulated artefact. The client's own session
 * does carry a sign-in instant, but only for the viewer, never for the other
 * accounts this list is reviewing.
 *
 * Nor is one required: PRD §81's `_Users` register asks for the last ACCESS
 * REVIEW, not the last sign-in, and "when did this person last act" is already
 * answered under audit by `audit_events`, searchable on the Audit tab.
 */
export async function fetchAdminUsers(): Promise<readonly AdminUser[]> {
  const [profileRes, roleRes] = await Promise.all([
    db
      .from(TABLES.profiles)
      .select('id,email,display_name,status,created_at')
      .order('created_at', { ascending: false }),
    db.from(TABLES.userRoles).select('user_id,role'),
  ]);
  if (profileRes.error) throw new Error(profileRes.error.message);
  if (roleRes.error) throw new Error(roleRes.error.message);

  const roleMap = new Map<string, Role[]>();
  for (const r of (roleRes.data ?? []) as { user_id: string; role: Role }[]) {
    const list = roleMap.get(r.user_id);
    if (list) list.push(r.role);
    else roleMap.set(r.user_id, [r.role]);
  }

  return ((profileRes.data ?? []) as ProfileRow[]).map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.display_name,
    status: p.status,
    created_at: p.created_at,
    roles: roleMap.get(p.id) ?? [],
  }));
}

export function useAdminUsers() {
  return useQuery({ queryKey: ['admin', 'users'], queryFn: fetchAdminUsers, staleTime: 15_000 });
}

type DelegationRow = Omit<AdminDelegation, 'user_email' | 'granted_by_name'>;

export function useAdminDelegations() {
  return useQuery({
    queryKey: ['admin', 'delegations'],
    queryFn: async (): Promise<readonly AdminDelegation[]> => {
      const { data, error } = await db
        .from(TABLES.delegations)
        .select(
          'id,user_id,permission,granted_by,effective_from,effective_to,reason,revoked_at,revoke_reason',
        )
        .order('effective_from', { ascending: false });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as DelegationRow[];

      // `user_delegations` stores uuids and nothing else, so the holder's email
      // and the granting administrator's name come from a second read of
      // `profiles`. A delegation nobody can read is a delegation nobody
      // reviews, and the alternative here would be inventing a name.
      const ids = [
        ...new Set(
          rows
            .flatMap((r) => [r.user_id, r.granted_by])
            .filter((v): v is string => v !== null),
        ),
      ];
      const people = new Map<string, ProfileNameRow>();
      for (const batch of batches(ids)) {
        const res = await db.from(TABLES.profiles).select('id,email,display_name').in('id', batch);
        if (res.error) throw new Error(res.error.message);
        for (const person of (res.data ?? []) as ProfileNameRow[]) {
          people.set(person.id, person);
        }
      }

      return rows.map((r) => ({
        ...r,
        // Null where no profile row answers for the id: the screen then shows
        // the uuid, which is true, rather than a plausible name that is not.
        user_email: people.get(r.user_id)?.email ?? null,
        granted_by_name:
          r.granted_by === null ? null : (people.get(r.granted_by)?.display_name ?? null),
      }));
    },
    staleTime: 15_000,
  });
}

export type AdminActionKind =
  | 'approve_access'
  | 'deny_access'
  | 'set_status'
  | 'set_roles'
  | 'create_delegation'
  | 'revoke_delegation'
  | 'upsert_controlled_value';

export interface AdminActionInput {
  readonly action: AdminActionKind;
  readonly userId?: string;
  readonly status?: UserStatus;
  readonly roles?: readonly Role[];
  readonly permission?: Permission;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly delegationId?: string;
  readonly listKey?: string;
  readonly value?: string;
  readonly label?: string;
  readonly active?: boolean;
  readonly reason: string;
}

export interface AdminActionResult {
  readonly ok: boolean;
  readonly message: string;
}

export function useAdminAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdminActionInput): Promise<AdminActionResult> => {
      const { data, error } = await db.functions.invoke(FUNCTIONS.adminAction, { body: input });
      if (error) throw new Error(error.message);
      const result = data as AdminActionResult | null;
      if (!result) throw new Error('The server returned no result. Nothing was changed.');
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin'] });
      void client.invalidateQueries({ queryKey: ['authority'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Controlled lists
// ---------------------------------------------------------------------------

export interface ControlledValue {
  readonly id: string;
  readonly list_key: string;
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
  readonly sort_order: number | null;
}

interface VocabularyRow {
  readonly code: string;
  readonly label: string;
  readonly active: boolean;
  readonly sort_order: number | null;
}

/**
 * The vocabulary is five tables of `(code, label, sort_order, active)`, not one
 * keyed table, so `list_key` is not a stored column — it is which table a row
 * came from. The literals below are the five values
 * `rpc_upsert_controlled_value` branches on, so a value the screen sends back
 * lands in the list it was read from; renaming one here would silently route an
 * edit to the wrong vocabulary. Listed alphabetically, which is the order the
 * screen's groups used to arrive in.
 */
const VOCABULARY_SOURCES = [
  {
    listKey: 'feed_types',
    read: () =>
      db
        .from('feed_types')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'materials',
    read: () =>
      db
        .from('materials')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'mill_screen_sizes',
    read: () =>
      db
        .from('mill_screen_sizes')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'sampling_points',
    read: () =>
      db
        .from('sampling_points')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'suppliers',
    read: () =>
      db
        .from('suppliers')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
] as const;

export function useControlledValues() {
  return useQuery({
    queryKey: ['admin', 'controlled-values'],
    queryFn: async (): Promise<readonly ControlledValue[]> => {
      const responses = await Promise.all(VOCABULARY_SOURCES.map((source) => source.read()));
      const out: ControlledValue[] = [];
      responses.forEach((response, index) => {
        if (response.error) throw new Error(response.error.message);
        const { listKey } = VOCABULARY_SOURCES[index]!;
        for (const row of (response.data ?? []) as VocabularyRow[]) {
          out.push({
            // `code` is the key within its own table; the list it belongs to is
            // prefixed so one id stays unique across the five flattened here.
            id: `${listKey}:${row.code}`,
            list_key: listKey,
            value: row.code,
            label: row.label,
            active: row.active,
            sort_order: row.sort_order,
          });
        }
      });
      // An empty list is an answer: the screen says the matching field accepts
      // free text until the list is configured.
      return out;
    },
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Sync health
// ---------------------------------------------------------------------------

export interface SyncJobRow {
  readonly id: string;
  readonly sample_uuid: string | null;
  readonly sample_id: string | null;
  readonly stage: Stage | null;
  readonly intended_tab: string | null;
  readonly payload_revision: number | null;
  readonly attempt_count: number;
  readonly state: string;
  readonly next_retry_at: string | null;
  readonly last_error: string | null;
  readonly last_confirmed_at: string | null;
  readonly reconciliation_status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SyncHealth {
  readonly jobs: readonly SyncJobRow[];
  readonly counts: Readonly<Record<string, number>>;
  /** Jobs that need a human: failed or dead-lettered. */
  readonly needsAttention: readonly SyncJobRow[];
}

interface SyncOutboxRow {
  readonly event_id: string;
  readonly sample_uuid: string | null;
  readonly target_tab: string | null;
  readonly payload_revision: number | null;
  readonly attempt_count: number;
  readonly state: string;
  readonly next_retry_at: string | null;
  readonly last_error: string | null;
  readonly confirmed_at: string | null;
  readonly reconciliation_status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SampleLabelRow {
  readonly id: string;
  readonly sample_id: string | null;
  readonly stage: Stage | null;
}

export function useSyncHealth() {
  return useQuery({
    queryKey: ['admin', 'sync-health'],
    queryFn: async (): Promise<SyncHealth> => {
      const { data, error } = await db
        .from(TABLES.syncOutbox)
        .select(
          'event_id,sample_uuid,target_tab,payload_revision,attempt_count,state,next_retry_at,last_error,confirmed_at,reconciliation_status,created_at,updated_at',
        )
        .order('updated_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as SyncOutboxRow[];

      // Neither the sample ID nor the stage is on the outbox — both live on
      // `samples`, reached by `sample_uuid`. This screen exists to tell an
      // administrator WHICH record is missing from the workbook, and the table
      // renders a missing `sample_id` as "Not linked to a sample", so dropping
      // the lookup would not blank the column, it would make it lie.
      const uuids = [
        ...new Set(rows.map((r) => r.sample_uuid).filter((v): v is string => v !== null)),
      ];
      const identified = new Map<string, SampleLabelRow>();
      for (const batch of batches(uuids)) {
        const res = await db.from(TABLES.samples).select('id,sample_id,stage').in('id', batch);
        if (res.error) throw new Error(res.error.message);
        for (const sample of (res.data ?? []) as SampleLabelRow[]) {
          identified.set(sample.id, sample);
        }
      }

      const jobs: SyncJobRow[] = rows.map((r) => {
        const sample = r.sample_uuid === null ? undefined : identified.get(r.sample_uuid);
        return {
          id: r.event_id,
          sample_uuid: r.sample_uuid,
          sample_id: sample?.sample_id ?? null,
          stage: sample?.stage ?? null,
          intended_tab: r.target_tab,
          payload_revision: r.payload_revision,
          attempt_count: r.attempt_count,
          state: r.state,
          next_retry_at: r.next_retry_at,
          last_error: r.last_error,
          last_confirmed_at: r.confirmed_at,
          reconciliation_status: r.reconciliation_status,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      });
      const counts: Record<string, number> = {};
      for (const j of jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;

      return {
        jobs,
        counts,
        needsAttention: jobs.filter((j) => j.state === 'failed' || j.state === 'dead_letter'),
      };
    },
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Audit dead letters
//
// A failed audit write is caught deliberately in
// `_shared/adapters/authorize.ts`: a denial must not become a 500 just because
// the event could not be recorded. But a swallowed error with no consumer is
// indistinguishable from no error at all, and FR-002's acceptance criterion is
// that an unauthorised attempt receives a denial AND a logged event. The
// database now keeps the whole original event in `audit_event_dead_letters`
// rather than a counter, so the trail can be replayed once the cause is fixed.
//
// This hook is the human end of that path. Without it the rows accumulate
// where only a database query would find them, which is the same invisibility
// the dead-letter table was created to remove.
// ---------------------------------------------------------------------------

export interface AuditDeadLetterRow {
  readonly id: string;
  readonly received_at: string;
  readonly action: string;
  readonly subject_type: string;
  readonly subject_id: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  /** 'rpc_error' = the database refused; 'threw' = it was never reached. */
  readonly failure_stage: string;
  readonly failure_detail: string;
  readonly state: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly replayed_at: string | null;
}

export interface AuditDeadLetters {
  readonly rows: readonly AuditDeadLetterRow[];
  /** Still unrecovered. These are the ones that mean the trail has a gap. */
  readonly held: readonly AuditDeadLetterRow[];
  readonly oldestHeldAt: string | null;
}

export function useAuditDeadLetters() {
  return useQuery({
    queryKey: ['admin', 'audit-dead-letters'],
    queryFn: async (): Promise<AuditDeadLetters> => {
      const { data, error } = await db
        .from(TABLES.auditDeadLetters)
        .select(
          'id,received_at,action,subject_type,subject_id,outcome,reason,failure_stage,failure_detail,state,attempts,last_error,replayed_at',
        )
        .order('received_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as AuditDeadLetterRow[];
      const held = rows.filter((r) => r.state === 'held');
      // Ascending by received_at, so the last held row in a descending list is
      // the oldest one still outstanding.
      const oldestHeldAt = held.length > 0 ? held[held.length - 1]!.received_at : null;
      return { rows, held, oldestHeldAt };
    },
    staleTime: 10_000,
  });
}

export function useSyncRetry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { jobId: string }): Promise<AdminActionResult> => {
      const { data, error } = await db.functions.invoke(FUNCTIONS.syncAction, {
        body: { action: 'retry', jobId: input.jobId },
      });
      if (error) throw new Error(error.message);
      const result = data as AdminActionResult | null;
      if (!result) throw new Error('The server returned no result. The job was not retried.');
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'sync-health'] });
      void client.invalidateQueries({ queryKey: ['samples'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

/** One tab's row-4 header check, as reported by the sync worker. */
export interface TabVerification {
  readonly stage: Stage;
  readonly sheetTab: string;
  readonly ok: boolean;
  readonly checkedAt: string | null;
  readonly mismatches: readonly HeaderMismatch[];
  readonly error: string | null;
}

export interface SchemaVerificationReport {
  readonly spreadsheetConfigured: boolean;
  readonly checkedAt: string | null;
  readonly tabs: readonly TabVerification[];
}

/**
 * Ask the privileged worker to compare the live row-4 headers against the
 * registry contract.
 *
 * The browser cannot do this itself: it holds no Google credential, by design.
 * When the worker is unreachable the panel still shows the EXPECTED contract
 * from the registry and says plainly that the live headers were not read —
 * never that they matched.
 */
export function useSchemaVerification() {
  return useQuery({
    queryKey: ['admin', 'schema-verification'],
    queryFn: async (): Promise<SchemaVerificationReport> => {
      const { data, error } = await db.functions.invoke(FUNCTIONS.schemaVerify, {
        body: { action: 'verify_headers' },
      });
      if (error) throw new Error(error.message);
      const report = data as SchemaVerificationReport | null;
      if (!report) throw new Error('The verification service returned no result.');
      return report;
    },
    // A header check costs a Sheets API call; do not poll it.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The contract the app will enforce, available with no network at all. */
export function expectedHeaderContract(): readonly {
  stage: Stage;
  sheetTab: string;
  columnCount: number;
  headers: readonly string[];
}[] {
  return DASHBOARD_ORDER.map((schema) => ({
    stage: schema.stage,
    sheetTab: schema.sheetTab,
    columnCount: schema.columnCount,
    headers: expectedHeaders(schema.stage),
  }));
}

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

export interface AuditQuery {
  readonly actor: string;
  readonly action: string;
  /** Plant-local dates, inclusive. */
  readonly fromDate: string;
  readonly toDate: string;
}

export const EMPTY_AUDIT_QUERY: AuditQuery = { actor: '', action: '', fromDate: '', toDate: '' };

interface AuditEventDbRow {
  readonly event_uuid: string;
  readonly sample_uuid: string | null;
  readonly actor_id: string | null;
  readonly actor_email: string | null;
  readonly action: string;
  readonly reason: string | null;
  readonly before_payload: unknown;
  readonly after_payload: unknown;
  readonly occurred_at: string;
  readonly deployment_version: string | null;
}

export function useAuditEvents(query: AuditQuery, page: number, pageSize = 50) {
  return useQuery({
    queryKey: ['admin', 'audit', query, page],
    queryFn: async (): Promise<{ rows: readonly AuditEventRow[]; total: number }> => {
      let q = db
        .from(TABLES.auditEvents)
        .select(
          'event_uuid,sample_uuid,actor_id,actor_email,action,reason,before_payload,after_payload,occurred_at,deployment_version',
          { count: 'exact' },
        )
        .order('occurred_at', { ascending: false });

      const actor = query.actor.replace(/[,()*%\\]/g, ' ').trim();
      // The person filter searches the email, the only text identity the table
      // records. A search for a surname still matches most addresses, but a
      // display name that differs from the address will not be found here.
      if (actor) q = q.ilike('actor_email', `%${actor}%`);
      if (query.action) q = q.eq('action', query.action);
      // The filter dates are plant-local calendar days, but `occurred_at` is a
      // UTC instant, so the day is converted to its instant bounds. Comparing
      // a Guyana date against a UTC timestamp directly would shift every
      // boundary by four hours.
      if (query.fromDate) q = q.gte('occurred_at', plantDayStart(query.fromDate).toISOString());
      if (query.toDate) q = q.lt('occurred_at', plantDayEnd(query.toDate).toISOString());

      const from = page * pageSize;
      const { data, error, count } = await q.range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);

      const rows: AuditEventRow[] = ((data ?? []) as AuditEventDbRow[]).map((r) => ({
        id: r.event_uuid,
        sample_uuid: r.sample_uuid,
        actor_id: r.actor_id,
        // There is no actor_name column: the table keeps `actor_id` and
        // `actor_email`. The timeline prints this field as the person, and
        // renders null as "Actor not recorded" — which would be false, since
        // the actor IS recorded. So it carries the email, never a name built
        // from one.
        actor_name: r.actor_email,
        action: r.action,
        reason: r.reason,
        prior_values: r.before_payload,
        new_values: r.after_payload,
        occurred_at: r.occurred_at,
        app_version: r.deployment_version,
      }));
      return { rows, total: count ?? 0 };
    },
    staleTime: 10_000,
  });
}
