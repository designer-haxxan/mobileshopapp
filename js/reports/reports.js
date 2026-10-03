// Reports. Every figure is computed from transaction records (documents, entries, stock moves).
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtDate, fmtTime, today, monthStart, round2, round3, toCSV, downloadFile } from '../core/utils.js';
import { money, balText, ledgerTable, REF_LABELS, rangeFor } from '../core/views.js';
import { getSettings } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import { printHTML } from '../printer/printer.js';
import { CONDITIONS, PTA, DEVICE_STATUS, deviceName } from '../core/mobile.js';

const $ = window.jQuery;
const live = (x) => x.filter((d) => d.status !== 'void');
const byDate = (store, from, to) => idb.getAllByIndex(store, 'date', IDBKeyRange.bound(from, to));
const sum = (arr, f) => round2(arr.reduce((s, x) => s + ((typeof f === 'function' ? f(x) : x[f]) || 0), 0));

// Column helpers: [label, type] where type ∈ text|money|qty|date
const C = (label, type = 'text') => ({ label, type });

async function cashAccounts() { return (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type)); }

function docRows(docs, partyKey, route) {
  return docs.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)).map((d) => [
    { v: d.number, href: `#/${route}/${d.id}` }, d.date, d[partyKey], d.discount || 0, d.tax || 0, d.total, d.paid, d.balance]);
}
const docCols = (party) => [C('No'), C('Date', 'date'), C(party), C('Discount', 'money'), C('Tax', 'money'), C('Total', 'money'), C('Paid', 'money'), C('Balance', 'money')];
const docFoot = (docs) => ['Total', '', `${docs.length} docs`, sum(docs, 'discount'), sum(docs, 'tax'), sum(docs, 'total'), sum(docs, 'paid'), sum(docs, 'balance')];

async function ledgerReport(accountId, from, to, debitNormal, title) {
  const led = await Posting.ledger(accountId, from, to);
  return {
    summary: [['Opening', balText(led.opening, debitNormal)], ['Debits', money(led.debit)], ['Credits', money(led.credit)], ['Closing', balText(led.closing, debitNormal)]],
    html: ledgerTable(led, { debitNormal }),
    csv: [['Date', 'Ref', 'Type', 'Details', 'Debit', 'Credit', 'Balance'], ['', '', '', 'Opening', '', '', led.opening],
      ...led.rows.map((e) => [e.date, e.refNo, REF_LABELS[e.refType] || e.refType, e.memo, e.debit, e.credit, e.running]), ['', '', '', 'Closing', led.debit, led.credit, led.closing]],
    title,
  };
}

