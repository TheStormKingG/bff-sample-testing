/**
 * The DGM target ranges, as the administrator has them.
 *
 * ===========================================================================
 * THE BROWSER IS THE ONLY READER
 * ===========================================================================
 * Unlike the sieve table, nothing on the server reads this document: it is an
 * input to no computation and no stored figure. It decides what a results
 * screen shades green, and nothing else. There is therefore no second reader
 * to diverge from — see `src/lib/dgmTargets.ts` for why that matters.
 *
 * ===========================================================================
 * IT IS NOT A CONTROL, AND IT FAILS TO NOTHING
 * ===========================================================================
 * `system_config` is readable by any active signed-in account, which is
 * correct: the target is published guidance the lab has adopted, not a
 * decision. Writing it goes through `rpc_set_dgm_target_ranges` under
 * `user.manage`.
 *
 * A row that cannot be read, or that breaks one of the rules in
 * `parseDgmTargets`, yields an EMPTY document and the reason. Empty is the
 * right failure: every screen then shows the DGM exactly as it did before
 * targets existed. The alternative — falling back to a built-in range — would
 * put a figure on a quality record that no administrator had set, which is
 * the one thing this feature was built to avoid.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import {
  DGM_TARGETS_CONFIG_KEY,
  emptyDgmTargets,
  parseDgmTargets,
  type DgmTargetDocument,
} from '@/lib/dgmTargets';
import { SYSTEM_CONFIG_TABLE } from '@/hooks/useSieveSeries';

export interface DgmTargetState {
  readonly document: DgmTargetDocument;
  /** False when no stored document is in force. */
  readonly stored: boolean;
  /** Why the stored document was not used, when it was not. */
  readonly problem: string | null;
}

export function useDgmTargets(): UseQueryResult<DgmTargetState> {
  return useQuery<DgmTargetState>({
    queryKey: ['dgm-target-ranges'],
    // A target changes when a nutritionist revises it, not during a shift.
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const none = (problem: string | null): DgmTargetState => ({
        document: emptyDgmTargets(),
        stored: false,
        problem,
      });

      const { data, error } = await supabase
        .from(SYSTEM_CONFIG_TABLE)
        .select('value')
        .eq('key', DGM_TARGETS_CONFIG_KEY)
        .maybeSingle();

      if (error !== null) return none(null);
      const raw = (data as { value?: string | null } | null)?.value ?? null;
      if (raw === null) return none(null);

      const parsed = parseDgmTargets(raw);
      if (!parsed.ok) return none(parsed.reason);
      return { document: parsed.document, stored: true, problem: null };
    },
  });
}
