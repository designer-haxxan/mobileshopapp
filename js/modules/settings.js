// Settings: business profile, tax & numbering, printer, appearance, account, data tools.
import { CONFIG } from '../config.js';
import * as UI from '../core/ui.js';
import { esc, num, fmtDateTime } from '../core/utils.js';
import { getSettings, saveSettings } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;

function section(title, icon, body) {
  return `<div class="card mb-3"><div class="card-body"><h2 class="h6 mb-3"><i class="bi bi-${icon} me-2"></i>${title}</h2>${body}</div></div>`;
}

export default {
  async render(el) {
    const $el = $(el);
    const s = getSettings();
    const u = Auth.user();
    const manage = Auth.can('settings.manage');
    const cap = Printer.capabilities();
    const ro = manage ? '' : 'disabled';
    const P = s.prefixes;
    $el.html(UI.pageHeader('Settings') + `<div class="row g-3"><div class="col-lg-6">
      ${section('Business profile', 'shop', `<form class="f-business row g-2">
        <div class="col-12"><label class="form-label">Business name</label><input name="name" class="form-control" value="${esc(s.business.name)}" ${ro}></div>
        <div class="col-12"><label class="form-label">Address</label><input name="address" class="form-control" value="${esc(s.business.address)}" ${ro}></div>
        <div class="col-6"><label class="form-label">Phone</label><input name="phone" class="form-control" value="${esc(s.business.phone)}" ${ro}></div>
        <div class="col-6"><label class="form-label">Tax / NTN no.</label><input name="taxNo" class="form-control" value="${esc(s.business.taxNo)}" ${ro}></div>
        <div class="col-8"><label class="form-label">Receipt footer</label><input name="footer" class="form-control" value="${esc(s.business.footer)}" ${ro}></div>
        <div class="col-4"><label class="form-label">Currency</label><input name="currency" class="form-control" maxlength="5" value="${esc(s.currency)}" ${ro}></div>
        ${manage ? '<div class="col-12"><button class="btn btn-primary">Save</button></div>' : ''}</form>`)}
      ${section('Sales, stock & numbering', 'sliders', `<form class="f-sales row g-2">
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="taxEnabled" id="s-tax" ${s.taxEnabled ? 'checked' : ''} ${ro}><label class="form-check-label" for="s-tax">Charge sales tax</label></div></div>
        <div class="col-6"><label class="form-label">Tax rate (%)</label><input name="taxRate" class="form-control" inputmode="decimal" value="${s.taxRate}" ${ro}></div>
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="allowNegativeStock" id="s-neg" ${s.allowNegativeStock ? 'checked' : ''} ${ro}><label class="form-check-label" for="s-neg">Allow selling when stock is insufficient</label></div></div>
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="updatePurchasePrice" id="s-upp" ${s.updatePurchasePrice ? 'checked' : ''} ${ro}><label class="form-check-label" for="s-upp">Update product cost price from latest purchase</label></div></div>
        <div class="col-12 small text-body-secondary mt-2">Document number prefixes (use a different prefix on each device if several devices sell at the same time)</div>
        ${[['sale', 'Sale'], ['purchase', 'Purchase'], ['saleReturn', 'Sale return'], ['purchaseReturn', 'Purchase return'], ['receipt', 'Receipt'], ['payment', 'Payment'], ['transfer', 'Transfer'], ['adjustment', 'Adjustment'], ['repair', 'Repair job'], ['service', 'Wallet service']]
          .map(([k, l]) => `<div class="col-6 col-md-3"><label class="form-label small">${l}</label><input name="p_${k}" class="form-control form-control-sm" maxlength="12" value="${esc(P[k])}" ${ro} pattern="[A-Za-z0-9]+"></div>`).join('')}
        ${manage ? '<div class="col-12"><button class="btn btn-primary">Save</button></div>' : ''}</form>`)}
      ${section('Warranty (mobile shop)', 'shield-check', `<form class="f-warranty row g-2">
        <div class="col-12 small text-body-secondary">Shop warranty in days, printed on the phone receipt. Set 0 for no warranty.</div>
        ${[['new', 'New phone'], ['open_box', 'Open box'], ['used', 'Used phone'], ['refurb', 'Refurbished']].map(([k, l]) => `<div class="col-6 col-md-3"><label class="form-label small">${l}</label><input name="w_${k}" class="form-control form-control-sm" inputmode="numeric" value="${esc(s.warranty?.[k] ?? 0)}" ${ro}></div>`).join('')}
        <div class="col-6 col-md-3"><label class="form-label small">Repair job</label><input name="repairWarrantyDays" class="form-control form-control-sm" inputmode="numeric" value="${esc(s.repairWarrantyDays ?? 30)}" ${ro}></div>
        ${manage ? '<div class="col-12"><button class="btn btn-primary">Save</button></div>' : ''}</form>`)}
      ${section('Appearance', 'palette', `<select class="form-select f-theme"><option value="auto">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select>`)}
    </div><div class="col-lg-6">
      ${section('Receipt printer', 'printer', `
        <div class="alert ${cap.webBluetooth ? 'alert-info' : 'alert-secondary'} small py-2">${esc(cap.note)}</div>
        <form class="f-printer row g-2">
          <div class="col-12"><label class="form-label">Print method</label><select name="method" class="form-select">
            <option value="browser" ${s.printer.method === 'browser' ? 'selected' : ''}>Browser print dialog (any printer, PDF, AirPrint)</option>
            <option value="bluetooth" ${s.printer.method === 'bluetooth' ? 'selected' : ''} ${cap.webBluetooth ? '' : 'disabled'}>Bluetooth ESC/POS printer (Web Bluetooth, BLE)${cap.webBluetooth ? '' : ' — not supported here'}</option>
            <option value="rawbt" ${s.printer.method === 'rawbt' ? 'selected' : ''}>RawBT app (Android, Classic Bluetooth printers)</option></select></div>
          <div class="col-6"><label class="form-label">Paper width</label><select name="width" class="form-select"><option value="58" ${s.printer.width == 58 ? 'selected' : ''}>58 mm (32 chars)</option><option value="80" ${s.printer.width == 80 ? 'selected' : ''}>80 mm (48 chars)</option></select></div>
          <div class="col-6"><label class="form-label">Copies</label><input name="copies" type="number" min="1" max="5" class="form-control" value="${s.printer.copies || 1}"></div>
          <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="autoPrint" id="s-ap" ${s.printer.autoPrint ? 'checked' : ''}><label class="form-check-label" for="s-ap">Print receipt automatically after each sale</label></div></div>
        </form>
        <div class="bt-box mt-3 ${s.printer.method === 'bluetooth' ? '' : 'd-none'}">
          <div class="d-flex align-items-center gap-2 mb-2"><i class="bi bi-bluetooth"></i><span class="bt-status small flex-grow-1"></span></div>
          <div class="d-flex gap-2"><button class="btn btn-outline-primary btn-bt-connect">Connect printer</button><button class="btn btn-outline-secondary btn-bt-disconnect">Disconnect</button></div>
          <label class="form-label mt-3">Transfer speed</label>
          <select class="form-select f-chunk">${Object.entries(Printer.CHUNK_SIZES).map(([v, l]) => `<option value="${v}" ${Number(s.printer.chunkSize || 20) === Number(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="form-text">If receipts come out cut off or garbled, choose Safe.</div>
        </div>
        <div class="rawbt-box small text-body-secondary mt-2 ${s.printer.method === 'rawbt' ? '' : 'd-none'}">Install the free <b>RawBT</b> app from Google Play, pair your printer in RawBT, then print from here. Receipts are sent as ESC/POS data.</div>
        <div class="img-box mt-3 ${s.printer.method === 'browser' ? 'd-none' : ''}">
          <label class="form-label">Urdu printing mode</label>
          <select class="form-select f-imgmode">
            <option value="gsv0" ${s.printer.imageMode !== 'escstar' ? 'selected' : ''}>Standard (GS v 0) — most printers</option>
            <option value="escstar" ${s.printer.imageMode === 'escstar' ? 'selected' : ''}>Compatibility (ESC *) — older printers</option></select>
          <div class="form-text">Urdu is printed as an image. If Test print shows blank space or garbage where Urdu should be, switch to Compatibility.</div>
        </div>
        <button class="btn btn-outline-secondary mt-3 btn-test"><i class="bi bi-printer me-1"></i>Test print (incl. Urdu)</button>`)}
      ${section('My account', 'person-circle', `<div class="mb-2"><b>${esc(u.username)}</b><div class="small text-body-secondary">${esc(Auth.ROLES[u.role] || u.role)}</div></div>
        <div class="small">Session valid until <b>${esc(fmtDateTime(new Date(Auth.expiresAt()).toISOString()))}</b>. After that, sign in again while online.</div>
        <div class="small mt-1">Device ID: <code class="user-select-all">${esc(Auth.deviceId())}</code></div>
        <div class="form-text">This account is linked to this device. To move it to another phone or change the password, call ${esc(CONFIG.SUPPORT_PHONE)}.</div>`)}
      ${section('App & data', 'phone', `<div class="small mb-2">Version ${esc(CONFIG.APP_VERSION)} · <span class="storage-info">checking storage…</span></div>
        <div class="d-flex flex-wrap gap-2">
          <button class="btn btn-outline-secondary btn-install d-none"><i class="bi bi-download me-1"></i>Install app</button>
          ${manage ? '<button class="btn btn-outline-secondary btn-integrity"><i class="bi bi-shield-check me-1"></i>Check data integrity</button><button class="btn btn-outline-secondary btn-rebuild"><i class="bi bi-arrow-repeat me-1"></i>Recalculate stock</button>' : ''}
        </div>
        <div class="d-flex align-items-center gap-2 mt-3"><i class="bi bi-camera"></i><span class="small flex-grow-1">Camera for barcode scanning: <b class="cam-state">checking…</b></span>
          <button class="btn btn-sm btn-outline-secondary btn-cam-test">Test camera</button></div>
        <div class="cam-help mt-2"></div>
        <div class="small text-body-secondary mt-2 ios-hint d-none">On iPhone/iPad: tap <i class="bi bi-box-arrow-up"></i> Share → <b>Add to Home Screen</b> to install.</div>`)}
    </div></div>`);

    $el.find('.f-theme').val(s.theme).on('change', function () { saveSettings({ theme: this.value }); });
    $el.on('submit', '.f-business', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      if (!v.name.trim()) return UI.toast('Business name is required', 'warning');
      saveSettings({ business: { name: v.name.trim(), address: v.address.trim(), phone: v.phone.trim(), taxNo: v.taxNo.trim(), footer: v.footer.trim() }, currency: v.currency.trim() || 'Rs' });
      UI.toast('Business profile saved');
    });
    $el.on('submit', '.f-warranty', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      const days = (x) => Math.max(0, Math.min(3650, Math.round(num(x))));
      saveSettings({ warranty: { new: days(v.w_new), open_box: days(v.w_open_box), used: days(v.w_used), refurb: days(v.w_refurb) }, repairWarrantyDays: days(v.repairWarrantyDays) });
      UI.toast('Warranty settings saved');
    });
    $el.on('submit', '.f-sales', (e) => {
      e.preventDefault();
      const f = e.target; const v = Object.fromEntries(new FormData(f).entries());
      const rate = num(v.taxRate);
      if (rate < 0 || rate > 100) return UI.toast('Tax rate must be between 0 and 100', 'warning');
      const prefixes = {};
      for (const k of Object.keys(P)) {
        const p = String(v['p_' + k] || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{1,12}$/.test(p)) return UI.toast(`Invalid prefix for ${k}. Use letters and digits only.`, 'warning');
        prefixes[k] = p;
      }
      saveSettings({ taxEnabled: f.taxEnabled.checked, taxRate: rate, allowNegativeStock: f.allowNegativeStock.checked, updatePurchasePrice: f.updatePurchasePrice.checked, prefixes });
      UI.toast('Settings saved');
    });
    const btStatus = () => $el.find('.bt-status').text(Printer.isConnected() ? `Connected: ${Printer.connectedName()}` : getSettings().printer.deviceName ? `Not connected (last: ${getSettings().printer.deviceName})` : 'No printer connected');
    btStatus();
    const onPrinter = () => btStatus();
    document.addEventListener('printer:changed', onPrinter);
    this._off = () => document.removeEventListener('printer:changed', onPrinter);
    $el.on('change', '.f-printer', (e) => {
      const f = e.currentTarget;
      const copies = Math.max(1, Math.min(5, parseInt(f.copies.value, 10) || 1));
      saveSettings({ printer: { method: f.method.value, width: Number(f.width.value), autoPrint: f.autoPrint.checked, copies } });
      $el.find('.bt-box').toggleClass('d-none', f.method.value !== 'bluetooth');
      $el.find('.rawbt-box').toggleClass('d-none', f.method.value !== 'rawbt');
      $el.find('.img-box').toggleClass('d-none', f.method.value === 'browser');
    });
    $el.on('change', '.f-imgmode', function () { saveSettings({ printer: { imageMode: this.value } }); UI.toast('Urdu printing mode saved'); });
    $el.on('change', '.f-chunk', function () { saveSettings({ printer: { chunkSize: Number(this.value) } }); UI.toast('Printer speed saved'); });
    $el.on('click', '.btn-bt-connect', async () => { try { const n = await Printer.connectBluetooth(); UI.toast(`Connected to ${n || 'printer'}`); } catch (e) { UI.toastError(e); } btStatus(); });
    $el.on('click', '.btn-bt-disconnect', () => { Printer.disconnect(); btStatus(); });
    const camState = async () => {
      const st = await Scanner.cameraPermission();
      $el.find('.cam-state').text({ granted: 'Allowed', denied: 'Blocked', prompt: 'Not asked yet', unknown: 'Unknown' }[st] || st)
        .attr('class', `cam-state text-${st === 'granted' ? 'success' : st === 'denied' ? 'danger' : 'body'}`);
      $el.find('.cam-help').html(Scanner.inAppBrowser() ? Scanner.cameraHelpHTML('inapp') : st === 'denied' ? Scanner.cameraHelpHTML('site') : '');
    };
    camState();
    $el.on('click', '.btn-cam-test', async () => {
      const code = await Scanner.scan({ title: 'Test camera' });
      if (code) UI.toast(`Camera works — read ${code}`);
      camState();
    });
    $el.on('click', '.btn-test', async () => { try { await Printer.testPrint(); } catch (e) { UI.toastError(e); } });
    const { canInstall, promptInstall } = await import('../app.js');
    if (canInstall()) $el.find('.btn-install').removeClass('d-none').on('click', promptInstall);
    if (Printer.capabilities().ios && !window.matchMedia('(display-mode: standalone)').matches) $el.find('.ios-hint').removeClass('d-none');
    if (navigator.storage?.estimate) {
      const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
      $el.find('.storage-info').text(`${(est.usage / 1048576).toFixed(1)} MB used · storage ${persisted ? 'persistent' : 'best-effort (may be cleared by the browser under pressure)'}`);
    } else $el.find('.storage-info').text('');
    $el.on('click', '.btn-integrity', async () => {
      const r = await UI.withLoading(() => Posting.integrityCheck(), 'Checking…');
      await UI.confirmDialog(`<p>Checked ${r.checked.entries} ledger entries, ${r.checked.stockMoves} stock movements and ${r.checked.products} products.</p>${r.issues.length ? `<div class="alert alert-warning small">${r.issues.slice(0, 50).map(esc).join('<br>')}</div>` : '<div class="alert alert-success mb-0">No problems found.</div>'}`, { html: true, title: 'Data integrity', okLabel: 'OK' });
    });
    $el.on('click', '.btn-rebuild', async () => {
      try {
        const fixed = await UI.withLoading(() => Posting.rebuildStock(), 'Recalculating…');
        UI.toast(fixed.length ? `Corrected stock for ${fixed.length} product(s)` : 'All stock quantities already match the stock ledger', fixed.length ? 'warning' : 'success');
      } catch (e) { UI.toastError(e); }
    });
  },
  destroy() { this._off?.(); this._off = null; },
};
