// Phones: IMEI stock list & detail, buying phones (new from dealers / used from people), IMEI lookup.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, fmtDateTime, uuid, num, round2, today, debounce, AppError } from '../core/utils.js';
import { cur } from '../core/views.js';
import { getSettings, pref } from '../core/settings.js';
import { BRANDS, CONDITIONS, PTA, STORAGES, RAMS, DEVICE_STATUS, cleanImei, imeiProblem, deviceName, ptaBadge, condBadge } from '../core/mobile.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Scanner from '../scanner/scanner.js';
import { printHTML } from '../printer/printer.js';
import { partyPicker } from './parties.js';

const $ = window.jQuery;
const opt = (obj, sel, key = 'label') => Object.entries(obj).map(([k, v]) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(v[key])}</option>`).join('');
const list = (arr, sel, blank = 'Select…') => `<option value="">${blank}</option>` + arr.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');
const daysIn = (d) => Math.max(0, Math.floor((Date.now() - new Date((d.purchaseDate || d.createdAt || today()).slice(0, 10) + 'T00:00:00')) / 86400000));

// ---------- shared phone form ----------
export function deviceFormHTML(d = {}, { cost = false, edit = false, costLabel = 'Buying price', seller = false } = {}) {
  return `<div class="row g-2 device-form">
    <div class="col-12"><label class="form-label">IMEI 1 <span class="text-danger">*</span> <span class="small text-body-secondary">(dial *#06# on the phone)</span></label>
      <div class="input-group"><input name="imei1" class="form-control form-control-lg imei-in" inputmode="numeric" maxlength="20" autocomplete="off" value="${esc(d.imei1 || '')}" placeholder="15-digit IMEI">
        <button type="button" class="btn btn-outline-secondary btn-scan-imei" data-target="imei1" aria-label="Scan IMEI barcode"><i class="bi bi-upc-scan"></i></button></div>
      <div class="imei-msg small mt-1" data-for="imei1"></div></div>
    <div class="col-12"><label class="form-label">IMEI 2 <span class="small text-body-secondary">(dual-SIM phones, optional)</span></label>
      <div class="input-group"><input name="imei2" class="form-control imei-in" inputmode="numeric" maxlength="20" autocomplete="off" value="${esc(d.imei2 || '')}" placeholder="Optional">
        <button type="button" class="btn btn-outline-secondary btn-scan-imei" data-target="imei2" aria-label="Scan IMEI barcode"><i class="bi bi-upc-scan"></i></button></div>
      <div class="imei-msg small mt-1" data-for="imei2"></div></div>
    <div class="col-6"><label class="form-label">Brand <span class="text-danger">*</span></label><input name="brand" class="form-control" list="brands-dl" value="${esc(d.brand || '')}" autocomplete="off"><datalist id="brands-dl">${BRANDS.map((b) => `<option value="${esc(b)}">`).join('')}</datalist></div>
    <div class="col-6"><label class="form-label">Model <span class="text-danger">*</span></label><input name="model" class="form-control" value="${esc(d.model || '')}" placeholder="e.g. iPhone 13 / Galaxy A54" autocomplete="off"></div>
    <div class="col-4"><label class="form-label">Storage</label><select name="storage" class="form-select">${list(STORAGES, d.storage, '—')}</select></div>
    <div class="col-4"><label class="form-label">RAM</label><select name="ram" class="form-select">${list(RAMS, d.ram, '—')}</select></div>
    <div class="col-4"><label class="form-label">Colour</label><input name="color" class="form-control" value="${esc(d.color || '')}"></div>
    <div class="col-6"><label class="form-label">Condition</label><select name="condition" class="form-select">${opt(CONDITIONS, d.condition || 'used')}</select></div>
    <div class="col-6"><label class="form-label">PTA status</label><select name="pta" class="form-select">${opt(PTA, d.pta || 'unknown')}</select></div>
    <div class="col-12 pta-help small"></div>
    <div class="col-4"><label class="form-label">Battery %</label><input name="battery" class="form-control" inputmode="numeric" maxlength="3" value="${esc(d.battery || '')}" placeholder="iPhone"></div>
    <div class="col-8"><label class="form-label">Comes with</label><input name="accessories" class="form-control" value="${esc(d.accessories || '')}" placeholder="Box, charger, cable, bill…"></div>
    ${cost ? `<div class="col-6"><label class="form-label">${esc(costLabel)} <span class="text-danger">*</span></label><input name="cost" class="form-control form-control-lg money" inputmode="decimal" value="${esc(d.cost ?? '')}"></div>` : ''}
    <div class="${cost ? 'col-6' : 'col-6'}"><label class="form-label">Selling price</label><input name="salePrice" class="form-control ${cost ? 'form-control-lg' : ''} money" inputmode="decimal" value="${esc(d.salePrice ?? '')}"></div>
    ${edit ? `<div class="col-6"><label class="form-label">Extra cost <span class="small text-body-secondary">(repair/refurb)</span></label><input name="extraCost" class="form-control money" inputmode="decimal" value="${esc(d.extraCost || '')}"></div>` : ''}
    <div class="col-12"><label class="form-label">Notes</label><input name="notes" class="form-control" value="${esc(d.notes || '')}" placeholder="Scratches, face-id issue, replaced screen…"></div>
    ${seller ? `<div class="col-12"><div class="small fw-semibold mt-1"><i class="bi bi-person-vcard me-1"></i>Whose phone is it? <span class="text-body-secondary fw-normal">(kept for your record)</span></div></div>
      <div class="col-6"><label class="form-label">Name</label><input name="sellerName" class="form-control" value="${esc(d.sellerName || '')}"></div>
      <div class="col-6"><label class="form-label">CNIC</label><input name="sellerCnic" class="form-control" inputmode="numeric" maxlength="15" value="${esc(d.sellerCnic || '')}"></div>
      <div class="col-12"><label class="form-label">Phone</label><input name="sellerPhone" class="form-control" inputmode="tel" value="${esc(d.sellerPhone || '')}"></div>` : ''}
  </div>`;
}

const PTA_HINT = {
  non_pta: 'Non-PTA phones must be registered (or work only through a bypass/JV patch). Tell the buyer clearly before selling.',
  jv: 'JV / patched phones can stop working on a local SIM after an update — mention it to the buyer.',
  unknown: 'Check the IMEI on the PTA DVS site (button below) before you pay for or sell the phone.',
};

export function bindDeviceForm($m) {
  const scope = $m.find('.device-form');
  const showPta = () => {
    const k = scope.find('[name=pta]').val();
    scope.find('.pta-help').html(`${PTA_HINT[k] ? `<div class="text-body-secondary mb-1"><i class="bi bi-info-circle me-1"></i>${esc(PTA_HINT[k])}</div>` : ''}
      <button type="button" class="btn btn-sm btn-outline-secondary btn-pta"><i class="bi bi-shield-check me-1"></i>Check PTA status</button>
      <span class="text-body-secondary ms-1">copies the IMEI and opens PTA DVS (or SMS the IMEI to 8484)</span>`);
  };
  showPta();
  scope.on('change', '[name=pta]', showPta);
  scope.on('click', '.btn-pta', async () => {
    const imei = cleanImei(scope.find('[name=imei1]').val());
    if (imei) { try { await navigator.clipboard.writeText(imei); UI.toast('IMEI copied — paste it on the PTA site', 'info', 2500); } catch { /* clipboard unavailable */ } }
    window.open('https://dvs.pta.gov.pk/', '_blank', 'noopener');
  });
  scope.on('click', '.btn-scan-imei', async function () {
    const code = await Scanner.scan({ title: 'Scan the IMEI barcode' });
    if (!code) return;
    const digits = cleanImei(code).replace(/\D/g, '');
    const $i = scope.find(`[name=${this.dataset.target}]`).val(digits.slice(0, 16)).trigger('input');
    $i.trigger('focus');
  });
  const check = debounce(async (input) => {
    const name = input.name; const raw = input.value; const $msg = scope.find(`.imei-msg[data-for=${name}]`);
    const v = cleanImei(raw);
    if (!v) { $msg.empty(); return; }
    const p = imeiProblem(v, { required: name === 'imei1' });
    if (p) { $msg.html(`<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${esc(p)}</span>`); return; }
    const stock = Catalog.allDevices().find((d) => d.imei1 === v || d.imei2 === v);
    if (stock) { $msg.html(`<span class="text-danger"><i class="bi bi-exclamation-triangle me-1"></i>Already in your stock: ${esc(deviceName(stock))}</span>`); return; }
    const old = await Posting.lookupImei(v);
    if (old && old.status !== 'in_stock') $msg.html(`<span class="text-warning-emphasis"><i class="bi bi-clock-history me-1"></i>You handled this phone before (${esc(DEVICE_STATUS[old.status]?.label || old.status)}${old.soldDate ? ' · sold ' + esc(fmtDate(old.soldDate)) : ''}).</span>`);
    else $msg.html('<span class="text-success"><i class="bi bi-check-circle me-1"></i>Valid IMEI</span>');
  }, 250);
  scope.on('input', '.imei-in', function () { this.value = this.value.replace(/[^\d\s-]/g, ''); check(this); });
  scope.find('.imei-in').each(function () { if (this.value) check(this); });
}

const readDevice = (v) => ({ imei1: cleanImei(v.imei1), imei2: cleanImei(v.imei2), brand: (v.brand || '').trim(), model: (v.model || '').trim(), storage: v.storage || '', ram: v.ram || '', color: (v.color || '').trim(),
  condition: v.condition || 'used', pta: v.pta || 'unknown', battery: (v.battery || '').trim(), accessories: (v.accessories || '').trim(), notes: (v.notes || '').trim(),
  cost: v.cost === undefined ? undefined : round2(num(v.cost)), salePrice: round2(num(v.salePrice)),
  sellerName: (v.sellerName || '').trim(), sellerCnic: (v.sellerCnic || '').trim(), sellerPhone: (v.sellerPhone || '').trim() });

// Modal used by the buy screen and by POS trade-in. Resolves with a device object (not yet saved) or null.
export function deviceModal(prefill = {}, { title = 'Phone details', cost = true, submitLabel = 'Add phone', costLabel = 'Buying price', seller = false } = {}) {
  return UI.formModal({
    title, submitLabel, size: 'lg', body: deviceFormHTML(prefill, { cost, costLabel, seller }),
    onShown: ($m) => { bindDeviceForm($m); $m.find('[name=imei1]').trigger('focus'); },
    onSubmit: (v) => {
      const d = readDevice(v);
      const p = imeiProblem(d.imei1); if (p) throw new AppError(p);
      const p2 = imeiProblem(d.imei2, { required: false }); if (p2) throw new AppError('IMEI 2: ' + p2);
      if (!d.brand || !d.model) throw new AppError('Brand and model are required.');
      if (cost && !(d.cost >= 0) ) throw new AppError('Enter the buying price.');
      if (cost && v.cost === '') throw new AppError('Enter the buying price.');
      const dup = Catalog.allDevices().find((x) => x.imei1 === d.imei1 || x.imei2 === d.imei1 || (d.imei2 && (x.imei1 === d.imei2 || x.imei2 === d.imei2)));
      if (dup && dup.id !== prefill.id) throw new AppError(`This IMEI is already in stock (${deviceName(dup)}).`);
      return d;
    },
  });
}

// ---------- phone stock list ----------
async function renderList(el) {
  const $el = $(el);
  const all = (await idb.getAll('devices')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const showCost = Auth.can('reports.profit');
  const f = { q: '', status: pref.get('phoneStatus', 'in_stock'), cond: '', brand: '', pta: '' };
  const stock = all.filter((d) => d.status === 'in_stock');
  const brands = [...new Set(all.map((d) => d.brand))].sort();
  const stockCost = round2(stock.reduce((s, d) => s + (d.costTotal || 0), 0));
  const stockSale = round2(stock.reduce((s, d) => s + (d.salePrice || 0), 0));
  const old = stock.filter((d) => daysIn(d) > 30).length;
  const byCond = Object.fromEntries(Object.keys(CONDITIONS).map((k) => [k, stock.filter((d) => d.condition === k).length]));
  $el.html(UI.pageHeader('Phone Stock', `${Auth.can('phone.buy') ? '<a class="btn btn-primary btn-sm" href="#/phonebuy"><i class="bi bi-plus-lg"></i> Buy phone</a>' : ''}<a class="btn btn-light btn-sm" href="#/imei"><i class="bi bi-upc-scan"></i><span class="d-none d-sm-inline"> IMEI check</span></a>`) + `
    <div class="row g-2 mb-3 stagger">
      <div class="col-6 col-lg-3"><div class="mini-stat tint-green"><i class="bi bi-phone"></i><div><div class="v" data-count="${stock.length}">0</div><div class="l">Phones in stock</div></div></div></div>
      <div class="col-6 col-lg-3"><div class="mini-stat tint-indigo"><i class="bi bi-cash-stack"></i><div><div class="v money" data-count="${showCost ? stockCost : stockSale}" data-money="1">0</div><div class="l">${showCost ? 'Stock cost value' : 'Stock sale value'}</div></div></div></div>
      <div class="col-6 col-lg-3"><div class="mini-stat tint-cyan"><i class="bi bi-graph-up-arrow"></i><div><div class="v money" data-count="${round2(stockSale - stockCost)}" data-money="1">0</div><div class="l">Expected profit</div></div></div></div>
      <div class="col-6 col-lg-3"><div class="mini-stat ${old ? 'tint-amber' : 'tint-slate'}"><i class="bi bi-hourglass-split"></i><div><div class="v" data-count="${old}">0</div><div class="l">Unsold over 30 days</div></div></div></div>
    </div>
    <div class="chips mb-2 status-chips">
      ${[['in_stock', `In stock (${stock.length})`], ['sold', 'Sold'], ['all', 'All']].map(([k, l]) => `<span class="chip ${f.status === k ? 'active' : ''}" data-status="${k}">${l}</span>`).join('')}
      <span class="chip-sep"></span>
      ${Object.entries(CONDITIONS).map(([k, c]) => `<span class="chip cond-chip" data-cond="${k}"><i class="bi bi-${c.icon} me-1"></i>${esc(c.short)} ${byCond[k] ? `<b>${byCond[k]}</b>` : ''}</span>`).join('')}
    </div>
    <div class="filters">
      <input type="search" class="form-control flex-grow-2 q" placeholder="Search IMEI, model, brand, colour…" inputmode="search">
      <select class="form-select f-brand"><option value="">All brands</option>${brands.map((b) => `<option>${esc(b)}</option>`).join('')}</select>
      <select class="form-select f-pta"><option value="">Any PTA status</option>${opt(PTA, '', 'short')}</select>
    </div>
    <div class="small text-body-secondary mb-2 summary"></div>
    <div class="phone-grid"></div>`);
  UI.countUp(el, (v, n) => (n.dataset.money ? `${cur()} ${fmtNum(v)}` : String(Math.round(v))));
  const draw = () => {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = all.filter((d) => (f.status === 'all' || d.status === f.status) && (!f.cond || d.condition === f.cond) && (!f.brand || d.brand === f.brand) && (!f.pta || d.pta === f.pta)
      && terms.every((t) => `${d.brand} ${d.model} ${d.storage} ${d.color} ${d.imei1} ${d.imei2 || ''}`.toLowerCase().includes(t)));
    $el.find('.summary').text(`${rows.length} phone${rows.length === 1 ? '' : 's'}`);
    $el.find('.phone-grid').html(rows.slice(0, 200).map((d) => {
      const days = daysIn(d); const stockD = d.status === 'in_stock';
      return `<a class="phone-card ${d.status}" href="#/phones/${encodeURIComponent(d.id)}">
        <div class="pc-top"><div class="pc-icon tint-${UI.tintFor(d.brand)}"><i class="bi bi-phone"></i></div>
          <div class="min-w-0 flex-grow-1"><div class="pc-name">${esc(deviceName(d))}</div><div class="pc-imei">IMEI ${esc(d.imei1)}</div></div>
          <div class="pc-price">${fmtNum(d.status === 'sold' ? d.soldPrice : d.salePrice)}</div></div>
        <div class="pc-tags">${condBadge(d.condition)}${ptaBadge(d.pta)}${d.battery ? `<span class="badge tint-slate"><i class="bi bi-battery-half"></i> ${esc(d.battery)}%</span>` : ''}
          ${stockD ? `<span class="badge ${days > 30 ? 'tint-amber' : 'tint-slate'}">${days}d in stock</span>` : `<span class="badge tint-slate">${esc(DEVICE_STATUS[d.status]?.label || d.status)}</span>`}
          ${showCost && stockD ? `<span class="badge tint-indigo">Cost ${fmtNum(d.costTotal)}</span>` : ''}</div></a>`;
    }).join('') || UI.emptyState('No phones match. Use “Buy phone” to add stock.', 'phone'));
    $el.find('.status-chips [data-status]').each(function () { $(this).toggleClass('active', this.dataset.status === f.status); });
    $el.find('.cond-chip').each(function () { $(this).toggleClass('active', this.dataset.cond === f.cond); });
  };
  $el.on('input', '.q', debounce((e) => { f.q = $el.find('.q').val(); draw(); }, 150));
  $el.on('change', '.f-brand', function () { f.brand = this.value; draw(); });
  $el.on('change', '.f-pta', function () { f.pta = this.value; draw(); });
  $el.on('click', '[data-status]', function () { f.status = this.dataset.status; pref.set('phoneStatus', f.status); draw(); });
  $el.on('click', '.cond-chip', function () { f.cond = f.cond === this.dataset.cond ? '' : this.dataset.cond; draw(); });
  draw();
}

// ---------- phone detail ----------
const HIST_ICON = { purchased: 'bag-plus', trade_in: 'arrow-left-right', sold: 'cart-check', sale_return: 'arrow-return-left', purchase_return: 'truck', edited: 'pencil', sale_reverted: 'arrow-counterclockwise', return_voided: 'arrow-counterclockwise' };

function tagLabelHTML(d) {
  const b = getSettings().business;
  return `<div class="receipt w58"><div class="c b">${esc(b.name)}</div><div class="c b big">${esc(deviceName(d))}</div><div class="c">${esc(CONDITIONS[d.condition]?.short || '')} · ${esc(PTA[d.pta]?.short || '')}${d.battery ? ` · Battery ${esc(d.battery)}%` : ''}</div>
    <div class="c">IMEI ${esc(d.imei1)}</div><hr><div class="c b big">${cur()} ${fmtNum(d.salePrice)}</div>${d.accessories ? `<div class="c small">${esc(d.accessories)}</div>` : ''}</div>`;
}

async function renderDetail(el, id, setTitle) {
  const $el = $(el);
  const d = await idb.get('devices', id);
  if (!d) { $el.html(UI.pageHeader('Phone', '', '#/phones') + UI.emptyState('Phone not found', 'phone')); return; }
  setTitle(deviceName(d));
  const [repairs] = await Promise.all([idb.getAllByIndex('repairs', 'imei', d.imei1)]);
  const showCost = Auth.can('reports.profit');
  const stockD = d.status === 'in_stock';
  const warrantyLeft = d.status === 'sold' && d.warrantyDays ? Math.ceil((new Date(d.soldDate + 'T00:00:00').getTime() + d.warrantyDays * 86400000 - Date.now()) / 86400000) : null;
  const row = (k, v) => (v ? `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>` : '');
  const profit = d.status === 'sold' ? round2((d.soldPrice || 0) - (d.costTotal || 0)) : null;
  $el.html(UI.pageHeader(deviceName(d), `${stockD && Auth.can('sale.create') ? '<button class="btn btn-success btn-sm btn-sell"><i class="bi bi-cart-plus"></i> Sell</button>' : ''}
    <div class="dropdown"><button class="btn btn-light btn-sm" data-bs-toggle="dropdown" aria-label="More"><i class="bi bi-three-dots-vertical"></i></button><ul class="dropdown-menu dropdown-menu-end">
      ${Auth.can('phone.edit') ? '<li><button class="dropdown-item btn-edit"><i class="bi bi-pencil me-2"></i>Edit details / price</button></li>' : ''}
      <li><button class="dropdown-item btn-tag"><i class="bi bi-tag me-2"></i>Print price tag</button></li>
      <li><button class="dropdown-item btn-copy"><i class="bi bi-clipboard me-2"></i>Copy IMEI</button></li>
      <li><a class="dropdown-item" href="#/repairs/new?imei=${encodeURIComponent(d.imei1)}"><i class="bi bi-tools me-2"></i>New repair job</a></li></ul></div>`, '#/phones') + `
    <div class="row g-3"><div class="col-lg-7">
      <div class="card device-hero ${d.status}"><div class="card-body">
        <div class="d-flex align-items-start gap-3"><div class="pc-icon lg tint-${UI.tintFor(d.brand)}"><i class="bi bi-phone"></i></div>
          <div class="flex-grow-1 min-w-0"><div class="h5 mb-1">${esc(deviceName(d))}</div><div class="imei-big">${esc(d.imei1)}</div>${d.imei2 ? `<div class="imei-big sm">${esc(d.imei2)}</div>` : ''}
            <div class="d-flex flex-wrap gap-1 mt-2">${condBadge(d.condition)}${ptaBadge(d.pta)}<span class="badge tint-${DEVICE_STATUS[d.status]?.tint || 'slate'}">${esc(DEVICE_STATUS[d.status]?.label || d.status)}</span></div></div>
          <div class="text-end"><div class="small text-body-secondary">${d.status === 'sold' ? 'Sold for' : 'Selling price'}</div><div class="h4 mb-0 money text-nowrap">${cur()} ${fmtNum(d.status === 'sold' ? d.soldPrice : d.salePrice)}</div></div></div>
        <hr>
        <div class="kv-grid">${row('Storage / RAM', esc([d.storage, d.ram].filter(Boolean).join(' / ')))}${row('Colour', esc(d.color))}${row('Battery health', d.battery ? esc(d.battery) + '%' : '')}${row('Comes with', esc(d.accessories))}
          ${row('Bought on', fmtDate(d.purchaseDate) + (d.purchaseNo ? ` · <a href="#/purchases/${encodeURIComponent(d.purchaseId)}">${esc(d.purchaseNo)}</a>` : ''))}
          ${stockD ? row('In stock for', `${daysIn(d)} days`) : ''}
          ${showCost ? row('Buying price', `${cur()} ${fmtNum(d.purchasePrice)}`) : ''}${showCost && d.extraCost ? row('Extra cost', `${cur()} ${fmtNum(d.extraCost)}`) : ''}
          ${showCost && stockD && d.salePrice ? row('Expected profit', `${cur()} ${fmtNum(d.salePrice - d.costTotal)}`) : ''}
          ${showCost && profit !== null ? row('Profit on this phone', `<b class="${profit < 0 ? 'text-danger' : 'text-success'}">${cur()} ${fmtNum(profit)}</b>`) : ''}
          ${d.status === 'sold' ? row('Sold to', `${esc(d.customerName || 'Walk-in')} on ${fmtDate(d.soldDate)} · <a href="#/sales/${encodeURIComponent(d.saleId)}">${esc(d.saleNo)}</a>`) : ''}
          ${warrantyLeft !== null ? row('Shop warranty', warrantyLeft > 0 ? `<span class="text-success fw-semibold">${warrantyLeft} day(s) left</span> of ${d.warrantyDays}` : `<span class="text-danger">Expired</span> (${d.warrantyDays} days)`) : ''}
          ${row('Notes', esc(d.notes))}</div>
        ${d.source !== 'supplier' && d.sellerName ? `<div class="seller-box mt-3"><div class="small fw-semibold mb-1"><i class="bi bi-person-vcard me-1"></i>Bought from ${d.source === 'trade-in' ? '(trade-in)' : '(person)'}</div>
          <div>${esc(d.sellerName)}${d.sellerPhone ? ' · ' + esc(d.sellerPhone) : ''}</div>${d.sellerCnic ? `<div class="small text-body-secondary">CNIC ${esc(d.sellerCnic)}</div>` : ''}${d.sellerAddress ? `<div class="small text-body-secondary">${esc(d.sellerAddress)}</div>` : ''}</div>` : ''}
      </div></div>
      ${repairs.length ? `<h2 class="h6 mt-3">Repair history</h2><div class="list-card">${repairs.map((r) => `<a class="list-row" href="#/repairs/${encodeURIComponent(r.id)}"><div class="main"><div class="title">${esc(r.number)} · ${esc(r.fault)}</div><div class="sub">${fmtDate(r.date)} · ${esc(r.status)}</div></div><div class="end money">${fmtNum(r.total || r.estimate || 0)}</div></a>`).join('')}</div>` : ''}
    </div><div class="col-lg-5"><div class="card"><div class="card-body"><h2 class="h6 mb-3"><i class="bi bi-clock-history me-2"></i>History of this IMEI</h2>
      <div class="timeline">${[...(d.history || [])].reverse().map((h) => `<div class="tl-item"><div class="tl-dot"><i class="bi bi-${HIST_ICON[h.type] || 'circle'}"></i></div>
        <div><div class="fw-semibold small">${esc(h.note || h.type)}</div><div class="small text-body-secondary">${fmtDateTime(h.at)}${h.ref ? ' · ' + esc(h.ref) : ''}${h.by ? ' · ' + esc(h.by) : ''}</div></div></div>`).join('') || '<div class="small text-body-secondary">No history recorded.</div>'}</div></div></div></div></div>`);
  $el.on('click', '.btn-sell', () => { sessionStorage.setItem('mobishop.addDevice', d.id); location.hash = '#/pos'; });
  $el.on('click', '.btn-copy', async () => { try { await navigator.clipboard.writeText(d.imei1); UI.toast('IMEI copied'); } catch { UI.toast(d.imei1, 'info', 6000); } });
  $el.on('click', '.btn-tag', () => printHTML(tagLabelHTML(d), { width: 58 }));
  $el.on('click', '.btn-edit', async () => {
    const r = await UI.formModal({
      title: 'Edit phone', size: 'lg', submitLabel: 'Save',
      body: stockD ? deviceFormHTML(d, { edit: true }) : `<div class="alert alert-info small">This phone is ${esc(DEVICE_STATUS[d.status]?.label.toLowerCase())}. Only the notes can be changed.</div><label class="form-label">Notes</label><input name="notes" class="form-control" value="${esc(d.notes || '')}">`,
      onShown: ($m) => { if (stockD) bindDeviceForm($m); },
      onSubmit: async (v) => { await Posting.updateDevice(d.id, v); return true; },
    });
    if (r) { UI.toast('Phone updated'); renderDetail(el, id, setTitle); }
  });
}

// ---------- buy / trade-in screen ----------
function agreementHTML(doc, devices) {
  const b = getSettings().business; const s = doc.seller || {};
  return `<div class="print-report agreement"><div style="text-align:center"><h2 style="margin:0">${esc(b.name)}</h2><div>${esc(b.address || '')} ${b.phone ? '· ' + esc(b.phone) : ''}</div>
    <h3 style="margin:10px 0 2px">PHONE PURCHASE RECEIPT</h3><div>خریداری کی رسید</div></div>
    <table style="width:100%;margin:10px 0"><tr><td>No: <b>${esc(doc.number)}</b></td><td style="text-align:right">Date: <b>${esc(fmtDate(doc.date))}</b></td></tr></table>
    <table style="width:100%;border-collapse:collapse" border="1" cellpadding="5"><tr><td style="width:30%">Seller name</td><td><b>${esc(s.name || doc.supplierName)}</b></td></tr>
      ${s.cnic ? `<tr><td>CNIC</td><td><b>${esc(s.cnic)}</b></td></tr>` : ''}${s.phone ? `<tr><td>Phone</td><td>${esc(s.phone)}</td></tr>` : ''}${s.address ? `<tr><td>Address</td><td>${esc(s.address)}</td></tr>` : ''}</table>
    <table style="width:100%;border-collapse:collapse;margin-top:10px" border="1" cellpadding="5"><tr><th align="left">Phone</th><th align="left">IMEI</th><th align="left">Condition / PTA</th><th align="right">Price (${esc(cur())})</th></tr>
      ${devices.map((d) => `<tr><td>${esc(deviceName(d))}</td><td>${esc(d.imei1)}${d.imei2 ? '<br>' + esc(d.imei2) : ''}</td><td>${esc(CONDITIONS[d.condition]?.short || '')} / ${esc(PTA[d.pta]?.short || '')}</td><td align="right">${fmtNum(d.purchasePrice ?? d.cost)}</td></tr>`).join('')}
      <tr><td colspan="3" align="right"><b>Total paid</b></td><td align="right"><b>${fmtNum(doc.total)}</b></td></tr></table>
    <p style="margin-top:12px;font-size:12px">I declare that I am the lawful owner of the phone(s) above. They are not stolen, snatched or blocked, and I am selling them of my own free will. I have removed my accounts (Apple ID / Google / Mi account).</p>
    <p dir="rtl" style="font-size:15px">میں تصدیق کرتا ہوں کہ مذکورہ موبائل میری ملکیت ہے، چوری یا چھینا ہوا نہیں ہے، اور میں اپنی مرضی سے فروخت کر رہا ہوں۔ میں نے اپنے اکاؤنٹس (Apple ID / Google / Mi) ہٹا دیے ہیں۔</p>
    <table style="width:100%;margin-top:34px"><tr><td style="border-top:1px solid #000;width:40%;text-align:center">Seller signature / thumb</td><td></td><td style="border-top:1px solid #000;width:40%;text-align:center">Buyer (${esc(b.name)})</td></tr></table></div>`;
}

async function renderBuy(el, setTitle) {
  Auth.require('phone.buy');
  setTitle('Buy / Trade-in Phone');
  const $el = $(el);
  const accounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active).sort((a, b) => (a.id === 'cash' ? -1 : b.id === 'cash' ? 1 : a.name.localeCompare(b.name)));
  const st = { id: uuid(), source: 'person', supplierId: null, supplierName: '', seller: { name: '', cnic: '', phone: '', address: '' }, devices: [], paid: '', account: pref.get('payAccount', 'cash'), date: today(), refNo: '', note: '' };
  const total = () => round2(st.devices.reduce((s, d) => s + (d.cost || 0), 0));
  const draw = () => {
    const t = total();
    const person = st.source === 'person';
    $el.html(UI.pageHeader('Buy Phone', '', '#/phones') + `
      <div class="row g-3"><div class="col-lg-7">
        <div class="seg mb-3"><button class="seg-btn ${person ? 'active' : ''}" data-src="person"><i class="bi bi-person me-1"></i>From a person<span>used phone</span></button>
          <button class="seg-btn ${!person ? 'active' : ''}" data-src="supplier"><i class="bi bi-truck me-1"></i>From dealer / supplier<span>new or used stock</span></button></div>
        <div class="card mb-3"><div class="card-body">
          ${person ? `<h2 class="h6 mb-2"><i class="bi bi-person-vcard me-2"></i>Seller details <span class="small text-body-secondary fw-normal">— keep a record of who sold you the phone</span></h2>
            <div class="row g-2"><div class="col-6"><label class="form-label">Name <span class="text-danger">*</span></label><input class="form-control s-in" data-f="name" value="${esc(st.seller.name)}"></div>
              <div class="col-6"><label class="form-label">CNIC</label><input class="form-control s-in" data-f="cnic" inputmode="numeric" maxlength="15" placeholder="35202-1234567-1" value="${esc(st.seller.cnic)}"></div>
              <div class="col-6"><label class="form-label">Phone</label><input class="form-control s-in" data-f="phone" inputmode="tel" value="${esc(st.seller.phone)}"></div>
              <div class="col-6"><label class="form-label">Address</label><input class="form-control s-in" data-f="address" value="${esc(st.seller.address)}"></div></div>`
          : `<h2 class="h6 mb-2"><i class="bi bi-truck me-2"></i>Supplier</h2>
            <button class="btn btn-light w-100 text-start btn-supplier"><i class="bi bi-person me-2"></i>${esc(st.supplierName || 'Select supplier (leave empty for a cash purchase)')}<i class="bi bi-chevron-right float-end"></i></button>
            <div class="mt-2"><label class="form-label">Supplier invoice no.</label><input class="form-control" id="b-ref" value="${esc(st.refNo)}"></div>`}
        </div></div>
        <div class="card"><div class="card-body"><div class="d-flex align-items-center mb-2"><h2 class="h6 mb-0 flex-grow-1"><i class="bi bi-phone me-2"></i>Phones (${st.devices.length})</h2>
          <button class="btn btn-primary btn-sm btn-add-phone"><i class="bi bi-plus-lg"></i> Add phone</button></div>
          ${st.devices.length ? `<div class="list-card">${st.devices.map((d, i) => `<div class="list-row" data-i="${i}"><div class="pc-icon tint-${UI.tintFor(d.brand)}"><i class="bi bi-phone"></i></div>
            <div class="main btn-edit-phone" role="button"><div class="title">${esc(deviceName(d))}</div><div class="sub">IMEI ${esc(d.imei1)} · ${esc(CONDITIONS[d.condition]?.short)} · ${esc(PTA[d.pta]?.short)}</div></div>
            <div class="end"><div class="fw-semibold money">${fmtNum(d.cost)}</div><button class="btn btn-link btn-sm text-danger p-0 btn-rm">Remove</button></div></div>`).join('')}</div>`
            : UI.emptyState('Add the phone you are buying: IMEI, model, condition, price.', 'phone')}</div></div>
      </div><div class="col-lg-5"><div class="card sticky-lg-top" style="top:72px"><div class="card-body">
        <div class="text-center mb-3"><div class="small text-body-secondary">Total to pay</div><div class="display-6 fw-bold money">${cur()} ${fmtNum(t)}</div></div>
        <div class="row g-2">
          <div class="col-6"><label class="form-label">${person ? 'Paid to seller' : 'Paid now'}</label><input class="form-control money" id="b-paid" inputmode="decimal" value="${esc(st.paid === '' ? (person || !st.supplierId ? t || '' : '') : st.paid)}"></div>
          <div class="col-6"><label class="form-label">Pay from</label><select class="form-select" id="b-acc">${UI.options(accounts, st.account)}</select></div>
          <div class="col-6"><label class="form-label">Date</label><input type="date" class="form-control" id="b-date" value="${esc(st.date)}" max="${today()}"></div>
          <div class="col-6"><label class="form-label">Note</label><input class="form-control" id="b-note" value="${esc(st.note)}"></div></div>
        ${!person && st.supplierId ? '<div class="small text-body-secondary mt-2">Unpaid amount is added to the supplier\'s payable.</div>' : ''}
        <div class="alert alert-danger py-2 small d-none b-err mt-3 mb-0"></div>
        <button class="btn btn-success btn-lg w-100 mt-3 btn-save" ${st.devices.length ? '' : 'disabled'}><i class="bi bi-check2-circle me-1"></i>Save purchase</button>
      </div></div></div></div>`);
  };
  const sync = () => {
    $el.find('.s-in').each(function () { st.seller[this.dataset.f] = this.value; });
    if ($el.find('#b-paid').length) { st.paid = $el.find('#b-paid').val(); st.account = $el.find('#b-acc').val(); st.date = $el.find('#b-date').val() || today(); st.note = $el.find('#b-note').val() || ''; }
    if ($el.find('#b-ref').length) st.refNo = $el.find('#b-ref').val() || '';
  };
  draw();
  $el.on('click', '[data-src]', function () { sync(); st.source = this.dataset.src; st.paid = ''; draw(); });
  $el.on('click', '.btn-supplier', async () => { sync(); const p = await partyPicker('suppliers', { noneLabel: 'Cash purchase (no supplier)' }); if (p === undefined) return; st.supplierId = p?.id || null; st.supplierName = p?.name || ''; st.paid = ''; draw(); });
  $el.on('click', '.btn-add-phone', async () => {
    sync();
    const d = await deviceModal({ condition: st.source === 'person' ? 'used' : 'new' });
    if (!d) return;
    if (st.devices.some((x) => x.imei1 === d.imei1 || (d.imei2 && x.imei2 === d.imei2))) return UI.toast('That IMEI is already in this purchase', 'warning');
    st.devices.push(d); st.paid = ''; draw();
  });
  $el.on('click', '.btn-edit-phone', async function () {
    sync(); const i = +$(this).closest('[data-i]').data('i');
    const d = await deviceModal(st.devices[i], { title: 'Edit phone', submitLabel: 'Update' });
    if (d) { st.devices[i] = { ...d, id: st.devices[i].id }; st.paid = ''; draw(); }
  });
  $el.on('click', '.btn-rm', function () { sync(); st.devices.splice(+$(this).closest('[data-i]').data('i'), 1); st.paid = ''; draw(); });
  $el.on('input', '#b-paid', () => { st.paid = $el.find('#b-paid').val(); });
  let busy = false;
  $el.on('click', '.btn-save', async function () {
    if (busy) return; sync(); busy = true;
    const $b = $(this).prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Saving…');
    $el.find('.b-err').addClass('d-none');
    try {
      const t = total();
      const paid = st.paid === '' ? (st.source === 'person' || !st.supplierId ? t : 0) : num(st.paid);
      pref.set('payAccount', st.account);
      const { doc } = await Posting.saveDevicePurchase({ id: st.id, date: st.date, supplierId: st.source === 'supplier' ? st.supplierId : null, seller: st.source === 'person' ? st.seller : null,
        devices: st.devices, paid, paymentAccountId: st.account, refNo: st.refNo, note: st.note });
      done(doc, st.devices);
    } catch (e) {
      $el.find('.b-err').text(e.message || String(e)).removeClass('d-none');
      $b.prop('disabled', false).html('<i class="bi bi-check2-circle me-1"></i>Save purchase');
    } finally { busy = false; }
  });
  function done(doc, devices) {
    const m = UI.modal({
      title: 'Purchase saved', fullscreenMobile: false, scrollable: false,
      body: `<div class="text-center"><i class="bi bi-check-circle-fill text-success display-5"></i><div class="h5 mt-2 mb-0">${esc(doc.number)}</div>
        <div class="text-body-secondary">${devices.length} phone${devices.length === 1 ? '' : 's'} added to stock · ${cur()} ${fmtNum(doc.total)}</div></div>`,
      footer: `<button class="btn btn-outline-secondary btn-agree"><i class="bi bi-printer me-1"></i>Print receipt for seller</button><a class="btn btn-outline-secondary" href="#/phones">View stock</a><button class="btn btn-primary flex-grow-1 btn-again">Buy another</button>`,
    });
    m.$el.find('.btn-agree').on('click', () => printHTML(agreementHTML(doc, devices), { page: 'A5' }));
    m.$el.find('a').on('click', () => m.close());
    m.$el.find('.btn-again').on('click', () => { m.close(); renderBuy(el, setTitle); });
  }
}

// ---------- IMEI check ----------
async function renderImei(el, setTitle) {
  setTitle('IMEI Check');
  const $el = $(el);
  $el.html(UI.pageHeader('IMEI Check', '', '#/phones') + `
    <div class="card imei-hero mb-3"><div class="card-body">
      <div class="small text-body-secondary mb-1">Type or scan an IMEI to see everything you know about that phone.</div>
      <div class="input-group input-group-lg"><span class="input-group-text"><i class="bi bi-upc-scan"></i></span>
        <input class="form-control imei-q" inputmode="numeric" maxlength="20" placeholder="IMEI or last 6+ digits" autocomplete="off">
        <button class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-camera"></i></button><button class="btn btn-primary btn-go">Check</button></div>
      <div class="small text-body-secondary mt-2"><i class="bi bi-info-circle me-1"></i>Dial <b>*#06#</b> on the phone to read its IMEI. For official PTA status use the PTA DVS website or SMS the IMEI to <b>8484</b>.</div></div></div>
    <div class="imei-out"></div>`);
  const go = async () => {
    const raw = cleanImei($el.find('.imei-q').val());
    const $o = $el.find('.imei-out');
    if (!raw) return $o.empty();
    let device = await Posting.lookupImei(raw);
    if (!device && /^\d{6,14}$/.test(raw)) {
      const hits = (await idb.getAll('devices')).filter((d) => d.imei1.endsWith(raw) || (d.imei2 && d.imei2.endsWith(raw)));
      if (hits.length === 1) device = hits[0];
      else if (hits.length > 1) return $o.html(`<div class="list-card">${hits.map((d) => `<a class="list-row" href="#/phones/${encodeURIComponent(d.id)}"><div class="main"><div class="title">${esc(deviceName(d))}</div><div class="sub">IMEI ${esc(d.imei1)}</div></div></a>`).join('')}</div>`);
    }
    const problem = imeiProblem(raw);
    const full = /^\d{15,16}$/.test(raw);
    const repairs = full ? await idb.getAllByIndex('repairs', 'imei', raw) : [];
    $o.html(`${full ? `<div class="alert alert-${problem ? 'danger' : 'success'} py-2 small"><i class="bi bi-${problem ? 'x-circle' : 'check-circle'} me-1"></i>${problem ? esc(problem) : 'IMEI format and checksum are valid.'}</div>` : ''}
      ${device ? `<a class="phone-card ${device.status}" href="#/phones/${encodeURIComponent(device.id)}"><div class="pc-top"><div class="pc-icon tint-${UI.tintFor(device.brand)}"><i class="bi bi-phone"></i></div>
          <div class="min-w-0 flex-grow-1"><div class="pc-name">${esc(deviceName(device))}</div><div class="pc-imei">IMEI ${esc(device.imei1)}</div></div><div class="pc-price">${fmtNum(device.soldPrice || device.salePrice)}</div></div>
        <div class="pc-tags">${condBadge(device.condition)}${ptaBadge(device.pta)}<span class="badge tint-${DEVICE_STATUS[device.status]?.tint}">${esc(DEVICE_STATUS[device.status]?.label)}</span>
          ${device.status === 'sold' ? `<span class="badge tint-slate">Sold ${esc(fmtDate(device.soldDate))} to ${esc(device.customerName || 'walk-in')}</span>` : ''}</div></a>`
        : `<div class="alert alert-secondary"><i class="bi bi-search me-1"></i>No record of this IMEI in your shop.</div>`}
      ${repairs.length ? `<h2 class="h6 mt-3">Repair jobs</h2><div class="list-card">${repairs.map((r) => `<a class="list-row" href="#/repairs/${encodeURIComponent(r.id)}"><div class="main"><div class="title">${esc(r.number)} · ${esc(r.fault)}</div><div class="sub">${fmtDate(r.date)} · ${esc(r.status)}</div></div></a>`).join('')}</div>` : ''}
      ${full ? `<button class="btn btn-outline-secondary mt-3 btn-pta"><i class="bi bi-shield-check me-1"></i>Check PTA status (copy IMEI &amp; open DVS)</button>` : ''}`);
    $o.find('.btn-pta').on('click', async () => { try { await navigator.clipboard.writeText(raw); UI.toast('IMEI copied — paste it on the PTA site', 'info', 2500); } catch { /* ignore */ } window.open('https://dvs.pta.gov.pk/', '_blank', 'noopener'); });
  };
  $el.on('click', '.btn-go', go);
  $el.on('keydown', '.imei-q', (e) => { if (e.key === 'Enter') go(); });
  $el.on('input', '.imei-q', function () { this.value = this.value.replace(/[^\d\s-]/g, ''); });
  $el.on('click', '.btn-scan', async () => { const c = await Scanner.scan({ title: 'Scan IMEI barcode' }); if (c) { $el.find('.imei-q').val(cleanImei(c).replace(/\D/g, '')); go(); } });
  detach = Scanner.attachWedge((c) => { $el.find('.imei-q').val(cleanImei(c).replace(/\D/g, '')); go(); return true; });
  setTimeout(() => $el.find('.imei-q').trigger('focus'), 50);
}

let detach = null;
export default {
  async render(el, { route, params, setTitle }) {
    this.destroy();
    if (route === 'phonebuy') return renderBuy(el, setTitle);
    if (route === 'imei') return renderImei(el, setTitle);
    if (params[0]) return renderDetail(el, params[0], setTitle);
    return renderList(el);
  },
  destroy() { detach?.(); detach = null; },
};
