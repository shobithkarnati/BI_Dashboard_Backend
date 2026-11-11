/**
 * Pricing sub-module: what it reads (package prices, vehicle prices, price settings, the GST and fees real
 * bookings used) and what it may change, through the shared change engine. v4's builders do the work
 * (price / discount / convert / service_prices / vehicle_price / settings); this file decides which of them
 * may be requested here. Reads are ported from the v4 pricing-control app.
 *
 * Every pricing request has no `entity`: v4 names the rows it writes itself.
 */

import { HttpError, NO_ENTITY, positiveInt } from '../engine/changes.js';
import { makePlans, isOn, SETTING_DEFAULTS } from '../engine/plans.js';

export const id = 'pricing';

export const allowedChanges = {
  price: [NO_ENTITY], // new prices for price rows
  discount: [NO_ENTITY], // a percent on a package, a category or one price row
  convert: [NO_ENTITY], // a quotation (MBF) package becomes a fixed-price (BWBP) one
  service_prices: [NO_ENTITY], // parts and labour price of each service inside a price row
  vehicle_price: [NO_ENTITY], // a separate price for one vehicle + fuel
  settings: [NO_ENTITY], // GST and fees
};

/**
 * What a pricing batch writes. No request may name these (Undo must accept them, nothing else does):
 * price rows, price groups, options, service prices, price settings (and the package's price type, which
 * the Catalog already allows).
 */
export const undoableEntities = ['ppgm', 'price_group', 'product_detail', 'service_price', 'price_setting'];

const text = (v, max) => String(v ?? '').trim().slice(0, max);

