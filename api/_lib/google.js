/**
 * Google service-account access without Google client libraries (they pull ESM-only dependencies
 * that break in bundled serverless functions). A self-signed JWT is exchanged for an OAuth token.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPES = {
  bigquery: 'https://www.googleapis.com/auth/bigquery.readonly',
  // Product Management saves its changes to the pricing_control dataset (never to zmater); reads still use the read-only scope.
  bigqueryEdit: 'https://www.googleapis.com/auth/bigquery',
  sheets: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  identity: 'https://www.googleapis.com/auth/identitytoolkit',
  datastore: 'https://www.googleapis.com/auth/datastore',
};
const REQUEST_TIMEOUT_MS = 20_000;

/** An upstream Google failure carrying a status and a message that is safe to show the browser. */
export class GoogleApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Private key with real newlines, whether stored with "\n" or "\\n". */
export function normalizePrivateKey(value) {
  return (value || '').replace(/\\+n/g, '\n');
}

export function firebaseServiceAccount(env = process.env) {
  return { clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY) };
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const tokens = new Map(); // `${email} ${scope}` -> { value, expiresAt }, reused across warm invocations

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** On Google Cloud (Cloud Run sets K_SERVICE) with no key configured: use the service account the server runs as. */
export const usesRuntimeAccount = ({ clientEmail, privateKey }, env = process.env) => !(clientEmail && privateKey) && Boolean(env.K_SERVICE);

async function runtimeAccountToken(scope) {
  const cacheKey = `runtime ${scope}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value;
  const response = await fetch(`${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(scope)}`, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`Runtime service account token failed (HTTP ${response.status}).`);
  tokens.set(cacheKey, { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

/**
 * OAuth token for `scope`. With FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (this computer) a signed JWT
 * is exchanged; on Cloud Run without them, the runtime service account's token is used (no key stored).
 */
export async function getAccessToken({ clientEmail, privateKey }, scope) {
  if (usesRuntimeAccount({ clientEmail, privateKey })) return runtimeAccountToken(scope);
  if (!clientEmail || !privateKey) throw new Error('Missing service account credentials.');
  const cacheKey = `${clientEmail} ${scope}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: clientEmail, scope, aud: TOKEN_URL, iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token exchange failed (HTTP ${response.status}).`);
  }
  tokens.set(cacheKey, { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

/**
 * Raw call to a Google API as the service account. Returns `{ status, data }` without mapping errors,
 * for the admin endpoints that need Google's own error codes (EMAIL_EXISTS, 404 on a missing document…).
 * Only network failures and a missing token throw.
 */
export async function googleFetch(url, scope, { method = 'GET', body, account = firebaseServiceAccount() } = {}) {
  let token;
  try {
    token = await getAccessToken(account, scope);
  } catch (err) {
    console.error('Could not obtain a Google access token:', err.message);
    throw new GoogleApiError('Server configuration error.', 500);
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('Network error reaching Google:', err.message);
    throw new GoogleApiError('Could not reach Google.', 502);
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

/**
 * GETs a Google API URL with a service-account token and returns parsed JSON.
 * `what` names the data in browser-facing messages; the real Google message stays in the server log.
 *  - 400/404     -> 404 ("not found": a missing table or sheet tab is a configuration problem)
 *  - 429         -> 429
 *  - 401/403/5xx -> 502 (our credentials or Google failed, not the user's session)
 */
export async function googleGet(url, scope, what, account = firebaseServiceAccount()) {
  let token;
  try {
    token = await getAccessToken(account, scope);
  } catch (err) {
    console.error('Could not obtain a Google access token:', err.message);
    throw new GoogleApiError('Server configuration error.', 500);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('Network error reaching Google:', err.message);
    throw new GoogleApiError('Could not reach Google.', 502);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new GoogleApiError('Unreadable response from Google.', 502);
  }

  if (!response.ok) {
    console.error(`Google API error reading ${what}:`, data?.error?.message || `HTTP ${response.status}`);
    if (response.status === 404 || response.status === 400) throw new GoogleApiError(`The ${what} was not found.`, 404);
    throw new GoogleApiError(`Could not read the ${what}.`, response.status === 429 ? 429 : 502);
  }
  return data;
}

/** Maps any thrown error to `[status, message]` for the browser. */
export function toHttpError(err) {
  if (err instanceof GoogleApiError) return [err.status, err.message];
  console.error('Unexpected data-source error:', err?.message);
  return [500, 'Server configuration error.'];
}