async function partyBalances(kind, asOf) {
  const prefix = kind === 'customers' ? 'C:' : 'S:';
  const map = new Map();
  await idb.each('entries', null, null, (e) => { if (e.accountId.startsWith(prefix) && e.date <= asOf) map.set(e.accountId, (map.get(e.accountId) || 0) + e.debit - e.credit); });
  const rows = [];
  for (const [acc, b] of map) {
    const bal = round2(kind === 'customers' ? b : -b);
    if (Math.abs(bal) < 0.005) continue;
    const p = Catalog.party(kind, acc.slice(2));
    rows.push([{ v: p?.name || acc, href: `#/${kind}/${acc.slice(2)}` }, p?.phone || '', bal]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  return rows;
}

export const REPORTS = {
  'daily-sales': {
    title: 'Daily sales', icon: 'calendar-day', group: 'Sales', filters: ['date'],
    async run({ date }) {
      const [sales, rets] = await Promise.all([byDate('sales', date, date), byDate('saleReturns', date, date)]);
      const s = live(sales); const r = live(rets);
      return {
        summary: [['Invoices', s.length], ['Gross sales', money(sum(s, 'total'))], ['Discounts', money(sum(s, 'discount'))], ['Tax', money(sum(s, 'tax'))],
          ['Collected', money(sum(s, 'paid'))], ['On credit', money(sum(s, 'balance'))], ['Returns', money(sum(r, 'total'))], ['Net sales', money(sum(s, 'total') - sum(r, 'total'))]],
        cols: [C('No'), C('Time'), C('Customer'), C('Pay via'), C('Total', 'money'), C('Paid', 'money'), C('Balance', 'money')],
        rows: s.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((d) => [{ v: d.number, href: `#/sales/${d.id}` }, fmtTime(d.createdAt), d.customerName, d.paymentAccountName, d.total, d.paid, d.balance]),
        foot: ['Total', '', '', '', sum(s, 'total'), sum(s, 'paid'), sum(s, 'balance')],
      };
    },
  },
  sales: {
    title: 'Sales by date range', icon: 'receipt', group: 'Sales', filters: ['range', 'customer'],
    async run({ from, to, customer }) {
      const docs = live(await byDate('sales', from, to)).filter((d) => !customer || d.customerId === customer);
      return { summary: [['Invoices', docs.length], ['Total', money(sum(docs, 'total'))], ['Paid', money(sum(docs, 'paid'))], ['Due', money(sum(docs, 'balance'))]],
        cols: docCols('Customer'), rows: docRows(docs, 'customerName', 'sales'), foot: docFoot(docs) };
    },
  },
  'sale-returns': {
    title: 'Sales returns', icon: 'arrow-return-left', group: 'Sales', filters: ['range'],
    async run({ from, to }) {
      const docs = live(await byDate('saleReturns', from, to)).sort((a, b) => a.date.localeCompare(b.date));
      return { summary: [['Returns', docs.length], ['Total', money(sum(docs, 'total'))], ['Refunded', money(sum(docs, 'refund'))]],
        cols: [C('No'), C('Date', 'date'), C('Invoice'), C('Customer'), C('Items'), C('Total', 'money'), C('Refund', 'money')],
        rows: docs.map((d) => [{ v: d.number, href: `#/returns/sale/${d.id}` }, d.date, d.docNo, d.partyName, d.items.map((i) => `${i.name} ×${fmtQty(i.qty)}`).join(', '), d.total, d.refund]),
        foot: ['Total', '', '', '', '', sum(docs, 'total'), sum(docs, 'refund')] };
    },
  },
  'product-sales': {
    title: 'Product-wise sales', icon: 'box-seam', group: 'Sales', filters: ['range'],
    async run({ from, to }) {
      const [items, rets] = await Promise.all([byDate('saleItems', from, to), byDate('saleReturns', from, to)]);
      const map = new Map();
      const g = (id, name) => map.get(id) || (map.set(id, { name, qty: 0, amount: 0, cost: 0, rqty: 0, ramount: 0, rcost: 0 }), map.get(id));
      for (const i of items) { const x = g(i.productId, i.name); x.qty += i.qty; x.amount += i.amount; x.cost += i.qty * i.cost; }
      for (const r of live(rets)) for (const i of r.items) { const x = g(i.productId, i.name); x.rqty += i.qty; x.ramount += i.lineAmount ?? i.amount; x.rcost += i.qty * i.cost; }
      const rows = [...map.entries()].map(([id, x]) => {
        const net = round2(x.amount - x.ramount); const cost = round2(x.cost - x.rcost);
        return [{ v: x.name, href: `#/stock/${id}` }, round3(x.qty), round3(x.rqty), round3(x.qty - x.rqty), net, cost, round2(net - cost)];
      }).sort((a, b) => b[4] - a[4]);
      const canProfit = Auth.can('reports.profit');
      const cols = [C('Product'), C('Sold', 'qty'), C('Returned', 'qty'), C('Net qty', 'qty'), C('Net amount', 'money')];
      if (canProfit) cols.push(C('Cost', 'money'), C('Profit', 'money'));
      return { summary: [['Products', rows.length], ['Net amount', money(sum(rows, (r) => r[4]))], ...(canProfit ? [['Gross profit', money(sum(rows, (r) => r[6]))]] : [])],
        note: 'Amounts are line amounts before bill-level discount and tax.',
        cols, rows: canProfit ? rows : rows.map((r) => r.slice(0, 5)) };
    },
  },
  purchases: {
    title: 'Purchases', icon: 'bag', group: 'Purchases', perm: 'purchase.manage', filters: ['range', 'supplier'],
    async run({ from, to, supplier }) {
      const docs = live(await byDate('purchases', from, to)).filter((d) => !supplier || d.supplierId === supplier);
      return { summary: [['Purchases', docs.length], ['Total', money(sum(docs, 'total'))], ['Paid', money(sum(docs, 'paid'))], ['Due', money(sum(docs, 'balance'))]],
        cols: docCols('Supplier'), rows: docRows(docs, 'supplierName', 'purchases'), foot: docFoot(docs) };
    },
  },
  'purchase-returns': {
    title: 'Purchase returns', icon: 'arrow-return-right', group: 'Purchases', perm: 'purchase.manage', filters: ['range'],
    async run({ from, to }) {
      const docs = live(await byDate('purchaseReturns', from, to)).sort((a, b) => a.date.localeCompare(b.date));
      return { summary: [['Returns', docs.length], ['Total', money(sum(docs, 'total'))], ['Refund received', money(sum(docs, 'refund'))]],
        cols: [C('No'), C('Date', 'date'), C('Purchase'), C('Supplier'), C('Items'), C('Total', 'money'), C('Refund', 'money')],
        rows: docs.map((d) => [{ v: d.number, href: `#/returns/purchase/${d.id}` }, d.date, d.docNo, d.partyName, d.items.map((i) => `${i.name} ×${fmtQty(i.qty)}`).join(', '), d.total, d.refund]),
        foot: ['Total', '', '', '', '', sum(docs, 'total'), sum(docs, 'refund')] };
    },
  },
  'product-purchases': {
    title: 'Product-wise purchases', icon: 'boxes', group: 'Purchases', perm: 'purchase.manage', filters: ['range'],
    async run({ from, to }) {
      const [items, rets] = await Promise.all([byDate('purchaseItems', from, to), byDate('purchaseReturns', from, to)]);
      const map = new Map();
      const g = (id, name) => map.get(id) || (map.set(id, { name, qty: 0, amount: 0, rqty: 0, ramount: 0 }), map.get(id));
      for (const i of items) { const x = g(i.productId, i.name); x.qty += i.qty; x.amount += i.amount; }
      for (const r of live(rets)) for (const i of r.items) { const x = g(i.productId, i.name); x.rqty += i.qty; x.ramount += i.lineAmount ?? i.amount; }
      const rows = [...map.entries()].map(([id, x]) => [{ v: x.name, href: `#/stock/${id}` }, round3(x.qty), round3(x.rqty), round3(x.qty - x.rqty), round2(x.amount - x.ramount), x.qty - x.rqty ? round2((x.amount - x.ramount) / (x.qty - x.rqty)) : 0]).sort((a, b) => b[4] - a[4]);
      return { summary: [['Products', rows.length], ['Net amount', money(sum(rows, (r) => r[4]))]],
        cols: [C('Product'), C('Purchased', 'qty'), C('Returned', 'qty'), C('Net qty', 'qty'), C('Net amount', 'money'), C('Avg rate', 'money')], rows };
    },
  },
  'customer-ledger': {
    title: 'Customer ledger', icon: 'person-lines-fill', group: 'Parties', filters: ['range', 'customer*'],
    run: async ({ from, to, customer }) => ledgerReport('C:' + customer, from, to, true, Catalog.party('customers', customer)?.name),
  },
  'supplier-ledger': {
    title: 'Supplier ledger', icon: 'truck', group: 'Parties', perm: 'purchase.manage', filters: ['range', 'supplier*'],
    run: async ({ from, to, supplier }) => ledgerReport('S:' + supplier, from, to, false, Catalog.party('suppliers', supplier)?.name),
  },
  receivables: {
    title: 'Receivables', icon: 'person-down', group: 'Parties', filters: ['asof'],
    async run({ date }) {
      const rows = await partyBalances('customers', date);
      return { summary: [['Customers', rows.length], ['Total receivable', money(sum(rows, (r) => Math.max(0, r[2])))], ['Advances', money(-sum(rows, (r) => Math.min(0, r[2])))]],
        cols: [C('Customer'), C('Phone'), C('Balance', 'money')], rows, foot: ['Total', '', sum(rows, (r) => r[2])] };
    },
  },
  payables: {
    title: 'Payables', icon: 'cash-stack', group: 'Parties', perm: 'purchase.manage', filters: ['asof'],
    async run({ date }) {
      const rows = await partyBalances('suppliers', date);
      return { summary: [['Suppliers', rows.length], ['Total payable', money(sum(rows, (r) => Math.max(0, r[2])))], ['Advances paid', money(-sum(rows, (r) => Math.min(0, r[2])))]],
        cols: [C('Supplier'), C('Phone'), C('Balance', 'money')], rows, foot: ['Total', '', sum(rows, (r) => r[2])] };
    },
  },
  'cash-book': {
    title: 'Cash book', icon: 'journal-text', group: 'Accounts', filters: ['range', 'cashAccount'],
    run: async ({ from, to, account }) => ledgerReport(account || 'cash', from, to, true, (await idb.get('accounts', account || 'cash'))?.name),
  },
  'account-ledger': {
    title: 'Account ledger', icon: 'bank', group: 'Accounts', perm: 'account.manage', filters: ['range', 'account'],
    async run({ from, to, account }) {
      const a = await idb.get('accounts', account || 'cash');
      return ledgerReport(a.id, from, to, Posting.isDebitNormal(a.type), a.name);
    },
  },
  'daily-closing': {
    title: 'Daily closing', icon: 'door-closed', group: 'Accounts', filters: ['date'],
    async run({ date }) {
      const [sales, rets, vouchers, purchases] = await Promise.all([byDate('sales', date, date), byDate('saleReturns', date, date), byDate('vouchers', date, date), byDate('purchases', date, date)]);
      const s = live(sales); const v = live(vouchers);
      const rows = [];
      for (const a of await cashAccounts()) {
        const led = await Posting.ledger(a.id, date, date);
        if (!led.rows.length && Math.abs(led.opening) < 0.005) continue;
        rows.push([{ v: a.name, href: Auth.can('account.manage') ? `#/accounts/${a.id}` : null }, led.opening, led.debit, led.credit, led.closing]);
      }
      return {
        summary: [['Invoices', s.length], ['Sales', money(sum(s, 'total'))], ['Cash/bank sales', money(sum(s, 'paid'))], ['Credit sales', money(sum(s, 'balance'))],
          ['Sale returns', money(sum(live(rets), 'total'))], ['Purchases', money(sum(live(purchases), 'total'))],
          ['Receipts', money(sum(v.filter((x) => x.type === 'receipt'), 'amount'))], ['Payments', money(sum(v.filter((x) => x.type === 'payment'), 'amount'))]],
        cols: [C('Cash / bank account'), C('Opening', 'money'), C('In', 'money'), C('Out', 'money'), C('Closing', 'money')], rows,
        foot: ['Total', sum(rows, (r) => r[1]), sum(rows, (r) => r[2]), sum(rows, (r) => r[3]), sum(rows, (r) => r[4])],
      };
    },
  },
  stock: {
    title: 'Stock report', icon: 'clipboard-data', group: 'Inventory', filters: ['asof'],
    async run({ date }) {
      const qty = new Map();
      await idb.each('stockMoves', 'date', IDBKeyRange.upperBound(date), (m) => qty.set(m.productId, round3((qty.get(m.productId) || 0) + m.qty)));
      const rows = Catalog.allProducts().filter((p) => p.trackStock !== false && (p.active || qty.get(p.id))).sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => { const q = qty.get(p.id) || 0; return [{ v: p.name, href: `#/stock/${p.id}` }, Catalog.category(p.categoryId)?.name || '', q, p.purchasePrice || 0, round2(q * (p.purchasePrice || 0)), round2(q * (p.salePrice || 0))]; });
      return { summary: [['Products', rows.length], ['Total qty', fmtQty(sum(rows, (r) => r[2]))], ['Value at cost', money(sum(rows, (r) => r[4]))], ['Value at sale price', money(sum(rows, (r) => r[5]))]],
        note: 'Quantities are calculated from stock movements up to the selected date; values use current prices.',
        cols: [C('Product'), C('Category'), C('Qty', 'qty'), C('Cost', 'money'), C('Value', 'money'), C('Sale value', 'money')], rows,
        foot: ['Total', '', sum(rows, (r) => r[2]), '', sum(rows, (r) => r[4]), sum(rows, (r) => r[5])] };
    },
  },
  'phone-stock': {
    title: 'Phone stock (IMEI)', icon: 'phone', group: 'Mobile shop', filters: [],
    async run() {
      const list = (await idb.getAllByIndex('devices', 'status', 'in_stock')).sort((a, b) => (a.purchaseDate || '').localeCompare(b.purchaseDate || ''));
      const days = (d) => Math.max(0, Math.floor((Date.now() - new Date((d.purchaseDate || today()) + 'T00:00:00')) / 86400000));
      const rows = list.map((d) => [{ v: deviceName(d), href: '#/phones/' + d.id }, d.imei1, CONDITIONS[d.condition]?.short || '', PTA[d.pta]?.short || '', days(d), d.costTotal || 0, d.salePrice || 0, round2((d.salePrice || 0) - (d.costTotal || 0))]);
      return { summary: [['Phones in stock', rows.length], ['Cost value', money(sum(list, 'costTotal'))], ['Selling value', money(sum(list, 'salePrice'))], ['Expected profit', money(sum(rows, (r) => r[7]))]],
        note: 'Oldest stock first. Days = days since you bought the phone.',
        cols: [C('Phone'), C('IMEI'), C('Condition'), C('PTA'), C('Days', 'qty'), C('Cost', 'money'), C('Price', 'money'), C('Margin', 'money')], rows,
        foot: ['Total', '', '', '', '', sum(rows, (r) => r[5]), sum(rows, (r) => r[6]), sum(rows, (r) => r[7])] };
    },
  },
  'phone-sales': {
    title: 'Phone sales & profit', icon: 'phone-flip', group: 'Mobile shop', filters: ['range'], perm: 'reports.profit',
    async run({ from, to }) {
      const [items, sales] = await Promise.all([byDate('saleItems', from, to), byDate('sales', from, to)]);
      const sm = new Map(live(sales).map((s) => [s.id, s]));
      const rows = items.filter((i) => i.deviceId && sm.has(i.saleId)).sort((a, b) => a.date.localeCompare(b.date))
        .map((i) => [i.date, { v: i.saleNo, href: '#/sales/' + i.saleId }, i.name, i.imei, sm.get(i.saleId).customerName, CONDITIONS[i.condition]?.short || '', i.cost, i.amount, round2(i.amount - i.cost)]);
      return { summary: [['Phones sold', rows.length], ['Sales', money(sum(rows, (r) => r[7]))], ['Cost', money(sum(rows, (r) => r[6]))], ['Profit', money(sum(rows, (r) => r[8]))]],
        note: 'Sale amount is the phone price after line discount, before any bill discount.',
        cols: [C('Date', 'date'), C('Bill'), C('Phone'), C('IMEI'), C('Customer'), C('Condition'), C('Cost', 'money'), C('Sold for', 'money'), C('Profit', 'money')], rows,
        foot: ['Total', '', '', '', '', '', sum(rows, (r) => r[6]), sum(rows, (r) => r[7]), sum(rows, (r) => r[8])] };
    },
  },
  'phone-register': {
    title: 'Used phone register (seller details)', icon: 'person-vcard', group: 'Mobile shop', filters: ['range'],
    async run({ from, to }) {
      const list = (await idb.getAll('devices')).filter((d) => d.purchaseDate >= from && d.purchaseDate <= to);
      const rows = list.filter((d) => d.source !== 'supplier').sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate))
        .map((d) => [d.purchaseDate, d.purchaseNo, d.sellerName || '', d.sellerCnic || '', d.sellerPhone || '', deviceName(d), d.imei1, d.purchasePrice, DEVICE_STATUS[d.status]?.label || d.status]);
      return { summary: [['Phones bought from people', rows.length], ['Total paid', money(sum(rows, (r) => r[7]))]],
        note: 'Keep this register for police/PTA checks: every used phone you bought, who sold it, their CNIC and the IMEI.',
        cols: [C('Date', 'date'), C('Purchase'), C('Seller'), C('CNIC'), C('Phone no.'), C('Phone'), C('IMEI'), C('Paid', 'money'), C('Now')], rows,
        foot: ['Total', '', '', '', '', '', '', sum(rows, (r) => r[7]), ''] };
    },
  },
  repairs: {
    title: 'Repair jobs', icon: 'tools', group: 'Mobile shop', filters: ['range'],
    async run({ from, to }) {
      const all = await idb.getAll('repairs');
      const done = all.filter((r) => r.status === 'delivered' && r.deliveredDate >= from && r.deliveredDate <= to).sort((a, b) => a.deliveredDate.localeCompare(b.deliveredDate));
      const open = all.filter((r) => ['received', 'diagnosing', 'waiting_parts', 'in_progress', 'ready'].includes(r.status));
      const rows = done.map((r) => [r.deliveredDate, { v: r.number, href: '#/repairs/' + r.id }, r.customerName, [r.brand, r.model].filter(Boolean).join(' '), r.fault, r.total, r.partsCost || 0, round2(r.total - (r.partsCost || 0)), r.balance || 0]);
      return { summary: [['Delivered', rows.length], ['Income', money(sum(rows, (r) => r[5]))], ['Parts cost', money(sum(rows, (r) => r[6]))], ['Profit', money(sum(rows, (r) => r[7]))], ['Still open', open.length], ['Unpaid balance', money(sum(rows, (r) => r[8]))]],
        cols: [C('Delivered', 'date'), C('Job'), C('Customer'), C('Phone'), C('Fault'), C('Charges', 'money'), C('Parts cost', 'money'), C('Profit', 'money'), C('Balance', 'money')], rows,
        foot: ['Total', '', '', '', '', sum(rows, (r) => r[5]), sum(rows, (r) => r[6]), sum(rows, (r) => r[7]), sum(rows, (r) => r[8])] };
    },
  },
  services: {
    title: 'Easypaisa / JazzCash / load', icon: 'wallet2', group: 'Mobile shop', filters: ['range'],
    async run({ from, to }) {
      const docs = live(await byDate('services', from, to)).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
      const rows = docs.map((d) => [d.date, { v: d.number, href: '#/services' }, d.walletName, d.typeLabel, d.customerNumber || d.customerName || '', d.amount, d.fee, d.commission, d.income]);
      return { summary: [['Transactions', rows.length], ['Volume', money(sum(rows, (r) => r[5]))], ['Fees collected', money(sum(rows, (r) => r[6]))], ['Commission', money(sum(rows, (r) => r[7]))], ['Total earned', money(sum(rows, (r) => r[8]))]],
        cols: [C('Date', 'date'), C('No'), C('Wallet'), C('Service'), C('Customer'), C('Amount', 'money'), C('Fee', 'money'), C('Commission', 'money'), C('Earned', 'money')], rows,
        foot: ['Total', '', '', '', '', sum(rows, (r) => r[5]), sum(rows, (r) => r[6]), sum(rows, (r) => r[7]), sum(rows, (r) => r[8])] };
    },
  },
  profit: {
    title: 'Profit summary', icon: 'graph-up-arrow', group: 'Accounts', perm: 'reports.profit', filters: ['range'],
    async run({ from, to }) {
      const [sales, items, rets, entries, accounts, moves] = await Promise.all([byDate('sales', from, to), byDate('saleItems', from, to), byDate('saleReturns', from, to), byDate('entries', from, to), idb.getAll('accounts'), byDate('stockMoves', from, to)]);
      const s = live(sales); const r = live(rets);
      const grossSales = sum(s, (d) => d.total - d.tax);
      const returns = sum(r, (d) => d.total - d.tax);
      const netSales = round2(grossSales - returns);
      const repairParts = sum(moves.filter((m) => m.type === 'repair'), (m) => -m.qty * (m.cost || 0));
      const cogs = round2(sum(items, (i) => i.qty * i.cost) - sum(r, (d) => d.items.reduce((a, i) => a + i.qty * i.cost, 0)) + repairParts);
      const gross = round2(netSales - cogs);
      const types = Object.fromEntries(accounts.map((a) => [a.id, a.type]));
      const skip = new Set(['sales', 'sales_returns', 'purchases', 'purchase_returns']);
      const inc = entries.filter((e) => types[e.accountId] === 'income' && !skip.has(e.accountId));
      const exp = entries.filter((e) => types[e.accountId] === 'expense' && !skip.has(e.accountId));
      const otherIncome = sum(inc, (e) => e.credit - e.debit);
      const expenses = sum(exp, (e) => e.debit - e.credit);
      const writeOff = sum(moves.filter((m) => m.type === 'adjust'), (m) => -m.qty * m.cost);
      const net = round2(gross + otherIncome - expenses - writeOff);
      const rows = [['Sales (excl. tax, after discounts)', grossSales], ['Less: sales returns', -returns], ['Net sales', netSales], ['Less: cost of goods sold (phones, accessories, repair parts)', -cogs], ['Gross profit', gross],
        ['Add: repair, service-fee & other income', otherIncome], ['Less: expenses', -expenses], ['Less: stock adjustments (loss) / gain', -writeOff], ['Net profit', net]];
      return { summary: [['Net sales', money(netSales)], ['Gross profit', money(gross)], ['Gross margin', netSales ? fmtNum((gross / netSales) * 100) + '%' : '—'], ['Net profit', money(net)]],
        note: 'Cost of goods sold uses the purchase price recorded on each sale line at the time of sale.',
        cols: [C('Item'), C('Amount', 'money')], rows, boldRows: [2, 4, 8] };
    },
  },
};

