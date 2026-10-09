/**
 * member_fees.tsx — club members' monthly subscription
 *
 *   /member-fees          every member's status, totals, reminders; "By month" tab shows
 *                         one month at a glance (green paid / red unpaid, gold paid ahead)
 *   /member-fees/:id      one member: month strip, collect months, payment visits
 *
 * Data: /api/data/member-fees (routes/api_member_fees.py). ₹ rate per month (revisable,
 * admin), due by the 10th, whole months only. Collect fills pending months oldest first,
 * then this month, then future months — the server previews exactly what it will post.
 * Access: admins, or roles with the `members:fees` permission.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';
import { apiAuthHeaders } from './apiHeaders';
import { can } from './usePermissions';

const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', muted:'#6b7280', text:'#1f2937',
  good:'#16a34a', warn:'#d97706', bad:'#dc2626' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const STATUS: Record<string, { label:string; color:string; bg:string }> = {
  overdue: { label:'Overdue', color:C.bad,  bg:'#fee2e2' },
  due:     { label:'Due',     color:C.warn, bg:'#fef3c7' },
  paid:    { label:'Paid up', color:C.good, bg:'#dcfce7' },
  ahead:   { label:'Paid ahead', color:'#a16207', bg:'#fef9c3' },
};

const base    = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
const fmtAmt  = (n:any) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const canUse  = () => (localStorage.getItem('user_role') || '').toLowerCase() === 'admin' || can('members:fees');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const mLabel  = (ym:string) => `${MON[Number(ym.slice(5,7)) - 1]} ${ym.slice(2,4)}`;
const mLong   = (ym:string) => `${MON[Number(ym.slice(5,7)) - 1]} ${ym.slice(0,4)}`;
const fmtDate = (d:string) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' }) : '—';
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

/** "Jun–Oct 26" style ranges for a sorted list of YYYY-MM months */
function monthRanges(months:string[]): string {
  const next = (ym:string) => { let y = +ym.slice(0,4), m = +ym.slice(5,7) + 1; if (m > 12) { y++; m = 1; } return `${y}-${String(m).padStart(2,'0')}`; };
  const out:string[] = []; let i = 0;
  while (i < months.length) {
    let j = i; while (j + 1 < months.length && months[j + 1] === next(months[j])) j++;
    out.push(i === j ? mLabel(months[i]) : months[i].slice(0,4) === months[j].slice(0,4)
      ? `${MON[+months[i].slice(5,7) - 1]}–${mLabel(months[j])}` : `${mLabel(months[i])} – ${mLabel(months[j])}`);
    i = j + 1;
  }
  return out.join(', ');
}

