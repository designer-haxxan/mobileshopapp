// Authentication against the eposwala login API (POST {AUTH_API_BASE}/login).
// One account is bound server-side to one device (deviceId). After a successful online login the
// session { token, expiresAt, username } is kept in LocalStorage and the POS works offline until
// expiresAt. Passwords are never stored.
import { CONFIG, storageKey } from '../config.js';
import { AppError } from '../core/utils.js';

const SESSION_KEY = storageKey('session');
// Device id identifies the PHONE (the server binds the account to it), so it is intentionally shared by all
// apps on this origin; changing it would make the server reply device_mismatch.
const DEVICE_KEY = 'minipos.deviceId';

// Exact error codes returned by the API → user-facing messages.
const ERRORS = {
  missing_fields: 'Enter your username and password.',
  invalid_credentials: 'Wrong username or password.',
  device_mismatch: `This account is already active on another phone. Call ${CONFIG.SUPPORT_PHONE} for help.`,
  account_disabled: `This account has been disabled. Call ${CONFIG.SUPPORT_PHONE} for help.`,
};
const GENERIC = 'Login failed. Try again.';

export const ROLES = { admin: 'Owner', manager: 'Manager', cashier: 'Cashier' };

const CASHIER = ['sale.create', 'party.edit', 'voucher.create', 'reports.view', 'repair.manage', 'service.create'];
const MANAGER = [...CASHIER, 'sale.edit', 'sale.void', 'sale.return', 'purchase.manage', 'product.edit', 'product.delete',
  'party.delete', 'voucher.void', 'phone.buy', 'phone.edit', 'account.manage', 'stock.adjust', 'reports.profit', 'settings.manage', 'backup.export'];
const PERMISSIONS = { cashier: CASHIER, manager: MANAGER, admin: ['*'] };

let current = null;

// Stable per-browser device id (sent with every login; the server binds the account to it).
export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

// The API identifies a shop account by username; that account owns all POS functions on its device.
// If the server ever includes a known `role`, it is honoured.
function toUser(s) {
  return { id: s.username, name: s.username, username: s.username, role: PERMISSIONS[s.role] ? s.role : 'admin' };
}

const isValid = (s) => !!(s && typeof s.token === 'string' && s.token && typeof s.username === 'string' && Number(s.expiresAt) > Date.now());

// Returns { user } or { user:null, reason }
export function restoreSession() {
  const s = readSession();
  if (!s) return { user: null };
  if (!isValid(s)) {
    localStorage.removeItem(SESSION_KEY);
    current = null;
    return { user: null, reason: 'Your session has expired. Connect to the internet and sign in again.' };
  }
  current = toUser(s);
  return { user: current };
}

export const user = () => current;
export const expiresAt = () => Number(readSession()?.expiresAt) || 0;
export const sessionExpired = () => !!current && !isValid(readSession());

export function can(perm) {
  if (!current) return false;
  const p = PERMISSIONS[current.role] || [];
  return p.includes('*') || p.includes(perm);
}
export function require(perm) {
  if (!can(perm)) throw new AppError('You do not have permission for this action.', 'FORBIDDEN');
}

export async function login(username, password) {
  username = String(username ?? '').trim();
  password = String(password ?? '');
  if (!username || !password) throw new AppError(ERRORS.missing_fields);
  if (!navigator.onLine) throw new AppError('Internet connection is required to sign in.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${CONFIG.AUTH_API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceId: deviceId() }),
      credentials: 'omit', cache: 'no-store', signal: ctrl.signal,
    });
  } catch {
    throw new AppError('Could not reach the login server. Check your internet connection and try again.');
  } finally { clearTimeout(timer); }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) throw new AppError(ERRORS[data?.error] || GENERIC);

  const session = { token: data?.token, expiresAt: Number(data?.expiresAt), username: data?.username };
  if (data?.role) session.role = data.role;
  if (!isValid(session)) throw new AppError(GENERIC);
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  current = toUser(session);
  return current;
}

// Logout only clears the local session (the API has no logout endpoint). The device binding stays on the server.
export function logout() {
  localStorage.removeItem(SESSION_KEY);
  current = null;
}
