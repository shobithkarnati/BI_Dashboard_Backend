/**
 * GET /api/products/history[?limit=50]   every change batch of every sub-module, newest first
 * GET /api/products/history?batch=<id>   the rows of one batch
 * Needs Product Management.
 */
import { productsEndpoint } from '../_lib/products/handler.js';

export default productsEndpoint(async (req, claims, service) => {
  if (req.query?.batch) return { results: await service.batch(String(req.query.batch)) };
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  return { results: await service.history(limit) };
});
