/**
 * Edge Function secrets. DENO-ONLY — never imported by a pure module.
 *
 * Build rule 1: "NEVER write the draft workbook ID into code, .env.example,
 * seeds, tests or docs as a usable default. The spreadsheet ID is an Edge
 * Function secret SHEETS_SPREADSHEET_ID with NO default value. If it is unset,
 * the sync worker must refuse to run." There is therefore no fallback, no
 * sample value and no "if unset, use the draft" path anywhere below. A missing
 * id is a hard refusal, because the alternative — a default — is a mechanism
 * by which a misconfiguration writes to the preserved draft workbook.
 *
 * Build rule 2: nothing here is ever returned to a caller. `presenceReport()`
 * exists so the health endpoint can say WHETHER a secret is set without
 * revealing anything about its value, not even its length.
 */

import { SheetsConfigurationError } from '../sheets.ts';

/** Secrets the platform injects into every function. */
const PLATFORM_KEYS = {
  supabaseUrl: ['SUPABASE_URL', 'SB_URL'],
  anonKey: ['SUPABASE_ANON_KEY', 'SB_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'],
  serviceRoleKey: ['SUPABASE_SERVICE_ROLE_KEY', 'SB_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'],
} as const;

/** Secrets an administrator must set. None has a default. */
export const REQUIRED_SHEETS_KEYS = ['SHEETS_SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'] as const;

/** Shared secret the scheduler presents. Without it, cron invocation is refused. */
export const SCHEDULER_SECRET_KEY = 'SYNC_SCHEDULER_SECRET';

function firstSet(names: readonly string[]): string | null {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value !== undefined && value.trim() !== '') return value;
  }
  return null;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? fallback : value;
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === '') {
    // The NAME is safe to repeat; the value never is.
    throw new SheetsConfigurationError([name]);
  }
  return value;
}

export interface PlatformConfig {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly appVersion: string;
}

export function readPlatformConfig(): PlatformConfig {
  const missing: string[] = [];
  const supabaseUrl = firstSet(PLATFORM_KEYS.supabaseUrl);
  const anonKey = firstSet(PLATFORM_KEYS.anonKey);
  const serviceRoleKey = firstSet(PLATFORM_KEYS.serviceRoleKey);
  if (supabaseUrl === null) missing.push(PLATFORM_KEYS.supabaseUrl[0]);
  if (anonKey === null) missing.push(PLATFORM_KEYS.anonKey[0]);
  if (serviceRoleKey === null) missing.push(PLATFORM_KEYS.serviceRoleKey[0]);
  if (supabaseUrl === null || anonKey === null || serviceRoleKey === null) {
    throw new SheetsConfigurationError(missing);
  }
  return {
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    appVersion: optionalEnv('APP_VERSION', 'unknown'),
  };
}

export interface SheetsConfig {
  readonly spreadsheetId: string;
  /** Raw service-account JSON. Parsed by `googleAuth.ts`, never logged. */
  readonly serviceAccountJson: string;
  /** Per-request timeout. A read beyond this is retryable; a write, unknown. */
  readonly requestTimeoutMs: number;
}

/**
 * Read the Sheets configuration, or refuse.
 *
 * Collects EVERY missing key before throwing, so an administrator setting up
 * the project learns both names at once instead of fixing one and
 * rediscovering the other on the next run.
 */
export function readSheetsConfig(): SheetsConfig {
  const missing: string[] = [];
  for (const key of REQUIRED_SHEETS_KEYS) {
    const value = Deno.env.get(key);
    if (value === undefined || value.trim() === '') missing.push(key);
  }
  if (missing.length > 0) throw new SheetsConfigurationError(missing);

  const spreadsheetId = Deno.env.get('SHEETS_SPREADSHEET_ID')!;
  const serviceAccountJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')!;

  const timeoutRaw = optionalEnv('SHEETS_REQUEST_TIMEOUT_MS', '15000');
  const parsed = Number(timeoutRaw);
  const requestTimeoutMs = Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 15_000;

  return { spreadsheetId, serviceAccountJson, requestTimeoutMs };
}

/** Is the Sheets configuration complete? Used by `/health` without throwing. */
export function sheetsConfigured(): boolean {
  return REQUIRED_SHEETS_KEYS.every((key) => {
    const value = Deno.env.get(key);
    return value !== undefined && value.trim() !== '';
  });
}

/**
 * Booleans only. No values, no lengths, no prefixes — a key length is enough
 * to fingerprint which credential is installed.
 */
export function presenceReport(): Readonly<Record<string, boolean>> {
  const names = [
    ...PLATFORM_KEYS.supabaseUrl.slice(0, 1),
    ...PLATFORM_KEYS.anonKey.slice(0, 1),
    ...PLATFORM_KEYS.serviceRoleKey.slice(0, 1),
    ...REQUIRED_SHEETS_KEYS,
    SCHEDULER_SECRET_KEY,
  ];
  const report: Record<string, boolean> = {};
  for (const name of names) {
    const direct = Deno.env.get(name);
    report[name] = direct !== undefined && direct.trim() !== '';
  }
  // Report the platform keys under their canonical name even when the
  // alternate spelling is what is actually set.
  report['SUPABASE_URL'] = firstSet(PLATFORM_KEYS.supabaseUrl) !== null;
  report['SUPABASE_ANON_KEY'] = firstSet(PLATFORM_KEYS.anonKey) !== null;
  report['SUPABASE_SERVICE_ROLE_KEY'] = firstSet(PLATFORM_KEYS.serviceRoleKey) !== null;
  return report;
}

/**
 * Constant-time comparison for the scheduler secret.
 *
 * `a === b` on strings short-circuits at the first differing character, which
 * leaks the length of the shared prefix across repeated attempts. The secret
 * is low-value, but the correct comparison costs two lines.
 */
export function secretsMatch(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  // Length itself is compared non-secretly; mismatched lengths still run the
  // full loop so the timing does not depend on where the difference is.
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Is this request an authorised scheduler invocation? */
export function isSchedulerRequest(request: Request): boolean {
  const expected = Deno.env.get(SCHEDULER_SECRET_KEY);
  if (expected === undefined || expected.trim() === '') {
    // No secret configured means scheduler invocation is NOT available. There
    // is no "allow when unset" branch: that is how an unauthenticated caller
    // would reach a privileged worker.
    return false;
  }
  return secretsMatch(request.headers.get('x-sync-scheduler-secret'), expected);
}
