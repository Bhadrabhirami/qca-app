/**
 * nets_staff.tsx — Net Booking: Staff / Coach View
 * Permissions: nets:view (list/calendar), nets:manage (mark paid / no-show / cancel / expire),
 * nets:book or admin (Book for someone)
 *
 * Tabs:
 *   Today     — today's bookings in start-time order for ground-level ops
 *   Bookings  — full list with filters (load more)
 *   Verify    — scan QR / enter booking ref → same booking card and actions
 */

import React, { useState, useCallback, useEffect } from 'react';
import { BarcodeScanner } from '@capacitor-community/barcode-scanner';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';
import { useNavigate } from 'react-router-dom';
import { usePermissions, can } from './usePermissions';
import { canBookNets } from './nets_book';
import { localIso, fmtAmt, fmtDay, netApi, netMsg, slotLines, firstSlotMinutes, isFree, shareBookingUrl, shareBooking } from './nets_util';

const C = {
  navy:   '#0d1b2a',
  green:  '#1a472a',
  gold:   '#c5a059',
  bg:     '#f0f2f5',
  card:   '#fff',
  border: '#e0e0e0',
  muted:  '#6b7280',
  red:    '#dc2626',
};
const STATUS_COLOR: Record<string, string> = {
  confirmed:  '#16a34a',
  cancelled:  '#dc2626',
  pending:    '#d97706',
  expired:    '#6b7280',
};
const PAY_COLOR: Record<string, string> = {
  paid:     '#16a34a',
  pending:  '#d97706',
  waived:   '#6b7280',
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 20,
      backgroundColor: color + '18', color, border: `1px solid ${color}33`,
      textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    }}>{label}</span>
  );
}

