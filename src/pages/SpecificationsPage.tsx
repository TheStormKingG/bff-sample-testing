/**
 * Approved limits — the specification ruleset, and the unapproved workbook
 * entries kept visibly apart from it.
 *
 * ===========================================================================
 * WHY THIS SCREEN IS MOSTLY A SET OF WARNINGS
 * ===========================================================================
 *
 * The live workbook's `Limits` tab holds 34 working entries and NONE of them
 * is an approval: 27 read "To set", 4 read "Set" (vendor reference values from
 * the Polinutri visit of 23 October 2026), 2 read "Confirm with Polinutri" and
 * 1 reads "To set with Polinutri" — a fourth status that is not in the PRD and
 * was found only in the 2026-10-24 read (docs/workbook-verification.md §5,
 * findings 2 and 3).
 *
 * The dangerous entries are the four marked "Set", because they carry real
 * numbers and therefore LOOK like limits. PRD §7.2 is explicit: they "remain
 * reference values until separately approved in the application". So this
 * screen never lets a reference entry become a rule by copying it. Promotion
 * opens the ordinary proposal form, with the entry number recorded as
 * provenance and every field blank — the proposer types the numbers, states a
 * reason and a source, and a DIFFERENT Quality Supervisor approves them
 * (PRD §7.3, Master Prompt §6, risk R-01).
 *
 * Consequence, stated on the page rather than left for somebody to discover:
 * while nothing is approved, every numeric measurement assesses as
 * "Not assessable" (FR-009, UAT-05). That is the system working correctly.
 *
 * Separation of duties is checked here so the screen can say WHY an approval
 * is unavailable. The control is the Edge Function, which checks it again
 * (Master Prompt §1: hiding a button is not a control).
 * ===========================================================================
 */

import { useMemo, useState } from 'react';
import {
  Archive,
  BookOpen,
  CheckCircle2,
  FileEdit,
  Gauge,
  Lock,
  Plus,
  Send,
  ShieldAlert,
  XCircle,
} from 'lucide-react';

import type { Stage } from '@/forms/types';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { describeBounds } from '@/lib/assessment';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import type { SpecificationVersionRow } from '@/hooks/useSamples';
import { useAuthority } from '@/hooks/useSamples';
import {
  WORKBOOK_STATUS_NOTES,
  approvalBlock,
  stageLabel,
  unitWarning,
  useSpecificationAction,
  useSpecifications,
  type SpecificationDecision,
  type SpecificationProposal,
} from '@/hooks/useSpecifications';
import { StatusChip, type Tone } from '@/components/ui';
import { ReasonDialog } from '@/components/form/ReasonDialog';
import {
  Button,
  Card,
  DetailRow,
  EmptyState,
  ErrorNotice,
  InfoNote,
  LoadingBlock,
  NotPermitted,
  PageHeader,
} from '@/components/records/common';
import { SpecApprovalForm } from '@/components/records/SpecApprovalForm';

/**
 * The number of `Limits` entries confirmed present in the live workbook on
 * 2026-10-24. It is a verified COUNT of imported reference rows, not an
 * acceptance limit — nothing here is ever compared against a measurement.
 * It exists so that a partial or duplicated import is visible on the screen
 * rather than silently believed.
 */
const VERIFIED_REFERENCE_ENTRY_COUNT = 34;

/** Workbook statuses, ordered so the ones carrying numbers come first. */
const WORKBOOK_STATUS_ORDER: readonly string[] = [
  'Set',
  'Confirm with Polinutri',
  'To set with Polinutri',
  'To set',
];

const WORKBOOK_STATUS_TONE: Record<string, Tone> = {
  Set: 'warning',
  'Confirm with Polinutri': 'warning',
  'To set with Polinutri': 'warning',
  'To set': 'neutral',
};

/**
 * Why each group needs its own treatment. The entries that read "To set" are
 * harmless — they are visibly empty. The other three carry numbers or an
 * observed range and are the ones somebody could mistake for an approval.
 */
const WORKBOOK_STATUS_EXPLANATION: Record<string, string> = {
  Set: 'These entries carry numbers, which makes them the easiest to mistake for limits. They are vendor reference values recorded during the Polinutri visit of 23 October 2026 and were never approved by Bounty Farm. They cannot decide conformity and cannot release material.',
  'Confirm with Polinutri':
    'These entries have bounds written down but are explicitly awaiting confirmation from Polinutri. PRD §7.2 forbids them driving a release decision.',
  'To set with Polinutri':
    'An observed range noted during a specialist visit, with no bounds entered in the workbook at all. It records what was seen, not what is allowed.',
  'To set': 'No limit has been written down yet. There is nothing here to approve.',
};

