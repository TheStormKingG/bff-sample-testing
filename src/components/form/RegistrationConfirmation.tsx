import { useState } from 'react';
import { CheckCircle2, ClipboardCopy, Printer } from 'lucide-react';

import { STAGE_SCHEMAS } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import { CAPTURE_STATE_LABELS, type CaptureState } from '@/lib/workflow';
import { SHEET_SYNC_LABELS, type SheetSyncState } from './saveState';
import { DerivedResultsTable } from './DerivedResultsTable';

export interface RegistrationConfirmationProps {
  readonly stage: Stage;
  /** The immutable human label issued by the server. */
  readonly sampleId: string;
  /** The server's registration instant, as an ISO string or a Date. */
  readonly registeredAt: Date | string;
  readonly captureState: CaptureState;
  readonly sheetSync?: SheetSyncState;
  /**
   * Values the server worked out, by registry field key. Shown immediately
   * because for a sieve test the calculated figures ARE the result the
   * operator came for, and there is nowhere else they would see them without
   * navigating away from the screen that tells them to write the ID on the bag.
   */
  readonly derived?: Readonly<Record<string, string>>;
  /** Continue to results entry, when the actor may enter them. */
  readonly onEnterResults?: () => void;
  readonly onRegisterAnother?: () => void;
  readonly onDone?: () => void;
}

/**
 * The post-registration confirmation screen (PRD §11, §3.3, FR-018).
 *
 * The sample ID is the physical link between a bag of feed in the mill and this
 * record, so the single most important thing on this screen is the instruction
 * to write it on the bag — stated before the navigation, in plain words, in
 * large type. A registration whose ID never makes it onto the bag produces an
 * orphan record and an untraceable sample.
 *
 * The ID is rendered in a monospace font with wide tracking because it will be
 * copied by hand onto a bag with a marker pen, and `0`/`O` and `1`/`I` have to
 * be distinguishable.
 *
 * Status and sheet-sync state are shown as two SEPARATE facts. The sample is
 * registered in the ledger; the spreadsheet row is written afterwards by the
 * sync worker. Collapsing them would let this screen claim a Google Sheets
 * write that has not happened.
 */
export function RegistrationConfirmation({
  stage,
  sampleId,
  registeredAt,
  captureState,
  sheetSync = 'pending',
  derived,
  onEnterResults,
  onRegisterAnother,
  onDone,
}: RegistrationConfirmationProps): JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const schema = STAGE_SCHEMAS[stage];
  const instant = registeredAt instanceof Date ? registeredAt : new Date(registeredAt);
  const timestampValid = !Number.isNaN(instant.getTime());

  const copy = async (): Promise<void> => {
    try {
      // Absent in insecure contexts and in jsdom; the fallback is to tell the
      // operator to copy it by hand rather than to pretend it worked.
      await navigator.clipboard.writeText(sampleId);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      {/* The printable bag label. Only this block reaches the printer. */}
      <div className="hidden print:block">
        <p className="text-sm">BFF Sample Testing — {schema.title}</p>
        <p className="my-2 font-mono text-4xl font-bold tracking-widest">{sampleId}</p>
        {timestampValid ? (
          <p className="text-sm">{formatPlantDateTimeLabelled(instant)}</p>
        ) : null}
      </div>

      <div className="print:hidden">
        <p className="flex items-center gap-2 text-lg font-bold text-green-900">
          <CheckCircle2 aria-hidden="true" className="h-6 w-6 shrink-0" />
          Sample registered
        </p>

        <div className="mt-4 rounded-lg border-2 border-slate-300 bg-white p-4">
          <h1 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Sample ID
          </h1>
          <p className="mt-1 break-all font-mono text-3xl font-bold tracking-widest text-slate-900">
            {sampleId}
          </p>

          <p className="mt-4 rounded border-2 border-blue-700 bg-blue-50 p-3 text-lg font-bold text-blue-900">
            Write this ID on the sample bag now.
          </p>

          <dl className="mt-4 space-y-2 text-base">
            <div>
              <dt className="font-semibold text-slate-700">Form</dt>
              <dd className="text-slate-900">
                {schema.ordinal}. {schema.title}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-700">Registered at</dt>
              <dd className="text-slate-900">
                {timestampValid
                  ? formatPlantDateTimeLabelled(instant)
                  : 'Time not available from the server'}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-700">Status</dt>
              <dd className="text-slate-900">{CAPTURE_STATE_LABELS[captureState]}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-700">Spreadsheet</dt>
              <dd className="text-slate-900">{SHEET_SYNC_LABELS[sheetSync]}</dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
            >
              <ClipboardCopy aria-hidden="true" className="h-5 w-5" />
              Copy ID
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
            >
              <Printer aria-hidden="true" className="h-5 w-5" />
              Print label
            </button>
          </div>

          <p aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm font-medium">
            {copyState === 'copied' ? (
              <span className="text-green-900">Sample ID copied.</span>
            ) : null}
            {copyState === 'failed' ? (
              <span className="text-red-900">
                Could not copy automatically. Select the ID above and copy it by hand.
              </span>
            ) : null}
          </p>
        </div>

        {derived !== undefined && Object.keys(derived).length > 0 && (
          <DerivedResultsTable stage={stage} derived={derived} className="mt-5" />
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {onEnterResults !== undefined ? (
            <button
              type="button"
              onClick={onEnterResults}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-blue-700 px-4 py-2 text-base font-bold text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
            >
              Enter test results
            </button>
          ) : null}
          {onRegisterAnother !== undefined ? (
            <button
              type="button"
              onClick={onRegisterAnother}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
            >
              Register another
            </button>
          ) : null}
          {onDone !== undefined ? (
            <button
              type="button"
              onClick={onDone}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2"
            >
              Back to forms
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
