/**
 * apiHeaders.ts — the one place that builds auth headers for API calls.
 *
 * Every page's local hdr()/hdrs()/getHeaders() helper delegates here.
 *
 * Auth is JWT only: the password is never stored (see Login.tsx), so the old
 * X-Username/X-Password fallback could only ever send an empty password.
 * The token is sent until its real expiry; after that the request goes out
 * without Authorization, the server answers 401, and App.jsx's fetch
 * interceptor shows the biometric lock or logs out. (While offline nothing
 * reaches the server, so the app keeps working on local data.)
 */
export function apiAuthHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const token  = localStorage.getItem('jwt_token');
  const expiry = parseInt(localStorage.getItem('jwt_expiry') || '0', 10);
  if (token && Date.now() < expiry) {
    h['Authorization'] = `Bearer ${token}`;
    // Server logs show who made the call
    h['X-Username'] = localStorage.getItem('auth_user') ?? '';
  }
  return h;
}

/** @deprecated kept for existing imports — same as apiAuthHeaders() */
export function apiHeaders(): Record<string, string> {
  return apiAuthHeaders();
}
