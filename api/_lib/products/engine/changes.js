/**
 * The change engine every Product Management sub-module shares, taken from the v4 pricing-control
 * function (app.js): the same plan previews, the same change_log rows, history and undo, so v4 and
 * this app read and write one shared history. Reads go to `zmater` (never written); the only writes
 * are to `pricing_control.change_log`.
 *
 * What may be changed is decided by the sub-modules (../modules): each lists the change types and
 * entities it allows, and anything else is refused.
 */

import { randomUUID } from 'node:crypto';
import { REGISTRY } from './registry.js';
import { makePlans } from './plans.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function positiveInt(v, what) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${what} is not valid`);
  return n;
}

/** Stands for "the request has no entity" in a module's allowed list (v4's move_service names its rows itself). */
export const NO_ENTITY = '(no entity)';

/** Refuses a change request unless a sub-module allows its { type, entity }. */
export function assertAllowed(body, allowed) {
  const type = body?.type;
  const entities = typeof type === 'string' && Object.hasOwn(allowed, type) ? allowed[type] : null;
  const entity = typeof body?.entity === 'string' ? body.entity : NO_ENTITY;
  if (!Array.isArray(entities) || !entities.includes(entity)) throw new HttpError(400, 'That change cannot be made here yet.');
}

/** Entities any sub-module may change (Undo is limited to these). */
const allowedEntities = (allowed) => new Set(Object.values(allowed).flat());

/** reverted_by on a batch withdrawn because another batch added the same new id at the same moment. */
export const DUPLICATE_ID_REVERTER = 'system: duplicate id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_WORD = /^[A-Za-z_]+$/;
const quoteWord = (w) => { if (!SAFE_WORD.test(w)) throw new Error('bad word'); return `'${w}'`; };

/**
 * `q` / `dml`: BigQuery calls (./bq.js). `allowed`: { type: [entities] } from the sub-modules.
 * `undoable`: extra entities a batch may contain for Undo (the rows a price change writes) that no request may name.
 * Returns the shared engine plus the table helpers sub-modules use for their own reads.
 */
