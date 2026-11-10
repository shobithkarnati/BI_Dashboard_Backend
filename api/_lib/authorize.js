/**
 * Dashboard-level authorization from the DASHBOARD_ACCESS environment variable.
 *
 *   DASHBOARD_ACCESS={"user.one":["advisor","bookings"],"user.two":["*","admin"]}
 *
 * This variable is the bootstrap: once the admin page stores grants in Firestore, those take over for
 * the users they cover (see access.js). "*" means every data dashboard; "admin" is always explicit.
 *
 * Deny by default: a missing, empty, malformed or wrongly-shaped value grants nothing to anybody.
 * Keys are User IDs or full emails, normalised exactly like the sign-in mapping
 * (lowercase; a bare User ID becomes <id>@bluewheel.app).
 */

// The dashboard list lives in shared/dashboards.js. `admin` is the user-management page:
// "*" never includes it, it has to be granted by name.
import { DASHBOARD_IDS, DATA_DASHBOARD_IDS } from '../../shared/dashboards.js';

export const AUTH_EMAIL_DOMAIN = 'bluewheel.app';
export const DATA_DASHBOARDS = DATA_DASHBOARD_IDS;
export const DASHBOARDS = DASHBOARD_IDS;

export function normalizeIdentity(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  return v.includes('@') ? v : `${v}@${AUTH_EMAIL_DOMAIN}`;
}

/** Parses DASHBOARD_ACCESS into Map<email, Set<dashboard>>. Never throws; invalid input yields an empty map. */
export function parseAccess(raw) {
  const access = new Map();
  if (!raw || !String(raw).trim()) return access;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('DASHBOARD_ACCESS is not valid JSON; all access is denied.');
    return access;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('DASHBOARD_ACCESS must be a JSON object; all access is denied.');
    return access;
  }

  for (const [identity, grants] of Object.entries(parsed)) {
    const key = normalizeIdentity(identity);
    if (!key || !Array.isArray(grants)) continue;
    const allowed = new Set();
    for (const grant of grants) {
      if (grant === '*') DATA_DASHBOARDS.forEach((d) => allowed.add(d));
      else if (DASHBOARDS.includes(grant)) allowed.add(grant);
    }
    if (allowed.size > 0) access.set(key, allowed);
  }
  return access;
}

/** Dashboards the given account email may open, in canonical order. */
export function getDashboards(email, raw = process.env.DASHBOARD_ACCESS) {
  const allowed = parseAccess(raw).get(normalizeIdentity(email));
  return allowed ? DASHBOARDS.filter((d) => allowed.has(d)) : [];
}

export function canAccess(email, dashboard, raw = process.env.DASHBOARD_ACCESS) {
  return DASHBOARDS.includes(dashboard) && getDashboards(email, raw).includes(dashboard);
}

/** Whether `email` is in a comma-separated list of User IDs or full emails (used for the optional per-sheet lists). */
export function isUserInList(rawList, email) {
  const target = normalizeIdentity(email);
  if (!target) return false;
  return String(rawList || '')
    .split(',')
    .map(normalizeIdentity)
    .filter(Boolean)
    .includes(target);
}
