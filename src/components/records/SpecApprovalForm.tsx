/**
 * Propose a specification rule.
 *
 * The form never pre-fills a bound. A number that decides whether feed is
 * released has to be typed deliberately by the person proposing it, with a
 * reason and a source. Promoting a workbook reference entry therefore carries
 * its provenance (the entry number) but not its numbers — copying them in one
 * click is exactly the act Master Prompt §6 and risk R-01 forbid.
 *
 * The proposer is never the approver: that is checked here for the message and
 * again on the server for the control (PRD §7.3).
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { STAGES, type Stage } from '@/forms/types';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { isUnitConfirmed } from '@/lib/assessment';
import { plantLocalDate } from '@/lib/time';
import {
  parameterOptions,
  type SpecificationProposal,
} from '@/hooks/useSpecifications';
import { Button, INPUT_CLASS, InfoNote } from './common';

const BLANK_TO_NULL = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function parseBound(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

const schema = z
  .object({
    // The seven stages are the only possible values; the select cannot offer
    // another, and a hand-crafted request is rejected server-side as well.
    stage: z.string().refine((v): v is Stage => (STAGES as readonly string[]).includes(v), {
      message: 'Choose a process stage.',
    }),
    parameterKey: z.string().min(1, 'Choose which test this rule applies to.'),
    material: z.string(),
    feedType: z.string(),
    samplingPoint: z.string(),
    testMethod: z.string(),
    unit: z
      .string()
      .min(1, 'An approved rule must state the unit its bounds are measured in.')
      .refine((v) => isUnitConfirmed(v), {
        message:
          'That is not a measurable unit. A rule whose unit is unconfirmed can never decide conformity.',
      }),
    lowerBound: z.string(),
    upperBound: z.string(),
    effectiveFrom: z.string().min(1, 'State the date this rule starts to apply.'),
    reason: z
      .string()
      .min(15, 'Explain why this limit is being set. This is recorded permanently.'),
    sourceEvidence: z
      .string()
      .min(5, 'Name the document, standard or approval this limit comes from.'),
  })
  .superRefine((values, ctx) => {
    const lower = parseBound(values.lowerBound);
    const upper = parseBound(values.upperBound);

    if (Number.isNaN(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lowerBound'],
        message: 'Enter a number, or leave it blank if there is no lower limit.',
      });
    }
    if (Number.isNaN(upper)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['upperBound'],
        message: 'Enter a number, or leave it blank if there is no upper limit.',
      });
    }
    if (lower === null && upper === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lowerBound'],
        message: 'A rule with no limit on either side cannot assess anything. Set at least one.',
      });
    }
    if (
      lower !== null &&
      upper !== null &&
      !Number.isNaN(lower) &&
      !Number.isNaN(upper) &&
      lower > upper
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['upperBound'],
        message: 'The highest allowed value must not be below the lowest allowed value.',
      });
    }
  });

type FormValues = z.input<typeof schema>;

export function SpecApprovalForm({
  initialStage,
  promotedFromWorkbookEntryNo,
  referenceNote,
  onCancel,
  onSubmit,
  submitting,
  submitError,
}: {
  initialStage: Stage;
  /** Provenance only. The reference entry's numbers are never copied in. */
  promotedFromWorkbookEntryNo?: number;
  referenceNote?: string;
  onCancel: () => void;
  onSubmit: (proposal: SpecificationProposal) => void;
  submitting: boolean;
  submitError: unknown;
}) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      stage: initialStage,
      parameterKey: '',
      material: '',
      feedType: '',
      samplingPoint: '',
      testMethod: '',
      unit: '',
      lowerBound: '',
      upperBound: '',
      effectiveFrom: plantLocalDate(new Date()),
      reason: '',
      sourceEvidence: '',
    },
  });

  const stage = watch('stage');
  const parameterKey = watch('parameterKey');
  const options = parameterOptions(
    (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : initialStage,
  );
  const chosen = options.find((o) => o.parameterKey === parameterKey);

  const errorMessage =
    submitError instanceof Error
      ? submitError.message
      : typeof submitError === 'string'
        ? submitError
        : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={handleSubmit((values) => {
        onSubmit({
          parameterKey: values.parameterKey,
          stage: values.stage as Stage,
          material: BLANK_TO_NULL(values.material),
          feedType: BLANK_TO_NULL(values.feedType),
          samplingPoint: BLANK_TO_NULL(values.samplingPoint),
          testMethod: BLANK_TO_NULL(values.testMethod),
          unit: values.unit.trim(),
          lowerBound: parseBound(values.lowerBound),
          upperBound: parseBound(values.upperBound),
          effectiveFrom: values.effectiveFrom,
          reason: values.reason,
          sourceEvidence: values.sourceEvidence,
          ...(promotedFromWorkbookEntryNo !== undefined
            ? { promotedFromWorkbookEntryNo }
            : {}),
        });
      })}
    >
      {promotedFromWorkbookEntryNo !== undefined ? (
        <InfoNote tone="warning">
          You are writing a new rule starting from workbook reference entry{' '}
          <strong>#{promotedFromWorkbookEntryNo}</strong>. Its values are shown for context only and
          have not been copied into the fields below — a limit that releases feed has to be entered
          and approved deliberately.
          {referenceNote ? <span className="mt-1 block">{referenceNote}</span> : null}
        </InfoNote>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="spec-stage" className="text-sm font-medium text-slate-800">
            Process stage
          </label>
          <select id="spec-stage" className={`${INPUT_CLASS} mt-1`} {...register('stage')}>
            {DASHBOARD_ORDER.map((s) => (
              <option key={s.stage} value={s.stage}>
                {s.ordinal}. {s.title}
              </option>
            ))}
          </select>
          {errors.stage ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.stage.message}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="spec-parameter" className="text-sm font-medium text-slate-800">
            Test this rule applies to
          </label>
          <select
            id="spec-parameter"
            className={`${INPUT_CLASS} mt-1`}
            {...register('parameterKey')}
          >
            <option value="">Choose a test…</option>
            {options.map((o) => (
              <option key={o.parameterKey} value={o.parameterKey}>
                {o.label}
                {o.unit ? ` (${o.unit})` : ''}
              </option>
            ))}
          </select>
          {errors.parameterKey ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.parameterKey.message}
            </p>
          ) : null}
        </div>
      </div>

      {chosen && !chosen.unitConfirmed ? (
        <InfoNote tone="warning">
          The workbook records no confirmed unit for {chosen.label}. Until a unit is approved here,
          this measurement can never be assessed as conforming, whatever bounds are set. Enter the
          unit you are approving, not the workbook&rsquo;s placeholder.
        </InfoNote>
      ) : null}

      <fieldset className="rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium text-slate-800">
          Applies to (leave blank for &ldquo;any&rdquo;)
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="spec-material" className="text-sm text-slate-700">
              Material
            </label>
            <input id="spec-material" className={`${INPUT_CLASS} mt-1`} {...register('material')} />
          </div>
          <div>
            <label htmlFor="spec-feed" className="text-sm text-slate-700">
              Feed type
            </label>
            <input id="spec-feed" className={`${INPUT_CLASS} mt-1`} {...register('feedType')} />
          </div>
          <div>
            <label htmlFor="spec-point" className="text-sm text-slate-700">
              Sampling point
            </label>
            <input
              id="spec-point"
              className={`${INPUT_CLASS} mt-1`}
              placeholder="AM or BC"
              {...register('samplingPoint')}
            />
          </div>
          <div>
            <label htmlFor="spec-method" className="text-sm text-slate-700">
              Test method
            </label>
            <input id="spec-method" className={`${INPUT_CLASS} mt-1`} {...register('testMethod')} />
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Two approved rules that are equally applicable make a measurement unassessable, so keep
          applicability precise.
        </p>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="spec-unit" className="text-sm font-medium text-slate-800">
            Unit
          </label>
          <input id="spec-unit" className={`${INPUT_CLASS} mt-1`} {...register('unit')} />
          {errors.unit ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.unit.message}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="spec-lower" className="text-sm font-medium text-slate-800">
            Lowest allowed value
          </label>
          <input
            id="spec-lower"
            inputMode="decimal"
            className={`${INPUT_CLASS} mt-1`}
            {...register('lowerBound')}
          />
          {errors.lowerBound ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.lowerBound.message}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="spec-upper" className="text-sm font-medium text-slate-800">
            Highest allowed value
          </label>
          <input
            id="spec-upper"
            inputMode="decimal"
            className={`${INPUT_CLASS} mt-1`}
            {...register('upperBound')}
          />
          {errors.upperBound ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.upperBound.message}
            </p>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-slate-600">
        Bounds are inclusive: a value exactly on the limit is within limit.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="spec-effective" className="text-sm font-medium text-slate-800">
            Applies from (Guyana date)
          </label>
          <input
            id="spec-effective"
            type="date"
            className={`${INPUT_CLASS} mt-1`}
            {...register('effectiveFrom')}
          />
          {errors.effectiveFrom ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.effectiveFrom.message}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-slate-600">
            A new limit applies from this date onwards. Past decisions are never rewritten.
          </p>
        </div>
        <div>
          <label htmlFor="spec-source" className="text-sm font-medium text-slate-800">
            Source or evidence
          </label>
          <input
            id="spec-source"
            className={`${INPUT_CLASS} mt-1`}
            placeholder="e.g. BFF-MAN-03 section A1, approved 2026-11-02"
            {...register('sourceEvidence')}
          />
          {errors.sourceEvidence ? (
            <p role="alert" className="mt-1 text-sm text-red-800">
              {errors.sourceEvidence.message}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <label htmlFor="spec-reason" className="text-sm font-medium text-slate-800">
          Why this limit
        </label>
        <textarea
          id="spec-reason"
          rows={4}
          className={`${INPUT_CLASS} mt-1`}
          {...register('reason')}
        />
        {errors.reason ? (
          <p role="alert" className="mt-1 text-sm text-red-800">
            {errors.reason.message}
          </p>
        ) : null}
      </div>

      {errorMessage ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900">
          The proposal was not saved: {errorMessage}
        </p>
      ) : null}

      <InfoNote>
        Submitting records a <strong>proposal</strong>. It does not change any assessment. A
        different Quality Supervisor has to approve it before it can decide conformity.
      </InfoNote>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Submit proposal for approval'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
