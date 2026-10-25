/**
 * POST /set-disposition — record what an authorised person decided about the
 * material.
 *
 * The whole decision — the release evaluation built from stored state, the
 * decision-specific permission, the hold-clearing check, `checkDisposition`
 * and the transaction — lives in `_shared/handlers/disposition.ts`. It was
 * moved there so the `sample-action` router can serve the frontend's
 * `disposition` action by running THE SAME spec, rather than a second copy of
 * the authority logic that would be free to drift from this one. There is one
 * implementation of a disposition in this codebase and both routes reach it.
 *
 * This file is now only a route. Keeping it is not ceremony: it is the
 * endpoint a direct API caller and the deploy checklist already name, and it
 * keeps `set_disposition` as its own operation in the request registry.
 */

import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation } from '../_shared/adapters/mutation.ts';
import { DISPOSITION_SPEC } from '../_shared/handlers/disposition.ts';

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, DISPOSITION_SPEC);
}

serveFunction({ name: 'set-disposition', methods: ['POST'] }, handler);
