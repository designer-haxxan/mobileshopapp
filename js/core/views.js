// Reusable view fragments: document links, ledger tables, date filters, balance formatting.
import { esc, fmtNum, fmtDate, today, monthStart } from './utils.js';
import { getSettings } from './settings.js';

export const cur = () => getSettings().currency;
export const money = (n) => `${esc(cur())} ${fmtNum(n)}`;

const REF_ROUTES = {
  sale: (id) => `#/sales/${id}`, purchase: (id) => `#/purchases/${id}`,
  saleReturn: (id) => `#/returns/sale/${id}`, purchaseReturn: (id) => `#/returns/purchase/${id}`,
  receipt: (id) => `#/vouchers/${id}`, payment: (id) => `#/vouchers/${id}`, transfer: (id) => `#/vouchers/${id}`,
  service: (id) => `#/services/${id}`,
  repair: (id) => `#/repairs/${id.split('%3A')[0]}`, repairPay: (id) => `#/repairs/${id.split('%3A')[0]}`,
};
export const REF_LABELS = { sale: 'Sale', purchase: 'Purchase', saleReturn: 'Sale return', purchaseReturn: 'Purchase return', receipt: 'Receipt', payment: 'Payment', transfer: 'Transfer', opening: 'Opening balance',
  service: 'Wallet / load service', repair: 'Repair job', repairPay: 'Repair advance' };

export function refLink(refType, id, text) {
  const r = REF_ROUTES[refType];
  return r ? `<a href="${r(encodeURIComponent(id))}">${esc(text)}</a>` : esc(text);
}

// Balance with Dr/Cr suffix. debitNormal: true for customers/cash/bank/assets/expenses.
export function balText(balance, debitNormal = true) {
  const v = debitNormal ? balance : -balance;
  if (Math.abs(v) < 0.005) return money(0);
  return v > 0 ? money(v) : `${money(-v)} ${debitNormal ? 'Cr' : 'Dr'}`;
}

export function dateFilter(from, to, extra = '') {
  return `<form class="filters date-filter">
    <div><label class="form-label small mb-0">From</label><input type="date" name="from" class="form-control form-control-sm" value="${esc(from)}"></div>
    <div><label class="form-label small mb-0">To</label><input type="date" name="to" class="form-control form-control-sm" value="${esc(to)}"></div>
    ${extra}
    <div class="d-flex align-items-end gap-1" style="flex:0 0 auto">
      <div class="btn-group btn-group-sm">
        <button type="button" class="btn btn-outline-secondary" data-range="today">Today</button>
        <button type="button" class="btn btn-outline-secondary" data-range="month">Month</button>
        <button type="button" class="btn btn-outline-secondary" data-range="all">All</button>
      </div>
      <button class="btn btn-primary btn-sm">Apply</button>
    </div></form>`;
}
export function rangeFor(key) {
  if (key === 'today') return [today(), today()];
  if (key === 'month') return [monthStart(), today()];
  return ['2000-01-01', today()];
}
// Wires the quick-range buttons; calls cb(from, to) on apply.
export function bindDateFilter($root, cb) {
  $root.on('click', '.date-filter [data-range]', function () {
    const [f, t] = rangeFor(this.dataset.range);
    const $f = $(this).closest('form');
    $f.find('[name=from]').val(f); $f.find('[name=to]').val(t);
    $f.trigger('submit');
  });
  $root.on('submit', '.date-filter', function (e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(this).entries());
    cb(fd.from || '2000-01-01', fd.to || today(), fd);
  });
}

export function ledgerTable(led, { debitNormal = true, showAccount = false, accountName = null } = {}) {
  const rows = led.rows.map((e) => `<tr>
      <td class="text-nowrap">${fmtDate(e.date)}</td>
      <td class="text-nowrap">${refLink(e.refType, e.txnId, e.refNo || '')}<div class="small text-body-secondary">${esc(REF_LABELS[e.refType] || e.refType)}</div></td>
      ${showAccount ? `<td>${esc(accountName ? accountName(e.accountId) : e.accountId)}</td>` : ''}
      <td class="small">${esc(e.memo)}</td>
      <td class="num">${e.debit ? fmtNum(e.debit) : ''}</td>
      <td class="num">${e.credit ? fmtNum(e.credit) : ''}</td>
      <td class="num fw-semibold">${balText(e.running, debitNormal)}</td></tr>`).join('');
  return `<div class="table-responsive"><table class="table table-sm table-hover table-report align-middle mb-0">
    <thead><tr><th>Date</th><th>Ref</th>${showAccount ? '<th>Account</th>' : ''}<th>Details</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
    <tbody><tr class="table-light"><td colspan="${showAccount ? 6 : 5}">Opening balance</td><td class="num fw-semibold">${balText(led.opening, debitNormal)}</td></tr>
    ${rows || `<tr><td colspan="${showAccount ? 7 : 6}" class="text-center text-body-secondary py-3">No transactions in this period</td></tr>`}</tbody>
    <tfoot><tr class="fw-semibold"><td colspan="${showAccount ? 4 : 3}">Totals / closing</td><td class="num">${fmtNum(led.debit)}</td><td class="num">${fmtNum(led.credit)}</td><td class="num">${balText(led.closing, debitNormal)}</td></tr></tfoot>
    </table></div>`;
}

// Simple incremental "load more" list rendering (keeps the DOM small).
export function pager($container, items, rowFn, pageSize = 50, empty = '') {
  let shown = 0;
  const more = () => {
    const chunk = items.slice(shown, shown + pageSize);
    shown += chunk.length;
    $container.find('.pager-more').remove();
    $container.append(chunk.map(rowFn).join(''));
    if (shown < items.length) $container.append(`<button class="list-row pager-more justify-content-center text-primary">Show more (${items.length - shown} remaining)</button>`);
  };
  $container.empty();
  if (!items.length) { $container.html(empty); return; }
  $container.off('click.pager').on('click.pager', '.pager-more', more);
  more();
}