export function createChangeEngine({ q, dml, project, srcDataset = 'zmater', ctlDataset = 'pricing_control', allowed = {}, checks = [], undoable = [] }) {
  const src = (t) => `\`${project}.${srcDataset}.${t}\``;
  const ctl = (t) => `\`${project}.${ctlDataset}.${t}\``;
  const live = (e) => ctl(`${REGISTRY[e].table}_live`);
  const { buildPlan } = makePlans({ q, ctl, src, HttpError, positiveInt });

  // v4 app.js: what the Review dialog shows
  const preview = (plan) => ({
    label: plan.label,
    count: plan.rows.length,
    warnings: plan.warnings,
    startAt: plan.start ? plan.start.toISOString() : null,
    endAt: plan.end ? plan.end.toISOString() : null,
    items: plan.items.slice(0, 60),
    truncated: Math.max(0, plan.items.length - 60),
  });

  // v4 app.js: one batch of change_log rows
  async function insertPlan(plan, who) {
    const batchId = randomUUID();
    const params = {
      batch_id: batchId, label: plan.label, reason: plan.reason, who,
      start_at: plan.start ? plan.start.toISOString() : '',
      end_at: plan.end ? plan.end.toISOString() : '',
    };
    const tuples = plan.rows.map((r, i) => {
      if (!/^\d+$/.test(r.entityId)) throw new Error('bad id');
      // Only real fields of a known entity (or "row" for add / remove) are written, never inherited names like "constructor".
      const cfg = Object.hasOwn(REGISTRY, r.entityType) ? REGISTRY[r.entityType] : null;
      if (!cfg || (r.field !== 'row' && !Object.hasOwn(cfg.fields, r.field))) throw new HttpError(400, 'That change cannot be made here.');
      params[`o${i}`] = r.oldValue == null ? '' : String(r.oldValue);
      params[`n${i}`] = String(r.newValue);
      return `(GENERATE_UUID(), @batch_id, ${quoteWord(r.entityType)}, '${r.entityId}', ${quoteWord(r.field)}, NULLIF(@o${i}, ''), @n${i}, ` +
        `COALESCE(SAFE_CAST(NULLIF(@start_at, '') AS TIMESTAMP), CURRENT_TIMESTAMP()), SAFE_CAST(NULLIF(@end_at, '') AS TIMESTAMP), ` +
        `'ACTIVE', @label, NULLIF(@reason, ''), @who, CURRENT_TIMESTAMP(), CAST(NULL AS STRING), CAST(NULL AS TIMESTAMP), ${quoteWord(r.op)})`;
    });
    await dml(`INSERT INTO ${ctl('change_log')}
      (change_id, batch_id, entity_type, entity_id, field, old_value, new_value, start_at, end_at,
       status, label, reason, changed_by, changed_at, reverted_by, reverted_at, op)
      VALUES ${tuples.join(',\n')}`, params);
    return batchId;
  }

  /** Marks every ACTIVE row of a batch REVERTED. Returns the number of rows changed. */
  const revertBatch = (batchId, who) => dml(
    `UPDATE ${ctl('change_log')}
     SET status = 'REVERTED', reverted_by = @who, reverted_at = CURRENT_TIMESTAMP()
     WHERE batch_id = @b AND status = 'ACTIVE'`, { who, b: batchId });

  /**
   * New ids come from MAX(id) + 1 (plans.js), so two people adding at the same moment can get the same
   * id. After saving, look for another ACTIVE batch that ADDs the same (entity_type, entity_id); if there
   * is one, this batch is withdrawn (REVERTED) and the user is asked to apply again with fresh ids.
   */
  async function hasDuplicateNewIds(plan, batchId) {
    const keys = [...new Set(plan.rows.filter((r) => r.op === 'ADD').map((r) => `${r.entityType}:${r.entityId}`))];
    if (!keys.length) return false;
    const clash = await q(`SELECT entity_type, entity_id FROM ${ctl('change_log')}
                           WHERE status = 'ACTIVE' AND op = 'ADD' AND batch_id != @b
                             AND CONCAT(entity_type, ':', entity_id) IN UNNEST(@keys)
                           LIMIT 1`, { b: batchId, keys }, { keys: ['STRING'] });
    return clash.length > 0;
  }

  // v4 app.js historyQuery
  const history = (limit) => q(`SELECT batch_id,
                     ANY_VALUE(label) AS label, ANY_VALUE(changed_by) AS who, MAX(changed_at) AS last_changed,
                     ANY_VALUE(start_at) AS starts_at, ANY_VALUE(end_at) AS ends_at, ANY_VALUE(reason) AS why,
                     COUNT(*) AS n_rows,
                     CASE WHEN LOGICAL_AND(status = 'REVERTED') THEN 'REVERTED'
                          WHEN ANY_VALUE(start_at) > CURRENT_TIMESTAMP() THEN 'SCHEDULED'
                          WHEN ANY_VALUE(end_at) IS NOT NULL AND ANY_VALUE(end_at) <= CURRENT_TIMESTAMP() THEN 'ENDED'
                          ELSE 'LIVE' END AS state,
                     ANY_VALUE(reverted_by) AS undone_by, MAX(reverted_at) AS undone_at
              FROM ${ctl('change_log')}
              GROUP BY batch_id
              ORDER BY last_changed DESC
              LIMIT @limit`, { limit });

  // v4 app.js /api/batch
  async function batch(id) {
    if (!UUID_RE.test(String(id || ''))) throw new HttpError(400, 'Change id is not valid');
    const rows = await q(`SELECT entity_type, entity_id, field, COALESCE(op, 'SET') AS action, old_value, new_value
                          FROM ${ctl('change_log')} WHERE batch_id = @id ORDER BY entity_type, entity_id LIMIT 300`, { id });
    return rows.map((r) => ({ ...r, new_value: r.new_value && r.new_value.length > 600 ? `${r.new_value.slice(0, 600)}…` : r.new_value }));
  }

  // v4 app.js /api/change: dryRun -> preview; warnings must be confirmed (force) before saving
  async function change(body, who) {
    const b = body && typeof body === 'object' ? body : {};
    assertAllowed(b, allowed);
    checks.forEach((check) => check(b)); // each sub-module's own rules, before anything is planned
    const plan = await buildPlan(b);
    if (b.dryRun) return { status: 200, body: { ok: true, preview: preview(plan) } };
    if (plan.warnings.length && !b.force) return { status: 409, body: { error: 'Please confirm the warnings first', preview: preview(plan) } };
    const batchId = await insertPlan(plan, who);
    if (await hasDuplicateNewIds(plan, batchId)) {
      await revertBatch(batchId, DUPLICATE_ID_REVERTER);
      console.log(JSON.stringify({ audit: true, who, batchId, label: plan.label, reverted: 'duplicate id' }));
      return { status: 409, body: { error: 'Someone else added an item at the same moment. Please review and apply again.' } };
    }
    console.log(JSON.stringify({ audit: true, who, batchId, label: plan.label, rows: plan.rows.length }));
    return { status: 200, body: { ok: true, batchId, count: plan.rows.length, label: plan.label, created: plan.created || [] } };
  }

  // v4 app.js /api/undo
  async function undo(batchId, who) {
    if (!UUID_RE.test(String(batchId || ''))) throw new HttpError(400, 'Change id is not valid');
    const have = await q(`SELECT entity_type AS t, COUNT(*) AS n FROM ${ctl('change_log')} WHERE batch_id = @b AND status = 'ACTIVE' GROUP BY 1`, { b: batchId });
    if (!have.length) throw new HttpError(404, 'Nothing to undo. It may already be undone.');
    // Only changes this app can make may be undone here (not, say, a price change made in the v4 app).
    const permitted = new Set([...allowedEntities(allowed), ...undoable]);
    if (have.some((r) => !permitted.has(r.t))) throw new HttpError(403, 'This change was made in another tool and cannot be undone here.');
    const n = await revertBatch(batchId, who);
    console.log(JSON.stringify({ audit: true, who, undo: batchId, rows: n }));
    return { ok: true, undone: n || have.reduce((sum, r) => sum + Number(r.n), 0) };
  }

  return { change, history, batch, undo, tables: { q, src, ctl, live } };
}