// ---------- rendering ----------
function cell(v, type) {
  if (v && typeof v === 'object') return v.href ? `<a href="${esc(v.href)}">${esc(v.v)}</a>` : esc(v.v);
  if (v === '' || v === null || v === undefined) return '';
  if (type === 'money') return fmtNum(v);
  if (type === 'qty') return fmtQty(v);
  if (type === 'date') return fmtDate(v);
  return typeof v === 'number' && type !== 'text' ? fmtNum(v) : esc(v);
}
const raw = (v) => (v && typeof v === 'object' ? v.v : v);

function tableHTML(res) {
  const num = (c) => (c.type === 'money' || c.type === 'qty' ? 'num' : '');
  return `<div class="table-responsive"><table class="table table-sm table-hover table-report mb-0">
    <thead><tr>${res.cols.map((c) => `<th class="${num(c)}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${res.rows.length ? res.rows.map((r, i) => `<tr class="${res.boldRows?.includes(i) ? 'fw-bold table-light' : ''}">${r.map((v, j) => `<td class="${num(res.cols[j])}">${cell(v, res.cols[j].type)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${res.cols.length}" class="text-center text-body-secondary py-4">No data for the selected filters</td></tr>`}</tbody>
    ${res.foot && res.rows.length ? `<tfoot><tr class="fw-semibold">${res.foot.map((v, j) => `<td class="${num(res.cols[j])}">${typeof v === 'number' ? cell(v, res.cols[j].type) : esc(v)}</td>`).join('')}</tr></tfoot>` : ''}
    </table></div>`;
}

