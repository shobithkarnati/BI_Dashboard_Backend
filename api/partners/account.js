/**
 * GET /api/partners/account?row=<n>[&masked=<shown value>]   reveal one bank account number
 *
 * /api/partners/sheets?sheet=PARTNER_DETAILS sends every bank account number masked ("XXXXXX1234").
 * This endpoint gives the full number for ONE partner when a user asks to see it, and logs who did.
 *
 *   row     required. 0-based index of the partner among the DATA rows of PARTNER_DETAILS, i.e. the
 *           sheets payload's `values[row + 1]` (values[0] is the header row). This is the same index
 *           as in the array the browser builds from `values.slice(1)` (fetchSheet). Digits only,
 *           no sign, no leading zeros, at most 6 digits.
 *   masked  optional, recommended. The masked value the page shows for that row. When given and the
 *           row's number no longer masks to it (the sheet changed since the page loaded), the answer
 *           is 409 and nothing is revealed: reload and try again.
 *
 *   200 { account: "<full number as stored in the sheet, trimmed>" }
 *   400 row missing or invalid · 403 not allowed (dashboard or PARTNER_DETAILS_ALLOWED_USERS)
 *   404 no such row, or that row has no account number · 409 sheet changed (see `masked`)
 *
 * Needs the `partners` dashboard and, when PARTNER_DETAILS_ALLOWED_USERS is set, membership in it.
 * The sheet read is the 45 s cached one shared with /api/partners/sheets.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';
import { isUserAllowedForSheet, readSheet, isAccountHeader, maskAccountNumber, SheetError } from './sheets.js';

const SHEET_KEY = 'PARTNER_DETAILS';
const ROW_PATTERN = /^(0|[1-9]\d{0,5})$/;

/** The row index from the query string, or null when it is not a plain non-negative integer. */
export function parseRow(value) {
  return typeof value === 'string' && ROW_PATTERN.test(value) ? Number(value) : null;
}

export default async function handler(req, res) {
  const claims = await guard(req, res, 'partners');
  if (!claims) return;

  const row = parseRow(req.query?.row);
  if (row === null) return send(res, 400, { error: 'Missing or invalid row.' });
  const masked = req.query?.masked;
  if (masked !== undefined && typeof masked !== 'string') return send(res, 400, { error: 'Invalid masked value.' });

  if (!isUserAllowedForSheet(SHEET_KEY, claims.email)) {
    return send(res, 403, { error: 'You do not have access to this data.' });
  }

  let data;
  try {
    data = await readSheet(SHEET_KEY);
  } catch (err) {
    if (err instanceof SheetError) return send(res, err.status, { error: err.message });
    console.error('Sheets read failed:', err?.message);
    return send(res, 500, { error: 'Server error.' });
  }

  const values = Array.isArray(data?.values) ? data.values : [];
  const column = (values[0] || []).findIndex(isAccountHeader);
  const cells = values[row + 1];
  if (!Array.isArray(cells)) return send(res, 404, { error: 'That partner was not found. Please reload.' });
  const account = column === -1 ? '' : String(cells[column] ?? '').trim();
  if (!account) return send(res, 404, { error: 'This partner has no account number.' });
  if (masked !== undefined && masked !== maskAccountNumber(account)) {
    return send(res, 409, { error: 'The partner list has changed. Please reload and try again.' });
  }

  console.log(JSON.stringify({ audit: true, who: claims.email, action: 'partners.reveal-account', row }));
  return send(res, 200, { account });
}
