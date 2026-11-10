// Copied unchanged from the v4 pricing-control function (registry.js); only its import and export lines were converted to ES modules.
// Everything the dashboard can change, in one place.
// Used by the API (what is allowed) and by viewgen.js (how the _live tables are built).
//   table   : table name in the zmater dataset
//   pk      : id column
//   fields  : columns that can be changed, with their kind: text | int | number | bool
//   extra   : columns that do not exist in zmater but are added by the _live table
//   parent  : when the parent row is removed, rows of this table disappear too
//   home    : 'ctl' = a new table that lives in pricing_control (not in the app database yet)
const REGISTRY = {
  package: {
    table: 'package_details', pk: 'package_details_id', noun: 'package', nameCol: 'package_name',
    fields: {
      package_name: 'text', category_id: 'int', package_priority: 'int', is_active: 'bool',
      price_type: 'text', price_reference: 'text', short_description: 'text', description: 'text', timeline: 'text',
    },
  },
  category: {
    table: 'categories', pk: 'category_id', noun: 'category', nameCol: 'category_name',
    fields: { category_name: 'text', category_priority: 'int', vehicle_type: 'text', bw_enabled: 'bool' },
    extra: { bw_enabled: { type: 'BOOL', def: 'TRUE' } },
  },
  service: {
    table: 'services', pk: 'service_id', noun: 'service', nameCol: 'service_name',
    fields: { service_name: 'text', category_id: 'int', service_identifier: 'text', bw_enabled: 'bool' },
    extra: { bw_enabled: { type: 'BOOL', def: 'TRUE' } },
  },
  ppgm: {
    table: 'product_price_group_map', pk: 'ppgm_id', noun: 'price',
    fields: { cost_total: 'number', discount_total: 'number', is_active: 'bool' },
  },
  price_group: {
    table: 'price_groups', pk: 'price_group_id', noun: 'price group',
    fields: { package_details_id: 'int', price_reference: 'text', price_reference_id: 'text', fuel_type: 'text' },
  },
  product_detail: {
    table: 'product_details', pk: 'product_details_id', noun: 'option', nameCol: 'product_name',
    fields: { package_details_id: 'int', product_name: 'text', pricing_level: 'text' },
  },
  package_service: {
    table: 'package_services', pk: 'package_service_id', noun: 'package service',
    fields: { package_details_id: 'int', service_id: 'int', package_service_priority: 'int' },
  },
  package_image: {
    table: 'package_images', pk: 'package_image_id', noun: 'package image',
    fields: { package_details_id: 'int', image_path: 'text' },
  },
  category_image: {
    table: 'category_image', pk: 'category_image_id', noun: 'category image',
    fields: { category_id: 'int', identifier: 'text', image_url: 'text' },
  },
  vehicle_master: {
    table: 'vehicle_master', pk: 'vehicle_master_id', noun: 'vehicle',
    fields: { make: 'text', model: 'text', body_type: 'text', vehicle_type: 'text' },
  },
  vehicle_variant: {
    table: 'vehicle_variant', pk: 'vehicle_variant_id', noun: 'variant', nameCol: 'name',
    fields: { vehicle_master_id: 'int', name: 'text', fuel_type: 'text', transmission_type: 'text', from_year: 'int', to_year: 'int' },
    parent: { entity: 'vehicle_master', fk: 'vehicle_master_id' },
  },
  service_center: {
    table: 'service_centers', pk: 'service_center_id', noun: 'service center', nameCol: 'name',
    fields: { name: 'text', active_status: 'bool', instant_bookings_off: 'bool', scheduled_bookings_off: 'bool' },
  },
  subscription: {
    table: 'subscription', pk: 'subscription_id', noun: 'subscription', nameCol: 'name',
    fields: { name: 'text', description: 'text', img_url: 'text', sellable: 'bool' },
  },
  app_config: {
    table: 'resource_config', pk: 'resource_config_id', noun: 'app content group', nameCol: 'resource_config_name',
    fields: { resource_config_name: 'text' },
  },
  app_content: {
    table: 'resource_config_details', pk: 'resource_config_details_id', noun: 'app content', nameCol: 'resource_config_key',
    fields: { config_id: 'int', resource_config_key: 'text', resource_config_value: 'text' },
  },

  // ----- new tables (made by setup.sh in pricing_control) -----
  service_price: {
    table: 'service_prices', home: 'ctl', pk: 'service_price_id', noun: 'service price',
    fields: { ppgm_id: 'int', service_id: 'int', parts_price: 'number', labour_price: 'number' },
  },
  price_setting: {
    table: 'price_settings', home: 'ctl', pk: 'price_setting_id', noun: 'price setting', nameCol: 'setting_key',
    fields: { setting_key: 'text', vehicle_type: 'text', setting_value: 'text' },
  },
  store_category: {
    table: 'store_categories', home: 'ctl', pk: 'store_category_id', noun: 'store category', nameCol: 'category_name',
    fields: { category_name: 'text', description: 'text', image_url: 'text', priority: 'int', is_active: 'bool' },
  },
  store_product: {
    table: 'store_products', home: 'ctl', pk: 'store_product_id', noun: 'store product', nameCol: 'product_name',
    fields: {
      store_category_id: 'int', product_name: 'text', brand: 'text', sku: 'text', vehicle_type: 'text',
      short_description: 'text', description: 'text', features: 'text', information: 'text',
      mrp: 'number', selling_price: 'number', gst_percent: 'number', hsn_code: 'text', stock_qty: 'int',
      warranty: 'text', installation_available: 'bool', installation_price: 'number', delivery_days: 'int',
      return_policy: 'text', universal_fit: 'bool', tags: 'text', priority: 'int', is_active: 'bool',
    },
  },
  store_product_image: {
    table: 'store_product_images', home: 'ctl', pk: 'store_product_image_id', noun: 'product photo',
    fields: { store_product_id: 'int', image_url: 'text', priority: 'int' },
  },
  store_fitment: {
    table: 'store_fitments', home: 'ctl', pk: 'store_fitment_id', noun: 'fitment',
    fields: { store_product_id: 'int', vehicle_master_id: 'int', fuel_type: 'text', from_year: 'int', to_year: 'int', notes: 'text' },
  },
  store_review: {
    table: 'store_reviews', home: 'ctl', pk: 'store_review_id', noun: 'review', nameCol: 'review_title',
    fields: { store_product_id: 'int', reviewer_name: 'text', rating: 'int', review_title: 'text', review_text: 'text', review_date: 'text', is_approved: 'bool' },
  },
};

