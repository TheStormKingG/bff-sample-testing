/**
 * The lab's sieve table, as the administrator has it.
 *
 * ===========================================================================
 * WHY THE BROWSER READS IT AT ALL
 * ===========================================================================
 * Three things on the form come from this table and would otherwise disagree
 * with the figures the server stores: the empty weights seeded into the tare
 * fields, the ABNT designation and aperture shown on each row of the sieve
 * grid, and the apertures the confirmation chart recomputes its curve from.
 *
 * The SERVER reads the same row and computes the stored figures from it
 * (`supabase/functions/_shared/adapters/sieveSeries.ts`). This is the same
 * value, not a second source: if the two ever diverged the chart would draw a
 * different distribution from the one the record holds.
 *
 * ===========================================================================
 * IT IS NOT A CONTROL
 * ===========================================================================
 * `system_config` is readable by any active signed-in account, which is
 * correct — the sieve table is equipment documentation, not a limit and not a
 * decision. Writing it goes through `rpc_set_sieve_series` under
 * `user.manage`, which is where the authority lives.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import {
  SIEVE_SERIES_CONFIG_KEY,
  defaultSieveSeriesDocument,
  parseSieveSeries,
  type SieveSeriesDocument,
} from '@/lib/sieveSeries';

export const SYSTEM_CONFIG_TABLE = 'system_config';

export interface SieveSeriesState {
  readonly document: SieveSeriesDocument;
  /** False when the built-in series is in use because the stored one is not. */
  readonly stored: boolean;
  /** Why the stored table was not used, when it was not. */
  readonly problem: string | null;
}

/**
 * Never throws and never leaves the caller without a table: a row that cannot
 * be read, or that breaks one of the rules in `parseSieveSeries`, yields the
 * built-in series and the reason. A form that refused to open because a
 * configuration row was malformed would take the plant's record-keeping
 * offline over a setting — and the built-in series is the one the figures
 * were calibrated against, so it is the right thing to fall back to.
 */
export function useSieveSeries(): UseQueryResult<SieveSeriesState> {
  return useQuery<SieveSeriesState>({
    queryKey: ['sieve-series'],
    // Equipment documentation changes when a sieve is replaced, not during a
    // shift. An hour is far longer than any one form is open.
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const fallback = (problem: string | null): SieveSeriesState => ({
        document: defaultSieveSeriesDocument(),
        stored: false,
        problem,
      });

      const { data, error } = await supabase
        .from(SYSTEM_CONFIG_TABLE)
        .select('value')
        .eq('key', SIEVE_SERIES_CONFIG_KEY)
        .maybeSingle();

      if (error !== null) return fallback(null);
      const raw = (data as { value?: string | null } | null)?.value ?? null;
      if (raw === null) return fallback(null);

      const parsed = parseSieveSeries(raw);
      if (!parsed.ok) return fallback(parsed.reason);
      return { document: parsed.document, stored: true, problem: null };
    },
  });
}
