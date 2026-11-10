// Copied from the v4 pricing-control function (plans.js): its import and export lines were converted to ES modules, and
// FIRST_NEW_ID was changed (see below). Nothing else differs; tests/products.test.js checks that.
// Turns a request from the dashboard into the exact rows that will be written to change_log.
// Nothing here writes anything: it only reads, checks and builds the plan (so "Review" can show it first).
import { REGISTRY, PRIORITY } from './registry.js';

const MAX_PRICE = 1000000;
const MAX_DISCOUNT_PERCENT = 90;
const MAX_ROWS = 1500;
const WARN_PRICE_JUMP = 0.5;
const WARN_DISCOUNT_PERCENT = 60;
// CHANGED FROM v4 (owner's request): v4 started new ids at 9000001 to keep them apart from the app's own ids.
// With 0 a new id is simply the highest existing id + 1 (live rows plus every id ever added in change_log, undone or not),
// e.g. last vehicle_master_id 125 -> 126, last variant id 1457 -> 1458.
// Ids from 9000000 up were handed out by v4's old rule (and by this app before the change). They are left out of
// "the highest id", otherwise one old 9000001 would make every new id continue from there (9000002, 9000003, ...).
const FIRST_NEW_ID = 0;
const OLD_RANGE_FROM = 9000000;

// Which column means "switched on" for each kind of item
const ENABLE_FIELD = {
  package: 'is_active', category: 'bw_enabled', service: 'bw_enabled',
  service_center: 'active_status', ppgm: 'is_active', subscription: 'sellable',
  store_category: 'is_active', store_product: 'is_active', store_review: 'is_approved',
};
// What can be removed for good (everything else can only be switched off)
const REMOVABLE = new Set(['vehicle_master', 'vehicle_variant', 'package_service', 'package_image', 'category_image', 'app_content',
  'service_price', 'store_product_image', 'store_fitment', 'store_review']);
const CREATABLE = new Set(['vehicle_master', 'vehicle_variant', 'package', 'service', 'category', 'package_service', 'package_image', 'category_image', 'app_content',
  'store_category', 'store_product', 'store_product_image', 'store_fitment', 'store_review']);
// The price settings the dashboard uses to work out what the customer pays
const SETTING_DEFAULTS = {
  gst_percent: '18', gst_added_on_top: 'YES', gst_on_pickup_drop: 'YES', gst_on_convenience: 'YES', round_to_rupee: 'YES',
  pickup_drop_fee: '0', convenience_fee: '0',
};
const PER_VEHICLE_SETTING = new Set(['pickup_drop_fee', 'convenience_fee']);

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const asBool = v => v === true || v === 1 || v === '1' || /^(true|t|yes|1|1\.0)$/i.test(String(v));
const str = v => (v === null || v === undefined ? null : typeof v === 'boolean' ? String(v) : String(v));
const isOn = col => `LOWER(CAST(${col} AS STRING)) IN ('true', '1', '1.0')`;

