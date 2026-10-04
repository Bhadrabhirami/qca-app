/**
 * jwtAuth.ts — JWT Authentication Service for QCA Mobile App
 * Phase 1: Parallel to existing X-Username/X-Password auth
 * Stores token in @capacitor/preferences (secure native storage)
 */
// Using localStorage instead of @capacitor/preferences for compatibility

const TOKEN_KEY   = 'jwt_access_token';
const USER_KEY    = 'jwt_user';
const EXPIRY_KEY  = 'jwt_expiry';

// ── Token Storage ──────────────────────────────────────────────────────────
export async function saveJwtToken(token: string, expiresIn: number, user: any) {
  const expiryMs = Date.now() + expiresIn * 1000;
  localStorage.setItem('jwt_token', token);
  localStorage.setItem('jwt_expiry', String(expiryMs));
  localStorage.setItem('jwt_user_cache', JSON.stringify(user));
}

export async function getJwtToken(): Promise<string | null> {
  return getJwtTokenSync();
}

export async function getJwtUser(): Promise<any | null> {
  try {
    const v = localStorage.getItem('jwt_user_cache');
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

export async function clearJwtToken() {
  localStorage.removeItem('jwt_token');
  localStorage.removeItem('jwt_expiry');
  localStorage.removeItem('jwt_user_cache');
}

export async function isJwtLoggedIn(): Promise<boolean> {
  const token = await getJwtToken();
  return !!token;
}

// ── API Calls ──────────────────────────────────────────────────────────────
function getBase(): string {
  const ip = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
  return ip.startsWith('http') ? ip : `http://${ip}`;
}

export async function jwtLogin(username: string, password: string): Promise<{
  success: boolean;
  token?: string;
  user?: any;
  error?: string;
  locked?: boolean;
  attemptsRemaining?: number;
}> {
  try {
    const r = await fetch(`${getBase()}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const j = await r.json();
    if (r.ok && j.access_token) {
      await saveJwtToken(j.access_token, j.expires_in, j.user);
      return { success: true, token: j.access_token, user: j.user };
    }
    return {
      success:          false,
      error:            j.error || 'Login failed',
      locked:           j.locked || false,
      attemptsRemaining: j.attempts_remaining,
    };
  } catch {
    return { success: false, error: 'Cannot reach server' };
  }
}

export async function jwtVerify(): Promise<boolean> {
  const token = await getJwtToken();
  if (!token) return false;
  try {
    const r = await fetch(`${getBase()}/api/auth/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ access_token: token }),
    });
    const j = await r.json();
    return j.valid === true;
  } catch {
    return false;
  }
}

export async function jwtLogout() {
  await clearJwtToken();
}

export async function checkPasswordStrength(password: string): Promise<{
  strong: boolean;
  score: number;
  strength: string;
  requirements: string[];
}> {
  try {
    const r = await fetch(`${getBase()}/api/auth/check-password-strength`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
    });
    return await r.json();
  } catch {
    return { strong: false, score: 0, strength: 'Unknown', requirements: [] };
  }
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<{
  success: boolean;
  error?: string;
  requirements?: string[];
}> {
  const token = await getJwtToken();
  if (!token) return { success: false, error: 'Not logged in' };
  try {
    const r = await fetch(`${getBase()}/api/auth/change-password`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ access_token: token, old_password: oldPassword, new_password: newPassword }),
    });
    const j = await r.json();
    if (r.ok) return { success: true };
    return { success: false, error: j.error, requirements: j.requirements };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/** Get JWT auth header for API calls */
export async function jwtHeader(): Promise<Record<string, string>> {
  const token = await getJwtToken();
  if (!token) return {};
  return { 'Authorization': `Bearer ${token}` };
}

/** Synchronous JWT token getter for use in hdr() functions */
export function getJwtTokenSync(): string | null {
  // Check both plain and CapacitorStorage formats
  const token  = localStorage.getItem('jwt_token')
               || localStorage.getItem('CapacitorStorage.jwt_access_token');
  const expiry = localStorage.getItem('jwt_expiry')
               || localStorage.getItem('CapacitorStorage.jwt_expiry');
  if (!token || !expiry) return null;
  if (Date.now() > parseInt(expiry) - 5 * 60 * 1000) return null;
  return token;
}
