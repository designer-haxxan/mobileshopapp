// JSON backup export, validation and restore (replace or merge). Never includes credentials.
import * as idb from '../db/idb.js';
import { DATA_STORES, SYSTEM_ACCOUNTS, LEGACY_DB_NAME } from '../db/schema.js';
import { CONFIG } from '../config.js';
import { getSettings, replaceSettings } from '../core/settings.js';
import { nowISO, round3, uuid, AppError } from '../core/utils.js';
import * as Auth from './auth.js';
import * as Catalog from './catalog.js';

export const FORMAT = 'mobishop-pos-backup';
const ACCEPTED_FORMATS = [FORMAT, 'saleapp-pos-backup'];

// Required fields per collection (id/key checked separately).
const REQUIRED = {
  products: ['name'], customers: ['name'], suppliers: ['name'], accounts: ['name', 'type'], categories: ['name'],
  sales: ['number', 'date', 'total'], saleItems: ['saleId', 'qty'], purchases: ['number', 'date', 'total'], purchaseItems: ['purchaseId', 'qty'],
  saleReturns: ['number', 'date', 'saleId', 'items'], purchaseReturns: ['number', 'date', 'purchaseId', 'items'], vouchers: ['number', 'date', 'amount'],
  entries: ['txnId', 'accountId', 'date', 'debit', 'credit'], stockMoves: ['productId', 'date', 'qty', 'refId'], adjustments: ['number', 'date', 'items'],
  devices: ['imei1', 'brand', 'status'], repairs: ['number', 'date', 'status'], services: ['number', 'date', 'amount'],
};
const DOC_STORES = { sales: ['saleItems', 'saleId'], purchases: ['purchaseItems', 'purchaseId'], saleReturns: null, purchaseReturns: null, vouchers: null, adjustments: null, repairs: null, services: null };
const NUMBERED = ['sales', 'purchases', 'saleReturns', 'purchaseReturns', 'vouchers', 'adjustments', 'repairs', 'services'];

async function sha256(text) {
  if (!crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createBackup() {
  Auth.require('backup.export');
  const data = await idb.read(DATA_STORES, async (t) => {
    const out = {};
    for (const s of DATA_STORES) out[s] = await t.getAll(s);
    return out;
  });
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  const u = Auth.user();
  return {
    format: FORMAT, backupVersion: CONFIG.BACKUP_VERSION, appVersion: CONFIG.APP_VERSION, schemaVersion: CONFIG.SCHEMA_VERSION,
    createdAt: nowISO(), createdBy: u ? { name: u.name } : null, deviceId: Auth.deviceId(),
    counts, checksum: await sha256(JSON.stringify(data)), settings: getSettings(), data,
  };
}

export function validateBackup(obj) {
  const errors = []; const warnings = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['The file is not a valid JSON object.'], warnings };
  if (!ACCEPTED_FORMATS.includes(obj.format)) errors.push('This file is not a MobiShop POS backup.');
  if (!Number.isInteger(obj.backupVersion)) errors.push('Missing backup version.');
  else if (obj.backupVersion > CONFIG.BACKUP_VERSION) errors.push(`This backup was made by a newer app version (backup v${obj.backupVersion}). Update the app first.`);
  if (obj.schemaVersion > CONFIG.SCHEMA_VERSION) errors.push(`Unsupported database schema version ${obj.schemaVersion}.`);
  if (!obj.data || typeof obj.data !== 'object') errors.push('Backup contains no data section.');
  if (errors.length) return { ok: false, errors, warnings };
  const counts = {};
  for (const store of DATA_STORES) {
    const list = obj.data[store];
    if (list === undefined) { warnings.push(`Collection "${store}" is missing (treated as empty).`); counts[store] = 0; continue; }
    if (!Array.isArray(list)) { errors.push(`Collection "${store}" is not a list.`); continue; }
    counts[store] = list.length;
    const keyField = store === 'meta' ? 'key' : 'id';
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r !== 'object' || typeof r[keyField] !== 'string' || !r[keyField]) { errors.push(`${store}[${i}] has no valid ${keyField}.`); break; }
      if (seen.has(r[keyField])) { errors.push(`${store} contains a duplicate record ${r[keyField]}.`); break; }
      seen.add(r[keyField]);
      const miss = (REQUIRED[store] || []).find((f) => r[f] === undefined || r[f] === null);
      if (miss) { errors.push(`${store} record ${r[keyField]} is missing "${miss}".`); break; }
    }
    if (NUMBERED.includes(store)) {
      const nums = new Set();
      for (const r of list) { if (nums.has(r.number)) { errors.push(`${store} contains duplicate number ${r.number}.`); break; } nums.add(r.number); }
    }
    if (obj.counts && obj.counts[store] !== undefined && obj.counts[store] !== list.length) errors.push(`Record count mismatch in ${store} (expected ${obj.counts[store]}, found ${list.length}). The file may be truncated.`);
  }
  if (!errors.length && Array.isArray(obj.data.entries)) {
    const byTxn = {};
    for (const e of obj.data.entries) { const b = byTxn[e.txnId] || (byTxn[e.txnId] = [0, 0]); b[0] += e.debit; b[1] += e.credit; }
    const bad = Object.entries(byTxn).filter(([, [d, c]]) => Math.abs(d - c) > 0.01);
    if (bad.length) warnings.push(`${bad.length} ledger transaction(s) in the backup are unbalanced.`);
  }
  return { ok: !errors.length, errors, warnings, counts, createdAt: obj.createdAt, appVersion: obj.appVersion, createdBy: obj.createdBy };
}

