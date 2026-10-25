/**
 * Copy and print the permanent sample ID for the bag label.
 *
 * Every route to the ID is keyboard reachable. Print is a real button in the
 * tab order, not a mouse-only gesture, and the full label text sits in a
 * focusable read-only field so a user who cannot print — or whose browser
 * blocks the print window — can still select and copy it with the keyboard
 * alone (Master Prompt §8: "preserve accessible alternate interaction").
 *
 * Nothing here claims success it has not observed: a blocked print window and
 * an unavailable clipboard each say so.
 */

import { useEffect, useRef, useState } from 'react';
import { Copy, Printer, X } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import { stageTitle, type SampleRow } from '@/hooks/useSamples';
import { Button } from './common';

function labelText(sample: SampleRow): string {
  const collected = new Date(sample.collection_instant);
  const when = Number.isNaN(collected.getTime())
    ? `${sample.collection_local_date} ${sample.collection_local_time} (Guyana)`
    : formatPlantDateTimeLabelled(collected);

  const lines = [
    sample.sample_id ?? 'NO SAMPLE ID — DRAFT',
    stageTitle(sample.stage),
    when,
  ];
  if (sample.material) lines.push(`Material: ${sample.material}`);
  if (sample.feed_type) lines.push(`Feed type: ${sample.feed_type}`);
  if (sample.supplier) lines.push(`Supplier: ${sample.supplier}`);
  if (sample.lot_no) lines.push(`Lot: ${sample.lot_no}`);
  if (sample.batch_no) lines.push(`Batch: ${sample.batch_no}`);
  if (sample.run_no) lines.push(`Run: ${sample.run_no}`);
  if (sample.sampling_point) lines.push(`Point: ${sample.sampling_point}`);
  return lines.join('\n');
}

const PRINT_STYLES = `
  @page { margin: 8mm; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 8mm; }
  .id { font-size: 28pt; font-weight: 700; letter-spacing: 1px; margin: 0 0 4mm; }
  .detail { font-size: 11pt; margin: 0 0 1.5mm; }
`;

/**
 * Build the label page as DOM nodes in the new window.
 *
 * Every value here is operator-entered text from the record. Assembling it as
 * an HTML string and writing that out would make correct escaping a
 * prerequisite for safety; `textContent` cannot be escaped wrongly, because it
 * never parses markup at all.
 */
function renderPrintDocument(doc: Document, sample: SampleRow): void {
  doc.title = `Sample label ${sample.sample_id ?? 'draft'}`;

  const style = doc.createElement('style');
  style.textContent = PRINT_STYLES;
  doc.head.appendChild(style);

  labelText(sample)
    .split('\n')
    .forEach((line, index) => {
      const p = doc.createElement('p');
      p.className = index === 0 ? 'id' : 'detail';
      p.textContent = line;
      doc.body.appendChild(p);
    });
}

export function LabelDialog({
  sample,
  onClose,
}: {
  sample: SampleRow;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<string | null>(null);

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

  const text = labelText(sample);

  async function copy() {
    try {
      // Only available in a secure context; a plain-HTTP page has no clipboard.
      await navigator.clipboard.writeText(text);
      setStatus('Label text copied to the clipboard.');
    } catch {
      textRef.current?.focus();
      textRef.current?.select();
      setStatus(
        'This browser did not allow an automatic copy. The label text is selected below — press Ctrl+C (or Cmd+C) to copy it.',
      );
    }
  }

  function print() {
    const win = window.open('', '_blank', 'width=420,height=320');
    if (!win) {
      setStatus(
        'The print window was blocked by the browser. Allow pop-ups for this site, or copy the label text below and print it from another application.',
      );
      return;
    }
    renderPrintDocument(win.document, sample);
    win.focus();
    win.print();
    setStatus('The print dialog was opened in a new window.');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="label-dialog-title"
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="label-dialog-title" className="text-xl font-semibold text-slate-900">
            Sample label
          </h2>
          <Button onClick={onClose} ariaLabel="Close the label dialog">
            <X aria-hidden className="h-4 w-4" />
            Close
          </Button>
        </div>

        <p className="mt-3 break-all rounded-md border-2 border-slate-900 p-3 text-center text-3xl font-bold tracking-wide text-slate-900">
          {sample.sample_id ?? 'No sample ID — this record is still a draft'}
        </p>

        <label htmlFor="label-dialog-text" className="mt-4 block text-sm font-medium text-slate-800">
          Full label text
        </label>
        <textarea
          id="label-dialog-text"
          ref={textRef}
          readOnly
          rows={8}
          value={text}
          className="mt-1 w-full rounded-md border border-slate-300 p-2 font-mono text-sm text-slate-900 focus:border-bff-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
        />

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void copy()}>
            <Copy aria-hidden className="h-4 w-4" />
            Copy label text
          </Button>
          <Button onClick={print}>
            <Printer aria-hidden className="h-4 w-4" />
            Print label
          </Button>
        </div>

        <p role="status" aria-live="polite" className="mt-3 min-h-[1.5rem] text-sm text-slate-700">
          {status}
        </p>

        <p className="mt-2 text-sm text-slate-600">
          Write this ID on the sample bag. It never changes, even if a result is corrected later.
        </p>
      </div>
    </div>
  );
}
