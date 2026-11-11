/**
 * THE list of Product Management sub-modules on the server. Each module file exports:
 *   id              its name (matches the page sub-module in master-app)
 *   allowedChanges  { change type: [entities] } it may save through the shared change engine
 *   createQueries   (tables) => { readName: async () => data } for its own endpoints
 *   undoableEntities (optional) extra entities its batches contain, so Undo accepts them (no request may name them)
 *   checkChange     (optional) (body) => void: throws an HttpError to refuse a change request before it is planned
 * To add one: write modules/<id>.js, add it below, add its endpoint in api/products/ and routes.js.
 */
import * as vehicles from './vehicles.js';
import * as catalog from './catalog.js';
import * as pricing from './pricing.js';

export const MODULES = [vehicles, catalog, pricing];

/** Every module's allowed changes merged: { type: [entities] }. */
export function allowedChanges(modules = MODULES) {
  const out = {};
  for (const m of modules) {
    for (const [type, entities] of Object.entries(m.allowedChanges || {})) out[type] = [...new Set([...(out[type] || []), ...entities])];
  }
  return out;
}
