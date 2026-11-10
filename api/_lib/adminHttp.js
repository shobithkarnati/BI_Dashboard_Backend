/** Request/response plumbing shared by the admin endpoints. */

import { send } from './respond.js';
import { GoogleApiError } from './google.js';
import { AdminError } from './adminService.js';

/** The parsed JSON body as a plain object ({} when absent or not an object). */
export const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

export function sendError(res, err) {
  if (err instanceof AdminError || err instanceof GoogleApiError) return send(res, err.status, { error: err.message });
  console.error('Admin request failed:', err?.message);
  return send(res, 500, { error: 'Server error.' });
}

export async function run(req, svc) {
  const body = bodyOf(req);
  const uid = typeof req.query?.uid === 'string' ? req.query.uid : '';
  switch (req.method) {
    case 'GET':
      return [200, { users: await svc.listUsers() }];
    case 'POST':
      return [201, { user: await svc.createUser(req.actor, body) }];
    case 'PATCH':
      switch (body.action) {
        case 'setAccess': return [200, await svc.setAccess(req.actor, uid, body.dashboards)];
        case 'setDisabled': return [200, await svc.setDisabled(req.actor, uid, body.disabled)];
        case 'setPassword': return [200, await svc.setPassword(req.actor, uid, body.password)];
        case 'revokeSessions': return [200, await svc.revokeSessions(req.actor, uid)];
        default: throw new AdminError('Unknown action.');
      }
    case 'DELETE':
      return [200, await svc.deleteUser(req.actor, uid)];
    default:
      throw new AdminError('Method not allowed.', 405);
  }
}
