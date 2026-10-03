// Builds a printer-independent receipt model and renders it to ESC/POS bytes or HTML.
import * as idb from '../db/idb.js';
import { getSettings } from '../core/settings.js';
import { fmtNum, fmtQty, fmtDateTime, fmtDate, esc, localDate } from '../core/utils.js';
import { EscPos, isPlain } from './escpos.js';
import * as Raster from './raster.js';

const CONDITION_LABEL = { new: 'New', open_box: 'Open box', used: 'Used', refurb: 'Refurbished' };
const PTA_LABEL = { pta: 'PTA approved', non_pta: 'Non-PTA', jv: 'JV', factory_unlocked: 'Factory unlocked' };
const TITLES = { repair: 'REPAIR JOB CARD', repairDone: 'REPAIR RECEIPT', service: 'SERVICE RECEIPT', sale: 'SALES RECEIPT', purchase: 'PURCHASE', saleReturn: 'SALE RETURN', purchaseReturn: 'PURCHASE RETURN', receipt: 'PAYMENT RECEIPT', payment: 'PAYMENT VOUCHER', transfer: 'TRANSFER' };

export async function buildReceipt(kind, doc) {
  const s = getSettings();
  const b = s.business;
  const m = { header: [b.name, b.address, b.phone ? 'Tel: ' + b.phone : '', b.taxNo ? 'Tax No: ' + b.taxNo : ''].filter(Boolean), title: TITLES[kind] || kind.toUpperCase(),
    info: [], items: [], totals: [], footer: b.footer || '', void: doc.status === 'void' };
  const sameDay = doc.createdAt && localDate(new Date(doc.createdAt)) === doc.date;
  m.info.push(['No', doc.number], ['Date', sameDay ? fmtDateTime(doc.createdAt) : fmtDate(doc.date)]);
  if (doc.userName) m.info.push(['User', doc.userName]);

  if (kind === 'sale' || kind === 'purchase') {
    const items = await idb.getAllByIndex(kind === 'sale' ? 'saleItems' : 'purchaseItems', kind === 'sale' ? 'saleId' : 'purchaseId', doc.id);
    const list = items.length ? items : (doc.voidedItems || []);
    list.sort((a, b) => a.line - b.line);
    m.info.push([kind === 'sale' ? 'Customer' : 'Supplier', kind === 'sale' ? doc.customerName : doc.supplierName]);
    m.items = list.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, rate: i.rate, discount: i.discount, amount: i.amount,
      sub: [i.imei ? 'IMEI: ' + i.imei : '', i.imei2 ? 'IMEI 2: ' + i.imei2 : '', kind === 'sale' && i.imei ? [CONDITION_LABEL[i.condition], PTA_LABEL[i.pta]].filter(Boolean).join(' / ') : '',
        kind === 'sale' && i.imei ? (i.warrantyDays ? `Warranty: ${i.warrantyDays} day(s)` : 'No warranty') : ''].filter(Boolean) }));
    if (kind === 'purchase' && doc.seller?.name) m.info.push(['Seller', doc.seller.name], ...(doc.seller.cnic ? [['CNIC', doc.seller.cnic]] : []), ...(doc.seller.phone ? [['Phone', doc.seller.phone]] : []));
    m.totals.push(['Subtotal', doc.subtotal]);
    if (doc.discount) m.totals.push(['Discount', -doc.discount]);
    if (doc.tax) m.totals.push([`Tax (${doc.taxRate}%)`, doc.tax]);
    m.totals.push(['TOTAL', doc.total, true]);
    if (doc.tradeIn) m.totals.push([`Trade-in: ${doc.tradeIn.name}`, -doc.tradeIn.value], ['NET TO PAY', doc.total - doc.tradeIn.value, true]);
    if (kind === 'sale' && doc.tendered > doc.paid) m.totals.push(['Cash tendered', doc.tendered]);
    m.totals.push(['Paid', doc.paid]);
    if (doc.change) m.totals.push(['Change', doc.change]);
    if (doc.balance) m.totals.push(['Balance due', doc.balance, true]);
    m.payment = doc.paid ? doc.paymentAccountName : 'Credit';
  } else if (kind === 'repair') {
    const done = doc.status === 'delivered';
    m.title = done ? TITLES.repairDone : TITLES.repair;
    m.info.push(['Customer', doc.customerName], ...(doc.customerPhone ? [['Phone', doc.customerPhone]] : []), ['Device', [doc.brand, doc.model].filter(Boolean).join(' ')],
      ...(doc.imei ? [['IMEI', doc.imei]] : []), ['Fault', doc.fault], ...(doc.accessories ? [['Left with us', doc.accessories]] : []),
      ...(doc.expectedDate && !done ? [['Expected', fmtDate(doc.expectedDate)]] : []));
    m.items = (doc.parts || []).map((p) => ({ name: p.name, qty: p.qty, unit: '', rate: p.price, amount: p.amount }));
    if (doc.labour) m.totals.push(['Labour', doc.labour]);
    if (done || doc.total) m.totals.push(['TOTAL', doc.total, true]); else if (doc.estimate) m.totals.push(['Estimate', doc.estimate, true]);
    m.totals.push(['Paid', doc.paid || 0]);
    const bal = done ? (doc.balance || 0) : Math.max(0, (doc.total || doc.estimate || 0) - (doc.paid || 0));
    if (bal) m.totals.push([done ? 'Balance due' : 'Balance (approx.)', bal, true]);
    m.footer = done ? (doc.warrantyDays ? `Repair warranty: ${doc.warrantyDays} day(s) on the repaired part. No warranty on water/physical damage.` : (b.footer || '')) : 'Keep this slip. Phones not collected within 30 days of the ready notice are not our responsibility.';
  } else if (kind === 'service') {
    m.info.push(['Provider', doc.walletName], ['Service', doc.typeLabel], ...(doc.customerNumber ? [['Number', doc.customerNumber]] : []), ...(doc.billKind ? [['Bill', doc.billKind]] : []), ...(doc.reference ? [['Ref / TID', doc.reference]] : []));
    m.totals.push([doc.dir === 'out' ? 'Amount sent' : 'Cash paid out', doc.amount]);
    if (doc.fee) m.totals.push(['Service charges', doc.fee]);
    if (doc.dir === 'out') m.totals.push(['TOTAL RECEIVED', doc.amount + doc.fee, true]);
  } else if (kind === 'saleReturn' || kind === 'purchaseReturn') {
    m.info.push(['Against', doc.docNo], [kind === 'saleReturn' ? 'Customer' : 'Supplier', doc.partyName || '']);
    m.items = doc.items.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, rate: i.rate, amount: i.amount }));
    m.totals.push(['RETURN TOTAL', doc.total, true]);
    m.totals.push([kind === 'saleReturn' ? 'Refunded' : 'Refund received', doc.refund]);
    m.payment = doc.refund ? doc.refundAccountName : 'Adjusted to account';
  } else {
    const party = { receipt: 'Received from', payment: 'Paid to', transfer: 'To account' }[doc.type];
    m.title = TITLES[doc.type];
    m.info.push([party, doc.counterName], [doc.type === 'transfer' ? 'From account' : 'Account', doc.accountName]);
    if (doc.note) m.info.push(['Note', doc.note]);
    m.totals.push(['AMOUNT', doc.amount, true]);
  }
  if (doc.note && kind !== 'voucher') m.note = doc.note;
  return m;
}

