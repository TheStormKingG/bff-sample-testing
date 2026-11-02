/**
 * Read the lab's sieve table out of `system_config`, for the endpoints that
 * compute from it.
 *
 * WHY IT NEVER THROWS. The table is a convenience over a method that already
 * has a correct default: refusing a registration because a configuration row
 * could not be read would take the plant's record-keeping offline over a
 * setting. A read that fails, or a stored value that breaks one of the rules
 * in `parseSieveSeries`, therefore yields `null` and the built-in series —
 * and says so in the log, so the divergence is discoverable rather than
 * silent. It is never half-applied: `parseSieveSeries` returns a whole table
 * or none.
 */

import { SIEVE_SERIES_CONFIG_KEY, parseSieveSeries, type SieveSeriesDocument } from '../../../../src/lib/sieveSeries.ts';

/**
 * Just enough of the client to read one row.
 *
 * Structural rather than `SupabaseClient`, so the unit tests can hand this a
 * four-line fake — and `unknown` rather than a builder type, because the
 * builder is a thenable whose exact shape is the library's business and not
 * this module's.
 */
interface ConfigReader {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<unknown> };
    };
  };
}

interface ConfigRow {
  readonly data?: { readonly value?: string | null } | null;
  readonly error?: unknown;
}

export async function readSieveSeries(
  admin: ConfigReader,
  log?: (message: string) => void,
): Promise<SieveSeriesDocument | null> {
  let raw: string | null = null;
  try {
    const response = (await admin
      .from('system_config')
      .select('value')
      .eq('key', SIEVE_SERIES_CONFIG_KEY)
      .maybeSingle()) as ConfigRow;
    if (response.error !== null && response.error !== undefined) {
      log?.(`sieve_series unreadable, using the built-in series: ${String(response.error)}`);
      return null;
    }
    raw = response.data?.value ?? null;
  } catch (cause) {
    log?.(`sieve_series unreadable, using the built-in series: ${String(cause)}`);
    return null;
  }

  if (raw === null) return null;

  const parsed = parseSieveSeries(raw);
  if (!parsed.ok) {
    // A stored table that breaks a rule is a configuration fault, not a
    // reason to refuse a sample. The built-in series is used and the reason
    // is logged, so somebody can see the setting is not in force.
    log?.(`sieve_series rejected, using the built-in series: ${parsed.reason}`);
    return null;
  }
  return parsed.document;
}
