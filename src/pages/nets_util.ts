/**
 * nets_util.ts — small helpers shared by the net booking screens.
 */
import { apiAuthHeaders } from './apiHeaders';

export const NET_NAMES: Record<string, string> = {
  syn1: 'Synthetic Turf 1', syn2: 'Synthetic Turf 2', con: 'Concrete Wicket', mat: 'Matting Wicket',
};

/** YYYY-MM-DD in the phone's own time zone (toISOString() is UTC — wrong before 5:30 AM in India) */
export function localIso(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const fmtAmt = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
export const fmtDay = (iso: string) => iso
  ? new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  : '';
/** Day session before 4 PM, flood-lit night session after */
export const defaultSession = (): 'day' | 'night' => (new Date().getHours() >= 16 ? 'night' : 'day');

const base = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
/** Call the net API; throws Error(message) with the server's plain-English reason */
export async function netApi(path: string, body?: any): Promise<any> {
  const r = await fetch(`${base()}/api/data/nets${path}`, body === undefined
    ? { headers: apiAuthHeaders(false) }
    : { method: 'POST', headers: { ...apiAuthHeaders(false), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 403 ? "You don't have permission for this" : (j.error || j.detail || `Server error ${r.status}`));
  return j;
}
export const netMsg = (e: any) => /failed to fetch/i.test(e?.message || '') ? 'Cannot reach the server' : e?.message || 'Something went wrong';

/** "6:30 PM" → minutes, for sorting bookings by start time */
export function labelMinutes(label: string): number {
  const m = String(label || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 9999;
  let h = Number(m[1]) % 12; if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
export function firstSlotMinutes(b: any): number {
  const all = Object.values(b?.nets_booked || {}).flat() as string[];
  return all.length ? Math.min(...all.map(labelMinutes)) : 9999;
}
/** "Synthetic Turf 1: 6:30 PM, 7:30 PM" lines */
export function slotLines(b: any): string[] {
  return Object.entries(b?.nets_booked || {}).map(([net, hrs]: any) =>
    `${NET_NAMES[net] || net}: ${Array.isArray(hrs) ? hrs.join(', ') : hrs}`);
}
/** A ₹0 booking (pass session or free) has nothing to collect */
export const isFree = (b: any) => Number(b?.total_amount || 0) <= 0;

function openUrl(url: string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
/** WhatsApp the booking details to the person who booked (null when there's no usable mobile) */
export function shareBookingUrl(b: any): string | null {
  const digits = String(b?.mobile || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const to = digits.length === 10 ? `91${digits}` : digits;
  const paid = b.payment_status === 'paid' ? ' (paid)' : isFree(b) ? '' : ' (to pay at the desk)';
  const text = `Quickies Cricket Academy — net booking\nRef: ${b.booking_ref}\n${fmtDay(b.booking_date)} · ${b.session_type === 'day' ? 'Day' : 'Night'}\n` +
    `${slotLines(b).join('\n')}\nAmount: ${isFree(b) ? 'Free / pass' : fmtAmt(b.total_amount)}${paid}\nPlease show this reference at the nets.`;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
export function shareBooking(b: any): boolean {
  const url = shareBookingUrl(b);
  if (url) openUrl(url);
  return !!url;
}
