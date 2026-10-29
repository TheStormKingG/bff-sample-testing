/**
 * The server's own words must reach the person standing at the tablet.
 *
 * WHY THIS EXISTS. supabase-js collapses every non-2xx into one
 * `FunctionsHttpError` whose message is always the same sentence — "Edge
 * Function returned a non-2xx status code". Every hook in this app except the
 * change-password screen threw that string straight at the operator, so no
 * message any Edge Function wrote had ever been seen.
 *
 * That is not cosmetic. `_shared/handlers/admin.ts` carries a thirty-line
 * message for one case alone — an account that WAS created but could not be
 * armed — whose entire purpose is to stop an administrator creating a second
 * account for the same person and handing out a password that was never
 * applied. Every word of it was unreachable.
 *
 * It is also what turned a refused database privilege into a mystery: the
 * server answered with a precise `internal` and the screen said only that
 * something had returned a non-2xx.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const HOOKS = join(REPO, 'src', 'hooks');

function hookFiles(): string[] {
  return readdirSync(HOOKS)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => join(HOOKS, f));
}

/** Source with comments stripped, so prose cannot satisfy a check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no hook throws the collapsed supabase-js message at an operator', () => {
  it('has no bare `throw new Error(error.message)` after an Edge Function call', () => {
    const offenders: string[] = [];
    for (const path of hookFiles()) {
      const rel = path.slice(REPO.length + 1);
      code(readFileSync(path, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (/throw new Error\(\s*error\.message\s*\)/.test(line)) {
            offenders.push(
              `${rel}:${i + 1} throws the raw FunctionsHttpError message, which is ` +
                `always "Edge Function returned a non-2xx status code" — the server's ` +
                `own explanation is discarded.`,
            );
          }
        });
    }
    // THE ASSERTION THAT FAILED BEFORE THE FIX, at 16 call sites across four
    // hook files.
    expect(offenders).toEqual([]);
  });

  it('decodes the envelope wherever an Edge Function is invoked', () => {
    // Every file that calls `functions.invoke` must also decode the failure.
    const missing: string[] = [];
    for (const path of hookFiles()) {
      const src = code(readFileSync(path, 'utf8'));
      if (!/functions\.invoke\(/.test(src)) continue;
      if (!/edgeErrorMessage|edgeFailureMessage|toRegisterError/.test(src)) {
        missing.push(path.slice(REPO.length + 1));
      }
    }
    expect(missing).toEqual([]);
  });

  it('VACUITY CHECK: there really are hooks that invoke Edge Functions', () => {
    // Without this, both checks above pass trivially if the matcher breaks or
    // the directory moves.
    const invoking = hookFiles().filter((p) =>
      /functions\.invoke\(/.test(code(readFileSync(p, 'utf8'))),
    );
    expect(invoking.length).toBeGreaterThanOrEqual(3);
  });

  it('the decoder returns the server sentence in preference to anything of its own', () => {
    // Read from source rather than executed: the module pulls in the Supabase
    // client and the env allowlist, which this assertion does not need. What
    // matters is the ORDER — the envelope message is returned before any
    // fallback wording is reached.
    const src = code(readFileSync(join(REPO, 'src/lib/supabase.ts'), 'utf8'));
    const fn = src.slice(src.indexOf('export async function edgeErrorMessage'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);

    const envelopeReturn = body.indexOf("if (message !== '') return message;");
    const notDeployed = body.indexOf('is not deployed to this project');
    const refused = body.indexOf('gave no reason that can be shown');

    expect(envelopeReturn, 'the envelope message is never returned').toBeGreaterThan(-1);
    expect(notDeployed).toBeGreaterThan(envelopeReturn);
    expect(refused).toBeGreaterThan(envelopeReturn);
  });

  it('promises nothing about what was written, because it cannot know', () => {
    // `edgeFailureMessage` may say "your password has NOT been changed" —
    // it guards one endpoint whose failure modes it knows. The general
    // decoder guards every endpoint, and a non-2xx can mean the request never
    // arrived OR that it committed and the reply was lost. Claiming nothing
    // was saved would be a guess presented as fact.
    const src = code(readFileSync(join(REPO, 'src/lib/supabase.ts'), 'utf8'));
    const fn = src.slice(src.indexOf('export async function edgeErrorMessage'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    expect(body).not.toMatch(/nothing was saved/i);
    expect(body).not.toMatch(/has NOT been/i);
  });
});
