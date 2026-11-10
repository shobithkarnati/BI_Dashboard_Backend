/**
 * Catalog sub-module (categories, packages, services): what it reads (the catalog tables with saved
 * changes on top) and what it may change, through the shared change engine. v4's builders do the work
 * (create / edit / order / move / move_service / remove); this file decides which of them, on
 * which items, and with which fields, are allowed here.
 */

import { HttpError, NO_ENTITY } from '../engine/changes.js';

export const id = 'catalog';

/**
 * { change type: entities } allowed here. Pictures (category and package) are not part of Product
 * Management: they are neither shown nor changed here.
 */
export const allowedChanges = {
  create: ['category', 'package', 'service', 'package_service'],
  edit: ['category', 'package', 'service'],
  order: ['category', 'package', 'package_service'],
  move: ['package', 'service'],
  move_service: [NO_ENTITY],
  remove: ['package_service'],
};

/** The only fields an edit may change. Package price type, its fixed prices and so on belong to Pricing. */
const EDITABLE_FIELDS = {
  category: ['category_name'],
  package: ['package_name', 'short_description', 'description', 'timeline'],
  service: ['service_name'],
};

/** Checked before any plan is built (only for this module's own requests). */
export function checkChange(body) {
  if (!body || typeof body !== 'object') return;
  if (body.type === 'edit' && Object.hasOwn(EDITABLE_FIELDS, body.entity)) {
    const changes = body.changes && typeof body.changes === 'object' ? body.changes : {};
    for (const field of Object.keys(changes)) {
      if (!EDITABLE_FIELDS[body.entity].includes(field)) throw new HttpError(400, `"${field}" cannot be changed here.`);
    }
  }
  // Service codes (SC123) are made for you, never typed, so they stay unique.
  if (body.type === 'create' && body.entity === 'service') {
    const values = body.values && typeof body.values === 'object' ? body.values : {};
    if (String(values.service_identifier ?? values.identifier ?? '').trim()) throw new HttpError(400, 'The code is made for you.');
  }
}

const LIMIT = 20000;

/** The module's reads. `tables` comes from the change engine: { q, src, ctl, live }. */
export function createQueries({ q, ctl, live }) {
  /**
   * Everything the three Catalog pages need, in one go (a few hundred rows in all):
   * { categories, packages, services, links }.
   */
  async function catalog() {
    const [categories, packages, services, links, added] = await Promise.all([
      q(`SELECT CAST(c.category_id AS INT64) AS id, c.category_name AS name, UPPER(CAST(c.vehicle_type AS STRING)) AS vehicle_type,
                CAST(c.cat_identifier AS STRING) AS identifier, SAFE_CAST(c.category_priority AS INT64) AS priority,
                COALESCE(p.n, 0) AS n_packages, COALESCE(s.n, 0) AS n_services
         FROM ${live('category')} c
         LEFT JOIN (SELECT CAST(category_id AS INT64) AS cid, COUNT(*) AS n FROM ${live('package')} GROUP BY 1) p ON p.cid = CAST(c.category_id AS INT64)
         LEFT JOIN (SELECT CAST(category_id AS INT64) AS cid, COUNT(*) AS n FROM ${live('service')} GROUP BY 1) s ON s.cid = CAST(c.category_id AS INT64)
         ORDER BY vehicle_type, priority IS NULL, priority, name LIMIT ${LIMIT}`),
      q(`SELECT CAST(p.package_details_id AS INT64) AS id, p.package_name AS name, CAST(p.category_id AS INT64) AS category_id,
                c.category_name AS category, UPPER(CAST(c.vehicle_type AS STRING)) AS vehicle_type, SAFE_CAST(p.package_priority AS INT64) AS priority,
                CAST(p.price_type AS STRING) AS price_type, CAST(p.package_type AS STRING) AS package_type,
                CAST(p.short_description AS STRING) AS short_description, CAST(p.description AS STRING) AS description, CAST(p.timeline AS STRING) AS timeline,
                COALESCE(s.n, 0) AS n_services
         FROM ${live('package')} p
         LEFT JOIN ${live('category')} c ON CAST(c.category_id AS INT64) = CAST(p.category_id AS INT64)
         LEFT JOIN (SELECT CAST(package_details_id AS INT64) AS pid, COUNT(*) AS n FROM ${live('package_service')} GROUP BY 1) s ON s.pid = CAST(p.package_details_id AS INT64)
         ORDER BY vehicle_type, category, priority IS NULL, priority, name LIMIT ${LIMIT}`),
      q(`SELECT CAST(s.service_id AS INT64) AS id, s.service_name AS name, CAST(s.service_identifier AS STRING) AS identifier,
                CAST(s.category_id AS INT64) AS category_id, c.category_name AS category, UPPER(CAST(c.vehicle_type AS STRING)) AS vehicle_type,
                COALESCE(k.n, 0) AS n_packages
         FROM ${live('service')} s
         LEFT JOIN ${live('category')} c ON CAST(c.category_id AS INT64) = CAST(s.category_id AS INT64)
         LEFT JOIN (SELECT CAST(service_id AS INT64) AS sid, COUNT(*) AS n FROM ${live('package_service')} GROUP BY 1) k ON k.sid = CAST(s.service_id AS INT64)
         ORDER BY vehicle_type, category, name LIMIT ${LIMIT}`),
      q(`SELECT CAST(package_service_id AS INT64) AS id, CAST(package_details_id AS INT64) AS package_id, CAST(service_id AS INT64) AS service_id,
                SAFE_CAST(package_service_priority AS INT64) AS priority
         FROM ${live('package_service')} ORDER BY package_id, priority IS NULL, priority, id LIMIT ${LIMIT}`),
      // Items added in Product Management (not yet in the app database). New ids continue from the last id, so the id cannot tell.
      q(`SELECT entity_type AS type, SAFE_CAST(entity_id AS INT64) AS id FROM ${ctl('change_log')}
         WHERE op = 'ADD' AND status = 'ACTIVE' AND entity_type IN ('category', 'package', 'service') AND SAFE_CAST(entity_id AS INT64) IS NOT NULL`),
    ]);
    const withFlag = (rows, type) => {
      const ids = new Set(added.filter((r) => r.type === type).map((r) => Number(r.id)));
      return rows.map((r) => ({ ...r, added_here: ids.has(Number(r.id)) }));
    };
    return {
      categories: withFlag(categories, 'category'),
      packages: withFlag(packages, 'package'),
      services: withFlag(services, 'service'),
      links,
    };
  }

  return { catalog };
}
