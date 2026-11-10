/**
 * Vehicles sub-module: what it reads (vehicle_master + vehicle_variant with saved changes on top) and
 * what it may change (add, edit, remove vehicles and variants, through the shared change engine).
 */

import { HttpError } from '../engine/changes.js';

export const id = 'vehicles';

/** { change type: entities } this module allows (v4 builders: create / edit / remove). */
export const allowedChanges = {
  create: ['vehicle_master', 'vehicle_variant'],
  edit: ['vehicle_master', 'vehicle_variant'],
  remove: ['vehicle_master', 'vehicle_variant'],
};

/**
 * Checked before any plan is built. A variant's name is typed by the person: it is never made up from the
 * fuel and transmission, so every new variant (with a new vehicle, or added to one) must come with a name.
 */
export function checkChange(body) {
  if (body?.type !== 'create') return;
  let variants = [];
  if (body.entity === 'vehicle_variant') variants = Array.isArray(body.variants) && body.variants.length ? body.variants : [body.values];
  else if (body.entity === 'vehicle_master' && Array.isArray(body.variants)) variants = body.variants;
  for (const v of variants) {
    if (typeof v?.name !== 'string' || !v.name.trim()) throw new HttpError(400, 'Enter a name for every variant.');
  }
}

/** The module's reads. `tables` comes from the change engine: { q, src, ctl, live }. */
export function createQueries({ q, src, ctl, live }) {
  /** Every vehicle with its variant and customer counts, every variant, and the pick lists (v4 lists + lookups). */
  async function vehicles() {
    const [rows, variants, fuels, trans, bodies, makes] = await Promise.all([
      q(`SELECT CAST(m.vehicle_master_id AS INT64) AS id, m.make AS make, m.model AS model, CAST(m.body_type AS STRING) AS body_type,
                CAST(m.vehicle_type AS STRING) AS vehicle_type, COALESCE(v.n, 0) AS n_variants, COALESCE(c.n, 0) AS n_customers,
                -- added in Product Management (not yet in the app database): new ids continue from the last id, so the id alone cannot tell
                COALESCE(CAST(m.vehicle_master_id AS INT64) IN (SELECT SAFE_CAST(entity_id AS INT64) FROM ${ctl('change_log')}
                         WHERE entity_type = 'vehicle_master' AND op = 'ADD' AND status = 'ACTIVE' AND SAFE_CAST(entity_id AS INT64) IS NOT NULL), FALSE) AS added_here
         FROM ${live('vehicle_master')} m
         LEFT JOIN (SELECT CAST(vehicle_master_id AS INT64) AS mid, COUNT(*) AS n FROM ${live('vehicle_variant')} GROUP BY 1) v ON v.mid = CAST(m.vehicle_master_id AS INT64)
         LEFT JOIN (SELECT CAST(vehicle_master_id AS INT64) AS mid, COUNT(*) AS n FROM ${src('vehicles')} GROUP BY 1) c ON c.mid = CAST(m.vehicle_master_id AS INT64)
         ORDER BY make, model LIMIT 20000`),
      q(`SELECT CAST(vehicle_variant_id AS INT64) AS id, CAST(vehicle_master_id AS INT64) AS vehicle_master_id, name AS name,
                CAST(fuel_type AS STRING) AS fuel_type, CAST(transmission_type AS STRING) AS transmission_type,
                SAFE_CAST(SUBSTR(CAST(from_year AS STRING), 1, 4) AS INT64) AS from_year, SAFE_CAST(SUBSTR(CAST(to_year AS STRING), 1, 4) AS INT64) AS to_year
         FROM ${live('vehicle_variant')}
         ORDER BY vehicle_master_id, from_year, fuel_type, name LIMIT 50000`),
      q(`SELECT DISTINCT UPPER(CAST(fuel_type AS STRING)) AS v FROM ${live('vehicle_variant')} WHERE fuel_type IS NOT NULL ORDER BY v`),
      q(`SELECT DISTINCT UPPER(CAST(transmission_type AS STRING)) AS v FROM ${live('vehicle_variant')} WHERE transmission_type IS NOT NULL ORDER BY v`),
      q(`SELECT UPPER(CAST(vehicle_type AS STRING)) AS vt, CAST(body_type AS STRING) AS v, COUNT(*) AS n FROM ${live('vehicle_master')} WHERE body_type IS NOT NULL GROUP BY 1, 2 ORDER BY vt, n DESC`),
      q(`SELECT DISTINCT make AS v FROM ${live('vehicle_master')} WHERE make IS NOT NULL ORDER BY v`),
    ]);
    return {
      vehicles: rows,
      variants,
      lookups: {
        fuels: fuels.map((r) => r.v), transmissions: trans.map((r) => r.v), makes: makes.map((r) => r.v),
        bodyTypes: bodies.map((r) => ({ vehicleType: r.vt, code: r.v, n: r.n })),
      },
    };
  }

  return { vehicles };
}
