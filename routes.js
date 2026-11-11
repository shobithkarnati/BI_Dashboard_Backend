/**
 * Every endpoint in api/, by route (/api/<route>). Adding a file in api/ means adding it here:
 * tests/server.test.js fails until you do.
 */
import adminAudit from './api/admin/audit.js';
import adminUsers from './api/admin/users.js';
import advisorData from './api/advisor/data.js';
import advisorDistance from './api/advisor/distance.js';
import bookings from './api/bookings/index.js';
import mePermissions from './api/me/permissions.js';
import partnersAccount from './api/partners/account.js';
import partnersSheets from './api/partners/sheets.js';
import productsCatalog from './api/products/catalog.js';
import productsChange from './api/products/change.js';
import productsPricing from './api/products/pricing.js';
import productsHistory from './api/products/history.js';
import productsUndo from './api/products/undo.js';
import productsVehicles from './api/products/vehicles.js';
import usersData from './api/users/data.js';

export const ROUTES = {
  'admin/audit': adminAudit,
  'admin/users': adminUsers,
  'advisor/data': advisorData,
  'advisor/distance': advisorDistance,
  bookings,
  'me/permissions': mePermissions,
  'partners/account': partnersAccount,
  'partners/sheets': partnersSheets,
  'products/catalog': productsCatalog,
  'products/change': productsChange,
  'products/history': productsHistory,
  'products/pricing': productsPricing,
  'products/undo': productsUndo,
  'products/vehicles': productsVehicles,
  'users/data': usersData,
};
