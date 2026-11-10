/**
 * Shared wiring for the /api/products/* endpoints: the sign-in guard, the service and error handling.
 * Reading needs the "products" dashboard; saving and undoing need "products_edit".
 */

import { guard } from '../guard.js';
import { send } from '../respond.js';
import { createBigQuery } from './engine/bq.js';
import { createProductsService, HttpError } from './service.js';

let service = null;
export function productsService(env = process.env) {
  if (!service) {
    if (!env.BQ_PROJECT_ID) throw new HttpError(500, 'Server configuration error.');
    service = createProductsService({
      ...createBigQuery({ project: env.BQ_PROJECT_ID }),
      project: env.BQ_PROJECT_ID,
      srcDataset: env.PRICING_SRC_DATASET || 'zmater',
      ctlDataset: env.PRICING_CTL_DATASET || 'pricing_control',
    });
  }
  return service;
}

/** The editor's name saved in change_log (changed_by / reverted_by). */
export const editorName = (claims) => String(claims?.email || claims?.uid || 'unknown').slice(0, 120);

/**
 * `fn(req, claims, service)` returns `{ status, body }` or a plain body (sent with 200).
 * `{ edit: true }` endpoints need the edit permission; `methods` defaults to GET.
 */
export function productsEndpoint(fn, { edit = false, methods = ['GET'], deps = {} } = {}) {
  return async function handler(req, res) {
    const claims = await (deps.guard || guard)(req, res, edit ? 'products_edit' : 'products', { methods });
    if (!claims) return;
    try {
      const out = await fn(req, claims, deps.service || productsService());
      if (out && typeof out.status === 'number' && 'body' in out) return send(res, out.status, out.body);
      return send(res, 200, out);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (typeof err?.status === 'number' && err.message) return send(res, err.status, { error: err.message });
      console.error('Product Management error:', err?.message || err);
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}
