/**
 * The screen that hosts all seven sample-testing forms.
 *
 * ===========================================================================
 * WHAT THIS PAGE DECIDES, AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 * It decides: which stage the route refers to, which actions this actor may be
 * OFFERED in the current capture state, where a draft lives, and which screen
 * the operator sees after the server confirms a registration.
 *
 * It does not decide: what the fields are (the registry), whether a value is
 * acceptable (`zodSchema`), whether the actor is ALLOWED to register (the Edge
 * Function re-authorises every call server-side — Master Prompt §1), or
 * whether the Google Sheets row exists (the sync worker, reported by the
 * server's own status object).
 *
 * ===========================================================================
 * THE THREE CLAIMS THIS PAGE IS CAREFUL NOT TO MAKE
 * ===========================================================================
 * 1. No success before the server confirms. The confirmation screen renders
 *    from a server-issued sample id and the server's own recorded instant
 *    (FR-015, UAT-13). There is no optimistic path to it.
 * 2. No Google Sheets claim. `isSheetConfirmed()` is the only test, and the
 *    registration response always says `pending` because the row is queued,
 *    not written (build rule 6).
 * 3. No approved sampling frequency where none exists. Four of the seven
 *    stages read "To set" in the workbook, and `InstructionStrip` says that in
 *    words instead of printing an unapproved rule (FR-020, risk R-08).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileText, Trash2 } from 'lucide-react';

import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';
import { defaultStageValues, hydrateStageValues } from '@/forms/defaults';
import type { StageFormValues } from '@/forms/zodSchema';

import { StageForm, type StageFormSubmission } from '@/components/form/StageForm';
import { InstructionStrip } from '@/components/form/InstructionStrip';
import { RegistrationConfirmation } from '@/components/form/RegistrationConfirmation';
import { availableActions, type FormActionAvailability, type SaveState } from '@/components/form/saveState';
import { Spinner } from '@/components/ui/Spinner';
import { useAccess } from '@/components/layout/accessContext';
import { useAuthority } from '@/hooks/useSamples';
import { useSampleDraft } from '@/hooks/useSampleDraft';
import {
  isSheetConfirmed,
  newIdempotencyKey,
  useRegisterSample,
  type RegisterSampleInput,
} from '@/hooks/useRegisterSample';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import NotFoundPage from '@/pages/NotFoundPage';

function isStage(value: string | undefined): value is Stage {
  return value !== undefined && (STAGES as readonly string[]).includes(value);
}

/**
 * A new form has no record behind it yet, so its capture state is `draft`.
 * Everything the footer offers is composed from that plus `can()`.
 */
const NEW_SAMPLE_STATE = 'draft' as const;

export default function StageFormPage() {
  const { stage } = useParams<{ stage?: string }>();

  // An unknown stage is a wrong address, not an empty form. Validated against
  // STAGES rather than against a list written here, so a stage can never be
  // reachable on one screen and unknown on another.
  if (!isStage(stage)) return <NotFoundPage />;

  // Keyed on the stage so switching forms rebuilds the screen from scratch
  // instead of carrying one stage's half-typed values into another.
  return <StageFormScreen key={stage} stage={stage} />;
}

