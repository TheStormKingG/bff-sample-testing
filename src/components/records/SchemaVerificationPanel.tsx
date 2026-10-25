/**
 * Row-4 header verification, per operational tab.
 *
 * The browser holds no Google credential, so it cannot read the live sheet
 * itself — the privileged worker does that. When the worker is unreachable
 * this panel still shows the contract the app will enforce, and says plainly
 * that the live headers were NOT read. It never reports a match it has not
 * seen: an unverified workbook must read as unverified, because the write path
 * fails closed on a mismatch (Master Prompt §3, PRD §4.3).
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import { FIRST_DATA_ROW, PROTECTED_HEADER_ROWS, REFERENCE_TABS } from '@/forms/registry';
import { expectedHeaderContract, type SchemaVerificationReport } from '@/hooks/useAdmin';
import { Button, InfoNote } from './common';

function TabContract({
  sheetTab,
  columnCount,
  headers,
  verified,
}: {
  sheetTab: string;
  columnCount: number;
  headers: readonly string[];
  verified:
    | { ok: boolean; checkedAt: string | null; mismatches: readonly { columnLetter: string; expected: string; actual: string }[]; error: string | null }
    | null;
}) {
  const [open, setOpen] = useState(false);

  const status = verified === null
    ? { Icon: HelpCircle, text: 'Live headers not read', tone: 'unknown' as const }
    : verified.error !== null
      ? { Icon: AlertTriangle, text: `Check failed: ${verified.error}`, tone: 'bad' as const }
      : verified.ok
        ? { Icon: CheckCircle2, text: 'Headers match the contract', tone: 'good' as const }
        : {
            Icon: AlertTriangle,
            text: `${verified.mismatches.length} header${verified.mismatches.length === 1 ? '' : 's'} differ — writes are blocked`,
            tone: 'bad' as const,
          };

  return (
    <li className="border-b border-slate-100 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-slate-900">{sheetTab}</p>
          <p className="text-sm text-slate-600">
            {columnCount} columns, header row {PROTECTED_HEADER_ROWS}, data from row{' '}
            {FIRST_DATA_ROW}
          </p>
        </div>
        <p
          className={
            status.tone === 'good'
              ? 'inline-flex items-center gap-1.5 text-sm font-medium text-emerald-900'
              : status.tone === 'bad'
                ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-red-900'
                : 'inline-flex items-center gap-1.5 text-sm text-slate-700'
          }
        >
          <status.Icon aria-hidden className="h-4 w-4 flex-shrink-0" />
          {status.text}
        </p>
      </div>

      {verified !== null && verified.checkedAt !== null ? (
        <p className="mt-0.5 text-xs text-slate-500">
          Checked {formatPlantDateTimeLabelled(new Date(verified.checkedAt))}
        </p>
      ) : null}

      {verified !== null && verified.mismatches.length > 0 ? (
        <table className="mt-2 w-full border-collapse text-left text-sm">
          <caption className="sr-only">Header differences found on {sheetTab}</caption>
          <thead>
            <tr className="text-xs font-semibold uppercase text-slate-600">
              <th scope="col" className="pr-3">
                Column
              </th>
              <th scope="col" className="pr-3">
                Expected
              </th>
              <th scope="col">Found in the sheet</th>
            </tr>
          </thead>
          <tbody>
            {verified.mismatches.map((m) => (
              <tr key={m.columnLetter} className="text-red-900">
                <td className="pr-3 font-mono">{m.columnLetter}</td>
                <td className="pr-3">{m.expected}</td>
                <td>{m.actual === '' ? '(blank)' : m.actual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-2 inline-flex min-h-tap items-center gap-1 text-sm text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
      >
        {open ? (
          <ChevronDown aria-hidden className="h-4 w-4" />
        ) : (
          <ChevronRight aria-hidden className="h-4 w-4" />
        )}
        {open ? 'Hide the expected headers' : 'Show the expected headers'}
      </button>
      {open ? (
        <ol className="mt-2 grid grid-cols-1 gap-x-6 text-sm text-slate-800 sm:grid-cols-2 lg:grid-cols-3">
          {headers.map((header, index) => (
            <li key={`${header}-${index}`} className="py-0.5">
              <span className="mr-2 font-mono text-xs text-slate-500">{index + 1}</span>
              {header}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function SchemaVerificationPanel({
  report,
  loading,
  error,
  onRecheck,
}: {
  report: SchemaVerificationReport | undefined;
  loading: boolean;
  error: unknown;
  onRecheck: () => void;
}) {
  const contract = expectedHeaderContract();
  const errorMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null;

  return (
    <div className="flex flex-col gap-4">
      {report === undefined ? (
        <InfoNote tone="warning">
          {loading
            ? 'Asking the sync worker to read the live header rows…'
            : `The live header rows have NOT been read${errorMessage ? `: ${errorMessage}` : ''}. The contract below is what the application will enforce; until the worker confirms it, treat the workbook as unverified. Writes fail closed on a mismatch, so nothing can be written to a sheet whose headers have drifted.`}
        </InfoNote>
      ) : report.spreadsheetConfigured ? (
        <InfoNote>
          Verified against the configured target workbook
          {report.checkedAt
            ? ` at ${formatPlantDateTimeLabelled(new Date(report.checkedAt))}`
            : ''}
          . The reference tabs {REFERENCE_TABS.join(' and ')} are never written to.
        </InfoNote>
      ) : (
        <InfoNote tone="warning">
          No target spreadsheet is configured. The sync worker refuses to run without one, so no
          sheet can be written — including the draft workbook, which must never be a write target.
        </InfoNote>
      )}

      <ul className="rounded-md border border-slate-200 px-3">
        {contract.map((tab) => {
          const verified = report?.tabs.find((t) => t.stage === tab.stage);
          return (
            <TabContract
              key={tab.stage}
              sheetTab={tab.sheetTab}
              columnCount={tab.columnCount}
              headers={tab.headers}
              verified={
                verified
                  ? {
                      ok: verified.ok,
                      checkedAt: verified.checkedAt,
                      mismatches: verified.mismatches,
                      error: verified.error,
                    }
                  : null
              }
            />
          );
        })}
      </ul>

      <div>
        <Button onClick={onRecheck} disabled={loading}>
          {loading ? 'Checking…' : 'Check the live headers again'}
        </Button>
      </div>
    </div>
  );
}
