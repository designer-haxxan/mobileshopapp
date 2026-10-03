// Posting engine. Every business operation runs inside ONE IndexedDB transaction that writes the
// document, its lines, stock movements, double-entry ledger entries, the number counter and the audit
// record together. If any step fails the whole transaction aborts, leaving no partial data behind.
import * as idb from '../db/idb.js';
import { uuid, round2, round3, num, nowISO, today, AppError, clean, lc, fmtQty } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import * as Auth from './auth.js';
import * as Catalog from './catalog.js';
import { deviceName, cleanImei, imeiProblem, SERVICE_TYPES, REPAIR_STATUS } from '../core/mobile.js';

const EPS = 0.0005;
const NUMBER_STORE = {
  sale: 'sales', purchase: 'purchases', saleReturn: 'saleReturns', purchaseReturn: 'purchaseReturns',
  receipt: 'vouchers', payment: 'vouchers', transfer: 'vouchers', adjustment: 'adjustments',
  repair: 'repairs', service: 'services',
};
export const ACCOUNT_TYPES = { cash: 'Cash', bank: 'Bank / Wallet', income: 'Income', expense: 'Expense', asset: 'Other Asset', liability: 'Liability', equity: 'Equity' };
const DEBIT_NORMAL = new Set(['cash', 'bank', 'asset', 'expense', 'customer']);
export const isDebitNormal = (type) => DEBIT_NORMAL.has(type);

export const partyAccount = (kind, id) => (kind === 'customers' ? 'C:' : 'S:') + id;
export function parseAccount(accId) {
  if (accId?.startsWith('C:')) return { kind: 'customers', id: accId.slice(2), type: 'customer' };
  if (accId?.startsWith('S:')) return { kind: 'suppliers', id: accId.slice(2), type: 'supplier' };
  return { kind: 'accounts', id: accId };
}

// ---------- helpers ----------
const newCtx = () => ({ touched: new Set(), parties: [], duplicate: false, devices: false });

async function finish(ctx) {
  if (ctx.touched.size) await Catalog.refreshProducts([...ctx.touched]);
  for (const [kind, id] of ctx.parties) await Catalog.refreshParty(kind, id);
  if (ctx.devices) await Catalog.refreshDevices();
  document.dispatchEvent(new CustomEvent('data:changed'));
}

async function nextNumber(t, kind) {
  const prefix = clean(getSettings().prefixes[kind] || kind.toUpperCase(), 12);
  const key = 'seq:' + kind;
  const rec = (await t.get('meta', key)) || { key, value: 0 };
  let n = rec.value; let number;
  do { n++; number = `${prefix}-${String(n).padStart(6, '0')}`; }
  while (await t.getByIndex(NUMBER_STORE[kind], 'number', number));
  await t.put('meta', { key, value: n });
  return number;
}

function mkEntries(doc, refType, lines) {
  const at = nowISO();
  const out = lines.filter((l) => round2(l[1]) !== 0 || round2(l[2]) !== 0).map(([accountId, dr, cr, memo]) => {
    if (dr < 0 || cr < 0) throw new AppError('Internal error: negative ledger amount');
    return { id: uuid(), txnId: doc.id, refType, refNo: doc.number, date: doc.date, accountId, debit: round2(dr), credit: round2(cr), memo: memo || '', createdAt: at };
  });
  const d = round2(out.reduce((s, e) => s + e.debit, 0)); const c = round2(out.reduce((s, e) => s + e.credit, 0));
  if (Math.abs(d - c) > 0.009) throw new AppError(`Internal error: unbalanced entries (${d} / ${c})`);
  return out;
}
async function addEntries(t, doc, refType, lines) {
  for (const e of mkEntries(doc, refType, lines)) await t.add('entries', e);
}

async function moveStock(t, ctx, { productId, qty, type, doc, cost, note = '' }) {
  const p = await t.get('products', productId);
  if (!p) throw new AppError('Product not found.');
  if (p.trackStock === false) return p;
  p.stock = round3((p.stock || 0) + qty); p.updatedAt = nowISO();
  await t.put('products', p);
  await t.add('stockMoves', { id: uuid(), productId, date: doc.date, qty: round3(qty), type, refId: doc.id, refNo: doc.number, cost: round2(cost ?? p.purchasePrice ?? 0), note, createdAt: nowISO() });
  ctx.touched.add(productId);
  if (qty < 0 && p.stock < -EPS && !getSettings().allowNegativeStock) {
    throw new AppError(`Insufficient stock for "${p.name}". Available: ${fmtQty(p.stock - qty)}`);
  }
  return p;
}

// Remove all stock moves & ledger entries of a document (used by edit and void).
async function revertDoc(t, ctx, docId) {
  const moves = await t.getAllByIndex('stockMoves', 'refId', docId);
  const allowNeg = getSettings().allowNegativeStock;
  for (const m of moves) {
    const p = await t.get('products', m.productId);
    if (p) {
      p.stock = round3((p.stock || 0) - m.qty); p.updatedAt = nowISO();
      if (m.qty > 0 && p.stock < -EPS && !allowNeg) throw new AppError(`Cannot reverse: stock of "${p.name}" has already been sold/used.`);
      await t.put('products', p); ctx.touched.add(p.id);
    }
    await t.delete('stockMoves', m.id);
  }
  await t.deleteByIndex('entries', 'txnId', docId);
}

async function audit(t, action, details = {}) {
  const u = Auth.user();
  const rec = { id: uuid(), at: nowISO(), userId: u?.id || null, userName: u?.name || '', action, details };
  await t.add('auditLog', rec);
}

const stamp = () => { const u = Auth.user(); return { userId: u?.id || null, userName: u?.name || '' }; };

async function paymentAccount(t, id) {
  const acc = await t.get('accounts', id || 'cash');
  if (!acc || !['cash', 'bank'].includes(acc.type) || !acc.active) throw new AppError('Select a valid cash/bank payment account.');
  return acc;
}