/** The module's reads. `tables` comes from the change engine: { q, src, ctl, live }. */
export function createQueries({ q, src, ctl, live }) {
  const { PPGM_SQL, vehiclePriceRows, vehiclesUsing } = makePlans({ q, ctl, src, HttpError, positiveInt });

  /** The lists the pages start from. */
  async function overview() {
    const [packages, categories, settings, bodies, fuels, disc] = await Promise.all([
      q(`SELECT CAST(p.package_details_id AS INT64) AS id, p.package_name AS name, CAST(p.category_id AS INT64) AS category_id,
                c.category_name AS category, UPPER(CAST(c.vehicle_type AS STRING)) AS vehicle_type,
                UPPER(CAST(p.price_type AS STRING)) AS price_type, COALESCE(k.n, 0) AS n_prices
         FROM ${live('package')} p
         LEFT JOIN ${live('category')} c ON CAST(c.category_id AS INT64) = CAST(p.category_id AS INT64)
         LEFT JOIN (SELECT CAST(pg.package_details_id AS INT64) AS pid, COUNT(*) AS n
                    FROM ${live('ppgm')} l JOIN ${live('price_group')} pg ON CAST(pg.price_group_id AS INT64) = CAST(l.price_group_id AS INT64)
                    WHERE ${isOn('l.is_active')} GROUP BY 1) k ON k.pid = CAST(p.package_details_id AS INT64)
         ORDER BY vehicle_type, category, name LIMIT 2000`),
      q(`SELECT CAST(category_id AS INT64) AS id, category_name AS name, UPPER(CAST(vehicle_type AS STRING)) AS vehicle_type
         FROM ${live('category')} ORDER BY vehicle_type, name LIMIT 500`),
      q(`SELECT CAST(price_setting_id AS INT64) AS id, setting_key AS k, IFNULL(UPPER(CAST(vehicle_type AS STRING)), '') AS vt, setting_value AS v
         FROM ${live('price_setting')} ORDER BY id LIMIT 200`),
      q(`SELECT UPPER(CAST(vehicle_type AS STRING)) AS vt, CAST(body_type AS STRING) AS v, COUNT(*) AS n FROM ${live('vehicle_master')}
         WHERE body_type IS NOT NULL GROUP BY 1, 2 ORDER BY vt, n DESC`),
      q(`SELECT DISTINCT UPPER(CAST(fuel_type AS STRING)) AS v FROM ${live('vehicle_variant')} WHERE fuel_type IS NOT NULL ORDER BY v`),
      q(`SELECT SAFE_CAST(discount_total AS FLOAT64) AS d, COUNT(*) AS n FROM ${live('ppgm')} GROUP BY 1 ORDER BY n DESC LIMIT 1`),
    ]);
    return {
      packages,
      categories,
      settings,
      defaults: SETTING_DEFAULTS,
      lookups: {
        bodyTypes: bodies.map((r) => ({ vehicleType: r.vt, code: r.v, n: r.n })),
        fuels: fuels.map((r) => r.v),
        defaultDiscountPercent: disc.length && disc[0].d != null ? Math.round(disc[0].d * 10000) / 100 : 0,
      },
    };
  }

  /** One package with its prices (one row per price group and option). */
  async function pkg(rawId) {
    const id = positiveInt(rawId, 'Package');
    const head = await q(
      `SELECT CAST(pd.package_details_id AS INT64) AS id, pd.package_name AS name, c.category_name AS category,
              CAST(pd.category_id AS INT64) AS category_id, UPPER(CAST(c.vehicle_type AS STRING)) AS vehicle_type,
              UPPER(CAST(pd.price_type AS STRING)) AS price_type, SAFE_CAST(pd.package_priority AS INT64) AS priority
       FROM ${live('package')} pd
       LEFT JOIN ${live('category')} c ON CAST(c.category_id AS INT64) = CAST(pd.category_id AS INT64)
       WHERE CAST(pd.package_details_id AS INT64) = @id`, { id });
    if (!head.length) throw new HttpError(404, 'Package not found');
    const rows = await q(PPGM_SQL('CAST(pg.package_details_id AS INT64) = @id'), { id });
    const options = await q(`SELECT CAST(product_details_id AS INT64) AS id, product_name AS name FROM ${live('product_detail')}
                             WHERE CAST(CAST(package_details_id AS INT64) AS STRING) = @pid ORDER BY id`, { pid: String(id) });
    const bodyCounts = await q(`SELECT UPPER(CAST(body_type AS STRING)) AS bt, COUNT(*) AS n FROM ${live('vehicle_master')}
                                WHERE UPPER(CAST(vehicle_type AS STRING)) = @vt GROUP BY 1`, { vt: String(head[0].vehicle_type || 'CAR').toUpperCase() });
    return { package: head[0], rows, options, bodyCounts: Object.fromEntries(bodyCounts.map((b) => [b.bt, b.n])) };
  }

  /** What each vehicle + fuel gets for one package. */
  async function vehiclePrices(query) {
    const id = positiveInt(query.id, 'Package');
    const rows = await vehiclePriceRows(id, { term: text(query.q, 80), bodyType: text(query.body, 30), fuelFilter: text(query.fuel, 30) });
    return { results: rows };
  }

  /** One price row with the price of each service inside it. */
  async function priceDetail(rawId) {
    const id = positiveInt(rawId, 'Price row');
    const r = (await q(PPGM_SQL('CAST(l.ppgm_id AS INT64) = @id'), { id }))[0];
    if (!r) throw new HttpError(404, 'Price row not found');
    const services = await q(`
      SELECT CAST(ps.service_id AS INT64) AS service_id, s.service_name AS service_name, SAFE_CAST(ps.package_service_priority AS INT64) AS package_service_priority,
             SAFE_CAST(x.parts_price AS FLOAT64) AS parts_price, SAFE_CAST(x.labour_price AS FLOAT64) AS labour_price
      FROM ${live('package_service')} ps
      LEFT JOIN ${live('service')} s ON CAST(s.service_id AS INT64) = CAST(ps.service_id AS INT64)
      LEFT JOIN (SELECT * EXCEPT(rn) FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY CAST(service_id AS INT64) ORDER BY CAST(service_price_id AS INT64) DESC) AS rn
                 FROM ${live('service_price')} WHERE CAST(ppgm_id AS INT64) = @id) WHERE rn = 1) x ON CAST(x.service_id AS INT64) = CAST(ps.service_id AS INT64)
      WHERE CAST(ps.package_details_id AS INT64) = @pid
      ORDER BY package_service_priority IS NULL, package_service_priority, service_name`, { id, pid: r.package_id });
    const vt = await q(`SELECT UPPER(CAST(c.vehicle_type AS STRING)) AS vt FROM ${live('package')} p JOIN ${live('category')} c
      ON CAST(c.category_id AS INT64) = CAST(p.category_id AS INT64) WHERE CAST(p.package_details_id AS INT64) = @pid`, { pid: r.package_id });
    return { row: r, services, vehicles_using: await vehiclesUsing(r), vehicle_type: vt[0] ? vt[0].vt : 'CAR' };
  }

  /**
   * The GST and fees real bookings used (last 90 days), to compare with the saved settings. Reads the
   * app's booking tables only.
   */
  async function bookingsCheck() {
    const I = (c) => `SAFE_CAST(SAFE_CAST(CAST(${c} AS STRING) AS FLOAT64) AS INT64)`;
    const N = (c) => `SAFE_CAST(CAST(${c} AS STRING) AS FLOAT64)`;
    const rows = await q(`
      WITH d AS (
        SELECT ${I('booking_cart_payment_details_id')} AS pdid, ${I('booking_cart_id')} AS booking_cart_id,
               ${N('grand_total')} AS grand_total, SAFE_CAST(CAST(initiated_at AS STRING) AS TIMESTAMP) AS paid_at
        FROM ${src('booking_cart_payment_details')} WHERE CAST(payment_status AS STRING) = 'PAYMENT_SUCCESS'),
      b AS (SELECT ${I('breakdown_id')} AS bid, ${I('booking_cart_payment_details_id')} AS pdid FROM ${src('booking_cart_payment_breakdown')}),
      i AS (SELECT ${I('breakdown_id')} AS bid, UPPER(CAST(fee_type AS STRING)) AS fee_type, ${N('total_amount')} AS total_amount,
                   ${N('actual_amount')} AS actual_amount, ${N('gst_total')} AS gst_total FROM ${src('booking_cart_internal_payment_details')}),
      cart AS (SELECT ${I('booking_cart_id')} AS booking_cart_id, ${I('vehicle_id')} AS vehicle_id FROM ${src('booking_cart')}),
      veh AS (SELECT ${I('vehicle_id')} AS vehicle_id, UPPER(CAST(vehicle_type AS STRING)) AS vt FROM ${src('vehicles')})
      SELECT d.booking_cart_id, d.grand_total, d.paid_at, IFNULL(veh.vt, 'CAR') AS vehicle_type,
             ARRAY_AGG(STRUCT(i.fee_type AS fee_type, i.total_amount AS total_amount, i.actual_amount AS actual_amount, i.gst_total AS gst_total)) AS lines
      FROM d JOIN b ON b.pdid = d.pdid JOIN i ON i.bid = b.bid
      LEFT JOIN cart ON cart.booking_cart_id = d.booking_cart_id LEFT JOIN veh ON veh.vehicle_id = cart.vehicle_id
      WHERE d.paid_at IS NULL OR d.paid_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
      GROUP BY 1, 2, 3, 4 ORDER BY d.paid_at DESC LIMIT 500`);
    return summariseBookings(rows);
  }

  /** The view named in `query.view`. */
  async function read(query = {}) {
    const view = text(query.view, 30) || 'overview';
    switch (view) {
      case 'overview': return overview();
      case 'package': return pkg(query.id);
      case 'vehicle-prices': return vehiclePrices(query);
      case 'price-detail': return priceDetail(query.ppgmId);
      case 'check': return bookingsCheck();
      default: throw new HttpError(400, 'Unknown view');
    }
  }

  return { read, overview, package: pkg, vehiclePrices, priceDetail, bookingsCheck };
}

