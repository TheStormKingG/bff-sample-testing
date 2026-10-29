/**
 * The one generated form, used by all seven stages.
 *
 * ===========================================================================
 * WHY THERE IS ONLY ONE OF THESE
 * ===========================================================================
 * PRD NFR-006 forbids "magic column offsets buried throughout UI code". So no
 * stage is named in this file, no field key is named in this file, and no
 * column letter appears anywhere. Everything comes from `registry.ts`:
 *
 *   - which fields exist, in which order        -> STAGE_SCHEMAS[stage].fields
 *   - which band each one sits in               -> field.section + SECTION_LABELS
 *   - which are mandatory right now             -> requiredFieldKeys(stage, phase)
 *   - which apply at all right now              -> isFieldApplicable (via editableFields)
 *   - the validation rules                      -> buildStageSchema / parseStageValues
 *   - the unit, the help text, the keyboard     -> FieldRenderer / FieldShell
 *
 * Adding a column to the registry therefore makes it appear in the right band
 * of the right form, with the right keyboard, unit, help text and validation,
 * without touching this file.
 *
 * ===========================================================================
 * THREE RULES THIS COMPONENT EXISTS TO HOLD
 * ===========================================================================
 *
 * 1. A NON-APPLICABLE VALUE MUST NEVER REACH THE SERVER (UAT-02). Moisture at
 *    BC applies only at sampling point BC. Two independent layers enforce it:
 *    the field is not rendered at AM, AND `buildStageSchema` omits the key so
 *    `z.object` strips any value left in form state. On top of that, switching
 *    BC -> AM actively clears the stored text via `clearNonApplicable`, so
 *    switching back to BC shows an empty box rather than a stale reading.
 *
 * 2. `implausibleAbove` IS NOT A VALIDATION FAILURE. It raises a confirmation
 *    question, and a confirmed value is submitted exactly as typed. Treating
 *    it as a rejection would turn a data-entry guard into an unapproved
 *    operational acceptance limit, which PRD §6.1 reserves to the process
 *    owner. The only consumer is `implausibleFindings()`.
 *
 * 3. AN EMPTY NUMERIC BOX IS "NOT MEASURED", NEVER 0 (PRD §6.1, build rule 8).
 *    Defaults come from `defaultStageValues`, which seeds only the collection
 *    date and time. Nothing here writes a zero into a result.
 *
 * The inputs stay UNCONTROLLED (react-hook-form `register` spread onto the
 * element), which is what preserves `12.50` as the operator typed it: no React
 * re-render can normalise the trailing zero away, and that zero states the
 * instrument's resolution.
 *
 * To load a different record into this form, remount it with a new `key`
 * rather than changing `initialValues` — form state belongs to the form after
 * mount, and a reset-on-prop effect would fight the operator's keystrokes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { STAGE_SCHEMAS } from '@/forms/registry';
import { SECTIONS, type FieldDef, type Section, type Stage } from '@/forms/types';
import { clearNonApplicable, defaultStageValues } from '@/forms/defaults';
import {
  buildStageSchema,
  editableFields,
  implausibleFindings,
  parseStageValues,
  requiredFieldKeys,
  type FormPhase,
  type ImplausibleFinding,
  type StageFormValues,
  type StageSubmitValues,
} from '@/forms/zodSchema';

import { ErrorSummary, type SummarisedError } from './ErrorSummary';
import { FieldRenderer } from './FieldRenderer';
import { fieldIds } from './FieldShell';
import { FormSection } from './FormSection';
import { ImplausibleValueDialog } from './ImplausibleValueDialog';
import { SaveStateBanner } from './SaveStateBanner';
import { StickyFormFooter } from './StickyFormFooter';
import type { FormActionAvailability, SaveState, SheetSyncState } from './saveState';

/** One per-field complaint from the server, as it was sent. */
export interface ServerIssue {
  /** A registry field key. The server uses the same names this form does. */
  readonly field: string;
  readonly message: string;
}

/**
 * The server's last refusal, kept as STRUCTURE rather than as a sentence.
 *
 * The page used to flatten this into one string —
 * `issues.map((i) => `${i.field}: ${i.message}`).join('; ')` — and print it in
 * the "Not saved" strip. An operator then read, in a paragraph:
 *
 *     (quantity_received_t: Quantity received must be a number.;
 *      moisture_pct: Moisture must be a number.; ...)
 *
 * which names columns in a database rather than the boxes on the screen, puts
 * them in no particular order, marks none of the fields, and leaves the
 * section headers still reading "8 fields" instead of "4 to fix". Every one of
 * those field keys is a key this form already renders, so all of it could be
 * pointed at the right box. Keeping the structure is what allows that.
 *
 * `submitted` is the operator's own text as it was sent. It is what makes a
 * routed error know when it has been ANSWERED: the complaint is about a
 * specific value, so it stands exactly as long as that value is unchanged.
 */
