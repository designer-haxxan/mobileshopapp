# MobiShop POS — mobile shop software

Offline-first, mobile-first software for a mobile phone shop in Pakistan, as a static PWA (no build step).
HTML5 · ES modules · jQuery · Bootstrap 5 · Bootstrap Icons · IndexedDB · Service Worker · eposwala login API.

## What it does

| Area | Features |
|---|---|
| **Phones (IMEI stock)** | Every phone is its own record: IMEI 1/2 (15-digit **Luhn check**, duplicate detection), brand, model, storage/RAM, colour, **condition** (new / open box / used / refurbished), **PTA status** (PTA approved / non-PTA / JV / factory unlocked / unchecked), battery %, accessories, buying price, extra (repair) cost, selling price, days in stock, full **history per IMEI**. Search by IMEI, last 6 digits, model or brand; scan the IMEI barcode with the camera or a hardware scanner. |
| **Buy phones** | *From dealers/suppliers* (new or used stock, bulk, on credit) or *from a person* (used phone): seller name, **CNIC**, phone and address are saved, and a **purchase receipt with an ownership declaration** (English + Urdu, signature lines) is printed for the seller. |
| **Sell phones** | Phones go into the normal POS cart next to accessories on one bill. Line price/discount, **warranty days per phone** (defaults by condition), IMEI + condition + PTA + warranty printed on the receipt. Returns, void and edit all restore phone stock correctly. |
| **Trade-in / exchange** | At checkout, take the customer's old phone as part payment: it is added to stock (with the customer's details) in the same transaction, and the bill shows *Total − Trade-in = Net to pay*. |
| **IMEI Check** | Type or scan any IMEI: validity, the shop's record (bought, sold to whom, warranty left), repair jobs, and a one-tap *copy IMEI & open PTA DVS* (or SMS the IMEI to 8484). |
| **Repairs** | Job cards (customer, phone, IMEI, fault, what was left with the shop, lock code, estimate, advance, expected date, technician, urgent). Status pipeline *Received → Diagnosing / Waiting parts → Repairing → Ready → Delivered*, parts from accessory stock or bought outside, labour, **repair warranty**, advance payments, delivery with balance on customer account, cancel with refund / inspection fee, reopen for warranty comebacks, WhatsApp updates, printable job card and receipt. |
| **Easypaisa · JazzCash · load · bills** | *Send (cash in)*, *Withdraw (cash out)*, *Bill payment*, *Mobile load/packages*, *Other*. Each transaction records the **fee** you charge and the **commission** the company pays you; wallet balances (Easypaisa, JazzCash, Load) and cash move together in the ledger. Rates are remembered per wallet/service. Top up a wallet from cash with one tap. |
| **Accessories & spare parts** | Existing product module (barcode, SKU, categories, wholesale price, images, low-stock alerts), with mobile categories pre-loaded: covers, tempered glass, chargers, cables, power banks, handsfree, speakers, watches, memory cards, SIMs, spare parts… |
| **Dashboard** | Today's takings, profit, phones sold, repairs delivered, services; *needs attention* alerts (repairs ready, late jobs, phones unsold 30/60+ days, low stock, negative wallets, backup); cash, **receivables (udhaar) with WhatsApp reminders**, payables, wallet balances; 7-day takings by category, month mix donut, phone stock value / condition mix / **stock ageing**, best-selling brands, repair pipeline. |
| **Accounts** | Cash book, double-entry ledgers, customer/supplier ledgers, receivables/payables, receipts/payments/transfers — unchanged, and now include wallets, repair income/advances and service income. |
| **Reports** (print + CSV) | New: *Phone stock (IMEI)*, *Phone sales & profit*, *Used phone register (seller details)*, *Repair jobs*, *Easypaisa/JazzCash/load*. Plus all the original sales, purchase, ledger, stock and **profit** reports (profit now includes repair parts and service income). |
| **Backup & restore** | Versioned JSON with checksum; phones, repairs and services included. Replace or merge. |

## Architecture

```
index.html              App shell (splash, animated login, layout)
manifest.json           PWA manifest
service-worker.js       Precache of shell + CDN libs; cache-first; /api/ requests never cached
css/app.css             Base design system
css/mobile.css          Mobile-shop theme (palette, hero, phone cards, wallets, stepper, charts, login art)
js/app.js               Boot, auth gate + session expiry, router (lazy-loaded modules), connection badge, SW updates
js/config.js            Login API URL, support phone, app/schema/backup versions, APP_ID
js/core/                utils, settings, ui helpers, shared views, mobile.js (brands, PTA/conditions, wallet & repair constants, IMEI Luhn)
js/db/                  IndexedDB wrapper (atomic multi-store transactions) + schema (v2)
js/services/            auth, catalog (in-memory search incl. in-stock phones), posting engine, backup, seed (default categories)
js/modules/             dashboard, pos, documents, phones (stock/detail/buy/IMEI), repairs, services, products, stock, parties, vouchers, accounts, settings, backup
js/reports/             reports
js/printer/             ESC/POS encoder, receipt builder (sales, repair job card, service receipt), Bluetooth/RawBT/browser printing
js/scanner/             camera scanning + keyboard-wedge scanner detection
```

### Storage

| Where | What |
|---|---|
| IndexedDB `mobishop_pos` | Business data: products, categories, customers, suppliers, accounts, sales + items, purchases + items, returns, vouchers, **ledger entries**, stock moves, adjustments, held sales, audit log, counters — and the mobile-shop stores **`devices`** (one record per IMEI, with history), **`repairs`** (job cards with payments and parts) and **`services`** (wallet / load / bill transactions) |
| LocalStorage | Settings (business profile, tax, prefixes, warranty days, printer, theme), device preferences, `mobishop.session`, drafts, and the shared phone id `minipos.deviceId` |

