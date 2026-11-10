/**
 * GET /api/users/data?type=<type>   (ported from the Users Netlify function data.js)
 *
 * users | vehicles | bookings | subscriptions | carts | locations come from BigQuery tables named in env vars
 * (BQ_TABLE_BOOKINGS here is the Users dashboard's own table, separate from Bookings' BQ_TABLE).
 * test_users | test_service_centers come from Google Sheets. Responds { rows: [{ column: value }] }
 * with every value a string, formatted exactly as the dashboard has always received it.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { toHttpError } from '../_lib/google.js';
import { tableUrl, getSchema, readRawRows, readSheetTab } from '../_lib/bigquery.js';

const BQ_TABLES = {
  users: () => process.env.BQ_TABLE_USERS,
  vehicles: () => process.env.BQ_TABLE_VEHICLES,
  bookings: () => process.env.BQ_TABLE_BOOKINGS,
  subscriptions: () => process.env.BQ_TABLE_SUBSCRIPTIONS,
  carts: () => process.env.BQ_TABLE_CARTS,
  locations: () => process.env.BQ_TABLE_LOCATIONS,
};
const SHEET_SOURCES = {
  test_users: () => ({ spreadsheetId: process.env.TEST_DATA_SPREADSHEET_ID, tab: process.env.TEST_USERS_SHEET_NAME || 'test_users' }),
  test_service_centers: () => ({ spreadsheetId: process.env.TEST_DATA_SPREADSHEET_ID, tab: process.env.TEST_SERVICE_CENTERS_SHEET_NAME || 'test_service_centers' }),
};
const BQ_TYPES = Object.keys(BQ_TABLES);
const ALL_TYPES = [...BQ_TYPES, ...Object.keys(SHEET_SOURCES)];

// Tables listed here are trimmed to these columns before leaving the server: the cart export is
// large and has many columns the dashboard never uses.
export const COLUMN_ALLOWLIST = {
  carts: new Set([
    'booking_id', 'booking_status', 'booking_cart_id', 'user_id', 'name', 'user_PhoneNumber',
    'vehicle_id', 'Vehicle_name', 'registration_number', 'fuel_type', 'vehicle_type', 'channel', 'cart_category',
    'booking_type', 'booking_cart_status', 'service_center_slot_id', 'is_user_rescheduled',
    'cart_created_at', 'package_name', 'seconds_in_cart', 'user_subscription_id', 'service_center_id',
  ]),
};

/** Epoch ms -> "YYYY-MM-DD HH:mm:ss" read in UTC. */
const formatUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * One BigQuery cell (REST sends every value as a string) to the text the dashboard has always
 * received from Google Sheets. NULL becomes ''. Change a date format here and only here.
 */
export function toCell(type, value) {
  if (value == null) return '';
  if (typeof value !== 'string') return JSON.stringify(value);
  switch (type) {
    case 'TIMESTAMP': {
      // Epoch seconds as a float string (possibly scientific notation), rounded to the second as Sheets showed them.
      const seconds = Math.round(Number(value));
      return Number.isFinite(seconds) ? formatUtc(seconds * 1000) : value;
    }
    case 'DATETIME': {
      // "2026-07-11T11:36:55.520749": a wall-clock time with no zone, rounded to the second, never shifted.
      const ms = Date.parse(`${value}Z`);
      return Number.isNaN(ms) ? value : formatUtc(Math.round(ms / 1000) * 1000);
    }
    case 'BOOLEAN':
    case 'BOOL':
      return value.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
    default:
      return value;
  }
}

async function readBigQuery(type, table) {
  const url = tableUrl(process.env.BQ_PROJECT_ID, process.env.BQ_DATASET, table);
  const fields = await getSchema(url, `${type} table`);
  const allowed = COLUMN_ALLOWLIST[type];
  // [column index in the REST row, name, type] for every column that is sent to the browser.
  const columns = fields.flatMap((field, index) => (!allowed || allowed.has(field.name) ? [[index, field.name, field.type]] : []));
  const raw = await readRawRows(url, `${type} table`);
  return raw.map((cells) => Object.fromEntries(columns.map(([index, name, fieldType]) => [name, toCell(fieldType, cells[index]?.v)])));
}

export default async function handler(req, res) {
  if (!(await guard(req, res, 'users'))) return;

  const { type } = req.query || {};
  if (typeof type !== 'string' || !ALL_TYPES.includes(type)) {
    return send(res, 400, { error: `Invalid type. Must be one of: ${ALL_TYPES.join(', ')}` });
  }

  const isBigQuery = BQ_TYPES.includes(type);
  const table = isBigQuery ? BQ_TABLES[type]() : null;
  const sheet = isBigQuery ? null : SHEET_SOURCES[type]();
  const configured = isBigQuery ? process.env.BQ_PROJECT_ID && process.env.BQ_DATASET && table : sheet.spreadsheetId;
  if (!configured) {
    return send(res, 404, { error: `The "${type}" data source is not configured on the server.` });
  }

  try {
    const rows = isBigQuery ? await readBigQuery(type, table) : await readSheetTab(sheet.spreadsheetId, sheet.tab);
    return send(res, 200, { rows });
  } catch (err) {
    const [status, error] = toHttpError(err);
    return send(res, status, { error });
  }
}
