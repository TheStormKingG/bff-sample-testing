/**
 * POST /admin-action — accounts, roles, delegations and controlled lists.
 *
 * A route table. The logic is `_shared/handlers/admin.ts`; the action
 * vocabulary and its permission table are `_shared/actions.ts`. Both are kept
 * out of this file so the authority surface is one screen of data rather than
 * seven branches of code.
 *
 * `src/hooks/useAdmin.ts` posts all seven actions here. None of them is a
 * quality decision, and that is by construction rather than by review: the
 * vocabulary contains no sample, disposition, hold or specification action, so
 * an administrator cannot reach one through this endpoint however it is
 * called. The one place administrative power could become quality power —
 * creating a delegation — is bounded in `delegationGrantRefusal`, which
 * refuses any permission the grantor does not hold themselves and refuses
 * `disposition.override_release` outright.
 */

import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation } from '../_shared/adapters/mutation.ts';
import { adminSpec } from '../_shared/handlers/admin.ts';
import { ADMIN_ACTIONS, parseAction } from '../_shared/actions.ts';

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, (body) => {
    const action = parseAction(body['action'], ADMIN_ACTIONS);
    if (action === null) {
      throw new ApiError('bad_request', {
        message: 'An unknown administration action was requested.',
        details: { field: 'action', allowed: ADMIN_ACTIONS },
      });
    }
    return adminSpec(action);
  });
}

serveFunction({ name: 'admin-action', methods: ['POST'] }, handler);
