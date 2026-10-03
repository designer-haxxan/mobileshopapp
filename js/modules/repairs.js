// Repairs: job cards from receiving a faulty phone to delivery, with advances, parts and warranty.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, fmtDateTime, uuid, num, round2, today, debounce, AppError } from '../core/utils.js';
import { cur } from '../core/views.js';
import { getSettings, pref } from '../core/settings.js';
import { BRANDS, REPAIR_STATUS, OPEN_REPAIR, COMMON_FAULTS, cleanImei, imeiProblem, waLink } from '../core/mobile.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Scanner from '../scanner/scanner.js';
import * as Printer from '../printer/printer.js';
import { partyPicker } from './parties.js';

const $ = window.jQuery;
const sBadge = (s) => { const x = REPAIR_STATUS[s] || REPAIR_STATUS.received; return `<span class="badge tint-${x.tint}"><i class="bi bi-${x.icon} me-1"></i>${esc(x.label)}</span>`; };
const ageDays = (r) => Math.max(0, Math.floor((Date.now() - new Date(r.date + 'T00:00:00')) / 86400000));
const payAccounts = async () => (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active).sort((a, b) => (a.id === 'cash' ? -1 : b.id === 'cash' ? 1 : a.name.localeCompare(b.name)));
const balanceOf = (r) => (r.status === 'delivered' ? (r.balance || 0) : Math.max(0, (r.total || r.estimate || 0) - (r.paid || 0)));

