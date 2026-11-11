/**
 * /api/admin/users: the admin page's user and access management (needs the `admin` permission).
 *   GET                         list accounts with their effective dashboards
 *   PATCH  ?uid=<uid>           { action: 'setAccess' | 'setDisabled' | 'revokeSessions', ... }
 *   DELETE ?uid=<uid>           delete the account and its access record
 * Accounts are not created here: sign-in is Microsoft only and the first sign-in makes the account.
 * Rules and validation live in _lib/adminService.js.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import * as identity from '../_lib/identity.js';
import * as access from '../_lib/access.js';
import { createAdminService } from '../_lib/adminService.js';
import { run, sendError } from '../_lib/adminHttp.js';

const METHODS = ['GET', 'PATCH', 'DELETE'];
const service = createAdminService({ identity, access });

export default async function handler(req, res) {
  const claims = await guard(req, res, 'admin', { methods: METHODS });
  if (!claims) return;
  req.actor = { uid: claims.uid, email: (claims.email || '').toLowerCase() };
  try {
    const [status, body] = await run(req, service);
    return send(res, status, body);
  } catch (err) {
    return sendError(res, err);
  }
}