export interface ServerRefusal {
  readonly issues: readonly ServerIssue[];
  readonly submitted: StageFormValues;
}

/** What a completed, validated submission hands back to its page. */
export interface StageFormSubmission {
  readonly phase: FormPhase;
  /** Validated payload, ready for the Edge Function's `values`. */
  readonly values: StageSubmitValues;
  /** The operator's raw text, for a draft or for repopulating after a failure. */
  readonly rawValues: StageFormValues;
  /**
   * Field keys whose soft typo guard the operator explicitly confirmed. The
   * server re-checks these, so an unconfirmed implausible value is refused
   * there too rather than only here.
   */
  readonly confirmedImplausible: readonly string[];
}

export interface StageFormProps {
  readonly stage: Stage;
  /** Which requiredness set applies. Registration for a new sample. */
  readonly phase: FormPhase;
  /** Seeded from `defaultStageValues` when omitted. Read once, at mount. */
  readonly initialValues?: StageFormValues;
  /** Which footer buttons to offer. Composed by the page from state + can(). */
  readonly actions: FormActionAvailability;
  readonly saveState: SaveState;
  /** The server's own words when a save failed. Never an exception trace. */
  readonly errorMessage?: string | null;
  /** The server's per-field complaints, to be shown ON the fields. */
  readonly refusal?: ServerRefusal | null;
  /**
   * Monotonic count of save attempts, supplied by the page.
   *
   * The notice has to be brought back on screen on every attempt, and no
   * other value on this path changes on every attempt — an identical second
   * refusal produces identical state, which React correctly treats as nothing
   * having happened.
   */
  readonly saveAttempt?: number;
  readonly sheetSync?: SheetSyncState | null;
  /** Why no action is on offer, when none is. */
  readonly noActionReason?: string | null;
  readonly onSubmit: (submission: StageFormSubmission) => void;
  /** A draft may be incomplete (FR-005); only malformed text is refused. */
  readonly onSaveDraft: (values: StageFormValues) => void;
  readonly onCancel: () => void;
  /**
   * Required even when `actions.canVoid` is false, so the footer can never be
   * wired to a handler that does nothing. What voiding means is the page's
   * decision: discarding an unregistered draft, or a reasoned state change on
   * a registered sample.
   */
  readonly onVoid: () => void;
  readonly onRetry?: () => void;
  /** Distinct ids per form instance, so two forms can coexist on one page. */
  readonly idPrefix?: string;
}

