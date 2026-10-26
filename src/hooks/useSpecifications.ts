/**
 * Specification rules: the versioned, approved ruleset and the unapproved
 * workbook reference entries, kept strictly apart.
 *
 * The `Limits` tab's 34 entries are imported as `reference_only` with no
 * approver, so none of them can decide conformity. Turning one into a rule is
 * a proposal a person writes and a DIFFERENT person approves — never a copy
 * of the reference numbers (Master Prompt §6, PRD §7.1, risk R-01).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Stage } from '@/forms/types';
import { assessableFields, getSchema } from '@/forms/registry';
import { isUnitConfirmed } from '@/lib/assessment';
import { checkSeparationOfDuties, type SeparationFailure } from '@/lib/roles';
import { newIdempotencyKey } from '@/hooks/useRegisterSample';
import {
  FUNCTIONS,
  SPECIFICATION_VERSION_COLUMNS,
  TABLES,
  toSpecificationVersionRow,
  type SpecificationVersionDbRow,
  type SpecificationVersionRow,
} from '@/hooks/useSamples';

const db = supabase as unknown as SupabaseClient;

/**
 * PostgREST carries an `in` filter in the query string, so one unbounded list
 * of uuids can outgrow a proxy's request-line limit. The profile lookup below
 * resolves in batches for that reason, not for database cost. Same constant
 * and same reason as `useAdmin.ts`; it is not exported from there.
 */
const ID_BATCH = 100;

function batches<T>(values: readonly T[], size = ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

/**
 * One profile row, reduced to what it takes to name the person.
 *
 * Both name columns are typed nullable even though `profiles.display_name` and
 * `profiles.email` are NOT NULL in the schema: this models what a PostgREST
 * response can hand back, not what the table guarantees, and `personName`
 * below treats a missing value as "names nobody" rather than printing blank.
 */
interface ProfileNameRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly email: string | null;
}

/**
 * The name to print for one profile row, or null if the row names nobody.
 *
 * `display_name` is the intended answer. The email fallback is a guard, not an
 * observed case: `profiles.display_name` is NOT NULL and carries
 * CHECK (length(btrim(display_name)) > 0), so the live schema cannot produce a
 * profile row whose display name is missing or blank. The branch exists so a
 * future relaxation of either constraint degrades to the email instead of
 * printing an empty cell, and it is recorded here as unexercised so nobody
 * reads the fallback as evidence that blank display names occur.
 */
function personName(person: ProfileNameRow | undefined): string | null {
  if (person === undefined) return null;
  const display = person.display_name?.trim();
  if (display !== undefined && display !== '') return display;
  const email = person.email?.trim();
  if (email !== undefined && email !== '') return email;
  return null;
}

/**
 * Resolve `proposed_by` / `approved_by` uuids to the people they identify.
 *
 * One keyed read per screen load (batched only against the request-line
 * limit), never one per row, and no read at all when no row names anybody —
 * the 34 `reference_only` workbook entries have neither column set, because
 * CHECK `specification_versions_reference_only_unapproved` forbids it.
 */
async function resolvePeople(
  rows: readonly SpecificationVersionDbRow[],
): Promise<Map<string, ProfileNameRow>> {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.proposed_by, r.approved_by])
        .filter((v): v is string => v !== null),
    ),
  ];
  const people = new Map<string, ProfileNameRow>();
  for (const batch of batches(ids)) {
    // A real second keyed read with a LITERAL select list, deliberately NOT a
    // PostgREST embedded resource (`profiles(display_name)`). An embed would
    // fetch the same names in one request, but `scripts/check-frontend-schema.py`
    // skips any select entry containing a parenthesis, so the embed form would
    // make these columns INVISIBLE to the schema gate instead of verified by
    // it — the gate would go green by checking less. This form is more verbose
    // and is the one the gate can read; do not "simplify" it into an embed.
    // Same shape and same reasoning as `useAdminDelegations` in useAdmin.ts.
    const res = await db
      .from(TABLES.profiles)
      .select('id,display_name,email')
      .in('id', batch);
    if (res.error) throw new Error(res.error.message);
    for (const person of (res.data ?? []) as ProfileNameRow[]) {
      people.set(person.id, person);
    }
  }
  return people;
}

/**
 * The four status strings the live `Limits` tab actually contains. None of them
 * is an approval. The fourth was found only in the 2026-10-24 read and is not
 * in the PRD.
 */
