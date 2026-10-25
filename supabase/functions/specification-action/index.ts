/**
 * POST /specification-action — propose a limit, send it for review, approve it
 * or reject it.
 *
 * `src/hooks/useSpecifications.ts` posts propose | submit_review | approve |
 * reject to one function name that did not exist, so no limit could be
 * proposed and none approved — which on this deployment means every
 * measurement stays `not_assessable` for ever, since 0 of the 34 workbook
 * limits are approved.
 *
 * A route table only. `approve` and `reject` run the SAME spec the
 * `approve-specification` endpoint runs, so the segregation-of-duties check
 * that stops a proposer approving their own rule exists once and cannot be
 * bypassed by arriving through this door.
 *
 * TWO PERMISSIONS, AND THE SPLIT IS THE CONTROL. Proposing needs
 * `spec.propose`; approving needs `spec.approve`. A quality officer holds only
 * the first, so the person who proposes a limit cannot put it in force. An
 * ADMINISTRATOR holds NEITHER and is refused all four actions with the attempt
 * logged — "an Administrator is not automatically a quality-release approver"
 * (PRD §2), enforced by the matrix rather than by a check in this file.
 */

import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation, type MutationSpec } from '../_shared/adapters/mutation.ts';
import {
  APPROVE_SPECIFICATION_SPEC,
  PROPOSE_SPECIFICATION_SPEC,
  SUBMIT_SPECIFICATION_SPEC,
} from '../_shared/handlers/specification.ts';
import {
  parseAction,
  SPECIFICATION_ACTIONS,
  type SpecificationAction,
} from '../_shared/actions.ts';

/** Total over `SpecificationAction`; no default branch. */
function specFor(action: SpecificationAction): MutationSpec<Record<string, unknown>> {
  switch (action) {
    case 'propose':
      return PROPOSE_SPECIFICATION_SPEC;
    case 'submit_review':
      return SUBMIT_SPECIFICATION_SPEC;
    case 'approve':
    case 'reject':
      /**
       * One spec for both. It reads the decision from
       * `body['decision'] ?? body['action']`, and the action IS 'approve' or
       * 'reject', so the frontend's payload needs no translation — and the
       * decision the spec acts on is the one the caller sent, not one this
       * router inferred.
       */
      return APPROVE_SPECIFICATION_SPEC;
  }
}

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, (body) => {
    const action = parseAction(body['action'], SPECIFICATION_ACTIONS);
    if (action === null) {
      throw new ApiError('bad_request', {
        message: 'An unknown specification action was requested.',
        details: { field: 'action', allowed: SPECIFICATION_ACTIONS },
      });
    }
    return specFor(action);
  });
}

serveFunction({ name: 'specification-action', methods: ['POST'] }, handler);
