export interface HelpHintProps {
  readonly id: string;
  readonly text: string | undefined;
}

/**
 * Inline help, always visible.
 *
 * Deliberately NOT a tooltip or a collapsed disclosure. This app is used by
 * plant operators with limited literacy on a phone in a feed mill; help that
 * explains what GSD, PDI or urease mean is useless if it is hidden behind a
 * hover target nobody discovers. The text is quoted verbatim from the workbook
 * `Read me` tab, because PRD §11 requires production vocabulary and forbids
 * rewording technical units.
 */
export function HelpHint({ id, text }: HelpHintProps): JSX.Element | null {
  if (text === undefined || text.trim() === '') return null;
  return (
    <p id={id} className="mt-1 text-sm leading-snug text-slate-600">
      {text}
    </p>
  );
}
