/**
 * GET /workbook-link — where the operational workbook lives, for a reader who
 * is already signed in.
 *
 * ===========================================================================
 * WHY THIS ENDPOINT EXISTS AT ALL
 * ===========================================================================
 * The Samples screen offers a "View spreadsheet" button. The obvious way to
 * build that is an `<a href>` with the URL written into the component, and it
 * is the one way this project forbids: the workbook identifier is an Edge
 * Function secret with no default, and `scripts/check-bundle-secrets.mjs`
 * FAILS THE DEPLOYMENT when it finds a Drive file id in `dist/` — by three
 * separate rules (the `SHEETS_SPREADSHEET_ID` name, a `/d/<id>` URL, and a
 * bare id-shaped token). `system_config` is closed to it too: the
 * `sheets_spreadsheet_id_location` row states that the id "is never stored in
 * the database or shipped to the browser".
 *
 * So the id stays here, in the one place the design puts it, and the browser
 * is told a URL only after it has proved who it is.
 *
 * ===========================================================================
 * WHAT THIS DOES AND DOES NOT PROTECT
 * ===========================================================================
 * Be precise about this, because the endpoint could otherwise read as a
 * security control it is not. It keeps the identifier out of a PUBLIC artefact
 * — the JavaScript bundle served to anyone who opens the site, signed in or
 * not, and readable by anything that indexes it. That is a real and worthwhile
 * difference from "anyone who views source".
 *
 * It does NOT control access to the workbook. That is Google's sharing
 * setting, and nothing here can see or change it. If the document is shared
 * as "anyone with the link", then everyone this endpoint answers — and anyone
 * they forward the URL to — can read every record in it. Authenticating the
 * caller narrows who learns the link from THIS app; it does not narrow who may
 * open it.
 *
 * `sample.view` is the permission required, because the workbook holds the
 * same records the Samples screen does and nothing further: a reader who may
 * list samples here may read them there.
 *
 * The URL is built as `/preview`, not `/edit`. An operator following a link
 * out of a quality system should land on a read-only view; a stray keystroke
 * in an edit view lands in an audited record that the server believes it owns.
 */

import { jsonResponse, serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { authenticate } from '../_shared/adapters/authorize.ts';
import { optionalEnv } from '../_shared/adapters/env.ts';
import { ApiError } from '../_shared/errors.ts';
import { can } from '../../../src/lib/roles.ts';

async function handler(ctx: RequestContext): Promise<Response> {
  // `authenticate` raises `unauthenticated` for a null or rejected token, and
  // `account_not_active` for a profile that is pending, suspended or disabled.
  const actor = await authenticate(ctx.bearerToken);

  if (!can(actor.authority, 'sample.view')) {
    throw new ApiError('forbidden', {
      internalDetail: `actor ${actor.userId} lacks sample.view for /workbook-link`,
    });
  }

  const spreadsheetId = optionalEnv('SHEETS_SPREADSHEET_ID', '').trim();

  // Absent is a legitimate state, not a fault: a deployment that has not been
  // pointed at a workbook yet should hide the button rather than offer a link
  // to nowhere. Reported as a flag so the client can tell "not configured"
  // from "request failed", which it cannot do from an error alone.
  if (spreadsheetId === '') {
    return jsonResponse({ configured: false, url: null }, { request: ctx.request });
  }

  return jsonResponse(
    {
      configured: true,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/preview`,
    },
    { request: ctx.request },
  );
}

serveFunction({ name: 'workbook-link', methods: ['GET', 'POST'] }, handler);