/** One booking with its nets, times and the actions this user may take */
export function BookingCard({ b, canManage, onAction, highlight }: { b: any; canManage: boolean; onAction: () => void; highlight?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const today = localIso();
  const day = String(b.booking_date || '').slice(0, 10);
  const live = b.status === 'confirmed';
  const owes = live && !isFree(b) && b.payment_status === 'pending';
  const paid = b.payment_status === 'paid' || Number(b.amount_paid || 0) > 0;
  // Undoing a payment reverses money: admins only (nets:admin)
  const canUndoPay = (localStorage.getItem('user_role') || '').toLowerCase() === 'admin' || can('nets:admin' as any);

  const act = async (path: string, done: string, body?: any) => {
    setLoading(true); setMsg('');
    try { await netApi(path, body || {}); setMsg(`✓ ${done}`); onAction(); }
    catch (e) { setMsg(netMsg(e)); }
    finally { setLoading(false); }
  };
  const markPaid = () => { if (confirm(`Mark ${fmtAmt(b.total_amount)} paid for ${b.booking_ref}?`)) act(`/bookings/${b.booking_ref}/paid`, 'Marked paid'); };
  const noShow = () => { if (confirm(`${b.member_name || 'They'} didn't turn up?\nThe net is released for walk-ins.${b.payment_status === 'paid' ? '\nThe payment stays recorded (no refund).' : ''}`)) act(`/bookings/${b.booking_ref}/no-show`, 'Marked no-show — net released'); };
  const cancel = () => {
    const reason = window.prompt(`Cancel ${b.booking_ref}? The slots are released.\n\nReason (optional):`, '');
    if (reason === null) return;
    act(`/bookings/${b.booking_ref}/cancel`, 'Cancelled', { reason });
  };
  const undoPay = () => {
    const reason = window.prompt(`Undo the ${fmtAmt(b.amount_paid || b.total_amount)} payment on ${b.booking_ref}?\nIt goes back to "payment pending" — then it can be collected again or cancelled.\n\nReason (required, e.g. refunded / marked by mistake):`, '');
    if (reason === null) return;
    act(`/bookings/${b.booking_ref}/unpay`, 'Payment undone — now pending', { reason });
  };
  const expire = () => { if (confirm(`Expire unpaid booking ${b.booking_ref}? Its slots are released.`)) act(`/bookings/${b.booking_ref}/expire`, 'Expired'); };
  const past = day < today, isToday = day === today;
  const btn = (bg: string, fg: string, border?: string): React.CSSProperties => ({ flex: 1, padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
    border: border ? `1px solid ${border}` : 'none', backgroundColor: bg, color: fg, fontWeight: 800, fontSize: 12 });

  return (
    <div style={{ backgroundColor: C.card, borderRadius: 12, padding: '12px 14px', marginBottom: 8,
      border: `${highlight ? 2 : 1}px solid ${highlight ? (STATUS_COLOR[b.status] || C.border) : C.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      opacity: live ? 1 : 0.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontWeight: 900, fontSize: 13, color: C.navy, fontFamily: 'monospace' }}>{b.booking_ref}</span>
        <Badge label={b.status} color={STATUS_COLOR[b.status] || C.muted} />
        {isFree(b) ? <Badge label={b.price_type === 'pass' ? 'pass' : 'free'} color="#7c3aed" />
          : <Badge label={b.payment_status} color={PAY_COLOR[b.payment_status] || C.muted} />}
      </div>
      <div style={{ fontWeight: 800, fontSize: 14, color: '#111' }}>{b.member_name || '—'}</div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
        {b.mobile ? `📞 ${b.mobile} · ` : ''}{day === today ? 'Today' : fmtDay(day)} · {b.session_type === 'day' ? '☀️ Day' : '🌙 Night'}
      </div>
      {slotLines(b).map(l => <div key={l} style={{ fontSize: 12, color: '#111', marginTop: 2, fontWeight: 600 }}>🏏 {l}</div>)}
      <div style={{ fontSize: 13, fontWeight: 900, color: C.navy, marginTop: 4 }}>
        {isFree(b) ? 'Free / pass' : fmtAmt(b.total_amount)}
        {b.booked_by_admin && <span style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}> · booked by {b.booked_by_admin}</span>}
      </div>
      {b.price_override_reason && <div style={{ fontSize: 10.5, color: C.muted }}>Price changed: {b.price_override_reason}</div>}
      {!live && b.cancellation_reason && <div style={{ fontSize: 10.5, color: C.muted }}>{b.cancellation_reason}</div>}
      {msg && <div style={{ fontSize: 12, fontWeight: 700, color: msg.startsWith('✓') ? '#16a34a' : C.red, marginTop: 6 }}>{msg}</div>}
      {live && paid && !past && canManage && !canUndoPay && (
        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 6 }}>Paid bookings can't be cancelled — ask an admin to undo the payment first.</div>
      )}
      {/* Future: paid / cancel / share · Today: + no-show · Past: only settle what's still owed */}
      {live && (canManage && owes || !past) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {canManage && owes && <button disabled={loading} onClick={markPaid} style={btn('#16a34a', '#fff')}>💵 Paid</button>}
          {canManage && isToday && <button disabled={loading} onClick={noShow} style={btn('#fffbeb', '#b45309', '#f59e0b')}>🚫 No-show</button>}
          {canManage && past && owes && <button disabled={loading} onClick={expire} style={btn('#fffbeb', '#d97706', '#d97706')}>⏱ Expire</button>}
          {canManage && !past && !paid && <button disabled={loading} onClick={cancel} style={btn('#fff', C.red, C.red)}>✕ Cancel</button>}
          {canUndoPay && !past && paid && <button disabled={loading} onClick={undoPay} style={btn('#fff', '#6b7280', '#9ca3af')}>↩ Undo payment</button>}
          {!past && shareBookingUrl(b) && <button onClick={() => shareBooking(b)} style={btn('#25d366', '#fff')}>💬 Share</button>}
        </div>
      )}
    </div>
  );
}

// ── Stale Bookings Panel (unpaid bookings whose time has passed) ─────
function StaleBookingsPanel({ onDone }: { onDone: () => void }) {
  const [open,    setOpen]    = React.useState(false);
  const [stale,   setStale]   = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expiring,setExpiring]= React.useState<string|null>(null);
  const [msg,     setMsg]     = React.useState('');

  const loadStale = async () => {
    setLoading(true); setMsg('');
    try { const j = await netApi('/bookings/stale'); setStale(j.data || []); setOpen(true); }
    catch (e) { setMsg(netMsg(e)); setOpen(true); }
    finally { setLoading(false); }
  };
  const expireOne = async (ref: string) => {
    if (!confirm(`Expire unpaid booking ${ref}? Its slots are released.`)) return;
    setExpiring(ref); setMsg('');
    try { await netApi(`/bookings/${ref}/expire`, {}); setStale(prev => prev.filter(b => b.booking_ref !== ref)); setMsg(`Done: ${ref} expired`); }
    catch (e) { setMsg(netMsg(e)); }
    finally { setExpiring(null); }
  };
  const expireAll = async () => {
    if (!confirm(`Expire ALL ${stale.length} unpaid past bookings? Their slots are released.`)) return;
    setLoading(true); setMsg('');
    try { const j = await netApi('/bookings/expire-stale', {}); setMsg(`Done: ${j.expired || 0} bookings expired`); setStale([]); onDone(); }
    catch (e) { setMsg(netMsg(e)); }
    finally { setLoading(false); }
  };

  return (
    <>
      <button onClick={loadStale} disabled={loading}
        style={{padding:'6px 12px',borderRadius:20,border:'1px solid #d97706',
          backgroundColor:'#fffbeb',color:'#d97706',fontSize:11.5,fontWeight:800,cursor:'pointer'}}>
        {loading ? 'Loading…' : '⏱ Unpaid past bookings'}
      </button>
      {open && (
        <div style={{position:'fixed' as const,inset:0,zIndex:200,backgroundColor:'rgba(0,0,0,0.6)',
          display:'flex',alignItems:'flex-end' as const}} onClick={()=>{setOpen(false);onDone();}}>
          <div onClick={e=>e.stopPropagation()} style={{backgroundColor:'#fff',width:'100%',maxHeight:'80vh',
            borderRadius:'20px 20px 0 0',overflowY:'auto' as const,paddingBottom:32}}>
            <div style={{padding:'16px',borderBottom:'1px solid #e0e0e0',
              position:'sticky' as const,top:0,backgroundColor:'#fff'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{fontWeight:900,fontSize:16}}>Unpaid past bookings ({stale.length})</div>
                <button onClick={()=>{setOpen(false);onDone();}} aria-label="Close"
                  style={{background:'none',border:'none',fontSize:20,cursor:'pointer'}}>✕</button>
              </div>
              <div style={{fontSize:11.5,color:C.muted,marginBottom:8}}>Their time has passed and nothing was paid. Expiring frees the slots; the record stays.</div>
              {msg && <div style={{fontSize:12,fontWeight:700,color:msg.startsWith('Done')?'#16a34a':'#dc2626',marginBottom:6}}>{msg}</div>}
              {stale.length > 0 && (
                <button onClick={expireAll} disabled={loading}
                  style={{width:'100%',padding:9,borderRadius:8,border:'none',
                    backgroundColor:'#dc2626',color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer'}}>
                  Expire all {stale.length}
                </button>
              )}
            </div>
            <div style={{padding:'8px 16px'}}>
              {stale.length === 0 && !msg && (
                <div style={{textAlign:'center',padding:24,color:'#6b7280'}}>Nothing unpaid from the past 👍</div>
              )}
              {stale.map((b:any) => (
                <div key={b.booking_ref} style={{backgroundColor:'#fafafa',borderRadius:10,
                  padding:'10px 12px',marginBottom:8,border:'1px solid #e0e0e0',
                  display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:12,fontFamily:'monospace'}}>{b.booking_ref}</div>
                    <div style={{fontWeight:700,fontSize:13}}>{b.member_name}</div>
                    <div style={{fontSize:11,color:'#6b7280'}}>
                      {fmtDay(b.booking_date)} · {b.session_type==='day'?'Day':'Night'} · {fmtAmt(b.total_amount)}
                    </div>
                    {slotLines(b).map(l => <div key={l} style={{fontSize:10.5,color:'#6b7280'}}>{l}</div>)}
                  </div>
                  <button onClick={()=>expireOne(b.booking_ref)} disabled={expiring===b.booking_ref}
                    style={{padding:'7px 12px',borderRadius:8,border:'1px solid #d97706',flexShrink:0,
                      backgroundColor:'#fffbeb',color:'#d97706',fontWeight:700,fontSize:12,cursor:'pointer'}}>
                    {expiring===b.booking_ref ? '…' : 'Expire'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Today Tab ─────────────────────────────────────────────────────────
function TodayTab({ canManage }: { canManage: boolean }) {
  const navigate = useNavigate();
  const today = localIso();
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { const j = await netApi(`/bookings?booking_date=${today}&limit=200`); setBookings(j.data || []); }
    catch (e) { setErr(netMsg(e)); }
    finally { setLoading(false); }
  }, [today]);
  useEffect(() => { load(); }, [load]);

  const live      = bookings.filter(b => b.status === 'confirmed');
  const toCollect = live.filter(b => !isFree(b) && b.payment_status === 'pending');
  const collected = live.filter(b => b.payment_status === 'paid').reduce((a, b) => a + Number(b.amount_paid || b.total_amount || 0), 0);
  // Live bookings first, in start-time order; cancelled / expired at the bottom
  const ordered = [...bookings].sort((a, b) =>
    (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1) ||
    a.session_type.localeCompare(b.session_type) || firstSlotMinutes(a) - firstSlotMinutes(b));

  return (
    <div style={{ padding: '12px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 10 }}>
        {[
          { label: 'Bookings',   val: String(live.length),          color: '#16a34a' },
          { label: 'To collect', val: String(toCollect.length),     color: '#d97706' },
          { label: 'Collected',  val: fmtAmt(collected),            color: '#2563eb' },
        ].map(s => (
          <div key={s.label} style={{ backgroundColor: C.card, borderRadius: 10,
            padding: '10px 6px', textAlign: 'center', border: `1px solid ${C.border}` }}>
            <div style={{ fontWeight: 900, fontSize: 19, color: s.color }}>{s.val}</div>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        {canBookNets() ? (
          <button onClick={() => navigate('/nets-book')} style={{ padding: '8px 14px', borderRadius: 20, border: 'none',
            backgroundColor: C.navy, color: '#fff', fontWeight: 800, fontSize: 12.5, cursor: 'pointer' }}>➕ Book for someone</button>
        ) : <span/>}
        {canManage && <StaleBookingsPanel onDone={load}/>}
      </div>

      {err && <div style={{ backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, color: C.red, fontSize: 13, marginBottom: 10 }}>⚠ {err}</div>}
      {loading && <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>Loading…</div>}
      {!loading && !err && bookings.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>No bookings today</div>
      )}
      {ordered.map(b => <BookingCard key={b.id} b={b} canManage={canManage} onAction={load}/>)}
    </div>
  );
}

// ── Bookings Tab ──────────────────────────────────────────────────────
const PAGE = 30;
function BookingsTab({ canManage }: { canManage: boolean }) {
  const [bookings,  setBookings]  = useState<any[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [hasMore,   setHasMore]   = useState(false);
  const [err,       setErr]       = useState('');
  const [date,      setDate]      = useState('');
  const [status,    setStatus]    = useState('');
  const [payment,   setPayment]   = useState('');
  const [name,      setName]      = useState('');

  const load = useCallback(async (more = false) => {
    setLoading(true); setErr('');
    const p = new URLSearchParams();
    if (date)    p.set('booking_date', date);
    if (status)  p.set('status', status);
    if (payment) p.set('payment', payment);
    if (name.trim()) p.set('member_name', name.trim());
    p.set('limit', String(PAGE)); p.set('offset', String(more ? bookings.length : 0));
    try {
      const j = await netApi(`/bookings?${p}`);
      setBookings(prev => more ? [...prev, ...(j.data || [])] : (j.data || []));
      setHasMore(!!j.has_more);
    } catch (e) { setErr(netMsg(e)); }
    finally { setLoading(false); }
  }, [date, status, payment, name, bookings.length]);

  useEffect(() => { load(false); }, []); // eslint-disable-line

  const field: React.CSSProperties = { flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12, outline: 'none', backgroundColor: '#fff' };
  return (
    <div style={{ padding: '12px 0' }}>
      <div style={{ backgroundColor: C.card, borderRadius: 12, padding: 12, marginBottom: 12, border: `1px solid ${C.border}` }}>
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && load(false)}
          placeholder="Search name…" aria-label="Search name"
          style={{ ...field, width: '100%', boxSizing: 'border-box' as const, marginBottom: 8, fontSize: 13, padding: '8px 12px' }} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Date" style={field} />
          <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status" style={field}>
            <option value="">All status</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
          <select value={payment} onChange={e => setPayment(e.target.value)} aria-label="Payment" style={field}>
            <option value="">All payment</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="waived">Waived</option>
          </select>
        </div>
        <button onClick={() => load(false)} style={{ width: '100%', padding: '9px', borderRadius: 8,
          border: 'none', backgroundColor: C.navy, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          {loading ? 'Searching…' : '🔍 Search'}
        </button>
      </div>

      {err && <div style={{ backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, color: C.red, fontSize: 13, marginBottom: 10 }}>⚠ {err}</div>}
      {!loading && !err && bookings.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>No bookings found</div>
      )}
      {bookings.map(b => <BookingCard key={b.id} b={b} canManage={canManage} onAction={() => load(false)}/>)}
      {hasMore && (
        <button disabled={loading} onClick={() => load(true)} style={{ width: '100%', padding: 10, borderRadius: 10,
          border: `1px solid ${C.border}`, backgroundColor: '#fff', color: C.navy, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
          {loading ? 'Loading…' : 'Load more'}</button>
      )}
    </div>
  );
}

// ── Verify Tab ────────────────────────────────────────────────────────
function VerifyTab({ canManage }: { canManage: boolean }) {
  const [ref,     setRef]     = React.useState('');
  const [booking, setBooking] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [error,   setError]   = React.useState('');
  const [scanning,setScanning]= React.useState(false);

  const startScan = async () => {
    setError(''); setScanning(true);
    try {
      await BarcodeScanner.checkPermission({ force: true });
      BarcodeScanner.hideBackground();
      document.querySelector('body')?.classList.add('scanner-active');
      // Add QR targeting overlay
      const overlay = document.createElement('div');
      overlay.id = 'qr-overlay';
      overlay.innerHTML = `
        <style>
          #qr-overlay {
            position: fixed; inset: 0; z-index: 9999;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            background: transparent;
          }
          #qr-overlay .top-bar, #qr-overlay .bottom-bar {
            width: 100%; flex: 1;
            background: rgba(0,0,0,0.5);
          }
          #qr-overlay .middle-row {
            display: flex; width: 100%; height: 250px;
          }
          #qr-overlay .side-bar {
            flex: 1; background: rgba(0,0,0,0.5);
          }
          #qr-overlay .scan-box {
            width: 250px; height: 250px; position: relative;
            border: 2px solid rgba(255,255,255,0.5);
          }
          #qr-overlay .corner {
            position: absolute; width: 24px; height: 24px;
            border-color: #d4af37; border-style: solid;
          }
          #qr-overlay .corner.tl { top:0; left:0; border-width: 3px 0 0 3px; }
          #qr-overlay .corner.tr { top:0; right:0; border-width: 3px 3px 0 0; }
          #qr-overlay .corner.bl { bottom:0; left:0; border-width: 0 0 3px 3px; }
          #qr-overlay .corner.br { bottom:0; right:0; border-width: 0 3px 3px 0; }
          #qr-overlay .scan-line {
            position: absolute; left: 0; right: 0; height: 2px;
            background: #d4af37; animation: scan 2s linear infinite;
          }
          @keyframes scan { 0%{top:0} 50%{top:calc(100% - 2px)} 100%{top:0} }
          #qr-overlay .label {
            position: absolute; bottom: -36px; left: 0; right: 0;
            text-align: center; color: #fff; font-size: 14px;
            font-family: sans-serif; font-weight: 600;
          }
          #qr-overlay .cancel-btn {
            position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%);
            padding: 12px 32px; background: rgba(0,0,0,0.7);
            color: #fff; border: 1px solid rgba(255,255,255,0.4);
            border-radius: 24px; font-size: 15px; font-weight: 700;
            cursor: pointer; font-family: sans-serif;
          }
        </style>
        <div class="top-bar"></div>
        <div class="middle-row">
          <div class="side-bar"></div>
          <div class="scan-box">
            <div class="corner tl"></div>
            <div class="corner tr"></div>
            <div class="corner bl"></div>
            <div class="corner br"></div>
            <div class="scan-line"></div>
            <div class="label">Point at QR Code</div>
          </div>
          <div class="side-bar"></div>
        </div>
        <div class="bottom-bar"></div>
        <button class="cancel-btn" id="qr-cancel-btn">✕ Cancel</button>
      `;
      document.body.appendChild(overlay);
      document.getElementById('qr-cancel-btn')?.addEventListener('click', async () => {
        await BarcodeScanner.stopScan();
        document.getElementById('qr-overlay')?.remove();
        document.querySelector('body')?.classList.remove('scanner-active');
        BarcodeScanner.showBackground();
        setScanning(false);
      });
      const result = await BarcodeScanner.startScan();
      document.getElementById('qr-overlay')?.remove();
      document.querySelector('body')?.classList.remove('scanner-active');
      BarcodeScanner.showBackground();
      if (result.hasContent) {
        const raw = result.content || '';
        // Try regex on full content
        const m1 = raw.match(/QCA[A-Z]-[A-Z0-9]{4,}/i);
        // Try last URL path segment
        const seg = raw.replace(/\/+$/, '').split('/').pop() || '';
        const m2  = seg.match(/^QCA[A-Z]-[A-Z0-9]{4,}$/i);
        const found = (m1?.[0] || m2?.[0] || '').toUpperCase();
        if (found) { setRef(found); await lookupRef(found); }
        else setError("That QR code isn't a net booking ticket. Type the reference instead.");
      }
    } catch {
      document.getElementById('qr-overlay')?.remove();
      document.querySelector('body')?.classList.remove('scanner-active');
      BarcodeScanner.showBackground();
      setError('Scanner error — type the reference instead');
    } finally { setScanning(false); }
  };

  const stopScan = async () => {
    await BarcodeScanner.stopScan();
    document.querySelector('body')?.classList.remove('scanner-active');
    BarcodeScanner.showBackground();
    setScanning(false);
  };

  const lookupRef = async (r: string) => {
    const target = (r || ref).trim().toUpperCase();
    if (!target) return;
    setLoading(true); setError(''); setBooking(null);
    try { const j = await netApi(`/bookings/${encodeURIComponent(target)}`); setBooking(j.data); }
    catch (e) { setError(/not found/i.test((e as any)?.message || '') ? `No booking ${target}` : netMsg(e)); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ padding: '12px 0' }}>
      {scanning ? (
        <div style={{textAlign:'center',padding:32}}>
          <div style={{fontSize:48,marginBottom:12}}>📷</div>
          <div style={{fontWeight:700,fontSize:15,marginBottom:16}}>Point camera at QR code</div>
          <button onClick={stopScan}
            style={{padding:'10px 24px',borderRadius:10,border:'none',
              backgroundColor:'#dc2626',color:'#fff',fontWeight:700,cursor:'pointer'}}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button onClick={startScan}
            style={{width:'100%',padding:14,borderRadius:12,border:'none',
              background:'linear-gradient(135deg,#1a472a,#2d6a4f)',
              color:'#fff',fontWeight:800,fontSize:15,cursor:'pointer',marginBottom:12}}>
            📷 Scan QR Code
          </button>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input value={ref} onChange={e => setRef(e.target.value.toUpperCase())}
              placeholder="QCAN-XXXXXX" aria-label="Booking reference"
              onKeyDown={e => e.key === 'Enter' && lookupRef('')}
              style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 10,
                border: '1px solid #e0e0e0', fontSize: 14, outline: 'none',
                fontFamily: 'monospace' }}/>
            <button onClick={() => lookupRef('')} disabled={loading}
              style={{ padding: '10px 18px', borderRadius: 10, border: 'none',
                backgroundColor: '#0d1b2a', color: '#fff', fontWeight: 800,
                fontSize: 14, cursor: 'pointer' }}>
              {loading ? '…' : 'Go'}
            </button>
          </div>
        </>
      )}

      {error && <div style={{ backgroundColor: '#fef2f2', borderRadius: 10, padding: 12,
        color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {booking && (<>
        <BookingCard b={booking} canManage={canManage} highlight onAction={() => lookupRef(booking.booking_ref)}/>
        <button onClick={()=>{setBooking(null);setRef('');}}
          style={{width:'100%',padding:10,borderRadius:10,
            border:'1px solid #e0e0e0',backgroundColor:'#f8fafc',
            color:'#6b7280',fontWeight:700,fontSize:13,cursor:'pointer'}}>
          Clear
        </button>
      </>)}
    </div>
  );
}


// ── Main Screen ───────────────────────────────────────────────────────
type Tab = 'today' | 'bookings' | 'verify';

export default function NetsStaffScreen() {
  const { can }     = usePermissions();
  const isAdmin     = (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
  const canView     = isAdmin || can('nets:view' as any);
  const canManage   = isAdmin || can('nets:manage' as any);
  const [tab, setTab] = useState<Tab>('today');

  if (!canView) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: C.muted }}>
        You don't have permission to view net bookings.
      </div>
    );
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'today',    label: '📅 Today'    },
    { id: 'bookings', label: '📋 Bookings' },
    { id: 'verify',   label: '✅ Verify'   },
  ];

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 48 }}>
      <ScreenHeader title="🏏 Net Dashboard" background="#0d1b2a">
        <HeaderTabs tabs={TABS} value={tab} onChange={setTab} color="#0d1b2a" />
      </ScreenHeader>

      <div style={{ padding: '0 16px' }}>
        {tab === 'today'    && <TodayTab canManage={canManage}/>}
        {tab === 'bookings' && <BookingsTab canManage={canManage}/>}
        {tab === 'verify'   && <VerifyTab canManage={canManage}/>}
      </div>
    </div>
  );
}