// ---------- list ----------
async function renderList(el) {
  const $el = $(el);
  const all = (await idb.getAll('repairs')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const f = { q: '', tab: pref.get('repairTab', 'open') };
  const count = (st) => all.filter((r) => st.includes(r.status)).length;
  const open = count(OPEN_REPAIR); const ready = count(['ready']); const waiting = count(['waiting_parts']);
  const dueMoney = all.filter((r) => OPEN_REPAIR.includes(r.status)).reduce((s, r) => s + (r.paid || 0), 0);
  const month = today().slice(0, 7);
  const monthIncome = all.filter((r) => r.status === 'delivered' && (r.deliveredDate || '').startsWith(month)).reduce((s, r) => s + r.total, 0);
  const monthProfit = all.filter((r) => r.status === 'delivered' && (r.deliveredDate || '').startsWith(month)).reduce((s, r) => s + r.total - (r.partsCost || 0), 0);
  $el.html(UI.pageHeader('Repairs', '<a class="btn btn-primary btn-sm" href="#/repairs/new"><i class="bi bi-plus-lg"></i> New job</a>') + `
    <div class="row g-2 mb-3 stagger">
      <div class="col-6 col-lg-3"><div class="mini-stat tint-violet"><i class="bi bi-wrench-adjustable"></i><div><div class="v" data-count="${open}">0</div><div class="l">Open jobs</div></div></div></div>
      <div class="col-6 col-lg-3"><div class="mini-stat ${ready ? 'tint-green pulse' : 'tint-slate'}"><i class="bi bi-check2-circle"></i><div><div class="v" data-count="${ready}">0</div><div class="l">Ready for pickup</div></div></div></div>
      <div class="col-6 col-lg-3"><div class="mini-stat tint-amber"><i class="bi bi-hourglass-split"></i><div><div class="v" data-count="${waiting}">0</div><div class="l">Waiting for parts</div></div></div></div>
      <div class="col-6 col-lg-3"><div class="mini-stat tint-cyan"><i class="bi bi-cash-coin"></i><div><div class="v money" data-count="${round2(monthProfit)}" data-money="1">0</div><div class="l">Repair profit this month</div></div></div></div>
    </div>
    <div class="chips mb-2 tabs">${[['open', `Open (${open})`], ['ready', `Ready (${ready})`], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => `<span class="chip ${f.tab === k ? 'active' : ''}" data-tab="${k}">${l}</span>`).join('')}</div>
    <div class="filters"><input type="search" class="form-control q" placeholder="Search job no, customer, phone, model, IMEI…"></div>
    <div class="repair-list"></div>`);
  UI.countUp(el, (v, n) => (n.dataset.money ? `${cur()} ${fmtNum(v)}` : String(Math.round(v))));
  const draw = () => {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = all.filter((r) => (f.tab === 'all' || (f.tab === 'open' ? OPEN_REPAIR.includes(r.status) : r.status === f.tab))
      && terms.every((t) => `${r.number} ${r.customerName} ${r.customerPhone} ${r.brand} ${r.model} ${r.imei} ${r.fault}`.toLowerCase().includes(t)));
    $el.find('.tabs [data-tab]').each(function () { $(this).toggleClass('active', this.dataset.tab === f.tab); });
    $el.find('.repair-list').html(rows.slice(0, 150).map((r) => {
      const bal = balanceOf(r); const late = OPEN_REPAIR.includes(r.status) && r.expectedDate && r.expectedDate < today();
      return `<a class="repair-card st-${r.status}" href="#/repairs/${encodeURIComponent(r.id)}">
        <div class="rc-side"><i class="bi bi-${REPAIR_STATUS[r.status]?.icon}"></i></div>
        <div class="rc-main"><div class="d-flex align-items-center gap-2"><span class="rc-no">${esc(r.number)}</span>${sBadge(r.status)}${r.priority === 'urgent' ? '<span class="badge text-bg-danger">Urgent</span>' : ''}${late ? '<span class="badge text-bg-warning">Late</span>' : ''}</div>
          <div class="rc-dev">${esc([r.brand, r.model].filter(Boolean).join(' ') || 'Phone')} <span class="rc-fault">· ${esc(r.fault)}</span></div>
          <div class="rc-cust"><i class="bi bi-person"></i> ${esc(r.customerName)}${r.customerPhone ? ' · ' + esc(r.customerPhone) : ''}</div></div>
        <div class="rc-end"><div class="fw-bold money">${fmtNum(r.total || r.estimate || 0)}</div>${bal > 0.004 && r.status !== 'cancelled' ? `<div class="small text-danger">Due ${fmtNum(bal)}</div>` : r.paid ? '<div class="small text-success">Paid</div>' : ''}<div class="small text-body-secondary">${ageDays(r)}d</div></div></a>`;
    }).join('') || UI.emptyState('No repair jobs here.', 'tools'));
  };
  $el.on('input', '.q', debounce(() => { f.q = $el.find('.q').val(); draw(); }, 150));
  $el.on('click', '[data-tab]', function () { f.tab = this.dataset.tab; pref.set('repairTab', f.tab); draw(); });
  draw();
}

// ---------- new job ----------
const LEFT_ITEMS = ['SIM', 'SIM tray', 'Memory card', 'Cover', 'Charger', 'Box'];

async function renderNew(el, setTitle) {
  setTitle('New Repair Job');
  const $el = $(el);
  const accounts = await payAccounts();
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const imeiQ = cleanImei(q.get('imei'));
  const known = imeiQ ? await Posting.lookupImei(imeiQ) : null;
  const s = { id: uuid(), customerId: null, customerName: known?.customerName || '', customerPhone: '', brand: known?.brand || '', model: known?.model || '', imei: imeiQ, color: known?.color || '' };
  const tech = pref.get('lastTech', '');
  $el.html(UI.pageHeader('New Repair Job', '', '#/repairs') + `<form class="job-form" autocomplete="off" novalidate><div class="row g-3"><div class="col-lg-7">
    <div class="card mb-3"><div class="card-body"><h2 class="h6 mb-2"><i class="bi bi-person me-2"></i>Customer</h2>
      <div class="row g-2"><div class="col-12"><button type="button" class="btn btn-light w-100 text-start btn-cust"><i class="bi bi-search me-2"></i><span>Pick an existing customer (optional)</span></button></div>
        <div class="col-6"><label class="form-label">Name <span class="text-danger">*</span></label><input name="customerName" class="form-control" value="${esc(s.customerName)}"></div>
        <div class="col-6"><label class="form-label">Phone</label><input name="customerPhone" class="form-control" inputmode="tel" value="${esc(s.customerPhone)}"></div></div></div></div>
    <div class="card mb-3"><div class="card-body"><h2 class="h6 mb-2"><i class="bi bi-phone me-2"></i>Phone</h2>
      <div class="row g-2"><div class="col-6"><label class="form-label">Brand</label><input name="brand" class="form-control" list="brands-dl2" value="${esc(s.brand)}"><datalist id="brands-dl2">${BRANDS.map((b) => `<option value="${esc(b)}">`).join('')}</datalist></div>
        <div class="col-6"><label class="form-label">Model</label><input name="model" class="form-control" value="${esc(s.model)}"></div>
        <div class="col-8"><label class="form-label">IMEI</label><div class="input-group"><input name="imei" class="form-control" inputmode="numeric" maxlength="20" value="${esc(s.imei)}"><button type="button" class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-upc-scan"></i></button></div><div class="small mt-1 imei-msg"></div></div>
        <div class="col-4"><label class="form-label">Colour</label><input name="color" class="form-control" value="${esc(s.color)}"></div>
        <div class="col-12"><label class="form-label">Left with us</label><div class="d-flex flex-wrap gap-2">${LEFT_ITEMS.map((x) => `<label class="chip-check"><input type="checkbox" name="left" value="${esc(x)}"><span>${esc(x)}</span></label>`).join('')}</div></div>
        <div class="col-6"><label class="form-label">Screen lock / PIN <span class="small text-body-secondary">(to test the phone)</span></label><input name="lockCode" class="form-control" autocomplete="off"></div>
        <div class="col-6"><label class="form-label">Existing damage</label><input name="existingDamage" class="form-control" placeholder="Scratches, cracked back…"></div></div></div></div>
  </div><div class="col-lg-5">
    <div class="card mb-3"><div class="card-body"><h2 class="h6 mb-2"><i class="bi bi-wrench-adjustable me-2"></i>Fault &amp; estimate</h2>
      <div class="d-flex flex-wrap gap-1 mb-2 fault-chips">${COMMON_FAULTS.map((x) => `<span class="chip sm" data-fault="${esc(x)}">${esc(x)}</span>`).join('')}</div>
      <label class="form-label">Fault <span class="text-danger">*</span></label><input name="fault" class="form-control mb-2">
      <label class="form-label">Details</label><input name="faultNotes" class="form-control mb-2" placeholder="What the customer says">
      <div class="row g-2"><div class="col-6"><label class="form-label">Estimate</label><input name="estimate" class="form-control money" inputmode="decimal"></div>
        <div class="col-6"><label class="form-label">Advance taken</label><input name="advance" class="form-control money" inputmode="decimal"></div>
        <div class="col-6"><label class="form-label">Advance to</label><select name="paymentAccountId" class="form-select">${UI.options(accounts, pref.get('payAccount', 'cash'))}</select></div>
        <div class="col-6"><label class="form-label">Expected on</label><input type="date" name="expectedDate" class="form-control" min="${today()}"></div>
        <div class="col-6"><label class="form-label">Technician</label><input name="technician" class="form-control" value="${esc(tech)}"></div>
        <div class="col-6 d-flex align-items-end"><div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" name="urgent" id="j-urgent"><label class="form-check-label" for="j-urgent">Urgent</label></div></div></div></div></div>
    <div class="alert alert-danger py-2 small d-none j-err"></div>
    <div class="d-flex gap-2"><button type="submit" class="btn btn-primary btn-lg flex-grow-1 btn-job"><i class="bi bi-check2-circle me-1"></i>Save &amp; print job card</button></div>
  </div></div></form>`);
  const $f = $el.find('form');
  const imeiCheck = () => {
    const v = cleanImei($f.find('[name=imei]').val()); const p = imeiProblem(v, { required: false });
    $f.find('.imei-msg').html(v ? (p ? `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${esc(p)}</span>` : '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Valid IMEI</span>') : '');
  };
  imeiCheck();
  $f.on('input', '[name=imei]', function () { this.value = this.value.replace(/[^\d\s-]/g, ''); imeiCheck(); });
  $f.on('click', '.btn-scan', async () => { const c = await Scanner.scan({ title: 'Scan IMEI barcode' }); if (c) { $f.find('[name=imei]').val(cleanImei(c).replace(/\D/g, '')); imeiCheck(); } });
  $f.on('click', '[data-fault]', function () { const $i = $f.find('[name=fault]'); $i.val(this.dataset.fault === 'Other' ? '' : this.dataset.fault).trigger('focus'); $f.find('[data-fault]').removeClass('active'); $(this).addClass('active'); });
  $f.on('click', '.btn-cust', async () => {
    const p = await partyPicker('customers');
    if (!p) return;
    s.customerId = p.id; $f.find('[name=customerName]').val(p.name); $f.find('[name=customerPhone]').val(p.phone || '');
    $f.find('.btn-cust span').text(`Customer: ${p.name}`);
  });
  let busy = false;
  $f.on('submit', async (e) => {
    e.preventDefault();
    if (busy) return; busy = true;
    const $b = $f.find('.btn-job').prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Saving…');
    $f.find('.j-err').addClass('d-none');
    try {
      const v = Object.fromEntries(new FormData($f[0]).entries());
      const left = $f.find('[name=left]:checked').map((i, x) => x.value).get().join(', ');
      pref.set('lastTech', v.technician || ''); pref.set('payAccount', v.paymentAccountId);
      const { doc } = await Posting.saveRepair({ ...v, id: s.id, customerId: s.customerId, accessories: left, priority: $f.find('[name=urgent]').prop('checked') ? 'urgent' : 'normal' });
      UI.toast(`${doc.number} created`);
      location.hash = `#/repairs/${encodeURIComponent(doc.id)}`;
      Printer.printDocument('repair', doc, { silentFail: true });
    } catch (err) {
      $f.find('.j-err').text(err.message || String(err)).removeClass('d-none');
      $b.prop('disabled', false).html('<i class="bi bi-check2-circle me-1"></i>Save &amp; print job card');
    } finally { busy = false; }
  });
}

// ---------- detail ----------
const STEPS = [['received', 'Received', 'inbox'], ['diagnosing', 'Diagnosing', 'search'], ['in_progress', 'Repairing', 'wrench-adjustable'], ['ready', 'Ready', 'check2-circle'], ['delivered', 'Delivered', 'bag-check']];
const stepIndex = (st) => ({ received: 0, diagnosing: 1, waiting_parts: 1, in_progress: 2, ready: 3, delivered: 4 }[st] ?? 0);

function stepper(r) {
  if (r.status === 'cancelled') return '<div class="alert alert-danger py-2 mb-3"><i class="bi bi-x-circle me-1"></i>This job was cancelled.</div>';
  const cur = stepIndex(r.status);
  return `<div class="stepper mb-3">${STEPS.map(([k, l, ic], i) => `<div class="step ${i < cur ? 'done' : i === cur ? 'now' : ''}"><div class="dot"><i class="bi bi-${i < cur ? 'check-lg' : ic}"></i></div><div class="lbl">${esc(k === 'diagnosing' && r.status === 'waiting_parts' ? 'Waiting parts' : l)}</div></div>`).join('')}</div>`;
}

async function renderDetail(el, id, setTitle) {
  const $el = $(el);
  const r = await idb.get('repairs', id);
  if (!r) { $el.html(UI.pageHeader('Repair', '', '#/repairs') + UI.emptyState('Job not found', 'tools')); return; }
  setTitle(r.number);
  const closed = ['delivered', 'cancelled'].includes(r.status);
  const total = r.total || 0; const bal = balanceOf(r);
  const kv = (k, v) => (v ? `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>` : '');
  const nextButtons = !closed ? [['diagnosing', 'Start diagnosing', 'search'], ['waiting_parts', 'Waiting for parts', 'hourglass-split'], ['in_progress', 'Repairing', 'wrench-adjustable'], ['ready', 'Mark ready', 'check2-circle']]
    .filter(([k]) => k !== r.status).map(([k, l, ic]) => `<button class="btn btn-outline-primary btn-sm btn-status" data-st="${k}"><i class="bi bi-${ic} me-1"></i>${l}</button>`).join('') : '';
  const waText = r.status === 'ready' ? `Assalam o Alaikum ${r.customerName}, your ${[r.brand, r.model].filter(Boolean).join(' ')} (job ${r.number}) is ready. ${balanceOf(r) > 0 ? `Amount due: ${cur()} ${fmtNum(balanceOf(r))}. ` : ''}Please collect it. — ${getSettings().business.name}` : `Dear ${r.customerName}, update on your ${[r.brand, r.model].filter(Boolean).join(' ')} (job ${r.number}): ${REPAIR_STATUS[r.status]?.label}. — ${getSettings().business.name}`;
  const wa = waLink(r.customerPhone, waText);
  $el.html(UI.pageHeader(r.number, `${!closed ? '<button class="btn btn-success btn-sm btn-deliver"><i class="bi bi-bag-check"></i> Deliver</button>' : ''}
    <div class="dropdown"><button class="btn btn-light btn-sm" data-bs-toggle="dropdown" aria-label="More"><i class="bi bi-three-dots-vertical"></i></button><ul class="dropdown-menu dropdown-menu-end">
      <li><button class="dropdown-item btn-print"><i class="bi bi-printer me-2"></i>Print ${r.status === 'delivered' ? 'receipt' : 'job card'}</button></li>
      ${wa ? `<li><a class="dropdown-item" href="${esc(wa)}" target="_blank" rel="noopener"><i class="bi bi-whatsapp me-2"></i>WhatsApp customer</a></li>` : ''}
      ${!closed ? '<li><button class="dropdown-item btn-edit"><i class="bi bi-pencil me-2"></i>Edit job details</button></li><li><button class="dropdown-item text-danger btn-cancel"><i class="bi bi-x-circle me-2"></i>Cancel job</button></li>' : ''}
      ${r.status === 'delivered' ? '<li><button class="dropdown-item btn-reopen"><i class="bi bi-arrow-counterclockwise me-2"></i>Reopen (warranty / wrong delivery)</button></li>' : ''}</ul></div>`, '#/repairs') + `
    ${stepper(r)}
    <div class="row g-3"><div class="col-lg-7">
      <div class="card mb-3"><div class="card-body">
        <div class="d-flex align-items-start gap-2 mb-2"><div class="flex-grow-1"><div class="h5 mb-0">${esc([r.brand, r.model].filter(Boolean).join(' ') || 'Phone')}</div><div class="text-body-secondary">${esc(r.fault)}</div></div>${sBadge(r.status)}${r.priority === 'urgent' ? '<span class="badge text-bg-danger">Urgent</span>' : ''}</div>
        <div class="kv-grid">${kv('Customer', esc(r.customerName) + (r.customerPhone ? ` · <a href="tel:${esc(r.customerPhone)}">${esc(r.customerPhone)}</a>` : ''))}
          ${kv('IMEI', r.imei ? `<a href="#/imei">${esc(r.imei)}</a>` : '')}${kv('Colour', esc(r.color))}${kv('Received', fmtDate(r.date) + ` (${ageDays(r)} days)`)}
          ${kv('Expected', r.expectedDate ? fmtDate(r.expectedDate) : '')}${kv('Technician', esc(r.technician))}${kv('Left with us', esc(r.accessories))}
          ${kv('Existing damage', esc(r.existingDamage))}${kv('Customer says', esc(r.faultNotes))}${kv('Lock code', r.lockCode ? esc(r.lockCode) : '')}${kv('Diagnosis', esc(r.diagnosis))}
          ${r.status === 'delivered' ? kv('Delivered', fmtDate(r.deliveredDate) + (r.warrantyDays ? ` · warranty ${r.warrantyDays} days` : '')) : ''}</div>
        ${nextButtons ? `<div class="d-flex flex-wrap gap-2 mt-3">${nextButtons}</div>` : ''}</div></div>
      <div class="card"><div class="card-body"><div class="d-flex align-items-center mb-2"><h2 class="h6 mb-0 flex-grow-1"><i class="bi bi-clock-history me-2"></i>Progress</h2></div>
        <div class="timeline">${[...(r.history || [])].reverse().map((h) => `<div class="tl-item"><div class="tl-dot"><i class="bi bi-${REPAIR_STATUS[h.status]?.icon || 'circle'}"></i></div><div><div class="fw-semibold small">${esc(h.note || REPAIR_STATUS[h.status]?.label)}</div><div class="small text-body-secondary">${fmtDateTime(h.at)}${h.by ? ' · ' + esc(h.by) : ''}</div></div></div>`).join('')}</div></div></div>
    </div><div class="col-lg-5">
      <div class="card mb-3"><div class="card-body"><div class="d-flex align-items-center mb-2"><h2 class="h6 mb-0 flex-grow-1"><i class="bi bi-receipt me-2"></i>Charges</h2>${!closed ? '<button class="btn btn-sm btn-outline-primary btn-work"><i class="bi bi-pencil"></i> Edit</button>' : ''}</div>
        ${(r.parts || []).length || r.labour ? `<table class="table table-sm mb-2"><tbody>${r.labour ? `<tr><td>Labour / service</td><td class="num">${fmtNum(r.labour)}</td></tr>` : ''}
          ${(r.parts || []).map((p) => `<tr><td>${esc(p.name)} <span class="text-body-secondary">× ${p.qty}</span></td><td class="num">${fmtNum(p.amount)}</td></tr>`).join('')}
          <tr class="fw-bold"><td>Total</td><td class="num">${cur()} ${fmtNum(total)}</td></tr></tbody></table>`
          : `<div class="text-body-secondary small mb-2">No charges entered yet.${r.estimate ? ` Estimate: <b>${cur()} ${fmtNum(r.estimate)}</b>` : ''} Add labour and parts when the repair is done.</div>`}
        <div class="d-flex justify-content-between"><span>Paid so far</span><b class="money text-success">${cur()} ${fmtNum(r.paid || 0)}</b></div>
        ${r.status !== 'cancelled' ? `<div class="d-flex justify-content-between"><span>${closed ? 'Balance on account' : 'Balance due'}</span><b class="money ${bal > 0.004 ? 'text-danger' : ''}">${cur()} ${fmtNum(bal)}</b></div>` : ''}
        ${!closed ? '<button class="btn btn-outline-success btn-sm w-100 mt-3 btn-adv"><i class="bi bi-cash-coin me-1"></i>Take advance payment</button>' : ''}
        ${(r.payments || []).length ? `<div class="mt-3 small"><div class="text-body-secondary mb-1">Payments</div>${r.payments.map((p) => `<div class="d-flex justify-content-between"><span>${fmtDate(p.date)} · ${esc(p.accountName)} <span class="text-body-secondary">${p.amount < 0 ? 'refund' : p.kind}</span></span><span class="money ${p.amount < 0 ? 'text-danger' : ''}">${fmtNum(p.amount)}</span></div>`).join('')}</div>` : ''}
        ${Auth.can('reports.profit') && r.status === 'delivered' ? `<hr><div class="d-flex justify-content-between small"><span>Parts cost</span><span class="money">${fmtNum(r.partsCost || 0)}</span></div><div class="d-flex justify-content-between small fw-semibold"><span>Profit</span><span class="money text-success">${fmtNum(total - (r.partsCost || 0))}</span></div>` : ''}
      </div></div></div></div>`);
  const reload = () => renderDetail(el, id, setTitle);
  const run = async (fn, ok) => { try { await UI.withLoading(fn); if (ok) UI.toast(ok); reload(); } catch (e) { UI.toastError(e); } };

  $el.on('click', '.btn-status', function () { run(() => Posting.setRepairStatus(id, this.dataset.st), 'Status updated'); });
  $el.on('click', '.btn-print', () => Printer.printDocument('repair', r));
  $el.on('click', '.btn-edit', async () => {
    const v = await UI.formModal({ title: 'Edit job details', size: 'lg', submitLabel: 'Save',
      body: `<div class="row g-2"><div class="col-6"><label class="form-label">Customer</label><input name="customerName" class="form-control" value="${esc(r.customerName)}"></div><div class="col-6"><label class="form-label">Phone</label><input name="customerPhone" class="form-control" value="${esc(r.customerPhone)}"></div>
        <div class="col-6"><label class="form-label">Brand</label><input name="brand" class="form-control" value="${esc(r.brand)}"></div><div class="col-6"><label class="form-label">Model</label><input name="model" class="form-control" value="${esc(r.model)}"></div>
        <div class="col-6"><label class="form-label">IMEI</label><input name="imei" class="form-control" value="${esc(r.imei)}"></div><div class="col-6"><label class="form-label">Colour</label><input name="color" class="form-control" value="${esc(r.color)}"></div>
        <div class="col-12"><label class="form-label">Fault</label><input name="fault" class="form-control" value="${esc(r.fault)}"></div><div class="col-12"><label class="form-label">Details</label><input name="faultNotes" class="form-control" value="${esc(r.faultNotes)}"></div>
        <div class="col-6"><label class="form-label">Left with us</label><input name="accessories" class="form-control" value="${esc(r.accessories)}"></div><div class="col-6"><label class="form-label">Lock code</label><input name="lockCode" class="form-control" value="${esc(r.lockCode)}"></div>
        <div class="col-4"><label class="form-label">Estimate</label><input name="estimate" class="form-control" value="${esc(r.estimate || '')}"></div><div class="col-4"><label class="form-label">Expected</label><input type="date" name="expectedDate" class="form-control" value="${esc(r.expectedDate || '')}"></div>
        <div class="col-4"><label class="form-label">Technician</label><input name="technician" class="form-control" value="${esc(r.technician)}"></div></div>`,
      onSubmit: async (x) => { await Posting.saveRepair({ ...r, ...x, editing: true, advance: 0 }); return true; } });
    if (v) { UI.toast('Job updated'); reload(); }
  });
  $el.on('click', '.btn-cancel', async () => {
    const accs = await payAccounts();
    const v = await UI.formModal({ title: `Cancel ${r.number}`, submitLabel: 'Cancel job', submitClass: 'btn-danger',
      body: `<p class="small text-body-secondary">${r.paid ? `The customer has paid ${cur()} ${fmtNum(r.paid)}. It will be refunded, minus any inspection fee you keep.` : 'No payment has been taken.'}</p>
        <div class="row g-2">${r.paid ? `<div class="col-6"><label class="form-label">Inspection fee to keep</label><input name="fee" class="form-control" inputmode="decimal" value="0"></div><div class="col-6"><label class="form-label">Refund from</label><select name="accountId" class="form-select">${UI.options(accs, 'cash')}</select></div>` : ''}
        <div class="col-12"><label class="form-label">Reason</label><input name="reason" class="form-control" placeholder="Customer declined / not repairable…"></div></div>`,
      onSubmit: async (x) => { await Posting.cancelRepair(id, x); return true; } });
    if (v) { UI.toast('Job cancelled'); reload(); }
  });
  $el.on('click', '.btn-reopen', async () => { if (await UI.confirmDialog('Reopen this job? The income and parts usage are reversed; payments stay as advances.', { okLabel: 'Reopen' })) run(() => Posting.reopenRepair(id), 'Job reopened'); });
  $el.on('click', '.btn-adv', async () => {
    const accs = await payAccounts();
    const v = await UI.formModal({ title: 'Advance payment', submitLabel: 'Receive', body: `<div class="row g-2"><div class="col-6"><label class="form-label">Amount</label><input name="amount" class="form-control form-control-lg money" inputmode="decimal"></div><div class="col-6"><label class="form-label">Into</label><select name="accountId" class="form-select form-select-lg">${UI.options(accs, pref.get('payAccount', 'cash'))}</select></div></div>`,
      onSubmit: async (x) => { await Posting.addRepairPayment(id, x); return true; } });
    if (v) { UI.toast('Advance received'); reload(); }
  });
  $el.on('click', '.btn-work', () => editWork(r, reload));
  $el.on('click', '.btn-deliver', async () => {
    if (!(r.total > 0)) { UI.toast('Enter the repair charges first (Charges → Edit).', 'warning'); return editWork(r, reload); }
    const accs = await payAccounts(); const due = round2(r.total - r.paid);
    const customers = Catalog.allParties('customers').filter((c) => c.active).sort((a, b) => a.name.localeCompare(b.name));
    const v = await UI.formModal({ title: `Deliver ${r.number}`, submitLabel: 'Complete delivery', submitClass: 'btn-success',
      body: `<div class="text-center mb-3"><div class="small text-body-secondary">${due >= 0 ? 'Amount due now' : 'Refund to customer'}</div><div class="display-6 fw-bold money">${cur()} ${fmtNum(Math.abs(due))}</div><div class="small text-body-secondary">Total ${fmtNum(r.total)} · advance ${fmtNum(r.paid)}</div></div>
        <div class="row g-2">${due > 0 ? `<div class="col-6"><label class="form-label">Collect now</label><input name="pay" class="form-control form-control-lg money" inputmode="decimal" value="${due}"></div>` : ''}
          <div class="col-${due > 0 ? 6 : 12}"><label class="form-label">${due >= 0 ? 'Into' : 'Refund from'}</label><select name="accountId" class="form-select form-select-lg">${UI.options(accs, pref.get('payAccount', 'cash'))}</select></div>
          ${due > 0 ? `<div class="col-12"><label class="form-label">If not fully paid — add the balance to customer</label><select name="customerId" class="form-select"><option value="">${r.customerId ? 'Linked customer' : '— none (must pay in full) —'}</option>${UI.options(customers, r.customerId || '')}</select></div>` : ''}</div>`,
      onSubmit: async (x) => { await Posting.deliverRepair(id, { pay: x.pay, accountId: x.accountId, customerId: x.customerId || r.customerId || null }); return true; } });
    if (v) { UI.toast(`${r.number} delivered`); const fresh = await idb.get('repairs', id); if (getSettings().printer.autoPrint) Printer.printDocument('repair', fresh, { silentFail: true }); reload(); }
  });
}

// Charges editor: labour + parts (stock parts or outside parts).
async function editWork(r, onDone) {
  const st = { parts: (r.parts || []).map((p) => ({ ...p })), labour: r.labour || '' };
  const m = UI.modal({
    title: `Charges · ${r.number}`, size: 'lg', static: true,
    body: `<div class="row g-2 mb-2"><div class="col-6"><label class="form-label">Labour / service charge</label><input class="form-control form-control-lg money w-labour" inputmode="decimal" value="${esc(st.labour)}"></div>
      <div class="col-6"><label class="form-label">Repair warranty (days)</label><input class="form-control form-control-lg w-warranty" inputmode="numeric" value="${esc(r.warrantyDays ?? 30)}"></div></div>
      <div class="d-flex align-items-center mb-1"><div class="fw-semibold flex-grow-1">Parts used</div><button class="btn btn-sm btn-outline-primary me-1 w-add-stock"><i class="bi bi-box-seam me-1"></i>From stock</button><button class="btn btn-sm btn-outline-secondary w-add-out"><i class="bi bi-plus-lg me-1"></i>Other part</button></div>
      <div class="parts-rows"></div>
      <div class="row g-2 mt-1"><div class="col-6"><label class="form-label">Technician</label><input class="form-control w-tech" value="${esc(r.technician || '')}"></div><div class="col-6"><label class="form-label">Diagnosis / work done</label><input class="form-control w-diag" value="${esc(r.diagnosis || '')}"></div></div>
      <div class="d-flex justify-content-between align-items-center mt-3 p-2 rounded bg-body-secondary"><span>Total charges</span><b class="fs-5 money w-total"></b></div>
      <div class="alert alert-danger py-2 small d-none w-err mt-2 mb-0"></div>`,
    footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary w-save">Save charges</button>',
  });
  const $m = m.$el;
  const draw = () => {
    $m.find('.parts-rows').html(st.parts.length ? '<div class="part-head"><span class="flex-grow-1">Part</span><span style="width:56px">Qty</span><span style="width:78px">Your cost</span><span style="width:78px">Price</span><span style="width:30px"></span></div>' + st.parts.map((p, i) => `<div class="part-row" data-i="${i}">
      <div class="flex-grow-1 min-w-0"><input class="form-control form-control-sm p-name" value="${esc(p.name)}" ${p.productId ? 'readonly' : ''} placeholder="Part name">
        ${p.productId ? '<div class="small text-body-secondary">From your stock — cost taken automatically</div>' : `<label class="small text-body-secondary"><input type="checkbox" class="p-cash" ${p.outsideCash ? 'checked' : ''}> bought with shop cash (records an expense)</label>`}</div>
      <input class="form-control form-control-sm p-qty" inputmode="decimal" value="${p.qty}" aria-label="Quantity" title="Qty">
      ${p.productId ? '<span style="width:78px;flex:0 0 78px"></span>' : `<input class="form-control form-control-sm p-cost" inputmode="decimal" value="${p.cost || ''}" placeholder="Cost" aria-label="Cost" title="Your cost">`}
      <input class="form-control form-control-sm p-price" inputmode="decimal" value="${p.price || ''}" placeholder="Price" aria-label="Price" title="Charge to customer">
      <button class="btn btn-sm btn-link text-danger p-rm" aria-label="Remove"><i class="bi bi-trash"></i></button></div>`).join('') : '<div class="small text-body-secondary py-2">No parts added. Labour only is fine.</div>');
    total();
  };
  const read = () => { $m.find('.part-row').each(function () { const i = +this.dataset.i; const p = st.parts[i]; if (!p) return; const $r = $(this);
    p.name = $r.find('.p-name').val(); p.qty = $r.find('.p-qty').val(); p.price = $r.find('.p-price').val(); if (!p.productId) { p.cost = $r.find('.p-cost').val(); p.outsideCash = $r.find('.p-cash').prop('checked'); } }); st.labour = $m.find('.w-labour').val(); };
  const total = () => { const c = Posting.previewRepair(st.parts, st.labour); $m.find('.w-total').text(c ? `${cur()} ${fmtNum(c.total)}` : '—'); };
  draw();
  $m.on('input', '.part-row input, .w-labour', () => { read(); total(); });
  $m.on('click', '.p-rm', function () { read(); st.parts.splice(+$(this).closest('.part-row').data('i'), 1); draw(); });
  $m.on('click', '.w-add-out', () => { read(); st.parts.push({ productId: null, name: '', qty: 1, cost: '', price: '', outsideCash: false }); draw(); });
  $m.on('click', '.w-add-stock', async () => {
    read();
    const hit = await UI.pick({ title: 'Part from stock', placeholder: 'Search parts / accessories…', search: async (q) => Catalog.searchProducts(q, { limit: 30 }).filter((p) => p.trackStock !== false).map((p) => ({ id: p.id, title: p.name, subtitle: `Stock ${p.stock}`, right: fmtNum(p.salePrice), value: p })) });
    if (!hit) return;
    st.parts.push({ productId: hit.value.id, name: hit.value.name, qty: 1, cost: hit.value.purchasePrice || 0, price: hit.value.salePrice || 0 }); draw();
  });
  $m.find('.w-save').on('click', async function () {
    read(); const $b = $(this).prop('disabled', true);
    try {
      await Posting.saveRepairWork(r.id, { parts: st.parts, labour: st.labour, warrantyDays: $m.find('.w-warranty').val(), technician: $m.find('.w-tech').val(), diagnosis: $m.find('.w-diag').val() });
      m.close(); UI.toast('Charges saved'); onDone();
    } catch (e) { $m.find('.w-err').text(e.message || String(e)).removeClass('d-none'); $b.prop('disabled', false); }
  });
}

export default {
  async render(el, { params, setTitle }) {
    if (params[0] && params[0].startsWith('new')) return renderNew(el, setTitle);
    if (params[0]) return renderDetail(el, params[0], setTitle);
    return renderList(el);
  },
};
