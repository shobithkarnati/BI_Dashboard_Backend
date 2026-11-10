/**
 * GET /api/me/permissions
 *
 * Tells the signed-in browser which dashboards the server will let it open. Used only to filter
 * navigation and route guards: every data endpoint authorises independently. Deny by default.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { getEffectiveDashboards } from '../_lib/access.js';

export default async function handler(req, res) {
  const claims = await guard(req, res, null);
  if (!claims) return;
  return send(res, 200, { dashboards: await getEffectiveDashboards(claims.email) });
}
