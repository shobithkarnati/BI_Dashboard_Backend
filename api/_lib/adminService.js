/**
 * The admin page's rules, with the Firebase Auth and Firestore calls injected so every rule can be
 * tested without a network. Nothing here trusts the browser: ids, passwords and dashboard lists are
 * validated again, an admin cannot lock themselves or the last active admin out, and every change is
 * written to the audit log (never with a password in it).
 * After a disable, delete, password reset or sign-out, the guard's cached account status and the
 * cached grant for that user are dropped, so this server stops accepting the old session at once.
 */

import { DASHBOARDS, AUTH_EMAIL_DOMAIN, normalizeIdentity, getDashboards } from './authorize.js';
import { mergeGrants } from './access.js';
import { forgetAccount as forgetCachedAccount } from './guard.js';

// Deliberately simple: one @, no spaces, a dot in the domain. Firebase does its own stricter check.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** An error whose message is safe to show the admin. */
export class AdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new AdminError('Enter a valid email address.');
  return email;
}

export function parsePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new AdminError(`Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

/** A list of known dashboard ids, de-duplicated and in canonical order. "*" is not accepted from the page. */
export function parseDashboards(value) {
  if (!Array.isArray(value) || value.some((d) => typeof d !== 'string' || !DASHBOARDS.includes(d))) {
    throw new AdminError('Dashboards must be a list of valid dashboard ids.');
  }
  return DASHBOARDS.filter((d) => value.includes(d));
}

/** How an account is shown: the User ID for `@bluewheel.app` accounts, otherwise the full email. */
const displayId = (email) => (email.endsWith(`@${AUTH_EMAIL_DOMAIN}`) ? email.slice(0, -(AUTH_EMAIL_DOMAIN.length + 1)) : email);

export function createAdminService({ identity, access, env = process.env, forgetAccount = forgetCachedAccount }) {
  /** Clears what the guard remembers about this user (account status, dashboard grant). */
  const forget = (target) => {
    forgetAccount(target.uid);
    if (typeof access.forgetGrant === 'function') access.forgetGrant(target.email);
  };
  const effective = (email, grants) => mergeGrants(email, grants.get(normalizeIdentity(email)) ?? null, env);

  async function snapshot() {
    const [users, grants] = await Promise.all([identity.listUsers(), access.listGrants()]);
    return { users, grants };
  }

  /** Whether any active account other than `uid` would still be an admin. */
  async function hasOtherActiveAdmin(uid) {
    const { users, grants } = await snapshot();
    return users.some((u) => u.uid !== uid && !u.disabled && effective(u.email, grants).includes('admin'));
  }

  const log = (actor, action, target, detail) => access.writeAudit({ actor: actor.email, action, target, detail });

  async function load(uid) {
    if (typeof uid !== 'string' || !uid) throw new AdminError('Missing user.');
    return identity.getUser(uid);
  }

  return {
    async listUsers() {
      const { users, grants } = await snapshot();
      return users
        .map((u) => {
          const stored = grants.get(normalizeIdentity(u.email));
          const dashboards = effective(u.email, grants);
          return {
            ...u,
            userId: displayId(u.email),
            dashboards,
            isAdmin: dashboards.includes('admin'),
            // Admin granted by DASHBOARD_ACCESS cannot be removed from the page (break-glass).
            adminFromConfig: getDashboards(u.email, env.DASHBOARD_ACCESS).includes('admin'),
            source: stored ? 'database' : dashboards.length ? 'server-config' : 'none',
          };
        })
        .sort((a, b) => a.userId.localeCompare(b.userId));
    },

    async createUser(actor, { email: rawEmail, password, dashboards }) {
      const email = parseEmail(rawEmail);
      const secret = parsePassword(password);
      const grants = parseDashboards(dashboards ?? []);
      const user = await identity.createUser({ email, password: secret });
      try {
        await access.writeGrant(email, grants, actor.email);
      } catch (err) {
        await identity.deleteUser(user.uid).catch(() => {}); // do not leave an account with no recorded access
        throw err;
      }
      await log(actor, 'user.create', email, `dashboards: ${grants.join(', ') || 'none'}`);
      const merged = mergeGrants(email, grants, env);
      return { ...user, userId: displayId(email), dashboards: merged, isAdmin: merged.includes('admin'), adminFromConfig: getDashboards(email, env.DASHBOARD_ACCESS).includes('admin'), source: 'database' };
    },

    async setAccess(actor, uid, dashboards) {
      const grants = parseDashboards(dashboards);
      const target = await load(uid);
      if (!grants.includes('admin')) {
        const { grants: all } = await snapshot();
        const wasAdmin = effective(target.email, all).includes('admin');
        const staysAdmin = mergeGrants(target.email, grants, env).includes('admin'); // true when admin comes from server config
        if (wasAdmin && !staysAdmin) {
          if (target.uid === actor.uid) throw new AdminError('You cannot remove your own admin access.');
          if (!target.disabled && !(await hasOtherActiveAdmin(target.uid))) throw new AdminError('This is the last active admin. Make someone else an admin first.');
        }
      }
      await access.writeGrant(target.email, grants, actor.email);
      await log(actor, 'access.update', target.email, `dashboards: ${grants.join(', ') || 'none'}`);
      return { uid: target.uid, dashboards: mergeGrants(target.email, grants, env) };
    },

    async setDisabled(actor, uid, disabled) {
      if (typeof disabled !== 'boolean') throw new AdminError('"disabled" must be true or false.');
      const target = await load(uid);
      if (disabled) {
        if (target.uid === actor.uid) throw new AdminError('You cannot disable your own account.');
        const { grants } = await snapshot();
        if (effective(target.email, grants).includes('admin') && !(await hasOtherActiveAdmin(target.uid))) {
          throw new AdminError('This is the last active admin. Make someone else an admin first.');
        }
      }
      await identity.setDisabled(target.uid, disabled);
      forget(target);
      await log(actor, disabled ? 'user.disable' : 'user.enable', target.email);
      return { uid: target.uid, disabled };
    },

    async setPassword(actor, uid, password) {
      const secret = parsePassword(password);
      const target = await load(uid);
      await identity.setPassword(target.uid, secret);
      await identity.revokeSessions(target.uid); // the old password's sessions end with it
      forget(target);
      await log(actor, 'user.password-reset', target.email);
      return { uid: target.uid };
    },

    async revokeSessions(actor, uid) {
      const target = await load(uid);
      await identity.revokeSessions(target.uid);
      forget(target);
      await log(actor, 'user.revoke-sessions', target.email);
      return { uid: target.uid };
    },

    async deleteUser(actor, uid) {
      const target = await load(uid);
      if (target.uid === actor.uid) throw new AdminError('You cannot delete your own account.');
      const { grants } = await snapshot();
      if (!target.disabled && effective(target.email, grants).includes('admin') && !(await hasOtherActiveAdmin(target.uid))) {
        throw new AdminError('This is the last active admin. Make someone else an admin first.');
      }
      await identity.deleteUser(target.uid);
      forget(target); // also covers a failed removeGrant below
      await access.removeGrant(target.email).catch((err) => console.error('Could not remove access record:', err.message));
      await log(actor, 'user.delete', target.email);
      return { uid: target.uid };
    },

    async listAudit() {
      return access.listAudit(100);
    },
  };
}
