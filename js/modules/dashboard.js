// Shop dashboard: today's takings, profit, cash, wallets, phone stock, repairs and udhaar — all computed from records.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtTime, fmtDate, today, localDate, monthStart, round2, debounce } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref } from '../core/settings.js';
import { REPAIR_STATUS, OPEN_REPAIR, CONDITIONS, WALLET_ACCOUNTS, deviceName, waLink } from '../core/mobile.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Backup from '../services/backup.js';

const $ = window.jQuery;
const SERIES = [['phones', 'Phones', 's1'], ['acc', 'Accessories', 's2'], ['repairs', 'Repairs', 's3'], ['services', 'Services', 's4']];
const compact = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)); const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
const daysBetween = (dateStr) => Math.max(0, Math.floor((Date.now() - new Date((dateStr || today()).slice(0, 10) + 'T00:00:00')) / 86400000));

async function gather() {
  const t0 = today(); const ms = monthStart();
  const d30 = new Date(); d30.setDate(d30.getDate() - 31); const from = localDate(d30) < ms ? localDate(d30) : ms;
  const range = IDBKeyRange.bound(from, t0);
  const [sales, items, repairs, services, devices, accounts, todayEntries, vouchersToday] = await idb.read(['sales', 'saleItems', 'repairs', 'services', 'devices', 'accounts', 'entries', 'vouchers'], (t) => Promise.all([
    t.getAllByIndex('sales', 'date', range), t.getAllByIndex('saleItems', 'date', range), t.getAll('repairs'), t.getAllByIndex('services', 'date', range),
    t.getAll('devices'), t.getAll('accounts'), t.getAllByIndex('entries', 'date', IDBKeyRange.only(t0)), t.getAllByIndex('vouchers', 'date', IDBKeyRange.only(t0))]));
  const live = (x) => x.filter((d) => d.status !== 'void');
  const saleMap = new Map(live(sales).map((s) => [s.id, s]));
  const blank = () => ({ phones: 0, acc: 0, repairs: 0, services: 0, profit: 0, phoneProfit: 0, accProfit: 0, repairProfit: 0, serviceProfit: 0, phonesSold: 0, brands: {} });
  const byDate = {};
  const day = (d) => byDate[d] || (byDate[d] = blank());
  for (const i of items) {
    const s = saleMap.get(i.saleId); if (!s) continue;
    const f = s.subtotal > 0 ? (s.total - s.tax) / s.subtotal : 1;
    const net = i.amount * f; const profit = net - i.qty * (i.cost || 0);
    const x = day(i.date);
    if (i.deviceId) { x.phones += net; x.phoneProfit += profit; x.phonesSold += 1; const b = (i.name || '').split(' ')[0]; x.brands[b] = (x.brands[b] || 0) + 1; } else { x.acc += net; x.accProfit += profit; }
    x.profit += profit;
  }
  for (const r of repairs) if (r.status === 'delivered' && r.deliveredDate >= from) { const x = day(r.deliveredDate); x.repairs += r.total; x.repairProfit += r.total - (r.partsCost || 0); x.profit += r.total - (r.partsCost || 0); }
  for (const s of live(services)) { const x = day(s.date); x.services += s.income; x.serviceProfit += s.income; x.profit += s.income; }
  const sum = (from2, key) => Object.entries(byDate).filter(([d]) => d >= from2 && d <= t0).reduce((a, [, v]) => a + v[key], 0);
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = localDate(d); const v = byDate[k] || blank(); days.push({ date: k, ...v, total: v.phones + v.acc + v.repairs + v.services }); }
  const brandCount = {};
  for (const [d, v] of Object.entries(byDate)) if (d >= from) for (const [b, n] of Object.entries(v.brands)) brandCount[b] = (brandCount[b] || 0) + n;
  const cashIds = new Set(accounts.filter((a) => ['cash', 'bank'].includes(a.type)).map((a) => a.id));
  const cashE = todayEntries.filter((e) => cashIds.has(e.accountId) && e.refType !== 'opening' && e.refType !== 'transfer');
  const todaySales = live(sales).filter((s) => s.date === t0);
  return { days, byDate, todayV: byDate[t0] || blank(), monthV: Object.fromEntries(['phones', 'acc', 'repairs', 'services', 'profit', 'phoneProfit'].map((k) => [k, sum(ms, k)])), brandCount,
    todaySales, recent: todaySales.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6),
    todayGross: round2(todaySales.reduce((a, s) => a + s.total, 0)),
    cashIn: round2(cashE.reduce((a, e) => a + e.debit, 0)), cashOut: round2(cashE.reduce((a, e) => a + e.credit, 0)), cashIds, repairs, devices, accounts, vouchersToday: live(vouchersToday).length,
    servicesToday: live(services).filter((s) => s.date === t0).length };
}

