/** GET /api/admin/audit: the latest 100 admin changes, newest first (needs the `admin` permission). */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { listAudit } from '../_lib/access.js';
import { sendError } from '../_lib/adminHttp.js';

export default async function handler(req, res) {
  if (!(await guard(req, res, 'admin'))) return;
  try {
    return send(res, 200, { entries: await listAudit(100) });
  } catch (err) {
    return sendError(res, err);
  }
}
