/**
 * nets_book.tsx — Book a net for someone (staff), like the web's Admin → Book.
 *
 *   1. Who:   search net members and academy users (student / parent / coach / club member),
 *             or enter a new walk-in (name + mobile; becomes a net member)
 *   2. When:  any date (staff may record past / earlier-today bookings) and Day / Night
 *   3. Slots: tap hours on each net; taken and maintenance-blocked slots are disabled
 *   4. Price: worked out by the server exactly as the booking will be (student concession,
 *             bundles, pass credit); can be changed with a reason
 *   5. Done:  booking is confirmed with payment pending → Mark paid / Share on WhatsApp
 *
 * Data: /api/data/nets/book/* (routes/api_nets.py). Access: admins, or roles with the
 * `nets:book` permission; Mark paid additionally needs `nets:manage`.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ScreenHeader from '../shared/ScreenHeader';
import { apiAuthHeaders } from './apiHeaders';
import { can } from './usePermissions';
import { localIso, defaultSession } from './nets_util';
import { useUnsavedChanges } from '../shared/backNav';

const C = { navy:'#0d1b2a', green:'#1a472a', gold:'#d4af37', bg:'#f0f2f5', border:'#e5e7eb', muted:'#6b7280', text:'#111827',
  good:'#16a34a', bad:'#dc2626', warn:'#d97706' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, padding:12 };
const INPUT: React.CSSProperties = { width:'100%', boxSizing:'border-box', padding:'9px 11px', borderRadius:9, border:`1px solid ${C.border}`,
  fontSize:14, outline:'none', backgroundColor:'#fff', fontFamily:'inherit' };
const ROLE_LABEL: Record<string,string> = { Student:'Student', Parent:'Parent', Coach:'Coach', Members:'Club member' };

const base = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
const isAdmin = () => (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
export const canBookNets = () => isAdmin() || can('nets:book');
const todayIso = () => localIso();
const fmtAmt = (n:any) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fmtDate = (d:string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });

async function api(path:string, body?:any) {
  const r = await fetch(`${base()}/api/data/nets${path}`, body === undefined
    ? { headers: apiAuthHeaders(false) }
    : { method:'POST', headers: { ...apiAuthHeaders(false), 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 403 ? "You don't have permission to book nets for someone"
    : r.status === 404 || r.status === 405 ? 'This server does not have booking from the app yet — update the server'
    : (j.error || j.detail || `Server error ${r.status}`));
  return j;
}
const netMsg = (e:any) => /failed to fetch/i.test(e?.message || '') ? 'Cannot reach the server' : e?.message || 'Something went wrong';
function openUrl(url:string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
const Step = ({ n, title, children }: { n:number; title:string; children:React.ReactNode }) => (
  <div style={{ ...CARD, display:'flex', flexDirection:'column', gap:9 }}>
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <span style={{ width:22, height:22, borderRadius:'50%', backgroundColor:C.navy, color:'#fff', fontSize:12, fontWeight:900,
        display:'flex', alignItems:'center', justifyContent:'center' }}>{n}</span>
      <span style={{ fontWeight:900, fontSize:14, color:C.text }}>{title}</span>
    </div>
    {children}
  </div>
);
const pill = (on:boolean): React.CSSProperties => ({ padding:'7px 13px', borderRadius:18, cursor:'pointer', fontSize:13, fontWeight:800,
  border:`1px solid ${on ? C.navy : C.border}`, backgroundColor: on ? C.navy : '#fff', color: on ? '#fff' : '#374151' });

export default function NetsBookScreen() {
  const nav = useNavigate();
  // Opened from a tapped calendar slot: ?date=&session=&net=&hour=
  const [params] = useSearchParams();
  const pre = { date: params.get('date') || '', session: params.get('session') || '', net: params.get('net') || '', hour: Number(params.get('hour')) };
  const [preApplied, setPreApplied] = useState(false);
  // 1. who
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [who, setWho] = useState<any>(null);            // {kind:'member'|'portal', id, name, mobile, code, role}
  const [isNew, setIsNew] = useState(false);
  const [nw, setNw] = useState({ name:'', mobile:'', email:'', address:'' });
  // 2–3. when + slots
  const [date, setDate] = useState(/^\d{4}-\d{2}-\d{2}$/.test(pre.date) ? pre.date : todayIso());
  const [session, setSession] = useState<'day'|'night'>(pre.session === 'day' || pre.session === 'night' ? pre.session : defaultSession());
  const [av, setAv] = useState<any>(null);
  const [avErr, setAvErr] = useState('');
  const [sel, setSel] = useState<Record<string, number[]>>({});
  // 4. price
  const [price, setPrice] = useState<any>(null);
  const [override, setOverride] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  // 5. save
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<any>(null);
  const [paid, setPaid] = useState(false);
  // half-made booking (person or slots chosen, not yet booked): ask before leaving
  useUnsavedChanges(!done && !busy && (!!who || (isNew && !!nw.name.trim()) || Object.values(sel).some(h => h.length > 0)),
    { message: 'This booking has not been made yet.' });

  // search people (debounced)
  useEffect(() => {
    if (who || isNew || q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => api(`/book/search?q=${encodeURIComponent(q.trim())}`).then(j => setResults(j.results || [])).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q, who, isNew]);

  // availability for the date + session; clear the slot choice when it changes
  const loadAv = () => {
    setAv(null); setAvErr(''); setSel({});
    api(`/book/availability?booking_date=${date}&session_type=${session}`).then(j => {
      setAv(j);
      // pre-select the tapped slot once, if it's still free
      if (!preApplied && pre.net && j.slots?.includes(pre.hour) && !(j.taken?.[pre.net] || []).includes(pre.hour)
          && !(j.blocked_nets || []).includes(pre.net)) setSel({ [pre.net]: [pre.hour] });
      setPreApplied(true);
    }).catch(e => setAvErr(netMsg(e)));
  };
  useEffect(loadAv, [date, session]); // eslint-disable-line

  const kind = isNew ? 'new_member' : who?.kind;
  const slotCount = Object.values(sel).reduce((a, h) => a + h.length, 0);
  // server price for this person + selection
  useEffect(() => {
    setPrice(null);
    if (!slotCount) return;
    const t = setTimeout(() => api('/book/price', { booker_kind: kind || 'new_member', booker_id: who?.id, booking_date: date, session_type: session, selection: sel })
      .then(setPrice).catch(() => setPrice(null)), 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(sel), kind, who?.id]); // eslint-disable-line

  const toggle = (net:string, h:number) => setSel(s => {
    const cur = new Set(s[net] || []); cur.has(h) ? cur.delete(h) : cur.add(h);
    const next = { ...s, [net]: [...cur].sort((a, b) => a - b) }; if (!next[net].length) delete next[net]; return next;
  });

  const ready = (who || (isNew && nw.name.trim() && nw.mobile.replace(/\D/g, '').length >= 10)) && slotCount > 0
    && (!override || (amount.trim() !== '' && note.trim()));
  const book = () => {
    setErr('');
    if (!who && !isNew) { setErr('Choose who the booking is for'); return; }
    if (isNew && (!nw.name.trim() || nw.mobile.replace(/\D/g, '').length < 10)) { setErr("Enter the person's name and a 10-digit mobile"); return; }
    if (!slotCount) { setErr('Pick at least one slot'); return; }
    if (override && (amount.trim() === '' || !note.trim())) { setErr('Enter the new price and a reason'); return; }
    setBusy(true);
    api('/book', {
      booker_kind: kind, booker_id: who?.id,
      new_name: nw.name.trim(), new_mobile: nw.mobile.trim(), new_email: nw.email.trim(), new_address: nw.address.trim(),
      booking_date: date, session_type: session, selection: sel,
      override_amount: override ? amount.trim() : '', price_note: override ? note.trim() : '',
    }).then(j => { setDone(j); setPaid(false); })
      .catch(e => { setErr(netMsg(e)); if (/just booked/.test(e.message)) loadAv(); })
      .finally(() => setBusy(false));
  };
  const markPaid = () => {
    setBusy(true);
    api(`/bookings/${done.booking_ref}/paid`, {}).then(() => setPaid(true)).catch(e => setErr(netMsg(e))).finally(() => setBusy(false));
  };
  const reset = () => { setDone(null); setWho(null); setIsNew(false); setQ(''); setNw({ name:'', mobile:'', email:'', address:'' });
    setOverride(false); setAmount(''); setNote(''); setErr(''); loadAv(); };

  const nets: [string, string][] = useMemo(() => Object.entries(av?.nets || {}), [av]);
  if (!canBookNets()) return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh' }}><ScreenHeader title="Book for someone" background={C.navy}/>
      <div style={{ padding:12 }}><div style={{ ...CARD, textAlign:'center', color:C.muted, fontSize:13 }}>
        🔒 You don't have permission to book nets for someone. Ask an admin for “Book nets for someone”.</div></div></div>
  );

  // ── Confirmation ──
  if (done) {
    const b = done.booking || {};
    const mobile = String(b.mobile || nw.mobile || who?.mobile || '').replace(/\D/g, '');
    const lines = Object.entries(b.nets_booked || {}).map(([n, hrs]:any) => `${av?.nets?.[n] || n}: ${hrs.join(', ')}`);
    const msg = `Quickies Cricket Academy — net booking confirmed\nRef: ${done.booking_ref}\n${fmtDate(String(b.booking_date || date).slice(0, 10))} · ${session === 'day' ? 'Day' : 'Night'}\n` +
      `${lines.join('\n')}\nAmount: ${fmtAmt(b.total_amount)}${paid ? ' (paid)' : ' (to pay at the desk)'}\nPlease show this reference at the nets.`;
    const wa = mobile.length >= 10 ? `https://wa.me/${mobile.length === 10 ? `91${mobile}` : mobile}?text=${encodeURIComponent(msg)}` : '';
    return (
      <div style={{ backgroundColor:C.bg, minHeight:'100vh', paddingBottom:90 }}>
        <ScreenHeader title="Booking confirmed" subtitle={done.booking_ref} background={C.navy}/>
        <div style={{ padding:12, display:'flex', flexDirection:'column', gap:10 }}>
          <div style={{ ...CARD, borderColor:C.good }}>
            <div style={{ fontSize:13, color:C.good, fontWeight:900 }}>✓ Booked for {b.member_name || who?.name || nw.name}</div>
            <div style={{ fontSize:22, fontWeight:900, color:C.navy, marginTop:4, letterSpacing:'0.04em' }}>{done.booking_ref}</div>
            <div style={{ fontSize:13, color:C.text, marginTop:6 }}>{fmtDate(String(b.booking_date || date).slice(0, 10))} · {session === 'day' ? '☀️ Day' : '🌙 Night'}</div>
            {lines.map(l => <div key={l} style={{ fontSize:13, color:C.text }}>{l}</div>)}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
              <span style={{ fontSize:20, fontWeight:900 }}>{fmtAmt(b.total_amount)}</span>
              <span style={{ fontSize:11, fontWeight:900, padding:'2px 8px', borderRadius:7, color: paid ? C.good : C.warn,
                backgroundColor: paid ? '#dcfce7' : '#fef3c7' }}>{paid ? 'PAID' : 'PAYMENT PENDING'}</span>
            </div>
            {b.price_override_reason && <div style={{ fontSize:11.5, color:C.muted, marginTop:4 }}>Price changed: {b.price_override_reason}</div>}
          </div>
          {err && <div style={{ color:C.bad, fontSize:13, fontWeight:700 }}>⚠ {err}</div>}
          {!paid && (isAdmin() || can('nets:manage')) && Number(b.total_amount) > 0 && (
            <button disabled={busy} onClick={markPaid} style={{ padding:12, borderRadius:11, border:'none', backgroundColor:C.green, color:'#fff', fontWeight:900, fontSize:14.5, cursor:'pointer' }}>
              {busy ? 'Saving…' : `💵 Mark ${fmtAmt(b.total_amount)} paid`}</button>
          )}
          {wa && <button onClick={() => openUrl(wa)} style={{ padding:12, borderRadius:11, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:900, fontSize:14.5, cursor:'pointer' }}>💬 Share on WhatsApp</button>}
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={reset} style={{ flex:1, padding:11, borderRadius:11, border:`1px solid ${C.navy}`, backgroundColor:'#fff', color:C.navy, fontWeight:800, cursor:'pointer' }}>Book another</button>
            <button onClick={() => nav('/nets')} style={{ flex:1, padding:11, borderRadius:11, border:'none', backgroundColor:C.navy, color:'#fff', fontWeight:800, cursor:'pointer' }}>Net Dashboard</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh', paddingBottom:110 }}>
      <ScreenHeader title="Book for someone" subtitle="Member, academy user or walk-in" background={C.navy}/>
      <div style={{ padding:12, display:'flex', flexDirection:'column', gap:10 }}>
        {/* 1. Who */}
        <Step n={1} title="Who is it for?">
          {who ? (
            <div style={{ display:'flex', alignItems:'center', gap:10, backgroundColor:'#f8fafc', borderRadius:10, padding:'8px 10px' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:900, fontSize:14 }}>{who.name}</div>
                <div style={{ fontSize:11.5, color:C.muted }}>{[who.kind === 'member' ? 'Net member' : ROLE_LABEL[who.role] || who.role, who.code, who.mobile].filter(Boolean).join(' · ')}</div>
              </div>
              <button onClick={() => { setWho(null); setQ(''); }} style={{ background:'none', border:'none', color:C.navy, fontWeight:800, fontSize:12.5, cursor:'pointer' }}>Change</button>
            </div>
          ) : isNew ? (
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              <input value={nw.name} onChange={e => setNw({ ...nw, name:e.target.value })} placeholder="Name *" aria-label="Name" style={INPUT}/>
              <input value={nw.mobile} onChange={e => setNw({ ...nw, mobile:e.target.value })} type="tel" inputMode="tel" placeholder="Mobile *" aria-label="Mobile" style={INPUT}/>
              <input value={nw.email} onChange={e => setNw({ ...nw, email:e.target.value })} type="email" placeholder="Email (optional)" aria-label="Email" style={INPUT}/>
              <input value={nw.address} onChange={e => setNw({ ...nw, address:e.target.value })} placeholder="Address (optional)" aria-label="Address" style={INPUT}/>
              <div style={{ fontSize:11, color:C.muted }}>They become a net member. If the mobile is already registered, the booking goes to that member.</div>
              <button onClick={() => setIsNew(false)} style={{ alignSelf:'flex-start', background:'none', border:'none', color:C.navy, fontWeight:800, fontSize:12.5, cursor:'pointer', padding:0 }}>← Search instead</button>
            </div>
          ) : (<>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Name, mobile, member code or login" aria-label="Search people" style={INPUT}/>
            {results.length > 0 && (
              <div style={{ border:`1px solid ${C.border}`, borderRadius:10, overflow:'hidden' }}>
                {results.map((r, i) => (
                  <button key={`${r.kind}-${r.id}`} onClick={() => { setWho(r); setResults([]); }}
                    style={{ width:'100%', textAlign:'left', display:'flex', alignItems:'center', gap:8, padding:'9px 11px', background:'#fff', border:'none',
                      borderTop: i ? `1px solid ${C.border}` : 'none', cursor:'pointer' }}>
                    <span style={{ flex:1, minWidth:0 }}>
                      <span style={{ display:'block', fontWeight:800, fontSize:13.5, color:C.text }}>{r.name}</span>
                      <span style={{ fontSize:11, color:C.muted }}>{[r.code, r.mobile].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span style={{ fontSize:10, fontWeight:900, padding:'2px 7px', borderRadius:6, flexShrink:0,
                      color: r.kind === 'member' ? '#a16207' : '#1d4ed8', backgroundColor: r.kind === 'member' ? '#fef3c7' : '#dbeafe' }}>
                      {(r.kind === 'member' ? 'Net member' : ROLE_LABEL[r.role] || r.role).toUpperCase()}</span>
                  </button>
                ))}
              </div>
            )}
            {q.trim().length >= 2 && results.length === 0 && <div style={{ fontSize:12, color:C.muted }}>Nobody found.</div>}
            <button onClick={() => { setIsNew(true); setNw(n => ({ ...n, name: /\d/.test(q) ? n.name : q.trim(), mobile: /\d{6,}/.test(q) ? q.trim() : n.mobile })); }}
              style={{ alignSelf:'flex-start', background:'none', border:'none', color:C.navy, fontWeight:800, fontSize:13, cursor:'pointer', padding:0 }}>+ New person (walk-in)</button>
          </>)}
        </Step>

        {/* 2. When */}
        <Step n={2} title="When?">
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Booking date" style={{ ...INPUT, flex:1 }}/>
            {(['day', 'night'] as const).map(s => <button key={s} onClick={() => setSession(s)} aria-pressed={session === s} style={pill(session === s)}>{s === 'day' ? '☀️ Day' : '🌙 Night'}</button>)}
          </div>
          <div style={{ fontSize:11.5, color: date < todayIso() ? C.warn : C.muted }}>
            {fmtDate(date)}{date < todayIso() ? ' · past date (recording an earlier booking)' : ''}</div>
        </Step>

        {/* 3. Slots */}
        <Step n={3} title={`Pick slots${slotCount ? ` · ${slotCount} chosen` : ''}`}>
          {avErr && <div style={{ color:C.bad, fontSize:12.5, fontWeight:700 }}>⚠ {avErr}</div>}
          {!av && !avErr && <div style={{ fontSize:12.5, color:C.muted }}>Loading slots…</div>}
          {av && av.slots.length === 0 && <div style={{ fontSize:12.5, color:C.muted }}>No {session} slots on this day{av.is_monday ? ' (Monday)' : ''}.</div>}
          {av && av.slots.length > 0 && nets.map(([netId, netName]) => {
            const blocked = (av.blocked_nets || []).includes(netId);
            return (
              <div key={netId}>
                <div style={{ fontSize:12, fontWeight:800, color: blocked ? C.muted : C.text, marginBottom:4 }}>{netName}{blocked ? ' — closed for maintenance' : ''}</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                  {av.slots.map((h:number) => {
                    const taken = (av.taken?.[netId] || []).includes(h);
                    const on = (sel[netId] || []).includes(h);
                    const off = taken || blocked;
                    return (
                      <button key={h} disabled={off} onClick={() => toggle(netId, h)} aria-pressed={on}
                        style={{ padding:'6px 9px', borderRadius:8, fontSize:12, fontWeight:800, cursor: off ? 'default' : 'pointer',
                          border:`1px solid ${on ? C.green : C.border}`, backgroundColor: on ? C.green : off ? '#f3f4f6' : '#fff',
                          color: on ? '#fff' : off ? '#c0c4cc' : C.text, textDecoration: taken ? 'line-through' : 'none' }}>
                        {av.slot_labels?.[String(h)] || `${h}:00`}</button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </Step>

        {/* 4. Price */}
        {slotCount > 0 && (
          <Step n={4} title="Price">
            <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
              <span style={{ fontSize:22, fontWeight:900, color: override ? C.muted : C.text, textDecoration: override ? 'line-through' : 'none' }}>
                {price ? fmtAmt(price.total_amount) : '…'}</span>
              {price && price.bundle_saving > 0 && <span style={{ fontSize:12, color:C.good, fontWeight:800 }}>
                saves {fmtAmt(price.bundle_saving)} ({price.price_type === 'concession' ? 'student rate' : price.price_type === 'pass' ? 'pass credit' : 'bundle'})</span>}
            </div>
            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer' }}>
              <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} style={{ width:17, height:17, accentColor:C.navy }}/>
              Change the price
            </label>
            {override && (<>
              <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="New amount (₹) — 0 for free" aria-label="New amount" style={INPUT}/>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason * (e.g. friendly discount)" aria-label="Reason for the price change" style={INPUT}/>
            </>)}
          </Step>
        )}

        {err && <div style={{ color:C.bad, fontSize:13, fontWeight:700 }}>⚠ {err}</div>}
      </div>

      {/* Book button, always reachable */}
      <div style={{ position:'fixed', left:0, right:0, bottom:'calc(56px + env(safe-area-inset-bottom, 0px))', padding:'8px 12px', backgroundColor:'rgba(240,242,245,0.96)',
        borderTop:`1px solid ${C.border}`, zIndex:20 }}>
        <button disabled={busy || !ready} onClick={book} style={{ width:'100%', padding:13, borderRadius:12, border:'none',
          backgroundColor: ready ? C.navy : '#9ca3af', color:'#fff', fontWeight:900, fontSize:15, cursor: ready ? 'pointer' : 'default' }}>
          {busy ? 'Booking…' : `Book${slotCount ? ` ${slotCount} slot${slotCount === 1 ? '' : 's'}` : ''}${price && slotCount ? ` · ${fmtAmt(override && amount !== '' ? amount : price.total_amount)}` : ''}`}
        </button>
      </div>
    </div>
  );
}