// ---------- document calculation (shared with the UI for live totals) ----------
export function calcDoc(items, billDiscount = 0, taxRate = 0) {
  const lines = [];
  for (const it of items) {
    const qty = round3(num(it.qty)); const rate = round2(num(it.rate)); const disc = round2(num(it.discount));
    if (!(qty > 0)) throw new AppError(`Quantity must be greater than zero (${it.name || 'item'}).`);
    if (rate < 0) throw new AppError(`Rate cannot be negative (${it.name || 'item'}).`);
    const gross = round2(qty * rate);
    if (disc < 0 || disc > gross + EPS) throw new AppError(`Invalid discount for ${it.name || 'item'}.`);
    lines.push({ ...it, qty, rate, discount: disc, amount: round2(gross - disc) });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const discount = round2(num(billDiscount));
  if (discount < 0 || discount > subtotal + EPS) throw new AppError('Bill discount cannot exceed the subtotal.');
  const taxable = round2(subtotal - discount);
  const tax = round2(taxable * num(taxRate) / 100);
  return { lines, subtotal, discount, taxRate: num(taxRate), tax, total: round2(taxable + tax), qtyTotal: round3(lines.reduce((s, l) => s + l.qty, 0)) };
}
// Same calculation without throwing, for live UI previews.
export function previewDoc(items, billDiscount, taxRate) {
  try { return calcDoc(items, billDiscount, taxRate); } catch { return null; }
}

// ---------- SALES ----------
const SALE_STORES = ['sales', 'saleItems', 'products', 'stockMoves', 'entries', 'meta', 'customers', 'accounts', 'saleReturns', 'auditLog', 'devices'];

export async function saveSale(input) {
  const editing = !!input.editId;
  Auth.require(editing ? 'sale.edit' : 'sale.create');
  const id = input.editId || input.id;
  if (!id) throw new AppError('Missing sale id.');
  const calc = calcDoc(input.items, input.discount, input.taxRate);
  if (!calc.lines.length) throw new AppError('The cart is empty.');
  const customerId = input.customerId || null;
  const tendered = round2(num(input.tendered));
  if (tendered < 0) throw new AppError('Paid amount cannot be negative.');
  const tradeIn = input.tradeIn?.device ? { device: input.tradeIn.device, value: round2(num(input.tradeIn.value)) } : null;
  if (tradeIn && (!(tradeIn.value > 0) || tradeIn.value > calc.total + 0.001)) throw new AppError('Trade-in value must be more than zero and not more than the bill total.');
  const tradeValue = tradeIn ? tradeIn.value : 0;
  const payable = round2(calc.total - tradeValue);
  const paid = round2(Math.min(tendered, payable));
  if (!customerId && paid < payable - 0.001) throw new AppError('Walk-in sales must be fully paid. Select a customer to sell on credit.');
  for (const l of calc.lines) if (l.deviceId && l.qty !== 1) throw new AppError('A phone is sold one at a time (quantity 1).');
  const ctx = newCtx();

  const sale = await idb.write(SALE_STORES, async (t) => {
    const existing = await t.get('sales', id);
    if (existing && !editing) { ctx.duplicate = true; return existing; }
    if (editing) {
      if (!existing) throw new AppError('Sale not found.');
      if (existing.status === 'void') throw new AppError('A voided sale cannot be edited.');
      if (await t.countByIndex('saleReturns', 'saleId', id)) throw new AppError('This sale has returns and can no longer be edited.');
      await revertDoc(t, ctx, id);
      await revertDevices(t, ctx, id);
      await t.deleteByIndex('saleItems', 'saleId', id);
    }
    let customerName = 'Walk-in Customer';
    if (customerId) {
      const c = await t.get('customers', customerId);
      if (!c) throw new AppError('Customer not found.');
      customerName = c.name; ctx.parties.push(['customers', customerId]);
    }
    const acc = await paymentAccount(t, input.paymentAccountId);
    const number = existing?.number || await nextNumber(t, 'sale');
    const now = nowISO();
    const doc = {
      id, number, date: input.date || existing?.date || today(), createdAt: existing?.createdAt || now, updatedAt: now,
      customerId, customerName, itemCount: calc.lines.length, qtyTotal: calc.qtyTotal,
      subtotal: calc.subtotal, discount: calc.discount, taxRate: calc.taxRate, tax: calc.tax, total: calc.total,
      tendered, paid, change: round2(Math.max(0, tendered - payable)), balance: round2(payable - paid), tradeValue,
      paymentAccountId: acc.id, paymentAccountName: acc.name,
      paymentType: paid >= payable ? 'paid' : paid > 0 ? 'partial' : 'credit',
      status: 'completed', note: clean(input.note, 500), edited: editing || !!existing?.edited, ...stamp(),
    };
    await t.put('sales', doc);
    let i = 0;
    for (const l of calc.lines) {
      if (l.deviceId) {
        const d = await t.get('devices', l.deviceId);
        if (!d) throw new AppError('A phone in the cart no longer exists.');
        if (d.status !== 'in_stock') throw new AppError(`${deviceName(d)} (IMEI ${d.imei1}) is no longer in stock.`);
        const wd = l.warrantyDays === undefined || l.warrantyDays === '' ? defaultWarranty(d.condition) : Math.max(0, Math.round(num(l.warrantyDays)));
        await t.add('saleItems', { id: uuid(), saleId: id, saleNo: number, date: doc.date, line: i++, productId: null, deviceId: d.id, imei: d.imei1, imei2: d.imei2 || '',
          name: deviceName(d), sku: 'IMEI ' + d.imei1, unit: 'pc', qty: 1, rate: l.rate, discount: l.discount, amount: l.amount, cost: round2(d.costTotal || 0),
          condition: d.condition, pta: d.pta, warrantyDays: wd });
        Object.assign(d, { status: 'sold', saleId: id, saleNo: number, soldAt: now, soldDate: doc.date, soldPrice: l.amount, customerId, customerName, warrantyDays: wd, updatedAt: now });
        addHist(d, 'sold', number, `Sold to ${customerName} for ${l.amount}`);
        await t.put('devices', d); ctx.devices = true;
        continue;
      }
      const p = await t.get('products', l.productId);
      if (!p) throw new AppError('A product in the cart no longer exists.');
      if (!p.active && !editing) throw new AppError(`"${p.name}" is inactive.`);
      const item = { id: uuid(), saleId: id, saleNo: number, date: doc.date, line: i++, productId: p.id, name: p.name, sku: p.sku || '', unit: p.unit || '',
        qty: l.qty, rate: l.rate, discount: l.discount, amount: l.amount, cost: round2(p.purchasePrice || 0) };
      await t.add('saleItems', item);
      await moveStock(t, ctx, { productId: p.id, qty: -l.qty, type: 'sale', doc, cost: item.cost });
    }
    const net = round2(calc.total - calc.tax);
    const C = customerId && partyAccount('customers', customerId);
    let tradeLines = [];
    if (tradeIn) {
      const [td] = await createDevices(t, ctx, { id, number, date: doc.date }, [{ ...tradeIn.device, cost: tradeValue }],
        { source: 'trade-in', seller: { name: customerId ? customerName : (tradeIn.device.sellerName || ''), cnic: tradeIn.device.sellerCnic, phone: tradeIn.device.sellerPhone } });
      doc.tradeIn = { value: tradeValue, deviceId: td.id, name: deviceName(td), imei: td.imei1, device: tradeIn.device };
      await t.put('sales', doc);
      tradeLines = [['purchases', tradeValue, 0, 'Trade-in phone ' + td.imei1]];
      if (customerId) tradeLines.push([C, 0, tradeValue, 'Trade-in phone credit']);
    }
    await addEntries(t, doc, 'sale', customerId ? [
      [C, calc.total, 0, 'Sale'], ['sales', 0, net, 'Sale'], ['tax', 0, calc.tax, 'Sales tax'],
      [acc.id, paid, 0, 'Payment received'], [C, 0, paid, 'Payment received'], ...tradeLines,
    ] : [[acc.id, paid, 0, 'Cash sale'], ['sales', 0, net, 'Sale'], ['tax', 0, calc.tax, 'Sales tax'], ...tradeLines]);
    await audit(t, editing ? 'sale_edited' : 'sale_created', { number, total: calc.total });
    return doc;
  });
  await finish(ctx);
  return { doc: sale, duplicate: ctx.duplicate };
}

// ---------- PURCHASES ----------
const PUR_STORES = ['purchases', 'purchaseItems', 'products', 'stockMoves', 'entries', 'meta', 'suppliers', 'accounts', 'purchaseReturns', 'auditLog'];

export async function savePurchase(input) {
  Auth.require('purchase.manage');
  const editing = !!input.editId;
  const id = input.editId || input.id;
  const calc = calcDoc(input.items, input.discount, 0);
  if (!calc.lines.length) throw new AppError('Add at least one product.');
  const supplierId = input.supplierId || null;
  const paid = round2(num(input.tendered));
  if (paid < 0 || paid > calc.total + 0.001) throw new AppError('Paid amount must be between 0 and the total.');
  if (!supplierId && paid < calc.total - 0.001) throw new AppError('Select a supplier for credit purchases, or pay the full amount.');
  const s = getSettings();
  const ctx = newCtx();

  const pur = await idb.write(PUR_STORES, async (t) => {
    const existing = await t.get('purchases', id);
    if (existing && !editing) { ctx.duplicate = true; return existing; }
    if (editing) {
      if (!existing) throw new AppError('Purchase not found.');
      if (existing.status === 'void') throw new AppError('A voided purchase cannot be edited.');
      if (await t.countByIndex('purchaseReturns', 'purchaseId', id)) throw new AppError('This purchase has returns and can no longer be edited.');
      if (existing.kind === 'device') throw new AppError('Phone purchases cannot be edited. Void it and enter it again.');
      await revertDoc(t, ctx, id);
      await t.deleteByIndex('purchaseItems', 'purchaseId', id);
    }
    let supplierName = 'Cash Purchase';
    if (supplierId) {
      const sp = await t.get('suppliers', supplierId);
      if (!sp) throw new AppError('Supplier not found.');
      supplierName = sp.name; ctx.parties.push(['suppliers', supplierId]);
    }
    const acc = await paymentAccount(t, input.paymentAccountId);
    const number = existing?.number || await nextNumber(t, 'purchase');
    const now = nowISO();
    const doc = {
      id, number, date: input.date || existing?.date || today(), createdAt: existing?.createdAt || now, updatedAt: now,
      supplierId, supplierName, refNo: clean(input.refNo, 60), itemCount: calc.lines.length, qtyTotal: calc.qtyTotal,
      subtotal: calc.subtotal, discount: calc.discount, tax: 0, total: calc.total, paid, balance: round2(calc.total - paid),
      paymentAccountId: acc.id, paymentAccountName: acc.name, status: 'completed', note: clean(input.note, 500),
      edited: editing || !!existing?.edited, ...stamp(),
    };
    await t.put('purchases', doc);
    const factor = calc.subtotal > 0 ? calc.total / calc.subtotal : 1;
    let i = 0;
    for (const l of calc.lines) {
      const p = await t.get('products', l.productId);
      if (!p) throw new AppError('A product in this purchase no longer exists.');
      const unitCost = round2((l.amount / l.qty) * factor);
      await t.add('purchaseItems', { id: uuid(), purchaseId: id, purchaseNo: number, date: doc.date, line: i++, productId: p.id, name: p.name, sku: p.sku || '', unit: p.unit || '',
        qty: l.qty, rate: l.rate, discount: l.discount, amount: l.amount, unitCost });
      await moveStock(t, ctx, { productId: p.id, qty: l.qty, type: 'purchase', doc, cost: unitCost });
      if (s.updatePurchasePrice) {
        const p2 = await t.get('products', p.id);
        p2.purchasePrice = unitCost; p2.updatedAt = nowISO();
        await t.put('products', p2); ctx.touched.add(p.id);
      }
    }
    const S = supplierId && partyAccount('suppliers', supplierId);
    await addEntries(t, doc, 'purchase', supplierId ? [
      ['purchases', calc.total, 0, 'Purchase'], [S, 0, calc.total, 'Purchase'],
      [S, paid, 0, 'Payment made'], [acc.id, 0, paid, 'Payment made'],
    ] : [['purchases', calc.total, 0, 'Cash purchase'], [acc.id, 0, calc.total, 'Cash purchase']]);
    await audit(t, editing ? 'purchase_edited' : 'purchase_created', { number, total: calc.total });
    return doc;
  });
  await finish(ctx);
  return { doc: pur, duplicate: ctx.duplicate };
}

// ---------- RETURNS ----------
async function returnedQtyMap(t, store, fk, docId) {
  const map = {};
  for (const r of await t.getAllByIndex(store, fk, docId)) {
    if (r.status === 'void') continue;
    for (const it of r.items) map[it.lineId] = round3((map[it.lineId] || 0) + it.qty);
  }
  return map;
}

// Returnable lines of a sale/purchase: [{...item, returned, remaining}]
export async function returnableLines(kind, docId) {
  const [itemStore, fk, retStore] = kind === 'sale' ? ['saleItems', 'saleId', 'saleReturns'] : ['purchaseItems', 'purchaseId', 'purchaseReturns'];
  return idb.read([itemStore, retStore], async (t) => {
    const items = (await t.getAllByIndex(itemStore, fk, docId)).sort((a, b) => a.line - b.line);
    const map = await returnedQtyMap(t, retStore, fk, docId);
    return items.map((it) => ({ ...it, returned: map[it.id] || 0, remaining: round3(it.qty - (map[it.id] || 0)) }));
  });
}

export async function saveReturn(kind, input) {
  const isSale = kind === 'sale';
  Auth.require(isSale ? 'sale.return' : 'purchase.manage');
  const [docStore, itemStore, retStore, fk, partyStore, partyKey] = isSale
    ? ['sales', 'saleItems', 'saleReturns', 'saleId', 'customers', 'customerId']
    : ['purchases', 'purchaseItems', 'purchaseReturns', 'purchaseId', 'suppliers', 'supplierId'];
  const ctx = newCtx();
  const ret = await idb.write([docStore, itemStore, retStore, 'products', 'stockMoves', 'entries', 'meta', 'accounts', 'auditLog', 'devices'], async (t) => {
    const existing = await t.get(retStore, input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const src = await t.get(docStore, input.docId);
    if (!src || src.status === 'void') throw new AppError('Original document not found or voided.');
    const items = await t.getAllByIndex(itemStore, fk, src.id);
    const done = await returnedQtyMap(t, retStore, fk, src.id);
    const factor = src.subtotal > 0 ? src.total / src.subtotal : 1;
    const lines = [];
    for (const l of input.lines) {
      const qty = round3(num(l.qty));
      if (!(qty > 0)) continue;
      const it = items.find((x) => x.id === l.lineId);
      if (!it) throw new AppError('Invalid return line.');
      const remaining = round3(it.qty - (done[it.id] || 0));
      if (qty > remaining + EPS) throw new AppError(`Cannot return ${fmtQty(qty)} of "${it.name}" (max ${fmtQty(remaining)}).`);
      const amount = round2(it.amount * factor * qty / it.qty);
      lines.push({ lineId: it.id, productId: it.productId, deviceId: it.deviceId || null, imei: it.imei || '', name: it.name, unit: it.unit, qty, rate: round2(amount / qty), amount, lineAmount: round2(it.amount * qty / it.qty), cost: isSale ? it.cost : it.unitCost });
    }
    if (!lines.length) throw new AppError('Enter a quantity to return.');
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    const tax = isSale && src.total > 0 ? round2(total * (src.tax || 0) / src.total) : 0;
    const partyId = src[partyKey] || null;
    let refund = partyId ? round2(num(input.refund)) : total;
    if (refund < 0 || refund > total + 0.001) throw new AppError('Refund must be between 0 and the return total.');
    const acc = await paymentAccount(t, input.refundAccountId);
    const number = await nextNumber(t, isSale ? 'saleReturn' : 'purchaseReturn');
    const doc = {
      id: input.id, number, date: input.date || today(), createdAt: nowISO(), [fk]: src.id, docNo: src.number,
      [partyKey]: partyId, partyName: isSale ? src.customerName : src.supplierName,
      items: lines, total, tax, refund, refundAccountId: acc.id, refundAccountName: acc.name,
      status: 'completed', note: clean(input.note, 500), ...stamp(),
    };
    await t.add(retStore, doc);
    for (const l of lines) {
      if (l.deviceId) {
        const d = await t.get('devices', l.deviceId);
        if (!d) throw new AppError('The phone record no longer exists.');
        if (isSale) {
          if (d.status !== 'sold' || d.saleId !== src.id) throw new AppError(`${deviceName(d)} is not currently sold on this bill.`);
          Object.assign(d, { status: 'in_stock', saleId: null, saleNo: '', soldAt: null, soldDate: null, soldPrice: 0, customerId: null, customerName: '', updatedAt: nowISO() });
          addHist(d, 'sale_return', number, 'Returned by customer');
        } else {
          if (d.status !== 'in_stock') throw new AppError(`${deviceName(d)} must be in stock to return it to the supplier.`);
          Object.assign(d, { status: 'returned_supplier', updatedAt: nowISO() });
          addHist(d, 'purchase_return', number, 'Returned to supplier');
        }
        await t.put('devices', d); ctx.devices = true;
        continue;
      }
      await moveStock(t, ctx, { productId: l.productId, qty: isSale ? l.qty : -l.qty, type: isSale ? 'sale_return' : 'purchase_return', doc, cost: l.cost });
    }
    if (partyId) ctx.parties.push([partyStore, partyId]);
    if (isSale) {
      const C = partyId ? partyAccount('customers', partyId) : acc.id;
      await addEntries(t, doc, 'saleReturn', [
        ['sales_returns', round2(total - tax), 0, 'Sales return'], ['tax', tax, 0, 'Tax reversal'], [C, 0, total, 'Sales return'],
        ...(partyId ? [[C, refund, 0, 'Refund paid'], [acc.id, 0, refund, 'Refund paid']] : []),
      ]);
    } else {
      const S = partyId ? partyAccount('suppliers', partyId) : acc.id;
      await addEntries(t, doc, 'purchaseReturn', [
        [S, total, 0, 'Purchase return'], ['purchase_returns', 0, total, 'Purchase return'],
        ...(partyId ? [[acc.id, refund, 0, 'Refund received'], [S, 0, refund, 'Refund received']] : []),
      ]);
    }
    await audit(t, isSale ? 'sale_return' : 'purchase_return', { number, total });
    return doc;
  });
  await finish(ctx);
  return { doc: ret, duplicate: ctx.duplicate };
}

// ---------- VOID ----------
const VOID_DEF = {
  sale: { store: 'sales', perm: 'sale.void', items: 'saleItems', fk: 'saleId', returns: 'saleReturns', party: ['customers', 'customerId'] },
  purchase: { store: 'purchases', perm: 'purchase.manage', items: 'purchaseItems', fk: 'purchaseId', returns: 'purchaseReturns', party: ['suppliers', 'supplierId'] },
  saleReturn: { store: 'saleReturns', perm: 'sale.void', party: ['customers', 'customerId'] },
  purchaseReturn: { store: 'purchaseReturns', perm: 'purchase.manage', party: ['suppliers', 'supplierId'] },
  voucher: { store: 'vouchers', perm: 'voucher.void' },
  adjustment: { store: 'adjustments', perm: 'stock.adjust' },
  service: { store: 'services', perm: 'service.create' },
};

export async function voidDocument(kind, id, reason = '') {
  const def = VOID_DEF[kind];
  Auth.require(def.perm);
  const ctx = newCtx();
  const stores = [def.store, 'products', 'stockMoves', 'entries', 'auditLog', 'devices', ...(def.items ? [def.items, def.returns] : [])];
  const doc = await idb.write(stores, async (t) => {
    const d = await t.get(def.store, id);
    if (!d) throw new AppError('Document not found.');
    if (d.status === 'void') throw new AppError('Already voided.');
    if (def.returns) {
      const rets = (await t.getAllByIndex(def.returns, def.fk, id)).filter((r) => r.status !== 'void');
      if (rets.length) throw new AppError('Void the returns of this document first.');
    }
    await revertDoc(t, ctx, id);
    if (kind === 'sale' || kind === 'purchase') await revertDevices(t, ctx, id);
    if (kind === 'saleReturn' || kind === 'purchaseReturn') {
      for (const it of d.items || []) {
        if (!it.deviceId) continue;
        const dv = await t.get('devices', it.deviceId);
        if (!dv) continue;
        if (kind === 'saleReturn') {
          if (dv.status !== 'in_stock') throw new AppError(`${deviceName(dv)} has been sold again; it cannot be put back on the original bill.`);
          Object.assign(dv, { status: 'sold', saleId: d.saleId, updatedAt: nowISO() });
        } else {
          if (dv.status !== 'returned_supplier') throw new AppError(`${deviceName(dv)} is not marked as returned to the supplier.`);
          Object.assign(dv, { status: 'in_stock', updatedAt: nowISO() });
        }
        addHist(dv, 'return_voided', d.number, 'Return voided');
        await t.put('devices', dv); ctx.devices = true;
      }
    }
    if (def.items) {
      d.voidedItems = await t.getAllByIndex(def.items, def.fk, id);
      await t.deleteByIndex(def.items, def.fk, id);
    }
    Object.assign(d, { status: 'void', voidedAt: nowISO(), voidedBy: Auth.user()?.name || '', voidReason: clean(reason, 200), updatedAt: nowISO() });
    await t.put(def.store, d);
    if (def.party && d[def.party[1]]) ctx.parties.push([def.party[0], d[def.party[1]]]);
    if (kind === 'voucher') for (const a of [d.accountId, d.counterAccountId]) { const pa = parseAccount(a); if (pa.kind !== 'accounts') ctx.parties.push([pa.kind, pa.id]); }
    await audit(t, kind + '_voided', { number: d.number });
    return d;
  });
  await finish(ctx);
  return doc;
}

// ---------- VOUCHERS (receipts, payments, transfers) ----------
async function accountInfo(t, accId) {
  const pa = parseAccount(accId);
  const rec = await t.get(pa.kind, pa.id);
  if (!rec) return null;
  return { id: accId, name: rec.name, type: pa.type || rec.type, active: rec.active };
}

export async function saveVoucher(input) {
  const type = input.type;
  if (!['receipt', 'payment', 'transfer'].includes(type)) throw new AppError('Invalid voucher type.');
  Auth.require(type === 'receipt' ? 'voucher.create' : 'account.manage');
  const amount = round2(num(input.amount));
  if (!(amount > 0)) throw new AppError('Amount must be greater than zero.');
  if (!input.counterAccountId) throw new AppError(type === 'transfer' ? 'Select the destination account.' : 'Select who/what this is for.');
  if (input.counterAccountId === input.accountId) throw new AppError('The two accounts must be different.');
  const ctx = newCtx();
  const doc = await idb.write(['vouchers', 'entries', 'meta', 'accounts', 'customers', 'suppliers', 'auditLog'], async (t) => {
    const existing = await t.get('vouchers', input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const acc = await paymentAccount(t, input.accountId);
    const counter = await accountInfo(t, input.counterAccountId);
    if (!counter || !counter.active) throw new AppError('The selected account/party does not exist or is inactive.');
    if (type === 'transfer' && !['cash', 'bank'].includes(counter.type)) throw new AppError('Transfers must be between cash/bank accounts.');
    const number = await nextNumber(t, type);
    const d = {
      id: input.id, number, type, date: input.date || today(), createdAt: nowISO(), amount,
      accountId: acc.id, accountName: acc.name, counterAccountId: counter.id, counterName: counter.name, counterType: counter.type,
      method: clean(input.method, 40), note: clean(input.note, 500), status: 'completed', ...stamp(),
    };
    await t.add('vouchers', d);
    const memo = d.note || { receipt: 'Received', payment: 'Paid', transfer: 'Transfer' }[type];
    await addEntries(t, d, type, type === 'receipt'
      ? [[acc.id, amount, 0, memo], [counter.id, 0, amount, memo]]
      : type === 'payment' ? [[counter.id, amount, 0, memo], [acc.id, 0, amount, memo]]
        : [[counter.id, amount, 0, memo], [acc.id, 0, amount, memo]]);
    const pa = parseAccount(counter.id);
    if (pa.kind !== 'accounts') ctx.parties.push([pa.kind, pa.id]);
    await audit(t, 'voucher_' + type, { number, amount });
    return d;
  });
  await finish(ctx);
  return { doc, duplicate: ctx.duplicate };
}

// ---------- PHONES (IMEI-tracked devices) ----------
const addHist = (d, type, ref, note = '') => { (d.history ||= []).push({ at: nowISO(), type, ref: ref || '', note, by: Auth.user()?.name || '' }); };
export const defaultWarranty = (condition) => {
  const w = getSettings().warranty || {};
  return Math.max(0, Math.round(num(w[condition], condition === 'new' ? 30 : 7)));
};

async function findDevice(t, imei) {
  const a = await t.getAllByIndex('devices', 'imei1', imei);
  if (a.length) return a[0];
  return (await t.getAllByIndex('devices', 'imei2', imei))[0] || null;
}

// Creates (or revives, if the same IMEI was sold earlier) one device record per entry. Runs inside a caller's transaction.
async function createDevices(t, ctx, doc, list, { source = 'supplier', seller = {}, supplierId = null } = {}) {
  const now = nowISO(); const out = []; const seen = new Set();
  for (const x of list) {
    const imei1 = cleanImei(x.imei1); const imei2 = cleanImei(x.imei2);
    const brand = clean(x.brand, 40); const model = clean(x.model, 80);
    if (!brand || !model) throw new AppError('Brand and model are required for every phone.');
    let msg = imeiProblem(imei1); if (msg) throw new AppError(`${brand} ${model}: ${msg}`);
    msg = imeiProblem(imei2, { required: false }); if (msg) throw new AppError(`${brand} ${model} (IMEI 2): ${msg}`);
    for (const m of [imei1, imei2].filter(Boolean)) { if (seen.has(m)) throw new AppError(`IMEI ${m} is entered twice.`); seen.add(m); }
    const cost = round2(num(x.cost));
    if (cost < 0) throw new AppError('Cost cannot be negative.');
    let existing = null;
    for (const m of [imei1, imei2].filter(Boolean)) {
      const e = await findDevice(t, m);
      if (!e) continue;
      if (e.status === 'in_stock') throw new AppError(`IMEI ${m} is already in stock (${deviceName(e)}).`);
      existing = existing || e;
    }
    const base = existing ? { ...existing } : { id: uuid(), createdAt: now, history: [] };
    const dev = { ...base, imei1, imei2, brand, model, storage: clean(x.storage, 20), ram: clean(x.ram, 20), color: clean(x.color, 30),
      condition: x.condition || 'used', pta: x.pta || 'unknown', battery: clean(x.battery, 10), accessories: clean(x.accessories, 120), notes: clean(x.notes, 300),
      purchasePrice: cost, extraCost: 0, costTotal: cost, salePrice: round2(num(x.salePrice)), status: 'in_stock',
      purchaseId: doc.id, purchaseNo: doc.number, purchaseDate: doc.date, source, supplierId,
      sellerName: clean(seller.name ?? x.sellerName, 100), sellerCnic: clean(seller.cnic ?? x.sellerCnic, 20), sellerPhone: clean(seller.phone ?? x.sellerPhone, 30), sellerAddress: clean(seller.address ?? x.sellerAddress, 200),
      saleId: null, saleNo: '', soldAt: null, soldDate: null, soldPrice: 0, customerId: null, customerName: '', updatedAt: now };
    addHist(dev, source === 'trade-in' ? 'trade_in' : 'purchased', doc.number, `${source === 'trade-in' ? 'Trade-in' : 'Bought'} for ${cost}${dev.sellerName ? ' from ' + dev.sellerName : ''}`);
    await t.put('devices', dev); out.push(dev); ctx.devices = true;
  }
  return out;
}

// Undo a document's effect on phones: sold phones go back to stock; phones that document created are removed (only if still in stock).
async function revertDevices(t, ctx, docId) {
  for (const d of await t.getAllByIndex('devices', 'saleId', docId)) {
    Object.assign(d, { status: 'in_stock', saleId: null, saleNo: '', soldAt: null, soldDate: null, soldPrice: 0, customerId: null, customerName: '', updatedAt: nowISO() });
    addHist(d, 'sale_reverted', '', 'Sale edited or voided');
    await t.put('devices', d); ctx.devices = true;
  }
  for (const d of await t.getAllByIndex('devices', 'purchaseId', docId)) {
    if (d.status !== 'in_stock') throw new AppError(`${deviceName(d)} (IMEI ${d.imei1}) has already been sold or returned, so this document cannot be changed.`);
    await t.delete('devices', d.id); ctx.devices = true;
  }
}

const cnicProblem = (s) => (s && !/^\d{5}-?\d{7}-?\d$/.test(String(s).trim()) ? 'CNIC must have 13 digits (e.g. 35202-1234567-1).' : '');

// Buy phones: new stock from a supplier/dealer, or a used phone from a walk-in person (seller details are kept for the record).
export async function saveDevicePurchase(input) {
  Auth.require('phone.buy');
  const id = input.id;
  if (!id) throw new AppError('Missing document id.');
  const list = input.devices || [];
  if (!list.length) throw new AppError('Add at least one phone.');
  const total = round2(list.reduce((s, d) => s + round2(num(d.cost)), 0));
  const supplierId = input.supplierId || null;
  const paid = round2(num(input.paid));
  if (paid < 0 || paid > total + 0.001) throw new AppError('Paid amount must be between 0 and the total.');
  if (!supplierId && paid < total - 0.001) throw new AppError('Select a supplier for credit purchases, or pay the full amount.');
  const seller = { name: clean(input.seller?.name, 100), cnic: clean(input.seller?.cnic, 20), phone: clean(input.seller?.phone, 30), address: clean(input.seller?.address, 200) };
  if (!supplierId && list.some((d) => d.condition !== 'new')) {
    if (!seller.name) throw new AppError('Enter the seller\'s name — you must keep a record of who sold you a used phone.');
    if (!seller.cnic && !seller.phone) throw new AppError('Enter the seller\'s CNIC or phone number.');
  }
  const cm = cnicProblem(seller.cnic); if (cm) throw new AppError(cm);
  const ctx = newCtx();
  const pur = await idb.write([...PUR_STORES, 'devices'], async (t) => {
    const existing = await t.get('purchases', id);
    if (existing) { ctx.duplicate = true; return existing; }
    let supplierName = seller.name || 'Cash Purchase';
    if (supplierId) {
      const sp = await t.get('suppliers', supplierId);
      if (!sp) throw new AppError('Supplier not found.');
      supplierName = sp.name; ctx.parties.push(['suppliers', supplierId]);
    }
    const acc = await paymentAccount(t, input.paymentAccountId);
    const number = await nextNumber(t, 'purchase');
    const now = nowISO();
    const doc = { id, number, kind: 'device', date: input.date || today(), createdAt: now, updatedAt: now, supplierId, supplierName, refNo: clean(input.refNo, 60),
      itemCount: list.length, qtyTotal: list.length, subtotal: total, discount: 0, tax: 0, total, paid, balance: round2(total - paid),
      paymentAccountId: acc.id, paymentAccountName: acc.name, status: 'completed', note: clean(input.note, 500), seller, ...stamp() };
    await t.put('purchases', doc);
    const devs = await createDevices(t, ctx, doc, list, { source: supplierId ? 'supplier' : 'customer', seller, supplierId });
    let i = 0;
    for (const d of devs) {
      await t.add('purchaseItems', { id: uuid(), purchaseId: id, purchaseNo: number, date: doc.date, line: i++, productId: null, deviceId: d.id, imei: d.imei1,
        name: deviceName(d), sku: 'IMEI ' + d.imei1, unit: 'pc', qty: 1, rate: d.purchasePrice, discount: 0, amount: d.purchasePrice, unitCost: d.purchasePrice });
    }
    const S = supplierId && partyAccount('suppliers', supplierId);
    await addEntries(t, doc, 'purchase', supplierId ? [
      ['purchases', total, 0, 'Phone purchase'], [S, 0, total, 'Phone purchase'],
      [S, paid, 0, 'Payment made'], [acc.id, 0, paid, 'Payment made'],
    ] : [['purchases', total, 0, 'Phone purchase'], [acc.id, 0, total, 'Phone purchase from ' + (seller.name || 'seller')]]);
    await audit(t, 'phone_purchase', { number, total, phones: devs.length });
    return doc;
  });
  await finish(ctx);
  return { doc: pur, duplicate: ctx.duplicate };
}

// Edit a phone's details/prices. Sold phones: only notes can change.
export async function updateDevice(id, data) {
  Auth.require('phone.edit');
  const ctx = newCtx();
  const rec = await idb.write(['devices', 'auditLog'], async (t) => {
    const d = await t.get('devices', id);
    if (!d) throw new AppError('Phone not found.');
    if (d.status !== 'in_stock') {
      d.notes = clean(data.notes, 300); d.updatedAt = nowISO(); await t.put('devices', d); return d;
    }
    const imei1 = cleanImei(data.imei1); const imei2 = cleanImei(data.imei2);
    let msg = imeiProblem(imei1); if (msg) throw new AppError(msg);
    msg = imeiProblem(imei2, { required: false }); if (msg) throw new AppError('IMEI 2: ' + msg);
    for (const m of [imei1, imei2].filter(Boolean)) { const e = await findDevice(t, m); if (e && e.id !== id) throw new AppError(`IMEI ${m} already belongs to ${deviceName(e)}.`); }
    const brand = clean(data.brand, 40); const model = clean(data.model, 80);
    if (!brand || !model) throw new AppError('Brand and model are required.');
    const extra = round2(num(data.extraCost)); const salePrice = round2(num(data.salePrice));
    if (extra < 0 || salePrice < 0) throw new AppError('Prices cannot be negative.');
    const before = { salePrice: d.salePrice, extraCost: d.extraCost };
    Object.assign(d, { imei1, imei2, brand, model, storage: clean(data.storage, 20), ram: clean(data.ram, 20), color: clean(data.color, 30), condition: data.condition || d.condition,
      pta: data.pta || d.pta, battery: clean(data.battery, 10), accessories: clean(data.accessories, 120), notes: clean(data.notes, 300), salePrice, extraCost: extra,
      costTotal: round2((d.purchasePrice || 0) + extra), updatedAt: nowISO() });
    if (before.salePrice !== salePrice || before.extraCost !== extra) addHist(d, 'edited', '', `Sale price ${before.salePrice} → ${salePrice}, extra cost ${before.extraCost || 0} → ${extra}`);
    await t.put('devices', d); ctx.devices = true;
    await audit(t, 'update_phone', { imei: imei1 });
    return d;
  });
  await finish(ctx);
  return rec;
}

// Find a phone's full record by any IMEI (for the IMEI lookup screen). Reads only.
export async function lookupImei(imei) {
  const q = cleanImei(imei);
  if (!q) return null;
  return idb.read(['devices'], async (t) => (await t.getAllByIndex('devices', 'imei1', q))[0] || (await t.getAllByIndex('devices', 'imei2', q))[0] || null);
}

// ---------- REPAIRS (job cards) ----------
const REPAIR_STORES = ['repairs', 'products', 'stockMoves', 'entries', 'meta', 'accounts', 'customers', 'auditLog'];
const TERMINAL = ['delivered', 'cancelled'];

export function calcRepair(parts = [], labour = 0) {
  const lines = parts.map((p) => {
    const qty = round3(num(p.qty, 1)); const price = round2(num(p.price)); const cost = round2(num(p.cost));
    if (!(qty > 0) || price < 0 || cost < 0) throw new AppError('Check the part quantity, price and cost.');
    return { productId: p.productId || null, name: clean(p.name, 120) || 'Part', qty, price, cost, outsideCash: !!p.outsideCash && !p.productId, amount: round2(qty * price) };
  });
  const labourAmt = round2(num(labour));
  if (labourAmt < 0) throw new AppError('Labour charge cannot be negative.');
  const partsTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  return { lines, labour: labourAmt, partsTotal, total: round2(labourAmt + partsTotal), partsCost: round2(lines.reduce((s, l) => s + l.qty * l.cost, 0)) };
}
export function previewRepair(parts, labour) { try { return calcRepair(parts, labour); } catch { return null; } }

async function repairPay(t, r, { amount, accountId, accountName, kind, date }) {
  const amt = round2(amount);
  if (!amt) return;
  const p = { id: uuid(), date, amount: amt, accountId, accountName, kind, at: nowISO() };
  r.payments.push(p); r.paid = round2((r.paid || 0) + amt);
  const memo = amt > 0 ? (kind === 'final' ? 'Repair payment' : 'Repair advance') : 'Repair refund';
  await addEntries(t, { id: `${r.id}:p:${p.id.slice(0, 8)}`, number: r.number, date },
    'repairPay', amt > 0 ? [[accountId, amt, 0, memo], ['repair_advance', 0, amt, memo]] : [['repair_advance', -amt, 0, memo], [accountId, 0, -amt, memo]]);
}
const repHist = (r, status, note = '') => { (r.history ||= []).push({ at: nowISO(), status, note, by: Auth.user()?.name || '' }); };

export async function saveRepair(input) {
  Auth.require('repair.manage');
  const id = input.id;
  if (!id) throw new AppError('Missing job id.');
  const customerName = clean(input.customerName, 100); const customerPhone = clean(input.customerPhone, 30);
  if (!customerName && !customerPhone) throw new AppError('Enter the customer name or phone number.');
  const brand = clean(input.brand, 40); const model = clean(input.model, 80);
  if (!brand && !model) throw new AppError('Enter the phone brand/model.');
  const imei = cleanImei(input.imei);
  const im = imeiProblem(imei, { required: false }); if (im) throw new AppError(im);
  const fault = clean(input.fault, 150);
  if (!fault) throw new AppError('Select or type the fault.');
  const estimate = round2(num(input.estimate)); const advance = round2(num(input.advance));
  if (estimate < 0 || advance < 0) throw new AppError('Amounts cannot be negative.');
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const existing = await t.get('repairs', id);
    const now = nowISO();
    if (existing && !input.editing) { ctx.duplicate = true; return existing; }
    if (existing && TERMINAL.includes(existing.status)) throw new AppError('A delivered or cancelled job cannot be edited.');
    const r = existing || { id, number: await nextNumber(t, 'repair'), createdAt: now, status: 'received', date: input.date || today(), parts: [], labour: 0, total: 0, paid: 0, payments: [], history: [], warrantyDays: Math.max(0, Math.round(num(getSettings().repairWarrantyDays, 30))), ...stamp() };
    let customerId = input.customerId || null;
    if (customerId && !(await t.get('customers', customerId))) customerId = null;
    Object.assign(r, { customerId, customerName: customerName || customerPhone, customerPhone, brand, model, imei, color: clean(input.color, 30), fault, faultNotes: clean(input.faultNotes, 400),
      accessories: clean(input.accessories, 150), lockCode: clean(input.lockCode, 40), existingDamage: clean(input.existingDamage, 200), estimate, expectedDate: input.expectedDate || '',
      technician: clean(input.technician, 60), priority: input.priority === 'urgent' ? 'urgent' : 'normal', updatedAt: now });
    if (!existing) repHist(r, 'received', 'Job card created');
    await t.put('repairs', r);
    if (!existing && advance > 0) {
      const acc = await paymentAccount(t, input.paymentAccountId);
      await repairPay(t, r, { amount: advance, accountId: acc.id, accountName: acc.name, kind: 'advance', date: r.date });
      await t.put('repairs', r);
    }
    if (customerId) ctx.parties.push(['customers', customerId]);
    await audit(t, existing ? 'repair_updated' : 'repair_created', { number: r.number });
    return r;
  });
  await finish(ctx);
  return { doc, duplicate: ctx.duplicate };
}

export async function setRepairStatus(id, status, note = '') {
  Auth.require('repair.manage');
  if (!REPAIR_STATUS[status] || TERMINAL.includes(status)) throw new AppError('Invalid status.');
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const r = await t.get('repairs', id);
    if (!r) throw new AppError('Job not found.');
    if (TERMINAL.includes(r.status)) throw new AppError('This job is already closed.');
    r.status = status; r.updatedAt = nowISO(); repHist(r, status, clean(note, 200));
    await t.put('repairs', r);
    return r;
  });
  await finish(ctx);
  return doc;
}

