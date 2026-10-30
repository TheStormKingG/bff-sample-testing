/**
 * Emit the spreadsheet row the server would send for a DGM registration, as a
 * psql variable file, so SQL can be checked against what TypeScript ACTUALLY
 * produces rather than against a transcription of it.
 *
 * Used by scripts/verify-dgm-trigger.sh. Run from the repository root:
 *   npx vite-node scripts/dgm-projected-row.ts <output.sql>
 */
import { writeFileSync } from 'node:fs';
import { validateStagePayload } from '../supabase/functions/_shared/validation.ts';

/** The worked example printed in the lab's own DGM workbook: 202 g of "BF". */
const WORKED: Array<[number, number]> = [
  [370, 370], [398, 444], [388, 472], [368, 430], [362, 372], [330, 330], [330, 330],
];

function payload(masses: Array<[number, number]>): Record<string, unknown> {
  const v: Record<string, unknown> = {
    collection_date: '2026-10-29', collection_time: '09:30',
    feed_type: 'LOCAL TRIGGER CHECK', batch_no: 'LOCAL-DGM-01',
    sampled_by: 'local harness', sieve_series: 'abnt-standard-7',
    tested_by_qo: 'local harness',
  };
  masses.forEach(([tare, gross], i) => {
    v[`sieve${i + 1}_tare_g`] = String(tare);
    v[`sieve${i + 1}_gross_g`] = String(gross);
  });
  return v;
}

function literal(masses: Array<[number, number]>): string {
  const r = validateStagePayload({ stage: 'dgm', phase: 'registration', values: payload(masses) });
  if (!r.ok) throw new Error('the harness payload no longer validates: ' + JSON.stringify(r.issues));
  // Postgres text[] literal. Cells contain double quotes nowhere today, but
  // doubling them costs nothing and a future label may.
  return '{' + r.row.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',') + '}';
}

const out = process.argv[2];
if (out === undefined) throw new Error('usage: dgm-projected-row.ts <output.sql>');

writeFileSync(
  out,
  `\\set worked_row '${literal(WORKED)}'\n` +
  // Every gross mass equal to its tare: every share is a 0/0, so seven of the
  // nine computed cells go blank and the trigger must DELETE their rows.
  `\\set nothing_row '${literal(WORKED.map(([t]) => [t, t] as [number, number]))}'\n`,
);
