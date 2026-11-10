/**
 * Product Management service: the shared change engine (engine/changes.js) plus every sub-module's
 * reads (modules/), as one object: { change, history, batch, undo, <module>: { ...reads } }.
 */
import { createChangeEngine } from './engine/changes.js';
import { MODULES, allowedChanges } from './modules/index.js';

export { HttpError } from './engine/changes.js';

export function createProductsService({ q, dml, project, srcDataset, ctlDataset, modules = MODULES }) {
  const engine = createChangeEngine({ q, dml, project, srcDataset, ctlDataset, allowed: allowedChanges(modules), checks: modules.map((m) => m.checkChange).filter(Boolean) });
  const service = { change: engine.change, history: engine.history, batch: engine.batch, undo: engine.undo };
  for (const m of modules) service[m.id] = m.createQueries(engine.tables);
  return service;
}
