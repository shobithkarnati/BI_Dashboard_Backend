/**
 * GET /api/products/catalog   (Catalog sub-module: categories, packages, services)
 * Everything the Catalog pages need, with saved changes on top: { categories, packages, services, links }. Needs Product Management.
 */
import { productsEndpoint } from '../_lib/products/handler.js';

export default productsEndpoint((req, claims, service) => service.catalog.catalog());
