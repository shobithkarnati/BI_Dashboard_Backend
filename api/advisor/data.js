/**
 * GET /api/advisor/data?type=<type>   (ported from the Advisor Netlify function data.js)
 *
 * Reads Advisor tables straight from BigQuery (tabledata.list, no SQL). Project, dataset and
 * table names are server-side env vars, never client input. Responds { rows: [{ column: value }] }.
 * Cell conversion is Advisor's own (ISO timestamps, "lat, lng" geography) and is not shared.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { toHttpError } from '../_lib/google.js';
import { tableUrl, getSchema, readRawRows } from '../_lib/bigquery.js';

const DATA_TYPES = {
  technician_details: { table: () => process.env.BQ_TABLE_TECHNICIAN_DETAILS },
  technician_referrals: { table: () => process.env.BQ_TABLE_REFERRALS },
  technician_booking_data: {
    table: () => process.env.BQ_TABLE_BOOKING_DATA,
    aliases: { 'Phone Number': 'advisor_phone' },
  },
};
// advisor_booking_data is the same table as technician_booking_data
DATA_TYPES.advisor_booking_data = DATA_TYPES.technician_booking_data;

/** "POINT(lng lat)" -> "lat, lng". Anything else is returned unchanged. */
export function wktToLatLng(wkt) {
  const m = /^POINT\s*\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/i.exec(wkt);
  return m ? `${m[2]}, ${m[1]}` : wkt;
}

export function convertCell(field, cell) {
  const v = cell?.v;
  if (v === null || v === undefined) return '';
  if (field.mode === 'REPEATED' || field.type === 'RECORD' || field.type === 'STRUCT') return JSON.stringify(v);
  switch (field.type) {
    case 'TIMESTAMP': {
      const seconds = parseFloat(v); // REST returns epoch seconds, e.g. "1.7E9"
      return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : String(v);
    }
    case 'GEOGRAPHY':
      return wktToLatLng(String(v));
    default:
      return String(v);
  }
}

export default async function handler(req, res) {
  if (!(await guard(req, res, 'advisor'))) return;

  const { type } = req.query || {};
  const config = typeof type === 'string' && Object.hasOwn(DATA_TYPES, type) ? DATA_TYPES[type] : null;
  if (!config) {
    return send(res, 400, { error: `Invalid type. Must be one of: ${Object.keys(DATA_TYPES).join(', ')}` });
  }

  const { BQ_PROJECT_ID, BQ_DATASET } = process.env;
  const table = config.table();
  if (!BQ_PROJECT_ID || !BQ_DATASET || !table) {
    return send(res, 500, { error: 'BigQuery table is not configured on the server.' });
  }

  try {
    const url = tableUrl(BQ_PROJECT_ID, BQ_DATASET, table);
    const fields = await getSchema(url, `${type} table`);
    const raw = await readRawRows(url, `${type} table`);
    const aliases = config.aliases || {};
    const rows = raw.map((cells) => {
      const obj = {};
      fields.forEach((field, i) => {
        const value = convertCell(field, cells[i]);
        obj[field.name] = value;
        if (aliases[field.name]) obj[aliases[field.name]] = value;
      });
      return obj;
    });
    return send(res, 200, { rows });
  } catch (err) {
    const [status, error] = toHttpError(err);
    return send(res, status, { error });
  }
}