function StageFormScreen({ stage }: { readonly stage: Stage }) {
  const schema = STAGE_SCHEMAS[stage];
  const navigate = useNavigate();
  const { profile, can } = useAccess();
  const { authority } = useAuthority();
  const draft = useSampleDraft(profile.id, stage);
  const registration = useRegisterSample();

  /**
   * Initial form values are captured ONCE, when the draft lookup settles.
   *
   * After that the form owns its own state: re-seeding it from a prop would
   * discard whatever the operator has typed since, and a draft save would
   * clear the form it was saved from.
   */
  const [initialValues, setInitialValues] = useState<StageFormValues | null>(null);
  const [restoredDraftAt, setRestoredDraftAt] = useState<string | null>(null);
  /** Bumped to remount the form for a deliberate fresh start. */
  const [formInstance, setFormInstance] = useState(0);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft.loaded || initialValues !== null) return;
    const stored = draft.draft;
    if (stored !== null) {
      setInitialValues(hydrateStageValues(stage, stored.values));
      setRestoredDraftAt(stored.savedAt);
      return;
    }
    setInitialValues(defaultStageValues(stage));
  }, [draft.draft, draft.loaded, initialValues, stage]);

  /**
   * The submission currently in flight, with the key it was sent under.
   *
   * A retry of the SAME payload must present the SAME idempotency key, which
   * is what makes the server replay the original registration rather than
   * create a second sample (FR-006). A changed payload is a different
   * submission and gets a new key.
   */
  const inFlight = useRef<{ readonly fingerprint: string; readonly input: RegisterSampleInput } | null>(
    null,
  );

  const send = useCallback(
    (submission: StageFormSubmission) => {
      const fingerprint = JSON.stringify({
        values: submission.values,
        confirmed: submission.confirmedImplausible,
      });

      let input = inFlight.current?.input ?? null;
      if (input === null || inFlight.current?.fingerprint !== fingerprint) {
        let key: string;
        try {
          key = newIdempotencyKey();
        } catch (cause) {
          setKeyError(
            cause instanceof Error
              ? cause.message
              : 'A unique save key could not be made, so nothing was sent.',
          );
          return;
        }
        input = {
          stage,
          values: submission.values,
          confirmedImplausible: submission.confirmedImplausible,
          idempotencyKey: key,
        };
        inFlight.current = { fingerprint, input };
      }

      setKeyError(null);
      setDraftNotice(null);
      registration.register(input);
    },
    [registration, stage],
  );

  const retry = useCallback(() => {
    const pending = inFlight.current;
    if (pending === null) return;
    // Same key, same payload: the server either completes the original
    // registration or replays it. It cannot produce a second sample.
    registration.register(pending.input);
  }, [registration]);

  const saveDraft = useCallback(
    (values: StageFormValues) => {
      const saved = draft.save(values);
      setDraftNotice(
        saved
          ? `Draft saved at ${formatPlantDateTimeLabelled(new Date())}. It has no sample ID yet.`
          : null,
      );
    },
    [draft],
  );

  const discardDraft = useCallback(() => {
    draft.clear();
    setRestoredDraftAt(null);
    setDraftNotice(null);
    setInitialValues(defaultStageValues(stage));
    setFormInstance((instance) => instance + 1);
  }, [draft, stage]);

  const registerAnother = useCallback(() => {
    registration.reset();
    inFlight.current = null;
    setKeyError(null);
    setDraftNotice(null);
    setRestoredDraftAt(null);
    setInitialValues(defaultStageValues(stage));
    setFormInstance((instance) => instance + 1);
  }, [registration, stage]);

  const result = registration.result;

  /**
   * A registered sample is no longer work in progress, so the local draft is
   * removed once the server has confirmed — never before, because a failed
   * registration is exactly when the operator still needs it.
   */
  useEffect(() => {
    if (result !== null) draft.clear();
    // `draft.clear` is stable per stage and user; re-running on a new result
    // is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const actions = useMemo<FormActionAvailability>(() => {
    const base = availableActions(NEW_SAMPLE_STATE, authority);
    return {
      ...base,
      // The state machine allows voiding a draft, but there is no record here
      // to void: nothing has been registered and no sample UUID exists. The
      // equivalent action on an unsaved form is discarding the draft, which is
      // offered beside the draft notice instead of as "Void".
      canVoid: false,
    };
  }, [authority]);

  const noActionReason = useMemo<string | null>(() => {
    if (actions.canRegister || actions.canSaveDraft) return null;
    return (
      'Your account cannot record samples yet. A Quality Supervisor has to give you ' +
      'the operator role before this form can be saved.'
    );
  }, [actions.canRegister, actions.canSaveDraft]);

  const registerError = registration.error;

  const saveState: SaveState = registration.isSaving
    ? 'saving'
    : registerError !== null || keyError !== null
      ? 'failed'
      : 'editing';

  const errorMessage = useMemo<string | null>(() => {
    if (keyError !== null) return keyError;
    if (registerError === null) return null;
    if (registerError.issues.length === 0) return registerError.message;
    const detail = registerError.issues
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join('; ');
    return `${registerError.message} (${detail})`;
  }, [keyError, registerError]);

  // Only a failure that did not reach the server may be resent. A duplicate or
  // in-progress conflict must NOT offer a retry button, because resending is
  // how a second record gets made.
  const onRetry = registerError?.retryable === true ? retry : undefined;

  if (result !== null) {
    return (
      <RegistrationConfirmation
        stage={stage}
        sampleId={result.sampleId}
        registeredAt={result.recordedAt}
        captureState={result.captureState}
        // Two separate facts. The ledger has the sample; the spreadsheet row is
        // queued. Only one value may ever be upgraded to "confirmed".
        sheetSync={isSheetConfirmed(result.sheetSync) ? 'confirmed' : 'pending'}
        onEnterResults={
          can('sample.enter_results')
            ? () => navigate(`/samples/${result.sampleUuid}`)
            : undefined
        }
        onRegisterAnother={actions.canRegister ? registerAnother : undefined}
        onDone={() => navigate('/')}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-5">
      <p className="text-sm font-semibold uppercase tracking-wide text-slate-600">
        Form {schema.ordinal} of {STAGES.length}
      </p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
        {schema.title}
      </h1>
      <p className="mt-1 text-base text-slate-700">{schema.description}</p>

      {/* Where and when to sample, and — only when a process owner has
          actually approved one — how often. */}
      <div className="mt-4">
        <InstructionStrip schema={schema} />
      </div>

      {restoredDraftAt !== null ? (
        <div className="mb-4 rounded-lg border-2 border-slate-300 bg-slate-50 p-3">
          <p className="flex items-start gap-2 text-base font-semibold text-slate-900">
            <FileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              Unfinished draft restored, saved {formatPlantDateTimeLabelled(new Date(restoredDraftAt))}.
            </span>
          </p>
          <p className="mt-1 text-sm text-slate-700">{draft.scopeNote}</p>
          <button
            type="button"
            onClick={discardDraft}
            className="mt-2 inline-flex min-h-[44px] items-center gap-2 rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
          >
            <Trash2 aria-hidden="true" className="h-5 w-5" />
            Discard this draft
          </button>
        </div>
      ) : null}

      {/* A draft is not a server save, so this never borrows the wording of
          one. It says what is true: kept on this device, no sample ID. */}
      {draftNotice !== null ? (
        <p
          aria-live="polite"
          className="mb-4 rounded-md border-2 border-slate-300 bg-white px-3 py-2 text-base font-medium text-slate-800"
        >
          {draftNotice}
        </p>
      ) : null}

      {draft.error !== null ? (
        <p
          aria-live="polite"
          className="mb-4 rounded-md border-2 border-amber-400 bg-amber-50 px-3 py-2 text-base font-medium text-amber-900"
        >
          {draft.error}
        </p>
      ) : null}

      {initialValues === null ? (
        <div className="py-10 text-center">
          <Spinner size="lg" label="Opening the form" />
          <p className="mt-3 text-base text-slate-700">Opening the form</p>
        </div>
      ) : (
        <StageForm
          key={`${stage}-${formInstance}`}
          stage={stage}
          // Registration requiredness. Results are entered later, against the
          // registered sample, so this form never asks for them.
          phase="registration"
          initialValues={initialValues}
          actions={actions}
          saveState={saveState}
          errorMessage={errorMessage}
          noActionReason={noActionReason}
          onSubmit={send}
          onSaveDraft={saveDraft}
          onCancel={() => navigate('/')}
          onVoid={discardDraft}
          onRetry={onRetry}
        />
      )}
    </div>
  );
}
