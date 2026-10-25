/**
 * One sample, in full.
 *
 * Reading order is deliberate. A quality hold is drawn first and strongest,
 * because a hold overrides every permissive signal below it; a page that led
 * with a row of green "Within limit" chips on held material would mislead at a
 * glance (Master Prompt §5).
 *
 * Actions are gated by `can()` so the screen does not offer work the user
 * cannot do — but the gate is cosmetic. Every action posts to an Edge Function
 * that re-checks authority, and a server denial is shown in the server's own
 * words.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClipboardCopy, Copy, FlaskConical, Gavel, PauseCircle, Tag, X } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import { getSchema } from '@/forms/registry';
import { checkTransition, type Disposition } from '@/lib/workflow';
import { appVersion, stageTitle, useAuthority } from '@/hooks/useSamples';
import { useSampleAction, useSampleDetail, type SampleActionKind } from '@/hooks/useSampleDetail';
import {
  Button,
  Card,
  CaptureStateBadge,
  DetailRow,
  DispositionBadge,
  ErrorNotice,
  InfoNote,
  LoadingBlock,
  NotPermitted,
  LinkButton,
  PageHeader,
  SyncStatePill,
  INPUT_CLASS,
} from '@/components/records/common';
import { HoldBanner } from '@/components/records/HoldBanner';
import { MeasurementTable } from '@/components/records/MeasurementTable';
import { LinkedSamples } from '@/components/records/LinkedSamples';
import { AuditTimeline } from '@/components/records/AuditTimeline';
import { LabelDialog } from '@/components/records/LabelDialog';
import { DispositionDialog } from '@/components/records/DispositionDialog';

interface ReasonPrompt {
  readonly action: SampleActionKind;
  readonly title: string;
  readonly explanation: string;
  readonly reasonRequired: boolean;
  readonly submitLabel: string;
  readonly danger?: boolean;
}

function ReasonDialog({
  prompt,
  onClose,
  onSubmit,
  submitting,
  error,
  blockedMessage,
}: {
  prompt: ReasonPrompt;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
  error: unknown;
  /** A server-style denial computed before submitting, shown verbatim. */
  blockedMessage: string | null;
}) {
  const [reason, setReason] = useState('');
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  const canSubmit =
    blockedMessage === null && (!prompt.reasonRequired || reason.trim().length > 0) && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reason-dialog-title"
        className="my-6 w-full max-w-xl rounded-lg bg-white p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="reason-dialog-title" className="text-xl font-semibold text-slate-900">
            {prompt.title}
          </h2>
          <Button onClick={onClose} ariaLabel="Close without recording anything">
            <X aria-hidden className="h-4 w-4" />
            Close
          </Button>
        </div>

        <p className="mt-2 text-base text-slate-700">{prompt.explanation}</p>

        <label htmlFor="reason-dialog-reason" className="mt-4 block text-sm font-medium text-slate-800">
          Reason {prompt.reasonRequired ? '(required)' : '(optional)'}
        </label>
        <textarea
          id="reason-dialog-reason"
          rows={4}
          className={`${INPUT_CLASS} mt-1`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="mt-1 text-xs text-slate-600">
          This is written to the sample history and cannot be edited afterwards.
        </p>

        {blockedMessage ? (
          <p role="alert" className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900">
            {blockedMessage}
          </p>
        ) : null}

        {message ? (
          <p role="alert" className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900">
            Nothing was recorded: {message}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant={prompt.danger ? 'danger' : 'primary'}
            disabled={!canSubmit}
            onClick={() => onSubmit(reason)}
          >
            {submitting ? 'Recording…' : prompt.submitLabel}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

export default function SampleDetailPage() {
  // The route is `samples/:id` (see App.tsx), so the param is `id`.
  const { id } = useParams<{ id: string }>();
  const detail = useSampleDetail(id);
  const { authority, allows } = useAuthority();
  const action = useSampleAction();

  const [labelOpen, setLabelOpen] = useState(false);
  const [dispositionOpen, setDispositionOpen] = useState(false);
  const [prompt, setPrompt] = useState<ReasonPrompt | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  if (detail.isPending) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <LoadingBlock label="Loading the sample record" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <ErrorNotice
          error={detail.error}
          what="This sample"
          onRetry={() => void detail.refetch()}
        />
        <p className="mt-4">
          <Link to="/samples" className="text-bff-700 underline">
            Back to the sample list
          </Link>
        </p>
      </div>
    );
  }

  const data = detail.data;
  const sample = data.sample;
  const schema = getSchema(sample.stage);
  const label = sample.sample_id ?? 'this draft record';

  const requiredFields = data.allFields.filter((v) => v.requiredForReview);
  const doneFields = requiredFields.filter((v) => v.displayText !== '');

  async function copyId() {
    if (sample.sample_id === null) {
      setCopyStatus('This record has no sample ID yet, because it has not been registered.');
      return;
    }
    try {
      await navigator.clipboard.writeText(sample.sample_id);
      setCopyStatus(`${sample.sample_id} copied.`);
    } catch {
      setCopyStatus('This browser did not allow copying. Open the label dialog to select the ID.');
    }
  }

  function submitReason(reason: string) {
    if (prompt === null) return;
    action.mutate(
      {
        action: prompt.action,
        sampleUuid: sample.id,
        expectedRevision: sample.revision,
        reason,
      },
      { onSuccess: () => setPrompt(null) },
    );
  }

  function submitDisposition(input: {
    decision: Disposition;
    reason: string;
    recordsOverride: boolean;
  }) {
    action.mutate(
      {
        action: 'disposition',
        sampleUuid: sample.id,
        expectedRevision: sample.revision,
        decision: input.decision,
        reason: input.reason,
        acknowledgedOverride: input.recordsOverride,
      },
      { onSuccess: () => setDispositionOpen(false) },
    );
  }

  // Transition authority, for the message rather than for the control.
  const reviewCheck = checkTransition({
    from: sample.capture_state,
    to: 'reviewed',
    actor: authority,
  });
  // A non-empty reason is supplied so the check reports the TRANSITION's
  // authority rather than the missing reason, which the dialog collects.
  const correctionCheck = checkTransition({
    from: sample.capture_state,
    to: 'correction_required',
    actor: authority,
    reason: 'reason supplied in the dialog',
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader
        title={sample.sample_id ?? 'Draft sample — no ID allocated'}
        description={`${schema.ordinal}. ${schema.title} · ${schema.instruction}`}
        actions={
          <>
            <Button onClick={() => void copyId()}>
              <Copy aria-hidden className="h-4 w-4" />
              Copy sample ID
            </Button>
            <Button onClick={() => setLabelOpen(true)}>
              <Tag aria-hidden className="h-4 w-4" />
              Print label
            </Button>
          </>
        }
      />

      <p role="status" aria-live="polite" className="mb-4 min-h-[1.25rem] text-sm text-slate-700">
        {copyStatus}
      </p>

      <HoldBanner
        hold={data.activeHold}
        triggers={data.holdTriggers}
        canClear={allows('hold.clear')}
        onClear={() =>
          setPrompt({
            action: 'clear_hold',
            title: `Clear the quality hold on ${label}`,
            explanation:
              'Clearing a hold does not accept the material. It records that the reason for the hold has been resolved, and a material decision still has to be made separately.',
            reasonRequired: true,
            submitLabel: 'Clear the hold',
            danger: true,
          })
        }
      />

      <div className="flex flex-col gap-5">
        <Card title="Sample details">
          <dl>
            <DetailRow label="Sample ID">
              <span className="font-mono text-lg font-semibold">
                {sample.sample_id ?? 'Not allocated — this record is a draft'}
              </span>
            </DetailRow>
            <DetailRow label="Stage">{stageTitle(sample.stage)}</DetailRow>
            <DetailRow label="Collected (plant local)">
              {Number.isNaN(new Date(sample.collection_instant).getTime())
                ? `${sample.collection_local_date} ${sample.collection_local_time} (Guyana)`
                : formatPlantDateTimeLabelled(new Date(sample.collection_instant))}
            </DetailRow>
            {sample.sampling_point ? (
              <DetailRow label="Sampling point">{sample.sampling_point}</DetailRow>
            ) : null}
            {sample.material ? <DetailRow label="Material">{sample.material}</DetailRow> : null}
            {sample.feed_type ? <DetailRow label="Feed type">{sample.feed_type}</DetailRow> : null}
            {sample.supplier ? <DetailRow label="Supplier">{sample.supplier}</DetailRow> : null}
            {sample.lot_no ? <DetailRow label="Delivery or lot no.">{sample.lot_no}</DetailRow> : null}
            {sample.batch_no ? <DetailRow label="Batch or bin no.">{sample.batch_no}</DetailRow> : null}
            {sample.run_no ? <DetailRow label="Run no.">{sample.run_no}</DetailRow> : null}
            <DetailRow label="Registered by">
              {sample.registered_by_name ?? 'Not recorded'}
            </DetailRow>
            <DetailRow label="Record state">
              <span className="flex flex-wrap items-center gap-2">
                <CaptureStateBadge state={sample.capture_state} />
                <DispositionBadge disposition={sample.disposition} />
              </span>
            </DetailRow>
            <DetailRow label="Testing progress">
              {requiredFields.length === 0
                ? 'This form has no tests that are mandatory before review.'
                : `${doneFields.length} of ${requiredFields.length} required results recorded`}
            </DetailRow>
            <DetailRow label="Revision">{sample.revision}</DetailRow>
            <DetailRow label="Google Sheets">
              <SyncStatePill state={sample.sync_state} confirmedAt={sample.sheet_confirmed_at} />
            </DetailRow>
          </dl>
        </Card>

        <Card
          title="Test results and assessments"
          description={
            data.approvedRuleCount === 0
              ? 'No approved limit exists for this stage yet, so measurements read "Not assessable". That is the correct result, not a fault: a limit has to be approved in Specifications before conformity can be decided.'
              : `${data.approvedRuleCount} approved rule${data.approvedRuleCount === 1 ? '' : 's'} apply to this stage.`
          }
        >
          <MeasurementTable views={data.allFields} />
        </Card>

        <Card title="Actions">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {allows('sample.enter_results') ? (
                /* The stage form is the one place results are entered, and it
                   opens on the EXISTING record: a second registration would
                   split one physical sample into two quality histories
                   (FR-007). */
                <LinkButton
                  to={`/stage/${sample.stage}?sample=${sample.id}`}
                  variant="primary"
                >
                  <FlaskConical aria-hidden className="h-4 w-4" />
                  Enter or update test results
                </LinkButton>
              ) : null}

              {allows('sample.review') ? (
                <Button
                  onClick={() =>
                    setPrompt({
                      action: 'review',
                      title: `Record a review of ${label}`,
                      explanation:
                        'A review records that the results have been checked. It is not a decision about the material; use "Record a material decision" for that.',
                      reasonRequired: false,
                      submitLabel: 'Record the review',
                    })
                  }
                >
                  <ClipboardCopy aria-hidden className="h-4 w-4" />
                  Record a review
                </Button>
              ) : null}

              {allows('sample.correct') || allows('sample.review') ? (
                <Button
                  onClick={() =>
                    setPrompt({
                      action: 'request_correction',
                      title: `Ask for a correction to ${label}`,
                      explanation:
                        'The record stays as it is and a correction is requested. The original values are kept and the change is recorded with a before and after.',
                      reasonRequired: true,
                      submitLabel: 'Request a correction',
                    })
                  }
                >
                  Request a correction
                </Button>
              ) : null}

              {allows('hold.raise') && data.activeHold === null ? (
                <Button
                  variant="danger"
                  onClick={() =>
                    setPrompt({
                      action: 'raise_hold',
                      title: `Put ${label} on quality hold`,
                      explanation:
                        'A hold stops the material from being released. Anybody can raise one; only an authorised approver can clear it.',
                      reasonRequired: true,
                      submitLabel: 'Raise the hold',
                      danger: true,
                    })
                  }
                >
                  <PauseCircle aria-hidden className="h-4 w-4" />
                  Raise a quality hold
                </Button>
              ) : null}

              {allows('disposition.accept') ||
              allows('disposition.reject') ||
              allows('disposition.rework') ||
              allows('disposition.override_release') ? (
                <Button variant="primary" onClick={() => setDispositionOpen(true)}>
                  <Gavel aria-hidden className="h-4 w-4" />
                  Record a material decision
                </Button>
              ) : null}
            </div>

            {!reviewCheck.allowed && reviewCheck.message && allows('sample.review') ? (
              <InfoNote tone="warning">{reviewCheck.message}</InfoNote>
            ) : null}

            {!allows('sample.review') &&
            !allows('disposition.accept') &&
            !allows('sample.enter_results') ? (
              <NotPermitted reason="Your role can view this record but not change it. An Administrator account deliberately has no quality authority: it cannot approve a specification, clear a hold or release material." />
            ) : null}

            <InfoNote>
              Every action here is checked again on the server before it is recorded. A button being
              visible is not permission.
            </InfoNote>
          </div>
        </Card>

        <Card title="Linked samples">
          <LinkedSamples
            upstream={data.upstream}
            downstream={data.downstream}
            missingLinkNote={data.missingLinkNote}
          />
        </Card>

        <Card title="History">
          <AuditTimeline events={data.events} />
          <p className="mt-3 text-xs text-slate-500">Viewed with app version {appVersion()}.</p>
        </Card>
      </div>

      {labelOpen ? <LabelDialog sample={sample} onClose={() => setLabelOpen(false)} /> : null}

      {prompt !== null ? (
        <ReasonDialog
          prompt={prompt}
          onClose={() => {
            setPrompt(null);
            action.reset();
          }}
          onSubmit={submitReason}
          submitting={action.isPending}
          error={action.error}
          blockedMessage={
            prompt.action === 'review' && !reviewCheck.allowed
              ? (reviewCheck.message ?? null)
              : prompt.action === 'request_correction' && !correctionCheck.allowed
                ? (correctionCheck.message ?? null)
                : null
          }
        />
      ) : null}

      {dispositionOpen ? (
        <DispositionDialog
          sampleLabel={label}
          actor={authority}
          evaluation={data.release}
          onClose={() => {
            setDispositionOpen(false);
            action.reset();
          }}
          onSubmit={submitDisposition}
          submitting={action.isPending}
          submitError={action.error}
        />
      ) : null}
    </div>
  );
}
