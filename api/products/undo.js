/**
 * POST /api/products/undo   { batchId }
 * Marks one change batch REVERTED (with who and when); the _live views drop it at once.
 * Needs Product Management edit.
 */
import { productsEndpoint, editorName } from '../_lib/products/handler.js';

export default productsEndpoint((req, claims, service) => service.undo(String(req.body?.batchId || ''), editorName(claims)), { edit: true, methods: ['POST'] });
