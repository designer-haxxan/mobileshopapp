// Easypaisa, JazzCash, mobile load and bill-payment counter: fees and commission are tracked per transaction.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, fmtTime, uuid, num, round2, today, localDate } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref } from '../core/settings.js';
import { SERVICE_TYPES, WALLET_ACCOUNTS, BILL_KINDS } from '../core/mobile.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';

const $ = window.jQuery;
const walletMeta = (id) => WALLET_ACCOUNTS.find((w) => w.id === id) || { icon: 'wallet2', color: '#6366f1', provider: '' };
const rateKey = (w, t) => `${w}:${t}`;

async function loadWallets() {
  const accounts = (await idb.getAll('accounts')).filter((a) => a.active);
  const bal = await Posting.allBalances();
  const wallets = accounts.filter((a) => a.type === 'bank').sort((a, b) => {
    const ia = WALLET_ACCOUNTS.findIndex((w) => w.id === a.id); const ib = WALLET_ACCOUNTS.findIndex((w) => w.id === b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  }).map((a) => ({ ...a, balance: bal.get(a.id)?.balance || 0 }));
  const cashAccs = accounts.filter((a) => a.type === 'cash');
  return { wallets, cash: { id: 'cash', name: 'Cash in Hand', balance: bal.get('cash')?.balance || 0 }, cashAccs };
}

// Service entry form. Resolves with the saved doc or null.
export async function serviceModal({ walletId = null, type = 'deposit' } = {}) {
  const { wallets, cashAccs } = await loadWallets();
  const rates = pref.get('svcRates', {});
  let touched = { fee: false, comm: false };
  const m = UI.modal({
    title: 'New service', size: 'md', static: true,
    body: `<form class="svc-form" autocomplete="off" novalidate>
      <label class="form-label small mb-1">Wallet / account</label>
      <div class="wallet-pick mb-2">${wallets.map((w) => { const meta = walletMeta(w.id); return `<label class="wp" style="--wc:${meta.color}"><input type="radio" name="walletId" value="${esc(w.id)}" ${w.id === (walletId || wallets[0]?.id) ? 'checked' : ''}><span><i class="bi bi-${meta.icon}"></i>${esc(w.name.replace(/ Wallet| Balance/, ''))}</span></label>`; }).join('')}</div>
      <label class="form-label small mb-1">Service</label>
      <div class="type-pick mb-3">${Object.entries(SERVICE_TYPES).map(([k, t]) => `<label class="tp tint-${t.tint}"><input type="radio" name="type" value="${k}" ${k === type ? 'checked' : ''}><span><i class="bi bi-${t.icon}"></i>${esc(t.short)}</span></label>`).join('')}</div>
      <div class="small text-body-secondary mb-2 type-help"></div>
      <div class="row g-2">
        <div class="col-12"><label class="form-label">Amount <span class="text-danger">*</span></label><input name="amount" class="form-control form-control-lg money" inputmode="decimal" placeholder="0"></div>
        <div class="col-6"><label class="form-label">Your fee (from customer)</label><input name="fee" class="form-control money" inputmode="decimal" placeholder="0"></div>
        <div class="col-6"><label class="form-label">Commission (from company)</label><input name="commission" class="form-control money" inputmode="decimal" placeholder="0"></div>
        <div class="col-6"><label class="form-label">Customer number</label><input name="customerNumber" class="form-control" inputmode="tel" placeholder="03xx-xxxxxxx"></div>
        <div class="col-6"><label class="form-label">Name</label><input name="customerName" class="form-control"></div>
        <div class="col-6 bill-kind d-none"><label class="form-label">Bill type</label><select name="billKind" class="form-select"><option value="">—</option>${BILL_KINDS.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
        <div class="col-6"><label class="form-label">Ref / TID</label><input name="reference" class="form-control"></div>
        ${cashAccs.length > 1 ? `<div class="col-6"><label class="form-label">Cash account</label><select name="cashAccountId" class="form-select">${UI.options(cashAccs, 'cash')}</select></div>` : ''}
      </div>
      <div class="svc-summary mt-3"></div>
      <div class="alert alert-danger py-2 small d-none svc-err mt-2 mb-0"></div></form>`,
    footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-success btn-lg flex-grow-1 svc-save"><i class="bi bi-check2-circle me-1"></i>Save</button>',
  });
  const $m = m.$el; const $f = $m.find('form');
  const val = (n) => $f.find(`[name=${n}]`).val();
  const sel = (n) => $f.find(`[name=${n}]:checked`).val();
  const summary = () => {
    const t = sel('type'); const def = SERVICE_TYPES[t]; const amount = num(val('amount')); const fee = num(val('fee')); const comm = num(val('commission'));
    const w = wallets.find((x) => x.id === sel('walletId'));
    $f.find('.type-help').text(def.help);
    $f.find('.bill-kind').toggleClass('d-none', t !== 'bill');
    const cashFlow = def.dir === 'out' ? `Take <b>${cur()} ${fmtNum(amount + fee)}</b> cash` : `Give <b>${cur()} ${fmtNum(amount)}</b> cash`;
    const after = w ? round2(w.balance + (def.dir === 'out' ? -amount : amount + fee) + comm) : 0;
    $f.find('.svc-summary').html(amount > 0 ? `<div class="svc-sum"><div>${cashFlow}</div><div class="small text-body-secondary">You earn <b class="text-success">${cur()} ${fmtNum(fee + comm)}</b> · wallet after: <b class="${after < 0 ? 'text-danger' : ''}">${fmtNum(after)}</b></div>
      ${w && def.dir === 'out' && w.balance < amount ? `<div class="small text-danger mt-1"><i class="bi bi-exclamation-triangle me-1"></i>${esc(w.name)} balance (${fmtNum(w.balance)}) is lower than the amount. Top it up first.</div>` : ''}</div>` : '');
  };
  const applyRates = () => {
    const r = rates[rateKey(sel('walletId'), sel('type'))]; const amount = num(val('amount'));
    if (r && amount > 0) {
      if (!touched.fee) $f.find('[name=fee]').val(r.fee ? round2(amount * r.fee) : '');
      if (!touched.comm) $f.find('[name=commission]').val(r.comm ? round2(amount * r.comm) : '');
    }
    summary();
  };
  $f.on('input', '[name=amount]', applyRates);
  $f.on('input', '[name=fee]', () => { touched.fee = true; summary(); });
  $f.on('input', '[name=commission]', () => { touched.comm = true; summary(); });
  $f.on('change', '[name=type], [name=walletId]', () => { touched = { fee: false, comm: false }; applyRates(); });
  $m.on('shown.bs.modal', () => $f.find('[name=amount]').trigger('focus'));
  summary();
  return new Promise((resolve) => {
    let result = null; let busy = false;
    $m.find('.svc-save').on('click', async function () {
      if (busy) return; busy = true;
      const $b = $(this).prop('disabled', true);
      $f.find('.svc-err').addClass('d-none');
      try {
        const v = Object.fromEntries(new FormData($f[0]).entries());
        const { doc } = await Posting.saveService({ ...v, id: uuid(), cashAccountId: v.cashAccountId || 'cash' });
        const a = doc.amount;
        rates[rateKey(doc.walletId, doc.type)] = { fee: doc.fee / a, comm: doc.commission / a }; pref.set('svcRates', rates);
        result = doc; m.close();
      } catch (e) { $f.find('.svc-err').text(e.message || String(e)).removeClass('d-none'); $b.prop('disabled', false); } finally { busy = false; }
    });
    m.closed.then(() => resolve(result));
  });
}

async function showDoc(d, reload) {
  const def = SERVICE_TYPES[d.type];
  const m = UI.modal({
    title: d.number, fullscreenMobile: false, scrollable: false,
    body: `<div class="text-center mb-2"><span class="badge tint-${def.tint}"><i class="bi bi-${def.icon} me-1"></i>${esc(def.label)}</span>${d.status === 'void' ? ' <span class="badge text-bg-danger">Void</span>' : ''}<div class="display-6 fw-bold money mt-1">${cur()} ${fmtNum(d.amount)}</div><div class="small text-body-secondary">${esc(d.walletName)} · ${fmtDate(d.date)} ${fmtTime(d.createdAt)}</div></div>
      <div class="kv-grid">${[['Customer', [d.customerName, d.customerNumber].filter(Boolean).join(' · ')], ['Ref / TID', d.reference], ['Bill', d.billKind], ['Fee', d.fee ? fmtNum(d.fee) : ''], ['Commission', d.commission ? fmtNum(d.commission) : ''], ['Cash account', d.cashAccountName], ['By', d.userName]]
        .filter(([, v]) => v).map(([k, v]) => `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>`,
    footer: `<button class="btn btn-outline-secondary btn-print"><i class="bi bi-printer me-1"></i>Print</button>${d.status !== 'void' && Auth.can('service.create') ? '<button class="btn btn-outline-danger btn-void">Void</button>' : ''}<button class="btn btn-primary" data-bs-dismiss="modal">Close</button>`,
  });
  m.$el.find('.btn-print').on('click', () => Printer.printDocument('service', d));
  m.$el.find('.btn-void').on('click', async () => {
    if (!await UI.confirmDialog(`Void ${d.number}? Cash, wallet and income entries are reversed.`, { okLabel: 'Void', okClass: 'btn-danger' })) return;
    try { await Posting.voidDocument('service', d.id, 'Voided'); UI.toast('Service voided'); m.close(); reload(); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el, { setTitle }) {
    this.destroy();
    const $el = $(el);
    const f = { range: pref.get('svcRange', 'today') };
    const draw = async () => {
      const { wallets, cash } = await loadWallets();
      const from = f.range === 'today' ? today() : f.range === 'week' ? (() => { const d = new Date(); d.setDate(d.getDate() - 6); return localDate(d); })() : today().slice(0, 8) + '01';
      const docs = (await idb.getAllByIndex('services', 'date', IDBKeyRange.bound(from, today()))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const live = docs.filter((d) => d.status !== 'void');
      const earned = round2(live.reduce((s, d) => s + d.income, 0)); const volume = round2(live.reduce((s, d) => s + d.amount, 0));
      const byType = {};
      for (const d of live) { const x = byType[d.type] || (byType[d.type] = { n: 0, amount: 0, income: 0 }); x.n++; x.amount += d.amount; x.income += d.income; }
      const periodLbl = { today: 'Today', week: 'Last 7 days', month: 'This month' }[f.range];
      $el.html(UI.pageHeader('Easypaisa, JazzCash & Load', '<button class="btn btn-primary btn-sm btn-new"><i class="bi bi-plus-lg"></i> New</button>') + `
        <div class="wallet-row mb-3 stagger">${wallets.map((w) => { const meta = walletMeta(w.id); return `<div class="wallet-card" style="--wc:${meta.color}"><div class="wc-head"><i class="bi bi-${meta.icon}"></i><span>${esc(w.name)}</span></div>
          <div class="wc-bal money ${w.balance < 0 ? 'neg' : ''}" data-count="${round2(w.balance)}" data-money="1">0</div>
          <div class="wc-actions"><button class="btn btn-sm btn-light btn-go" data-w="${esc(w.id)}">Service</button><button class="btn btn-sm btn-outline-light btn-topup" data-w="${esc(w.id)}" title="Move cash into this wallet">Top-up</button></div></div>`; }).join('')}
          <div class="wallet-card cashc"><div class="wc-head"><i class="bi bi-cash-stack"></i><span>Cash in hand</span></div><div class="wc-bal money" data-count="${round2(cash.balance)}" data-money="1">0</div><div class="wc-actions"><a class="btn btn-sm btn-light" href="#/vouchers">Cash book</a></div></div></div>
        <div class="quick-svc mb-3">${Object.entries(SERVICE_TYPES).map(([k, t]) => `<button class="qs tint-${t.tint}" data-type="${k}"><i class="bi bi-${t.icon}"></i><span>${esc(t.short)}</span></button>`).join('')}</div>
        <div class="d-flex align-items-center mb-2"><div class="chips flex-grow-1">${[['today', 'Today'], ['week', '7 days'], ['month', 'Month']].map(([k, l]) => `<span class="chip ${f.range === k ? 'active' : ''}" data-range="${k}">${l}</span>`).join('')}</div></div>
        <div class="row g-2 mb-3"><div class="col-4"><div class="mini-stat tint-green"><i class="bi bi-coin"></i><div><div class="v money" data-count="${earned}" data-money="1">0</div><div class="l">Earned ${periodLbl.toLowerCase()}</div></div></div></div>
          <div class="col-4"><div class="mini-stat tint-indigo"><i class="bi bi-arrow-left-right"></i><div><div class="v money" data-count="${volume}" data-money="1">0</div><div class="l">Volume</div></div></div></div>
          <div class="col-4"><div class="mini-stat tint-cyan"><i class="bi bi-hash"></i><div><div class="v" data-count="${live.length}">0</div><div class="l">Transactions</div></div></div></div></div>
        ${Object.keys(byType).length ? `<div class="d-flex flex-wrap gap-2 mb-3">${Object.entries(byType).map(([k, x]) => `<span class="badge tint-${SERVICE_TYPES[k].tint} fs-6 fw-semibold"><i class="bi bi-${SERVICE_TYPES[k].icon} me-1"></i>${SERVICE_TYPES[k].short}: ${x.n} · earned ${fmtNum(x.income)}</span>`).join('')}</div>` : ''}
        <div class="list-card">${docs.slice(0, 120).map((d) => { const t = SERVICE_TYPES[d.type]; const meta = walletMeta(d.walletId);
          return `<button class="list-row w-100 text-start svc-row ${d.status === 'void' ? 'opacity-50' : ''}" data-id="${esc(d.id)}"><div class="icon-chip tint-${t.tint}"><i class="bi bi-${t.icon}"></i></div>
          <div class="main"><div class="title">${esc(t.short)} · ${esc(d.customerNumber || d.customerName || d.walletName)}</div><div class="sub">${esc(d.number)} · ${esc(d.walletName)} · ${fmtTime(d.createdAt)}${d.status === 'void' ? ' · VOID' : ''}</div></div>
          <div class="end"><div class="fw-bold money">${fmtNum(d.amount)}</div><div class="small text-success">+${fmtNum(d.income)}</div></div></button>`; }).join('') || UI.emptyState(`No services ${periodLbl.toLowerCase()}. Tap New to record Easypaisa, JazzCash, load or a bill.`, 'wallet2')}</div>`);
      UI.countUp(el, (v, n) => (n.dataset.money ? `${cur()} ${fmtNum(v)}` : String(Math.round(v))));
    };
    await draw();
    const add = async (opts) => { const d = await serviceModal(opts); if (d) { UI.toast(`${d.number} saved`); await draw(); if (pref.get('autoPrintService', false)) Printer.printDocument('service', d, { silentFail: true }); } };
    $el.on('click', '.btn-new', () => add({}));
    $el.on('click', '.qs', function () { add({ type: this.dataset.type }); });
    $el.on('click', '.btn-go', function () { add({ walletId: this.dataset.w }); });
    $el.on('click', '.btn-topup', async function () {
      const { newVoucher } = await import('./vouchers.js');
      await newVoucher({ type: 'transfer', accountId: 'cash', counterAccountId: this.dataset.w });
      draw();
    });
    $el.on('click', '[data-range]', function () { f.range = this.dataset.range; pref.set('svcRange', f.range); draw(); });
    $el.on('click', '.svc-row', async function () { const d = await idb.get('services', this.dataset.id); if (d) showDoc(d, draw); });
    this._h = () => { if (location.hash.startsWith('#/services')) draw(); };
    document.addEventListener('data:changed', this._h);
  },
  destroy() { if (this._h) document.removeEventListener('data:changed', this._h); this._h = null; },
};
