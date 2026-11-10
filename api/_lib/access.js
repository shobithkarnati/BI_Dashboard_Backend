/**
 * Where dashboard grants live: the Firestore collection `access` (document id = the account email,
 * field `dashboards` = array of strings), edited by admins on the admin page. DASHBOARD_ACCESS is the
 * bootstrap and break-glass: a user with a Firestore document uses it; a user without one falls back to
 * the environment value; and `admin` in the environment always applies, so an empty or broken
 * database can never lock every admin out. Anything unreadable fails closed to the environment value.
 *
 * Firestore is reached over REST with the service account, so the database's own rules can (and
 * should) deny all client access: see docs/ADMIN.md.
 */

import { googleFetch, GoogleApiError, SCOPES } from './google.js';
import { DASHBOARDS, getDashboards, normalizeIdentity } from './authorize.js';
import { withImplied } from '../../shared/dashboards.js';

const GRANT_CACHE_MS = 30_000;
const grantCache = new Map(); // email -> { dashboards: string[] | null, expiresAt }

const docsBase = (env = process.env) =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;

const toFields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v)
  ? { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } }
  : { stringValue: String(v) }]));
const fromFields = (fields = {}) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k,
  v.arrayValue ? (v.arrayValue.values || []).map((x) => x.stringValue) : (v.stringValue ?? v.integerValue ?? v.timestampValue ?? null)]));
const docEmail = (doc) => {
  const raw = String(doc.name || '').split('/').pop() || '';
  try { return decodeURIComponent(raw); } catch { return raw; } // a stray "%" must not break the whole list
};
const known = (list) => (list || []).filter((d) => DASHBOARDS.includes(d));

async function firestore(path, { method = 'GET', body } = {}) {
  const { status, data } = await googleFetch(`${docsBase()}${path}`, SCOPES.datastore, { method, body });
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    console.error('Firestore error:', data?.error?.message || `HTTP ${status}`);
    throw new GoogleApiError('Could not reach the access database.', 502);
  }
  return data;
}

/** Stored dashboards for an email, or null when there is no document. */
export async function readGrant(email) {
  const doc = await firestore(`/access/${encodeURIComponent(normalizeIdentity(email))}`);
  return doc ? known(fromFields(doc.fields).dashboards) : null;
}

/** Map<email, dashboards[]> of every stored grant. */
export async function listGrants() {
  const grants = new Map();
  let pageToken = '';
  do {
    const qs = `pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await firestore(`/access?${qs}`);
    for (const doc of data?.documents || []) grants.set(normalizeIdentity(docEmail(doc)), known(fromFields(doc.fields).dashboards));
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return grants;
}

export async function writeGrant(email, dashboards, actor) {
  const key = normalizeIdentity(email);
  const saved = await firestore(`/access/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: { fields: toFields({ dashboards, updatedBy: actor, updatedAt: new Date().toISOString() }) },
  });
  if (!saved) throw new GoogleApiError('Could not save the access change.', 502);
  grantCache.delete(key);
}

export async function removeGrant(email) {
  const key = normalizeIdentity(email);
  await firestore(`/access/${encodeURIComponent(key)}`, { method: 'DELETE' });
  grantCache.delete(key);
}

/** Drops the cached grant for `email` so the next permission check reads the database again. */
export function forgetGrant(email) {
  const key = normalizeIdentity(email);
  if (key) grantCache.delete(key);
}

/** Pure merge used by the guard, the permissions endpoint and the admin page's "last admin" rule. */
export function mergeGrants(email, stored, env = process.env) {
  const fromEnv = getDashboards(email, env.DASHBOARD_ACCESS);
  const merged = new Set(stored ?? fromEnv);
  if (fromEnv.includes('admin')) merged.add('admin'); // break-glass: the environment's admins stay admins
  return withImplied(DASHBOARDS.filter((d) => merged.has(d)));
}

/** Dashboards the account may open right now. Never throws: a database problem falls back to the environment. */
export async function getEffectiveDashboards(email, env = process.env) {
  const key = normalizeIdentity(email);
  if (!key) return [];
  const hit = grantCache.get(key);
  let stored;
  if (hit && hit.expiresAt > Date.now()) {
    stored = hit.dashboards;
  } else {
    try {
      stored = await readGrant(key);
      grantCache.set(key, { dashboards: stored, expiresAt: Date.now() + GRANT_CACHE_MS });
    } catch (err) {
      console.error('Access database unavailable, using DASHBOARD_ACCESS only:', err.message);
      stored = null;
    }
  }
  return mergeGrants(key, stored, env);
}

/** Appends an audit entry. Failing to log must not undo a change that already happened, but it is loud. */
export async function writeAudit({ actor, action, target, detail = '' }) {
  try {
    await firestore('/audit', {
      method: 'POST',
      body: { fields: toFields({ at: new Date().toISOString(), actor, action, target, detail }) },
    });
  } catch (err) {
    console.error(`AUDIT WRITE FAILED (${action} by ${actor} on ${target}):`, err.message);
  }
}

export async function listAudit(limit = 100) {
  const data = await firestore(':runQuery', {
    method: 'POST',
    body: { structuredQuery: { from: [{ collectionId: 'audit' }], orderBy: [{ field: { fieldPath: 'at' }, direction: 'DESCENDING' }], limit } },
  });
  return (Array.isArray(data) ? data : []).filter((r) => r.document).map((r) => {
    const f = fromFields(r.document.fields);
    return { at: f.at, actor: f.actor, action: f.action, target: f.target, detail: f.detail || '' };
  });
}
