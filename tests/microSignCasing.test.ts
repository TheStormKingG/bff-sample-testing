/**
 * No micrometre is ever rendered through `text-transform: uppercase`.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * CSS `uppercase` maps µ (U+00B5, MICRO SIGN) to Μ (U+039C, GREEK CAPITAL
 * MU). At a small size, in the sans-serif this app uses, Μ is
 * indistinguishable from a Latin M.
 *
 * So a column heading written "Aperture (µm)" renders as "APERTURE (MM)",
 * and the screen that sets the sieve apertures presents micrometres as
 * millimetres — a thousandfold unit error, on a quality record, produced by
 * a text transform and visible only in a screenshot of the running page.
 * That is exactly where it was found.
 *
 * ===========================================================================
 * WHY A SOURCE SCAN AND NOT A RENDER
 * ===========================================================================
 * jsdom applies no Tailwind, so `getComputedStyle` reports no
 * `text-transform` for a `className` of "uppercase" and a rendering test
 * would pass against the defect. The class and the text are both in the
 * source, which is where the pairing can actually be seen.
 *
 * The scan is deliberately simple: for every element carrying `uppercase`,
 * look at its own inline text. It will not catch a micro sign arriving
 * through a variable, which is the limit of what a source scan can claim —
 * and `UnitBadge`, the component that renders EVERY unit this application
 * knows, deliberately carries no `uppercase` at all, which is the structural
 * half of the same guarantee.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const MICRO = 'µ';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.tsx') || full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Text rendered ANYWHERE INSIDE an element whose className says uppercase.
 *
 * The SUBTREE, not the element's own text, and the first version of this
 * scanner got that wrong — it looked only at the immediate text and reported
 * a clean codebase against the live defect. `text-transform` INHERITS: the
 * class was on a `<tr>` and the micro sign was in a `<th>` two lines below
 * it. A scanner that cannot see a child cannot see this bug at all.
 *
 * Depth is tracked on the tag name, so a nested element of the same kind
 * does not end the subtree early. Self-closing tags are not counted.
 */
function uppercasedText(source: string): string[] {
  const out: string[] = [];
  const opener = /<([A-Za-z][\w.]*)\s[^>]*className=\{?["'`][^"'`]*\buppercase\b[^"'`]*["'`][^>]*?(\/?)>/g;

  for (const match of source.matchAll(opener)) {
    const tag = match[1]!;
    if (match[2] === '/') continue; // self-closing: no subtree
    const from = match.index! + match[0].length;

    let depth = 1;
    let cursor = from;
    const tags = new RegExp(`<(/?)${tag}(\\s[^>]*?)?(/?)>`, 'g');
    tags.lastIndex = from;
    let step: RegExpExecArray | null;
    while ((step = tags.exec(source)) !== null) {
      if (step[1] === '/') depth--;
      else if (step[3] !== '/') depth++;
      cursor = step.index;
      if (depth === 0) break;
    }

    const subtree = source.slice(from, depth === 0 ? cursor : from);
    // Strip tags and JSX expressions, leaving the literal text that renders.
    out.push(subtree.replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' '));
  }
  return out;
}

describe('the micro sign never passes through an uppercase transform', () => {
  it('INSTRUMENT CHECK: the scanner sees uppercased text at all', () => {
    // A scanner that matched nothing would report a clean codebase in exactly
    // the same words as a correct one.
    const seen = sourceFiles(SRC).flatMap((f) => uppercasedText(readFileSync(f, 'utf8')));
    expect(seen.length, 'no uppercased text found — the scanner is broken').toBeGreaterThan(3);
    expect(
      seen.some((t) => t.trim() !== ''),
      'every match was empty — the text capture is broken',
    ).toBe(true);
  });

  it('INSTRUMENT CHECK: it would catch the defect it was written for', () => {
    // THE SHAPE THAT ACTUALLY OCCURRED: the class on a row, the micro sign in
    // a cell inside it. The first scanner looked only at an element's own
    // text and passed against exactly this, which is why the control below is
    // nested and not flat.
    const planted = [
      '<tr className="text-xs font-semibold uppercase tracking-wide">',
      '  <th className="py-2">Position</th>',
      `  <th className="py-2">Aperture (${MICRO}m)</th>`,
      '</tr>',
    ].join('\n');
    expect(uppercasedText(planted).some((t) => t.includes(MICRO))).toBe(true);

    // And the same text WITHOUT the transform is not reported, or the scan
    // would flag every micrometre in the application.
    const safe = planted.replace(' uppercase', '');
    expect(uppercasedText(safe).some((t) => t.includes(MICRO))).toBe(false);
  });

  it('finds no micro sign inside an uppercased element', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const text of uppercasedText(readFileSync(file, 'utf8'))) {
        if (text.includes(MICRO)) {
          offenders.push(
            `${file.replace(process.cwd() + '/', '')}: "${text.trim()}" renders through ` +
              `text-transform: uppercase, which turns µ into Greek capital Mu and reads as M. ` +
              `Micrometres would be shown as millimetres.`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the unit badge free of any case transform, for every unit at once', () => {
    // The structural half: `UnitBadge` renders every unit the registry
    // declares, so one `uppercase` there would mis-state µm on every form in
    // the application rather than on one screen.
    const badge = readFileSync(join(SRC, 'components/form/UnitBadge.tsx'), 'utf8');
    expect(badge).not.toContain('uppercase');
    expect(badge).not.toContain('capitalize');
  });
});
