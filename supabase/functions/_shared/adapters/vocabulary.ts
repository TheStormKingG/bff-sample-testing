/**
 * Read the administrator-editable dropdown lists, for the endpoints that
 * validate against them.
 *
 * WHY THE SERVER READS THEM AT ALL. The option list is the validation
 * contract: `validateStagePayload` refuses a code that is not in it, and so
 * does `toSheetRow`. If only the browser could see an administrator's list,
 * every value they added would be offered on the form and then refused here
 * — the operator would be told their own choice was invalid.
 *
 * WHY IT NEVER THROWS. These lists are a convenience over fields that already
 * have a correct shipped list. Refusing a registration because a vocabulary
 * table could not be read would take the plant's record-keeping offline over
 * a setting. A read that fails yields `null` for that list, `resolveOptions`
 * falls back to the registry's own options, and the reason is logged so the
 * divergence is discoverable rather than silent.
 *
 * An EMPTY table is treated the same way, by `resolveOptions` rather than
 * here: a list with no rows would make a required field impossible to fill,
 * which is a worse failure than an out-of-date list.
 */

import {
  VOCABULARY_LIST_KEYS,
  parseVocabularyRows,
  type VocabularyDocument,
  type VocabularyListKey,
} from '../../../../src/lib/vocabulary.ts';

/**
 * Just enough of the client to read four columns of one table.
 *
 * Structural rather than `SupabaseClient`, so the unit tests can hand this a
 * short fake — the same shape `adapters/sieveSeries.ts` uses, and for the
 * same reason.
 */
interface VocabularyReader {
  from(table: string): {
    select(columns: string): PromiseLike<unknown>;
  };
}

interface ListResponse {
  readonly data?: readonly Record<string, unknown>[] | null;
  readonly error?: unknown;
}

export async function readVocabulary(
  admin: VocabularyReader,
  log?: (message: string) => void,
): Promise<VocabularyDocument> {
  const out: Record<string, ReturnType<typeof parseVocabularyRows>> = {};

  /*
    THE TABLE NAMES ARE LITERALS, not the loop variable they obviously could
    be. Two reasons, and the second is the one that bites.

    `rpc_upsert_controlled_value` already states the first: "five static
    branches rather than one dynamic statement", because a table name
    assembled at runtime inside a privileged path is avoidable and so avoided.

    The second is that `tests/serviceRoleReadContract.test.ts` proves every
    `service_role` grant is matched by a function that actually reads that
    table, by scanning for `.from('name')`. A loop over a key array is
    invisible to it — so the grant would read as unused, and the test would
    have to be weakened to accept a read it cannot see. A grant nothing can
    prove is a grant nobody will dare remove.

    `READERS` is typed `Record<VocabularyListKey, …>`, so adding a fourth list
    to `VOCABULARY_LIST_KEYS` is a compile error here rather than a list that
    silently never loads.
  */
  const READERS: Record<VocabularyListKey, () => PromiseLike<unknown>> = {
    feed_types: () => admin.from('feed_types').select('code,label,sort_order,active'),
    samplers: () => admin.from('samplers').select('code,label,sort_order,active'),
    testers: () => admin.from('testers').select('code,label,sort_order,active'),
  };

  // Sequential rather than `Promise.all`: three small reads, and one failing
  // must not discard the two that worked. Each list falls back on its own.
  for (const key of VOCABULARY_LIST_KEYS) {
    try {
      const response = (await READERS[key]()) as ListResponse;
      if (response.error !== null && response.error !== undefined) {
        log?.(`${key} unreadable, using the shipped list: ${String(response.error)}`);
        continue;
      }
      out[key] = parseVocabularyRows(response.data ?? []);
    } catch (cause) {
      log?.(`${key} unreadable, using the shipped list: ${String(cause)}`);
    }
  }

  return out as VocabularyDocument;
}
