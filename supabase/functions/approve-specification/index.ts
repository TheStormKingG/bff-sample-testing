/**
 * POST /approve-specification — approve or reject a proposed limit.
 *
 * The logic, including the segregation-of-duties check that stops a proposer
 * approving their own rule, is `_shared/handlers/specification.ts`. It was
 * moved there so the `specification-action` router can serve the frontend's
 * `approve` and `reject` actions with THE SAME spec — one implementation of
 * the only code in this system that can put a numeric limit into force.
 */

import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation } from '../_shared/adapters/mutation.ts';
import { APPROVE_SPECIFICATION_SPEC } from '../_shared/handlers/specification.ts';

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, APPROVE_SPECIFICATION_SPEC);
}

serveFunction({ name: 'approve-specification', methods: ['POST'] }, handler);
