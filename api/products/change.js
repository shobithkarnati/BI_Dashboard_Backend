/**
 * POST /api/products/change   (change engine shared by every sub-module)
 * Body as in v4: { type, entity, ..., dryRun?, force?, reason?, startAt?, endAt? }.
 * dryRun: true returns the plan to review; without it the plan is saved to pricing_control.change_log.
 * Only the changes the sub-modules allow are accepted (api/_lib/products/modules). Needs Product Management edit.
 */
import { productsEndpoint, editorName } from '../_lib/products/handler.js';

export default productsEndpoint((req, claims, service) => service.change(req.body, editorName(claims)), { edit: true, methods: ['POST'] });
