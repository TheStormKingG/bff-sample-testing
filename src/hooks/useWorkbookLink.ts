/**
 * Where the operational workbook lives, asked of the server rather than known.
 *
 * ===========================================================================
 * WHY THIS IS A REQUEST AND NOT A CONSTANT
 * ===========================================================================
 * The URL cannot be written into this file. The workbook identifier is an Edge
 * Function secret, and `scripts/check-bundle-secrets.mjs` fails the deployment
 * when it finds a Drive file id anywhere in `dist/` — by the
 * `SHEETS_SPREADSHEET_ID` name, by a `/d/<id>` URL and by a bare id-shaped
 * token. The database is closed to it too: `system_config`'s
 * `sheets_spreadsheet_id_location` row records that the id "is never stored in
 * the database or shipped to the browser".
 *
 * So the browser asks `workbook-link`, which authenticates the caller, checks
 * `sample.view` and builds the URL from the secret it already holds.
 *
 * WHAT THAT BUYS, STATED HONESTLY. It keeps the identifier out of a public
 * artefact — the bundle any visitor can read, signed in or not. It does NOT
 * control who may open the workbook; that is Google's sharing setting, which
 * nothing here can see. If the document is shared as "anyone with the link",
 * everyone who receives this URL, and everyone they forward it to, can read
 * every record in it.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { supabase, edgeErrorMessage } from '@/lib/supabase';
import { FUNCTIONS } from '@/hooks/useSamples';

export interface WorkbookLink {
  /** False when the deployment has no workbook configured. Not an error. */
  readonly configured: boolean;
  /** Absent whenever `configured` is false. */
  readonly url: string | null;
}

/**
 * Narrow the response rather than trusting its shape.
 *
 * `functions.invoke` resolves `data` as `unknown`; casting it would let a
 * changed contract reach the DOM as `href={undefined}`, which renders a link
 * that silently goes nowhere.
 */
export function parseWorkbookLink(data: unknown): WorkbookLink {
  if (typeof data !== 'object' || data === null) {
    throw new Error('The workbook link could not be read.');
  }
  const record = data as Record<string, unknown>;
  const configured = record['configured'] === true;
  const url = typeof record['url'] === 'string' ? record['url'] : null;

  // A URL is only ever rendered as an outbound link, so refuse anything that
  // is not an https Google Sheets address. A `javascript:` or `data:` value
  // arriving here would otherwise become a clickable target.
  if (configured && (url === null || !/^https:\/\/docs\.google\.com\//.test(url))) {
    throw new Error('The workbook link was not a recognised address.');
  }
  return { configured, url: configured ? url : null };
}

/**
 * `enabled` gates the request on the caller being able to use it at all: an
 * unauthenticated visitor would get a 401 and a red error for a button they
 * were never going to see.
 */
export function useWorkbookLink(enabled: boolean): UseQueryResult<WorkbookLink> {
  return useQuery<WorkbookLink>({
    queryKey: ['workbook-link'],
    enabled,
    // The answer changes only when the deployment is reconfigured, which is a
    // redeploy, not a session event.
    staleTime: 60 * 60 * 1000,
    // One attempt. A missing button is a smaller problem than a screen that
    // retries a refused request three times on every visit.
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(FUNCTIONS.workbookLink, {
        method: 'GET',
      });
      if (error !== null) {
        throw new Error(await edgeErrorMessage(error, FUNCTIONS.workbookLink));
      }
      return parseWorkbookLink(data);
    },
  });
}
