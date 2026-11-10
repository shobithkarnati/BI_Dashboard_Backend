/**
 * GET /api/products/vehicles   (Vehicles sub-module)
 * Every vehicle (vehicle_master with saved changes on top), every variant, and the pick lists:
 * { vehicles, variants, lookups }. Needs Product Management.
 */
import { productsEndpoint } from '../_lib/products/handler.js';

export default productsEndpoint((req, claims, service) => service.vehicles.vehicles());
