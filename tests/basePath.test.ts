/**
 * The public base path is one value, in one file, used by everything.
 *
 * ===========================================================================
 * WHY THIS IS A GATE AND NOT A CONVENTION
 * ===========================================================================
 * Vite compiles `base` into every asset URL in index.html. If the end-to-end
 * suite runs against one base and the deployment builds with another, the
 * routing specs pass against a path the live site never serves — which is the
 * precise failure `e2e/pages-routing.spec.ts` exists to catch, defeated by
 * testing the wrong thing. The two workflows previously derived the base
 * independently from the repository name; they agreed, but only by arithmetic
 * coincidence, and the move to bountyfarmltd.com broke that coincidence
 * because the PUBLIC path is no longer the repository name.
 *
 * So the value lives in `.github/base-path` and both workflows read it. This
 * file asserts they do, and that the canonical redirect in index.html names
 * the same path — three places that must agree, checked rather than hoped.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const BASE_PATH_FILE = '.github/base-path';
const WORKFLOWS = ['.github/workflows/deploy-pages.yml', '.github/workflows/ci.yml'];

describe('the public base path', () => {
  const raw = read(BASE_PATH_FILE);
  const base = raw.trim();

  it('is a single, absolute, slash-terminated path', () => {
    // Slash-terminated because Vite joins it to asset names by concatenation:
    // '/FeedQualityApp' + 'assets/x.js' is '/FeedQualityAppassets/x.js'.
    expect(raw.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(base.startsWith('/'), `${BASE_PATH_FILE} must start with /`).toBe(true);
    expect(base.endsWith('/'), `${BASE_PATH_FILE} must end with /`).toBe(true);
    expect(base).not.toContain(' ');
  });

  it.each(WORKFLOWS)('%s reads it rather than deriving its own', (workflow) => {
    const yaml = read(workflow);
    expect(yaml, `${workflow} no longer reads ${BASE_PATH_FILE}`).toContain(BASE_PATH_FILE);
    // The old derivation computed a base from the repository name. Leaving it
    // in place beside the file read would be two sources again, and the one
    // that wins would depend on step order.
    expect(yaml, `${workflow} still derives a base from the repository name`).not.toMatch(
      /base="\/\$repo/,
    );
  });

  it('is the path the canonical redirect sends old bookmarks to', () => {
    // index.html redirects *.github.io visitors to the new home. If the base
    // moves and that URL does not, the redirect lands on a path with no app.
    const html = read('index.html');
    const redirect = /location\.replace\('([^']+)'/.exec(html);
    expect(redirect, 'the canonical redirect is missing from index.html').not.toBeNull();
    const target = redirect?.[1] ?? '';
    expect(target).toContain(base);
    expect(target.startsWith('https://'), 'the canonical URL must be https').toBe(true);
  });

  it('only redirects away from github.io, never from localhost or the canonical host', () => {
    // The CI preview server serves this same HTML from 127.0.0.1. A redirect
    // that fired there would send the whole Playwright suite to production.
    const html = read('index.html');
    expect(html).toContain("location.hostname.endsWith('.github.io')");
    expect(html).not.toMatch(/location\.hostname\s*!==/);
  });

  it('POSITIVE CONTROL: the workflow check can fail', () => {
    const fake = 'run: |\n  base="/$repo/"\n';
    expect(fake).toMatch(/base="\/\$repo/);
    expect(fake).not.toContain(BASE_PATH_FILE);
  });
});