// Parts, labour, diagnosis and technician notes. Stock is only consumed at delivery.
export async function saveRepairWork(id, input) {
  Auth.require('repair.manage');
  const calc = calcRepair(input.parts || [], input.labour);
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const r = await t.get('repairs', id);
    if (!r) throw new AppError('Job not found.');
    if (TERMINAL.includes(r.status)) throw new AppError('This job is already closed.');
    Object.assign(r, { parts: calc.lines, labour: calc.labour, total: calc.total, diagnosis: clean(input.diagnosis, 400), technician: clean(input.technician, 60) || r.technician,
      warrantyDays: Math.max(0, Math.round(num(input.warrantyDays, r.warrantyDays))), updatedAt: nowISO() });
    repHist(r, r.status, `Charges updated: total ${calc.total}`);
    await t.put('repairs', r);
    return r;
  });
  await finish(ctx);
  return doc;
}

export async function addRepairPayment(id, input) {
  Auth.require('repair.manage');
  const amount = round2(num(input.amount));
  if (!(amount > 0)) throw new AppError('Amount must be greater than zero.');
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const r = await t.get('repairs', id);
    if (!r) throw new AppError('Job not found.');
    if (TERMINAL.includes(r.status)) throw new AppError('This job is already closed.');
    const acc = await paymentAccount(t, input.accountId);
    await repairPay(t, r, { amount, accountId: acc.id, accountName: acc.name, kind: 'advance', date: input.date || today() });
    r.updatedAt = nowISO(); repHist(r, r.status, `Advance received: ${amount}`);
    await t.put('repairs', r);
    return r;
  });
  await finish(ctx);
  return doc;
}