const mode = (a) => {
  if (!a.length) return null;
  const counts = new Map();
  a.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
};

/**
 * What the paid bookings say about GST and fees (v4 appCheck): the usual GST percent, whether GST is added on
 * top of the price, and the usual pickup-and-drop and convenience fee per vehicle type.
 * `rows`: [{ grand_total, vehicle_type, lines: [{ fee_type, actual_amount, gst_total }] }].
 */
export function summariseBookings(rows) {
  const gst = [];
  const fees = {};
  let onTop = 0;
  let inside = 0;
  let carts = 0;
  for (const r of rows) {
    let actual = 0;
    let tax = 0;
    let hasPkg = false;
    for (const l of r.lines || []) {
      const a = Number(l.actual_amount) || 0;
      const g = Number(l.gst_total) || 0;
      actual += a;
      tax += g;
      if (l.fee_type === 'BWBP_PACKAGE_FEE') {
        hasPkg = true;
        if (a > 0 && g > 0) gst.push(Math.round((g / a) * 10000) / 100);
      } else if (a > 0 && ['PICKUP_DROP_FEE', 'CONVENIENCE_FEE'].includes(l.fee_type)) {
        const key = `${l.fee_type}|${r.vehicle_type}`;
        (fees[key] = fees[key] || []).push([Math.round(a * 100) / 100, g > 0]);
      }
    }
    if (!hasPkg) continue;
    carts++;
    const total = Number(r.grand_total) || 0;
    if (tax > 0 && Math.abs(total - (actual + tax)) <= 1.5) onTop++;
    else if (Math.abs(total - actual) <= 1.5) inside++;
  }
  return {
    carts,
    gst_percent: mode(gst),
    gst_added_on_top: onTop || inside ? (onTop >= inside ? 'YES' : 'NO') : null,
    evidence: { gst_added: onTop, gst_inside: inside },
    fees: Object.entries(fees).map(([key, list]) => {
      const [fee_type, vehicle_type] = key.split('|');
      return { fee_type, vehicle_type, amount: mode(list.map((x) => x[0])), with_gst: list.filter((x) => x[1]).length > list.length / 2, carts: list.length };
    }),
  };
}
