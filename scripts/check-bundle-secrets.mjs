#!/usr/bin/env node
/**
 * BFF Sample Testing — published-bundle credential scanner.
 *
 * GitHub Pages is a public static host. Everything in `dist/` is readable by
 * anybody, signed in or not (Master Prompt §1, "Design principle"). This script
 * is the gate that proves no server-side credential reached that directory.
 *
 * It is deliberately dependency-free (node: builtins only) so it can run in CI
 * before `npm ci` has been trusted, and so it has no supply chain of its own.
 *
 * WHY A SCANNER NEEDS ITS OWN PROOF
 * ---------------------------------
 * A scanner that finds nothing is indistinguishable from a scanner that looked
 * in the wrong place, matched nothing because its patterns are broken, or ran
 * against an empty directory. "Zero findings" is a claim about the instrument
 * as much as about the bundle. Three mechanisms address that here:
 *
 *   1. POSITIVE CONTROLS. The scan asserts things that MUST be present in a
 *      real build of this app (JavaScript, the Supabase URL shape, the anon key
 *      shape). A clean report with a failed positive control exits non-zero and
 *      is reported as a broken scanner, not a pass.
 *   2. PER-RULE SELF-TEST (`--self-test`). Every declared rule is exercised by
 *      a known-positive fixture and by near-miss known-negative fixtures that
 *      differ from the positive only in the token, inside the SAME surrounding
 *      context. A negative's silence is therefore attributable: the identical
 *      context with the positive token did fire, so the rule was reached.
 *   3. COVERAGE ASSERTION. The self-test fails if any rule declared by a
 *      detector is never exercised by a positive fixture. A rule nothing
 *      exercises is NOT RUN, exactly as an unexecuted test is.
 *
 * Every count this script prints is counted, never written down: a total an
 * artefact states about itself rather than derives from itself stops being a
 * measurement the moment the artefact changes.
 *
 * WHY MATCHES ARE REDACTED
 * ------------------------
 * CI logs for a public repository are public. Printing a discovered credential
 * in full would widen the leak this script exists to stop. So a finding prints
 * the rule that fired, the file, the line and byte offset, the reason, and a
 * short redacted excerpt with the true length — enough to locate the exact
 * bytes in the working tree, without republishing them.
 *
 * Usage:
 *   node scripts/check-bundle-secrets.mjs                  # scan ./dist
 *   node scripts/check-bundle-secrets.mjs --dir some/dir   # scan elsewhere
 *   node scripts/check-bundle-secrets.mjs --self-test      # validate the rules
 *
 * Exit codes: 0 clean, 1 findings or failed control or failed self-test,
 *             2 usage error.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extensions whose bytes are not text and are never scanned as text. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav',
  '.zip', '.gz', '.br', '.pdf',
]);

/** Extensions that count as "JavaScript was produced by the build". */
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Shorten a matched secret for printing. Keeps enough to grep for in the
 * working tree; never prints the whole value.
 */
function redact(value) {
  const text = String(value);
  if (text.length <= 10) return `"${text}" (${text.length} chars)`;
  return `"${text.slice(0, 6)}…${text.slice(-2)}" (${text.length} chars)`;
}

/** 1-indexed line number of a byte offset, for a locator a human can use. */
function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g;