**Shared origin.** All apps under the same GitHub Pages user are one origin (one IndexedDB / LocalStorage / Cache Storage), so this app namespaces everything with `CONFIG.APP_ID` (`mobishop`): database `mobishop_pos`, keys `mobishop.*`, caches `mobishop-v*`. It does **not** touch the old SaleAPP/DistERP data (`disterp_*`, `saleapp_pos`); *Backup & Restore* can still import `saleapp_pos`. If you copy this app for another shop, **change `APP_ID`** in `js/config.js` and `service-worker.js`.

### How phones, repairs and wallets post to the books

Every operation runs in **one IndexedDB transaction** (document + lines + stock/phone state + balanced ledger entries + counter + audit record). Any failure aborts everything; a duplicate tap is detected by the document id.

- **Phone purchase**: `Dr Purchases / Cr Supplier or Cash`; creates the `devices` records. IMEIs must be valid and not already in stock. A phone that was sold earlier can be bought back (the record is revived with its history).
- **Phone sale**: normal sale entries; the phone becomes *sold*, its cost goes on the sale line (profit per IMEI). Return/void/edit put it back in stock; editing/voiding a *purchase* is refused while its phone has been sold.
- **Trade-in**: `Dr Purchases (trade value) / Cr Customer` (credit) or the cash due is reduced; the old phone enters stock in the same transaction.
- **Repair**: advances `Dr Cash/Bank / Cr Repair Advances` (a liability); at delivery `Dr Repair Advances (+ Customer for any balance) / Cr Repair Income`, parts leave stock (`stockMoves` type `repair`), parts bought with shop cash are expensed.
- **Wallet / load / bill**: *out* `Dr Cash (amount + fee) / Cr Wallet (amount) / Cr Service Income (fee)`; *in* `Dr Wallet (amount + fee) / Cr Cash (amount) / Cr Service Income (fee)`; commission `Dr Wallet / Cr Service Income`.

Balances and reports are always derived from records. *Settings → App & data* can verify ledger balance and stock.

### Authentication

Login uses the eposwala API (`CONFIG.AUTH_API_BASE`, default `https://eposwala.com/api`):

```
POST /api/login   Content-Type: application/json
{ "username": "...", "password": "...", "deviceId": "..." }
2xx  → { "token": "...", "expiresAt": <unix ms>, "username": "..." }
!2xx → { "error": "missing_fields" | "invalid_credentials" | "device_mismatch" | "account_disabled" }
```

- **Login requires internet.** After that the app works offline until `expiresAt`.
- **One device per account** (`deviceId` in `localStorage["minipos.deviceId"]`). Moving to another phone goes through support (`CONFIG.SUPPORT_PHONE`).
- **Permissions.** The logged-in account is the shop owner (everything allowed). If the server ever adds a `role` (`manager` / `cashier`) the role permissions apply: cashiers can sell, run repairs and wallet services; managers can also buy/edit phones, void, edit, and see profit.

## Setup

1. **Login API** — set `AUTH_API_BASE` and `SUPPORT_PHONE` in `js/config.js` if they differ. The API must send CORS headers for the origin the app is served from (or serve the app from the API's own origin).
2. **Run locally** — ES modules and the service worker need HTTP(S); `localhost` counts as secure.

   ```bash
   python -m http.server 8765
   ```

   Then open http://localhost:8765.
3. **Deploy** — GitHub Pages (branch `main`, root; `.nojekyll` keeps files unchanged, `CNAME` sets the custom domain) or any HTTPS host. **HTTPS is required** for the service worker, camera and Web Bluetooth.

When you change any file, bump `VERSION` in `service-worker.js`; installed apps update themselves the next time they are opened online.

## Printing & scanning

| Capability | Notes |
|---|---|
| Web Bluetooth ESC/POS (58/80 mm) | Chrome/Edge on Android/desktop, BLE printers only. Not on iOS. |
| RawBT | Android app that bridges to classic Bluetooth/USB/network printers. |
| Browser print | Everywhere (AirPrint, PDF, any printer); also the automatic fallback. |
| Urdu | Shop name, customer and item names and footers print in Jameel Noori Nastaleeq on every print method. |
| Documents | Sales receipt (IMEI, condition, PTA, warranty, trade-in), repair job card & repair receipt, service receipt, phone price tag (58 mm), seller purchase receipt (A5). |
| Camera / hardware scanners | IMEI and product barcodes: native `BarcodeDetector` or `html5-qrcode`; USB/Bluetooth keyboard-wedge scanners work on the POS and IMEI screens. Camera-permission help for Android/iOS is built in. |

## Known limitations

- **Data lives on the device.** No cloud sync; use backups (the dashboard reminds you after 7 days). To combine devices, give each a different number prefix and use **Merge**.
- **Anyone with physical access can read local data** (the offline session gate is client-side). Use phone lock screens.
- **PTA status is entered by hand.** The app validates IMEI format/checksum and opens the official PTA DVS site, but it cannot query PTA from the browser.
- **Cost of goods sold** is the cost recorded on each phone / the last purchase price of each accessory (no FIFO / weighted average).
- **Outside spare parts** bought for a repair are only expensed if you tick *bought with shop cash* on the part line (otherwise record the payment in the Cash Book).
- **Installments / layaway** are not modelled separately: sell on credit to a customer and record receipts as they pay.
- iOS has no Web Bluetooth: print through AirPrint / the browser dialog.
