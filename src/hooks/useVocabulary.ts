/**
 * The administrator-editable dropdown lists, as the forms draw them.
 *
 * ===========================================================================
 * THE SAME ROWS THE SERVER VALIDATES AGAINST
 * ===========================================================================
 * `supabase/functions/_shared/adapters/vocabulary.ts` reads these three
 * tables before validating a payload. This is the same read from the other
 * side — not a second source. If the two diverged, the form would offer a
 * value the server refuses, and the operator would be told their own choice
 * was invalid.
 *
 * ===========================================================================
 * IT IS NOT A CONTROL
 * ===========================================================================
 * These tables are readable by any active signed-in account, which is
 * correct: a list of feed types and sampler names is reference data, not a
 * decision. Writing goes through `rpc_upsert_controlled_value` under
 * `user.manage`, which audits every change.
 *
 * A read that fails yields an EMPTY document, and `resolveOptions` then
 * falls back to the list the application shipped with. That is deliberate
 * and it is the opposite of the DGM targets, where empty means "no band":
 * here an empty list would make a required field impossible to fill, so the
 * shipped list is the safe answer rather than nothing.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import {
  VOCABULARY_LIST_KEYS,
  parseVocabularyRows,
  type VocabularyDocument,
  type VocabularyListKey,
} from '@/lib/vocabulary';

export function useVocabulary(): UseQueryResult<VocabularyDocument> {
  return useQuery<VocabularyDocument>({
    queryKey: ['vocabulary'],
    // A feed type or a sampler changes when the product range or the payroll
    // does, not during a shift. Invalidated outright when an administrator
    // saves a list — see `useAdmin`'s `onSuccess`.
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      // Literal table names, typed exhaustively, for the same reasons the
      // Edge adapter spells them out — see its header.
      const readers: Record<VocabularyListKey, () => PromiseLike<unknown>> = {
        feed_types: () => supabase.from('feed_types').select('code,label,sort_order,active'),
        samplers: () => supabase.from('samplers').select('code,label,sort_order,active'),
        testers: () => supabase.from('testers').select('code,label,sort_order,active'),
      };

      const out: Record<string, ReturnType<typeof parseVocabularyRows>> = {};
      for (const key of VOCABULARY_LIST_KEYS) {
        const response = (await readers[key]()) as {
          data?: Record<string, unknown>[] | null;
          error?: unknown;
        };
        // One list failing must not discard the two that worked; each falls
        // back to its own shipped options independently.
        if (response.error !== null && response.error !== undefined) continue;
        out[key] = parseVocabularyRows(response.data ?? []);
      }
      return out as VocabularyDocument;
    },
  });
}