// Async because Urdu/non-Latin lines are rendered with the Jameel Noori Nastaleeq web font.
export async function toEscPos(m, width = 58) {
  await Raster.ensureFont();
  const p = new EscPos(width, Raster, { imageMode: getSettings().printer.imageMode });
  const cur = getSettings().currency;
  p.align('center');
  m.header.forEach((h, i) => { if (i === 0) p.bold(true).size(true).wrap(h, Math.floor(p.cols / 2)).size(false).bold(false); else p.wrap(h); });
  p.hr().bold(true).line(m.title).bold(false);
  if (m.void) p.bold(true).line('*** VOID ***').bold(false);
  p.align('left');
  m.info.forEach(([k, v]) => p.lr(k + ':', String(v ?? '')));
  if (m.items.length) {
    p.hr();
    m.items.forEach((i) => {
      p.wrap(i.name);
      (i.sub || []).forEach((x) => p.wrap('  ' + x));
      p.lr(`  ${fmtQty(i.qty)} ${i.unit || ''} x ${fmtNum(i.rate)}`, fmtNum(i.amount));
      if (i.discount) p.lr('  Discount', '-' + fmtNum(i.discount));
    });
  }
  p.hr();
  m.totals.forEach(([k, v, strong]) => { if (strong) p.bold(true); p.lr(k, `${v < 0 ? '-' : ''}${cur} ${fmtNum(Math.abs(v))}`); if (strong) p.bold(false); });
  if (m.payment) p.lr('Payment', m.payment);
  if (m.note) { p.hr(); p.wrap('Note: ' + m.note); }
  p.hr().align('center');
  if (m.footer) p.wrap(m.footer);
  p.feed(3).cut();
  return p.bytes();
}

// Urdu/RTL text is wrapped so it uses Jameel Noori Nastaleeq and right-to-left layout.
const t = (s) => (isPlain(s) ? esc(s) : `<span class="ur" dir="auto">${esc(s)}</span>`);

export function toHTML(m, width = 58) {
  const cur = esc(getSettings().currency);
  const row = (l, r, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${r}</td></tr>`;
  return `<div class="receipt w${Number(width) === 80 ? 80 : 58}">
    ${m.header.map((h, i) => `<div class="c ${i === 0 ? 'b big' : ''}">${t(h)}</div>`).join('')}
    <hr><div class="c b">${esc(m.title)}</div>${m.void ? '<div class="c b">*** VOID ***</div>' : ''}
    <table>${m.info.map(([k, v]) => row(esc(k) + ':', t(v))).join('')}</table>
    ${m.items.length ? '<hr><table>' + m.items.map((i) => `<tr><td colspan="2">${t(i.name)}${(i.sub || []).map((x) => `<div class="small">&nbsp;&nbsp;${esc(x)}</div>`).join('')}</td></tr>${row(`&nbsp;&nbsp;${fmtQty(i.qty)} ${esc(i.unit || '')} x ${fmtNum(i.rate)}`, fmtNum(i.amount))}${i.discount ? row('&nbsp;&nbsp;Discount', '-' + fmtNum(i.discount)) : ''}`).join('') + '</table>' : ''}
    <hr><table>${m.totals.map(([k, v, strong]) => row(esc(k), `${v < 0 ? '-' : ''}${cur} ${fmtNum(Math.abs(v))}`, strong ? 'b' : '')).join('')}
    ${m.payment ? row('Payment', t(m.payment)) : ''}</table>
    ${m.note ? `<hr><div>Note: ${t(m.note)}</div>` : ''}
    <hr>${m.footer ? `<div class="c">${t(m.footer)}</div>` : ''}</div>`;
}
