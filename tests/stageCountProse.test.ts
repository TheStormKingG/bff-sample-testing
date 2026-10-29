/**
 * No sentence on the screen restates how many stages there are.
 *
 * ===========================================================================
 * WHY THIS GATE EXISTS
 * ===========================================================================
 * Adding DGM as the eighth stage silently falsified five separate sentences
 * that had counted the stages by hand. Two of them were RENDERED COPY and
 * shipped to production wrong:
 *
 *   - the Samples page offered to "Search every sample from all seven forms",
 *     directly above a filter listing eight;
 *   - the dashboard described "The seven sample testing logs used in the feed
 *     factory" to every reader who may not record.
 *
 * Nothing broke. No test failed. The application kept working perfectly while
 * telling the operator something untrue, which is the whole hazard: a count
 * written in prose has no referent the compiler can check, so it rots in
 * silence and is found by a person reading the screen, if at all.
 *
 * The dashboard's own warning line gets this right — it derives
 * `stagesWithoutFrequency` and renders "5 of 8 stages have no approved
 * sampling frequency", which was correct the moment DGM existed. The rule is
 * therefore: a count shown to a user is DERIVED or it is ABSENT. Never typed.
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT CHECK
 * ===========================================================================
 * Comments. Several say "seven" correctly and must keep saying it:
 * `src/lib/dgm.ts` describes seven sieve positions, and `registry.ts` contrasts
 * the authored DGM tab with "the other seven tabs". Flagging those would be a
 * false positive of exactly the kind that trains people to ignore a gate.
 * So the source is stripped of comments first, and only what can reach a
 * screen is searched.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_SCHEMAS } from '@/forms/registry';

// Same convention as tests/registryDatabaseContract.test.ts: vitest runs
// from the repository root.
const SRC = join(process.cwd(), 'src');

/**
 * Remove comments, leaving string and template literals intact.
 *
 * A line-based rule is not enough: the stalest sentence of the five lived
 * inside a multi-line {@code /* *\/} JSX comment, and a naive scan would have
 * reported it forever. This tracks whether it is inside a string, so an
 * apostrophe or a `//` inside a URL does not throw it off.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** Every .ts/.tsx file under src/, recursively. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { found.push(...sources(full)); continue; }
    if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * A number of stages, written out. Both the words and the digits, because
 * "all 7 forms" rots exactly as quietly as "all seven forms".
 */
const COUNTED_STAGES =
  /\b(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:sample[\s-]?testing\s+)?(forms?|stages?)\b/gi;

describe('no screen says how many stages there are', () => {
  const files = sources(SRC);

  it('reads a meaningful number of source files', () => {
    // Without this the sweep below could pass by scanning nothing at all —
    // the failure mode that let a hand-maintained contract go unchecked in
    // 0002_samples.sql for the life of the project.
    expect(files.length).toBeGreaterThan(40);
  });

  it('POSITIVE CONTROL: the matcher finds the sentence that actually shipped', () => {
    const shipped = 'Search every sample from all seven forms.';
    expect(shipped.match(COUNTED_STAGES)).not.toBeNull();
    expect('Search every sample from all 8 forms.'.match(COUNTED_STAGES)).not.toBeNull();
    expect('Search every sample from every form.'.match(COUNTED_STAGES)).toBeNull();
  });

  it('POSITIVE CONTROL: the comment stripper really removes comments', () => {
    // If stripComments silently returned '' this suite would pass vacuously;
    // if it returned its input unchanged it would flag the legitimate
    // "seven sieve positions" comments. Both directions are pinned.
    const sample = [
      'const a = "keep me";',
      '// drop seven forms',
      '/* drop eight stages */',
      'const url = "https://x/y"; // drop',
      'const t = `seven forms`;',
    ].join('\n');
    const stripped = stripComments(sample);
    expect(stripped).toContain('keep me');
    expect(stripped).toContain('https://x/y');
    expect(stripped).toContain('`seven forms`');
    expect(stripped).not.toContain('drop');
  });

  it('no rendered string counts the stages', () => {
    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(COUNTED_STAGES)) {
        offences.push(`${file.slice(SRC.length + 1)}: "${match[0]}"`);
      }
    }
    expect(
      offences,
      'A count shown to a user must be derived from the registry, not typed. ' +
        'These were typed, and the next stage will falsify them silently:\n' +
        offences.join('\n'),
    ).toEqual([]);
  });

  it('and the registry is where the real number lives', () => {
    // The gate above only forbids the hand-written count. This names the
    // thing that should be read instead, so the fix is obvious from the test.
    expect(Object.keys(STAGE_SCHEMAS).length).toBe(8);
  });
});
