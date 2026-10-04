/**
 * nets_staff.tsx — Net Booking: Staff / Coach View
 * Permissions: nets:view (list/calendar), nets:manage (mark paid/cancel)
 *
 * Tabs:
 *   Today     — today's bookings for quick ground-level ops
 *   Bookings  — full list with filters
 *   Verify    — enter booking ref → show detail → mark paid / cancel
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { BarcodeScanner } from '@capacitor-community/barcode-scanner';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';

const NET_NAMES: Record<string,string> = {
  syn1: 'Synthetic Turf 1',
  syn2: 'Synthetic Turf 2',
  con:  'Concrete Wicket',
  mat:  'Matting Wicket',
};

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

function bld() {
  const ip = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
  return ip.startsWith('http') ? ip : `http://${ip}`;
}
function hdr() {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) {
      // Token expired - trigger auto logout
      window.dispatchEvent(new Event('jwt-expired'));
      return {};
    }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return {
    'Content-Type': 'application/json',
    'X-Username':   localStorage.getItem('auth_user') ?? '',
    'X-Password':   localStorage.getItem('auth_pass') ?? '',
  };
}
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

function BookingCard({ b, onAction }: { b: any; onAction: () => void }) {
  const base = bld();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const action = async (endpoint: string, label: string) => {
    if (!confirm(`${label} booking ${b.booking_ref}?`)) return;
    setLoading(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets${endpoint}`, { method: 'POST', headers: hdr() });
      const j = await r.json();
      if (r.ok) { setMsg('✓ Done'); onAction(); }
      else setMsg(j.error || 'Error');
    } catch { setMsg('Network error'); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      backgroundColor: C.card, borderRadius: 12, padding: '12px 14px',
      marginBottom: 8, border: `1px solid ${C.border}`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 900, fontSize: 13, color: C.navy,
              fontFamily: 'monospace' }}>{b.booking_ref}</span>
            <Badge label={b.status}  color={STATUS_COLOR[b.status]  || C.muted} />
            <Badge label={b.payment_status} color={PAY_COLOR[b.payment_status] || C.muted} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#111' }}>{b.member_name || '—'}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            📞 {b.mobile || '—'} · {b.booking_date} · {b.session_type === 'day' ? '☀️ Day' : '🌙 Night'}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            🏏 {b.slot_count} slot{b.slot_count !== 1 ? 's' : ''} · Rs.{b.total_amount || b.amount_due || 0}
          </div>
        </div>
      </div>
      {msg && <div style={{ fontSize: 12, color: msg.startsWith('✓') ? '#16a34a' : C.red,
        marginTop: 6 }}>{msg}</div>}
      {b.status === 'confirmed' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {b.payment_status !== 'paid' && (
            <button onClick={() => action(`/bookings/${b.booking_ref}/paid`, 'Mark paid')}
              disabled={loading}
              style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none',
                backgroundColor: '#16a34a', color: '#fff', fontWeight: 700,
                fontSize: 12, cursor: 'pointer' }}>
              💵 Mark Paid
            </button>
          )}
          <button onClick={() => action(`/bookings/${b.booking_ref}/cancel`, 'Cancel')}
            disabled={loading}
            style={{ flex: 1, padding: '8px', borderRadius: 8,
              border: `1px solid ${C.red}`, backgroundColor: '#fff',
              color: C.red, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            ✕ Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Today Tab ─────────────────────────────────────────────────────────

// ── Stale Bookings Panel ─────────────────────────────────────────────
function StaleBookingsPanel({ base, onDone }: { base: string; onDone: ()=>void }) {
  const [open,    setOpen]    = React.useState(false);
  const [stale,   setStale]   = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expiring,setExpiring]= React.useState<string|null>(null);
  const [msg,     setMsg]     = React.useState('');

  const loadStale = async () => {
    setLoading(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/bookings/stale`, { headers: hdr() });
      const j = await r.json();
      setStale(j.data || []);
      setOpen(true);
    } catch { setMsg('Failed to load'); }
    finally { setLoading(false); }
  };

  const expireOne = async (ref: string) => {
    if (!confirm(`Expire booking ${ref}?`)) return;
    setExpiring(ref);
    try {
      const r = await fetch(`${base}/api/data/nets/bookings/${ref}/expire`, {
        method: 'POST', headers: hdr()
      });
      if (r.ok) { setStale(prev => prev.filter(b => b.booking_ref !== ref)); setMsg(`Done: ${ref} expired`); }
    } catch { setMsg('Error'); }
    finally { setExpiring(null); }
  };

  const expireAll = async () => {
    if (!confirm(`Expire ALL ${stale.length} stale bookings?`)) return;
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/nets/bookings/expire-stale`, { method: 'POST', headers: hdr() });
      const j = await r.json();
      setMsg(`Done: ${j.expired || 0} bookings expired`);
      setStale([]); onDone();
    } catch { setMsg('Error'); }
    finally { setLoading(false); }
  };

  return (
    <>
      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:8}}>
        <button onClick={loadStale} disabled={loading}
          style={{padding:'6px 14px',borderRadius:20,border:'1px solid #d97706',
            backgroundColor:'#fffbeb',color:'#d97706',fontSize:11,fontWeight:700,cursor:'pointer'}}>
          {loading ? 'Loading...' : 'Stale Bookings'}
        </button>
      </div>
      {open && (
        <div style={{position:'fixed' as const,inset:0,zIndex:200,backgroundColor:'rgba(0,0,0,0.6)',
          display:'flex',alignItems:'flex-end' as const}}>
          <div style={{backgroundColor:'#fff',width:'100%',maxHeight:'80vh',
            borderRadius:'20px 20px 0 0',overflowY:'auto' as const,paddingBottom:32}}>
            <div style={{padding:'16px',borderBottom:'1px solid #e0e0e0',
              position:'sticky' as const,top:0,backgroundColor:'#fff'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{fontWeight:900,fontSize:16}}>Stale Bookings ({stale.length})</div>
                <button onClick={()=>{setOpen(false);onDone();}}
                  style={{background:'none',border:'none',fontSize:20,cursor:'pointer'}}>x</button>
              </div>
              {msg && <div style={{fontSize:12,color:msg.startsWith('Done')?'#16a34a':'#dc2626',marginBottom:6}}>{msg}</div>}
              {stale.length > 0 && (
                <button onClick={expireAll} disabled={loading}
                  style={{width:'100%',padding:9,borderRadius:8,border:'none',
                    backgroundColor:'#dc2626',color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer'}}>
                  Expire All {stale.length} Bookings
                </button>
              )}
            </div>
            <div style={{padding:'8px 16px'}}>
              {stale.length === 0 && !msg && (
                <div style={{textAlign:'center',padding:24,color:'#6b7280'}}>No stale bookings</div>
              )}
              {stale.map((b:any) => (
                <div key={b.booking_ref} style={{backgroundColor:'#fafafa',borderRadius:10,
                  padding:'10px 12px',marginBottom:8,border:'1px solid #e0e0e0',
                  display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:12,fontFamily:'monospace'}}>{b.booking_ref}</div>
                    <div style={{fontWeight:600,fontSize:13}}>{b.member_name}</div>
                    <div style={{fontSize:11,color:'#6b7280'}}>
                      {b.booking_date} · {b.session_type==='day'?'Day':'Night'} · Rs.{b.total_amount||0}
                    </div>
                    {b.nets_booked && Object.entries(b.nets_booked).map(([net,slots]:any)=>(
                      <div key={net} style={{fontSize:10,color:'#6b7280'}}>
                        {NET_NAMES[net]||net}: {Array.isArray(slots)?slots.join(', '):slots}
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>expireOne(b.booking_ref)}
                    disabled={expiring===b.booking_ref}
                    style={{padding:'7px 12px',borderRadius:8,border:'1px solid #d97706',
                      backgroundColor:'#fffbeb',color:'#d97706',fontWeight:700,fontSize:12,cursor:'pointer'}}>
                    {expiring===b.booking_ref ? '...' : 'Expire'}
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

function TodayTab({ canManage }: { canManage: boolean }) {
  const base = bld();
  const today = new Date().toISOString().slice(0, 10);
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/nets/bookings?booking_date=${today}`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setBookings(j.data);
    } catch {} finally { setLoading(false); }
  }, [base, today]);

  useEffect(() => { load(); }, []);

  const confirmed = bookings.filter(b => b.status === 'confirmed');
  const paid      = confirmed.filter(b => b.payment_status === 'paid');
  const pending   = confirmed.filter(b => b.payment_status === 'pending');

  return (
    <div style={{ padding: '12px 0' }}>
      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'Confirmed', val: confirmed.length, color: '#16a34a' },
          { label: 'Paid',      val: paid.length,      color: '#2563eb' },
          { label: 'Pending',   val: pending.length,   color: '#d97706' },
        ].map(s => (
          <div key={s.label} style={{ backgroundColor: C.card, borderRadius: 10,
            padding: '10px 8px', textAlign: 'center', border: `1px solid ${C.border}` }}>
            <div style={{ fontWeight: 900, fontSize: 22, color: s.color }}>{s.val}</div>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Stale Bookings Panel */}
      <StaleBookingsPanel base={base} onDone={load}/>

      {loading && <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>Loading…</div>}
      {!loading && bookings.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>No bookings today</div>
      )}
      {bookings.map(b => (
        <BookingCard key={b.id} b={b} onAction={load}/>
      ))}
    </div>
  );
}

