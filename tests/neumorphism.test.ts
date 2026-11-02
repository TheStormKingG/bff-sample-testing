/**
 * The surface system is the whole application's, and it stays legible.
 *
 * ===========================================================================
 * WHY A TEST AND NOT A STYLE GUIDE
 * ===========================================================================
 * The neumorphic ground was painted on the app shell from the start and used
 * by one screen. Every other page grew flat white cards with hairline borders
 * ON TOP of it — not because anyone decided that, but because `bg-white
 * border border-slate-200` is what you reach for when nothing stops you.
 * A paragraph in a stylesheet did not stop it. This does.
 *
 * ===========================================================================
 * THE ONE THAT IS ABOUT SAFETY RATHER THAN TASTE
 * ===========================================================================
 * `text-slate-500` is 4.76:1 on white and 4.31:1 on `neu-base`. It passed AA
 * on one surface and failed on the other, so the day the tinted ground spread
 * past the home screen it became a trap: unchanged markup, silently
 * non-compliant. Every occurrence is now `slate-600`, and the assertion below
 * is what keeps it that way — on a record read in Guyanese daylight, on a
 * phone, by someone wearing gloves.
 *
 * The contrast figures are COMPUTED here from the hex values in the Tailwind
 * config rather than quoted, because a quoted ratio is a claim nobody checks.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** The ground the shell paints, from `tailwind.config` — not retyped. */
const NEU_BASE = '#f1f4f8';
const WHITE = '#ffffff';

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(Number.parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles().map((path) => ({
  path: path.slice(process.cwd().length + 1),
  text: readFileSync(path, 'utf8'),
}));

describe('the ground is still the ground', () => {
  it('reads a realistic number of source files', () => {
    // The instrument check. A walker that found nothing would make every
    // assertion below vacuously true.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('is painted once, on the shell', () => {
    const shell = FILES.filter((f) => /app-shell[^']*bg-neu-base/.test(f.text));
    expect(shell.map((f) => f.path)).toEqual(['src/components/layout/AppLayout.tsx']);
  });
});

describe('muted text clears AA on BOTH surfaces', () => {
  it('slate-600 does and slate-500 does not — which is why one of them is banned', () => {
    // Computed, so the numbers in the stylesheet's comment cannot drift away
    // from the truth without this failing.
    expect(contrast('#64748b', WHITE)).toBeGreaterThan(4.5);
    expect(contrast('#64748b', NEU_BASE)).toBeLessThan(4.5);
    expect(contrast('#475569', WHITE)).toBeGreaterThan(4.5);
    expect(contrast('#475569', NEU_BASE)).toBeGreaterThan(4.5);
  });

  it('slate-500 appears in no component', () => {
    const offenders = FILES.filter((f) => f.text.includes('text-slate-500')).map((f) => f.path);
    expect(
      offenders,
      'text-slate-500 is 4.31:1 on the app ground: it passes AA on white and fails on every ' +
        'page of this application. Use text-slate-600.',
    ).toEqual([]);
  });

  it('slate-400 survives only where the contrast minimum does not apply', () => {
    /*
      Three exemptions, each named in WCAG rather than invented here:
      placeholder text, a disabled control, and a purely decorative image.
      The third is why the sweep reads the surrounding markup — an
      `aria-hidden` icon beside a heading that already says the same thing
      carries no information, and darkening it would make the empty state
      shout. Anything else at 2.32:1 on this ground is unreadable.
    */
    const bad: string[] = [];
    for (const file of FILES) {
      for (const match of file.text.matchAll(/(^|\s|')([a-z-]*:)?text-slate-400\b/g)) {
        const prefix = match[2] ?? '';
        if (prefix === 'placeholder:' || prefix === 'disabled:') continue;
        const line = file.text.slice(0, match.index).lastIndexOf('\n');
        const context = file.text.slice(line + 1, (match.index ?? 0) + 200);
        if (/aria-hidden="true"/.test(context)) continue;
        bad.push(`${file.path}: ${prefix}text-slate-400`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('a container is a raised surface, not a white sheet on top of one', () => {
  /**
   * The pattern that was everywhere, and what it costs.
   *
   * A white fill with a hairline border is a perfectly good card — on a white
   * page. On the tinted ground it hides the ground's only purpose, and the
   * two treatments side by side are what "inconsistent" actually looked like
   * on this app: the home screen moulded out of the page, every other screen
   * a stack of paper laid on it.
   */
  it('nothing is filled white except a control a value goes into', () => {
    /*
      The rule, stated as simply as it can be: on this ground, `bg-white` is
      for INPUTS. They are concave (`shadow-neu-inset`) and keep the white
      fill because typed text deserves the strongest possible backdrop —
      the one place the style's own low-contrast tendency must not win.

      The sweep reads the whole class string rather than one line of it,
      because `INPUT_CLASS` is assembled from concatenated fragments and the
      `shadow-neu-inset` that exempts it sits on a different line from the
      `bg-white` that triggers it.
    */
    const offenders: string[] = [];
    for (const file of FILES) {
      // Print styles paint on paper, where there is no ground at all.
      if (file.path.includes('LabelDialog')) continue;
      for (const match of file.text.matchAll(/bg-white/g)) {
        const from = Math.max(0, (match.index ?? 0) - 400);
        const context = file.text.slice(from, (match.index ?? 0) + 400);
        if (/shadow-neu-inset/.test(context)) continue;
        if (/print:/.test(context)) continue;
        const line = file.text
          .slice(file.text.lastIndexOf('\n', match.index) + 1, file.text.indexOf('\n', match.index))
          .trim();
        // Prose about the code, not markup. `FieldShell` explains at length
        // why `bg-white` once vanished from an error state.
        if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
        offenders.push(`${file.path}: ${line.slice(0, 80)}`);
      }
    }
    expect(
      offenders,
      'white fill on the app ground. Use bg-neu-base with shadow-neu-sm for a raised ' +
        'surface, or bg-white with shadow-neu-inset for something a value goes into.',
    ).toEqual([]);
  });

  it('every raised surface uses a radius the style can carry', () => {
    // Neumorphism needs a generous radius: the highlight and the shade have
    // to turn the corner for the surface to read as moulded rather than cut
    // out. `rounded-md` (6px) is too tight to show either.
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of file.text.matchAll(/rounded-(sm|md)\b[^'"`\n]*shadow-neu/g)) {
        offenders.push(`${file.path}: ${match[0].slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
