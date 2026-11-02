import { useCallback, useEffect, useRef, useState } from 'react';

export interface HelpHintProps {
  readonly id: string;
  readonly text: string | undefined;
}

/**
 * Inline help: one line by default, the rest one tap away.
 *
 * ===========================================================================
 * WHY IT IS CLAMPED AND NOT SHORTENED
 * ===========================================================================
 * A hint that runs to four lines above a field pushes the field itself off
 * the screen, and several of these are long: the pellet-temperature hint is
 * 179 characters and the mycotoxin one is 153. Cutting them to a line each
 * was the obvious fix and it is the wrong one, because of what is IN them.
 *
 * `mash_temperature_c` says: "The workbook Read me tab notes 84 to 86 °C
 * after conditioning — reference only, not an approved limit." That clause
 * exists because FR-009 and UAT-05 forbid this application implying an
 * acceptance limit nobody approved, and 0 of 34 workbook limits are
 * approved. Deleting it to save a line would have the app quietly assert the
 * opposite of what it was built to say. The same is true of the urease, PDI
 * and GSD hints, which are an operator's glossary at the point of entry —
 * PRD §11 requires production vocabulary and this screen is where it is
 * needed.
 *
 * So the text stays whole and the LAYOUT gives way: one line, then "More".
 *
 * ===========================================================================
 * WHY THIS IS NOT THE TOOLTIP THIS COMPONENT USED TO FORBID
 * ===========================================================================
 * The earlier version of this file refused to hide help behind a disclosure,
 * on the grounds that "help that explains what GSD, PDI or urease mean is
 * useless if it is hidden behind a hover target nobody discovers". That
 * reasoning is kept and is exactly why this is not that:
 *
 *  - The help is still VISIBLE. A line of it is on the screen unprompted,
 *    so its existence is never in question — there is nothing to discover.
 *  - The control is a BUTTON with a word on it, not a hover target. It works
 *    by touch, which is the only input this app's users have.
 *  - It appears ONLY when there is something folded. A hint that already fits
 *    renders exactly as it did before, with no control at all.
 *
 * ===========================================================================
 * WHY OVERFLOW IS MEASURED AND NOT COUNTED
 * ===========================================================================
 * Whether a string needs a second line depends on the font, the column width
 * and the device — a character cap would be wrong on half of them. The
 * element is measured instead (`scrollHeight` against `clientHeight` while
 * clamped) and re-measured when it is resized, so the control appears on a
 * 320px phone and not on a tablet for the same text. In jsdom every element
 * reports zero height, so no control renders and the full text is in the DOM
 * either way, which is what the unit tests see.
 */
export function HelpHint({ id, text }: HelpHintProps): JSX.Element | null {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    // Only meaningful while clamped: expanded, scrollHeight === clientHeight.
    if (expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, text]);

  if (text === undefined || text.trim() === '') return null;

  /*
    One line everywhere, TWO inside a paired sample-details cell — expressed
    as a descendant variant rather than a prop, so the layout that creates the
    narrow column is the thing that widens the allowance, and no input
    component has to thread a flag down to get it right. The clamp governs
    `clientHeight`, so the overflow measurement above follows it for free.
  */
  const clamp = expanded ? '' : 'line-clamp-1 [.paired-cell_&]:line-clamp-2';

  return (
    <div className="mt-1">
      {/*
        The id stays on the TEXT, not on this wrapper: `aria-describedby`
        points at it and must resolve to the words, never to the words plus a
        button whose label would then be read as part of the description.
      */}
      <p id={id} ref={ref} className={`text-sm leading-snug text-slate-600 ${clamp}`}>
        {text}
      </p>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={id}
          className="mt-0.5 rounded text-sm font-semibold text-bff-700 underline underline-offset-2 hover:text-bff-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-700"
        >
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}
