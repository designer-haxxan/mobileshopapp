// Mobile-shop domain constants and helpers (brands, conditions, PTA status, wallet providers, IMEI checks).
import { esc } from './utils.js';

export const BRANDS = ['Apple', 'Samsung', 'Xiaomi', 'Redmi', 'POCO', 'Oppo', 'Vivo', 'Realme', 'Infinix', 'Tecno', 'Itel', 'Honor', 'Huawei', 'OnePlus', 'Google', 'Nokia', 'Motorola', 'QMobile', 'VGO Tel', 'Sparx', 'Other'];

export const CONDITIONS = {
  new: { label: 'New (sealed)', short: 'New', icon: 'box-seam', tint: 'green' },
  open_box: { label: 'Open box', short: 'Open box', icon: 'box2-heart', tint: 'cyan' },
  used: { label: 'Used', short: 'Used', icon: 'phone', tint: 'amber' },
  refurb: { label: 'Repaired / refurbished', short: 'Refurb', icon: 'tools', tint: 'violet' },
};

// How the phone stands with Pakistan's PTA (Device Identification, Registration & Blocking System).
export const PTA = {
  pta: { label: 'PTA approved', short: 'PTA', tint: 'green' },
  non_pta: { label: 'Non-PTA (not registered)', short: 'Non-PTA', tint: 'red' },
  jv: { label: 'JV / patched (works on local SIM)', short: 'JV', tint: 'amber' },
  factory_unlocked: { label: 'Factory unlocked', short: 'Unlocked', tint: 'cyan' },
  unknown: { label: 'Not checked', short: 'Unchecked', tint: 'slate' },
};

export const STORAGES = ['8GB', '16GB', '32GB', '64GB', '128GB', '256GB', '512GB', '1TB'];
export const RAMS = ['1GB', '2GB', '3GB', '4GB', '6GB', '8GB', '12GB', '16GB'];

export const DEVICE_STATUS = {
  in_stock: { label: 'In stock', tint: 'green' },
  sold: { label: 'Sold', tint: 'slate' },
  returned_supplier: { label: 'Returned to supplier', tint: 'amber' },
};

export const REPAIR_STATUS = {
  received: { label: 'Received', icon: 'inbox', tint: 'slate', step: 0 },
  diagnosing: { label: 'Diagnosing', icon: 'search', tint: 'cyan', step: 1 },
  waiting_parts: { label: 'Waiting for parts', icon: 'hourglass-split', tint: 'amber', step: 1 },
  in_progress: { label: 'Being repaired', icon: 'wrench-adjustable', tint: 'violet', step: 2 },
  ready: { label: 'Ready for pickup', icon: 'check2-circle', tint: 'green', step: 3 },
  delivered: { label: 'Delivered', icon: 'bag-check', tint: 'indigo', step: 4 },
  cancelled: { label: 'Cancelled', icon: 'x-circle', tint: 'red', step: 4 },
};
export const OPEN_REPAIR = ['received', 'diagnosing', 'waiting_parts', 'in_progress', 'ready'];

export const COMMON_FAULTS = ['Screen broken', 'Display / touch issue', 'Battery drain', 'Not charging', 'Water damage', 'Dead / no power', 'Software / hang', 'Speaker / mic issue', 'Camera issue', 'Network / IMEI issue', 'FRP / password unlock', 'Back glass', 'Charging port', 'Other'];

// Easypaisa / JazzCash / load / bill payment. dir 'out' = customer pays cash, shop sends money from its wallet;
// dir 'in' = customer's money arrives in the shop wallet, shop hands out cash.
export const SERVICE_TYPES = {
  deposit: { label: 'Cash In (send money)', short: 'Send', icon: 'arrow-up-right-circle', dir: 'out', tint: 'green', help: 'Customer gives cash, you send it from your wallet.' },
  withdraw: { label: 'Cash Out (withdraw)', short: 'Withdraw', icon: 'arrow-down-left-circle', dir: 'in', tint: 'red', help: 'Customer sends money to your wallet, you hand over cash.' },
  bill: { label: 'Bill payment', short: 'Bill', icon: 'receipt-cutoff', dir: 'out', tint: 'amber', help: 'Utility / mobile / internet bill paid through your wallet.' },
  load: { label: 'Mobile load / package', short: 'Load', icon: 'sim', dir: 'out', tint: 'cyan', help: 'Easyload, packages, bundles. Commission = what the network gives you.' },
  other: { label: 'Other service', short: 'Other', icon: 'three-dots', dir: 'out', tint: 'slate', help: 'Any other agent service.' },
};

export const WALLET_ACCOUNTS = [
  { id: 'wallet_ep', name: 'Easypaisa Wallet', provider: 'Easypaisa', icon: 'phone-vibrate', color: '#16a34a' },
  { id: 'wallet_jc', name: 'JazzCash Wallet', provider: 'JazzCash', icon: 'lightning-charge', color: '#dc2626' },
  { id: 'wallet_load', name: 'Mobile Load Balance', provider: 'Load', icon: 'sim', color: '#0891b2' },
];

export const BILL_KINDS = ['Electricity (WAPDA/K-Electric)', 'Gas (SNGPL/SSGC)', 'Water', 'Internet / PTCL', 'Mobile postpaid', 'Credit card', 'Challan / Fee', 'Other'];

// A valid IMEI is 15 digits and passes the Luhn check (IMEI-SV 16 digits is also accepted without the check).
export const cleanImei = (s) => String(s ?? '').replace(/[\s-]/g, '');
export function luhnOk(d) {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i];
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
// Returns '' when OK, otherwise a message.
export function imeiProblem(raw, { required = true } = {}) {
  const s = cleanImei(raw);
  if (!s) return required ? 'IMEI is required.' : '';
  if (!/^\d+$/.test(s)) return 'IMEI must contain digits only.';
  if (s.length !== 15 && s.length !== 16) return `IMEI must be 15 digits (you typed ${s.length}).`;
  if (s.length === 15 && !luhnOk(s)) return 'This IMEI looks mistyped (checksum failed). Dial *#06# on the phone to read it again.';
  return '';
}

export const deviceName = (d) => [d.brand, d.model, d.storage, d.color].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || 'Phone';
export const imeiShort = (s) => (s ? `…${String(s).slice(-6)}` : '');
export const ptaBadge = (k) => { const p = PTA[k] || PTA.unknown; return `<span class="badge tint-${p.tint} pta-badge">${esc(p.short)}</span>`; };
export const condBadge = (k) => { const c = CONDITIONS[k] || CONDITIONS.used; return `<span class="badge tint-${c.tint}">${esc(c.short)}</span>`; };
export const waLink = (phone, text) => {
  const p = String(phone || '').replace(/\D/g, '').replace(/^0/, '92');
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : '';
};
