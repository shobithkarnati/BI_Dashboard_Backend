/**
 * GET /api/bookings[?type=<type>]   (ported from the Bookings Netlify function bookings.js)
 *
 * bookings (default) is read from the BigQuery table BQ_TABLE; test_users | test_service_centers are
 * two tabs of the TEST_DATA_SPREADSHEET_ID Google Sheet. Responds { rows: [{ column: value }] } with
 * every value a string, and only the columns the dashboard uses.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { toHttpError } from '../_lib/google.js';
import { tableUrl, getSchema, readRawRows, readSheetTab } from '../_lib/bigquery.js';

const SHEET_SOURCES = {
  test_users: () => ({ spreadsheetId: process.env.TEST_DATA_SPREADSHEET_ID, tab: process.env.TEST_USERS_SHEET_NAME || 'test_users' }),
  test_service_centers: () => ({ spreadsheetId: process.env.TEST_DATA_SPREADSHEET_ID, tab: process.env.TEST_SERVICE_CENTERS_SHEET_NAME || 'test_service_centers' }),
};
const ALL_TYPES = ['bookings', ...Object.keys(SHEET_SOURCES)];

// Only the columns the dashboard uses are sent to the browser.
export const COLUMNS = [
  'booking_id', 'booking_date', 'user_id', 'user_name', 'phone_number',
  'vehicle_type', 'vehicle_name', 'body_type', 'package_details_id', 'package_name',
  'fuel_type', 'service_center_id', 'service_center_name', 'booking_type',
  'is_membership_booking', 'is_base_or_Add_on',
  'technician_pickup_type', 'technician_pickup_id', 'technician_pickup_name',
  'technician_drop_type', 'technician_drop_id', 'technician_drop_name',
  'amount_paid', 'booking_status', 'reject_reason', 'refund_status', 'refund_amount',
];

/** One BigQuery REST cell (a string or null) to a JSON-friendly string. TIMESTAMP -> ISO-8601. */
export function toPlain(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'TIMESTAMP') {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
  }
  return String(value);
}

async function readBookings() {
  const { BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE } = process.env;
  const url = tableUrl(BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE);
  const fields = await getSchema(url, 'bookings table');
  const wanted = fields
    .map((field, index) => ({ name: field.name, type: field.type, index }))
    .filter((field) => COLUMNS.includes(field.name));
  const raw = await readRawRows(url, 'bookings table');
  return raw.map((cells) => {
    const row = {};
    COLUMNS.forEach((col) => { row[col] = ''; });
    wanted.forEach(({ name, type, index }) => { row[name] = toPlain(cells[index]?.v, type); });
    return row;
  });
}

export default async function handler(req, res) {
  if (!(await guard(req, res, 'bookings'))) return;

  const type = req.query?.type ?? 'bookings';
  if (typeof type !== 'string' || !ALL_TYPES.includes(type)) {
    return send(res, 400, { error: `Invalid type. Must be one of: ${ALL_TYPES.join(', ')}` });
  }

  const isBookings = type === 'bookings';
  const { BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE } = process.env;
  const sheet = isBookings ? null : SHEET_SOURCES[type]();
  const configured = isBookings ? BQ_PROJECT_ID && BQ_DATASET && BQ_TABLE : sheet.spreadsheetId;
  if (!configured) {
    return send(res, 404, { error: `The "${type}" data source is not configured on the server.` });
  }

  try {
    const rows = isBookings ? await readBookings() : await readSheetTab(sheet.spreadsheetId, sheet.tab);
    return send(res, 200, { rows });
  } catch (err) {
    const [status, error] = toHttpError(err);
    return send(res, status, { error });
  }
}