// ---------- charts ----------
function drawStacked(box, days) {
  const W = Math.max(280, box.clientWidth); const H = 210;
  const m = { t: 20, r: 8, b: 26, l: 42 }; const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const max = niceMax(Math.max(...days.map((d) => d.total)));
  const band = iw / days.length; const bw = Math.min(38, band * 0.58);
  const y = (v) => m.t + ih - (v / max) * ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Takings for the last 7 days by category"><g class="grid">`;
  for (const t of [0, max / 2, max]) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
  svg += '</g><g class="axis">';
  for (const t of [0, max / 2, max]) svg += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  days.forEach((d, i) => { const cx = m.l + band * i + band / 2; const last = i === days.length - 1;
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" ${last ? 'font-weight="700"' : ''}>${last ? 'Today' : new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</text>`; });
  svg += '</g>';
  days.forEach((d, i) => {
    const x = m.l + band * i + (band - bw) / 2; let acc = 0;
    const segs = SERIES.filter(([k]) => d[k] > 0);
    segs.forEach(([k, , cls], si) => {
      const h = (d[k] / max) * ih; const top = y(acc + d[k]); acc += d[k];
      const r = si === segs.length - 1 ? Math.min(5, h, bw / 2) : 0;
      svg += `<path class="seg ${cls}" d="M${x},${top + h} V${top + r} ${r ? `Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r}` : `H${x + bw}`} V${top + h} Z" style="animation-delay:${i * 0.05 + si * 0.04}s"/>`;
    });
    svg += `<rect class="bar-hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
  });
  svg += '</svg><div class="viz-tip"></div>';
  box.innerHTML = svg;
  const tip = box.querySelector('.viz-tip');
  const show = (el) => {
    const d = days[+el.dataset.i];
    tip.innerHTML = `<b>${esc(fmtDate(d.date))}</b><br>${SERIES.map(([k, l, c]) => (d[k] > 0 ? `<span class="dot ${c}"></span>${l} ${fmtNum(d[k])}<br>` : '')).join('')}<b>${esc(cur())} ${fmtNum(d.total)}</b>`;
    tip.style.left = `${+el.getAttribute('x') + band / 2}px`; tip.style.top = `${Math.max(16, y(d.total))}px`; tip.classList.add('show');
  };
  box.querySelectorAll('.bar-hit').forEach((el) => { el.addEventListener('mouseenter', () => show(el)); el.addEventListener('click', () => show(el)); el.addEventListener('mouseleave', () => tip.classList.remove('show')); });
}

function donut(parts, centerTop, centerBottom) {
  const total = parts.reduce((s, p) => s + p.v, 0);
  const R = 52; const C = 2 * Math.PI * R; let off = 0;
  const arcs = total > 0 ? parts.filter((p) => p.v > 0).map((p, i) => { const len = (p.v / total) * C; const a = `<circle class="arc ${p.cls}" cx="70" cy="70" r="${R}" fill="none" stroke-width="16" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" style="animation-delay:${i * 0.12}s"/>`; off += len; return a; }).join('') : '';
  return `<svg viewBox="0 0 140 140" class="donut" role="img"><circle cx="70" cy="70" r="${R}" fill="none" stroke-width="16" class="donut-bg"/>${arcs}
    <text x="70" y="66" text-anchor="middle" class="d-top">${esc(centerTop)}</text><text x="70" y="84" text-anchor="middle" class="d-bot">${esc(centerBottom)}</text></svg>`;
}

export default {
  async render(el) {
    this.destroy();
    const $el = $(el);
    const u = Auth.user();
    const [g, bal] = await Promise.all([gather(), Posting.allBalances()]);
    const money = (n) => `data-count="${round2(n)}" data-money="1"`;
    const showProfit = Auth.can('reports.profit');

    // balances
    let rec = 0; let pay = 0; let cash = 0; const wallets = [];
    const recList = []; const payList = [];
    for (const [id, b] of bal) {
      if (id.startsWith('C:') && b.balance > 0.004) { rec += b.balance; recList.push([id.slice(2), b.balance]); }
      if (id.startsWith('S:') && b.balance < -0.004) { pay -= b.balance; payList.push([id.slice(2), -b.balance]); }
    }
    cash = bal.get('cash')?.balance || 0;
    for (const a of g.accounts) if (a.type === 'bank' && a.active) wallets.push({ ...a, balance: bal.get(a.id)?.balance || 0, meta: WALLET_ACCOUNTS.find((w) => w.id === a.id) });
    wallets.sort((a, b) => (b.meta ? 1 : 0) - (a.meta ? 1 : 0));
    recList.sort((a, b) => b[1] - a[1]); payList.sort((a, b) => b[1] - a[1]);

    // phones
    const stock = g.devices.filter((d) => d.status === 'in_stock');
    const stockCost = round2(stock.reduce((s, d) => s + (d.costTotal || 0), 0));
    const stockSale = round2(stock.reduce((s, d) => s + (d.salePrice || 0), 0));
    const aging = [['0–7 days', 0, 7, 'a1'], ['8–30', 8, 30, 'a2'], ['31–60', 31, 60, 'a3'], ['60+', 61, 9999, 'a4']].map(([l, lo, hi, cls]) => {
      const list = stock.filter((d) => { const n = daysBetween(d.purchaseDate); return n >= lo && n <= hi; });
      return { l, cls, n: list.length, v: list.reduce((s, d) => s + (d.costTotal || 0), 0) };
    });
    const oldPhones = stock.filter((d) => daysBetween(d.purchaseDate) > 60).sort((a, b) => daysBetween(b.purchaseDate) - daysBetween(a.purchaseDate));
    const condParts = Object.entries(CONDITIONS).map(([k, c], i) => ({ k, v: stock.filter((d) => d.condition === k).length, label: c.short, cls: `c${i + 1}` }));

    // accessories
    const prods = Catalog.allProducts().filter((p) => p.active);
    const tracked = prods.filter((p) => p.trackStock !== false);
    const accStock = round2(tracked.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchasePrice || 0), 0));
    const low = tracked.filter((p) => p.stock <= (p.minStock || 0)).sort((a, b) => a.stock - b.stock);

    // repairs
    const open = g.repairs.filter((r) => OPEN_REPAIR.includes(r.status));
    const pipe = ['received', 'diagnosing', 'waiting_parts', 'in_progress', 'ready'].map((k) => ({ k, n: open.filter((r) => r.status === k).length }));
    const ready = open.filter((r) => r.status === 'ready').sort((a, b) => a.date.localeCompare(b.date));
    const late = open.filter((r) => r.expectedDate && r.expectedDate < today() && r.status !== 'ready');

    const tv = g.todayV;
    const todayTotal = round2(g.todayGross + tv.repairs + tv.services);
    const mixParts = SERIES.map(([k, l, c]) => ({ v: round2(g.monthV[k]), label: l, cls: c }));
    const mixTotal = mixParts.reduce((s, p) => s + p.v, 0);
    const brands = Object.entries(g.brandCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const lastBackup = pref.get('lastBackupAt');
    const backupDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup)) / 86400000) : null;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const alerts = [];
    if (ready.length) alerts.push(['check2-circle', 'green', `${ready.length} repaired phone${ready.length > 1 ? 's' : ''} waiting for pickup`, '#/repairs']);
    if (late.length) alerts.push(['alarm', 'amber', `${late.length} repair${late.length > 1 ? 's' : ''} past the promised date`, '#/repairs']);
    if (oldPhones.length) alerts.push(['hourglass-split', 'amber', `${oldPhones.length} phone${oldPhones.length > 1 ? 's' : ''} unsold for over 60 days (${esc(cur())} ${fmtNum(oldPhones.reduce((s, d) => s + d.costTotal, 0))} tied up)`, '#/phones']);
    if (low.length) alerts.push(['exclamation-triangle', 'red', `${low.length} accessor${low.length > 1 ? 'ies' : 'y'} low or out of stock`, '#/stock']);
    for (const w of wallets.filter((x) => x.balance < 0)) alerts.push(['wallet2', 'red', `${esc(w.name)} balance is negative — record a top-up`, '#/services']);
    if (stock.some((d) => d.pta === 'unknown')) alerts.push(['shield-exclamation', 'slate', `${stock.filter((d) => d.pta === 'unknown').length} phone(s) in stock with unchecked PTA status`, '#/phones']);
    if (Auth.can('backup.export') && (backupDays === null || backupDays >= 7)) alerts.push(['cloud-arrow-down', 'amber', backupDays === null ? 'No backup made yet — your data only lives on this phone' : `Last backup was ${backupDays} days ago`, '#/backup']);

    const tile = (href, icon, tint, title, sub, perm) => (perm && !Auth.can(perm) ? '' : `<a class="act-tile tint-${tint}" href="${href}"><i class="bi bi-${icon}"></i><div class="t">${title}</div><div class="s">${sub}</div></a>`);
    const kpi = (icon, tint, label, valueAttr, sub, href) => `<div class="col-6 col-lg-3"><${href ? `a href="${href}"` : 'div'} class="stat-card kpi-card d-block text-decoration-none p-3 h-100">
      <div class="kpi"><div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div><div class="min-w-0"><div class="l">${label}</div><div class="v money" ${valueAttr}>0</div></div></div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</${href ? 'a' : 'div'}></div>`;

    $el.html(`
      <div class="mobi-hero">
        <div class="hero-fx" aria-hidden="true"><span class="sig"><i></i><i></i><i></i><i></i></span><span class="fp p1"><i class="bi bi-phone"></i></span><span class="fp p2"><i class="bi bi-phone-flip"></i></span><span class="fp p3"><i class="bi bi-sim"></i></span><span class="fp p4"><i class="bi bi-headphones"></i></span></div>
        <div class="d-flex justify-content-between align-items-start gap-2 mb-3">
          <div><div class="hello">${greet}, ${esc(u.name.split(' ')[0])} 👋</div><div class="date">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
          <span class="pill"><i class="bi bi-${navigator.onLine ? 'wifi' : 'wifi-off'}"></i>${navigator.onLine ? 'Online' : 'Offline'}</span>
        </div>
        <div class="lbl">Today's takings</div>
        <div class="big money" ${money(todayTotal)}>0</div>
        <div class="d-flex flex-wrap gap-2 mt-2 mb-3">
          <span class="pill"><i class="bi bi-phone"></i>${tv.phonesSold} phone${tv.phonesSold === 1 ? '' : 's'} sold</span>
          <span class="pill"><i class="bi bi-receipt"></i>${g.todaySales.length} bill${g.todaySales.length === 1 ? '' : 's'}</span>
          <span class="pill"><i class="bi bi-tools"></i>${g.repairs.filter((r) => r.deliveredDate === today()).length} repair${g.repairs.filter((r) => r.deliveredDate === today()).length === 1 ? '' : 's'} delivered</span>
          <span class="pill"><i class="bi bi-wallet2"></i>${g.servicesToday} service${g.servicesToday === 1 ? '' : 's'}</span>
          ${showProfit ? `<span class="pill glow"><i class="bi bi-graph-up-arrow"></i>Profit ${esc(cur())} ${fmtNum(tv.profit)}</span>` : ''}
        </div>
        <div class="d-flex flex-wrap gap-2">
          ${Auth.can('sale.create') ? '<a class="btn hero-cta" href="#/pos"><i class="bi bi-cart-plus me-1"></i>New sale</a>' : ''}
          ${Auth.can('phone.buy') ? '<a class="btn btn-outline-light" href="#/phonebuy"><i class="bi bi-phone me-1"></i>Buy phone</a>' : ''}
          ${Auth.can('repair.manage') ? '<a class="btn btn-outline-light" href="#/repairs/new"><i class="bi bi-tools me-1"></i>New repair</a>' : ''}
        </div>
      </div>
      ${!navigator.onLine ? '<div class="alert alert-secondary py-2 small"><i class="bi bi-wifi-off me-1"></i>You are offline. Everything you do is saved on this phone.</div>' : ''}
      <div class="legacy-hint"></div>

      <div class="act-grid stagger">
        ${tile('#/pos', 'cart-check', 'green', 'Sell', 'Phones & accessories', 'sale.create')}
        ${tile('#/phonebuy', 'phone-flip', 'indigo', 'Buy / Trade-in', 'New & used phones', 'phone.buy')}
        ${tile('#/repairs/new', 'tools', 'violet', 'Repair job', `${open.length} open`, 'repair.manage')}
        ${tile('#/services', 'wallet2', 'cyan', 'Easypaisa · JazzCash', `${g.servicesToday} today`, 'service.create')}
        ${tile('#/imei', 'upc-scan', 'pink', 'IMEI check', 'History & PTA', null)}
        ${tile('#/vouchers', 'cash-coin', 'amber', 'Cash book', 'Receipts & payments', 'voucher.create')}
      </div>

      ${alerts.length ? `<div class="section-title"><h2>Needs your attention</h2></div><div class="alert-list stagger">${alerts.map(([ic, tint, txt, href]) => `<a class="alert-row tint-${tint}" href="${href}"><i class="bi bi-${ic}"></i><span>${txt}</span><i class="bi bi-chevron-right ms-auto"></i></a>`).join('')}</div>` : ''}

      <div class="section-title"><h2>Money</h2></div>
      <div class="row g-2 stagger">
        ${kpi('cash-stack', 'green', 'Cash in hand', money(cash), `In today ${esc(cur())} ${fmtNum(g.cashIn)} · out ${fmtNum(g.cashOut)}`, '#/accounts')}
        ${kpi('person-down', 'amber', 'Receivables (udhaar)', money(rec), `${recList.length} customer${recList.length === 1 ? '' : 's'} owe you`, Auth.can('reports.view') ? '#/reports/receivables' : '#/customers')}
        ${Auth.can('purchase.manage') ? kpi('truck', 'red', 'Payables', money(pay), `${payList.length} supplier${payList.length === 1 ? '' : 's'} to pay`, Auth.can('reports.view') ? '#/reports/payables' : null) : ''}
        ${showProfit ? kpi('graph-up-arrow', 'indigo', 'Profit this month', money(g.monthV.profit), `Phones ${esc(cur())} ${fmtNum(g.monthV.phoneProfit)}`, '#/reports/profit') : ''}
      </div>
      <div class="wallet-row mt-2 stagger">${wallets.map((w) => `<a class="wallet-card mini" href="#/services" style="--wc:${w.meta?.color || '#6366f1'}"><div class="wc-head"><i class="bi bi-${w.meta?.icon || 'wallet2'}"></i><span>${esc(w.name)}</span></div><div class="wc-bal money ${w.balance < 0 ? 'neg' : ''}" ${money(w.balance)}>0</div></a>`).join('')}</div>

      <div class="row g-3 mt-1">
        <div class="col-lg-8"><div class="card viz-card h-100">
          <div class="viz-head"><div><div class="ttl">Takings — last 7 days</div><div class="sub">Total ${esc(cur())} ${fmtNum(g.days.reduce((s, d) => s + d.total, 0))}</div></div>
            <div class="legend">${SERIES.map(([, l, c]) => `<span><i class="dot ${c}"></i>${l}</span>`).join('')}</div></div>
          <div class="viz week-chart"></div>
          <details class="viz-table"><summary>Show as table</summary><div class="table-responsive"><table class="table table-sm table-report mt-2 mb-0"><thead><tr><th>Date</th>${SERIES.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Total</th></tr></thead>
            <tbody>${g.days.map((d) => `<tr><td>${esc(fmtDate(d.date))}</td>${SERIES.map(([k]) => `<td class="num">${fmtNum(d[k])}</td>`).join('')}<td class="num fw-semibold">${fmtNum(d.total)}</td></tr>`).join('')}</tbody></table></div></details>
        </div></div>
        <div class="col-lg-4"><div class="card viz-card h-100"><div class="viz-head"><div><div class="ttl">Where money comes from</div><div class="sub">This month</div></div></div>
          <div class="donut-wrap">${donut(mixParts, mixTotal ? compact(mixTotal) : '—', 'this month')}<div class="donut-legend">${mixParts.map((p) => `<div><i class="dot ${p.cls}"></i><span>${p.label}</span><b>${mixTotal ? Math.round((p.v / mixTotal) * 100) : 0}%</b></div>`).join('')}</div></div>
        </div></div>
      </div>

      <div class="section-title"><h2>Phone stock</h2><a href="#/phones">Open stock <i class="bi bi-chevron-right"></i></a></div>
      <div class="row g-3">
        <div class="col-lg-4"><div class="card viz-card h-100 stock-card">
          <div class="d-flex align-items-center gap-3"><div class="stock-ring"><span class="n" data-count="${stock.length}">0</span><span class="u">phones</span></div>
            <div><div class="small text-body-secondary">At cost</div><div class="h5 mb-1 money" ${money(stockCost)}>0</div><div class="small text-body-secondary">At selling price</div><div class="fw-semibold money">${esc(cur())} ${fmtNum(stockSale)}</div></div></div>
          <div class="cond-bar mt-3">${condParts.filter((p) => p.v).map((p) => `<span class="${p.cls}" style="flex:${p.v}" title="${esc(p.label)}: ${p.v}"></span>`).join('') || '<span class="empty" style="flex:1"></span>'}</div>
          <div class="cond-legend">${condParts.map((p) => `<span><i class="dot ${p.cls}"></i>${esc(p.label)} <b>${p.v}</b></span>`).join('')}</div>
        </div></div>
        <div class="col-lg-4"><div class="card viz-card h-100"><div class="viz-head"><div><div class="ttl">How long phones sit</div><div class="sub">Cost value by days in stock</div></div></div>
          ${aging.map((a) => `<div class="hbar"><div class="name"><i class="dot ${a.cls}"></i>${a.l}</div><div class="amt money">${a.n} · ${fmtNum(a.v)}</div><div class="track"><div class="fill ${a.cls}" style="width:${stockCost ? Math.max(a.n ? 3 : 0, (a.v / stockCost) * 100) : 0}%"></div></div></div>`).join('')}
        </div></div>
        <div class="col-lg-4"><div class="card viz-card h-100"><div class="viz-head"><div><div class="ttl">Best-selling brands</div><div class="sub">Phones sold, last 30 days</div></div></div>
          ${brands.length ? brands.map(([b, n]) => `<div class="hbar"><div class="name">${esc(b)}</div><div class="amt">${n} sold</div><div class="track"><div class="fill" style="width:${Math.max(6, (n / brands[0][1]) * 100)}%"></div></div></div>`).join('') : UI.emptyState('No phone sales yet', 'phone')}
        </div></div>
      </div>

      <div class="section-title"><h2>Repairs</h2><a href="#/repairs">All jobs <i class="bi bi-chevron-right"></i></a></div>
      <div class="pipeline stagger">${pipe.map((p, i) => `<a class="pipe-step st-${p.k} ${p.n ? 'has' : ''}" href="#/repairs"><div class="n" data-count="${p.n}">0</div><div class="l">${esc(REPAIR_STATUS[p.k].label)}</div>${i < pipe.length - 1 ? '<i class="bi bi-chevron-right arrow"></i>' : ''}</a>`).join('')}</div>

      <div class="row g-3 mt-1">
        <div class="col-md-6"><div class="section-title mt-0"><h2>Ready for pickup</h2><a href="#/repairs">View</a></div>
          <div class="list-card">${ready.slice(0, 5).map((r) => { const wa = waLink(r.customerPhone, `Assalam o Alaikum ${r.customerName}, your ${[r.brand, r.model].filter(Boolean).join(' ')} (job ${r.number}) is ready for pickup.`);
            return `<div class="list-row"><div class="icon-chip tint-green"><i class="bi bi-check2-circle"></i></div><a class="main text-decoration-none text-reset" href="#/repairs/${encodeURIComponent(r.id)}"><div class="title">${esc([r.brand, r.model].filter(Boolean).join(' ') || 'Phone')} · ${esc(r.customerName)}</div><div class="sub">${esc(r.number)} · ${daysBetween(r.date)}d old${r.total - r.paid > 0 ? ' · due ' + fmtNum(r.total - r.paid) : ''}</div></a>${wa ? `<a class="btn btn-sm btn-outline-success" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp"><i class="bi bi-whatsapp"></i></a>` : ''}</div>`; }).join('') || UI.emptyState('No phones waiting for pickup', 'check2-circle')}</div></div>
        <div class="col-md-6"><div class="section-title mt-0"><h2>Recent sales</h2><a href="#/sales">View all</a></div>
          <div class="list-card">${g.recent.map((s) => `<a class="list-row" href="#/sales/${encodeURIComponent(s.id)}">${UI.avatar(s.customerName, 'round')}<div class="main"><div class="title">${esc(s.customerName)}</div><div class="sub">${esc(s.number)} · ${fmtTime(s.createdAt)}${s.tradeIn ? ' · trade-in' : ''}</div></div><div class="end"><div class="fw-bold money">${fmtNum(s.total)}</div>${s.balance > 0.004 ? '<span class="badge text-bg-warning">Credit</span>' : '<span class="badge bg-success-subtle text-success-emphasis">Paid</span>'}</div></a>`).join('') || UI.emptyState('No sales yet today', 'receipt')}</div></div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-md-6"><div class="section-title mt-0"><h2>Who owes you</h2><a href="#/customers">Customers</a></div>
          <div class="list-card">${recList.slice(0, 5).map(([id, b]) => { const p = Catalog.party('customers', id); const wa = waLink(p?.phone, `Assalam o Alaikum ${p?.name || ''}, a gentle reminder: ${cur()} ${fmtNum(b)} is pending at our shop. Thank you.`);
            return `<div class="list-row">${UI.avatar(p?.name || '?', 'round')}<a class="main text-decoration-none text-reset" href="#/customers/${encodeURIComponent(id)}"><div class="title">${esc(p?.name || 'Customer')}</div><div class="sub">${esc(p?.phone || '')}</div></a><div class="end fw-bold money text-danger">${fmtNum(b)}</div>${wa ? `<a class="btn btn-sm btn-outline-success ms-2" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="Remind on WhatsApp"><i class="bi bi-whatsapp"></i></a>` : ''}</div>`; }).join('') || UI.emptyState('Nobody owes you money', 'emoji-smile')}</div></div>
        <div class="col-md-6"><div class="section-title mt-0"><h2>You owe suppliers</h2><a href="#/suppliers">Suppliers</a></div>
          <div class="list-card">${payList.slice(0, 5).map(([id, b]) => { const p = Catalog.party('suppliers', id);
            return `<a class="list-row" href="#/suppliers/${encodeURIComponent(id)}">${UI.avatar(p?.name || '?', 'round')}<div class="main"><div class="title">${esc(p?.name || 'Supplier')}</div><div class="sub">${esc(p?.phone || '')}</div></div><div class="end fw-bold money">${fmtNum(b)}</div></a>`; }).join('') || UI.emptyState('No supplier dues', 'check2-circle')}</div></div>
      </div>
      <div class="text-center small text-body-secondary mt-4 mb-2">Accessories stock value ${esc(cur())} ${fmtNum(accStock)} · ${prods.length} accessory items</div>`);

    UI.countUp(el, (v, node) => (node.dataset.money ? `${cur()} ${fmtNum(v)}` : String(Math.round(v))));
    const chartBox = el.querySelector('.week-chart');
    drawStacked(chartBox, g.days);
    this._resize = debounce(() => { if (chartBox.isConnected) drawStacked(chartBox, g.days); }, 200);
    window.addEventListener('resize', this._resize);

    if (Auth.can('backup.restore') && pref.get('legacyHandled') !== true) {
      Backup.legacyDataExists().then((yes) => yes && $el.find('.legacy-hint').html('<div class="alert alert-info py-2 small d-flex align-items-center gap-2"><i class="bi bi-database"></i><div class="flex-grow-1">Data from an older version was found on this device.</div><a class="btn btn-sm btn-info" href="#/backup">Review</a></div>'));
    }
    const refresh = () => { if (location.hash === '' || location.hash.startsWith('#/dashboard')) this.render(el); };
    this._h = refresh;
    document.addEventListener('data:changed', refresh);
  },
  destroy() {
    if (this._h) document.removeEventListener('data:changed', this._h);
    if (this._resize) window.removeEventListener('resize', this._resize);
    this._h = null; this._resize = null;
  },
};
