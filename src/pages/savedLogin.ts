/**
 * savedLogin.ts — remember the login so an expired session can be renewed
 * with a fingerprint instead of retyping the password.
 *
 * - Username: plain localStorage ('last_username'), survives session expiry.
 * - Password: Android Keystore-encrypted storage (@aparajita/capacitor-secure-storage),
 *   only on the native app — the web fallback of that plugin is not encrypted,
 *   so in a browser nothing is saved.
 * - Reading it back is always preceded by a fingerprint / device-credential
 *   prompt (see Login.tsx). Saved per server, so a dev and a prod server
 *   don't share credentials.
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

const USER_KEY = 'last_username';

const isNative = () => !!(window as any).Capacitor?.isNativePlatform?.();
const credKey  = () => `qca_login:${(localStorage.getItem('server_ip') || '').replace(/\/+$/, '')}`;

export function getLastUsername(): string {
  return localStorage.getItem(USER_KEY) || '';
}

export function setLastUsername(username: string) {
  if (username) localStorage.setItem(USER_KEY, username);
}

export function canRememberPassword(): boolean {
  return isNative();
}

export async function savePassword(username: string, password: string): Promise<void> {
  if (!isNative() || !username || !password) return;
  try { await SecureStorage.set(credKey(), { u: username, p: password }); }
  catch (e) { console.warn('[savedLogin] save failed', e); }
}

export async function loadSavedLogin(): Promise<{ u: string; p: string } | null> {
  if (!isNative()) return null;
  try {
    const v = await SecureStorage.get(credKey()) as any;
    return v && typeof v.u === 'string' && typeof v.p === 'string' ? { u: v.u, p: v.p } : null;
  } catch { return null; }
}

export async function hasSavedLogin(): Promise<boolean> {
  return (await loadSavedLogin()) !== null;
}

/** Forget the saved password (wrong/changed password, or the user turned it off). Username is kept. */
export async function forgetPassword(): Promise<void> {
  if (!isNative()) return;
  try { await SecureStorage.remove(credKey()); } catch { /* nothing saved */ }
}