function messageOf(error: unknown): string | undefined {
  if (error === null || error === undefined || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

export function StageForm({
  stage,
  phase,
  initialValues,
  actions,
  saveState,
  errorMessage = null,
  refusal = null,
  saveAttempt = 0,
  sheetSync = null,
  noActionReason = null,
  onSubmit,
  onSaveDraft,
  onCancel,
  onVoid,
  onRetry,
  idPrefix,
}: StageFormProps): JSX.Element {
  const schema = STAGE_SCHEMAS[stage];
  const prefix = idPrefix ?? `stage-${stage}`;

  /**
   * Read once. `useState` with an initialiser rather than `useMemo`, because a
   * memo is a cache the runtime may drop, and dropping these would re-seed the
   * form mid-edit.
   */
  const [defaults] = useState<StageFormValues>(
    () => initialValues ?? defaultStageValues(stage),
  );

  /**
   * The resolver is rebuilt per validation run from the values being
   * validated, because requiredness and applicability both depend on them —
   * `buildStageSchema` omits a field that does not currently apply, which is
   * what keeps a stale BC reading out of the payload.
   *
   * `raw: true` makes the resolver hand back the operator's own strings rather
   * than the parsed payload, so `handleSubmit` receives `StageFormValues` as
   * its type says. The typed payload is produced once, below, by
   * `parseStageValues` — the same schema, called through its own API.
   */
  const resolver = useCallback<Resolver<StageFormValues>>(
    (values, context, options) =>
      zodResolver(buildStageSchema(stage, phase, values), undefined, { raw: true })(
        values,
        context,
        options,
      ),
    [stage, phase],
  );

  const { control, register, handleSubmit, getValues, setValue, setError, clearErrors, formState } =
    useForm<StageFormValues>({
      defaultValues: defaults,
      resolver,
      /**
       * `ErrorSummary` owns post-submit focus, so react-hook-form must not
       * also grab it. Two components competing for focus is not a style
       * question here: the field react-hook-form jumps to may sit inside a
       * collapsed band, and the operator arrives at one red box with no idea
       * that eleven others are below it. The summary announces the count and
       * the list first, and each entry moves focus to its own field.
       */
      shouldFocusError: false,
    });

  const watched = useWatch({ control }) as Partial<Record<string, unknown>> | undefined;

  /** Current form state as plain strings, for every registry-derived decision. */
  const values = useMemo<StageFormValues>(() => {
    const merged: StageFormValues = { ...defaults };
    for (const [key, value] of Object.entries(watched ?? {})) {
      if (typeof value === 'string') merged[key] = value;
    }
    return merged;
  }, [defaults, watched]);

  /**
   * A value that has stopped applying is blanked in form state.
   *
   * The rule itself lives in `clearNonApplicable`, so this is a write-back of
   * that function's answer rather than a second copy of the condition.
   *
   * This is belt to the schema's braces: `buildStageSchema` already omits a
   * non-applicable key, so a stale reading cannot reach the server either way
   * (UAT-02). What the clearing adds is that switching AM -> BC -> AM -> BC
   * shows an EMPTY box, instead of resurrecting a number the operator typed
   * for a different sampling point and may not notice.
   *
   * The write is guarded by a diff, so the pass that clears a value is
   * followed by one that finds nothing to do, and it terminates.
   */
  useEffect(() => {
    const current = getValues();
    const next = clearNonApplicable(stage, current);
    for (const key of Object.keys(next)) {
      if (next[key] === current[key]) continue;
      setValue(key, '', { shouldDirty: true, shouldValidate: false });
    }
  }, [getValues, setValue, stage, values]);

  const applicable = useMemo<readonly FieldDef[]>(
    () => editableFields(stage, values),
    [stage, values],
  );
  const required = useMemo(() => requiredFieldKeys(stage, phase, values), [stage, phase, values]);

  /** Only the bands this stage actually has — tabs 1, 4 and 7 carry no settings. */
  const sections = useMemo<readonly Section[]>(
    () => SECTIONS.filter((section) => applicable.some((field) => field.section === section)),
    [applicable],
  );

  const [openSections, setOpenSections] = useState<Readonly<Record<Section, boolean>>>(() => ({
    sample_details: true,
    settings: true,
    test_results: true,
    follow_up: true,
  }));

  const [pending, setPending] = useState<StageFormSubmission | null>(null);
  const [findings, setFindings] = useState<readonly ImplausibleFinding[]>([]);

  const noticeRef = useRef<HTMLDivElement | null>(null);

  /**
   * Bring the failure notice onto the screen.
   *
   * SCROLL IS EXPLICIT HERE, NEVER A SIDE EFFECT OF FOCUS. `focus()` scrolls
   * in most browsers, which is why this looked like it worked and why the
   * report reads as intermittent — but for a `tabindex="-1"` heading the
   * amount, the alignment and whether it happens at all are the browser's
   * choice, and the report came from iOS Safari, which this repo has no way
   * to measure. So `ErrorSummary` is asked NOT to scroll when it takes focus,
   * and the scroll happens here, where the alignment is ours.
   *
   * `block: 'start'`, chosen rather than defaulted. A twelve-error summary is
   * taller than a phone viewport, so `'center'` would push the count — the
   * one line saying how much is wrong — off the top; and `'nearest'` can
   * leave the notice behind the `sticky bottom-0` action bar.
   *
   * NO `behavior`. Omitting it resolves to the computed `scroll-behavior`,
   * which `index.css` already forces to `auto` under `prefers-reduced-motion`.
   * Passing `'smooth'` would OVERRIDE that CSS and animate for somebody who
   * asked for no animation.
   */
  const revealNotice = useCallback(() => {
    noticeRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  const errors = formState.errors;

  /**
   * The server's complaints that still stand, keyed by field.
   *
   * WHY THESE ARE NOT PUT INTO react-hook-form VIA `setError`. That was the
   * obvious design and it is wrong here for one concrete reason: `saveDraft`
   * calls `clearErrors()` unconditionally as its first statement. An operator
   * who gets a server refusal and then taps "Save draft" would have every
   * routed error silently wiped — the fields would go quiet while still being
   * exactly as unacceptable to the server. Holding them here keeps the
   * server's verdict independent of anything the client decides to clear.
   *
   * WHEN ONE STOPS STANDING. The complaint is about a VALUE, so it stands
   * exactly as long as that value is unchanged. Comparing against the text
   * that was submitted — rather than clearing on any keystroke — means an
   * operator who edits a field and then types the same thing back still sees
   * the error, which is correct: the server has not been asked again.
   *
   * An issue naming a field this form is not currently showing is NOT dropped
   * — it falls through to `unroutedIssues` below and is shown in the banner.
   * Silently discarding it would hide a real refusal.
   */
  const serverErrors = useMemo<Readonly<Record<string, string>>>(() => {
    if (refusal === null) return {};
    const live: Record<string, string> = {};
    for (const issue of refusal.issues) {
      if (!applicable.some((field) => field.key === issue.field)) continue;
      const sent = refusal.submitted[issue.field] ?? '';
      const now = values[issue.field] ?? '';
      if (sent !== now) continue;
      live[issue.field] = issue.message;
    }
    return live;
  }, [applicable, refusal, values]);

  /** Refusals with no field on this form to land on. The banner shows these. */
  const unroutedIssues = useMemo<readonly ServerIssue[]>(() => {
    if (refusal === null) return [];
    return refusal.issues.filter(
      (issue) => !applicable.some((field) => field.key === issue.field),
    );
  }, [applicable, refusal]);

  /**
   * The message for a field: the client's own verdict first.
   *
   * Client validation ran against what is in the box NOW; a server issue is
   * about what was sent. When both have something to say the fresher one is
   * the client's.
   */
  const errorFor = useCallback(
    (key: string): string | undefined => messageOf(errors[key]) ?? serverErrors[key],
    [errors, serverErrors],
  );

  /** One summary entry per field with an error, in the order they are read. */
  const summarised = useMemo<readonly SummarisedError[]>(
    () =>
      applicable.flatMap((field) => {
        const message = messageOf(errors[field.key]) ?? serverErrors[field.key];
        if (message === undefined) return [];
        return [
          {
            fieldKey: field.key,
            label: field.label,
            message,
            targetId: fieldIds(prefix, field.key).input,
          },
        ];
      }),
    [applicable, errors, prefix, serverErrors],
  );

  const errorCountIn = useCallback(
    (section: Section): number =>
      summarised.filter(
        (entry) =>
          applicable.find((field) => field.key === entry.fieldKey)?.section === section,
      ).length,
    [applicable, summarised],
  );

  const toggleSection = useCallback((section: Section, open: boolean) => {
    setOpenSections((previous) => ({ ...previous, [section]: open }));
  }, []);

  /** A collapsed field cannot take focus, so open its band before focus moves. */
  const revealField = useCallback(
    (fieldKey: string) => {
      const field = applicable.find((candidate) => candidate.key === fieldKey);
      if (field === undefined) return;
      setOpenSections((previous) => ({ ...previous, [field.section]: true }));
    },
    [applicable],
  );

  const dispatch = useCallback(
    (submission: StageFormSubmission) => {
      setPending(null);
      setFindings([]);
      onSubmit(submission);
    },
    [onSubmit],
  );

  const onValid = useCallback(
    (raw: StageFormValues) => {
      const parsed = parseStageValues(stage, phase, raw);
      if (!parsed.ok) {
        // Unreachable while the resolver and this call share one schema. If it
        // ever is reached the schema changed under us, and the honest response
        // is the field-level errors rather than a silent submit.
        for (const [key, message] of Object.entries(parsed.errors)) {
          setError(key, { type: 'validate', message });
        }
        return;
      }

      const submission: StageFormSubmission = {
        phase,
        values: parsed.values,
        rawValues: raw,
        confirmedImplausible: [],
      };

      const above = implausibleFindings(stage, parsed.values);
      if (above.length > 0) {
        // Not a rejection: a question. The value is already valid.
        setFindings(above);
        setPending({
          ...submission,
          confirmedImplausible: above.map((finding) => finding.field.key),
        });
        return;
      }

      dispatch(submission);
    },
    [dispatch, phase, setError, stage],
  );

  const submit = handleSubmit(onValid);

  /**
   * TRIGGER ONE — client validation refused the form.
   *
   * Keyed on the ATTEMPT (`submitCount`), never on the error count. The count
   * was the original defect: it is the RESULT of an attempt, not the attempt,
   * so it only changes on the first failure (0 -> N) and the operator's second
   * tap of Register produces no change for React to see and nothing on screen.
   *
   * `!isSubmitSuccessful` is load-bearing and not defensive. `submitCount`
   * also increments on a SUCCESSFUL submit, and a successful submit carrying
   * an implausible value opens `ImplausibleValueDialog` — which is entitled to
   * focus. Without this guard, answering a typo guard would yank the operator
   * back to the top of the form.
   *
   * An effect rather than `handleSubmit`'s `onInvalid` hook, and this was
   * measured rather than preferred: `onInvalid` does fire once per attempt,
   * but react-hook-form awaits it BEFORE publishing the errors to form state,
   * so on the first failure the notice has not rendered yet and there is
   * nothing to scroll to. The effect runs after the commit.
   */
  useEffect(() => {
    if (formState.submitCount === 0) return;
    if (formState.isSubmitSuccessful) return;
    if (summarised.length === 0) return;
    revealNotice();
    // The ATTEMPT is the trigger. `summarised` is read when the effect runs,
    // not watched — adding it here would turn "once per attempt" back into
    // "once per change in the result", which is the bug being fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formState.submitCount]);

  /**
   * TRIGGER TWO — the server refused, or the save could not be sent.
   *
   * Keyed on `saveAttempt` as well as `saveState` because `saveState` alone
   * cannot see a repeat. The key-generation failure path sets its message and
   * returns without ever calling the server, so `saveState` never leaves
   * `failed`; a second identical failure changes no state at all. The counter
   * is the only value that moves on every try.
   */
  useEffect(() => {
    if (saveState !== 'failed') return;
    revealNotice();
  }, [saveState, saveAttempt, revealNotice]);

  /**
   * Save draft (FR-005).
   *
   * A draft is allowed to be incomplete, so the registration-phase
   * requiredness is not applied — but the `draft` phase still refuses text
   * that could never be submitted, so a draft can never hold `abc` in a
   * measurement box and surprise the operator later.
   */
  const saveDraft = useCallback(() => {
    const raw = getValues();
    clearErrors();
    const parsed = parseStageValues(stage, 'draft', raw);
    if (!parsed.ok) {
      for (const [key, message] of Object.entries(parsed.errors)) {
        setError(key, { type: 'validate', message });
      }
      return;
    }
    onSaveDraft(raw);
  }, [clearErrors, getValues, onSaveDraft, setError, stage]);

  const busy = saveState === 'saving';

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
      /* The page owns the visible heading; the form names itself rather than
         introducing a second one for a screen reader to announce. */
      aria-label={`${schema.ordinal}. ${schema.title} sample`}
    >
      {/*
        ONE NOTICE REGION, so bringing "the failure notice" on screen is never
        a question of which one. Both can be present at once: a server refusal
        leaves `saveState === 'failed'`, and the operator then resubmitting a
        still-incomplete form adds the summary above it. Scrolling to the top
        of the region shows whichever comes first, with no branch to get wrong.

        The wrapper carries no role and no margin of its own — `ErrorSummary`
        already carries `mb-4` — so it is layout-neutral and introduces no
        second live region.

        `scroll-mt-4` for a smaller reason than it might seem: nothing in this
        app is sticky at the TOP (only the action bar, at the bottom), so there
        is no header to clear. A notice flush against the viewport edge simply
        reads as clipped.
      */}
      <div ref={noticeRef} className="scroll-mt-4">
        <ErrorSummary
          errors={summarised}
          attempt={formState.submitCount}
          onNavigate={revealField}
        />

        {saveState !== 'editing' ? (
          <div className="mb-4">
            <SaveStateBanner
              state={saveState}
              sheetSync={sheetSync}
              errorMessage={errorMessage}
              unroutedIssues={unroutedIssues}
              routedCount={Object.keys(serverErrors).length}
              onRetry={onRetry}
            />
          </div>
        ) : null}
      </div>

      {sections.map((section) => {
        const sectionFields = applicable.filter((field) => field.section === section);
        return (
          <FormSection
            key={section}
            section={section}
            open={openSections[section]}
            onToggle={toggleSection}
            errorCount={errorCountIn(section)}
            fieldCount={sectionFields.length}
          >
            {sectionFields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                idPrefix={prefix}
                required={required.has(field.key)}
                error={errorFor(field.key)}
                control={register(field.key)}
                disabled={busy}
                currentValue={values[field.key] ?? ''}
              />
            ))}
          </FormSection>
        );
      })}

      <StickyFormFooter
        actions={actions}
        saveState={saveState}
        onSaveDraft={saveDraft}
        // Register and Save results are the same act — validate this stage at
        // the current phase and hand the payload up. Which of the two is on
        // offer is decided by the capture state, and never both at once.
        onRegister={() => {
          void submit();
        }}
        onSaveResults={() => {
          void submit();
        }}
        onVoid={onVoid}
        onCancel={onCancel}
        noActionReason={noActionReason}
      />

      <ImplausibleValueDialog
        findings={findings}
        busy={busy}
        onConfirm={() => {
          if (pending !== null) dispatch(pending);
        }}
        onCancel={() => {
          setPending(null);
          setFindings([]);
        }}
      />
    </form>
  );
}

export default StageForm;
