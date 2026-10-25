/**
 * POST /review-sample — record a review outcome with its assessment evidence.
 *
 * The logic is `_shared/handlers/review.ts`, moved there so the
 * `sample-action` router can serve the frontend's `review` and
 * `request_correction` actions with THE SAME spec instead of a second copy.
 *
 * `reviewSpec(null)` means "read the outcome from the body", which is what a
 * direct caller of this endpoint supplies. The router passes the outcome
 * instead, because `src/hooks/useSampleDetail.ts` encodes it in the action
 * name and sends no `outcome` field.
 */

import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation } from '../_shared/adapters/mutation.ts';
import { reviewSpec } from '../_shared/handlers/review.ts';

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, reviewSpec(null));
}

serveFunction({ name: 'review-sample', methods: ['POST'] }, handler);