export async function verifyChecksum(obj) {
  if (!obj.checksum) return null;
  const h = await sha256(JSON.stringify(obj.data));
  return h === null ? null : h === obj.checksum;
}

async function recomputeStock(t) {
  const sums = {};
  for (const m of await t.getAll('stockMoves')) sums[m.productId] = round3((sums[m.productId] || 0) + m.qty);
  for (const p of await t.getAll('products')) {
    const s = p.trackStock === false ? 0 : (sums[p.id] || 0);
    if (p.stock !== s) { p.stock = s; await t.put('products', p); }
  }
}
async function ensureSystemAccounts(t) {
  for (const a of SYSTEM_ACCOUNTS) {
    if (!(await t.get('accounts', a.id))) await t.put('accounts', { ...a, system: true, active: 1, createdAt: nowISO(), updatedAt: nowISO() });
  }
}

const stamp = (r) => r.updatedAt || r.voidedAt || r.createdAt || '';

export async function restore(obj, mode, { includeSettings = true } = {}) {
  Auth.require('backup.restore');
  const v = validateBackup(obj);
  if (!v.ok) throw new AppError('Backup is invalid: ' + v.errors[0]);
  const data = Object.fromEntries(DATA_STORES.map((s) => [s, obj.data[s] || []]));
  const report = { mode, added: 0, updated: 0, skipped: 0, conflicts: [] };

  await idb.write(DATA_STORES, async (t) => {
    if (mode === 'replace') {
      for (const s of DATA_STORES) await t.clear(s);
      for (const s of DATA_STORES) for (const r of data[s]) { await t.put(s, r); report.added++; }
    } else {
      // --- merge: documents are merged as a unit together with their lines, entries and stock moves ---
      const useBackup = new Map(); // parent key -> boolean
      const decide = async (store, r) => {
        const local = await t.get(store, r.id);
        if (NUMBERED.includes(store)) {
          const same = await t.getByIndex(store, 'number', r.number);
          if (same && same.id !== r.id) { report.conflicts.push(`${r.number}: a different document with this number exists locally`); return false; }
        }
        if (!local) { report.added++; return true; }
        if (stamp(r) > stamp(local)) { report.updated++; return true; }
        report.skipped++; return false;
      };
      for (const store of [...NUMBERED, 'devices', 'products', 'customers', 'suppliers', 'accounts']) {
        for (const r of data[store]) {
          const ok = await decide(store, r);
          useBackup.set(store + ':' + r.id, ok);
          if (ok) await t.put(store, r);
        }
      }
      const docParent = new Map();
      for (const s of NUMBERED) for (const r of data[s]) docParent.set(r.id, s + ':' + r.id);
      const entryParent = (e) => {
        if (e.txnId.startsWith('open:C:')) return 'customers:' + e.txnId.slice(7);
        if (e.txnId.startsWith('open:S:')) return 'suppliers:' + e.txnId.slice(7);
        if (e.txnId.startsWith('open:')) return 'accounts:' + e.txnId.slice(5);
        return docParent.get(e.txnId) || docParent.get(e.txnId.split(':')[0]);
      };
      const moveParent = (m) => (m.refId.startsWith('open:') ? 'products:' + m.refId.slice(5) : docParent.get(m.refId));
      // Replace children of every parent taken from the backup.
      for (const [key, ok] of useBackup) {
        if (!ok) continue;
        const [store, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        if (store === 'customers' || store === 'suppliers') await t.deleteByIndex('entries', 'txnId', `open:${store === 'customers' ? 'C' : 'S'}:${id}`);
        else if (store === 'accounts') await t.deleteByIndex('entries', 'txnId', 'open:' + id);
        else if (store === 'products') await t.deleteByIndex('stockMoves', 'refId', 'open:' + id);
        else {
          await t.deleteByIndex('entries', 'txnId', id);
          await t.deleteByIndex('stockMoves', 'refId', id);
          if (DOC_STORES[store]) await t.deleteByIndex(DOC_STORES[store][0], DOC_STORES[store][1], id);
        }
      }
      for (const e of data.entries) if (useBackup.get(entryParent(e))) await t.put('entries', e);
      for (const m of data.stockMoves) if (useBackup.get(moveParent(m))) await t.put('stockMoves', m);
      for (const i of data.saleItems) if (useBackup.get('sales:' + i.saleId)) await t.put('saleItems', i);
      for (const i of data.purchaseItems) if (useBackup.get('purchases:' + i.purchaseId)) await t.put('purchaseItems', i);
      for (const s of ['categories', 'holds', 'auditLog']) {
        for (const r of data[s]) { const local = await t.get(s, r.id); if (!local || stamp(r) > stamp(local)) await t.put(s, r); }
      }
      for (const m of data.meta) {
        const local = await t.get('meta', m.key);
        if (m.key.startsWith('seq:')) await t.put('meta', { key: m.key, value: Math.max(local?.value || 0, m.value || 0) });
        else if (!local) await t.put('meta', m);
      }
    }
    await ensureSystemAccounts(t);
    await recomputeStock(t);
    await t.add('auditLog', { id: uuid(), at: nowISO(), userId: Auth.user()?.id, userName: Auth.user()?.name, action: 'backup_restored', details: { mode, from: obj.createdAt } });
  });
  if (includeSettings && obj.settings && mode === 'replace') replaceSettings(obj.settings);
  await Catalog.load();
  document.dispatchEvent(new CustomEvent('data:changed'));
  return report;
}

// ---------- Old shared database ----------
// Older builds (and copies of this app such as AgriSale / pharmaSaleApp) used one database, "saleapp_pos",
// on the shared designer-haxxan.github.io origin. It is never modified here; it can be imported (merged) once
// after the user reviews its record counts.
export async function legacyDataExists() {
  if (!indexedDB.databases) return false;
  try { return (await indexedDB.databases()).some((d) => d.name === LEGACY_DB_NAME); } catch { return false; }
}

// Returns a backup-shaped object with the old data, or null if there is nothing to import.
export async function readLegacyData() {
  if (!(await legacyDataExists())) return null;
  let db;
  try {
    db = await new Promise((res, rej) => {
      const r = indexedDB.open(LEGACY_DB_NAME); // no version: open as-is, never upgrade it
      r.onupgradeneeded = () => r.transaction.abort(); // it did not exist after all: don't create it
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch { return null; }
  try {
    db.onversionchange = () => db.close();
    const stores = DATA_STORES.filter((s) => db.objectStoreNames.contains(s));
    const data = {};
    if (stores.length) {
      await new Promise((res, rej) => {
        const t = db.transaction(stores, 'readonly');
        for (const s of stores) { const r = t.objectStore(s).getAll(); r.onsuccess = () => { data[s] = r.result; }; }
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    }
    for (const s of DATA_STORES) data[s] ||= [];
    const counts = Object.fromEntries(DATA_STORES.map((s) => [s, data[s].length]));
    const business = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'vouchers'].reduce((n, s) => n + counts[s], 0);
    if (!business) return null;
    return { format: FORMAT, backupVersion: CONFIG.BACKUP_VERSION, appVersion: `shared database v${db.version}`, schemaVersion: CONFIG.SCHEMA_VERSION,
      createdAt: nowISO(), counts, data };
  } finally { db.close(); }
}