const RULE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  proposed: 'Proposed, awaiting approval',
  approved: 'Approved and in force',
  rejected: 'Rejected',
  superseded: 'Superseded by a later version',
  reference_only: 'Reference only — not an approved limit',
};

const RULE_STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  proposed: 'info',
  approved: 'success',
  rejected: 'danger',
  superseded: 'neutral',
  reference_only: 'warning',
};

const RULE_STATUS_ICON = {
  draft: FileEdit,
  proposed: Send,
  approved: CheckCircle2,
  rejected: XCircle,
  superseded: Archive,
  reference_only: BookOpen,
} as const;

function ruleStatusIcon(status: string) {
  return status in RULE_STATUS_ICON
    ? RULE_STATUS_ICON[status as keyof typeof RULE_STATUS_ICON]
    : BookOpen;
}

function RuleStatusChip({ status }: { status: string }) {
  return (
    <StatusChip
      label={RULE_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')}
      tone={RULE_STATUS_TONE[status] ?? 'neutral'}
      icon={ruleStatusIcon(status)}
      srPrefix="Specification status:"
    />
  );
}

/** Applicability, in the plant's own words. Blank means "any". */
function applicabilityText(rule: SpecificationVersionRow): string {
  const parts: string[] = [];
  if (rule.material !== null && rule.material !== '') parts.push(`material ${rule.material}`);
  if (rule.feed_type !== null && rule.feed_type !== '') parts.push(`feed type ${rule.feed_type}`);
  if (rule.sampling_point !== null && rule.sampling_point !== '') {
    parts.push(`sampling point ${rule.sampling_point}`);
  }
  if (rule.test_method !== null && rule.test_method !== '') {
    parts.push(`method ${rule.test_method}`);
  }
  return parts.length === 0 ? 'Any material, feed type, sampling point and method' : parts.join(', ');
}

function boundsText(rule: SpecificationVersionRow): string {
  return describeBounds({
    lowerBound: rule.lower_bound,
    upperBound: rule.upper_bound,
    unit: rule.unit,
  });
}

function instant(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatPlantDateTimeLabelled(parsed);
}

// ---------------------------------------------------------------------------
// A rule in the approval workflow
// ---------------------------------------------------------------------------

interface DecisionRequest {
  readonly rule: SpecificationVersionRow;
  readonly decision: SpecificationDecision;
}

function RuleCard({
  rule,
  actorId,
  canPropose,
  canApprove,
  onDecide,
}: {
  rule: SpecificationVersionRow;
  actorId: string | null;
  canPropose: boolean;
  canApprove: boolean;
  onDecide: (request: DecisionRequest) => void;
}) {
  const block = approvalBlock(rule, actorId);
  const unitProblem = unitWarning(rule);
  const isProposer = actorId !== null && rule.proposed_by === actorId;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{rule.test_label ?? rule.parameter_key}</h3>
          <p className="text-sm text-slate-600">
            {stageLabel(rule.stage)}
            {rule.sample_label !== null && rule.sample_label !== ''
              ? ` · ${rule.sample_label}`
              : ''}{' '}
            · version {rule.version}
          </p>
        </div>
        <RuleStatusChip status={rule.status} />
      </div>

      {unitProblem !== null ? (
        <div className="mt-3">
          <InfoNote tone="warning">{unitProblem}</InfoNote>
        </div>
      ) : null}

      <dl className="mt-3">
        <DetailRow label="Limits">
          <span className="font-semibold tabular-nums">{boundsText(rule)}</span>
        </DetailRow>
        <DetailRow label="Unit">
          {rule.unit === null || rule.unit.trim() === '' ? (
            <span className="text-slate-600">Not recorded</span>
          ) : (
            // Rendered verbatim. Workbook entry 13's unit cell literally
            // contains the words "to confirm", and rewording it would hide
            // the problem the words are reporting.
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm">{rule.unit}</code>
          )}
        </DetailRow>
        <DetailRow label="Applies to">{applicabilityText(rule)}</DetailRow>
        <DetailRow label="In force">
          {rule.effective_from} (Guyana date)
          {rule.effective_to !== null ? ` until ${rule.effective_to}` : ' onwards'}
        </DetailRow>
        <DetailRow label="Proposed by">
          {rule.proposed_by_name ?? rule.proposed_by ?? 'Not recorded'}
        </DetailRow>
        <DetailRow label="Approved by">
          {rule.approved_by === null ? (
            <span className="font-medium text-amber-900">
              Nobody. This rule cannot decide conformity.
            </span>
          ) : (
            <>
              {rule.approved_by_name ?? rule.approved_by} · {instant(rule.approved_at)}
            </>
          )}
        </DetailRow>
        {rule.source_note !== null && rule.source_note !== '' ? (
          <DetailRow label="Source or evidence">{rule.source_note}</DetailRow>
        ) : null}
        {rule.workbook_entry_no !== null ? (
          <DetailRow label="Started from">
            Workbook reference entry #{rule.workbook_entry_no}. Its numbers were not copied — the
            values above were entered deliberately.
          </DetailRow>
        ) : null}
      </dl>

      {rule.status === 'draft' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canPropose && isProposer ? (
            <Button variant="primary" onClick={() => onDecide({ rule, decision: 'submit_review' })}>
              <Send aria-hidden className="h-4 w-4" />
              Submit for approval
            </Button>
          ) : (
            <NotPermitted
              reason={
                canPropose
                  ? 'Only the person who wrote this draft can submit it for approval.'
                  : 'Submitting a limit change for approval needs the propose-specification permission.'
              }
            />
          )}
        </div>
      ) : null}

      {rule.status === 'proposed' ? (
        <div className="mt-3 flex flex-col gap-2">
          {!canApprove ? (
            <NotPermitted reason="Approving or rejecting a limit is a Quality Supervisor decision. You can see the proposal but not decide it." />
          ) : block.blocked ? (
            <p
              role="note"
              className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            >
              <Lock aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{block.message}</span>
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => onDecide({ rule, decision: 'approve' })}>
                <CheckCircle2 aria-hidden className="h-4 w-4" />
                Approve this limit
              </Button>
              <Button variant="danger" onClick={() => onDecide({ rule, decision: 'reject' })}>
                <XCircle aria-hidden className="h-4 w-4" />
                Reject this proposal
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// A workbook reference entry
// ---------------------------------------------------------------------------

function ReferenceEntry({
  entry,
  canPropose,
  onPromote,
}: {
  entry: SpecificationVersionRow;
  canPropose: boolean;
  onPromote: (entry: SpecificationVersionRow) => void;
}) {
  const unitProblem = unitWarning(entry);
  const hasNumbers = entry.lower_bound !== null || entry.upper_bound !== null;

  return (
    <li className="border-b border-slate-100 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900">
            {entry.workbook_entry_no !== null ? (
              <span className="mr-2 font-mono text-sm text-slate-500">
                #{entry.workbook_entry_no}
              </span>
            ) : null}
            {entry.test_label ?? entry.parameter_key}
          </p>
          <p className="text-sm text-slate-600">
            {stageLabel(entry.stage)}
            {entry.sample_label !== null && entry.sample_label !== ''
              ? ` · ${entry.sample_label}`
              : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusChip
            label="Reference only — not an approved limit"
            tone="warning"
            icon={BookOpen}
            size="sm"
            srPrefix="Specification status:"
          />
          {entry.workbook_status !== null ? (
            <StatusChip
              label={`Workbook status: ${entry.workbook_status}`}
              tone={WORKBOOK_STATUS_TONE[entry.workbook_status] ?? 'neutral'}
              size="sm"
            />
          ) : null}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <p className="text-slate-800">
          <span className="text-slate-600">Values in the workbook: </span>
          {hasNumbers ? (
            <span className="font-semibold tabular-nums">{boundsText(entry)}</span>
          ) : (
            <span className="text-slate-600">no numbers entered</span>
          )}
        </p>
        <p className="text-slate-800">
          <span className="text-slate-600">Unit as written: </span>
          {entry.unit === null || entry.unit.trim() === '' ? (
            <span className="text-slate-600">blank</span>
          ) : (
            <code className="rounded bg-slate-100 px-1.5 py-0.5">{entry.unit}</code>
          )}
        </p>
        {entry.source_note !== null && entry.source_note !== '' ? (
          <p className="text-slate-700 sm:col-span-2">
            <span className="text-slate-600">Note: </span>
            {entry.source_note}
          </p>
        ) : null}
      </div>

      {unitProblem !== null ? (
        <div className="mt-2">
          <InfoNote tone="warning">{unitProblem}</InfoNote>
        </div>
      ) : null}

      <div className="mt-2">
        {canPropose ? (
          <Button onClick={() => onPromote(entry)}>
            <Plus aria-hidden className="h-4 w-4" />
            Write a new rule starting from this entry
          </Button>
        ) : (
          <p className="text-sm text-slate-600">
            Turning this into an approved limit is a Quality Supervisor action.
          </p>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Composer =
  | { readonly open: false }
  | {
      readonly open: true;
      readonly stage: Stage;
      readonly workbookEntryNo?: number;
      readonly referenceNote?: string;
    };

export default function SpecificationsPage() {
  const { user, allows } = useAuthority();
  const specs = useSpecifications();
  const action = useSpecificationAction();

  const [composer, setComposer] = useState<Composer>({ open: false });
  const [decision, setDecision] = useState<DecisionRequest | null>(null);
  /** A failed decision, kept with its reason so it can be retried as typed. */
  const [failed, setFailed] = useState<{
    request: DecisionRequest | { readonly proposal: SpecificationProposal };
    reason: string | null;
    message: string;
  } | null>(null);

  const canPropose = allows('spec.propose');
  const canApprove = allows('spec.approve');
  const firstStage = DASHBOARD_ORDER[0]?.stage;

  const grouped = useMemo(() => {
    const entries = specs.data?.reference ?? [];
    const known = new Map<string, SpecificationVersionRow[]>();
    const unknown: SpecificationVersionRow[] = [];
    for (const entry of entries) {
      const status = entry.workbook_status;
      if (status !== null && WORKBOOK_STATUS_ORDER.includes(status)) {
        const list = known.get(status);
        if (list) list.push(entry);
        else known.set(status, [entry]);
      } else {
        unknown.push(entry);
      }
    }
    return { known, unknown };
  }, [specs.data]);

  function openDecision(request: DecisionRequest) {
    setFailed(null);
    setDecision(request);
  }

  function submitDecision(request: DecisionRequest, reason: string) {
    setDecision(null);
    action.mutate(
      {
        action: request.decision,
        specificationVersionId: request.rule.id,
        reason,
      },
      {
        onSuccess: () => setFailed(null),
        onError: (error: unknown) =>
          setFailed({
            request,
            reason,
            message: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function submitProposal(proposal: SpecificationProposal) {
    action.mutate(
      { action: 'propose', proposal },
      {
        onSuccess: () => {
          setComposer({ open: false });
          setFailed(null);
        },
        onError: (error: unknown) =>
          setFailed({
            request: { proposal },
            reason: null,
            message: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  /**
   * Send a failed DECISION again with the reason already typed. A failed
   * proposal is retried from the form itself, which still holds its values.
   */
  function retryFailedDecision() {
    const pending = failed;
    if (pending === null) return;
    if ('rule' in pending.request && pending.reason !== null) {
      submitDecision(pending.request, pending.reason);
    }
  }

  const rules = specs.data?.rules ?? [];
  const reference = specs.data?.reference ?? [];
  const approvedCount = specs.data?.approvedCount ?? 0;
  const importMismatch =
    specs.data !== undefined && reference.length !== VERIFIED_REFERENCE_ENTRY_COUNT;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader
        title="Approved limits"
        description="The versioned specification rules that decide conformity, and the workbook entries that do not."
        actions={
          canPropose && firstStage !== undefined ? (
            <Button
              variant="primary"
              onClick={() => {
                setFailed(null);
                setComposer({ open: true, stage: firstStage });
              }}
            >
              <Plus aria-hidden className="h-4 w-4" />
              Propose a new limit
            </Button>
          ) : undefined
        }
      />

      {specs.isPending ? (
        <LoadingBlock label="Loading the specification ruleset" />
      ) : specs.isError ? (
        <ErrorNotice
          error={specs.error}
          what="The specification ruleset"
          onRetry={() => void specs.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {/* The headline fact, taken from the stored rows rather than asserted. */}
          <div
            role="region"
            aria-label="State of the approved ruleset"
            className={
              approvedCount === 0
                ? 'rounded-md border-2 border-amber-500 bg-amber-50 p-4'
                : 'rounded-md border border-emerald-300 bg-emerald-50 p-4'
            }
          >
            <p className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <ShieldAlert aria-hidden className="h-6 w-6" />
              {approvedCount === 0
                ? 'No limit is approved. Nothing can be assessed against a limit yet.'
                : `${approvedCount} approved limit${approvedCount === 1 ? '' : 's'} in force.`}
            </p>
            <p className="mt-1 text-base text-slate-800">
              {reference.length} workbook {reference.length === 1 ? 'entry' : 'entries'}{' '}
              {reference.length === 1 ? 'was' : 'were'} imported from the <code>Limits</code> tab
              for reference, and <strong>0 of {reference.length}</strong> is an approval — an
              imported entry carries no approver, so it can never decide conformity.
            </p>
            {approvedCount === 0 ? (
              <p className="mt-1 text-base font-medium text-slate-900">
                Every numeric measurement therefore assesses as <strong>Not assessable</strong>.
                That is the correct result, not a fault: a value cannot be called conforming
                against a limit nobody has approved (FR-009, UAT-05).
              </p>
            ) : null}
            {importMismatch ? (
              <p role="alert" className="mt-2 text-sm font-semibold text-red-900">
                The workbook verification of 24 October 2026 recorded{' '}
                {VERIFIED_REFERENCE_ENTRY_COUNT} entries on the <code>Limits</code> tab, but{' '}
                {reference.length} are loaded here. The import is incomplete or has been
                duplicated — check it before relying on this list.
              </p>
            ) : null}
          </div>

          {/* A failed PROPOSAL is reported inside the form, where the values
              still are. Only a failed decision needs the page-level banner. */}
          {failed !== null && !('proposal' in failed.request) ? (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4">
              <p className="text-base font-semibold text-red-900">
                The change was not saved: {failed.message}
              </p>
              <p className="mt-1 text-sm text-red-900">
                Nothing was changed. The ruleset is exactly as it was before.
                {failed.reason !== null
                  ? ' Your reason was kept, so you can send it again without retyping it.'
                  : ''}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {failed.reason !== null ? (
                  <Button onClick={retryFailedDecision} disabled={action.isPending}>
                    {action.isPending ? 'Sending…' : 'Try again'}
                  </Button>
                ) : null}
                <Button onClick={() => setFailed(null)}>Dismiss</Button>
              </div>
            </div>
          ) : null}

          {composer.open ? (
            <Card
              title="Propose a limit"
              description="A proposal changes no assessment. It has to be approved by a different Quality Supervisor before it can decide conformity."
            >
              <SpecApprovalForm
                initialStage={composer.stage}
                {...(composer.workbookEntryNo !== undefined
                  ? { promotedFromWorkbookEntryNo: composer.workbookEntryNo }
                  : {})}
                {...(composer.referenceNote !== undefined
                  ? { referenceNote: composer.referenceNote }
                  : {})}
                onCancel={() => setComposer({ open: false })}
                onSubmit={submitProposal}
                submitting={action.isPending}
                submitError={
                  failed !== null && 'proposal' in failed.request ? failed.message : null
                }
              />
            </Card>
          ) : null}

          {!canPropose && !canApprove ? (
            <NotPermitted reason="You can read the ruleset. Proposing and approving limits are Quality Supervisor actions, and an Administrator does not acquire them from a technical role (PRD §2)." />
          ) : null}

          <Card
            title="Specification rules"
            description="Rules inside the approval workflow. Only a rule that is approved AND has a recorded approver can decide conformity."
          >
            {rules.length === 0 ? (
              <EmptyState
                title="No specification rule has been written yet."
                hint="Propose one from a workbook reference entry below, or from scratch. Until a rule is approved, measurements assess as Not assessable."
              />
            ) : (
              <ul className="flex flex-col gap-4">
                {rules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    actorId={user.id}
                    canPropose={canPropose}
                    canApprove={canApprove}
                    onDecide={openDecision}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Workbook reference entries"
            description="Imported verbatim from the Limits tab so the plant can see what was written down. None of these is an approved limit, and none of them is keyed by its spreadsheet row — the Limits tab warns that its rows must not be moved, so a row number would be a fragile key."
          >
            {reference.length === 0 ? (
              <EmptyState
                title="No workbook entries have been imported."
                hint="The Limits tab's 34 entries are loaded as reference-only rows. An empty list here means the import has not run."
              />
            ) : (
              <div className="flex flex-col gap-5">
                {WORKBOOK_STATUS_ORDER.map((status) => {
                  const entries = grouped.known.get(status) ?? [];
                  if (entries.length === 0) return null;
                  return (
                    <section key={status}>
                      <h3 className="flex flex-wrap items-center gap-2 text-base font-bold text-slate-900">
                        <Gauge aria-hidden className="h-5 w-5" />
                        Workbook status &ldquo;{status}&rdquo;
                        <span className="font-normal text-slate-600">
                          ({entries.length} {entries.length === 1 ? 'entry' : 'entries'})
                        </span>
                      </h3>
                      <p className="mt-1 text-sm text-slate-700">
                        {WORKBOOK_STATUS_EXPLANATION[status] ??
                          WORKBOOK_STATUS_NOTES[status] ??
                          'This status does not map to an approval.'}
                      </p>
                      <ul
                        className={
                          status === 'To set'
                            ? 'mt-2 rounded-md border border-slate-200 px-3'
                            : 'mt-2 rounded-md border-2 border-amber-400 bg-amber-50/40 px-3'
                        }
                      >
                        {entries.map((entry) => (
                          <ReferenceEntry
                            key={entry.id}
                            entry={entry}
                            canPropose={canPropose}
                            onPromote={(row) => {
                              setFailed(null);
                              setComposer({
                                open: true,
                                stage: row.stage,
                                ...(row.workbook_entry_no !== null
                                  ? { workbookEntryNo: row.workbook_entry_no }
                                  : {}),
                                referenceNote: `Workbook entry #${row.workbook_entry_no ?? '—'} reads: ${
                                  row.test_label ?? row.parameter_key
                                }, unit "${row.unit ?? 'blank'}", ${boundsText(row)}, status "${
                                  row.workbook_status ?? 'not recorded'
                                }".`,
                              });
                            }}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}

                {grouped.unknown.length > 0 ? (
                  <section>
                    <h3 className="text-base font-bold text-red-900">
                      Entries with an unrecognised workbook status ({grouped.unknown.length})
                    </h3>
                    <p className="mt-1 text-sm text-red-900">
                      The workbook is known to contain four status values. These rows carry
                      something else, so the import has encountered a value nobody has reviewed.
                      They are shown rather than hidden, and they are still reference-only.
                    </p>
                    <ul className="mt-2 rounded-md border-2 border-red-400 bg-red-50/50 px-3">
                      {grouped.unknown.map((entry) => (
                        <ReferenceEntry
                          key={entry.id}
                          entry={entry}
                          canPropose={canPropose}
                          onPromote={(row) => {
                            setFailed(null);
                            setComposer({
                              open: true,
                              stage: row.stage,
                              ...(row.workbook_entry_no !== null
                                ? { workbookEntryNo: row.workbook_entry_no }
                                : {}),
                              referenceNote: `Workbook entry #${
                                row.workbook_entry_no ?? '—'
                              } carries the unrecognised status "${
                                row.workbook_status ?? 'none'
                              }".`,
                            });
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            )}
          </Card>
        </div>
      )}

      <ReasonDialog
        open={decision !== null}
        title={
          decision === null
            ? 'Record a reason'
            : decision.decision === 'approve'
              ? 'Approve this limit'
              : decision.decision === 'reject'
                ? 'Reject this proposal'
                : 'Submit this draft for approval'
        }
        prompt={
          decision === null
            ? ''
            : decision.decision === 'approve'
              ? 'This limit will decide whether feed conforms, from its effective date onwards. State the authority for approving it. The reason is recorded permanently and cannot be edited afterwards.'
              : decision.decision === 'reject'
                ? 'State why this proposed limit is not acceptable. The proposal and your reason are both kept.'
                : 'State what this draft is for. A different Quality Supervisor will decide it.'
        }
        confirmLabel={
          decision === null
            ? 'Confirm'
            : decision.decision === 'approve'
              ? 'Approve the limit'
              : decision.decision === 'reject'
                ? 'Reject the proposal'
                : 'Submit for approval'
        }
        busy={action.isPending}
        onConfirm={(reason) => {
          if (decision !== null) submitDecision(decision, reason);
        }}
        onCancel={() => setDecision(null)}
      />
    </div>
  );
}