/** Decode a JWT's payload segment. Returns null when it is not JSON. */
function decodeJwtPayload(jwt) {
  const segment = jwt.split('.')[1];
  if (!segment) return null;
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Google Drive / Sheets file ids are 33 or 44 characters from the base64url
 * alphabet and, by Drive's own convention since 2014, begin with `1`.
 *
 * HEURISTIC AND ITS LIMITS, stated rather than implied: an id that does not
 * begin with `1`, or whose 33/44-character token is glued to neighbouring
 * characters from the same alphabet, is NOT matched by this rule. The
 * authoritative defences against a leaked workbook id are therefore the URL
 * rule and the `SHEETS_SPREADSHEET_ID` identifier rule; this bare-token rule is
 * the backstop. The mixed-case-plus-digit filter exists to keep the rule off
 * minified identifiers and hash fragments, which are rarely all three.
 */
const DRIVE_ID_BARE_PATTERN =
  /(?<![A-Za-z0-9_-])1(?:[A-Za-z0-9_-]{32}|[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

function looksLikeDriveId(token) {
  const body = token.slice(1);
  return /[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9]/.test(body);
}

/** Collect every match of a global pattern as a finding of one named rule. */
function matchRule(text, pattern, rule, reason) {
  const out = [];
  for (const match of text.matchAll(pattern)) {
    out.push({ rule, reason, value: match[0], index: match.index ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detectors. Each declares its rule ids; the self-test asserts every one of
// them is exercised by a positive fixture.
// ---------------------------------------------------------------------------

const DETECTORS = [
  {
    id: 'supabase-service-role-jwt',
    title: 'Supabase service_role (or other non-anon) JWT',
    rules: ['jwt-role-service_role', 'jwt-role-other-than-anon'],
    redactMatches: true,
    scan(text) {
      const out = [];
      for (const match of text.matchAll(JWT_PATTERN)) {
        const payload = decodeJwtPayload(match[0]);
        if (!payload || typeof payload.role !== 'string') continue;
        if (payload.role === 'anon') continue; // the anon key is public by design
        const ref = typeof payload.ref === 'string' ? payload.ref : '?';
        const iss = typeof payload.iss === 'string' ? payload.iss : '?';
        out.push({
          rule: payload.role === 'service_role' ? 'jwt-role-service_role' : 'jwt-role-other-than-anon',
          reason: `decoded JWT payload carries "role":"${payload.role}" (iss=${iss}, ref=${ref})`,
          value: match[0],
          index: match.index ?? 0,
        });
      }
      return out;
    },
  },
  {
    id: 'supabase-secret-key',
    title: 'Supabase secret (non-publishable) API key',
    rules: ['sb_secret-prefix'],
    redactMatches: true,
    scan(text) {
      return matchRule(
        text,
        /\bsb_secret_[A-Za-z0-9_-]{6,}/g,
        'sb_secret-prefix',
        'Supabase secret-key prefix `sb_secret_`; only `sb_publishable_` may ship',
      );
    },
  },
  {
    id: 'pem-private-key',
    title: 'PEM private key block',
    rules: ['pem-begin-private-key'],
    redactMatches: true,
    scan(text) {
      return matchRule(
        text,
        /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
        'pem-begin-private-key',
        'PEM private-key armour header',
      );
    },
  },
  {
    id: 'google-service-account-json',
    title: 'Google service-account credential JSON',
    rules: ['type-service_account', 'private_key_id-field', 'iam-gserviceaccount-email'],
    redactMatches: true,
    scan(text) {
      return [
        ...matchRule(
          text,
          /"type"\s*:\s*"service_account"/g,
          'type-service_account',
          'service-account key file discriminator field',
        ),
        ...matchRule(
          text,
          /"private_key_id"\s*:/g,
          'private_key_id-field',
          'service-account key file `private_key_id` field',
        ),
        ...matchRule(
          text,
          /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com/g,
          'iam-gserviceaccount-email',
          'service-account identity address',
        ),
      ];
    },
  },
  {
    id: 'google-oauth-client-secret',
    title: 'Google OAuth client secret',
    rules: ['gocspx-prefix'],
    redactMatches: true,
    scan(text) {
      return matchRule(
        text,
        /GOCSPX-[A-Za-z0-9_-]*/g,
        'gocspx-prefix',
        'Google OAuth client-secret prefix `GOCSPX-`',
      );
    },
  },
  {
    id: 'google-api-key',
    title: 'Google API key',
    rules: ['aiza-39-char-key', 'aiza-unexpected-length'],
    redactMatches: true,
    scan(text) {
      const exact = matchRule(
        text,
        /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
        'aiza-39-char-key',
        'Google API key in its documented 39-character shape',
      );
      // A truncated, rotated or differently-sized AIza token is still a key
      // shape and still must not ship; it gets its own rule so a finding says
      // which of the two fired.
      const odd = matchRule(
        text,
        /\bAIza[0-9A-Za-z_-]{6,34}(?![0-9A-Za-z_-])/g,
        'aiza-unexpected-length',
        'token with the Google API-key prefix `AIza` but not the documented length',
      );
      return [...exact, ...odd];
    },
  },
  {
    id: 'google-oauth-refresh-token',
    title: 'Google OAuth refresh token',
    rules: ['oauth-refresh-token-prefix'],
    redactMatches: true,
    scan(text) {
      return matchRule(
        text,
        /\b1\/\/[0-9A-Za-z_-]{20,}/g,
        'oauth-refresh-token-prefix',
        'Google OAuth refresh-token prefix `1//`',
      );
    },
  },
  {
    id: 'sheets-spreadsheet-id',
    title: 'Sheets spreadsheet identifier',
    rules: ['sheets_spreadsheet_id-identifier', 'drive-id-in-google-url', 'drive-id-bare-token'],
    redactMatches: true,
    scan(text) {
      const out = [
        // The NAME is as disqualifying as the value: the spreadsheet id is an
        // Edge Function secret with no default, so the frontend has no reason
        // to know the variable exists (safety rule 1).
        ...matchRule(
          text,
          /SHEETS_SPREADSHEET_ID/g,
          'sheets_spreadsheet_id-identifier',
          'Edge Function secret NAME present in client code; the browser must not know it',
        ),
        ...matchRule(
          text,
          /\/d\/(?:e\/)?[A-Za-z0-9_-]{25,}/g,
          'drive-id-in-google-url',
          'Google Docs/Drive document URL containing a file id',
        ),
      ];
      for (const match of text.matchAll(DRIVE_ID_BARE_PATTERN)) {
        if (!looksLikeDriveId(match[0])) continue;
        out.push({
          rule: 'drive-id-bare-token',
          reason: `bare ${match[0].length}-character Google Drive file-id shape`,
          value: match[0],
          index: match.index ?? 0,
        });
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Positive controls — what a real build of THIS app must contain.
// ---------------------------------------------------------------------------

const SUPABASE_URL_SHAPE = /https:\/\/[A-Za-z0-9-]{1,63}\.supabase\.(?:co|in)\b/;
const SUPABASE_URL_PLACEHOLDER = /YOUR-PROJECT-REF/;
const PUBLISHABLE_KEY_SHAPE = /\bsb_publishable_[A-Za-z0-9_-]{6,}/;
const ANON_KEY_PLACEHOLDER = /YOUR-PUBLISHABLE-ANON-KEY/;

function hasAnonJwt(text) {
  for (const match of text.matchAll(JWT_PATTERN)) {
    const payload = decodeJwtPayload(match[0]);
    if (payload && payload.role === 'anon') return true;
  }
  return false;
}

const POSITIVE_CONTROLS = [
  {
    id: 'javascript-present',
    description: 'the scanned directory contains built JavaScript',
    check(files) {
      const js = files.filter((f) => JS_EXTENSIONS.has(extname(f.path).toLowerCase()));
      const substantial = js.filter((f) => f.text.length >= 1024);
      if (substantial.length === 0) {
        return { ok: false, detail: 'scanner found nothing to scan: no JavaScript file of 1KB or more' };
      }
      return { ok: true, detail: `${substantial.length} JavaScript file(s) of 1KB or more` };
    },
  },
  {
    id: 'supabase-url-shape',
    description: 'the Supabase project URL is baked into the bundle',
    check(files) {
      for (const file of files) {
        if (SUPABASE_URL_SHAPE.test(file.text)) {
          return { ok: true, detail: `project URL shape found in ${file.path}` };
        }
        if (SUPABASE_URL_PLACEHOLDER.test(file.text)) {
          return { ok: true, detail: `documented .env.example placeholder found in ${file.path}` };
        }
      }
      return {
        ok: false,
        detail:
          'no https://<ref>.supabase.co URL and no YOUR-PROJECT-REF placeholder in the bundle — ' +
          'either VITE_SUPABASE_URL was unset at build time or the scan is pointed at the wrong directory',
      };
    },
  },
  {
    id: 'anon-key-shape',
    description: 'the public anon/publishable key is baked into the bundle',
    check(files) {
      for (const file of files) {
        if (hasAnonJwt(file.text)) {
          return { ok: true, detail: `JWT with "role":"anon" found in ${file.path}` };
        }
        if (PUBLISHABLE_KEY_SHAPE.test(file.text)) {
          return { ok: true, detail: `sb_publishable_ key found in ${file.path}` };
        }
        if (ANON_KEY_PLACEHOLDER.test(file.text)) {
          return { ok: true, detail: `documented .env.example placeholder found in ${file.path}` };
        }
      }
      return {
        ok: false,
        detail:
          'no anon JWT, sb_publishable_ key or YOUR-PUBLISHABLE-ANON-KEY placeholder in the bundle — ' +
          'either VITE_SUPABASE_ANON_KEY was unset at build time or the scan is pointed at the wrong directory',
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Scan an in-memory file set. Pure: no filesystem, so the self-test runs the
 * same code path the real scan runs.
 */
function scanTexts(files) {
  const findings = [];
  for (const file of files) {
    for (const detector of DETECTORS) {
      for (const hit of detector.scan(file.text)) {
        findings.push({
          detector: detector.id,
          detectorTitle: detector.title,
          redact: detector.redactMatches !== false,
          file: file.path,
          line: lineNumberAt(file.text, hit.index),
          index: hit.index,
          rule: hit.rule,
          reason: hit.reason,
          value: hit.value,
        });
      }
    }
  }
  const controls = POSITIVE_CONTROLS.map((control) => ({
    id: control.id,
    description: control.description,
    ...control.check(files),
  }));
  return { findings, controls };
}

function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch (error) {
        process.stderr.write(`  ! could not read ${full}: ${String(error)}\n`);
        continue;
      }
      files.push({ path: relative(root, full) || entry.name, text });
    }
  };
  walk(root);
  return files;
}

function printFindings(findings) {
  for (const finding of findings) {
    process.stdout.write(`  LEAK  ${finding.detectorTitle}\n`);
    process.stdout.write(`        detector : ${finding.detector}\n`);
    process.stdout.write(`        rule     : ${finding.rule}\n`);
    process.stdout.write(`        file     : ${finding.file} (line ${finding.line}, byte ${finding.index})\n`);
    process.stdout.write(`        reason   : ${finding.reason}\n`);
    process.stdout.write(
      `        match    : ${finding.redact ? redact(finding.value) : JSON.stringify(finding.value)}\n`,
    );
  }
}

function runScan(dir) {
  process.stdout.write(`Scanning ${dir} for leaked credentials\n`);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stdout.write(
      `FAIL  scanner found nothing to scan: ${dir} does not exist or is not a directory.\n` +
        '      Run `npm run build` first, or pass --dir <path>.\n',
    );
    return 1;
  }

  const files = collectFiles(dir);
  const { findings, controls } = scanTexts(files);

  process.stdout.write(`  scanned ${files.length} text file(s)\n\n`);

  process.stdout.write('Positive controls (a clean scan is only meaningful if these pass):\n');
  let controlFailures = 0;
  for (const control of controls) {
    if (!control.ok) controlFailures += 1;
    process.stdout.write(`  ${control.ok ? 'PASS' : 'FAIL'}  ${control.id} — ${control.detail}\n`);
  }
  process.stdout.write('\n');

  if (findings.length > 0) {
    process.stdout.write(`Credential findings: ${findings.length}\n`);
    printFindings(findings);
    process.stdout.write('\n');
  } else {
    process.stdout.write('Credential findings: 0\n\n');
  }

  if (findings.length > 0) {
    process.stdout.write(
      `FAIL  ${findings.length} credential finding(s) in ${dir}. ` +
        'Nothing in this list may ship to a public static host.\n',
    );
    return 1;
  }
  if (controlFailures > 0) {
    process.stdout.write(
      `FAIL  ${controlFailures} positive control(s) failed. Zero findings is NOT a pass here: ` +
        'the scanner cannot show it examined this application\'s real bundle.\n',
    );
    return 1;
  }
  process.stdout.write(`PASS  no leaked credentials in ${dir}, and every positive control held.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Placeholder credential shapes. None is a real credential: the JWTs carry the
 * literal signature `NOT_A_REAL_SIGNATURE_...`, and the Drive id spells out
 * that it is an example. They exist only to prove the rules fire.
 */
const FIXTURES = {
  anonJwt:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4YW1wbGVyZWYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.NOT_A_REAL_SIGNATURE_placeholder_value_0000',
  serviceRoleJwt:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4YW1wbGVyZWYiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9.NOT_A_REAL_SIGNATURE_placeholder_value_0000',
  authenticatedJwt:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4YW1wbGVyZWYiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.NOT_A_REAL_SIGNATURE_placeholder_value_0000',
  driveId44: '1ExampleNotARealDriveFileIdForSelfTest000000',
  driveId33: '1ExampleNotARealDriveFileIdFor000',
  apiKey: 'AIzaSyEXAMPLEnotARealGoogleApiKey000000',
};

const SELF_TEST_CASES = [
  {
    detector: 'supabase-service-role-jwt',
    rule: 'jwt-role-service_role',
    context: (token) => `var e={supabaseKey:"${token}"};`,
    positive: FIXTURES.serviceRoleJwt,
    negatives: [
      { token: FIXTURES.anonJwt, why: 'the anon key is public by design and must not be flagged' },
      { token: 'eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24tYXQtYWxs.NOT_A_REAL_SIGNATURE_000', why: 'payload is not JSON' },
    ],
  },
  {
    detector: 'supabase-service-role-jwt',
    rule: 'jwt-role-other-than-anon',
    context: (token) => `var e={supabaseKey:"${token}"};`,
    positive: FIXTURES.authenticatedJwt,
    negatives: [{ token: FIXTURES.anonJwt, why: 'role anon is the only allowed role' }],
  },
  {
    detector: 'supabase-secret-key',
    rule: 'sb_secret-prefix',
    context: (token) => `const k="${token}";`,
    positive: 'sb_secret_EXAMPLEnotARealSecretKey00',
    negatives: [
      { token: 'sb_publishable_EXAMPLEpublishableKey00', why: 'the publishable key is public by design' },
      { token: 'sb_secret_', why: 'bare prefix with no key body is not a key' },
    ],
  },
  {
    detector: 'pem-private-key',
    rule: 'pem-begin-private-key',
    context: (token) => `var pem="${token}\\nMIIE...\\n";`,
    positive: '-----BEGIN PRIVATE KEY-----',
    negatives: [
      { token: '-----BEGIN PUBLIC KEY-----', why: 'a public key is not a credential' },
      { token: '-----BEGIN CERTIFICATE-----', why: 'a certificate is not a private key' },
    ],
  },
  {
    detector: 'google-service-account-json',
    rule: 'type-service_account',
    context: (token) => `var cred={${token},"project_id":"x"};`,
    positive: '"type":"service_account"',
    negatives: [
      { token: '"type":"authorized_user"', why: 'a user credential type is a different shape' },
      { token: '"type":"service"', why: 'near-miss discriminator value' },
    ],
  },
  {
    detector: 'google-service-account-json',
    rule: 'private_key_id-field',
    context: (token) => `var cred={${token}"abc"};`,
    positive: '"private_key_id":',
    negatives: [{ token: '"public_key_id":', why: 'a public key id is not a credential field' }],
  },
  {
    detector: 'google-service-account-json',
    rule: 'iam-gserviceaccount-email',
    context: (token) => `var cred={"client_email":"${token}"};`,
    positive: 'bff-sheets-writer@example-project.iam.gserviceaccount.com',
    negatives: [
      { token: 'operator@bountyfarm.example', why: 'an ordinary staff address is not a service-account identity' },
      { token: 'bff@example-project.gserviceaccount.example', why: 'near-miss domain' },
    ],
  },
  {
    detector: 'google-oauth-client-secret',
    rule: 'gocspx-prefix',
    context: (token) => `const s="${token}";`,
    positive: 'GOCSPX-EXAMPLEnotARealClientSecret',
    negatives: [
      { token: 'GOCSPY-EXAMPLEnotARealClientSecret', why: 'wrong prefix' },
      { token: 'xGOCSPX', why: 'prefix fragment without the hyphen' },
    ],
  },
  {
    detector: 'google-api-key',
    rule: 'aiza-39-char-key',
    context: (token) => `const k="${token}";`,
    positive: FIXTURES.apiKey,
    negatives: [
      { token: `x${FIXTURES.apiKey}`, why: 'no word boundary before AIza' },
      { token: FIXTURES.apiKey.replace('AIza', 'AIzb'), why: 'wrong prefix' },
    ],
  },
  {
    detector: 'google-api-key',
    rule: 'aiza-unexpected-length',
    context: (token) => `const k="${token}";`,
    positive: 'AIzaSyEXAMPLEtruncated',
    negatives: [
      { token: 'AIza', why: 'prefix alone carries no key body' },
      { token: 'xAIzaSyEXAMPLEtruncated', why: 'no word boundary before AIza' },
    ],
  },
  {
    detector: 'google-oauth-refresh-token',
    rule: 'oauth-refresh-token-prefix',
    context: (token) => `var t="${token}";`,
    positive: '1//0gEXAMPLEnotARealRefreshToken00',
    negatives: [
      { token: '1//0gShort', why: 'token body below the minimum length' },
      { token: '2//0gEXAMPLEnotARealRefreshToken00', why: 'wrong prefix digit' },
    ],
  },
  {
    detector: 'sheets-spreadsheet-id',
    rule: 'sheets_spreadsheet_id-identifier',
    context: (token) => `var cfg={id:process.env.${token}};`,
    positive: 'SHEETS_SPREADSHEET_ID',
    negatives: [
      { token: 'SHEETS_SPREADSHEET', why: 'near-miss identifier' },
      { token: 'VITE_SUPABASE_URL', why: 'a public frontend variable name is allowed' },
    ],
  },
  {
    detector: 'sheets-spreadsheet-id',
    rule: 'drive-id-in-google-url',
    context: (token) => `var u="https://docs.google.com${token}/edit";`,
    positive: `/d/${FIXTURES.driveId44}`,
    negatives: [
      { token: '/d/short', why: 'path segment far below a file-id length' },
      { token: '/spreadsheets/u/0', why: 'a Sheets URL carrying no file id' },
    ],
  },
  {
    detector: 'sheets-spreadsheet-id',
    rule: 'drive-id-bare-token',
    context: (token) => `var w="${token}";`,
    positive: FIXTURES.driveId44,
    negatives: [
      { token: FIXTURES.driveId44.slice(0, 43), why: '43 characters: neither a 33- nor a 44-character id' },
      { token: FIXTURES.driveId44.toLowerCase(), why: 'no uppercase character, so it is not a Drive id shape' },
      { token: `sha256-${FIXTURES.driveId44}`, why: 'glued to a hash prefix, so the token is 51 characters' },
      {
        token: 'ZXhhbXBsZSBiYXNlNjQgY29udGVudCB0aGF0IGlzIG11Y2ggbG9uZ2VyIHRoYW4gZm9ydHktZm91ciBjaGFyYWN0ZXJz',
        why: 'a long base64 blob is not a delimited 33/44-character token',
      },
    ],
  },
];

/** Bundles used to exercise the positive controls themselves. */
function bundleFile(name, body) {
  // Pad so the 1KB JavaScript threshold is met by construction, not by luck.
  return { path: name, text: `${body}\n/* ${'pad '.repeat(300)}*/\n` };
}

const GOOD_BUNDLE = [
  bundleFile(
    'assets/index-abc123.js',
    `var cfg={url:"https://exampleref.supabase.co",key:"${FIXTURES.anonJwt}"};`,
  ),
  { path: 'index.html', text: '<!doctype html><html><body><div id="root"></div></body></html>' },
];

function runSelfTest() {
  process.stdout.write('check-bundle-secrets self-test\n\n');

  let passed = 0;
  let failed = 0;
  const failures = [];

  /** The ONE place a check is recorded, so the printed total is counted. */
  const check = (name, ok, detail) => {
    if (ok) {
      passed += 1;
      process.stdout.write(`  ok    ${name}${detail ? ` — ${detail}` : ''}\n`);
    } else {
      failed += 1;
      failures.push(name);
      process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
    }
  };

  const findRules = (text) =>
    scanTexts([{ path: 'fixture.js', text }]).findings.map((f) => `${f.detector}:${f.rule}`);

  process.stdout.write('Rule fixtures (each negative shares its positive\'s surrounding context,\n');
  process.stdout.write('so a negative that matches nothing proves the rule was reached and declined):\n');

  const exercised = new Set();

  for (const testCase of SELF_TEST_CASES) {
    const key = `${testCase.detector}:${testCase.rule}`;
    const positiveRules = findRules(testCase.context(testCase.positive));
    const positiveFired = positiveRules.includes(key);
    check(
      `positive ${key}`,
      positiveFired,
      positiveFired ? 'fired the declared rule' : `fired [${positiveRules.join(', ') || 'nothing'}] instead`,
    );
    if (positiveFired) exercised.add(key);

    for (const negative of testCase.negatives) {
      const negativeRules = findRules(testCase.context(negative.token));
      const stillFires = negativeRules.includes(key);
      check(
        `negative ${key} (${negative.why})`,
        !stillFires && positiveFired,
        stillFires
          ? `rule still fired on the near-miss token`
          : positiveFired
            ? 'declined, and the identical context with the positive token did fire'
            : 'INCONCLUSIVE: the positive in this context did not fire, so silence proves nothing',
      );
    }
  }

  process.stdout.write('\nRule coverage (a declared rule nothing exercises is NOT RUN):\n');
  for (const detector of DETECTORS) {
    for (const rule of detector.rules) {
      const key = `${detector.id}:${rule}`;
      check(`coverage ${key}`, exercised.has(key), exercised.has(key) ? 'exercised' : 'NO positive fixture');
    }
  }

  process.stdout.write('\nWhole-bundle behaviour:\n');

  const clean = scanTexts(GOOD_BUNDLE);
  check(
    'a good bundle yields zero findings',
    clean.findings.length === 0,
    clean.findings.length === 0 ? '0 findings' : `${clean.findings.length}: ${clean.findings.map((f) => f.rule).join(', ')}`,
  );
  for (const control of clean.controls) {
    check(`control ${control.id} passes on a good bundle`, control.ok, control.detail);
  }

  const noJs = scanTexts([{ path: 'index.html', text: '<!doctype html>' }]);
  const noJsControl = noJs.controls.find((c) => c.id === 'javascript-present');
  check(
    'control javascript-present fails when there is no JavaScript',
    noJsControl !== undefined && !noJsControl.ok && noJsControl.detail.includes('nothing to scan'),
    noJsControl ? noJsControl.detail : 'control missing',
  );

  const noUrl = [
    bundleFile('assets/index-abc123.js', `var cfg={key:"${FIXTURES.anonJwt}"};`),
  ];
  const noUrlControl = scanTexts(noUrl).controls.find((c) => c.id === 'supabase-url-shape');
  check(
    'control supabase-url-shape fails when the project URL is absent',
    noUrlControl !== undefined && !noUrlControl.ok,
    noUrlControl ? `reported: ${noUrlControl.detail.slice(0, 60)}…` : 'control missing',
  );

  const noAnon = [bundleFile('assets/index-abc123.js', 'var cfg={url:"https://exampleref.supabase.co"};')];
  const noAnonControl = scanTexts(noAnon).controls.find((c) => c.id === 'anon-key-shape');
  check(
    'control anon-key-shape fails when the anon key is absent',
    noAnonControl !== undefined && !noAnonControl.ok,
    noAnonControl ? `reported: ${noAnonControl.detail.slice(0, 60)}…` : 'control missing',
  );

  const leaky = scanTexts([
    ...GOOD_BUNDLE,
    bundleFile('assets/leak-def456.js', `var admin="${FIXTURES.serviceRoleJwt}";`),
  ]);
  const leakRules = leaky.findings.map((f) => `${f.detector}:${f.rule}`);
  check(
    'a bundle with a service_role key is reported by the service-role rule',
    leakRules.includes('supabase-service-role-jwt:jwt-role-service_role'),
    `findings: ${leakRules.join(', ') || 'none'}`,
  );
  const leakFinding = leaky.findings[0];
  check(
    'a finding names its file and does not print the whole secret',
    leakFinding !== undefined &&
      leakFinding.file === 'assets/leak-def456.js' &&
      !redact(leakFinding.value).includes(FIXTURES.serviceRoleJwt),
    leakFinding ? `${leakFinding.file} -> ${redact(leakFinding.value)}` : 'no finding',
  );

  const total = passed + failed;
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}  self-test: ${passed}/${total} checks passed\n`);
  if (failed > 0) {
    process.stdout.write(`      failed: ${failures.join('; ')}\n`);
  }
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(argv) {
  let dir = 'dist';
  let selfTest = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') {
      selfTest = true;
    } else if (arg === '--dir') {
      const next = argv[i + 1];
      if (next === undefined) {
        process.stderr.write('--dir needs a path\n');
        return 2;
      }
      dir = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/check-bundle-secrets.mjs [--dir <path>] [--self-test]\n',
      );
      return 0;
    } else {
      process.stderr.write(`unknown argument ${JSON.stringify(arg)}\n`);
      return 2;
    }
  }
  return selfTest ? runSelfTest() : runScan(dir);
}

process.exit(main(process.argv.slice(2)));
