/**
 * POST /sample-action — the five sample decisions the record screen sends.
 *
 * `src/hooks/useSampleDetail.ts` posts `SampleActionKind` — review,
 * request_correction, raise_hold, clear_hold, disposition — to one function
 * name that did not exist. Every one of those failed as an opaque transport
 * error: a reviewer could not sign off, a hold could not be raised or
 * cleared, and no material could be dispositioned.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT. It is a route table and nothing else.
 * Each action maps to a spec that lives in `_shared/handlers/`, and three of
 * those specs are the SAME objects the `review-sample` and `set-disposition`
 * endpoints run. No authority logic is restated here, so there is no second
 * copy of the release gate to drift from the first. The thing a router of
 * this shape usually gets wrong — a quietly different rule on one of its
 * paths — is structurally impossible when the paths are shared specs.
 *
 * WHY A ROUTER RATHER THAN REPOINTING THE FRONTEND. Three of these five
 * actions already had working endpoints, so the obvious fix is to point the
 * hook at them. The hook multiplexes all five onto one call and belongs to
 * another slice, so repointing a constant cannot separate them: it would move
 * two actions to the right endpoint and break the other three. Routing
 * server-side fixes all five without touching a file this slice does not own.
 *
 * AUTHORITY IS NOT DECIDED HERE. `runMutation` authorises before the
 * endpoint's work begins, using the permission on the selected spec, and
 * audits the denial (FR-002). For `disposition` that gate is deliberately only
 * `sample.view`, because which permission a disposition needs depends on the
 * decision — and the disposition spec then performs the real check itself,
 * exactly as it does when reached through `set-disposition`. An ADMINISTRATOR
 * is refused every action in this file: the role holds no `sample.review`, no
 * `hold.*` and no `disposition.*` permission, and there is no branch here that
 * could make an exception.
 */

import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation, type MutationSpec } from '../_shared/adapters/mutation.ts';
import { DISPOSITION_SPEC } from '../_shared/handlers/disposition.ts';
import { reviewSpec } from '../_shared/handlers/review.ts';
import { holdSpec } from '../_shared/handlers/hold.ts';
import { parseAction, SAMPLE_ACTIONS, type SampleAction } from '../_shared/actions.ts';

/**
 * Action -> spec. Total over `SampleAction`, so a new action cannot compile
 * until it is given a spec; there is no default branch that could fall through
 * to a weaker check.
 */
function specFor(action: SampleAction): MutationSpec<Record<string, unknown>> {
  switch (action) {
    case 'review':
      return reviewSpec('reviewed');
    case 'request_correction':
      return reviewSpec('correction_required');
    case 'raise_hold':
      return holdSpec('raise_hold');
    case 'clear_hold':
      return holdSpec('clear_hold');
    case 'disposition':
      return DISPOSITION_SPEC;
  }
}

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, (body) => {
    const action = parseAction(body['action'], SAMPLE_ACTIONS);
    if (action === null) {
      // Thrown before the idempotency key is claimed, so a malformed request
      // does not consume one.
      throw new ApiError('bad_request', {
        message: 'An unknown sample action was requested.',
        details: { field: 'action', allowed: SAMPLE_ACTIONS },
      });
    }
    return specFor(action);
  });
}

serveFunction({ name: 'sample-action', methods: ['POST'] }, handler);
