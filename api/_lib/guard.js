/**
 * Shared request guard for every protected endpoint:
 *   1. method must be GET (admin endpoints list the extra methods they accept) (405)
 *   2. exact-origin check, a second layer only                  (403)
 *   3. Firebase ID token verified server-side (jose, Google's    (401)
 *      public keys), signed in with email + password only
 *   4. account still active: not disabled, deleted or revoked   (401)
 *   5. the account is authorised for the endpoint's dashboard   (403), deny by default
 * Responses never include tokens, keys or internals; the real reason goes to the server log.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { send } from './respond.js';
import { getEffectiveDashboards } from './access.js';
import { getAccessToken, firebaseServiceAccount, SCOPES } from './google.js';

const ACCOUNT_CACHE_MS = 60_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const toOrigin = (value) => {
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return '';
  }
};

/** Exact-match origins from ALLOWED_ORIGIN (plus `platform.origins`, set by the server, never from the browser). No hard-coded default. */
export function getAllowedOrigins(env = process.env, platform = {}) {
  return new Set([...(env.ALLOWED_ORIGIN || '').split(','), ...(platform.origins || [])].map(toOrigin).filter(Boolean));
}

/** Same-origin GETs may carry no Origin header, so the Referer's origin is the fallback (as in the source apps). */
export function isAllowedOrigin(headers, env = process.env, platform = {}) {
  const origin = toOrigin(headers?.origin || headers?.referer || '');
  if (!origin) return false;
  if (getAllowedOrigins(env, platform).has(origin)) return true;
  // Localhost only on this computer: never on Cloud Run (server.js sets platform.deployed) or with NODE_ENV=production.
  const isProduction = env.NODE_ENV === 'production' || platform.deployed === true;
  return !isProduction && LOCAL_HOSTS.has(new URL(origin).hostname);
}

// Google's public keys for Firebase ID tokens (JWK form). jose fetches them on first use and caches them.
export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_TOLERANCE_S = 5;
let remoteKeys = null;
const firebaseKeys = () => (remoteKeys ||= createRemoteJWKSet(new URL(FIREBASE_JWKS_URL)));

/**
 * Verifies a Firebase ID token as Google documents it (no Admin SDK): RS256 signed by one of the
 * securetoken keys, iss = https://securetoken.google.com/<project>, aud = <project>, not expired,
 * iat and auth_time in the past, sub a non-empty string (the uid). Returns the claims with `uid`
 * added, the same shape firebase-admin's verifyIdToken returned. `keys` / `now` are for tests.
 */
export async function verifyFirebaseIdToken(token, { projectId = process.env.FIREBASE_PROJECT_ID, keys = firebaseKeys(), now } = {}) {
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not set.');
  if (typeof token !== 'string' || !token) throw new Error('Missing ID token.');
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
    clockTolerance: CLOCK_TOLERANCE_S,
    ...(now ? { currentDate: now } : {}),
  });
  const nowS = Math.floor((now ? now.getTime() : Date.now()) / 1000);
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('ID token has no valid subject.');
  if (typeof payload.iat !== 'number' || payload.iat > nowS + CLOCK_TOLERANCE_S) throw new Error('ID token issued in the future.');
  if (typeof payload.auth_time !== 'number' || payload.auth_time > nowS + CLOCK_TOLERANCE_S) throw new Error('ID token auth_time is in the future.');
  return { ...payload, uid: payload.sub };
}

/** Only email + password accounts may use the dashboards (not anonymous, phone, custom-token or federated sign-ins). */
export const ALLOWED_SIGN_IN_PROVIDER = 'password';

const accountStatus = new Map(); // uid -> { account, expiresAt }

/**
 * Drops the cached account status for `uid`, so the next request re-checks it with Firebase at once.
 * Called by the admin service after it disables, deletes or signs out a user. The cache is per
 * server instance: other Cloud Run instances pick the change up within ACCOUNT_CACHE_MS.
 */
export function forgetAccount(uid) {
  if (typeof uid === 'string' && uid) accountStatus.delete(uid);
}

/**
 * Rejects users that were disabled, deleted, or had their sessions revoked after this sign-in.
 * Uses a direct Identity Toolkit lookup (proven in the Service Center source) rather than
 * verifyIdToken(token, true), which broke once bundled in the original deployment.
 */
async function assertAccountActive(claims) {
  let entry = accountStatus.get(claims.uid);
  if (!entry || Date.now() > entry.expiresAt) {
    const accessToken = await getAccessToken(firebaseServiceAccount(), SCOPES.identity);
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(process.env.FIREBASE_PROJECT_ID)}/accounts:lookup`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: [claims.uid] }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Account lookup failed (HTTP ${response.status}).`);
    entry = { account: data.users?.[0] || null, expiresAt: Date.now() + ACCOUNT_CACHE_MS };
    accountStatus.set(claims.uid, entry);
  }
  const { account } = entry;
  if (!account) throw new Error('User no longer exists.');
  if (account.disabled) throw new Error('User is disabled.');
  if (account.validSince && claims.auth_time < Number(account.validSince)) throw new Error('Session was revoked.');
}

/**
 * Builds a guard. `deps` are injectable so the policy can be unit tested without Firebase.
 * Returns the verified token claims, or null after having sent the rejection response.
 */
export function createGuard(deps = {}) {
  const verify = deps.verifyIdToken || ((token) => verifyFirebaseIdToken(token));
  const assertActive = deps.assertAccountActive || assertAccountActive;
  const env = deps.env || process.env;
  // Grants come from the admin database with DASHBOARD_ACCESS as fallback (access.js); a sync or async override is accepted for tests.
  const allowed = deps.canAccess || (async (email, dashboard) => (await getEffectiveDashboards(email, env)).includes(dashboard));

  /** `dashboard` is required for data endpoints; null means "signed-in, active account" (permission lookup only). */
  return async function guard(req, res, dashboard, { methods = ['GET'] } = {}) {
    if (!methods.includes(req.method)) {
      send(res, 405, { error: 'Method Not Allowed' });
      return null;
    }
    if (!isAllowedOrigin(req.headers, env, req.platform)) {
      send(res, 403, { error: 'Forbidden' });
      return null;
    }

    const header = req.headers?.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) {
      send(res, 401, { error: 'Missing authentication token.' });
      return null;
    }

    let claims;
    try {
      claims = await verify(idToken);
      const provider = claims?.firebase?.sign_in_provider;
      if (provider !== ALLOWED_SIGN_IN_PROVIDER) throw new Error(`Sign-in provider "${String(provider)}" is not allowed.`);
      await assertActive(claims);
    } catch (err) {
      console.error('Authentication rejected:', err.message);
      send(res, 401, { error: 'Invalid or expired session. Please sign in again.' });
      return null;
    }

    if (dashboard && !(await allowed(claims.email, dashboard))) {
      console.error(`Access denied: uid=${claims.uid} dashboard=${dashboard}`);
      send(res, 403, { error: 'This account does not have access to this dashboard.' });
      return null;
    }
    return claims;
  };
}

export const guard = createGuard();