export async function deliverRepair(id, input) {
  Auth.require('repair.manage');
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const r = await t.get('repairs', id);
    if (!r) throw new AppError('Job not found.');
    if (TERMINAL.includes(r.status)) throw new AppError('This job is already closed.');
    const calc = calcRepair(r.parts, r.labour);
    if (!(calc.total > 0)) throw new AppError('Enter the repair charges before delivering the phone.');
    const date = input.date || today();
    const acc = await paymentAccount(t, input.accountId);
    const due = round2(calc.total - r.paid);
    let pay = round2(num(input.pay));
    let credit = 0;
    if (due >= 0) {
      if (pay < 0 || pay > due + 0.001) throw new AppError('Payment cannot be more than the amount due.');
      pay = Math.min(pay, due);
      credit = round2(due - pay);
      if (credit > 0.001 && !input.customerId && !r.customerId) throw new AppError('Select a customer to leave a balance, or collect the full amount.');
      if (pay > 0) await repairPay(t, r, { amount: pay, accountId: acc.id, accountName: acc.name, kind: 'final', date });
    } else {
      await repairPay(t, r, { amount: due, accountId: acc.id, accountName: acc.name, kind: 'refund', date });
    }
    let customerId = null;
    if (credit > 0.001) {
      customerId = input.customerId || r.customerId;
      if (!(await t.get('customers', customerId))) throw new AppError('Customer not found.');
      r.customerId = customerId; ctx.parties.push(['customers', customerId]);
    }
    const docRef = { id: r.id, number: r.number, date };
    let partsCost = 0; const extra = [];
    for (const l of calc.lines) {
      let cost = l.cost;
      if (l.productId) {
        const p = await moveStock(t, ctx, { productId: l.productId, qty: -l.qty, type: 'repair', doc: docRef, note: 'Used in ' + r.number });
        cost = round2(p.purchasePrice || 0);
      } else if (l.outsideCash && l.cost > 0) {
        extra.push(['repair_parts', round2(l.qty * l.cost), 0, 'Part bought for ' + r.number], ['cash', 0, round2(l.qty * l.cost), 'Part bought for ' + r.number]);
      }
      l.cost = cost; partsCost = round2(partsCost + l.qty * cost);
    }
    await addEntries(t, docRef, 'repair', [
      ['repair_advance', r.paid, 0, 'Repair completed'],
      ...(credit > 0.001 ? [[partyAccount('customers', customerId), credit, 0, 'Repair balance']] : []),
      ['repair_income', 0, calc.total, 'Repair ' + r.number], ...extra,
    ]);
    Object.assign(r, { parts: calc.lines, total: calc.total, partsCost, status: 'delivered', deliveredAt: nowISO(), deliveredDate: date, balance: credit, updatedAt: nowISO() });
    repHist(r, 'delivered', credit > 0.001 ? `Delivered with balance ${credit}` : 'Delivered');
    await t.put('repairs', r);
    await audit(t, 'repair_delivered', { number: r.number, total: calc.total });
    return r;
  });
  await finish(ctx);
  return doc;
}

