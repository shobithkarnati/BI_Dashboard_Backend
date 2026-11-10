/** BigQuery REST `tabledata.list` reader (no query jobs, no SQL, needs only BigQuery Data Viewer). */

import { googleGet, GoogleApiError, SCOPES } from './google.js';
import { createReadCache } from './readCache.js';

const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const PAGE_SIZE = 10000;
const SCHEMA_TTL_MS = 5 * 60_000;
const schemaCache = new Map();
/** Raw rows per table URL for 45 s (see readCache.js); concurrent reads of one table share one fetch. */
export const rowCache = createReadCache();

/** Table coordinates come only from server-side configuration, never from the request. */
export function tableUrl(projectId, datasetId, tableId) {
  return `${BQ_BASE}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`;
}

/** Top-level schema fields; only real tables are readable. */
export async function getSchema(url, what) {
  const cached = schemaCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.fields;
  const meta = await googleGet(`${url}?fields=schema,type`, SCOPES.bigquery, what);
  if (meta.type && meta.type !== 'TABLE') {
    console.error(`${what}: configured source is a ${meta.type}; only real tables can be read.`);
    throw new GoogleApiError('Server configuration error.', 500);
  }
  const fields = meta.schema?.fields || [];
  schemaCache.set(url, { fields, expiresAt: Date.now() + SCHEMA_TTL_MS });
  return fields;
}

/**
 * Every page of raw rows (`row.f` cell arrays, REST string values). Cached briefly per table URL
 * (rowCache); the returned array is shared, so callers only read it.
 */
export function readRawRows(url, what) {
  return rowCache.get(url, () => fetchRawRows(url, what));
}

async function fetchRawRows(url, what) {
  const rows = [];
  let pageToken = '';
  do {
    const qs = `maxResults=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await googleGet(`${url}/data?${qs}`, SCOPES.bigquery, what);
    for (const row of page.rows || []) rows.push(row.f || []);
    pageToken = page.pageToken || '';
  } while (pageToken);
  return rows;
}

/** One Google Sheets tab as objects keyed by its header row (every value a string). */
export async function readSheetTab(spreadsheetId, tab, what = 'test list') {
  const data = await googleGet(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab)}`,
    SCOPES.sheets,
    what
  );
  const [headers, ...values] = data.values || [];
  if (!headers) return [];
  return values.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}
