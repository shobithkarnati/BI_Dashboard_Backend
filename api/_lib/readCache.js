/**
 * A tiny in-memory cache for whole-table reads (BigQuery rows, Google Sheets values), per server
 * instance. Dashboards load every table on page open and again on refresh, so for a short time
 * (45 s by default) every request for the same source shares one Google read:
 *   - identical reads that arrive while one is running wait for it (one fetch, one promise);
 *   - a finished read is reused until it is `ttlMs` old;
 *   - a failed read is never kept, so the next request tries again.
 * Cached values are shared between requests: callers must treat them as read-only.
 */

export const READ_CACHE_TTL_MS = 45_000;

export function createReadCache({ ttlMs = READ_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { promise, expiresAt }

  return {
    /** The cached value for `key`, or the result of `load()` (shared by concurrent callers). */
    get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return hit.promise;
      const entry = { promise: null, expiresAt: Infinity }; // pending reads never expire
      entry.promise = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            entry.expiresAt = now() + ttlMs;
            return value;
          },
          (err) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw err;
          }
        );
      entries.set(key, entry);
      return entry.promise;
    },
    /** Forgets one key, or everything when no key is given. */
    clear(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