// ── Bookings Tab ──────────────────────────────────────────────────────
function BookingsTab() {
  const base = bld();
  const [bookings,  setBookings]  = useState<any[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [date,      setDate]      = useState('');
  const [status,    setStatus]    = useState('');
  const [payment,   setPayment]   = useState('');
  const [name,      setName]      = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (date)    p.set('booking_date', date);
    if (status)  p.set('status', status);
    if (payment) p.set('payment', payment);
    if (name)    p.set('member_name', name);
    try {
      const r = await fetch(`${base}/api/data/nets/bookings?${p}`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setBookings(j.data);
    } catch {} finally { setLoading(false); }
  }, [base, date, status, payment, name]);

  useEffect(() => { load(); }, []);

  return (
    <div style={{ padding: '12px 0' }}>
      {/* Filters */}
      <div style={{ backgroundColor: C.card, borderRadius: 12, padding: 12,
        marginBottom: 12, border: `1px solid ${C.border}` }}>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="Search member name…"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, marginBottom: 8,
            border: `1px solid ${C.border}`, fontSize: 13, outline: 'none',
            boxSizing: 'border-box' as const }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 8,
              border: `1px solid ${C.border}`, fontSize: 12, outline: 'none' }} />
          <select value={status} onChange={e => setStatus(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 8,
              border: `1px solid ${C.border}`, fontSize: 12, outline: 'none' }}>
            <option value="">All Status</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
          <select value={payment} onChange={e => setPayment(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 8,
              border: `1px solid ${C.border}`, fontSize: 12, outline: 'none' }}>
            <option value="">All Payment</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="waived">Waived</option>
          </select>
        </div>
        <button onClick={load} style={{ width: '100%', padding: '9px', borderRadius: 8,
          border: 'none', backgroundColor: C.navy, color: '#fff', fontWeight: 700,
          fontSize: 13, cursor: 'pointer' }}>
          {loading ? 'Searching…' : '🔍 Search'}
        </button>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>Loading…</div>}
      {!loading && bookings.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>No bookings found</div>
      )}
      {bookings.map(b => <BookingCard key={b.id} b={b} onAction={load}/>)}
    </div>
  );
}

