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

/** Table of administrator-maintained vocabulary (materials, suppliers, ...). */
const CONTROLLED_VALUES_TABLE = 'controlled_values';

// ---------------------------------------------------------------------------
// Users, roles and delegations
// ---------------------------------------------------------------------------

export interface AdminUser {
  readonly id: string;
  readonly email: string | null;
  readonly full_name: string | null;
  readonly status: UserStatus;
  readonly created_at: string;
  readonly last_sign_in_at: string | null;
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
}

export async function fetchAdminUsers(): Promise<readonly AdminUser[]> {
  const [profileRes, roleRes] = await Promise.all([
    db
      .from(TABLES.profiles)
      .select('id,email,full_name,status,created_at,last_sign_in_at')
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

  return ((profileRes.data ?? []) as Omit<AdminUser, 'roles'>[]).map((p) => ({
    ...p,
    roles: roleMap.get(p.id) ?? [],
  }));
}

export function useAdminUsers() {
  return useQuery({ queryKey: ['admin', 'users'], queryFn: fetchAdminUsers, staleTime: 15_000 });
}

export function useAdminDelegations() {
  return useQuery({
    queryKey: ['admin', 'delegations'],
    queryFn: async (): Promise<readonly AdminDelegation[]> => {
      const { data, error } = await db
        .from(TABLES.delegations)
        .select(
          'id,user_id,user_email,permission,granted_by,granted_by_name,effective_from,effective_to,reason',
        )
        .order('effective_from', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as AdminDelegation[];
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

export function useControlledValues() {
  return useQuery({
    queryKey: ['admin', 'controlled-values'],
    queryFn: async (): Promise<readonly ControlledValue[]> => {
      const { data, error } = await db
        .from(CONTROLLED_VALUES_TABLE)
        .select('id,list_key,value,label,active,sort_order')
        .order('list_key', { ascending: true })
        .order('sort_order', { ascending: true, nullsFirst: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ControlledValue[];
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

export function useSyncHealth() {
  return useQuery({
    queryKey: ['admin', 'sync-health'],
    queryFn: async (): Promise<SyncHealth> => {
      const { data, error } = await db
        .from(TABLES.syncOutbox)
        .select(
          'id,sample_uuid,sample_id,stage,intended_tab,payload_revision,attempt_count,state,next_retry_at,last_error,last_confirmed_at,reconciliation_status,created_at,updated_at',
        )
        .order('updated_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);

      const jobs = (data ?? []) as SyncJobRow[];
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

export function useAuditEvents(query: AuditQuery, page: number, pageSize = 50) {
  return useQuery({
    queryKey: ['admin', 'audit', query, page],
    queryFn: async (): Promise<{ rows: readonly AuditEventRow[]; total: number }> => {
      let q = db
        .from(TABLES.auditEvents)
        .select(
          'id,sample_uuid,actor_id,actor_name,action,reason,prior_values,new_values,occurred_at,app_version',
          { count: 'exact' },
        )
        .order('occurred_at', { ascending: false });

      const actor = query.actor.replace(/[,()*%\\]/g, ' ').trim();
      if (actor) q = q.ilike('actor_name', `%${actor}%`);
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
      return { rows: (data ?? []) as AuditEventRow[], total: count ?? 0 };
    },
    staleTime: 10_000,
  });
}
