// IndexedDB schema definition and migrations.
import { CONFIG } from '../config.js';

export const DB_NAME = `${CONFIG.APP_ID}_pos`;
// Database name used by older builds (shared with other apps on the same origin). Never modified; only read on import.
export const LEGACY_DB_NAME = 'saleapp_pos';
export const DB_VERSION = 2;

// Stores that make up the business data (included in backups).
export const DATA_STORES = [
  'categories', 'products', 'customers', 'suppliers', 'accounts',
  'sales', 'saleItems', 'purchases', 'purchaseItems', 'saleReturns', 'purchaseReturns',
  'vouchers', 'entries', 'stockMoves', 'adjustments', 'holds', 'auditLog', 'meta',
  'devices', 'repairs', 'services',
];

// Added in schema v2 (mobile shop): IMEI-tracked phones, repair job cards, wallet/load services.
const STORES_V2 = {
  devices: { indexes: { imei1: 'imei1', imei2: 'imei2', status: 'status', brand: 'brand', saleId: 'saleId', purchaseId: 'purchaseId', createdAt: 'createdAt' } },
  repairs: { indexes: { number: ['number', true], date: 'date', status: 'status', imei: 'imei', customerId: 'customerId' } },
  services: { indexes: { number: ['number', true], date: 'date', type: 'type', accountId: 'accountId' } },
};

const STORES = {
  meta: { keyPath: 'key', indexes: {} },
  categories: { indexes: { nameLc: 'nameLc' } },
  products: { indexes: { nameLc: 'nameLc', barcode: 'barcode', sku: 'sku', categoryId: 'categoryId' } },
  customers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  suppliers: { indexes: { nameLc: 'nameLc', phone: 'phone' } },
  accounts: { indexes: { type: 'type' } },
  sales: { indexes: { number: ['number', true], date: 'date', customerId: 'customerId' } },
  saleItems: { indexes: { saleId: 'saleId', productId: 'productId', date: 'date' } },
  purchases: { indexes: { number: ['number', true], date: 'date', supplierId: 'supplierId' } },
  purchaseItems: { indexes: { purchaseId: 'purchaseId', productId: 'productId', date: 'date' } },
  saleReturns: { indexes: { number: ['number', true], date: 'date', saleId: 'saleId', customerId: 'customerId' } },
  purchaseReturns: { indexes: { number: ['number', true], date: 'date', purchaseId: 'purchaseId', supplierId: 'supplierId' } },
  vouchers: { indexes: { number: ['number', true], date: 'date', type: 'type' } },
  entries: { indexes: { accountId: 'accountId', txnId: 'txnId', date: 'date', acctDate: [['accountId', 'date'], false] } },
  stockMoves: { indexes: { productId: 'productId', refId: 'refId', date: 'date', prodDate: [['productId', 'date'], false] } },
  adjustments: { indexes: { number: ['number', true], date: 'date' } },
  holds: { indexes: { createdAt: 'createdAt' } },
  auditLog: { indexes: { at: 'at' } },
};

export const SYSTEM_ACCOUNTS = [
  { id: 'cash', name: 'Cash in Hand', type: 'cash' },
  { id: 'sales', name: 'Sales', type: 'income' },
  { id: 'sales_returns', name: 'Sales Returns', type: 'income' },
  { id: 'purchases', name: 'Purchases', type: 'expense' },
  { id: 'purchase_returns', name: 'Purchase Returns', type: 'expense' },
  { id: 'tax', name: 'Sales Tax Payable', type: 'liability' },
  { id: 'equity', name: 'Opening Balance Equity', type: 'equity' },
  { id: 'income', name: 'Other Income', type: 'income' },
  { id: 'expense', name: 'General Expenses', type: 'expense' },
];

// Mobile-shop accounts (wallets are cash-like so they appear in payment pickers and the cash book).
export const MOBILE_ACCOUNTS = [
  { id: 'wallet_ep', name: 'Easypaisa Wallet', type: 'bank' },
  { id: 'wallet_jc', name: 'JazzCash Wallet', type: 'bank' },
  { id: 'wallet_load', name: 'Mobile Load Balance', type: 'bank' },
  { id: 'repair_income', name: 'Repair Income', type: 'income' },
  { id: 'repair_advance', name: 'Repair Advances (customers)', type: 'liability' },
  { id: 'service_income', name: 'Service Fees & Commission', type: 'income' },
  { id: 'repair_parts', name: 'Repair Parts Bought', type: 'expense' },
];
SYSTEM_ACCOUNTS.push(...MOBILE_ACCOUNTS);

export function upgrade(db, oldVersion, t) {
  if (oldVersion < 1) {
    for (const [name, def] of Object.entries(STORES)) {
      const os = db.createObjectStore(name, { keyPath: def.keyPath || 'id' });
      for (const [idx, spec] of Object.entries(def.indexes)) {
        const [keyPath, unique] = Array.isArray(spec) ? spec : [spec, false];
        os.createIndex(idx, keyPath, { unique: !!unique });
      }
    }
    const now = new Date().toISOString();
    const acc = t.objectStore('accounts');
    for (const a of SYSTEM_ACCOUNTS) acc.put({ ...a, system: true, active: 1, createdAt: now, updatedAt: now });
    t.objectStore('meta').put({ key: 'schemaVersion', value: 1 });
    t.objectStore('meta').put({ key: 'createdAt', value: now });
  }
  if (oldVersion < 2) {
    for (const [name, def] of Object.entries(STORES_V2)) {
      if (db.objectStoreNames.contains(name)) continue;
      const os = db.createObjectStore(name, { keyPath: def.keyPath || 'id' });
      for (const [idx, spec] of Object.entries(def.indexes)) {
        const [keyPath, unique] = Array.isArray(spec) ? spec : [spec, false];
        os.createIndex(idx, keyPath, { unique: !!unique });
      }
    }
    const now = new Date().toISOString();
    for (const a of MOBILE_ACCOUNTS) t.objectStore('accounts').put({ ...a, system: true, active: 1, createdAt: now, updatedAt: now });
    t.objectStore('meta').put({ key: 'schemaVersion', value: 2 });
  }
  // Future migrations: if (oldVersion < 2) { ... }
}
