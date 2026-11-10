/**
 * The two BigQuery calls the v4 pricing code needs, `q` (SELECT -> rows) and `dml` (INSERT / UPDATE ->
 * rows changed), over the REST API with the app's service account. v4 used Google's client library;
 * this returns the same plain values it did (numbers for INT64 and FLOAT64, booleans, ISO time strings),
 * so the copied v4 code works unchanged. Every value goes in as a query parameter, never into the SQL text.
 */

import { googleFetch, SCOPES } from '../../google.js';

const API = 'https://bigquery.googleapis.com/bigquery/v2/projects';
const WAIT_MS = 20_000;

export class BigQueryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** JS value -> BigQuery parameter type (as the client library infers it). `hint` like ['INT64'] for arrays. */
function paramType(value, hint) {
  if (Array.isArray(value) || Array.isArray(hint)) {
    const inner = Array.isArray(hint) ? hint[0] : null;
    return { type: 'ARRAY', arrayType: inner ? { type: inner } : paramType(value[0]) };
  }
  if (typeof hint === 'string') return { type: hint };
  if (typeof value === 'boolean') return { type: 'BOOL' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'INT64' : 'FLOAT64' };
  return { type: 'STRING' };
}

const paramValue = (value) => (Array.isArray(value)
  ? { arrayValues: value.map((v) => paramValue(v)) }
  : { value: value === null || value === undefined ? null : String(value) });

export function toQueryParameters(params = {}, types = {}) {
  return Object.entries(params).map(([name, value]) => ({
    name,
    parameterType: paramType(value, types?.[name]),
    parameterValue: paramValue(value),
  }));
}

/** One REST cell -> the plain value the client library gives (after v4's `plain()`). */
function cellValue(field, v) {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED') return (v || []).map((item) => cellValue({ ...field, mode: 'NULLABLE' }, item.v));
  switch (field.type) {
    case 'INTEGER': case 'INT64': case 'FLOAT': case 'FLOAT64': return Number(v);
    case 'BOOLEAN': case 'BOOL': return v === 'true' || v === true;
    case 'TIMESTAMP': return new Date(Number(v) * 1000).toISOString();
    case 'RECORD': case 'STRUCT': return Object.fromEntries(field.fields.map((f, i) => [f.name, cellValue(f, v.f[i].v)]));
    default: return v; // STRING, NUMERIC, DATE, DATETIME, TIME, JSON: as BigQuery wrote them
  }
}

export function toRows(schema, rows = []) {
  const fields = schema?.fields || [];
  return rows.map((r) => Object.fromEntries(fields.map((f, i) => [f.name, cellValue(f, r.f[i].v)])));
}

function failure(status, data) {
  const message = data?.error?.message || `HTTP ${status}`;
  console.error('BigQuery error:', message);
  if (/not found: (table|dataset)|does not exist/i.test(message)) return new BigQueryError('Setup is not finished: a pricing_control table or view is missing.', 500);
  if (status === 403) return new BigQueryError('The server is not allowed to read or save this data yet (Google Cloud access).', 502);
  return new BigQueryError('The data service failed. Please try again.', status === 400 ? 500 : 502);
}

/** Creates `{ q, dml }` for one project. `fetchImpl` is injectable for tests. */
export function createBigQuery({ project, fetchImpl = googleFetch } = {}) {
  const base = `${API}/${encodeURIComponent(project)}`;

  async function run(sql, params, types, scope) {
    const { status, data } = await fetchImpl(`${base}/queries`, scope, {
      method: 'POST',
      body: { query: sql, useLegacySql: false, parameterMode: 'NAMED', queryParameters: toQueryParameters(params, types), timeoutMs: 10_000 },
    });
    if (status !== 200) throw failure(status, data);
    let page = data;
    const started = Date.now();
    const rows = [];
    // Wait for slow queries, then read every page.
    for (;;) {
      if (page.jobComplete === false) {
        if (Date.now() - started > WAIT_MS) throw new BigQueryError('The query took too long. Please try again.', 504);
      } else {
        rows.push(...toRows(page.schema || data.schema, page.rows));
        if (!page.pageToken) return { rows, affected: Number(page.numDmlAffectedRows || data.numDmlAffectedRows || 0) };
      }
      const { jobId, location } = data.jobReference;
      const qs = new URLSearchParams({ timeoutMs: '10000', ...(location ? { location } : {}), ...(page.pageToken ? { pageToken: page.pageToken } : {}) });
      const next = await fetchImpl(`${base}/queries/${encodeURIComponent(jobId)}?${qs}`, scope);
      if (next.status !== 200) throw failure(next.status, next.data);
      page = next.data;
    }
  }

  return {
    q: async (sql, params, types) => (await run(sql, params, types, SCOPES.bigquery)).rows,
    dml: async (sql, params) => (await run(sql, params, undefined, SCOPES.bigqueryEdit)).affected,
  };
}
