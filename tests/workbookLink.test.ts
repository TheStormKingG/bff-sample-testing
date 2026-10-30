/**
 * The workbook link is read from the server, and only an address it recognises
 * becomes something a person can click.
 *
 * Two things are under test and both are security-shaped:
 *
 *  1. The URL is never compiled into the client. That is enforced for real by
 *     `scripts/check-bundle-secrets.mjs`, which fails the DEPLOYMENT when a
 *     Drive file id appears in `dist/`; this file only pins the client's half
 *     of the arrangement — that it asks an endpoint rather than knowing.
 *
 *  2. Whatever comes back is narrowed before it reaches an `href`. The
 *     response is `unknown` at the boundary, and an href is the one place in
 *     this app where a string from elsewhere becomes a thing an operator can
 *     activate with one tap.
 */

import { describe, expect, it } from 'vitest';
import { parseWorkbookLink } from '@/hooks/useWorkbookLink';
import { FUNCTIONS } from '@/hooks/useSamples';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('reading the workbook link', () => {
  it('accepts a configured Google Sheets address', () => {
    const link = parseWorkbookLink({
      configured: true,
      url: 'https://docs.google.com/spreadsheets/d/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678/preview',
    });
    expect(link.configured).toBe(true);
    expect(link.url).toContain('https://docs.google.com/');
  });

  it('treats "no workbook configured" as an answer, not a failure', () => {
    // A deployment that has not been pointed at a workbook should hide the
    // button. Throwing here would paint an error on a screen that is working.
    const link = parseWorkbookLink({ configured: false, url: null });
    expect(link.configured).toBe(false);
    expect(link.url).toBeNull();
  });

  it.each([
    ['javascript:alert(1)', 'a script URL'],
    ['data:text/html,<script>alert(1)</script>', 'a data URL'],
    ['http://docs.google.com/spreadsheets/d/x/preview', 'plain http'],
    ['https://docs.google.evil.com/spreadsheets/d/x', 'a lookalike host'],
    ['https://example.com/spreadsheets/d/x', 'some other host'],
  ])('refuses %s (%s)', (url) => {
    // This value becomes an href. Anything that is not an https Google Sheets
    // address is refused rather than rendered as a clickable target.
    expect(() => parseWorkbookLink({ configured: true, url })).toThrow();
  });

  it.each([null, undefined, 'a string', 42, { configured: true }, { configured: true, url: 7 }])(
    'refuses a malformed response: %s',
    (data) => {
      expect(() => parseWorkbookLink(data)).toThrow();
    },
  );

  it('POSITIVE CONTROL: the guard can pass as well as fail', () => {
    expect(() =>
      parseWorkbookLink({ configured: true, url: 'https://docs.google.com/spreadsheets/d/x/preview' }),
    ).not.toThrow();
  });
});

describe('the client does not know where the workbook is', () => {
  it('names an endpoint instead of an address', () => {
    expect(FUNCTIONS.workbookLink).toBe('workbook-link');
  });

  it('no source file carries a Google Drive file id', () => {
    // The real gate runs over dist/ at deploy time. This one runs on every
    // push and names the file, which is a far faster way to learn you did it
    // than a failed deployment ten minutes later.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|html)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        // The same shape the bundle scanner looks for: a Drive id in a URL.
        if (/\/d\/(?:e\/)?[A-Za-z0-9_-]{25,}/.test(text)) offenders.push(full);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
