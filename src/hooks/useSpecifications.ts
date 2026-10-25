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

  // Mapped, not cast. Seven of this screen's field names are not column names
  // — see `toSpecificationVersionRow` — and the cast that used to stand here
  // is what let the divergence survive a clean typecheck: `as` asserts the
  // shape rather than producing it, so TypeScript had nothing to disagree
  // with and every field the database does not store arrived `undefined`.
  const rows = ((data ?? []) as SpecificationVersionDbRow[]).map(toSpecificationVersionRow);
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
      const { data, error } = await db.functions.invoke(FUNCTIONS.specificationAction, {
        body: input,
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
