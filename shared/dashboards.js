/**
 * THE list of dashboards, read by both the server (permissions) and the browser (sidebar, routes,
 * Admin page checkboxes). Plain data with no imports so either side can load it.
 *
 *   id     permission name, URL prefix (/<id>), API folder (api/<id>/) and key in src/app/dashboards.js
 *   label  shown in the sidebar, breadcrumbs and Admin page
 *   admin  true only for the user-management page: "*" never grants it
 *   grantOnly  a permission, not a page (no sidebar entry): "*" never grants it
 *   implies    another id this one also gives (edit gives view)
 *
 * Order here is sidebar order. To add a dashboard, see "Adding a dashboard" in README.md.
 */
export const DASHBOARDS = [
  { id: 'advisor', label: 'Advisors' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'partners', label: 'Partners' },
  { id: 'users', label: 'Users' },
  { id: 'products', label: 'Product Management' },
  { id: 'products_edit', label: 'Product Management: edit', grantOnly: true, implies: 'products', hint: 'Can save and undo changes in Product Management (includes viewing it)' },
  { id: 'admin', label: 'Admin', admin: true, hint: 'Can manage users and access' },
];

export const DASHBOARD_IDS = DASHBOARDS.map((d) => d.id);
/** What "*" grants: every dashboard except admin and the edit-only permissions. */
export const DATA_DASHBOARD_IDS = DASHBOARDS.filter((d) => !d.admin && !d.grantOnly).map((d) => d.id);

/** Adds what each grant implies (products_edit -> products). Returns ids in canonical order. */
export function withImplied(ids) {
  const set = new Set(ids);
  DASHBOARDS.forEach((d) => { if (d.implies && set.has(d.id)) set.add(d.implies); });
  return DASHBOARD_IDS.filter((id) => set.has(id));
}
