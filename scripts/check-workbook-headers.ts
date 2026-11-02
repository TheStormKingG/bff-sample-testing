/**
 * Read row 4 of every operational tab out of the live workbook and compare it
 * to the registry, cell by cell, by position.
 *
 * ===========================================================================
 * WHY THIS EXISTS AND WHEN TO RUN IT
 * ===========================================================================
 * A spreadsheet restructure is verified by reading the data back, never by
 * looking at it. Three screenshots of the same row leave you reasoning about
 * JPEG colour and column widths; one read-back parsed and diffed by position
 * answers the only question that matters — does column AD hold the heading
 * the system will write under it — in seconds and without ambiguity.
 *
 * It is the same comparison the Edge Functions make before every write
 * (`diffHeaders`), run from a laptop against the same registry, so a pass
 * here means the workbook will not fence itself off. It is deliberately NOT
 * a substitute for that check: this one has no service account, reads rather
 * than writes, and cannot latch anything.
 *
 * ===========================================================================
 * THE SPREADSHEET ID IS NOT IN THIS FILE, AND MUST NOT BE
 * ===========================================================================
 * Build rule 1: the id is an Edge Function secret with no default anywhere in
 * this codebase, never in a `VITE_*` variable, never in `src/**`, never in the
 * bundle. It is passed in for the length of one command:
 *
 *     BFF_SPREADSHEET_ID=... npx vite-node scripts/check-workbook-headers.ts
 *
 * The id is never printed, including on error.
 *
 * It reads through the public `gviz` CSV endpoint, which needs no credential —
 * which is itself worth knowing: this workbook is readable by anyone holding
 * its link, and that is a standing finding, not a feature this script relies
 * on by choice.
 */

import { STAGE_SCHEMAS } from '../src/forms/registry.ts';
import { expectedHeaders } from '../src/forms/sheetMapping.ts';
import { STAGES, type Stage } from '../src/forms/types.ts';

const id = process.env['BFF_SPREADSHEET_ID'];
if (id === undefined || id.trim() === '') {
  console.error(
    'Set BFF_SPREADSHEET_ID for this command. It is a secret: do not add it to .env,\n' +
      'and do not paste it into any file in this repository.',
  );
  process.exit(2);
}

/** One row of CSV as Sheets renders it: every cell quoted, commas inside. */
function parseCsvRow(text: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') break;
    else cell += c;
  }
  cells.push(cell);
  return cells;
}

async function headerRowOf(stage: Stage): Promise<string[]> {
  const schema = STAGE_SCHEMAS[stage];
  const url =
    `https://docs.google.com/spreadsheets/d/${id}/gviz/tq` +
    `?tqx=out:csv&headers=0&sheet=${encodeURIComponent(schema.sheetTab)}` +
    `&range=A4:${schema.lastColumn}4`;
  const response = await fetch(url);
  if (!response.ok) {
    // The id would otherwise appear in a fetch error's message.
    throw new Error(`Could not read "${schema.sheetTab}": HTTP ${response.status}`);
  }
  return parseCsvRow((await response.text()).trim());
}

let failed = 0;
for (const stage of STAGES) {
  const schema = STAGE_SCHEMAS[stage];
  let live: string[];
  try {
    live = await headerRowOf(stage);
  } catch (error) {
    console.log(`FAIL  ${schema.sheetTab} — ${error instanceof Error ? error.message : error}`);
    failed++;
    continue;
  }

  // `null`: the shipped sieve table. An administrator who has re-designated a
  // sieve should expect the live headings to follow it, and the sync worker
  // rewrites them — so a mismatch reported here right after such an edit is
  // the workbook not yet caught up rather than a restructure gone wrong.
  const want = expectedHeaders(stage, null);
  const problems: string[] = [];
  if (live.length !== want.length) {
    problems.push(`width: live ${live.length} cells, contract ${want.length}`);
  }
  want.forEach((heading, i) => {
    const actual = (live[i] ?? '').trim();
    if (actual !== heading) {
      problems.push(
        `${schema.fields[i]!.columnLetter}: live ${JSON.stringify(actual)} ` +
          `!= ${JSON.stringify(heading)}`,
      );
    }
  });

  if (problems.length === 0) {
    console.log(`ok    ${schema.sheetTab} — ${want.length} columns, 0 mismatches`);
  } else {
    failed++;
    console.log(`FAIL  ${schema.sheetTab}`);
    for (const problem of problems) console.log(`        ${problem}`);
  }
}

console.log(
  failed === 0
    ? '\nEvery tab matches the registry. The writer will not fence the workbook off.'
    : `\n${failed} tab(s) do not match. Writing is blocked until they do.`,
);
process.exit(failed === 0 ? 0 : 1);