// Column types of the new tables (used by setup.sh to create them, and by the SQL export for Postgres)
const NEW_TABLE_TYPES = { int: ['INT64', 'BIGINT'], number: ['FLOAT64', 'NUMERIC'], text: ['STRING', 'TEXT'], bool: ['BOOL', 'BOOLEAN'] };

// Priority columns (which one is shown first)
const PRIORITY = {
  category: 'category_priority',
  package: 'package_priority',
  package_service: 'package_service_priority',
  store_category: 'priority',
  store_product: 'priority',
  store_product_image: 'priority',
};

// CREATE TABLE statements for the new tables. dialect: 'bq' (BigQuery) or 'pg' (Postgres)
function newTableDDL(dialect, prefix) {
  const out = [];
  for (const cfg of Object.values(REGISTRY)) {
    if (cfg.home !== 'ctl') continue;
    const i = dialect === 'bq' ? 0 : 1;
    const cols = [`${cfg.pk} ${NEW_TABLE_TYPES.int[i]}${dialect === 'pg' ? ' PRIMARY KEY' : ''}`]
      .concat(Object.entries(cfg.fields).map(([f, k]) => `${f} ${NEW_TABLE_TYPES[k][i]}`));
    out.push(`CREATE TABLE IF NOT EXISTS ${prefix(cfg.table)} (\n  ${cols.join(',\n  ')}\n);`);
  }
  return out.join('\n');
}

export { REGISTRY, PRIORITY, newTableDDL };
