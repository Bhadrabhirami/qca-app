/**
 * utils.ts — Shared frontend utilities
 * Import in pages that need safe fetch with timeout
 */

/** Fetch with AbortSignal timeout — prevents indefinite hangs on Android mobile */
export function fetchT(
  url: string,
  opts: RequestInit = {},
  ms = 15000
): Promise<Response> {
  // AbortSignal.timeout is available in modern WebView (Chromium 103+)
  if (typeof AbortSignal.timeout === 'function') {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  }
  // Fallback for older WebViews
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

/** Format file size */
export function fmtFileSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024)        return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Date string YYYY-MM-DD */
export function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

/** N days ago YYYY-MM-DD */
export function daysAgoStr(n: number): string {
  return new Date(Date.now() - (n - 1) * 86400000).toISOString().split('T')[0];
}

/** Time ago label */
export function timeAgoLabel(dt: string): string {
  if (!dt) return '';
  const diff = (Date.now() - new Date(dt).getTime()) / 1000;
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Standard auth headers — reads from localStorage */
export function authHeaders(): Record<string, string> {
  return (()=>{const _j=localStorage.getItem('jwt_token'),_e=parseInt(localStorage.getItem('jwt_expiry')||'0');if(_j&&Date.now()<_e-60000)return{'Content-Type':'application/json','Authorization':'Bearer '+_j,'X-Username':localStorage.getItem('auth_user')||''};return{'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};})();
}

/** Build base URL from stored server IP */
export function buildServerBase(): string {
  const ip = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
  return ip.startsWith('http') ? ip : `http://${ip}`;
}

/** Show native confirm dialog — returns Promise<boolean> */
export function confirmAsync(msg: string): Promise<boolean> {
  return Promise.resolve(window.confirm(msg));
}
