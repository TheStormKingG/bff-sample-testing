/**
 * Record a material decision.
 *
 * Authority comes from `checkDisposition`, and its denial messages are shown
 * VERBATIM. They are written to be the reason an auditor reads later, so
 * rewording them in the UI would put a second, softer account of the same
 * refusal in front of the person acting.
 *
 * When `recordsOverride` is true the dialog says plainly that the decision
 * will be filed as an authorised override rather than a clean acceptance, and
 * will not submit without a justification and an explicit acknowledgement. The
 * audit trail must never be readable as a clean pass.
 *
 * The server re-checks all of this. Nothing here is the control.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';

import {
  checkDisposition,
  DISPOSITION_LABELS,
  type Disposition,
  type ReleaseEvaluation,
} from '@/lib/workflow';
import type { AuthorityContext } from '@/lib/roles';
import { Button, INPUT_CLASS } from './common';

/** Offered decisions. `undetermined` is a starting state, not a decision. */
const OFFERED: readonly Disposition[] = [
  'accepted',
  'rejected',
  'rework_required',
  'on_hold',
  'released_by_authorized_override',
];

const DECISION_HELP: Record<Disposition, string> = {
  undetermined: '',
  on_hold: 'Stop the material from being used until Quality decides.',
  accepted: 'Release the material for use.',
  rejected: 'The material must not be used.',
  rework_required: 'The material can be used only after further processing.',
  released_by_authorized_override:
    'Release the material despite outstanding quality findings, under a recorded delegated authority.',
};

const BLOCKER_LABELS: Record<ReleaseEvaluation['blockers'][number]['kind'], string> = {
  active_hold: 'Quality hold',
  outside_approved_limit: 'Outside an approved limit',
  missing_required_result: 'Missing required result',
  not_assessable: 'Cannot be assessed',
  sheet_sync_unconfirmed: 'Google Sheets row not confirmed',
};

export function DispositionDialog({
  sampleLabel,
  actor,
  evaluation,
  onClose,
  onSubmit,
  submitting,
  submitError,
}: {
  sampleLabel: string;
  actor: AuthorityContext;
  evaluation: ReleaseEvaluation;
  onClose: () => void;
  onSubmit: (input: { decision: Disposition; reason: string; recordsOverride: boolean }) => void;
  submitting: boolean;
  submitError: unknown;
}) {
  const ids = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [decision, setDecision] = useState<Disposition>('rejected');
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Changing the decision invalidates an acknowledgement given for another one.
  useEffect(() => setAcknowledged(false), [decision]);

  const check = checkDisposition({ decision, actor, evaluation, reason });
  const needsAcknowledgement = check.recordsOverride;
  const canSubmit = check.allowed && (!needsAcknowledgement || acknowledged) && !submitting;

  const errorMessage =
    submitError instanceof Error
      ? submitError.message
      : typeof submitError === 'string'
        ? submitError
        : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        tabIndex={-1}
        className="my-6 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={`${ids}-title`} className="text-xl font-semibold text-slate-900">
            Record a material decision for {sampleLabel}
          </h2>
          <Button onClick={onClose} ariaLabel="Close without recording a decision">
            <X aria-hidden className="h-4 w-4" />
            Close
          </Button>
        </div>

        {evaluation.blockers.length > 0 ? (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="flex items-center gap-2 text-base font-semibold text-amber-900">
              <AlertTriangle aria-hidden className="h-5 w-5" />
              {evaluation.blockers.length} outstanding quality finding
              {evaluation.blockers.length === 1 ? '' : 's'}
            </p>
            <ul className="mt-1 list-inside list-disc text-sm text-amber-900">
              {evaluation.blockers.map((b, index) => (
                <li key={`${b.kind}-${index}`}>
                  <span className="font-medium">{BLOCKER_LABELS[b.kind]}: </span>
                  {b.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 rounded-md border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
            Nothing is outstanding against this sample. A decision still has to be recorded by an
            authorised person; the system never releases material on its own.
          </p>
        )}

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-slate-800">Decision</legend>
          <div className="mt-2 flex flex-col gap-2">
            {OFFERED.map((option) => {
              const id = `${ids}-decision-${option}`;
              return (
                <label
                  key={option}
                  htmlFor={id}
                  className="flex min-h-tap cursor-pointer items-start gap-3 rounded-md border border-slate-300 p-3 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-bff-600"
                >
                  <input
                    id={id}
                    type="radio"
                    name={`${ids}-decision`}
                    value={option}
                    checked={decision === option}
                    onChange={() => setDecision(option)}
                    className="mt-1 h-5 w-5 border-slate-400 text-bff-700 focus:ring-bff-600"
                  />
                  <span>
                    <span className="block text-base font-medium text-slate-900">
                      {DISPOSITION_LABELS[option]}
                    </span>
                    <span className="block text-sm text-slate-600">{DECISION_HELP[option]}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-4">
          <label htmlFor={`${ids}-reason`} className="text-sm font-medium text-slate-800">
            Reason — recorded permanently in the sample history
          </label>
          <textarea
            id={`${ids}-reason`}
            rows={4}
            className={`${INPUT_CLASS} mt-1`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={`${ids}-reason-hint`}
          />
          <p id={`${ids}-reason-hint`} className="mt-1 text-xs text-slate-600">
            Say who authorised the decision and on what basis.
          </p>
        </div>

        {needsAcknowledgement ? (
          <div className="mt-4 rounded-md border-2 border-purple-400 bg-purple-50 p-3">
            <p className="flex items-center gap-2 text-base font-semibold text-purple-900">
              <ShieldAlert aria-hidden className="h-5 w-5" />
              This will be recorded as an authorised override
            </p>
            <p className="mt-1 text-sm text-purple-900">
              The record will say that material was released over outstanding quality findings
              under your delegated authority. It will <strong>not</strong> read as a clean
              acceptance, and the findings above stay visible on the sample for good.
            </p>
            <label
              htmlFor={`${ids}-ack`}
              className="mt-2 flex min-h-tap cursor-pointer items-start gap-2 text-sm text-purple-900"
            >
              <input
                id={`${ids}-ack`}
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-5 w-5 rounded border-purple-400 text-purple-700 focus:ring-purple-600"
              />
              I understand this is recorded as an authorised override, not as a clean acceptance.
            </label>
          </div>
        ) : null}

        {/* The denial message is the library's own wording, unaltered. */}
        {!check.allowed && check.message ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900"
          >
            {check.message}
          </p>
        ) : null}

        {errorMessage ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900"
          >
            The decision was not recorded: {errorMessage}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant={check.recordsOverride ? 'danger' : 'primary'}
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({ decision, reason, recordsOverride: check.recordsOverride })
            }
          >
            {submitting
              ? 'Recording…'
              : check.recordsOverride
                ? 'Record authorised override'
                : `Record "${DISPOSITION_LABELS[decision]}"`}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