export async function cancelRepair(id, input = {}) {
  Auth.require('repair.manage');
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const r = await t.get('repairs', id);
    if (!r) throw new AppError('Job not found.');
    if (TERMINAL.includes(r.status)) throw new AppError('This job is already closed.');
    const date = input.date || today();
    const fee = Math.min(round2(num(input.fee)), r.paid);
    if (fee < 0) throw new AppError('Fee cannot be negative.');
    if (r.paid > 0) {
      const acc = await paymentAccount(t, input.accountId);
      if (r.paid - fee > 0) await repairPay(t, r, { amount: -(r.paid - fee), accountId: acc.id, accountName: acc.name, kind: 'refund', date });
      if (fee > 0) await addEntries(t, { id: `${r.id}:fee`, number: r.number, date }, 'repair', [['repair_advance', fee, 0, 'Inspection fee'], ['repair_income', 0, fee, 'Inspection fee ' + r.number]]);
    }
    r.status = 'cancelled'; r.cancelledAt = nowISO(); r.cancelReason = clean(input.reason, 200); r.updatedAt = nowISO();
    repHist(r, 'cancelled', r.cancelReason || 'Cancelled');
    await t.put('repairs', r);
    await audit(t, 'repair_cancelled', { number: r.number });
    return r;
  });
  await finish(ctx);
  return doc;
}

