#!/usr/bin/env node
/**
 * Guard the modules that BOTH toolchains import.
 *
 * Seven-ish files under src/ are consumed by the Vite frontend AND by the
 * Supabase Edge Functions, so the sheet mapping, the authority model and the
 * assessment engine cannot drift between client and server. The two runtimes
 * do not agree on module specifiers:
 *
 *   - Vite resolves `./registry`, `./registry.ts` and `@/forms/registry`.
 *   - Deno and the Supabase bundler resolve only `./registry.ts`.
 *
 * So an import that is perfectly valid for the frontend can make the Edge
 * Function deploy fail. That is not hypothetical: it happened, and the deploy
 * was the first step that noticed.
 *
 * WHY THIS SCRIPT AND NOT A STANDARD TOOL. Both obvious candidates were tried
 * against the real defect and BOTH returned success with it present:
 *
 *   deno check <all function modules>   -> exit 0
 *   deno info <each function entrypoint> -> exit 0
 *
 * `deno check` type-checks, and the path into these files is `import type`,
 * which is erased before any module graph is built. `deno info` builds a graph
 * from the entrypoints, which does not include everything the Supabase bundler
 * uploads. Neither asks the question that fails. Hence an explicit check, with
 * its own controls — run `--self-test` to see it both catch and not-catch.
 *
 * Usage:
 *   node scripts/check-shared-module-imports.mjs
 *   node scripts/check-shared-module-imports.mjs --self-test
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `new URL(...).pathname`: the latter is percent-encoded,
// and this repository's directory name contains a space, so it would resolve
// to a non-existent "FEED%20QUALITY" and the scan would find nothing. The
// instrument check below is what caught that.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = join(REPO, 'supabase', 'functions');

/** Every relative/aliased import specifier in a source string. */
function importSpecifiers(src) {
  const out = [];
  const re = /\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)/g;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2]);
  return out.filter(Boolean);
}

const isLocal = (spec) => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/');

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

/**
 * The transitive closure of src/ files reachable from supabase/functions.
 * Starts from the explicit `../../../src/...` references in the function tree,
 * then follows relative imports inside src/ — because a file is only safe if
 * everything it pulls in is also safe.
 */
function sharedModules() {
  const seeds = new Set();
  for (const file of walk(FUNCTIONS_DIR)) {
    const src = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(src)) {
      if (!spec.includes('/src/')) continue;
      const resolved = resolve(dirname(file), spec);
      const candidate = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
      if (existsSync(candidate)) seeds.add(candidate);
    }
  }

  const closure = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop();
    if (closure.has(file)) continue;
    closure.add(file);
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!isLocal(spec)) continue;
      const base = spec.startsWith('@/') ? join(REPO, 'src', spec.slice(2)) : resolve(dirname(file), spec);
      for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate) && !closure.has(candidate)) queue.push(candidate);
      }
    }
  }
  return [...closure].sort();
}

/** Specifiers in `file` that Deno cannot resolve. */
function offendingSpecifiers(src) {
  return importSpecifiers(src).filter(
    (spec) => isLocal(spec) && (spec.startsWith('@/') || !spec.endsWith('.ts')),
  );
}

function run() {
  const files = sharedModules();

  // Instrument check: an empty set would make this pass vacuously, which is
  // the exact failure this script exists to prevent elsewhere.
  if (files.length === 0) {
    console.error(
      'FAIL  no shared modules found. Either supabase/functions stopped importing src/, ' +
        'or this scanner is looking in the wrong place. Either way it checked nothing.',
    );
    return 1;
  }

  const problems = [];
  for (const file of files) {
    for (const spec of offendingSpecifiers(readFileSync(file, 'utf8'))) {
      problems.push(
        `${relative(REPO, file)}: "${spec}" — Vite resolves this, Deno and the Supabase ` +
          `bundler do not. Use an explicit relative path ending in .ts.`,
      );
    }
  }

  console.log(`Checked ${files.length} module(s) shared between the frontend and the Edge Functions:`);
  for (const f of files) console.log(`  ${relative(REPO, f)}`);

  if (problems.length > 0) {
    console.error(`\nFAIL  ${problems.length} unresolvable specifier(s):`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log('\nPASS  every shared module uses a specifier both toolchains resolve.');
  return 0;
}

function selfTest() {
  const cases = [
    { name: 'extensionless relative is caught', src: "import { a } from './registry';", expect: 1 },
    { name: 'alias import is caught', src: "import { a } from '@/forms/types';", expect: 1 },
    { name: 'parent-relative extensionless is caught', src: "import { a } from '../lib/time';", expect: 1 },
    { name: 'explicit .ts relative passes', src: "import { a } from './registry.ts';", expect: 0 },
    { name: 'type-only import is still checked', src: "import type { A } from './types';", expect: 1 },
    { name: 'bare package import is ignored', src: "import { z } from 'zod';", expect: 0 },
    { name: 'node builtin is ignored', src: "import fs from 'node:fs';", expect: 0 },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = offendingSpecifiers(c.src).length;
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name} — expected ${c.expect}, got ${got}`);
  }
  console.log(failed === 0 ? `\nPASS  self-test ${cases.length}/${cases.length}` : `\nFAIL  ${failed} self-test case(s)`);
  return failed === 0 ? 0 : 1;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run());