export const WORKBOOK_STATUS_NOTES: Record<string, string> = {
  'To set': 'No limit has been set yet.',
  Set: 'A vendor reference value from the Polinutri visit of 23 October 2026. Not a Bounty Farm approval.',
  'Confirm with Polinutri': 'Awaiting confirmation from Polinutri. Cannot drive a release decision.',
  'To set with Polinutri':
    'An observed range recorded during a specialist visit, with no bounds entered. Not a limit.',
};

export interface SpecificationSet {
  /** Rules that live in the approval workflow: draft/proposed/approved/... */
  readonly rules: readonly SpecificationVersionRow[];
  /** The imported workbook entries. Reference only, never assessable. */
  readonly reference: readonly SpecificationVersionRow[];
  readonly approvedCount: number;
}

export async function fetchSpecifications(): Promise<SpecificationSet> {
  const { data, error } = await db
    .from(TABLES.specificationVersions)
    .select(SPECIFICATION_VERSION_COLUMNS)
    .order('stage', { ascending: true })
    .order('workbook_entry_no', { ascending: true, nullsFirst: false })
    .order('parameter_key', { ascending: true })
    .order('version', { ascending: false });
  if (error) throw new Error(error.message);

  const dbRows = (data ?? []) as SpecificationVersionDbRow[];

  // Who proposed a limit and who approved it are the two names risk R-01 is
  // about, so this screen resolves them instead of printing 36 hex characters.
  // `specification_versions` stores only the uuids; the names come from a
  // second keyed read of `profiles`.
  //
  // THE NAME IS RESOLVED AT READ TIME, NOT RECORDED ON THE SPECIFICATION.
  // The quality record holds the profile id and nothing else, so if a person
  // is later renamed, every historical version will display the NEW name
  // against the OLD decision. That is a real property of this design, not an
  // oversight: the id is the stable identifier and the name is a current
  // lookup of it. A record that had to show the name as it stood on the
  // approval date would need the name stored on the version row at approval,
  // which the schema does not do.
  const people = await resolvePeople(dbRows);

  // Mapped, not cast. Seven of this screen's field names are not column names
  // — see `toSpecificationVersionRow` — and the cast that used to stand here
  // is what let the divergence survive a clean typecheck: `as` asserts the
  // shape rather than producing it, so TypeScript had nothing to disagree
  // with and every field the database does not store arrived `undefined`.
  //
  // `toSpecificationVersionRow` is left exactly as it is — it is also called
  // by `useSampleDetail`, bare, as `.map(toSpecificationVersionRow)` — and the
  // two name fields it nulls are filled here instead. NULL survives wherever
  // no profile row answers, so `SpecificationsPage`'s own `?? proposed_by`
  // fallback stays live and shows the traceable uuid rather than a plausible
  // name that is not in the database.
  const rows = dbRows.map((row) => ({
    ...toSpecificationVersionRow(row),
    proposed_by_name: row.proposed_by === null ? null : personName(people.get(row.proposed_by)),
    approved_by_name: row.approved_by === null ? null : personName(people.get(row.approved_by)),
  }));
  const reference = rows.filter((r) => r.status === 'reference_only');
  const rules = rows.filter((r) => r.status !== 'reference_only');

  return {
    rules,
    reference,
    approvedCount: rules.filter((r) => r.status === 'approved' && r.approved_by !== null).length,
  };
}

export function useSpecifications() {
  return useQuery({
    queryKey: ['specifications'],
    queryFn: fetchSpecifications,
    staleTime: 30_000,
  });
}

/** Only parameters that exist in the form registry can carry a rule. */
export interface ParameterOption {
  readonly parameterKey: string;
  readonly stage: Stage;
  readonly label: string;
  readonly unit: string | null;
  readonly unitConfirmed: boolean;
  readonly section: string;
}

export function parameterOptions(stage: Stage): readonly ParameterOption[] {
  return assessableFields(stage).map((f) => ({
    parameterKey: f.parameterKey as string,
    stage,
    label: f.label,
    unit: f.unit ?? null,
    unitConfirmed: f.unitConfirmed !== false && isUnitConfirmed(f.unit ?? null),
    section: f.section,
  }));
}

export interface SpecificationProposal {
  readonly parameterKey: string;
  readonly stage: Stage;
  readonly material: string | null;
  readonly feedType: string | null;
  readonly samplingPoint: string | null;
  readonly testMethod: string | null;
  readonly unit: string | null;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  /** Plant-local date the rule takes effect from. Prospective only. */
  readonly effectiveFrom: string;
  readonly reason: string;
  readonly sourceEvidence: string;
  /**
   * Set when the proposal was started from a workbook reference entry. The
   * entry number is recorded as provenance; its numbers are NOT copied.
   */
  readonly promotedFromWorkbookEntryNo?: number;
}