// ── Verify Tab ────────────────────────────────────────────────────────
function VerifyTab() {
  const base = bld();
  const [ref,     setRef]     = React.useState('');
  const [booking, setBooking] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [error,   setError]   = React.useState('');
  const [msg,     setMsg]     = React.useState('');
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
        const ref = (m1?.[0] || m2?.[0] || '').toUpperCase();
        if (ref) { setRef(ref); await lookupRef(ref); }
        else { setError('RAW: ' + raw); }
      }
    } catch {
      document.querySelector('body')?.classList.remove('scanner-active');
      BarcodeScanner.showBackground();
      setError('Scanner error - try manual entry');
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
    setLoading(true); setError(''); setBooking(null); setMsg('');
    try {
      const res = await fetch(`${base}/api/data/nets/bookings/${target}`, { headers: hdr() });
      const j = await res.json();
      if (res.ok && j.data) setBooking(j.data);
      else setError(j.error || 'Booking not found');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  };

  const action = async (endpoint: string, label: string) => {
    if (!confirm(label + '?')) return;
    setLoading(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets${endpoint}`, { method: 'POST', headers: hdr() });
      const j = await r.json();
      if (r.ok) {
        setMsg('Done: ' + label);
        const r2 = await fetch(`${base}/api/data/nets/bookings/${booking.booking_ref}`, { headers: hdr() });
        const j2 = await r2.json();
        if (j2.data) setBooking(j2.data);
      } else setMsg(j.error || 'Error');
    } catch { setMsg('Network error'); }
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
              placeholder="QCAD-XXXXXX"
              onKeyDown={e => e.key === 'Enter' && lookupRef('')}
              style={{ flex: 1, padding: '10px 12px', borderRadius: 10,
                border: '1px solid #e0e0e0', fontSize: 14, outline: 'none',
                fontFamily: 'monospace' }}/>
            <button onClick={() => lookupRef('')} disabled={loading}
              style={{ padding: '10px 18px', borderRadius: 10, border: 'none',
                backgroundColor: '#0d1b2a', color: '#fff', fontWeight: 800,
                fontSize: 14, cursor: 'pointer' }}>
              {loading ? '...' : 'Go'}
            </button>
          </div>
        </>
      )}

      {error && <div style={{ backgroundColor: '#fef2f2', borderRadius: 10, padding: 12,
        color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {booking && (
        <div style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16,
          border: '2px solid ' + (STATUS_COLOR[booking.status] || '#e0e0e0') }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontWeight: 900, fontSize: 15, fontFamily: 'monospace',
              color: '#0d1b2a' }}>{booking.booking_ref}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Badge label={booking.status} color={STATUS_COLOR[booking.status] || '#6b7280'}/>
              <Badge label={booking.payment_status} color={PAY_COLOR[booking.payment_status] || '#6b7280'}/>
            </div>
          </div>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{booking.member_name}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {booking.mobile} · {booking.booking_date} · {booking.session_type}
          </div>
          <div style={{ fontWeight: 800, fontSize: 18, color: '#0d1b2a', marginTop: 8 }}>
            Rs. {booking.total_amount || 0}
          </div>
          {booking.nets_booked && Object.entries(booking.nets_booked).map(([net,slots]:any) => (
            <div key={net} style={{fontSize:11,color:'#6b7280'}}>
              🏏 {NET_NAMES[net]||net}: {Array.isArray(slots)?slots.join(', '):slots}
            </div>
          ))}
          {msg && <div style={{ fontSize: 13, color: msg.startsWith('Done') ? '#16a34a' : '#dc2626',
            marginTop: 8, fontWeight: 600 }}>{msg}</div>}
          {booking.status === 'confirmed' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {booking.payment_status !== 'paid' && (
                <button onClick={() => action('/bookings/' + booking.booking_ref + '/paid', 'Mark Paid')}
                  disabled={loading}
                  style={{ flex: 1, padding: 11, borderRadius: 10, border: 'none',
                    backgroundColor: '#16a34a', color: '#fff', fontWeight: 800,
                    fontSize: 14, cursor: 'pointer' }}>
                  Mark Paid
                </button>
              )}
              <button onClick={() => action('/bookings/' + booking.booking_ref + '/cancel', 'Cancel')}
                disabled={loading}
                style={{ flex: 1, padding: 11, borderRadius: 10,
                  border: '2px solid #dc2626', backgroundColor: '#fff',
                  color: '#dc2626', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )}
          <button onClick={()=>{setBooking(null);setRef('');setMsg('');}}
            style={{width:'100%',padding:10,borderRadius:10,marginTop:10,
              border:'1px solid #e0e0e0',backgroundColor:'#f8fafc',
              color:'#6b7280',fontWeight:700,fontSize:13,cursor:'pointer'}}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}


// ── Main Screen ───────────────────────────────────────────────────────
type Tab = 'today' | 'bookings' | 'verify';

export default function NetsStaffScreen() {
  const navigate    = useNavigate();
  const { can }     = usePermissions();
  const canView     = can('nets:view' as any);
  const canManage   = can('nets:manage' as any);
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
        {tab === 'bookings' && <BookingsTab/>}
        {tab === 'verify'   && <VerifyTab/>}
      </div>
    </div>
  );
}