function makePlans({ q, ctl, src, HttpError, positiveInt }) {
  const live = e => ctl(REGISTRY[e].table + '_live');
  const idEq = (col, p = '@id') => `CAST(CAST(${col} AS INT64) AS STRING) = ${p}`;

  function parseWhen(v, name) {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} is not a valid date and time`);
    return d;
  }

  // ---------- value checks ----------
  function clean(kind, v, field) {
    if (kind === 'bool') {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      throw new HttpError(400, `${field} must be on or off`);
    }
    if (kind === 'int') {
      const n = Number(v);
      if (v === '' || v === null || !Number.isSafeInteger(n)) throw new HttpError(400, `${field} must be a whole number`);
      return n;
    }
    if (kind === 'number') {
      const n = Number(v);
      if (v === '' || v === null || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
      return n;
    }
    let s = String(v ?? '');
    const long = /description|timeline|value|path|url|features|information|review text|return policy|notes/.test(field);
    s = long ? s.replace(/\r/g, '').trim() : s.replace(/\s+/g, ' ').trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw new HttpError(400, `${field} has characters that are not allowed`);
    if (s.length > (long ? 4000 : 200)) throw new HttpError(400, `${field} is too long`);
    return s;
  }
  const label = f => f.replace(/_/g, ' ').replace(/\bbw\b/i, 'BW').replace(/\bid\b/i, 'id');

  async function getRow(entity, id) {
    const cfg = REGISTRY[entity];
    const r = await q(`SELECT * FROM ${live(entity)} WHERE ${idEq(cfg.pk)} LIMIT 1`, { id: String(id) });
    return r[0] || null;
  }
  const nameOf = (entity, row, id) => {
    const cfg = REGISTRY[entity];
    return (cfg.nameCol && row && row[cfg.nameCol]) || `${cfg.noun} ${id}`;
  };

  async function nextIds(entity, count) {
    const cfg = REGISTRY[entity];
    const first = cfg.home === 'ctl' ? 0 : FIRST_NEW_ID;
    const r = await q(
      `SELECT GREATEST(${first},
          IFNULL((SELECT MAX(CAST(CAST(${cfg.pk} AS INT64) AS INT64)) FROM ${live(entity)} WHERE CAST(CAST(${cfg.pk} AS INT64) AS INT64) < ${OLD_RANGE_FROM}), 0),
          IFNULL((SELECT MAX(SAFE_CAST(entity_id AS INT64)) FROM ${ctl('change_log')} WHERE entity_type = @t AND op = 'ADD' AND SAFE_CAST(entity_id AS INT64) < ${OLD_RANGE_FROM}), 0)
        ) AS m`, { t: entity });
    const m = Number(r[0].m);
    return Array.from({ length: count }, (_, i) => m + 1 + i);
  }

  // ---------- plan building blocks ----------
  const newPlan = b => {
    const start = parseWhen(b.startAt, 'Start');
    const end = parseWhen(b.endAt, 'End');
    if (end) {
      if (end.getTime() <= Date.now()) throw new HttpError(400, 'End must be in the future');
      if (start && end.getTime() <= start.getTime()) throw new HttpError(400, 'End must be after start');
    }
    return { start, end, reason: String(b.reason || '').trim().slice(0, 200), warnings: [], rows: [], items: [], label: '' };
  };

  // change some fields of one existing row
  async function addSet(plan, entity, id, changes, row) {
    const cfg = REGISTRY[entity];
    row = row || await getRow(entity, id);
    if (!row) throw new HttpError(404, `That ${cfg.noun} was not found`);
    let n = 0;
    for (const [field, raw] of Object.entries(changes)) {
      const kind = cfg.fields[field];
      if (!kind) throw new HttpError(400, `"${field}" cannot be changed here`);
      const val = clean(kind, raw, label(field));
      if (cfg.nameCol === field && val === '') throw new HttpError(400, `Enter a ${label(field)}`);
      const curRaw = row[field];
      const cur = kind === 'bool' ? asBool(curRaw) : curRaw;
      if (kind === 'bool' ? cur === val : (cur !== null && cur !== undefined && String(cur) === String(val))) continue;
      if (cur === null || cur === undefined) { /* fine: first value */ }
      plan.rows.push({ entityType: entity, entityId: String(id), op: 'SET', field, oldValue: kind === 'bool' ? (curRaw == null ? null : String(cur)) : str(curRaw), newValue: str(val) });
      plan.items.push({
        title: `${cap(cfg.noun)}: ${nameOf(entity, row, id)}`, subtitle: label(field),
        old: kind === 'bool' ? (curRaw == null ? null : cur) : (curRaw ?? ''), new: val,
        kind: kind === 'bool' ? 'onoff' : (kind === 'text' ? 'text' : 'num'),
      });
      n++;
    }
    return n;
  }

  function addNew(plan, entity, id, values, title, subtitle) {
    (plan.created = plan.created || []).push({ entity, id });
    plan.rows.push({ entityType: entity, entityId: String(id), op: 'ADD', field: 'row', oldValue: null, newValue: JSON.stringify({ [REGISTRY[entity].pk]: id, ...values }) });
    plan.items.push({ title, subtitle: subtitle || '', kind: 'add' });
  }
  function addRemove(plan, entity, id, title, subtitle) {
    plan.rows.push({ entityType: entity, entityId: String(id), op: 'DELETE', field: 'row', oldValue: null, newValue: 'removed' });
    plan.items.push({ title, subtitle: subtitle || '', kind: 'remove' });
  }

  async function mustExist(entity, id, what) {
    const r = await getRow(entity, id);
    if (!r) throw new HttpError(404, `${what || cap(REGISTRY[entity].noun)} ${id} was not found`);
    return r;
  }
  async function countWhere(sql, params) {
    try { const r = await q(sql, params); return Number(r[0]?.n || 0); } catch (e) { return 0; }
  }

  // one price row with names, both the live and the original values
  const PPGM_SQL = where => `
    SELECT CAST(l.ppgm_id AS INT64) AS ppgm_id,
           CAST(pg.package_details_id AS INT64) AS package_id,
           pd.package_name AS package_name,
           CAST(pg.price_group_id AS INT64) AS price_group_id,
           UPPER(CAST(pg.price_reference AS STRING)) AS price_reference,
           CAST(pg.price_reference_id AS STRING) AS body_type,
           UPPER(CAST(pg.fuel_type AS STRING)) AS group_fuel_type,
           CAST(l.product_details_id AS INT64) AS product_details_id,
           prod.product_name AS product_name,
           SAFE_CAST(l.cost_total AS FLOAT64) AS cost,
           SAFE_CAST(l.discount_total AS FLOAT64) AS discount,
           SAFE_CAST(b.cost_total AS FLOAT64) AS orig_cost,
           SAFE_CAST(b.discount_total AS FLOAT64) AS orig_discount,
           ${isOn('l.is_active')} AS enabled
    FROM ${live('ppgm')} l
    LEFT JOIN ${src('product_price_group_map')} b ON CAST(b.ppgm_id AS INT64) = CAST(l.ppgm_id AS INT64)
    JOIN ${live('price_group')} pg ON CAST(pg.price_group_id AS INT64) = CAST(l.price_group_id AS INT64)
    JOIN ${live('package')} pd ON CAST(pd.package_details_id AS INT64) = CAST(pg.package_details_id AS INT64)
    LEFT JOIN ${live('product_detail')} prod ON CAST(prod.product_details_id AS INT64) = CAST(l.product_details_id AS INT64)
    WHERE ${where}
    ORDER BY body_type, product_name, ppgm_id
    LIMIT ${MAX_ROWS + 1}`;

  // ---------- the builders ----------
  const B = {};

  B.rename = async (b, plan) => {
    const cfg = REGISTRY[b.entity];
    if (!cfg || !cfg.nameCol || !['package', 'category', 'service', 'service_center', 'subscription'].includes(b.entity)) {
      throw new HttpError(400, 'Choose what to rename: package, category or service');
    }
    const id = positiveInt(b.id, 'Item');
    const newName = clean('text', b.newName, 'Name');
    if (!newName) throw new HttpError(400, 'Enter the new name');
    const row = await mustExist(b.entity, id);
    if (row[cfg.nameCol] === newName) throw new HttpError(400, 'The new name is the same as the current name');
    await addSet(plan, b.entity, id, { [cfg.nameCol]: newName }, row);
    plan.label = `Rename ${cfg.noun}: "${row[cfg.nameCol]}" to "${newName}"`;
  };

  B.edit = async (b, plan) => {
    const cfg = REGISTRY[b.entity];
    if (!cfg || b.entity === 'ppgm') throw new HttpError(400, 'That cannot be edited here');
    const id = positiveInt(b.id, 'Item');
    const changes = b.changes && typeof b.changes === 'object' ? b.changes : {};
    if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing was changed');
    const row = await mustExist(b.entity, id);
    for (const [f, v] of Object.entries(changes)) {
      if (f === 'category_id' && b.entity !== 'category_image') await mustExist('category', positiveInt(v, 'Category'), 'Category');
      if (f === 'vehicle_master_id') await mustExist('vehicle_master', positiveInt(v, 'Vehicle'), 'Vehicle');
    }
    const n = await addSet(plan, b.entity, id, changes, row);
    if (!n) throw new HttpError(400, 'Nothing was changed');
    if (b.entity === 'vehicle_variant') {
      const f = parseInt(String(changes.from_year ?? row.from_year ?? '').slice(0, 4), 10), t = parseInt(String(changes.to_year ?? row.to_year ?? '').slice(0, 4), 10);
      if (f && t && t < f) throw new HttpError(400, '"To year" cannot be before "From year"');
    }
    plan.label = `Edit ${cfg.noun} "${nameOf(b.entity, row, id)}"`;
  };

  B.toggle = async (b, plan) => {
    const cfg = REGISTRY[b.entity];
    if (!cfg || !(ENABLE_FIELD[b.entity] || b.field)) throw new HttpError(400, 'That cannot be switched on or off');
    const id = positiveInt(b.id, 'Item');
    const field = b.field || ENABLE_FIELD[b.entity];
    if (cfg.fields[field] !== 'bool') throw new HttpError(400, 'That cannot be switched on or off');
    const value = clean('bool', b.value, 'Value');
    const row = await mustExist(b.entity, id);
    const n = await addSet(plan, b.entity, id, { [field]: value }, row);
    if (!n && !b.cascade) throw new HttpError(400, `It is already ${value ? 'on' : 'off'}`);
    const name = nameOf(b.entity, row, id);
    let verb = value ? 'Switch on' : 'Switch off';
    if (b.entity === 'service_center') {
      const inprog = await countWhere(
        `SELECT COUNT(*) AS n FROM ${src('bookings')} WHERE CAST(CAST(service_center_id AS INT64) AS STRING) = @id AND status IN ('ACCEPTED','PICKUP_COMPLETE','SERVICESTARTED')`, { id: String(id) });
      if (field === 'active_status' && !value && inprog) plan.warnings.push(`${name} has ${inprog} booking${inprog > 1 ? 's' : ''} in progress.`);
      if (field === 'instant_bookings_off') verb = value ? 'Stop instant bookings at' : 'Allow instant bookings at';
      if (field === 'scheduled_bookings_off') verb = value ? 'Stop scheduled bookings at' : 'Allow scheduled bookings at';
    }
    if (b.entity === 'category' && b.cascade) {
      const pk = await q(`SELECT CAST(package_details_id AS INT64) AS id FROM ${live('package')} WHERE ${idEq('category_id')}`, { id: String(id) });
      let changed = 0;
      for (const p of pk) { changed += await addSet(plan, 'package', p.id, { is_active: value }); }
      if (changed) plan.warnings.push(`${value ? 'This also switches ON' : 'This also switches off'} ${changed} package${changed > 1 ? 's' : ''} in this category${value ? ', including any that were off on purpose' : ''}.`);
    }
    if (!plan.rows.length) throw new HttpError(400, `It is already ${value ? 'on' : 'off'}`);
    plan.label = `${verb} ${cfg.noun} "${name}"`;
  };

  B.order = async (b, plan) => {
    const entity = b.entity;
    const col = PRIORITY[entity];
    if (!col) throw new HttpError(400, 'That cannot be ordered');
    const ids = Array.isArray(b.ids) ? b.ids.map(x => positiveInt(x, 'Item')) : [];
    if (ids.length < 2) throw new HttpError(400, 'Nothing to put in order');
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'The same item is in the list twice');
    if (ids.length > 300) throw new HttpError(400, 'Too many items to order at once');
    const cfg = REGISTRY[entity];
    const rows = await q(`SELECT * FROM ${live(entity)} WHERE CAST(${cfg.pk} AS INT64) IN UNNEST(@ids)`, { ids }, { ids: ['INT64'] });
    const byId = new Map(rows.map(r => [Number(r[cfg.pk]), r]));
    let names = new Map();
    if (entity === 'package_service') {
      const sv = await q(`SELECT CAST(service_id AS INT64) AS id, service_name AS name FROM ${live('service')}`);
      names = new Map(sv.map(s => [s.id, s.name]));
    }
    ids.forEach(id => { if (!byId.has(id)) throw new HttpError(404, `Item ${id} was not found`); });
    let pos = 1;
    for (const id of ids) {
      const row = byId.get(id);
      const nm = entity === 'package_service' ? (names.get(Number(row.service_id)) || `Service ${row.service_id}`) : nameOf(entity, row, id);
      const cur = row[col] == null ? null : Number(row[col]);
      if (cur !== pos) {
        plan.rows.push({ entityType: entity, entityId: String(id), op: 'SET', field: col, oldValue: cur == null ? null : String(cur), newValue: String(pos) });
        plan.items.push({ title: nm, subtitle: 'Position', old: cur == null ? '–' : cur, new: pos, kind: 'num' });
      }
      pos++;
    }
    if (!plan.rows.length) throw new HttpError(400, 'The order is already like this');
    plan.label = `Change display order of ${ids.length} ${cfg.noun}${ids.length > 1 ? 's' : ''}`;
  };

  B.move = async (b, plan) => {
    const entity = b.entity;
    if (!['package', 'service'].includes(entity)) throw new HttpError(400, 'Only packages and services can be moved');
    const id = positiveInt(b.id, 'Item');
    const to = positiveInt(b.toCategoryId, 'Category');
    const row = await mustExist(entity, id);
    const dest = await mustExist('category', to, 'Category');
    if (Number(row.category_id) === to) throw new HttpError(400, `It is already in "${dest.category_name}"`);
    const from = await getRow('category', row.category_id);
    if (from && from.vehicle_type && dest.vehicle_type && String(from.vehicle_type).toUpperCase() !== String(dest.vehicle_type).toUpperCase()) {
      plan.warnings.push(`You are moving it from a ${from.vehicle_type} category to a ${dest.vehicle_type} category.`);
    }
    await addSet(plan, entity, id, { category_id: to }, row);
    // show names, not numbers
    plan.items = [{ title: `${cap(REGISTRY[entity].noun)}: ${nameOf(entity, row, id)}`, subtitle: 'Category', old: from ? from.category_name : String(row.category_id), new: dest.category_name, kind: 'text' }];
    plan.label = `Move ${REGISTRY[entity].noun} "${nameOf(entity, row, id)}" to "${dest.category_name}"`;
  };

  B.create = async (b, plan) => {
    const entity = b.entity;
    if (!CREATABLE.has(entity)) throw new HttpError(400, 'That cannot be added here');
    const cfg = REGISTRY[entity];
    const v = b.values && typeof b.values === 'object' ? b.values : {};

    if (entity === 'vehicle_master') {
      const make = clean('text', v.make, 'Make'), model = clean('text', v.model, 'Model');
      const body = clean('text', v.body_type, 'Body type'), vt = clean('text', v.vehicle_type, 'Vehicle type').toUpperCase();
      if (!make || !model) throw new HttpError(400, 'Enter the make and the model');
      if (!body) throw new HttpError(400, 'Choose the body type');
      if (!['CAR', 'BIKE'].includes(vt)) throw new HttpError(400, 'Vehicle type must be CAR or BIKE');
      const variants = Array.isArray(b.variants) ? b.variants : [];
      if (!variants.length) throw new HttpError(400, 'Add at least one variant (fuel type and years)');
      if (variants.length > 40) throw new HttpError(400, 'Add at most 40 variants at once');
      const dup = await q(`SELECT CAST(vehicle_master_id AS INT64) AS id FROM ${live('vehicle_master')}
        WHERE LOWER(make) = LOWER(@make) AND LOWER(model) = LOWER(@model) AND UPPER(CAST(vehicle_type AS STRING)) = @vt LIMIT 1`, { make, model, vt });
      if (dup.length) throw new HttpError(400, `${make} ${model} already exists (id ${dup[0].id}). Open it and add variants there.`);
      const ids = await nextIds('vehicle_master', 1);
      const vids = await nextIds('vehicle_variant', variants.length);
      addNew(plan, 'vehicle_master', ids[0], { make, model, body_type: body, vehicle_type: vt }, `${make} ${model}`, `${vt} · ${body} · id ${ids[0]}`);
      variants.forEach((x, i) => addVariant(plan, ids[0], vids[i], x, `${make} ${model}`));
      plan.label = `Add vehicle ${make} ${model} with ${variants.length} variant${variants.length > 1 ? 's' : ''}`;
      return;
    }

    if (entity === 'vehicle_variant') {
      const mid = positiveInt(b.masterId ?? v.vehicle_master_id, 'Vehicle');
      const m = await mustExist('vehicle_master', mid, 'Vehicle');
      const variants = Array.isArray(b.variants) && b.variants.length ? b.variants : [v];
      if (variants.length > 40) throw new HttpError(400, 'Add at most 40 variants at once');
      const vids = await nextIds('vehicle_variant', variants.length);
      variants.forEach((x, i) => addVariant(plan, mid, vids[i], x, `${m.make} ${m.model}`));
      plan.label = `Add ${variants.length} variant${variants.length > 1 ? 's' : ''} to ${m.make} ${m.model}`;
      return;
    }

    if (entity === 'package') {
      const name = clean('text', v.package_name, 'Package name');
      if (!name) throw new HttpError(400, 'Enter the package name');
      const cid = positiveInt(v.category_id, 'Category');
      const cat = await mustExist('category', cid, 'Category');
      const same = await q(`SELECT CAST(package_details_id AS INT64) AS id FROM ${live('package')} WHERE ${idEq('category_id', '@c')} AND LOWER(package_name) = LOWER(@n) LIMIT 1`, { c: String(cid), n: name });
      if (same.length) plan.warnings.push(`A package called "${name}" already exists in "${cat.category_name}".`);
      const pr = await q(`SELECT IFNULL(MAX(SAFE_CAST(package_priority AS INT64)), 0) AS m FROM ${live('package')} WHERE ${idEq('category_id', '@c')}`, { c: String(cid) });
      const [id] = await nextIds('package', 1);
      const vals = {
        package_name: name, category_id: cid, package_type: 'PREDEFINED', package_category: 'CARE',
        price_type: 'MBF', price_reference: 'MBF', package_priority: Number(pr[0].m) + 1, is_active: false,
        short_description: clean('text', v.short_description || '', 'Short description'),
        description: clean('text', v.description || '', 'Description'),
        timeline: clean('text', v.timeline || '', 'Timeline'),
      };
      addNew(plan, 'package', id, vals, name, `New package in ${cat.category_name} · starts switched OFF · id ${id}`);
      plan.label = `Add package "${name}" to "${cat.category_name}"`;
      return;
    }

    if (entity === 'service') {
      const name = clean('text', v.service_name, 'Service name');
      if (!name) throw new HttpError(400, 'Enter the service name');
      const cid = positiveInt(v.category_id, 'Category');
      const cat = await mustExist('category', cid, 'Category');
      const ids = await q(`SELECT service_identifier AS s FROM ${live('service')}`);
      const mx = ids.reduce((m, r) => Math.max(m, parseInt(String(r.s || '').replace(/\D/g, ''), 10) || 0), 0);
      const ident = clean('text', v.service_identifier || '', 'Identifier') || `SC${String(mx + 1).padStart(3, '0')}`;
      const [id] = await nextIds('service', 1);
      addNew(plan, 'service', id, { service_name: name, category_id: cid, service_identifier: ident, bw_enabled: true }, name, `New service in ${cat.category_name} · ${ident} · id ${id}`);
      plan.label = `Add service "${name}"`;
      return;
    }

    if (entity === 'category') {
      const name = clean('text', v.category_name, 'Category name');
      if (!name) throw new HttpError(400, 'Enter the category name');
      const vt = clean('text', v.vehicle_type, 'Vehicle type').toUpperCase();
      if (!['CAR', 'BIKE'].includes(vt)) throw new HttpError(400, 'Vehicle type must be CAR or BIKE');
      const all = await q(`SELECT category_priority AS p, cat_identifier AS ci FROM ${live('category')} WHERE UPPER(CAST(vehicle_type AS STRING)) = @vt`, { vt });
      const prefix = vt === 'CAR' ? 'CC' : 'CB';
      const mxP = all.reduce((m, r) => Math.max(m, Number(r.p) || 0), 0);
      const mxI = all.reduce((m, r) => Math.max(m, parseInt(String(r.ci || '').replace(/\D/g, ''), 10) || 0), 0);
      const [id] = await nextIds('category', 1);
      addNew(plan, 'category', id, { category_name: name, vehicle_type: vt, category_priority: mxP + 1, cat_identifier: `${prefix}${mxI + 1}`, bw_enabled: true }, name, `New ${vt} category · id ${id}`);
      plan.label = `Add category "${name}"`;
      return;
    }

    if (entity === 'package_service') {
      const pid = positiveInt(v.package_details_id, 'Package'), sid = positiveInt(v.service_id, 'Service');
      const p = await mustExist('package', pid, 'Package'), s = await mustExist('service', sid, 'Service');
      const ex = await q(`SELECT 1 AS x FROM ${live('package_service')} WHERE ${idEq('package_details_id', '@p')} AND ${idEq('service_id', '@s')} LIMIT 1`, { p: String(pid), s: String(sid) });
      if (ex.length) throw new HttpError(400, `"${s.service_name}" is already in "${p.package_name}"`);
      const pr = await q(`SELECT IFNULL(MAX(SAFE_CAST(package_service_priority AS INT64)), 0) AS m FROM ${live('package_service')} WHERE ${idEq('package_details_id', '@p')}`, { p: String(pid) });
      const [id] = await nextIds('package_service', 1);
      addNew(plan, 'package_service', id, { package_details_id: pid, service_id: sid, package_service_priority: Number(pr[0].m) + 1 }, `${s.service_name}`, `Added to package "${p.package_name}"`);
      plan.label = `Add service "${s.service_name}" to package "${p.package_name}"`;
      return;
    }

    if (entity === 'package_image') {
      const pid = positiveInt(v.package_details_id, 'Package');
      const p = await mustExist('package', pid, 'Package');
      const path = clean('text', v.image_path, 'Image link');
      if (!/^https?:\/\//i.test(path)) throw new HttpError(400, 'The image link must start with https://');
      const [id] = await nextIds('package_image', 1);
      addNew(plan, 'package_image', id, { package_details_id: pid, image_path: path }, 'New image', `For package "${p.package_name}"`);
      plan.label = `Add image to package "${p.package_name}"`;
      return;
    }

    if (entity === 'category_image') {
      const cid = positiveInt(v.category_id, 'Category');
      const c = await mustExist('category', cid, 'Category');
      const url = clean('text', v.image_url, 'Image link');
      if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'The image link must start with https://');
      const ex = await q(`SELECT identifier AS i FROM ${live('category_image')} WHERE ${idEq('category_id', '@c')}`, { c: String(cid) });
      let ident = clean('text', v.identifier || '', 'Identifier');
      if (!ident) {
        const base = ex.map(r => String(r.i || '')).find(s => s.includes('$'));
        const prefix = base ? base.split('$')[0] : String(c.cat_identifier || `C${cid}`);
        const mx = ex.reduce((m, r) => Math.max(m, parseInt(String(r.i || '').split('$')[1], 10) || 0), 0);
        ident = `${prefix}$${mx + 1}`;
      }
      const [id] = await nextIds('category_image', 1);
      addNew(plan, 'category_image', id, { category_id: cid, identifier: ident, image_url: url }, 'New image', `For category "${c.category_name}"`);
      plan.label = `Add image to category "${c.category_name}"`;
      return;
    }

    if (entity === 'app_content') {
      const cid = positiveInt(v.config_id, 'Group');
      const g = await mustExist('app_config', cid, 'Group');
      const key = clean('text', v.resource_config_key, 'Name'), val = clean('text', v.resource_config_value, 'Value');
      if (!key) throw new HttpError(400, 'Enter a name');
      const [id] = await nextIds('app_content', 1);
      addNew(plan, 'app_content', id, { config_id: cid, resource_config_key: key, resource_config_value: val }, key, `New item in "${g.resource_config_name}"`);
      plan.label = `Add "${key}" to ${g.resource_config_name}`;
      return;
    }
    if (cfg.home === 'ctl') {
      const REQUIRED = {
        store_category: ['category_name'], store_product: ['product_name', 'store_category_id', 'selling_price'],
        store_product_image: ['store_product_id', 'image_url'], store_fitment: ['store_product_id', 'vehicle_master_id'],
        store_review: ['store_product_id', 'reviewer_name', 'rating'],
      }[entity] || [];
      const vals = {};
      for (const [f, kind] of Object.entries(cfg.fields)) {
        const raw = v[f];
        if (raw === undefined || raw === null || raw === '') continue;
        vals[f] = clean(kind, raw, label(f));
      }
      for (const f of REQUIRED) if (vals[f] === undefined || vals[f] === '') throw new HttpError(400, `Enter ${label(f)}`);
      if (vals.store_category_id !== undefined) await mustExist('store_category', vals.store_category_id, 'Store category');
      if (vals.store_product_id !== undefined) await mustExist('store_product', vals.store_product_id, 'Product');
      if (vals.vehicle_master_id !== undefined) await mustExist('vehicle_master', vals.vehicle_master_id, 'Vehicle');
      if (vals.rating !== undefined && (vals.rating < 1 || vals.rating > 5)) throw new HttpError(400, 'Rating must be 1 to 5');
      for (const m of ['mrp', 'selling_price', 'installation_price']) if (vals[m] !== undefined && (vals[m] < 0 || vals[m] > MAX_PRICE)) throw new HttpError(400, `${label(m)} is not valid`);
      if (vals.image_url !== undefined && !/^https?:\/\//i.test(vals.image_url)) throw new HttpError(400, 'The picture link must start with https://');
      if (entity === 'store_product') {
        if (vals.is_active === undefined) vals.is_active = false;
        if (vals.mrp !== undefined && vals.selling_price > vals.mrp) plan.warnings.push('The selling price is higher than the MRP.');
      }
      if (entity === 'store_category' && vals.is_active === undefined) vals.is_active = true;
      if (entity === 'store_review' && vals.is_approved === undefined) vals.is_approved = true;
      const col = PRIORITY[entity];
      if (col && vals[col] === undefined) {
        const parentCol = { store_product: 'store_category_id', store_product_image: 'store_product_id' }[entity];
        const pr = await q(`SELECT IFNULL(MAX(SAFE_CAST(${col} AS INT64)), 0) AS m FROM ${live(entity)}${parentCol ? ` WHERE ${idEq(parentCol, '@p')}` : ''}`,
          parentCol ? { p: String(vals[parentCol]) } : {});
        vals[col] = Number(pr[0].m) + 1;
      }
      const [id] = await nextIds(entity, 1);
      const title = vals[cfg.nameCol] || (entity === 'store_fitment' ? `Vehicle ${vals.vehicle_master_id}` : `New ${cfg.noun}`);
      addNew(plan, entity, id, vals, title, `New ${cfg.noun} · id ${id}`);
      plan.label = `Add ${cfg.noun} "${title}"`;
      return;
    }
    throw new HttpError(400, 'That cannot be added here');
  };

  function addVariant(plan, masterId, vid, x, vehicleName) {
    const fuel = clean('text', x.fuel_type, 'Fuel type').toUpperCase();
    const trans = clean('text', x.transmission_type, 'Transmission').toUpperCase();
    if (!fuel) throw new HttpError(400, 'Choose the fuel type of every variant');
    if (!trans) throw new HttpError(400, 'Choose the transmission of every variant');
    const from = clean('int', x.from_year, 'From year');
    const to = x.to_year === '' || x.to_year == null ? null : clean('int', x.to_year, 'To year');
    if (from < 1980 || from > 2100) throw new HttpError(400, 'From year is not valid');
    if (to !== null && (to < from || to > 2100)) throw new HttpError(400, '"To year" must be the same as or after "From year"');
    const name = clean('text', x.name || '', 'Variant name') || `${fuel} ${trans}`;
    addNew(plan, 'vehicle_variant', vid, { vehicle_master_id: masterId, name, fuel_type: fuel, transmission_type: trans, from_year: from, to_year: to }, `${name}`, `${vehicleName} · ${from}${to ? ' to ' + to : ' onwards'} · id ${vid}`);
  }

  B.remove = async (b, plan) => {
    const entity = b.entity;
    if (!REMOVABLE.has(entity)) throw new HttpError(400, 'This cannot be removed. Switch it off instead.');
    const cfg = REGISTRY[entity];
    const id = positiveInt(b.id, 'Item');
    const row = await mustExist(entity, id);
    let name = nameOf(entity, row, id), sub = '';
    if (entity === 'vehicle_master') {
      name = `${row.make} ${row.model}`;
      const nv = await q(`SELECT COUNT(*) AS n FROM ${live('vehicle_variant')} WHERE ${idEq('vehicle_master_id')}`, { id: String(id) });
      const cu = await countWhere(`SELECT COUNT(*) AS n FROM ${src('vehicles')} WHERE ${idEq('vehicle_master_id')}`, { id: String(id) });
      sub = `Also removes its ${nv[0].n} variant${Number(nv[0].n) === 1 ? '' : 's'}`;
      if (cu) plan.warnings.push(`${cu} customer vehicle${cu > 1 ? 's use' : ' uses'} this model. They stay in the app database, but the model will no longer be in the list.`);
    }
    if (entity === 'package_service') {
      const s = await getRow('service', row.service_id), p = await getRow('package', row.package_details_id);
      name = s ? s.service_name : `Service ${row.service_id}`; sub = p ? `Taken out of package "${p.package_name}"` : '';
    }
    addRemove(plan, entity, id, name, sub);
    plan.label = `Remove ${cfg.noun} "${name}"`;
  };

  B.moveService = async (b, plan) => {
    const psId = positiveInt(b.packageServiceId, 'Item');
    const to = positiveInt(b.toPackageId, 'Package');
    const row = await mustExist('package_service', psId);
    const s = await mustExist('service', row.service_id, 'Service');
    const from = await getRow('package', row.package_details_id);
    const dest = await mustExist('package', to, 'Package');
    if (Number(row.package_details_id) === to) throw new HttpError(400, 'It is already in that package');
    const ex = await q(`SELECT 1 AS x FROM ${live('package_service')} WHERE ${idEq('package_details_id', '@p')} AND ${idEq('service_id', '@s')} LIMIT 1`, { p: String(to), s: String(row.service_id) });
    if (ex.length) throw new HttpError(400, `"${s.service_name}" is already in "${dest.package_name}"`);
    const pr = await q(`SELECT IFNULL(MAX(SAFE_CAST(package_service_priority AS INT64)), 0) AS m FROM ${live('package_service')} WHERE ${idEq('package_details_id', '@p')}`, { p: String(to) });
    const [id] = await nextIds('package_service', 1);
    plan.rows.push({ entityType: 'package_service', entityId: String(psId), op: 'DELETE', field: 'row', oldValue: null, newValue: 'removed' });
    plan.rows.push({ entityType: 'package_service', entityId: String(id), op: 'ADD', field: 'row', oldValue: null, newValue: JSON.stringify({ package_service_id: id, package_details_id: to, service_id: Number(row.service_id), package_service_priority: Number(pr[0].m) + 1 }) });
    plan.items.push({ title: `Service: ${s.service_name}`, subtitle: 'Package', old: from ? from.package_name : String(row.package_details_id), new: dest.package_name, kind: 'text' });
    plan.label = `Move service "${s.service_name}" to package "${dest.package_name}"`;
  };

  // ----- prices and discounts (from v1) -----
  B.price = async (b, plan) => {
    const edits = Array.isArray(b.rows) ? b.rows : [];
    if (!edits.length) throw new HttpError(400, 'No price changes were sent');
    if (edits.length > 200) throw new HttpError(400, 'Change at most 200 prices at once');
    const wanted = new Map();
    for (const e of edits) {
      const id = positiveInt(e.ppgmId, 'Price row');
      const p = Number(e.newPrice);
      if (!Number.isFinite(p) || p < 1 || p > MAX_PRICE) throw new HttpError(400, `Price must be between 1 and ${MAX_PRICE.toLocaleString('en-IN')}`);
      wanted.set(id, round(p, 2));
    }
    const ids = [...wanted.keys()];
    const cur = await q(PPGM_SQL('CAST(l.ppgm_id AS INT64) IN UNNEST(@ids)'), { ids }, { ids: ['INT64'] });
    const byId = new Map(cur.map(r => [r.ppgm_id, r]));
    let jumps = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) throw new HttpError(404, `Price row ${id} was not found`);
      const np = wanted.get(id);
      if (r.cost !== null && Math.abs(r.cost - np) < 0.005) continue;
      if (r.cost && Math.abs(np - r.cost) / r.cost > WARN_PRICE_JUMP) jumps++;
      plan.rows.push({ entityType: 'ppgm', entityId: String(id), op: 'SET', field: 'cost_total', oldValue: r.cost === null ? null : String(r.cost), newValue: String(np) });
      plan.items.push({ title: `${r.package_name} · ${r.body_type}`, subtitle: r.product_name || '', old: r.cost, new: np, kind: 'money' });
    }
    if (!plan.rows.length) throw new HttpError(400, 'Those prices are already the current prices');
    if (jumps) plan.warnings.push(`${jumps} price${jumps > 1 ? 's' : ''} change by more than ${WARN_PRICE_JUMP * 100}%.`);
    const pkgs = [...new Set(plan.items.map(i => i.title.split(' · ')[0]))];
    plan.label = `Price change: ${plan.rows.length} price${plan.rows.length > 1 ? 's' : ''} on ${pkgs.length === 1 ? `"${pkgs[0]}"` : `${pkgs.length} packages`}`;
  };

  B.discount = async (b, plan) => {
    const percent = Number(b.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > MAX_DISCOUNT_PERCENT) throw new HttpError(400, `Discount must be between 0 and ${MAX_DISCOUNT_PERCENT}%`);
    const pct = round(percent, 2), value = round(pct / 100, 4);
    const id = positiveInt(b.id, 'Item');
    let where, scopeName;
    if (b.scope === 'package') where = 'CAST(pg.package_details_id AS INT64) = @id';
    else if (b.scope === 'category') where = 'CAST(pd.category_id AS INT64) = @id';
    else if (b.scope === 'ppgm') where = 'CAST(l.ppgm_id AS INT64) = @id';
    else throw new HttpError(400, 'Choose where the discount applies: package, category or price row');
    const cur = await q(PPGM_SQL(where), { id });
    if (!cur.length) throw new HttpError(404, 'No price rows were found for that selection. Packages priced by quotation (MBF) have no fixed price to discount.');
    if (cur.length > MAX_ROWS) throw new HttpError(400, `That selection has more than ${MAX_ROWS} price rows. Pick a smaller group.`);
    if (b.scope === 'category') {
      const c = await getRow('category', id);
      scopeName = c ? `category "${c.category_name}"` : `category ${id}`;
    } else if (b.scope === 'package') scopeName = `"${cur[0].package_name}"`;
    else scopeName = `price row ${id}`;
    for (const r of cur) {
      if (r.discount !== null && Math.abs(r.discount - value) < 0.00005) continue;
      plan.rows.push({ entityType: 'ppgm', entityId: String(r.ppgm_id), op: 'SET', field: 'discount_total', oldValue: r.discount === null ? null : String(r.discount), newValue: String(value) });
      plan.items.push({ title: `${r.package_name} · ${r.body_type}`, subtitle: r.product_name || '', old: r.discount === null ? null : round(r.discount * 100, 2), new: pct, kind: 'percent', price: r.cost });
    }
    if (!plan.rows.length) throw new HttpError(400, `The discount is already ${pct}% for this selection`);
    if (pct > WARN_DISCOUNT_PERCENT) plan.warnings.push(`A discount of ${pct}% is very high.`);
    if (plan.rows.length > 200) plan.warnings.push(`This changes ${plan.rows.length} price rows.`);
    plan.label = `Discount ${pct}% on ${scopeName} (${plan.rows.length} price row${plan.rows.length > 1 ? 's' : ''})`;
  };

  // ----- MBF (quotation) to BWBP (fixed price) -----
  B.convert = async (b, plan) => {
    const pid = positiveInt(b.packageId, 'Package');
    const pkg = await mustExist('package', pid, 'Package');
    if (String(pkg.price_type).toUpperCase() === 'BWBP') throw new HttpError(400, 'This package already has fixed prices. Use the Prices screen to change them.');
    const prices = Array.isArray(b.prices) ? b.prices : [];
    if (!prices.length) throw new HttpError(400, 'Enter at least one price');
    if (prices.length > 400) throw new HttpError(400, 'Too many prices at once');
    const disc = b.discountPercent === undefined || b.discountPercent === '' ? 0 : Number(b.discountPercent);
    if (!Number.isFinite(disc) || disc < 0 || disc > MAX_DISCOUNT_PERCENT) throw new HttpError(400, `Discount must be between 0 and ${MAX_DISCOUNT_PERCENT}%`);
    const discVal = round(disc / 100, 4);

    // options (product_details) of this package
    const opts = await q(`SELECT CAST(product_details_id AS INT64) AS id, product_name AS name FROM ${live('product_detail')} WHERE ${idEq('package_details_id', '@p')}`, { p: String(pid) });
    const optById = new Map(opts.map(o => [o.id, o]));
    const groups = await q(`SELECT CAST(price_group_id AS INT64) AS id, CAST(price_reference_id AS STRING) AS bt FROM ${live('price_group')} WHERE ${idEq('package_details_id', '@p')}`, { p: String(pid) });
    const groupByBt = new Map(groups.map(g => [String(g.bt).toUpperCase(), g.id]));
    const existing = await q(PPGM_SQL('CAST(pg.package_details_id AS INT64) = @p'), { p: pid });
    const exKey = new Map(existing.map(r => [`${String(r.body_type).toUpperCase()}|${r.product_name}`, r]));

    // which price groups / options must be created
    const wantBt = [...new Set(prices.map(x => clean('text', x.bodyType, 'Vehicle type').toUpperCase()))];
    if (wantBt.some(x => !x)) throw new HttpError(400, 'Every price needs a vehicle type');
    const newBt = wantBt.filter(bt => !groupByBt.has(bt));
    const needDefaultOption = !opts.length;
    const pgIds = await nextIds('price_group', newBt.length);
    newBt.forEach((bt, i) => { groupByBt.set(bt, pgIds[i]); });
    let defaultOptId = null;
    if (needDefaultOption) {
      [defaultOptId] = await nextIds('product_detail', 1);
      addNew(plan, 'product_detail', defaultOptId, { package_details_id: pid, product_name: pkg.package_name, pricing_level: 'PACKAGE' }, `Option: ${pkg.package_name}`, 'Created because this package had no option yet');
      optById.set(defaultOptId, { id: defaultOptId, name: pkg.package_name });
    }
    newBt.forEach((bt, i) => addNew(plan, 'price_group', pgIds[i], { package_details_id: pid, price_reference: 'BODYTYPE_MAPPED', price_reference_id: bt }, `Price group: ${bt}`, `For package "${pkg.package_name}"`));

    const toAdd = [];
    const seen = new Set();
    for (const x of prices) {
      const bt = String(x.bodyType).trim().toUpperCase();
      const price = Number(x.price);
      if (!Number.isFinite(price) || price < 1 || price > MAX_PRICE) throw new HttpError(400, `Price must be between 1 and ${MAX_PRICE.toLocaleString('en-IN')}`);
      const optId = x.productId ? positiveInt(x.productId, 'Option') : (defaultOptId || (opts.length === 1 ? opts[0].id : null));
      if (!optId || !optById.has(optId)) throw new HttpError(400, 'Choose which option each price is for');
      const key = `${bt}|${optId}`;
      if (seen.has(key)) throw new HttpError(400, `${bt} has two prices for the same option`);
      seen.add(key);
      toAdd.push({ bt, optId, price: round(price, 2), group: groupByBt.get(bt) });
    }
    const ppIds = await nextIds('ppgm', toAdd.length);
    const today = new Date(), end = new Date(today); end.setUTCFullYear(end.getUTCFullYear() + 10);
    const iso = d => d.toISOString().slice(0, 10);
    toAdd.forEach((t, i) => {
      const opt = optById.get(t.optId);
      const was = exKey.get(`${t.bt}|${opt.name}`);
      if (was) throw new HttpError(400, `${t.bt} already has a price for "${opt.name}". Use the Prices screen to change it.`);
      addNew(plan, 'ppgm', ppIds[i], {
        price_group_id: t.group, product_details_id: t.optId, cost_total: t.price, discount_total: discVal,
        is_active: true, is_recommanded: false, valid_from: iso(today), valid_to: iso(end),
      }, `${t.bt} · ${opt.name}`, `Price ₹${t.price.toLocaleString('en-IN')} · discount ${disc}%`);
    });
    // finally switch the package over
    await addSet(plan, 'package', pid, { price_type: 'BWBP', price_reference: 'BODYTYPE_MAPPED' }, pkg);
    plan.warnings.push(`"${pkg.package_name}" will change from quotation (MBF) to a fixed price (BWBP). Vehicle types you do not give a price for will have no price.`);
    plan.label = `Change "${pkg.package_name}" from MBF to BWBP with ${toAdd.length} price${toAdd.length > 1 ? 's' : ''}`;
  };

  // ----- one-line helpers for the new builders -----
  function pushSet(plan, entity, id, field, oldV, newV, title, subtitle, kind) {
    plan.rows.push({ entityType: entity, entityId: String(id), op: 'SET', field, oldValue: oldV == null ? null : String(oldV), newValue: String(newV) });
    plan.items.push({ title, subtitle, old: oldV, new: newV, kind });
  }
  const sameNum = (a, b) => a !== null && a !== undefined && a !== '' && Math.abs(Number(a) - Number(b)) < 0.005;
  const optMoney = (v, what) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) throw new HttpError(400, `${what} must be between 0 and ${MAX_PRICE.toLocaleString('en-IN')}`);
    return round(n, 2);
  };
  async function vehiclesUsing(r) {
    if (r.price_reference === 'VEHICLE_MAPPED') return 1;
    return countWhere(`SELECT COUNT(*) AS n FROM ${live('vehicle_master')} WHERE UPPER(CAST(body_type AS STRING)) = UPPER(@b)`, { b: String(r.body_type) });
  }

  // ----- price of each service inside one price row -----
  B.service_prices = async (b, plan) => {
    const ppgmId = positiveInt(b.ppgmId, 'Price row');
    const cur = await q(PPGM_SQL('CAST(l.ppgm_id AS INT64) = @id'), { id: ppgmId });
    if (!cur.length) throw new HttpError(404, 'Price row not found');
    const r = cur[0];
    const svcs = await q(`SELECT CAST(ps.service_id AS INT64) AS sid, s.service_name AS name
      FROM ${live('package_service')} ps LEFT JOIN ${live('service')} s ON CAST(s.service_id AS INT64) = CAST(ps.service_id AS INT64)
      WHERE ${idEq('ps.package_details_id', '@p')}`, { p: String(r.package_id) });
    const nameOf_ = new Map(svcs.map(x => [x.sid, x.name || `Service ${x.sid}`]));
    const have = await q(`SELECT CAST(service_price_id AS INT64) AS id, CAST(service_id AS INT64) AS sid,
      SAFE_CAST(parts_price AS FLOAT64) AS parts, SAFE_CAST(labour_price AS FLOAT64) AS labour
      FROM ${live('service_price')} WHERE ${idEq('ppgm_id', '@p')}`, { p: String(ppgmId) });
    const bySid = new Map(have.map(x => [x.sid, x]));
    const lines = Array.isArray(b.lines) ? b.lines : [];
    const final = new Map(have.map(x => [x.sid, { parts: x.parts, labour: x.labour }]));
    const toAdd = [];
    for (const ln of lines) {
      const sid = positiveInt(ln.serviceId, 'Service');
      if (!nameOf_.has(sid)) throw new HttpError(400, `Service ${sid} is not in this package`);
      const parts = optMoney(ln.parts, 'Parts price'), labour = optMoney(ln.labour, 'Labour price');
      const ex = bySid.get(sid);
      const title = `${nameOf_.get(sid)} (service_id ${sid})`;
      if (ex) {
        if (parts !== null && !sameNum(ex.parts, parts)) pushSet(plan, 'service_price', ex.id, 'parts_price', ex.parts, parts, title, 'parts_price', 'money');
        if (labour !== null && !sameNum(ex.labour, labour)) pushSet(plan, 'service_price', ex.id, 'labour_price', ex.labour, labour, title, 'labour_price', 'money');
        final.set(sid, { parts: parts ?? ex.parts, labour: labour ?? ex.labour });
      } else if (parts !== null || labour !== null) {
        toAdd.push({ sid, parts, labour, title });
        final.set(sid, { parts, labour });
      }
    }
    const ids = await nextIds('service_price', toAdd.length);
    toAdd.forEach((t, i) => {
      plan.rows.push({ entityType: 'service_price', entityId: String(ids[i]), op: 'ADD', field: 'row', oldValue: null,
        newValue: JSON.stringify({ service_price_id: ids[i], ppgm_id: ppgmId, service_id: t.sid, parts_price: t.parts, labour_price: t.labour }) });
      plan.items.push({ title: t.title, subtitle: `parts_price ${t.parts ?? 0} + labour_price ${t.labour ?? 0}`, kind: 'add' });
    });
    if (b.setPackagePrice) {
      const missing = svcs.filter(x => { const f = final.get(x.sid); return !f || (f.parts == null && f.labour == null); });
      if (missing.length) throw new HttpError(400, `Give a price to every service first. Missing: ${missing.map(x => x.name).slice(0, 5).join(', ')}`);
      const total = round(svcs.reduce((a, x) => a + (Number(final.get(x.sid).parts) || 0) + (Number(final.get(x.sid).labour) || 0), 0), 2);
      if (total < 1) throw new HttpError(400, 'The total of the services must be at least 1');
      if (!sameNum(r.cost, total)) pushSet(plan, 'ppgm', ppgmId, 'cost_total', r.cost, total, `Package price: ${r.package_name}`, `cost_total = total of the services`, 'money');
    }
    if (!plan.rows.length) throw new HttpError(400, 'Nothing was changed');
    const n = await vehiclesUsing(r);
    if (n > 1 && plan.rows.some(x => x.entityType === 'ppgm')) plan.warnings.push(`This price (ppgm_id ${ppgmId}) is used by ${n} vehicles of body type ${r.body_type}. All of them get the new price.`);
    plan.label = `Service prices for "${r.package_name}" · ${r.body_type}${r.product_name ? ' · ' + r.product_name : ''}`;
  };

  // ----- a separate price for one vehicle + fuel -----
  B.vehicle_price = async (b, plan) => {
    const pid = positiveInt(b.packageId, 'Package'), mid = positiveInt(b.vehicleMasterId, 'Vehicle');
    const fuel = String(b.fuelType || '').trim().toUpperCase().slice(0, 30);
    const pkg = await mustExist('package', pid, 'Package');
    if (String(pkg.price_type).toUpperCase() !== 'BWBP') throw new HttpError(400, 'This package has no fixed prices yet. Use "Set fixed prices" first.');
    const veh = await mustExist('vehicle_master', mid, 'Vehicle');
    const vname = `${veh.make} ${veh.model}${fuel ? ' ' + fuel : ''}`;
    const prices = Array.isArray(b.prices) ? b.prices : [];
    const disc = b.discountPercent === undefined || b.discountPercent === '' || b.discountPercent === null ? null : Number(b.discountPercent);
    if (disc !== null && (!Number.isFinite(disc) || disc < 0 || disc > MAX_DISCOUNT_PERCENT)) throw new HttpError(400, `Discount must be between 0 and ${MAX_DISCOUNT_PERCENT}%`);
    const want = new Map();
    for (const x of prices) {
      if (x.price === '' || x.price === null || x.price === undefined) continue;
      const p = Number(x.price);
      if (!Number.isFinite(p) || p < 1 || p > MAX_PRICE) throw new HttpError(400, `Price must be between 1 and ${MAX_PRICE.toLocaleString('en-IN')}`);
      want.set(positiveInt(x.productId, 'Option'), round(p, 2));
    }
    if (!want.size && disc === null) throw new HttpError(400, 'Enter a price');
    const opts = await q(`SELECT CAST(product_details_id AS INT64) AS id, product_name AS name FROM ${live('product_detail')} WHERE ${idEq('package_details_id', '@p')}`, { p: String(pid) });
    const optName = new Map(opts.map(o => [o.id, o.name]));
    for (const id of want.keys()) if (!optName.has(id)) throw new HttpError(400, `Option ${id} is not part of this package`);
    const cur = await vehiclePriceRows(pid, { vehicleMasterId: mid, fuel });
    const curByOpt = new Map(cur.filter(x => x.fuel_type === fuel && x.product_details_id).map(x => [x.product_details_id, x]));
    const own = await q(`SELECT CAST(price_group_id AS INT64) AS id FROM ${live('price_group')}
      WHERE ${idEq('package_details_id', '@p')} AND UPPER(CAST(price_reference AS STRING)) = 'VEHICLE_MAPPED'
        AND SAFE_CAST(SAFE_CAST(CAST(price_reference_id AS STRING) AS FLOAT64) AS INT64) = @m
        AND IFNULL(UPPER(CAST(fuel_type AS STRING)), '') = @f LIMIT 1`, { p: String(pid), m: mid, f: fuel });
    const dval = disc === null ? null : round(disc / 100, 4);
    if (own.length) {
      const gid = own[0].id;
      const rows = await q(PPGM_SQL('CAST(l.price_group_id AS INT64) = @g'), { g: gid });
      const byOpt = new Map(rows.map(x => [x.product_details_id, x]));
      const adds = [];
      for (const o of opts) {
        const ex = byOpt.get(o.id), np = want.get(o.id);
        const t = `${vname} · ${o.name}`;
        if (ex) {
          if (np !== undefined && !sameNum(ex.cost, np)) pushSet(plan, 'ppgm', ex.ppgm_id, 'cost_total', ex.cost, np, t, 'cost_total', 'money');
          if (dval !== null && !sameNum(ex.discount, dval)) pushSet(plan, 'ppgm', ex.ppgm_id, 'discount_total', ex.discount, dval, t, 'discount_total', 'text');
        } else if (np !== undefined) adds.push({ gid, o, price: np, d: dval ?? (curByOpt.get(o.id)?.discount_total ?? 0) });
      }
      await addPrices(plan, adds, vname);
    } else {
      const [gid] = await nextIds('price_group', 1);
      addNew(plan, 'price_group', gid, { package_details_id: pid, price_reference: 'VEHICLE_MAPPED', price_reference_id: String(mid), fuel_type: fuel || null },
        `Own price group for ${vname}`, `price_reference VEHICLE_MAPPED · price_reference_id ${mid}${fuel ? ' · fuel_type ' + fuel : ''}`);
      const adds = [];
      for (const o of opts) {
        const c = curByOpt.get(o.id);
        const price = want.has(o.id) ? want.get(o.id) : (c && c.cost_total != null ? c.cost_total : null);
        if (price === null) { plan.warnings.push(`"${o.name}" has no price for ${vname}, so it will not be sold for this vehicle.`); continue; }
        adds.push({ gid, o, price, d: dval ?? (c && c.discount_total != null ? c.discount_total : 0) });
      }
      if (!adds.length) throw new HttpError(400, 'Enter a price');
      await addPrices(plan, adds, vname);
      const bt = String(veh.body_type || '');
      plan.warnings.push(`${vname} gets its own price. Other ${bt} vehicles keep the body type price.`);
    }
    if (!plan.rows.length) throw new HttpError(400, 'Those are already the prices');
    plan.label = `Price for ${vname}: "${pkg.package_name}"`;
  };
  async function addPrices(plan, adds, vname) {
    const ids = await nextIds('ppgm', adds.length);
    const today = new Date(), end = new Date(today); end.setUTCFullYear(end.getUTCFullYear() + 10);
    const iso = d => d.toISOString().slice(0, 10);
    adds.forEach((a, i) => addNew(plan, 'ppgm', ids[i], {
      price_group_id: a.gid, product_details_id: a.o.id, cost_total: a.price, discount_total: a.d,
      is_active: true, is_recommanded: false, valid_from: iso(today), valid_to: iso(end),
    }, `${vname} · ${a.o.name}`, `cost_total ₹${a.price.toLocaleString('en-IN')} · discount ${round(a.d * 100, 2)}%`));
  }

  // which price each vehicle + fuel gets for a package (same rules as the app: own vehicle price first, then body type)
  async function vehiclePriceRows(pid, f = {}) {
    const where = [];
    const params = { pid };
    if (f.vehicleMasterId) { where.push('v.vmid = @mid'); params.mid = f.vehicleMasterId; }
    if (f.term) { where.push(`(LOWER(CONCAT(IFNULL(v.make,''), ' ', IFNULL(v.model,''))) LIKE CONCAT('%', LOWER(@term), '%') OR CAST(v.vmid AS STRING) = @term)`); params.term = f.term; }
    if (f.bodyType) { where.push('v.body_type = @bt'); params.bt = String(f.bodyType).toUpperCase(); }
    if (f.fuelFilter) { where.push('v.fuel = @ff'); params.ff = String(f.fuelFilter).toUpperCase(); }
    return q(`
      WITH pkgvt AS (
        SELECT UPPER(CAST(c.vehicle_type AS STRING)) AS vt FROM ${live('package')} p
        JOIN ${live('category')} c ON CAST(c.category_id AS INT64) = CAST(p.category_id AS INT64)
        WHERE CAST(p.package_details_id AS INT64) = @pid),
      vm AS (
        SELECT CAST(vehicle_master_id AS INT64) AS vmid, make, model, UPPER(CAST(body_type AS STRING)) AS body_type
        FROM ${live('vehicle_master')} WHERE UPPER(CAST(vehicle_type AS STRING)) IN (SELECT vt FROM pkgvt)),
      vf AS (
        SELECT DISTINCT CAST(vehicle_master_id AS INT64) AS vmid, UPPER(CAST(fuel_type AS STRING)) AS fuel
        FROM ${live('vehicle_variant')} WHERE fuel_type IS NOT NULL),
      v AS (SELECT vm.*, IFNULL(vf.fuel, '') AS fuel FROM vm LEFT JOIN vf USING (vmid)),
      pg AS (
        SELECT CAST(price_group_id AS INT64) AS gid, UPPER(CAST(price_reference AS STRING)) AS ref,
               UPPER(TRIM(CAST(price_reference_id AS STRING))) AS refid, IFNULL(UPPER(CAST(fuel_type AS STRING)), '') AS gfuel
        FROM ${live('price_group')} WHERE CAST(package_details_id AS INT64) = @pid),
      pm AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT CAST(ppgm_id AS INT64) AS ppgm_id, CAST(price_group_id AS INT64) AS gid, CAST(product_details_id AS INT64) AS prod,
                 SAFE_CAST(cost_total AS FLOAT64) AS cost, SAFE_CAST(discount_total AS FLOAT64) AS disc,
                 ROW_NUMBER() OVER (PARTITION BY CAST(price_group_id AS INT64), CAST(product_details_id AS INT64) ORDER BY CAST(ppgm_id AS INT64) DESC) AS rn
          FROM ${live('ppgm')} WHERE ${isOn('is_active')}) WHERE rn = 1),
      cand AS (
        SELECT v.vmid, v.fuel, pg.gid, pg.ref, pg.refid, pg.gfuel,
               CASE WHEN pg.ref = 'VEHICLE_MAPPED' THEN IF(pg.gfuel = v.fuel, 1, 2) ELSE IF(pg.gfuel = v.fuel, 3, 4) END AS rk
        FROM v JOIN pg ON (
              (pg.ref = 'VEHICLE_MAPPED' AND SAFE_CAST(SAFE_CAST(pg.refid AS FLOAT64) AS INT64) = v.vmid)
           OR (pg.ref = 'BODYTYPE_MAPPED' AND pg.refid = v.body_type))
         AND (pg.gfuel = '' OR pg.gfuel = v.fuel)),
      best AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT c.*, pm.ppgm_id, pm.prod, pm.cost, pm.disc,
                 ROW_NUMBER() OVER (PARTITION BY c.vmid, c.fuel, pm.prod ORDER BY c.rk, c.gid DESC) AS rn
          FROM cand c JOIN pm ON pm.gid = c.gid) WHERE rn = 1)
      SELECT v.vmid AS vehicle_master_id, TRIM(CONCAT(IFNULL(v.make,''), ' ', IFNULL(v.model,''))) AS vehicle_name,
             v.body_type AS body_type, v.fuel AS fuel_type, b.prod AS product_details_id, b.ppgm_id AS ppgm_id,
             b.cost AS cost_total, b.disc AS discount_total, b.ref AS price_reference, b.refid AS price_reference_id, b.gid AS price_group_id
      FROM v LEFT JOIN best b ON b.vmid = v.vmid AND b.fuel = v.fuel
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY vehicle_name, v.vmid, fuel_type, product_details_id
      LIMIT 1500`, params);
  }

  // ----- price settings (GST, pickup and drop, convenience fee) -----
  B.settings = async (b, plan) => {
    const items = Array.isArray(b.items) ? b.items : [];
    const have = await q(`SELECT CAST(price_setting_id AS INT64) AS id, setting_key AS k, IFNULL(UPPER(CAST(vehicle_type AS STRING)), '') AS vt, setting_value AS v FROM ${live('price_setting')}`);
    const byKey = new Map(have.map(x => [`${x.k}|${x.vt}`, x]));
    const adds = [];
    for (const it of items) {
      const k = String(it.key || '');
      if (!(k in SETTING_DEFAULTS)) throw new HttpError(400, `Unknown setting ${k}`);
      const vt = PER_VEHICLE_SETTING.has(k) ? String(it.vehicleType || '').toUpperCase() : '';
      if (PER_VEHICLE_SETTING.has(k) && !['CAR', 'BIKE'].includes(vt)) throw new HttpError(400, `${k} needs CAR or BIKE`);
      let v = String(it.value ?? '').trim().toUpperCase();
      if (['gst_percent', 'pickup_drop_fee', 'convenience_fee'].includes(k)) {
        const n = Number(v);
        if (v === '' || !Number.isFinite(n) || n < 0 || n > (k === 'gst_percent' ? 50 : 100000)) throw new HttpError(400, `${label(k)} is not valid`);
        v = String(round(n, 2));
      } else if (!['YES', 'NO'].includes(v)) throw new HttpError(400, `${label(k)} must be YES or NO`);
      const ex = byKey.get(`${k}|${vt}`);
      const title = `${k}${vt ? ' (' + vt + ')' : ''}`;
      if (ex) { if (String(ex.v) !== v) pushSet(plan, 'price_setting', ex.id, 'setting_value', ex.v, v, title, 'setting_value', 'text'); }
      else adds.push({ k, vt, v, title });
    }
    const ids = await nextIds('price_setting', adds.length);
    adds.forEach((a, i) => {
      plan.rows.push({ entityType: 'price_setting', entityId: String(ids[i]), op: 'ADD', field: 'row', oldValue: null,
        newValue: JSON.stringify({ price_setting_id: ids[i], setting_key: a.k, vehicle_type: a.vt || null, setting_value: a.v }) });
      plan.items.push({ title: a.title, subtitle: '', old: SETTING_DEFAULTS[a.k] + ' (default)', new: a.v, kind: 'text' });
    });
    if (!plan.rows.length) throw new HttpError(400, 'Those are already the settings');
    plan.label = 'Change price settings (GST and fees)';
  };

  async function buildPlan(b) {
    const plan = newPlan(b);
    const fn = { rename: B.rename, edit: B.edit, toggle: B.toggle, order: B.order, move: B.move, create: B.create, remove: B.remove,
      move_service: B.moveService, price: B.price, discount: B.discount, convert: B.convert,
      service_prices: B.service_prices, vehicle_price: B.vehicle_price, settings: B.settings }[b.type];
    if (!fn) throw new HttpError(400, 'Unknown change type');
    await fn(b, plan);
    if (!plan.rows.length) throw new HttpError(400, 'Nothing to change');
    if (plan.rows.length > MAX_ROWS) throw new HttpError(400, `That changes more than ${MAX_ROWS} rows. Pick a smaller group.`);
    return plan;
  }

  return { buildPlan, PPGM_SQL, getRow, isOn, live, MAX_ROWS, vehiclePriceRows, vehiclesUsing };
}

export { makePlans, ENABLE_FIELD, REMOVABLE, CREATABLE, isOn, SETTING_DEFAULTS, PER_VEHICLE_SETTING };