// Reopen a delivered job (e.g. warranty comeback or wrong delivery): revenue and stock use are reversed, advances stay.
export async function reopenRepair(id) {
  Auth.require('repair.manage');
  const ctx = newCtx();
  const doc = await idb.write(REPAIR_STORES, async (t) => {
    const r = await t.get('repairs', id);
    if (!r || r.status !== 'delivered') throw new AppError('Only a delivered job can be reopened.');
    await revertDoc(t, ctx, id);
    Object.assign(r, { status: 'ready', deliveredAt: null, deliveredDate: null, balance: 0, partsCost: 0, updatedAt: nowISO() });
    repHist(r, 'ready', 'Reopened after delivery');
    await t.put('repairs', r);
    await audit(t, 'repair_reopened', { number: r.number });
    if (r.customerId) ctx.parties.push(['customers', r.customerId]);
    return r;
  });
  await finish(ctx);
  return doc;
}

// ---------- WALLET / LOAD / BILL SERVICES (Easypaisa, JazzCash, easyload …) ----------
export async function saveService(input) {
  Auth.require('service.create');
  const def = SERVICE_TYPES[input.type];
  if (!def) throw new AppError('Select the service type.');
  const amount = round2(num(input.amount)); const fee = round2(num(input.fee)); const commission = round2(num(input.commission));
  if (!(amount > 0)) throw new AppError('Amount must be greater than zero.');
  if (fee < 0 || commission < 0) throw new AppError('Fee and commission cannot be negative.');
  if (!input.walletId) throw new AppError('Select the wallet / load account.');
  const ctx = newCtx();
  const doc = await idb.write(['services', 'entries', 'meta', 'accounts', 'auditLog'], async (t) => {
    const existing = await t.get('services', input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const wallet = await t.get('accounts', input.walletId);
    if (!wallet || wallet.type !== 'bank' || !wallet.active) throw new AppError('Select a valid wallet account.');
    const cash = await paymentAccount(t, input.cashAccountId || 'cash');
    if (cash.id === wallet.id) throw new AppError('Cash account and wallet must be different.');
    const number = await nextNumber(t, 'service');
    const d = { id: input.id, number, date: input.date || today(), createdAt: nowISO(), type: input.type, typeLabel: def.short, dir: def.dir,
      walletId: wallet.id, walletName: wallet.name, cashAccountId: cash.id, cashAccountName: cash.name, amount, fee, commission, income: round2(fee + commission),
      customerName: clean(input.customerName, 100), customerNumber: clean(input.customerNumber, 40), reference: clean(input.reference, 60), billKind: clean(input.billKind, 60),
      note: clean(input.note, 300), status: 'completed', ...stamp() };
    await t.add('services', d);
    const memo = `${def.short} ${wallet.name}`;
    const lines = def.dir === 'out'
      ? [[cash.id, amount + fee, 0, memo], [wallet.id, 0, amount, memo], ['service_income', 0, fee, 'Service fee']]
      : [[wallet.id, amount + fee, 0, memo], [cash.id, 0, amount, memo], ['service_income', 0, fee, 'Service fee']];
    if (commission > 0) lines.push([wallet.id, commission, 0, 'Commission'], ['service_income', 0, commission, 'Commission']);
    await addEntries(t, d, 'service', lines);
    await audit(t, 'service_created', { number, type: input.type, amount });
    return d;
  });
  await finish(ctx);
  return { doc, duplicate: ctx.duplicate };
}


// ---------- MASTER DATA ----------
async function setOpening(t, txnId, accountId, debitAmount, date, label) {
  await t.deleteByIndex('entries', 'txnId', txnId);
  const amt = round2(debitAmount);
  if (!amt) return;
  const doc = { id: txnId, number: 'OPENING', date: date || today() };
  await addEntries(t, doc, 'opening', amt > 0 ? [[accountId, amt, 0, label], ['equity', 0, amt, label]] : [[accountId, 0, -amt, label], ['equity', -amt, 0, label]]);
}

export async function saveParty(kind, data) {
  Auth.require(kind === 'customers' ? 'party.edit' : 'purchase.manage');
  const name = clean(data.name, 120);
  if (!name) throw new AppError('Name is required.');
  const email = clean(data.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address.');
  const opening = round2(num(data.openingBalance));
  const id = data.id || uuid();
  const now = nowISO();
  const rec = await idb.write([kind, 'entries', 'auditLog'], async (t) => {
    const old = data.id ? await t.get(kind, id) : null;
    const r = { ...(old || { createdAt: now }), id, name, nameLc: lc(name), phone: clean(data.phone, 40), email, address: clean(data.address, 300),
      note: clean(data.note, 500), openingBalance: opening, openingDate: data.openingDate || old?.openingDate || today(), active: data.active === false ? 0 : 1, updatedAt: now };
    await t.put(kind, r);
    const acc = partyAccount(kind, id);
    // Customers: opening = receivable (debit). Suppliers: opening = payable (credit).
    await setOpening(t, 'open:' + acc, acc, kind === 'customers' ? opening : -opening, r.openingDate, 'Opening balance');
    await audit(t, (old ? 'update_' : 'create_') + kind.slice(0, -1), { name });
    return r;
  });
  await Catalog.refreshParty(kind, id);
  document.dispatchEvent(new CustomEvent('data:changed'));
  return rec;
}

export async function deleteParty(kind, id) {
  Auth.require('party.delete');
  const acc = partyAccount(kind, id);
  const res = await idb.write([kind, 'entries', 'sales', 'purchases', 'auditLog'], async (t) => {
    const p = await t.get(kind, id);
    if (!p) throw new AppError('Not found.');
    const used = (await t.getAllByIndex('entries', 'accountId', acc)).some((e) => e.refType !== 'opening')
      || (await t.countByIndex(kind === 'customers' ? 'sales' : 'purchases', kind === 'customers' ? 'customerId' : 'supplierId', id)) > 0;
    if (used) {
      p.active = 0; p.updatedAt = nowISO(); await t.put(kind, p);
      await audit(t, 'deactivate_' + kind.slice(0, -1), { name: p.name });
      return 'deactivated';
    }
    await t.deleteByIndex('entries', 'txnId', 'open:' + acc);
    await t.delete(kind, id);
    await audit(t, 'delete_' + kind.slice(0, -1), { name: p.name });
    return 'deleted';
  });
  await Catalog.refreshParty(kind, id);
  document.dispatchEvent(new CustomEvent('data:changed'));
  return res;
}

export async function saveAccount(data) {
  Auth.require('account.manage');
  const id = data.id || uuid();
  const now = nowISO();
  const rec = await idb.write(['accounts', 'entries', 'auditLog'], async (t) => {
    const old = data.id ? await t.get('accounts', id) : null;
    const type = old?.system ? old.type : data.type;
    if (!ACCOUNT_TYPES[type]) throw new AppError('Select an account type.');
    const name = old?.system ? old.name : clean(data.name, 80);
    if (!name) throw new AppError('Account name is required.');
    const opening = round2(num(data.openingBalance));
    const r = { ...(old || { createdAt: now, system: false }), id, name, type, note: clean(data.note, 300), openingBalance: opening,
      openingDate: data.openingDate || old?.openingDate || today(), active: old?.system ? 1 : (data.active === false ? 0 : 1), updatedAt: now };
    await t.put('accounts', r);
    if (!['income', 'expense'].includes(type) && id !== 'equity') {
      await setOpening(t, 'open:' + id, id, isDebitNormal(type) ? opening : -opening, r.openingDate, 'Opening balance');
    }
    await audit(t, old ? 'update_account' : 'create_account', { name });
    return r;
  });
  document.dispatchEvent(new CustomEvent('data:changed'));
  return rec;
}

export async function deleteAccount(id) {
  Auth.require('account.manage');
  return idb.write(['accounts', 'entries', 'auditLog'], async (t) => {
    const a = await t.get('accounts', id);
    if (!a) throw new AppError('Account not found.');
    if (a.system) throw new AppError('System accounts cannot be deleted.');
    const used = (await t.getAllByIndex('entries', 'accountId', id)).some((e) => e.refType !== 'opening');
    if (used) { a.active = 0; a.updatedAt = nowISO(); await t.put('accounts', a); await audit(t, 'deactivate_account', { name: a.name }); return 'deactivated'; }
    await t.deleteByIndex('entries', 'txnId', 'open:' + id);
    await t.delete('accounts', id);
    await audit(t, 'delete_account', { name: a.name });
    return 'deleted';
  });
}

export async function saveCategory(data) {
  Auth.require('product.edit');
  const name = clean(data.name, 80);
  if (!name) throw new AppError('Category name is required.');
  const id = data.id || uuid();
  await idb.write(['categories'], async (t) => {
    const dup = (await t.getAllByIndex('categories', 'nameLc', lc(name))).find((c) => c.id !== id);
    if (dup) throw new AppError('A category with this name already exists.');
    const old = data.id ? await t.get('categories', id) : null;
    await t.put('categories', { ...(old || { createdAt: nowISO() }), id, name, nameLc: lc(name), updatedAt: nowISO() });
  });
  await Catalog.refreshCategories();
  return id;
}
export async function deleteCategory(id) {
  Auth.require('product.edit');
  await idb.write(['categories', 'products'], async (t) => {
    if (await t.countByIndex('products', 'categoryId', id)) throw new AppError('This category is used by products. Reassign them first.');
    await t.delete('categories', id);
  });
  await Catalog.refreshCategories();
}

export async function saveProduct(data) {
  Auth.require('product.edit');
  const name = clean(data.name, 150);
  if (!name) throw new AppError('Product name is required.');
  const id = data.id || uuid();
  const sku = clean(data.sku, 60); const barcode = clean(data.barcode, 60);
  const salePrice = round2(num(data.salePrice)); const purchasePrice = round2(num(data.purchasePrice));
  const wholesalePrice = round2(num(data.wholesalePrice));
  if (salePrice < 0 || purchasePrice < 0 || wholesalePrice < 0) throw new AppError('Prices cannot be negative.');
  const openingStock = round3(num(data.openingStock));
  const ctx = newCtx();
  const rec = await idb.write(['products', 'stockMoves', 'auditLog'], async (t) => {
    if (barcode) {
      const dup = (await t.getAllByIndex('products', 'barcode', barcode)).find((p) => p.id !== id);
      if (dup) throw new AppError(`Barcode already used by "${dup.name}".`);
    }
    if (sku) {
      const dup = (await t.getAllByIndex('products', 'sku', sku)).find((p) => p.id !== id);
      if (dup) throw new AppError(`SKU already used by "${dup.name}".`);
    }
    const old = data.id ? await t.get('products', id) : null;
    if (data.id && !old) throw new AppError('Product not found.');
    const now = nowISO();
    const trackStock = data.trackStock !== false;
    const p = { ...(old || { createdAt: now, stock: 0 }), id, name, nameLc: lc(name), sku, barcode, categoryId: data.categoryId || '', unit: clean(data.unit, 20) || 'pcs',
      purchasePrice, salePrice, wholesalePrice, minStock: round3(num(data.minStock)), openingStock: trackStock ? openingStock : 0, trackStock,
      image: data.image === undefined ? (old?.image || '') : data.image, active: data.active === false ? 0 : 1, updatedAt: now };
    const openRef = 'open:' + id;
    const [openMove] = await t.getAllByIndex('stockMoves', 'refId', openRef);
    const newOpening = trackStock ? openingStock : 0;
    const delta = round3(newOpening - (openMove?.qty || 0));
    p.stock = round3((p.stock || 0) + delta);
    await t.put('products', p);
    if (openMove) await t.delete('stockMoves', openMove.id);
    if (newOpening) {
      await t.add('stockMoves', { id: uuid(), productId: id, date: openMove?.date || today(), qty: newOpening, type: 'opening', refId: openRef, refNo: 'OPENING', cost: purchasePrice, note: 'Opening stock', createdAt: now });
    }
    ctx.touched.add(id);
    await audit(t, old ? 'update_product' : 'create_product', { name });
    return p;
  });
  await finish(ctx);
  return rec;
}

export async function deleteProduct(id) {
  Auth.require('product.delete');
  const ctx = newCtx();
  const res = await idb.write(['products', 'stockMoves', 'saleItems', 'purchaseItems', 'auditLog'], async (t) => {
    const p = await t.get('products', id);
    if (!p) throw new AppError('Product not found.');
    const moves = await t.getAllByIndex('stockMoves', 'productId', id);
    const used = moves.some((m) => m.type !== 'opening') || await t.countByIndex('saleItems', 'productId', id) || await t.countByIndex('purchaseItems', 'productId', id);
    ctx.touched.add(id);
    if (used) { p.active = 0; p.updatedAt = nowISO(); await t.put('products', p); await audit(t, 'deactivate_product', { name: p.name }); return 'deactivated'; }
    for (const m of moves) await t.delete('stockMoves', m.id);
    await t.delete('products', id);
    await audit(t, 'delete_product', { name: p.name });
    return 'deleted';
  });
  await finish(ctx);
  return res;
}

// ---------- STOCK ADJUSTMENTS ----------
export async function saveAdjustment(input) {
  Auth.require('stock.adjust');
  const lines = (input.lines || []).map((l) => ({ ...l, qty: round3(num(l.qty)) })).filter((l) => l.qty !== 0);
  if (!lines.length) throw new AppError('Add at least one product with a non-zero quantity change.');
  const ctx = newCtx();
  const doc = await idb.write(['adjustments', 'products', 'stockMoves', 'meta', 'auditLog'], async (t) => {
    const existing = await t.get('adjustments', input.id);
    if (existing) { ctx.duplicate = true; return existing; }
    const number = await nextNumber(t, 'adjustment');
    const d = { id: input.id, number, date: input.date || today(), createdAt: nowISO(), reason: clean(input.reason, 60) || 'Adjustment', note: clean(input.note, 500), items: [], status: 'completed', ...stamp() };
    for (const l of lines) {
      const p = await t.get('products', l.productId);
      if (!p) throw new AppError('Product not found.');
      if (p.trackStock === false) throw new AppError(`"${p.name}" does not track stock.`);
      d.items.push({ productId: p.id, name: p.name, unit: p.unit, qty: l.qty, before: p.stock, cost: p.purchasePrice || 0 });
      await moveStock(t, ctx, { productId: p.id, qty: l.qty, type: 'adjust', doc: d, cost: p.purchasePrice, note: d.reason });
    }
    await t.add('adjustments', d);
    await audit(t, 'stock_adjustment', { number, lines: lines.length });
    return d;
  });
  await finish(ctx);
  return { doc, duplicate: ctx.duplicate };
}

// ---------- HELD SALES ----------
export const saveHold = (hold) => idb.write(['holds'], (t) => t.put('holds', { ...hold, createdAt: hold.createdAt || nowISO() }));
export const deleteHold = (id) => idb.write(['holds'], (t) => t.delete('holds', id));

// ---------- BALANCES & LEDGERS (always derived from entries) ----------
export async function allBalances() {
  const map = new Map();
  await idb.each('entries', null, null, (e) => {
    const b = map.get(e.accountId) || { debit: 0, credit: 0 };
    b.debit += e.debit; b.credit += e.credit; map.set(e.accountId, b);
  });
  for (const b of map.values()) { b.debit = round2(b.debit); b.credit = round2(b.credit); b.balance = round2(b.debit - b.credit); }
  return map;
}

export async function accountBalance(accountId, uptoDate = '9999-12-31') {
  const rows = await idb.getAllByIndex('entries', 'acctDate', IDBKeyRange.bound([accountId, ''], [accountId, uptoDate]));
  return round2(rows.reduce((s, e) => s + e.debit - e.credit, 0));
}

// Ledger rows with running balance (debit - credit).
export async function ledger(accountId, from, to) {
  const [before, rows] = await idb.read(['entries'], (t) => Promise.all([
    t.getAllByIndex('entries', 'acctDate', IDBKeyRange.bound([accountId, ''], [accountId, from], false, true)),
    t.getAllByIndex('entries', 'acctDate', IDBKeyRange.bound([accountId, from], [accountId, to])),
  ]));
  const opening = round2(before.reduce((s, e) => s + e.debit - e.credit, 0));
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  let run = opening;
  for (const r of rows) { run = round2(run + r.debit - r.credit); r.running = run; }
  return { opening, rows, closing: run, debit: round2(rows.reduce((s, r) => s + r.debit, 0)), credit: round2(rows.reduce((s, r) => s + r.credit, 0)) };
}

// ---------- MAINTENANCE ----------
export async function rebuildStock() {
  Auth.require('settings.manage');
  const fixed = [];
  const ctx = newCtx();
  await idb.write(['products', 'stockMoves'], async (t) => {
    const moves = await t.getAll('stockMoves');
    const sums = {};
    for (const m of moves) sums[m.productId] = round3((sums[m.productId] || 0) + m.qty);
    for (const p of await t.getAll('products')) {
      if (p.trackStock === false) continue;
      const s = sums[p.id] || 0;
      if (Math.abs((p.stock || 0) - s) > EPS) { fixed.push({ name: p.name, was: p.stock, now: s }); p.stock = s; await t.put('products', p); ctx.touched.add(p.id); }
    }
  });
  await finish(ctx);
  return fixed;
}

export async function integrityCheck() {
  const issues = [];
  const [entries, products, moves] = await idb.read(['entries', 'products', 'stockMoves'], (t) => Promise.all([t.getAll('entries'), t.getAll('products'), t.getAll('stockMoves')]));
  const byTxn = {};
  for (const e of entries) { const b = byTxn[e.txnId] || (byTxn[e.txnId] = { d: 0, c: 0, ref: e.refNo }); b.d += e.debit; b.c += e.credit; }
  for (const [txn, b] of Object.entries(byTxn)) if (Math.abs(b.d - b.c) > 0.009) issues.push(`Unbalanced ledger for ${b.ref || txn}: Dr ${round2(b.d)} / Cr ${round2(b.c)}`);
  const sums = {};
  for (const m of moves) sums[m.productId] = round3((sums[m.productId] || 0) + m.qty);
  for (const p of products) if (p.trackStock !== false && Math.abs((p.stock || 0) - (sums[p.id] || 0)) > EPS) issues.push(`Stock mismatch for "${p.name}": cached ${p.stock}, ledger ${sums[p.id] || 0}`);
  return { issues, checked: { entries: entries.length, products: products.length, stockMoves: moves.length } };
}
