/**
 * GET /api/products/pricing?view=...   (Pricing sub-module: prices, discounts, GST and fees)
 *   view=overview (default)  { packages, categories, settings, lookups }
 *   view=package&id=         one package's prices: { package, rows, options, bodyCounts }
 *   view=vehicle-prices&id=  what each vehicle + fuel pays for a package (&q= &body= &fuel= to narrow)
 *   view=price-detail&ppgmId=  one price row with the price of each service in it
 *   view=check               the GST and fees real bookings used (to compare with the settings)
 * Needs Product Management.
 */
import { productsEndpoint } from '../_lib/products/handler.js';

export default productsEndpoint((req, claims, service) => service.pricing.read(req.query || {}));