function renderIndex(el) {
  const groups = {};
  for (const [key, r] of Object.entries(REPORTS)) {
    if (r.perm && !Auth.can(r.perm)) continue;
    (groups[r.group] ||= []).push([key, r]);
  }
  $(el).html(UI.pageHeader('Reports') + Object.entries(groups).map(([g, list]) => `<h2 class="h6 text-body-secondary mt-3">${esc(g)}</h2>
    <div class="row g-2">${list.map(([k, r]) => `<div class="col-6 col-md-4 col-xl-3"><a class="quick-action h-100" href="#/reports/${k}"><i class="bi bi-${r.icon}"></i>${esc(r.title)}</a></div>`).join('')}</div>`).join(''));
}

async function renderReport(el, key) {
  const rep = REPORTS[key];
  const $el = $(el);
  if (!rep || (rep.perm && !Auth.can(rep.perm))) { $el.html(UI.pageHeader('Report', '', '#/reports') + UI.emptyState('Report not available', 'shield-lock')); return; }
  const f = { from: monthStart(), to: today(), date: today(), customer: '', supplier: '', account: 'cash' };
  const accs = rep.filters.includes('cashAccount') ? await cashAccounts() : rep.filters.includes('account') ? await idb.getAll('accounts') : [];
  const fl = rep.filters;
  const partySel = (kind, req) => `<div class="flex-grow-2"><label class="form-label small mb-0">${kind === 'customers' ? 'Customer' : 'Supplier'}${req ? ' *' : ''}</label>
    <select name="${kind === 'customers' ? 'customer' : 'supplier'}" class="form-select form-select-sm">${req ? '<option value="">Select…</option>' : '<option value="">All</option>'}${UI.options(Catalog.allParties(kind).sort((a, b) => a.name.localeCompare(b.name)), '')}</select></div>`;
  $el.html(UI.pageHeader(rep.title, `<button class="btn btn-light btn-sm btn-print"><i class="bi bi-printer"></i><span class="d-none d-sm-inline"> Print</span></button><button class="btn btn-light btn-sm btn-csv"><i class="bi bi-filetype-csv"></i><span class="d-none d-sm-inline"> CSV</span></button>`, '#/reports') + `
    <form class="filters rep-filters">
      ${fl.includes('range') ? `<div><label class="form-label small mb-0">From</label><input type="date" name="from" class="form-control form-control-sm" value="${f.from}"></div><div><label class="form-label small mb-0">To</label><input type="date" name="to" class="form-control form-control-sm" value="${f.to}"></div>` : ''}
      ${fl.includes('date') || fl.includes('asof') ? `<div><label class="form-label small mb-0">${fl.includes('asof') ? 'As of' : 'Date'}</label><input type="date" name="date" class="form-control form-control-sm" value="${f.date}"></div>` : ''}
      ${fl.includes('customer') || fl.includes('customer*') ? partySel('customers', fl.includes('customer*')) : ''}
      ${fl.includes('supplier') || fl.includes('supplier*') ? partySel('suppliers', fl.includes('supplier*')) : ''}
      ${fl.includes('cashAccount') || fl.includes('account') ? `<div><label class="form-label small mb-0">Account</label><select name="account" class="form-select form-select-sm">${UI.options(accs, 'cash')}</select></div>` : ''}
      <div class="d-flex align-items-end gap-1" style="flex:0 0 auto">
        ${fl.includes('range') ? '<div class="btn-group btn-group-sm"><button type="button" class="btn btn-outline-secondary" data-range="today">Today</button><button type="button" class="btn btn-outline-secondary" data-range="month">Month</button><button type="button" class="btn btn-outline-secondary" data-range="all">All</button></div>' : ''}
        <button class="btn btn-primary btn-sm">Run</button></div>
    </form>
    <div class="rep-out"></div>`);
  let res = null;
  const run = async () => {
    Object.assign(f, Object.fromEntries(new FormData($el.find('.rep-filters')[0]).entries()));
    if ((fl.includes('customer*') && !f.customer) || (fl.includes('supplier*') && !f.supplier)) {
      $el.find('.rep-out').html(UI.emptyState(`Select a ${fl.includes('customer*') ? 'customer' : 'supplier'} to view the ledger`, 'person')); res = null; return;
    }
    $el.find('.rep-out').html(UI.spinner('Calculating…'));
    try {
      res = await rep.run(f);
      $el.find('.rep-out').html(`${res.summary ? `<div class="row g-2 mb-3">${res.summary.map(([l, v]) => `<div class="col-6 col-md-3"><div class="card stat-card"><div class="card-body py-2"><div class="stat-label">${esc(l)}</div><div class="fw-bold money">${v}</div></div></div></div>`).join('')}</div>` : ''}
        ${res.note ? `<div class="small text-body-secondary mb-2">${esc(res.note)}</div>` : ''}
        <div class="card"><div class="card-body p-0">${res.html || tableHTML(res)}</div></div>`);
    } catch (e) { $el.find('.rep-out').html(UI.errorState(e)); }
  };
  const period = () => (fl.includes('range') ? `${fmtDate(f.from)} – ${fmtDate(f.to)}` : fmtDate(f.date));
  $el.on('submit', '.rep-filters', (e) => { e.preventDefault(); run(); });
  $el.on('change', '.rep-filters select', run);
  $el.on('click', '[data-range]', function () { const [a, b] = rangeFor(this.dataset.range); $el.find('[name=from]').val(a); $el.find('[name=to]').val(b); run(); });
  $el.on('click', '.btn-print', () => {
    if (!res) return;
    const b = getSettings().business;
    printHTML(`<div class="print-report"><h2>${esc(b.name)}</h2><div><b>${esc(rep.title)}</b>${res.title ? ' — ' + esc(res.title) : ''}</div><div>${esc(period())} · printed ${new Date().toLocaleString()}</div><br>
      ${res.summary ? `<table style="margin-bottom:8px"><tr>${res.summary.map(([l, v]) => `<td><div>${esc(l)}</div><b>${v}</b></td>`).join('')}</tr></table>` : ''}
      ${res.html || tableHTML(res)}</div>`, { page: 'A4' });
  });
  $el.on('click', '.btn-csv', () => {
    if (!res) return;
    const rows = res.csv || [res.cols.map((c) => c.label), ...res.rows.map((r) => r.map(raw)), ...(res.foot ? [res.foot] : [])];
    downloadFile(`${key}-${fl.includes('range') ? f.from + '_' + f.to : f.date}.csv`, '﻿' + toCSV(rows), 'text/csv;charset=utf-8');
  });
  if (!(fl.includes('customer*') || fl.includes('supplier*'))) await run();
  else $el.find('.rep-out').html(UI.emptyState(`Select a ${fl.includes('customer*') ? 'customer' : 'supplier'} to view the ledger`, 'person'));
}

export default {
  async render(el, { params }) {
    if (params[0]) await renderReport(el, params[0]); else renderIndex(el);
  },
};
