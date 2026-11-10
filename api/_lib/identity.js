/**
 * Firebase Auth user management over the Identity Toolkit REST API, as the service account.
 * Same transport as the account-active check in guard.js (no firebase-admin: it broke when bundled).
 * Only the fields the admin page needs are ever returned: never password hashes or salts.
 */

import { googleFetch, GoogleApiError, SCOPES } from './google.js';

const base = (env = process.env) => `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}`;

/** Identity Toolkit error code ("EMAIL_EXISTS", "WEAK_PASSWORD : ..."), or '' when there is none. */
const errorCode = (data) => String(data?.error?.message || '').split(/[\s:]/)[0];

const toUser = (u) => ({
  uid: u.localId,
  email: (u.email || '').toLowerCase(),
  disabled: Boolean(u.disabled),
  createdAt: u.createdAt ? Number(u.createdAt) : null,
  lastSignInAt: u.lastLoginAt ? Number(u.lastLoginAt) : null,
});

function fail(status, data, what) {
  const code = errorCode(data);
  console.error(`Identity Toolkit error (${what}):`, code || `HTTP ${status}`);
  if (code === 'EMAIL_EXISTS') throw new GoogleApiError('A user with that email already exists.', 409);
  if (code === 'INVALID_EMAIL') throw new GoogleApiError('Enter a valid email address.', 400);
  if (code === 'WEAK_PASSWORD') throw new GoogleApiError('That password is too weak.', 400);
  if (code === 'USER_NOT_FOUND' || code === 'INVALID_LOCAL_ID') throw new GoogleApiError('That user no longer exists.', 404);
  throw new GoogleApiError('Could not complete the user change.', 502);
}

async function call(path, what, { method = 'POST', body } = {}) {
  const { status, data } = await googleFetch(`${base()}${path}`, SCOPES.identity, { method, body });
  if (status < 200 || status >= 300) fail(status, data, what);
  return data;
}

export async function listUsers() {
  const users = [];
  let pageToken = '';
  do {
    const qs = `maxResults=1000${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await call(`/accounts:batchGet?${qs}`, 'list users', { method: 'GET' });
    for (const u of data.users || []) users.push(toUser(u));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return users;
}

export async function getUser(uid) {
  const data = await call('/accounts:lookup', 'get user', { body: { localId: [uid] } });
  if (!data.users?.[0]) throw new GoogleApiError('That user no longer exists.', 404);
  return toUser(data.users[0]);
}

export async function createUser({ email, password }) {
  const data = await call('/accounts', 'create user', { body: { email, password, emailVerified: false, disabled: false } });
  return getUser(data.localId);
}

const update = (uid, fields, what) => call('/accounts:update', what, { body: { localId: uid, ...fields } });
export const setDisabled = (uid, disabled) => update(uid, { disableUser: Boolean(disabled) }, 'disable user');
export const setPassword = (uid, password) => update(uid, { password }, 'set password');
/** Invalidates every refresh token issued before now: the user is signed out on all devices. */
export const revokeSessions = (uid) => update(uid, { validSince: String(Math.floor(Date.now() / 1000)) }, 'revoke sessions');
export const deleteUser = (uid) => call('/accounts:delete', 'delete user', { body: { localId: uid } });