export type SpecificationDecision = 'submit_review' | 'approve' | 'reject';

export interface SpecificationActionInput {
  readonly action: 'propose' | SpecificationDecision;
  readonly specificationVersionId?: string;
  readonly proposal?: SpecificationProposal;
  readonly reason?: string;
  /**
   * The key the server replays a retry under.
   *
   * NOT OPTIONAL ON THE WIRE, only in this type. `runMutation` resolves
   * `ctx.idempotencyKey ?? body['idempotencyKey'] ?? body['idempotency_key']`
   * and refuses the request with `bad_request` if none of the three is a valid
   * key — BEFORE `authenticate()`, before the permission check and before the
   * handler. This hook sent none, so every proposal, submission, approval and
   * rejection it posted was refused at that first line. The consequence is not
   * "a replay could approve a limit twice": it is that no specification limit
   * could be proposed or approved through this screen at all.
   *
   * Generated per call when the caller supplies none. A caller that must retry
   * THE SAME act passes its own key, so the second request replays the first
   * outcome instead of recording a second decision (PRD §10.3) — which matters
   * more here than anywhere: an approval is a quality decision with a named
   * approver, and two of them are two records.
   */
  readonly idempotencyKey?: string;
}

export interface SpecificationActionResult {
  readonly ok: boolean;
  readonly specificationVersionId: string | null;
  readonly message: string;
}

export function useSpecificationAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SpecificationActionInput): Promise<SpecificationActionResult> => {
      // Generated here rather than in the component, so no call site can omit
      // it. `newIdempotencyKey` throws where the browser has no secure random
      // source; inside the mutation function that becomes a reported failure
      // naming the cause rather than a throw out of a click handler.
      const { idempotencyKey, ...rest } = input;
      const key = idempotencyKey ?? newIdempotencyKey();
      const { data, error } = await db.functions.invoke(FUNCTIONS.specificationAction, {
        // Header first, body as the documented fallback for a proxy that
        // strips custom headers. `NON_PAYLOAD_KEYS` excludes `idempotencyKey`
        // from the payload hash, so sending both cannot manufacture a
        // conflict.
        body: { ...rest, idempotencyKey: key },
        headers: { 'Idempotency-Key': key },
      });
      if (error) throw new Error(error.message);
      const result = data as SpecificationActionResult | null;
      if (!result) throw new Error('The server returned no result. Nothing was changed.');
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['specifications'] });
      // An approved rule changes future assessments, so detail views must
      // not keep showing a cached evaluation as current.
      void client.invalidateQueries({ queryKey: ['sample'] });
    },
  });
}

export interface ApprovalBlock {
  readonly blocked: boolean;
  readonly failure: SeparationFailure | null;
  readonly message: string | null;
}

/**
 * Can this actor approve this proposal?
 *
 * Separation of duties is enforced by the server too; this exists so the UI can
 * say WHY the button is unavailable instead of silently disabling it.
 */
export function approvalBlock(
  rule: SpecificationVersionRow,
  actorId: string | null,
): ApprovalBlock {
  if (actorId === null) {
    return { blocked: true, failure: null, message: 'Sign in to review a specification.' };
  }

  const failure = checkSeparationOfDuties({
    action: 'approve_specification',
    actorId,
    subjectActorId: rule.proposed_by,
  });

  if (failure === null) return { blocked: false, failure: null, message: null };

  return {
    blocked: true,
    failure,
    message:
      'You proposed this rule, so you cannot approve it. A limit change needs a different approver (PRD §7.3). Ask another Quality Supervisor to review it.',
  };
}

/**
 * A rule with no confirmed unit can never drive an assessment, whatever its
 * bounds say. Workbook entry 13 is exactly this case: its unit cell contains
 * the literal text "to confirm".
 */
export function unitWarning(rule: SpecificationVersionRow): string | null {
  if (isUnitConfirmed(rule.unit)) return null;
  return `The unit is recorded as ${
    rule.unit === null || rule.unit.trim() === '' ? 'blank' : `"${rule.unit}"`
  }, which names no measurable quantity. This entry can never decide conformity until a unit is approved.`;
}

export function stageLabel(stage: Stage): string {
  const schema = getSchema(stage);
  return `${schema.ordinal}. ${schema.title}`;
}
