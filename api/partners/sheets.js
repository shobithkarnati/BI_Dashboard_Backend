/**
 * GET /api/partners/sheets?sheet=<KEY>   (ported from the Service Center sheets function)
 *
 * Returns the raw Google Sheets values payload ({ range, majorDimension, values: [headerRow, ...dataRows] });
 * the client parses it. In PARTNER_DETAILS every bank account number is masked (XXXXXX1234, see
 * maskAccountNumber); the full number is only given out one row at a time by /api/partners/account.
 * Reads are cached for 45 s per spreadsheet + tab (shared with /api/partners/account).
 *
 * Differences from the original, on purpose: the sheet key must be on an explicit allowlist (the original auto-allowed any env var
 * ending in _SPREADSHEET_ID, which in a shared environment would expose unrelated spreadsheets such
 * as the test-data lists). The optional per-sheet <KEY>_ALLOWED_USERS list is kept as a narrower gate.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { isUserInList } from '../_lib/authorize.js';
import { getAccessToken, SCOPES } from '../_lib/google.js';
import { createReadCache } from '../_lib/readCache.js';

const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
export const SHEET_KEYS = ['PARTNER_DETAILS', 'SERVICE_NETWORK', 'PACKAGE_MAPPING', 'BOOKINGS'];

/** Optional per-sheet allowlist. When <KEY>_ALLOWED_USERS is unset, dashboard access is enough. */
export function isUserAllowedForSheet(sheetKey, email, env = process.env) {
  const raw = env[`${sheetKey}_ALLOWED_USERS`];
  if (!raw || !raw.trim()) return true;
  return isUserInList(raw, email);
}

/**
 * The service account for Sheets: the GOOGLE_SERVICE_ACCOUNT_* pair when both are set, else the Firebase
 * pair. Email and key always come from the same account (on Cloud Run neither is set and the server's own
 * account is used).
 */
function sheetsAccount(env = process.env) {
  const own = Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  return {
    clientEmail: own ? env.GOOGLE_SERVICE_ACCOUNT_EMAIL : env.FIREBASE_CLIENT_EMAIL,
    privateKey: ((own ? env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY : env.FIREBASE_PRIVATE_KEY) || '').replace(/\\+n/g, '\n'),
  };
}

/** A failure with a status and a message that is safe to show the browser (the details are logged). */
export class SheetError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Sheets values per spreadsheet + tab for 45 s (see readCache.js), shared by /sheets and /account. */
export const sheetCache = createReadCache();

/** The raw values payload of one allowlisted sheet. Throws SheetError. The result is shared: do not modify it. */
export function readSheet(sheetKey, env = process.env) {
  const spreadsheetId = env[`${sheetKey}_SPREADSHEET_ID`];
  if (!spreadsheetId) {
    console.error(`${sheetKey}_SPREADSHEET_ID is not set.`);
    throw new SheetError(404, 'Endpoint or spreadsheet not found. Check your server-side configuration.');
  }
  const sheetName = env[`${sheetKey}_SHEET_NAME`] || env.SHEET_NAME || 'Sheet1';
  return sheetCache.get(JSON.stringify([spreadsheetId, sheetName]), () => fetchSheet(sheetKey, spreadsheetId, sheetName, env));
}

async function fetchSheet(sheetKey, spreadsheetId, sheetName, env) {
  let accessToken;
  try {
    accessToken = await getAccessToken(sheetsAccount(env), SCOPES.sheets);
  } catch (err) {
    console.error('Could not obtain Sheets access token:', err.message);
    throw new SheetError(500, 'Server configuration error.');
  }

  let response;
  try {
    response = await fetch(`${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error('Network error reaching Google Sheets:', err.message);
    throw new SheetError(502, 'Could not reach Google Sheets API.');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new SheetError(502, 'Unreadable response from Google Sheets.');
  }

  if (!response.ok) {
    console.error(`Google Sheets API error (${sheetKey}, HTTP ${response.status}):`, data?.error?.message || '');
    // Google-side 403/404 is a server setup problem, not the user's access: report 502 so the
    // browser does not show "Access denied" or sign the user out.
    throw new SheetError(502, `The data service can't read the ${sheetKey} sheet. Check that the spreadsheet ID is correct and shared (Viewer) with the service account.`);
  }
  return data;
}

/** Header -> comparable key, as the browser's getVal does: lowercase, letters and digits only. */
export const normalizeHeader = (header) => String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** PARTNER_DETAILS columns holding a bank account number ("Bank Account Number", "bank_account_number", ...). */
const ACCOUNT_HEADERS = new Set(['bankaccountnumber', 'bankaccountno', 'accountnumber']);
export const isAccountHeader = (header) => ACCOUNT_HEADERS.has(normalizeHeader(header));

/**
 * "XXXXXX" + the last 4 characters (spaces and dashes ignored), e.g. "50100123451234" -> "XXXXXX1234".
 * Values under 8 characters are fully masked ("XXXX"); an empty cell stays "". The X count is fixed,
 * so the mask does not reveal the number's length.
 */
export function maskAccountNumber(value) {
  const compact = String(value ?? '').replace(/[\s-]/g, '');
  if (!compact) return '';
  return compact.length < 8 ? 'XXXX' : `XXXXXX${compact.slice(-4)}`;
}

/** A copy of a PARTNER_DETAILS payload with every bank account number masked (the input is not changed). */
export function maskPartnerDetails(data) {
  const values = Array.isArray(data?.values) ? data.values : null;
  if (!values || !values.length) return data;
  const columns = (values[0] || []).flatMap((header, i) => (isAccountHeader(header) ? [i] : []));
  if (!columns.length) return data;
  return {
    ...data,
    values: [values[0], ...values.slice(1).map((row) => {
      if (!Array.isArray(row)) return row;
      const copy = [...row];
      for (const i of columns) if (i < copy.length) copy[i] = maskAccountNumber(copy[i]);
      return copy;
    })],
  };
}

/** The sheet key from ?sheet=, or an error response already sent (null). */
export function parseSheetKey(req, res) {
  const sheetKey = typeof req.query?.sheet === 'string' ? req.query.sheet.toUpperCase() : '';
  if (!sheetKey) {
    send(res, 400, { error: 'Missing required query parameter: sheet' });
    return null;
  }
  if (!SHEET_KEYS.includes(sheetKey)) {
    console.error(`Unknown sheet key "${sheetKey}" requested.`);
    send(res, 400, { error: 'Unknown data source.' });
    return null;
  }
  return sheetKey;
}

export default async function handler(req, res) {
  const claims = await guard(req, res, 'partners');
  if (!claims) return;

  const sheetKey = parseSheetKey(req, res);
  if (!sheetKey) return;

  if (!isUserAllowedForSheet(sheetKey, claims.email)) {
    return send(res, 403, { error: 'You do not have access to this data.' });
  }

  try {
    const data = await readSheet(sheetKey);
    return send(res, 200, sheetKey === 'PARTNER_DETAILS' ? maskPartnerDetails(data) : data);
  } catch (err) {
    if (err instanceof SheetError) return send(res, err.status, { error: err.message });
    console.error('Sheets read failed:', err?.message);
    return send(res, 500, { error: 'Server error.' });
  }
}