async function api(path:string, body?:any) {
  const r = await fetch(`${base()}/api/data/member-fees${path}`, body === undefined
    ? { headers: apiAuthHeaders(false) }
    : { method:'POST', headers: { ...apiAuthHeaders(false), 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e:any = new Error(r.status === 403 ? "You don't have access to member fees"
      : r.status === 404 || r.status === 405 ? 'This server does not have member fees yet — update the server and restart it'
      : (j.error || j.detail || `Server error ${r.status}`));
    e.status = r.status; e.data = j; throw e;
  }
  return j;
}
const netMsg = (e:any) => /failed to fetch/i.test(e?.message || '') ? 'Cannot reach the server' : e?.message || 'Something went wrong';

function waLink(m:any, text:string): string | null {
  const raw = String(m.phone || '').replace(/\D/g, '');
  if (raw.length < 10) return null;
  return `https://wa.me/${raw.length === 10 ? `91${raw}` : raw}?text=${encodeURIComponent(text)}`;
}
const reminder = (m:any) =>
  `Dear ${m.name}, a gentle reminder from Quickies Cricket Club: your monthly membership subscription for ` +
  `${monthRanges(m.pending_months)} (${fmtAmt(m.pending_amount)}) is pending. Kindly pay at your convenience. Thank you.`;
function openUrl(url:string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── Small pieces ─────────────────────────────────────────────────────────────
const Empty = ({ text }: { text:string }) => <div style={{ ...CARD, padding:'18px 14px', textAlign:'center', color:C.muted, fontSize:12.5 }}>{text}</div>;
const SectionLabel = ({ children }: { children:React.ReactNode }) =>
  <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase', margin:'6px 2px 0' }}>{children}</div>;

/** Member photo — fetched as a blob like the About page (a plain <img> is blocked cross-origin) */
function Avatar({ m, size }: { m:any; size:number }) {
  const [src, setSrc] = useState<string|null>(null);
  useEffect(() => {
    if (!m.image_url) return;
    let cancelled = false, made:string|null = null;
    fetch(m.image_url.startsWith('http') ? m.image_url : `${base()}${m.image_url}`, { headers: apiAuthHeaders(false) })
      .then(r => r.ok ? r.blob() : null)
      .then(b => { if (b && !cancelled) { made = URL.createObjectURL(b); setSrc(made); } })
      .catch(() => {});
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [m.image_url]);
  const initials = String(m.name || '?').split(/\s+/).map((w:string) => w[0]).slice(0, 2).join('').toUpperCase();
  return src
    ? <img src={src} alt="" style={{ width:size, height:size, borderRadius:'50%', objectFit:'cover', flexShrink:0 }}/>
    : <div style={{ width:size, height:size, borderRadius:'50%', backgroundColor:'#e8f0ea', color:C.green, fontWeight:900,
        fontSize:size * 0.36, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{initials}</div>;
}

function statusLine(m:any): { text:string; color:string } {
  if (m.status === 'overdue' || m.status === 'due') {
    const n = m.pending_months.length;
    return { text: `${monthRanges(m.pending_months)} · ${n} month${n === 1 ? '' : 's'} · ${fmtAmt(m.pending_amount)}`, color: STATUS[m.status].color };
  }
  if (m.status === 'ahead') return { text: `Paid till ${mLong(m.paid_till)} · ${m.ahead_months} ahead`, color: STATUS.ahead.color };
  return { text: m.paid_till ? `Paid till ${mLong(m.paid_till)}` : 'No payments yet', color: C.good };
}

const NoAccess = () => (
  <div style={{ backgroundColor:C.bg, minHeight:'100%' }}>
    <ScreenHeader title="Member Fees"/>
    <div style={{ padding:10 }}><Empty text="🔒 You don't have access to member fees. Ask an admin for the “Member fees” permission."/></div>
  </div>
);

// Last list shown, per signed-in user, so Back from a member is instant (refreshed in the background)
let listCache: { user:string; data:any } | null = null;
const who = () => localStorage.getItem('auth_user') || '';

// ══ Level 1 — all members ═════════════════════════════════════════════════════
export function MemberFees() {
  const nav = useNavigate();
  const [data, setData] = useState<any>(listCache?.user === who() ? listCache.data : null);
  const [err, setErr]   = useState('');
  const [loading, setLoading] = useState(true);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') || 'pending') as 'pending'|'ahead'|'all'|'month';
  const setTab = (t:string) => setParams(p => { t === 'pending' ? p.delete('tab') : p.set('tab', t); return p; }, { replace:true });
  const viewMonth = params.get('m') || '';
  const setViewMonth = (m:string) => setParams(p => { p.set('m', m); return p; }, { replace:true });
  const [q, setQ]       = useState('');
  const [rateOpen, setRateOpen] = useState(false);
  const load = () => {
    setLoading(true); setErr('');
    api('').then(j => { listCache = { user: who(), data: j }; setData(j); })
      .catch(e => setErr(netMsg(e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const rows = useMemo(() => (data?.members || []).filter((m:any) =>
    (tab === 'all' || (tab === 'pending' ? (m.status === 'overdue' || m.status === 'due') : m.status === 'ahead')) &&
    (!q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase()))), [data, tab, q]);
  if (!canUse()) return <NoAccess/>;
  const s = data?.summary;

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom: tab === 'month' ? 0 : 24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title="Member Fees" subtitle={data ? `${fmtAmt(data.rate)} a month · due by the ${data.due_day}th` : 'Club membership subscription'}
        actions={<HeaderIconButton label="Refresh" onClick={load}>↻</HeaderIconButton>}>
        <HeaderTabs value={tab} onChange={setTab} tabs={[
          { id:'pending', label:`Pending${s ? ` · ${s.overdue + s.due}` : ''}` },
          { id:'ahead',   label:`Ahead${s ? ` · ${s.ahead}` : ''}` },
          { id:'all',     label:`All${s ? ` · ${s.members}` : ''}` },
          { id:'month',   label:'By month' }]}/>
      </ScreenHeader>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {loading && !data && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading…</div>}
        {err && (
          <div style={{ ...CARD, padding:14, textAlign:'center' }}>
            <div style={{ color:C.bad, fontWeight:800, fontSize:13, marginBottom:8 }}>⚠ {err}</div>
            <button onClick={load} style={{ padding:'7px 16px', borderRadius:9, border:'none', backgroundColor:C.green, color:'#fff', fontWeight:800, cursor:'pointer' }}>Retry</button>
          </div>
        )}
        {data && tab === 'month' && <MonthView data={data} ym={viewMonth || data.month} setYm={setViewMonth} onOpen={id => nav(`/member-fees/${id}`)}/>}
        {data && tab !== 'month' && (<>
          {/* Totals */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, opacity: loading ? 0.6 : 1 }}>
            <div style={{ ...CARD, padding:'10px 12px' }}>
              <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase' }}>Pending</div>
              <div style={{ fontSize:22, fontWeight:900, color: s.pending_amount ? C.bad : C.good }}>{fmtAmt(s.pending_amount)}</div>
              <div style={{ fontSize:11, color:C.muted }}>{s.overdue} overdue · {s.due} due this month</div>
            </div>
            <div style={{ ...CARD, padding:'10px 12px' }}>
              <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase' }}>Collected</div>
              <div style={{ fontSize:22, fontWeight:900, color:C.green }}>{fmtAmt(s.collected_month)}</div>
              <div style={{ fontSize:11, color:C.muted }}>this month · {fmtAmt(s.collected_year)} this year</div>
            </div>
          </div>
          <div style={{ ...CARD, display:'flex' }}>
            {(['overdue','due','paid','ahead'] as const).map((k, i) => (
              <div key={k} style={{ flex:1, padding:'7px 4px', textAlign:'center', borderLeft: i ? `1px solid ${C.border}` : 'none' }}>
                <div style={{ fontSize:16, fontWeight:900, color:STATUS[k].color }}>{s[k]}</div>
                <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase' }}>{STATUS[k].label}</div>
              </div>
            ))}
          </div>

          <div style={{ position:'relative' }}>
            <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:13 }}>🔍</span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a member" aria-label="Find a member"
              style={{ width:'100%', padding:'8px 30px', borderRadius:10, border:`1px solid ${C.border}`, fontSize:13.5, outline:'none', boxSizing:'border-box', backgroundColor:'#fff' }}/>
          </div>

          {rows.length === 0 ? <Empty text={tab === 'pending' ? 'Nobody owes a membership fee 👍' : 'No members here'}/> : (
            <div style={CARD}>
              {rows.map((m:any, i:number) => {
                const line = statusLine(m);
                const wa = (m.status === 'overdue' || m.status === 'due') ? waLink(m, reminder(m)) : null;
                return (
                  <div key={m.id} role="button" tabIndex={0} onClick={() => nav(`/member-fees/${m.id}`)}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop: i ? `1px solid ${C.border}` : 'none', cursor:'pointer' }}>
                    <Avatar m={m} size={36}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ fontWeight:800, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</span>
                        <span style={{ flexShrink:0, fontSize:9.5, fontWeight:900, padding:'1px 6px', borderRadius:6, color:STATUS[m.status].color, backgroundColor:STATUS[m.status].bg }}>
                          {STATUS[m.status].label.toUpperCase()}</span>
                      </div>
                      <div style={{ fontSize:11, color:C.muted }}>{[m.position, m.category].filter(Boolean).join(' · ')}</div>
                      <div style={{ fontSize:11.5, fontWeight:700, color:line.color, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{line.text}</div>
                    </div>
                    {wa && <button onClick={e => { e.stopPropagation(); openUrl(wa); }} aria-label={`Send WhatsApp reminder to ${m.name}`}
                      style={{ flexShrink:0, padding:'6px 9px', borderRadius:8, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:800, fontSize:11.5, cursor:'pointer' }}>💬 Remind</button>}
                  </div>
                );
              })}
            </div>
          )}

          {data.is_admin && (
            <div style={{ ...CARD, padding:'9px 12px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ flex:1, fontSize:12 }}>
                  <b>Monthly fee:</b> {data.rates.map((r:any) => `${fmtAmt(r.amount)} from ${mLong(r.from)}`).join(' · ')}
                </div>
                <button onClick={() => setRateOpen(o => !o)} style={{ background:'none', border:'none', color:C.green, fontWeight:800, fontSize:12, cursor:'pointer' }}>
                  {rateOpen ? 'Close' : 'Revise'}</button>
              </div>
              {rateOpen && <RateForm current={data.rate} onSaved={() => { setRateOpen(false); load(); }}/>}
            </div>
          )}
          <div style={{ fontSize:11, color:C.muted, lineHeight:1.5, padding:'0 2px' }}>
            Members in Draft are not billed. A month's fee is due by the {data.due_day}th; months paid in advance keep the rate paid at the time.
          </div>
        </>)}
      </div>
    </div>
  );
}

// ── By month: every member's status for one month at a glance ───────────────
const shiftYm = (ym:string, n:number) => { let y = +ym.slice(0,4), m = +ym.slice(5,7) + n;
  while (m > 12) { y++; m -= 12; } while (m < 1) { y--; m += 12; } return `${y}-${String(m).padStart(2,'0')}`; };
const LOOK: Record<string, { ring:string; bg:string; label:string }> = {
  paid:    { ring:C.good,    bg:'#dcfce7', label:'Paid' },
  overdue: { ring:C.bad,     bg:'#fee2e2', label:'Unpaid' },
  due:     { ring:C.warn,    bg:'#fef3c7', label:'Due (not late)' },
  ahead:   { ring:C.gold,    bg:'#fef9c3', label:'Paid ahead' },
  notyet:  { ring:'#cbd5e1', bg:'#f8fafc', label:'Not yet due' },
};

/** Best grid for n photos in a w×h box: the column count that gives the largest photo */
function fitGrid(n:number, w:number, h:number) {
  const LABEL = 15, RING = 12, GAP = 6;            // name line, ring + padding, spacing
  let best = { cols:4, size:0 };
  for (let cols = 3; cols <= 9; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.floor(Math.min(w / cols - GAP, h / rows - LABEL - GAP) - RING);
    if (size > best.size) best = { cols, size };
  }
  return { cols: best.cols, size: Math.max(22, Math.min(best.size, 72)) };
}

function MonthView({ data, ym, setYm, onOpen }: { data:any; ym:string; setYm:(m:string)=>void; onOpen:(id:number)=>void }) {
  const now = data.month;
  const first = data.members.reduce((a:string, m:any) => m.start < a ? m.start : a, now);
  const last  = data.members.reduce((a:string, m:any) => m.paid_till && m.paid_till > a ? m.paid_till : a, shiftYm(now, 3));
  const [only, setOnly] = useState('');
  const rateFor = (x:string) => data.rates.reduce((amt:number, r:any) => r.from <= x ? r.amount : amt, data.rates[0]?.amount || data.rate);
  const lateNow = Number(data.today.slice(8, 10)) > data.due_day;

  // Members billed in this month (their start is on or before it), alphabetical
  const cells = data.members.filter((m:any) => m.start <= ym)
    .map((m:any) => {
      const paid = (m.paid_months || []).includes(ym);
      const key = ym > now ? (paid ? 'ahead' : 'notyet')
        : paid ? 'paid' : ym < now || lateNow ? 'overdue' : 'due';
      return { m, key };
    })
    .sort((a:any, b:any) => a.m.name.localeCompare(b.m.name));
  const keys = ym > now ? ['ahead', 'notyet'] : ym === now && !lateNow ? ['paid', 'due'] : ['paid', 'overdue'];
  const count = (k:string) => cells.filter((c:any) => c.key === k).length;
  const rate = rateFor(ym);
  const paidN = cells.filter((c:any) => c.key === 'paid' || c.key === 'ahead').length;
  const shown = only ? cells.filter((c:any) => c.key === only) : cells;
  const go = (n:number) => { setYm(shiftYm(ym, n)); setOnly(''); };

  // Fill exactly the space left above the bottom bar, and size the photos to fit it
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [box, setBox] = useState({ w:0, h:0 });
  useLayoutEffect(() => {
    const measure = () => {
      const el = wrapRef.current; if (!el) return;
      const area = (el.closest('.app-scroll') as HTMLElement | null)?.getBoundingClientRect().bottom ?? window.innerHeight;
      setHeight(Math.max(260, Math.floor(area - el.getBoundingClientRect().top - 10)));
      const g = gridRef.current; if (g) setBox({ w:g.clientWidth - 12, h:g.clientHeight - 16 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (gridRef.current) ro.observe(gridRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const { cols, size } = fitGrid(Math.max(1, shown.length), box.w || 340, box.h || 400);

  const arrow = (on:boolean): React.CSSProperties => ({ width:34, height:30, borderRadius:8, border:'none', fontSize:18, fontWeight:800,
    backgroundColor:on ? '#f0f4f0' : 'transparent', color:on ? C.green : '#d1d5db', cursor:on ? 'pointer' : 'default' });

  return (
    <div ref={wrapRef} style={{ height: height || undefined, display:'flex', flexDirection:'column', gap:8 }}>
      <div style={{ ...CARD, flexShrink:0, display:'flex', alignItems:'center', gap:6, padding:'5px 8px' }}>
        <button aria-label="Previous month" disabled={ym <= first} onClick={() => go(-1)} style={arrow(ym > first)}>‹</button>
        <div style={{ flex:1, textAlign:'center' }}>
          <div style={{ fontWeight:800, fontSize:14 }}>{new Date(+ym.slice(0,4), +ym.slice(5,7) - 1, 1).toLocaleDateString('en-GB', { month:'long', year:'numeric' })}</div>
          <div style={{ fontSize:10.5, color:C.muted }}>
            {ym < now ? 'Past month' : ym === now ? `This month · due by the ${data.due_day}th` : 'Future month'} · {fmtAmt(rate)} each
            {ym !== now && <> · <button onClick={() => { setYm(now); setOnly(''); }}
              style={{ background:'none', border:'none', padding:0, color:C.green, fontWeight:800, fontSize:10.5, cursor:'pointer' }}>This month</button></>}
          </div>
        </div>
        <button aria-label="Next month" disabled={ym >= last} onClick={() => go(1)} style={arrow(ym < last)}>›</button>
      </div>

      <div ref={gridRef} style={{ ...CARD, flex:1, minHeight:0, padding:'8px 6px', overflowY: size <= 22 ? 'auto' : 'hidden',
        display:'grid', gridTemplateColumns:`repeat(${cols}, 1fr)`, alignContent:'space-evenly', rowGap:6 }}>
        {shown.length === 0
          ? <div style={{ gridColumn:'1 / -1', textAlign:'center', color:C.muted, fontSize:12.5 }}>{cells.length ? 'Nobody in this group' : 'No members were billed this month'}</div>
          : shown.map(({ m, key }:any) => (
            <button key={m.id} onClick={() => onOpen(m.id)} aria-label={`${m.name}: ${LOOK[key].label}`}
              style={{ background:'none', border:'none', padding:0, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:2, minWidth:0 }}>
              <div style={{ padding:2, borderRadius:'50%', backgroundColor:LOOK[key].bg,
                border:`3px ${key === 'notyet' ? 'dashed' : 'solid'} ${LOOK[key].ring}`, opacity: key === 'notyet' ? 0.75 : 1 }}>
                <Avatar m={m} size={size}/>
              </div>
              <span style={{ fontSize: size < 40 ? 9.5 : 11, fontWeight:700, color:C.text, maxWidth:'100%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', padding:'0 1px' }}>
                {m.name.split(/\s+/)[0]}</span>
            </button>
          ))}
      </div>

      {/* Footer: what the colours add up to */}
      <div style={{ ...CARD, flexShrink:0, padding:'7px 8px', display:'flex', flexDirection:'column', gap:5 }}>
        <div style={{ display:'flex', gap:6 }}>
          {keys.map(k => {
            const on = only === k, n = count(k);
            return (
              <button key={k} onClick={() => setOnly(on ? '' : k)} aria-pressed={on}
                style={{ flex:'1 1 0', minWidth:0, display:'flex', alignItems:'center', gap:6, padding:'5px 7px', borderRadius:10, cursor:'pointer', textAlign:'left',
                  border:`1.5px solid ${on ? LOOK[k].ring : C.border}`, backgroundColor: on ? LOOK[k].bg : '#fff' }}>
                <span style={{ width:12, height:12, borderRadius:'50%', flexShrink:0, backgroundColor:LOOK[k].bg, border:`2.5px ${k === 'notyet' ? 'dashed' : 'solid'} ${LOOK[k].ring}` }}/>
                <span style={{ display:'flex', flexDirection:'column', lineHeight:1.15, minWidth:0 }}>
                  <span style={{ fontSize:10.5, fontWeight:700, color:C.muted, whiteSpace:'nowrap' }}>{LOOK[k].label}</span>
                  <span style={{ fontSize:14, fontWeight:900, color:C.text, whiteSpace:'nowrap' }}>{n} <span style={{ fontSize:11, fontWeight:700, color:C.muted }}>· {fmtAmt(n * rate)}</span></span>
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ fontSize:11, color:C.muted }}>
          {ym > now
            ? <>{paidN} of {cells.length} members have already paid for this month.</>
            : <>Collected: <b style={{ color:C.text }}>{fmtAmt(paidN * rate)}</b> of {fmtAmt(cells.length * rate)} ({cells.length ? Math.round(100 * paidN / cells.length) : 0}%)</>}
          {only && <> · showing {LOOK[only].label.toLowerCase()} only</>}
        </div>
      </div>
    </div>
  );
}

function RateForm({ current, onSaved }: { current:number; onSaved:()=>void }) {
  const d = new Date(); const nextMonth = `${d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear()}-${String(d.getMonth() === 11 ? 1 : d.getMonth() + 2).padStart(2,'0')}`;
  const [amount, setAmount] = useState(String(current));
  const [from, setFrom] = useState(nextMonth);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const save = () => {
    setBusy(true); setMsg('');
    api('/rate', { amount: Number(amount), from_month: from }).then(onSaved).catch(e => setMsg(netMsg(e))).finally(() => setBusy(false));
  };
  const inp: React.CSSProperties = { padding:'7px 8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:13, minWidth:0 };
  return (
    <div style={{ marginTop:8, display:'flex', flexDirection:'column', gap:6 }}>
      <div style={{ display:'flex', gap:6 }}>
        <input type="number" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} aria-label="New monthly fee" style={{ ...inp, flex:1 }}/>
        <input type="month" value={from} min={todayIso().slice(0,7)} onChange={e => setFrom(e.target.value)} aria-label="Applies from month" style={{ ...inp, flex:1 }}/>
      </div>
      <div style={{ fontSize:11, color:C.muted }}>Months already paid keep their old amount. Applies to unpaid months from the chosen month.</div>
      {msg && <div style={{ color:C.bad, fontSize:12, fontWeight:700 }}>⚠ {msg}</div>}
      <button disabled={busy || !(Number(amount) > 0)} onClick={save}
        style={{ padding:'8px', borderRadius:9, border:'none', backgroundColor:C.green, color:'#fff', fontWeight:800, cursor:'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Saving…' : `Set ${fmtAmt(amount)} from ${from ? mLong(from) : '…'}`}</button>
    </div>
  );
}

// ══ Level 2 — one member ══════════════════════════════════════════════════════
export function MemberFeeDetail() {
  const { id } = useParams();
  const [d, setD]     = useState<any>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<any>(null);
  const load = () => { setErr(''); api(`/${id}`).then(setD).catch(e => setErr(netMsg(e))); };
  useEffect(load, [id]);
  if (!canUse()) return <NoAccess/>;
  const m = d?.member;
  const wa = m && (m.status === 'overdue' || m.status === 'due') ? waLink(m, reminder(m))
    : m ? waLink(m, `Hello ${m.name}, greetings from Quickies Cricket Club.`) : null;

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title={m?.name || 'Member'} subtitle={m ? [m.position, m.category].filter(Boolean).join(' · ') : 'Loading…'}/>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {err && <Empty text={`⚠ ${err}`}/>}
        {!d && !err && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading…</div>}
        {d && (<>
          {/* Header */}
          <div style={{ ...CARD, display:'flex', alignItems:'center', gap:12, padding:12 }}>
            <Avatar m={m} size={54}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:900, fontSize:16 }}>{m.name}</div>
              <div style={{ fontSize:11.5, color:C.muted }}>{m.phone || 'no phone'}</div>
              <span style={{ display:'inline-block', marginTop:4, fontSize:10.5, fontWeight:900, padding:'2px 8px', borderRadius:7,
                color:STATUS[m.status].color, backgroundColor:STATUS[m.status].bg }}>{STATUS[m.status].label.toUpperCase()}</span>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
              {m.phone && <a href={`tel:${String(m.phone).replace(/\s/g,'')}`} style={{ padding:'5px 10px', borderRadius:8, backgroundColor:'#f0f4f0', color:C.green, fontWeight:800, fontSize:12, textDecoration:'none', textAlign:'center' }}>📞 Call</a>}
              {wa && <button onClick={() => openUrl(wa)} style={{ padding:'5px 10px', borderRadius:8, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer' }}>
                💬 {m.status === 'overdue' || m.status === 'due' ? 'Remind' : 'WhatsApp'}</button>}
            </div>
          </div>

          {/* Summary */}
          <div style={{ ...CARD, display:'flex' }}>
            {[['Pending', fmtAmt(m.pending_amount), m.pending_amount ? C.bad : C.good],
              ['Paid till', m.paid_till ? mLabel(m.paid_till) : '—', C.text],
              ['Ahead', `${m.ahead_months} mo`, m.ahead_months ? STATUS.ahead.color : C.muted],
              ['Total paid', fmtAmt(d.total_paid), C.green]].map(([l, v, col]:any, i) => (
              <div key={l} style={{ flex:1, padding:'7px 4px', textAlign:'center', borderLeft: i ? `1px solid ${C.border}` : 'none' }}>
                <div style={{ fontSize:14.5, fontWeight:900, color:col }}>{v}</div>
                <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase' }}>{l}</div>
              </div>
            ))}
          </div>

          {/* Month strip */}
          <SectionLabel>Months</SectionLabel>
          <div style={{ ...CARD, padding:10 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:5 }}>
              {d.strip.map((x:any) => {
                const look = x.state === 'paid' ? (x.month > d.month ? { bg:'#fef3c7', fg:'#a16207', b:'none' } : { bg:'#dcfce7', fg:C.good, b:'none' })
                  : x.state === 'overdue' ? { bg:'#fee2e2', fg:C.bad, b:'none' }
                  : x.state === 'due' ? { bg:'#fff7ed', fg:C.warn, b:`1px solid ${C.warn}` }
                  : { bg:'transparent', fg:C.muted, b:`1px dashed ${C.border}` };
                return (
                  <div key={x.month} title={`${mLong(x.month)}: ${x.state}`} style={{ padding:'6px 2px', borderRadius:7, textAlign:'center',
                    backgroundColor:look.bg, color:look.fg, border:look.b, outline: x.month === d.month ? `2px solid ${C.text}` : 'none', outlineOffset:1 }}>
                    <div style={{ fontSize:11.5, fontWeight:800 }}>{MON[+x.month.slice(5,7) - 1]}</div>
                    <div style={{ fontSize:9.5 }}>{x.month.slice(0,4)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:10, justifyContent:'center', marginTop:8, fontSize:10.5, color:C.muted }}>
              {[['#dcfce7','Paid'],['#fef3c7','Paid ahead'],['#fee2e2','Overdue'],['#fff7ed','Due'],['transparent','Not yet due']].map(([bg, l]) =>
                <span key={l}><span style={{ display:'inline-block', width:9, height:9, borderRadius:2, backgroundColor:bg, border:`1px solid ${C.border}`, marginRight:4 }}/>{l}</span>)}
            </div>
          </div>

          {/* Collect */}
          {done ? (
            <div style={{ ...CARD, padding:12, borderColor:C.good }}>
              <div style={{ fontWeight:900, color:C.good, fontSize:14 }}>✓ Recorded {fmtAmt(done.total)} for {done.posted.length} month{done.posted.length === 1 ? '' : 's'}</div>
              <div style={{ fontSize:12, color:C.text, marginTop:4 }}>{monthRanges(done.posted.map((p:any) => p.month))}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>Receipts {done.posted[0]?.receipt_no}{done.posted.length > 1 ? ` – ${done.posted[done.posted.length - 1].receipt_no}` : ''}</div>
              <button onClick={() => setDone(null)} style={{ marginTop:8, background:'none', border:'none', color:C.green, fontWeight:800, fontSize:12.5, cursor:'pointer', padding:0 }}>Record another payment</button>
            </div>
          ) : (
            <Collect memberId={Number(id)} pending={m.pending_months.length} modes={d.modes} rate={d.rate}
              onDone={res => { setDone(res); listCache = null; load(); }}/>
          )}

          {/* Payment visits */}
          <SectionLabel>Payments</SectionLabel>
          {d.visits.length === 0 ? <Empty text="No membership payments yet"/> : (
            <div style={CARD}>
              {d.visits.map((v:any, i:number) => (
                <div key={`${v.date}-${v.mode}`} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:800 }}>{monthRanges(v.months)}</div>
                    <div style={{ fontSize:11, color:C.muted }}>
                      {fmtDate(v.date)} · {v.mode || '—'} · {v.months.length} month{v.months.length === 1 ? '' : 's'}
                      {v.receipts.length ? ` · ${v.receipts[0]}${v.receipts.length > 1 ? `–${v.receipts[v.receipts.length - 1].replace('REC-', '')}` : ''}` : ''}
                    </div>
                  </div>
                  <div style={{ fontWeight:900, fontSize:13.5, color:C.green }}>{fmtAmt(v.amount)}</div>
                </div>
              ))}
            </div>
          )}
        </>)}
      </div>
    </div>
  );
}

/** Pick a number of months; the server previews exactly which months that covers */
function Collect({ memberId, pending, modes, rate, onDone }: { memberId:number; pending:number; modes:string[]; rate:number; onDone:(r:any)=>void }) {
  const [n, setN] = useState(Math.max(1, pending));
  const [mode, setMode] = useState(modes[0] || 'Cash');
  const [date, setDate] = useState(todayIso());
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState('');
  useEffect(() => {
    setPlan(null); setMsg('');
    const t = setTimeout(() => api(`/${memberId}/preview`, { months: n }).then(setPlan).catch(e => setMsg(netMsg(e))), 250);
    return () => clearTimeout(t);
  }, [n, memberId]);
  const save = () => {
    if (!plan) return;
    setBusy(true); setMsg('');
    api(`/${memberId}/collect`, { months: n, payment_mode: mode, payment_date: date, expect: plan.months.map((x:any) => x.month) })
      .then(onDone)
      .catch(e => { setMsg(netMsg(e)); if (e.status === 409) api(`/${memberId}/preview`, { months: n }).then(setPlan); })
      .finally(() => setBusy(false));
  };
  const chip = (k:number, label:string) => (
    <button key={label} onClick={() => setN(k)} aria-pressed={n === k} style={{ flexShrink:0, padding:'5px 10px', borderRadius:16, fontSize:12, fontWeight:700, cursor:'pointer',
      border:`1px solid ${n === k ? C.green : C.border}`, backgroundColor: n === k ? C.green : '#fff', color: n === k ? '#fff' : '#374151' }}>{label}</button>
  );
  const step: React.CSSProperties = { width:34, height:34, borderRadius:9, border:`1px solid ${C.border}`, backgroundColor:'#fff', fontSize:18, fontWeight:900, color:C.green, cursor:'pointer' };
  return (<>
    <SectionLabel>Collect payment</SectionLabel>
    <div style={{ ...CARD, padding:12, display:'flex', flexDirection:'column', gap:9 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <button aria-label="One month less" style={step} onClick={() => setN(v => Math.max(1, v - 1))}>−</button>
        <div style={{ flex:1, textAlign:'center' }}>
          <div style={{ fontSize:20, fontWeight:900 }}>{n} month{n === 1 ? '' : 's'}</div>
          <div style={{ fontSize:11.5, color:C.muted }}>{plan ? fmtAmt(plan.total) : fmtAmt(n * rate)}</div>
        </div>
        <button aria-label="One month more" style={step} onClick={() => setN(v => Math.min(60, v + 1))}>+</button>
      </div>
      <div style={{ display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none' }}>
        {pending > 0 && chip(pending, `All pending · ${pending}`)}
        {[1, 3, 6, 12].filter(k => k !== pending).map(k => chip(k, k === 12 ? '1 year' : `${k} mo`))}
      </div>
      <div style={{ fontSize:12, color:C.text, backgroundColor:'#f8faf8', borderRadius:8, padding:'7px 9px', minHeight:18 }}>
        {plan ? <>Covers <b>{monthRanges(plan.months.map((x:any) => x.month))}</b></> : <span style={{ color:C.muted }}>Working out the months…</span>}
      </div>
      <div style={{ display:'flex', gap:6 }}>
        <select value={mode} onChange={e => setMode(e.target.value)} aria-label="Payment mode"
          style={{ flex:1, padding:'8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:13, backgroundColor:'#fff' }}>
          {modes.map(x => <option key={x}>{x}</option>)}
        </select>
        <input type="date" value={date} max={todayIso()} onChange={e => setDate(e.target.value)} aria-label="Payment date"
          style={{ flex:1, padding:'7px 8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:13, minWidth:0 }}/>
      </div>
      {msg && <div style={{ color:C.bad, fontSize:12, fontWeight:700 }}>⚠ {msg}</div>}
      <button disabled={!plan || busy} onClick={save}
        style={{ padding:'11px', borderRadius:11, border:'none', backgroundColor:C.green, color:'#fff', fontWeight:900, fontSize:14,
          cursor: plan && !busy ? 'pointer' : 'default', opacity: plan && !busy ? 1 : 0.6 }}>
        {busy ? 'Recording…' : plan ? `Record ${fmtAmt(plan.total)} · ${mode}` : 'Record payment'}</button>
    </div>
  </>);
}
