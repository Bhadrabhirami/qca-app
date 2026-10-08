/**
 * kpi.tsx — KPI dashboard → filtered student list → student profile (admin only)
 *
 *   /kpi                    academy KPIs, charts, action lists, match leaderboard
 *   /kpi/list?…             students matching a filter (session, fee, attendance band, at risk…)
 *   /kpi/student/:id        one student's attendance, fees and matches
 *
 * Access: admins, or roles with the `kpi:view` permission. Fee figures come only for
 * users who also have `payments:view` (the server leaves them out; can_fees=false).
 *
 * Data: GET /api/data/kpi/dashboard and /api/data/kpi/student/{id} (server computes
 * everything; see routes/api_kpi.py for the definitions). Attendance % is measured
 * against an expected 3 days a week; fees are due on the 10th.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';
import StudentPhoto from '../shared/StudentPhoto';
import { apiAuthHeaders } from './apiHeaders';
import { fmtRegNo } from './studentUtils';
import { can } from './usePermissions';

// ── Look ─────────────────────────────────────────────────────────────────────
const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', muted:'#6b7280', text:'#1f2937',
  good:'#16a34a', warn:'#d97706', bad:'#dc2626', none:'#d1d5db' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const FEE_COLOR: Record<string,string> = { paid:C.good, partial:C.warn, unpaid:'#6b7280', overdue:C.bad, 'not billed':C.none, member:'#7c3aed' };
const FEE_LABEL: Record<string,string> = { paid:'Paid', partial:'Partial', unpaid:'Due (not late)', overdue:'Overdue', 'not billed':'Not billed yet', member:'Club member — no fee' };

const base   = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
const fmtAmt = (n:any) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const attColor = (p:number|null|undefined) => p == null ? C.muted : p > 80 ? C.good : p >= 60 ? C.warn : C.bad;
/** The attendance % behind the flags: this month, or the last 30 days early in the month */
const rowPct = (s:any): number|null => s.att_flag_pct !== undefined ? s.att_flag_pct : s.att_pct;
const ids = (s:any) => [fmtRegNo(s.regno), s.qca_id ? `Q${String(s.qca_id).padStart(3,'0')}` : ''].filter(Boolean).join(' · ');
const monthLabel = (ym:string, long = true) => { const [y,m] = ym.split('-').map(Number); return new Date(y, m-1, 1).toLocaleDateString('en-GB', long ? { month:'long', year:'numeric' } : { month:'short' }); };
const shiftMonth = (ym:string, n:number) => { const [y,m] = ym.split('-').map(Number); const d = new Date(y, m-1+n, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
const isAdmin = () => (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
const canKpi  = () => isAdmin() || can('kpi:view');

/** WhatsApp link to the parent (else the student), 10-digit numbers get +91 */
function waLink(s:any, text:string): string | null {
  const raw = String(s.parent_phone || s.phone || '').replace(/\D/g, '');
  if (raw.length < 10) return null;
  const num = raw.length === 10 ? `91${raw}` : raw;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}
const feeReminder = (s:any) =>
  `Dear Parent, this is a gentle reminder from Quickies Cricket Academy that ${s.name}'s fee of ${fmtAmt(s.overdue_amount)}` +
  `${s.overdue_months?.length ? ` (${s.overdue_months.map((m:string)=>monthLabel(m,false)).join(', ')})` : ''} is pending. Kindly pay at the earliest. Thank you.`;
function openWa(url: string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── Dashboard data (shared by the dashboard and list screens) ────────────────
let cache: { month:string; user:string; at:number; data:any } | null = null;
const who = () => localStorage.getItem('auth_user') || '';
async function loadDashboard(month:string, force = false): Promise<any> {
  if (!force && cache && cache.month === month && cache.user === who() && Date.now() - cache.at < 5 * 60_000) return cache.data;
  const r = await fetch(`${base()}/api/data/kpi/dashboard?month=${month}`, { headers: apiAuthHeaders(false) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(
    r.status === 403 ? "You don't have access to the KPI dashboard"
    : r.status === 404 || r.status === 405 ? 'This server does not have the KPI dashboard yet — update the server (routes/api_kpi.py + main.py) and restart it'
    : (j.error || `Server error ${r.status}`));
  cache = { month, user: who(), at: Date.now(), data: j };
  return j;
}
function useDashboard(month:string) {
  const [data, setData] = useState<any>(cache?.month === month && cache.user === who() ? cache.data : null);
  const [err, setErr]   = useState('');
  const [loading, setLoading] = useState(!data);
  const reload = (force = false) => {
    setLoading(true); setErr('');
    loadDashboard(month, force).then(setData)
      .catch(e => setErr(/failed to fetch/i.test(e.message) ? 'Cannot reach the server' : e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { reload(); }, [month]); // eslint-disable-line
  return { data, err, loading, reload };
}

// ── Small pieces ─────────────────────────────────────────────────────────────
const SectionLabel = ({ children, action, onAction }: { children:React.ReactNode; action?:string; onAction?:()=>void }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'6px 2px 0' }}>
    <span style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase' }}>{children}</span>
    {action && <button onClick={onAction} style={{ background:'none', border:'none', padding:0, color:C.green, fontSize:12, fontWeight:800, cursor:'pointer' }}>{action} ›</button>}
  </div>
);
const Empty = ({ text }: { text:string }) => <div style={{ ...CARD, padding:'18px 14px', textAlign:'center', color:C.muted, fontSize:12.5 }}>{text}</div>;
const Note = ({ children }: { children:React.ReactNode }) => <div style={{ fontSize:11, color:C.muted, lineHeight:1.5, padding:'0 2px' }}>{children}</div>;

function Trend({ now, prev, higherIsGood = true, suffix = '', vs = 'prev', fmt }: { now:number|null; prev:number|null; higherIsGood?:boolean; suffix?:string; vs?:string; fmt?:(n:number)=>string }) {
  if (now == null || prev == null) return <span style={{ fontSize:10.5, color:C.muted }}>no comparison</span>;
  const diff = Math.round((now - prev) * 10) / 10;
  if (diff === 0) return <span style={{ fontSize:10.5, color:C.muted }}>→ same as {vs}</span>;
  const good = (diff > 0) === higherIsGood;
  return <span style={{ fontSize:10.5, fontWeight:800, color: good ? C.good : C.bad }}>{diff > 0 ? '▲' : '▼'} {fmt ? fmt(Math.abs(diff)) : Math.abs(diff)}{suffix} <span style={{ fontWeight:600 }}>vs {vs}</span></span>;
}

function KpiCard({ label, value, sub, trend, color, onClick }: { label:string; value:React.ReactNode; sub?:React.ReactNode; trend?:React.ReactNode; color?:string; onClick?:()=>void }) {
  return (
    <button onClick={onClick} style={{ ...CARD, padding:'10px 12px', textAlign:'left', cursor:onClick?'pointer':'default', display:'flex', flexDirection:'column', gap:2 }}>
      <span style={{ fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase', letterSpacing:'0.5px' }}>{label}</span>
      <span style={{ fontSize:22, fontWeight:900, color:color || C.green, lineHeight:1.1 }}>{value}</span>
      {sub && <span style={{ fontSize:11, color:C.muted }}>{sub}</span>}
      {trend}
    </button>
  );
}

/** Donut with tappable slices (and legend rows) */
function Donut({ parts, onPick }: { parts:{key:string;label:string;value:number;color:string}[]; onPick:(k:string)=>void }) {
  const total = parts.reduce((a,p)=>a+p.value,0) || 1;
  const R = 34, CIRC = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:14, padding:'10px 12px' }}>
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="Fee status split">
        <circle cx="48" cy="48" r={R} fill="none" stroke="#f1f5f9" strokeWidth="16"/>
        {parts.filter(p=>p.value>0).map(p => {
          const len = CIRC * p.value / total; const off = CIRC * acc / total; acc += p.value;
          return <circle key={p.key} cx="48" cy="48" r={R} fill="none" stroke={p.color} strokeWidth="16"
            strokeDasharray={`${len} ${CIRC-len}`} strokeDashoffset={-off} transform="rotate(-90 48 48)"
            style={{ cursor:'pointer' }} onClick={() => onPick(p.key)}/>;
        })}
        <text x="48" y="52" textAnchor="middle" fontSize="15" fontWeight="900" fill={C.text}>{total}</text>
      </svg>
      <div style={{ flex:1, display:'flex', flexDirection:'column', gap:3 }}>
        {parts.map(p => (
          <button key={p.key} onClick={() => onPick(p.key)} style={{ display:'flex', alignItems:'center', gap:7, background:'none', border:'none', padding:'2px 0', cursor:'pointer', textAlign:'left' }}>
            <span style={{ width:10, height:10, borderRadius:3, backgroundColor:p.color, flexShrink:0 }}/>
            <span style={{ flex:1, fontSize:12.5, color:C.text }}>{p.label}</span>
            <span style={{ fontSize:12.5, fontWeight:800, color:C.text }}>{p.value}</span>
            <span style={{ color:C.muted, fontSize:12 }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Money received each month, stacked by fee type; tap a month for its breakdown */
const COLL_PARTS = [
  { key:'tuition', label:'Tuition', color:'#1a472a' },
  { key:'admission', label:'Admission', color:'#d4af37' },
  { key:'registration', label:'Camp registration', color:'#0ea5e9' },
];
const shortAmt = (n:number) => n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : n >= 1000 ? `₹${Math.round(n/100)/10}k` : `₹${Math.round(n)}`;
function CollectionChart({ trend, month, inProgress }: { trend:any[]; month:string; inProgress:boolean }) {
  const [pick, setPick] = useState<string>(month);
  const sel = trend.find(t => t.month === pick) || trend[trend.length - 1];
  const max = Math.max(1, ...trend.map(t => t.total || 0));
  const parts = COLL_PARTS.filter(p => trend.some(t => (t[p.key] || 0) > 0));
  return (
    <div style={CARD}>
      <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:130, padding:'10px 12px 4px' }}>
        {trend.map(t => {
          const on = t.month === sel.month;
          return (
            <button key={t.month} onClick={() => setPick(t.month)} aria-label={`${monthLabel(t.month)}: ${fmtAmt(t.total)}`}
              style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:3, height:'100%', justifyContent:'flex-end', background:'none', border:'none', padding:0, cursor:'pointer' }}>
              <span style={{ fontSize:9.5, fontWeight:800, color:C.text }}>{t.total ? shortAmt(t.total) : '—'}</span>
              <div style={{ width:'72%', height:`${Math.max(2, (t.total || 0) / max * 78)}%`, display:'flex', flexDirection:'column-reverse',
                borderRadius:'4px 4px 0 0', overflow:'hidden', outline: on ? `2px solid ${C.text}` : 'none', outlineOffset:1 }}>
                {COLL_PARTS.map(p => (t[p.key] || 0) > 0 &&
                  <div key={p.key} style={{ height:`${t[p.key] / t.total * 100}%`, backgroundColor:p.color }}/>)}
              </div>
              <span style={{ fontSize:10, color: on ? C.text : C.muted, fontWeight: on ? 800 : 500 }}>
                {monthLabel(t.month, false)}{t.month === month && inProgress ? '*' : ''}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display:'flex', gap:12, justifyContent:'center', padding:'2px 12px 8px', fontSize:10.5, color:C.muted }}>
        {parts.map(p => <span key={p.key}><span style={{ display:'inline-block', width:9, height:9, borderRadius:2, backgroundColor:p.color, marginRight:4 }}/>{p.label}</span>)}
      </div>
      {/* Selected month breakdown */}
      <div style={{ borderTop:`1px solid ${C.border}`, padding:'8px 12px', display:'flex', flexDirection:'column', gap:4 }}>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12.5, fontWeight:900 }}>
          <span>{monthLabel(sel.month)}{sel.month === month && inProgress ? ' (to date)' : ''}</span><span style={{ color:C.green }}>{fmtAmt(sel.total)}</span>
        </div>
        {COLL_PARTS.map(p => (
          <div key={p.key} style={{ display:'flex', alignItems:'center', gap:7, fontSize:12 }}>
            <span style={{ width:9, height:9, borderRadius:2, backgroundColor:p.color }}/>
            <span style={{ flex:1, color:C.text }}>{p.label}</span>
            <span style={{ fontWeight:800, color:(sel[p.key] || 0) ? C.text : C.muted }}>{fmtAmt(sel[p.key])}</span>
          </div>
        ))}
        {sel.due > 0 && (
          <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
            {monthLabel(sel.month, false)} tuition bill:{' '}
            <b style={{ color:attColor(sel.pct) }}>{sel.pct == null ? '—' : `${Math.round(sel.pct)}%`}</b> collected ({fmtAmt(sel.collected)} of {fmtAmt(sel.due)})
          </div>
        )}
      </div>
    </div>
  );
}

function Spark({ points }: { points:{label:string;value:number|null}[] }) {
  const W = 300, H = 70, pad = 6;
  const vals = points.map(p => p.value ?? 0);
  const step = points.length > 1 ? (W - 2*pad) / (points.length - 1) : 0;
  const y = (v:number) => H - pad - (Math.min(100, v) / 100) * (H - 2*pad);
  const path = vals.map((v,i) => `${i ? 'L' : 'M'}${pad + i*step},${y(v)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H+14}`} role="img" aria-label="Monthly attendance trend">
      <line x1={pad} x2={W-pad} y1={y(60)} y2={y(60)} stroke={C.warn} strokeDasharray="3 3" strokeWidth="1"/>
      <path d={path} fill="none" stroke={C.green} strokeWidth="2"/>
      {vals.map((v,i) => <circle key={i} cx={pad + i*step} cy={y(v)} r="2.5" fill={attColor(v)}/>)}
      {points.map((p,i) => (i % Math.ceil(points.length/6) === 0 || i === points.length-1) &&
        <text key={i} x={pad + i*step} y={H+12} fontSize="9" textAnchor="middle" fill={C.muted}>{p.label}</text>)}
    </svg>
  );
}

function StudentRow({ s, first, onOpen, extra }: { s:any; first:boolean; onOpen:()=>void; extra?:React.ReactNode }) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen}
      style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop:first?'none':`1px solid ${C.border}`, cursor:'pointer' }}>
      <StudentPhoto student={{ name:s.name, profile_image:s.profile_image }} size={34}/>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontWeight:800, fontSize:13.5, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</span>
          {s.at_risk && <span style={{ flexShrink:0, fontSize:9.5, fontWeight:900, padding:'1px 6px', borderRadius:6, backgroundColor:'#fee2e2', color:C.bad }}>AT RISK</span>}
          {s.status === 'Club Member' && <span style={{ flexShrink:0, fontSize:9.5, fontWeight:900, padding:'1px 6px', borderRadius:6, backgroundColor:'#ede9fe', color:'#7c3aed' }}>CLUB</span>}
        </div>
        <div style={{ fontSize:11, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {ids(s) && <span style={{ color:C.green, fontWeight:700 }}>{ids(s)} · </span>}{s.sessions}
          {s.matches ? ` · 🏏 ${s.matches}` : ''}
        </div>
        <div style={{ fontSize:11, marginTop:1, display:'flex', gap:8 }}>
          <span style={{ fontWeight:800, color:s.not_attending ? C.bad : attColor(rowPct(s)) }}>
            {s.not_attending ? `Not seen ${s.last_present ? `since ${new Date(s.last_present+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'})}` : 'yet'}`
              : `${rowPct(s) == null ? '—' : `${Math.round(rowPct(s)!)}%`} ${s.att_basis === '30d' ? 'last 30d' : 'attendance'}`}
          </span>
          {s.fee_status != null && <span style={{ fontWeight:700, color:FEE_COLOR[s.fee_status] || C.muted }}>
            {s.fee_status === 'overdue' ? `Overdue ${fmtAmt(s.overdue_amount)} · ${s.days_overdue}d` : s.fee_status === 'member' ? 'No academy fee' : FEE_LABEL[s.fee_status] || s.fee_status}
          </span>}
        </div>
      </div>
      {extra}
    </div>
  );
}

function WaButton({ s }: { s:any }) {
  const url = waLink(s, feeReminder(s));
  if (!url) return null;
  return (
    <button onClick={e => { e.stopPropagation(); openWa(url); }} aria-label={`Send WhatsApp reminder to ${s.name}`}
      style={{ flexShrink:0, padding:'6px 9px', borderRadius:8, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:800, fontSize:11.5, cursor:'pointer' }}>
      💬 Remind
    </button>
  );
}

function StudentSearch({ students, onPick }: { students:any[]; onPick:(id:number)=>void }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase(); if (!t) return [];
    return students.filter(s => s.name.toLowerCase().includes(t) || fmtRegNo(s.regno).includes(t) || String(s.qca_id || '').includes(t.replace(/^q/,''))).slice(0, 6);
  }, [q, students]);
  return (
    <div style={{ position:'relative' }}>
      <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:13 }}>🔍</span>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a student — name, reg no or QCA ID" aria-label="Find a student"
        style={{ width:'100%', padding:'8px 30px', borderRadius:10, border:`1px solid ${C.border}`, fontSize:13.5, outline:'none', boxSizing:'border-box', backgroundColor:'#fff' }}/>
      {hits.length > 0 && (
        <div style={{ ...CARD, position:'absolute', left:0, right:0, top:'calc(100% + 4px)', zIndex:20, boxShadow:'0 6px 18px rgba(0,0,0,0.12)' }}>
          {hits.map((s,i) => (
            <button key={s.id} onClick={() => { setQ(''); onPick(s.id); }}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'none', border:'none', borderTop:i?`1px solid ${C.border}`:'none', textAlign:'left', cursor:'pointer' }}>
              <span style={{ flex:1, fontSize:13, fontWeight:700, color:C.text }}>{s.name}</span>
              <span style={{ fontSize:11, color:C.green, fontWeight:700 }}>{ids(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MonthBar({ month, setMonth }: { month:string; setMonth:(m:string)=>void }) {
  const atNow = month >= thisMonth();
  const arrow = (on:boolean): React.CSSProperties => ({ width:34, height:30, borderRadius:8, border:'none', fontSize:18, fontWeight:800,
    backgroundColor:on?'#f0f4f0':'transparent', color:on?C.green:'#d1d5db', cursor:on?'pointer':'default' });
  return (
    <div style={{ ...CARD, display:'flex', alignItems:'center', gap:6, padding:'5px 8px' }}>
      <button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month,-1))} style={arrow(true)}>‹</button>
      <span style={{ flex:1, textAlign:'center', fontWeight:800, fontSize:14, color:C.text }}>{monthLabel(month)}</span>
      <button aria-label="Next month" disabled={atNow} onClick={() => setMonth(shiftMonth(month,1))} style={arrow(!atNow)}>›</button>
    </div>
  );
}

const AdminOnly = () => (
  <div style={{ backgroundColor:C.bg, minHeight:'100%' }}>
    <ScreenHeader title="KPI Dashboard"/>
    <div style={{ padding:10 }}><Empty text="🔒 You don't have access to the KPI dashboard. Ask an admin to give your role the “View KPI Dashboard” permission."/></div>
  </div>
);

// ══ Level 1 — Dashboard ═══════════════════════════════════════════════════════
export function KpiDashboard() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const setMonth = (m:string) => setParams(p => { p.set('month', m); return p; }, { replace:true });
  const [tab, setTab] = useState<'overview'|'matches'>('overview');
  const { data, err, loading, reload } = useDashboard(month);
  if (!canKpi()) return <AdminOnly/>;

  const byId: Record<number,any> = Object.fromEntries((data?.students || []).map((s:any) => [s.id, s]));
  const list = (q:string) => nav(`/kpi/list?month=${month}&${q}`);
  const open = (id:number) => nav(`/kpi/student/${id}?month=${month}`);
  const k = data?.kpis;
  const vs = data?.prev_label || 'prev';
  const fees = data?.can_fees !== false;
  const feeParts = ['paid','partial','unpaid','overdue','member'].map(key => ({ key, label: FEE_LABEL[key], value: data?.fee_split?.[key] || 0, color: FEE_COLOR[key] }));

  const ActionList = ({ title, idsList, empty, filter, withWa }: { title:string; idsList:number[]; empty:string; filter:string; withWa?:boolean }) => (<>
    <SectionLabel action={idsList.length > 4 ? `All ${idsList.length}` : undefined} onAction={() => list(filter)}>{title} · {idsList.length}</SectionLabel>
    {idsList.length === 0 ? <Empty text={empty}/> : (
      <div style={CARD}>
        {idsList.slice(0, 4).map((id, i) => byId[id] && <StudentRow key={id} s={byId[id]} first={i===0} onOpen={() => open(id)} extra={withWa ? <WaButton s={byId[id]}/> : undefined}/>)}
      </div>
    )}
  </>);

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title="KPI Dashboard" subtitle={data ? `${monthLabel(month)} · ${data.students.length} students` : 'Academy performance'}
        actions={<HeaderIconButton label="Refresh" onClick={() => reload(true)}>↻</HeaderIconButton>}>
        <HeaderTabs value={tab} onChange={setTab} tabs={[{ id:'overview', label:'📊 Overview' }, { id:'matches', label:'🏏 Matches' }]}/>
      </ScreenHeader>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {data && <StudentSearch students={data.students} onPick={open}/>}
        {tab === 'overview' && <MonthBar month={month} setMonth={setMonth}/>}
        {loading && !data && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading KPIs…</div>}
        {err && (
          <div style={{ ...CARD, padding:'14px', textAlign:'center' }}>
            <div style={{ color:C.bad, fontWeight:800, fontSize:13, marginBottom:8 }}>⚠ {err}</div>
            <button onClick={() => reload(true)} style={{ padding:'7px 16px', borderRadius:9, border:'none', backgroundColor:C.green, color:'#fff', fontWeight:800, cursor:'pointer' }}>Retry</button>
          </div>
        )}

        {data && tab === 'overview' && (<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, opacity: loading ? 0.6 : 1 }}>
            <KpiCard label="Active players" value={k.active_players.value} sub="came in the last 30 days"
              trend={<Trend now={k.active_players.value} prev={k.active_players.prev}/>} onClick={() => list('active=1')}/>
            <KpiCard label="Attendance" value={k.attendance_pct.value == null ? '—' : `${k.attendance_pct.value}%`} color={attColor(k.attendance_pct.value)}
              sub="of expected 3 days/week" trend={<Trend now={k.attendance_pct.value} prev={k.attendance_pct.prev} suffix="%" vs={vs}/>} onClick={() => list('sort=att')}/>
            {fees && <KpiCard label="Fees collected" value={k.fees_collected_pct.value == null ? '—' : `${k.fees_collected_pct.value}%`}
              sub={`${fmtAmt(k.fees_collected_pct.collected)} of ${fmtAmt(k.fees_collected_pct.due)}`}
              trend={<Trend now={k.fees_collected_pct.value} prev={k.fees_collected_pct.prev} suffix="%" vs={vs}/>} onClick={() => list('sort=fee')}/>}
            {fees && <KpiCard label="Overdue" value={fmtAmt(k.overdue_amount.value)} color={k.overdue_amount.value ? C.bad : C.good}
              sub={`${k.overdue_amount.students} student${k.overdue_amount.students===1?'':'s'} · due on the ${data.due_day}th`}
              trend={k.overdue_amount.prev != null ? <Trend now={k.overdue_amount.value} prev={k.overdue_amount.prev} higherIsGood={false} fmt={fmtAmt} vs="30 days ago"/> : undefined}
              onClick={() => list('fee=overdue')}/>}
          </div>

          <SectionLabel>Attendance by session</SectionLabel>
          <div style={{ ...CARD, padding:'8px 12px', display:'flex', flexDirection:'column', gap:8 }}>
            {data.by_session.map((s:any) => (
              <button key={s.session} onClick={() => list(`session=${s.session}`)} style={{ background:'none', border:'none', padding:0, textAlign:'left', cursor:'pointer' }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:12.5, marginBottom:3 }}>
                  <span style={{ fontWeight:800, color:C.text }}>{s.session === 'Morning' ? '🌅' : '🌆'} {s.session} <span style={{ fontWeight:500, color:C.muted }}>· {s.students} students · {s.days} days</span></span>
                  <span style={{ fontWeight:900, color:attColor(s.pct) }}>{s.pct == null ? '—' : `${s.pct}%`} ›</span>
                </div>
                <div style={{ height:9, borderRadius:5, backgroundColor:'#f1f5f9', overflow:'hidden' }}>
                  <div style={{ width:`${Math.min(100, s.pct || 0)}%`, height:'100%', backgroundColor:attColor(s.pct) }}/>
                </div>
              </button>
            ))}
          </div>

          {fees && <SectionLabel>Fee status · {monthLabel(month)}</SectionLabel>}
          {fees && <div style={CARD}><Donut parts={feeParts} onPick={key => list(`fee=${encodeURIComponent(key)}`)}/></div>}

          {fees && data.collection_trend.length > 0 && (<>
            <SectionLabel>Monthly collection{data.in_progress ? ' · * to date' : ''}</SectionLabel>
            <CollectionChart trend={data.collection_trend} month={month} inProgress={data.in_progress}/>
          </>)}

          {fees && <ActionList title="⚠ At risk (low attendance + overdue)" idsList={data.at_risk} empty="No students are both irregular and overdue 👍" filter="risk=1" withWa/>}
          <ActionList title="Irregular (coming, but below 60%)" idsList={data.irregular} empty="Nobody is below 60% attendance 👍" filter="irregular=1"/>
          {data.not_attending && <ActionList title="Not attending (30+ days)" idsList={data.not_attending} empty="Everyone has come in the last 30 days 👍" filter="away=1"/>}
          {fees && <ActionList title="Overdue fees (oldest first)" idsList={data.overdue} empty="No overdue fees 👍" filter="fee=overdue" withWa/>}
          <Note>Attendance counts days present against an expected 3 days a week (100% = 3+); early in the month the lists use the last 30 days.
            Arrows compare with {data.in_progress ? `the same days last month (${vs})` : 'the previous month'}.{fees && ` A month's fee is overdue from the ${data.due_day + 1}th; partial payments still count as owing here, so these totals can be higher than the Payments dues count.`}</Note>
        </>)}

        {data && tab === 'matches' && (() => {
          const lb = data.leaderboard;
          const Board = ({ title, rows, unit }: { title:string; rows:any[]; unit:string }) => (<>
            <SectionLabel>{title}</SectionLabel>
            {rows.length === 0 ? <Empty text="No match stats yet"/> : (
              <div style={CARD}>
                {rows.map((r:any, i:number) => (
                  <button key={r.id} onClick={() => open(r.id)} style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'9px 12px', background:'none', border:'none', borderTop:i?`1px solid ${C.border}`:'none', cursor:'pointer', textAlign:'left' }}>
                    <span style={{ fontSize:18 }}>{['🥇','🥈','🥉'][i]}</span>
                    <span style={{ flex:1, fontWeight:800, fontSize:13.5, color:C.text }}>{r.name}</span>
                    <span style={{ fontWeight:900, fontSize:15, color:C.green }}>{r.value} <span style={{ fontSize:11, color:C.muted, fontWeight:700 }}>{unit}</span></span>
                  </button>
                ))}
              </div>
            )}
          </>);
          const res = lb.results || {};
          return (<>
            <div style={{ ...CARD, display:'flex' }}>
              {[['Played', lb.matches, C.green], ['Won', res.Won || 0, C.good], ['Lost', res.Lost || 0, C.bad],
                ['Other', lb.matches - (res.Won || 0) - (res.Lost || 0), C.muted]].map(([l, v, col]:any, i) => (
                <div key={l} style={{ flex:1, padding:'8px 4px', textAlign:'center', borderLeft:i?`1px solid ${C.border}`:'none' }}>
                  <div style={{ fontSize:18, fontWeight:900, color:col }}>{v}</div>
                  <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase' }}>{l}</div>
                </div>
              ))}
            </div>
            <Board title="Top batters · total runs" rows={lb.batters} unit="runs"/>
            <Board title="Top bowlers · total wickets" rows={lb.bowlers} unit="wkts"/>
            {lb.fielders && <Board title="Top fielders · total catches" rows={lb.fielders} unit="ct"/>}
            <Note>With only {lb.matches} matches so far, totals are shown — averages and strike rates come later.</Note>
          </>);
        })()}
      </div>
    </div>
  );
}

// ══ Level 2 — Filtered list ═══════════════════════════════════════════════════
export function KpiList() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const { data, err, loading, reload } = useDashboard(month);
  if (!canKpi()) return <AdminOnly/>;

  const f = {
    session: params.get('session') || '', fee: params.get('fee') || '', att: params.get('att') || '',
    risk: params.get('risk') === '1', irregular: params.get('irregular') === '1', active: params.get('active') === '1', away: params.get('away') === '1',
    sort: params.get('sort') || 'name',
  };
  const set = (key:string, val:string) => setParams(p => { val ? p.set(key, val) : p.delete(key); return p; }, { replace:true });
  const band = (p:number|null) => p == null ? '' : p > 80 ? 'green' : p >= 60 ? 'amber' : 'red';

  const rows = (data?.students || []).filter((s:any) =>
    (!f.session || s.sessions.includes(f.session)) && (!f.fee || s.fee_status === f.fee) && (!f.att || band(rowPct(s)) === f.att) &&
    (!f.risk || s.at_risk) && (!f.irregular || s.irregular) && (!f.active || s.active) && (!f.away || s.not_attending));
  rows.sort((a:any, b:any) =>
    f.sort === 'att' ? (rowPct(a) ?? -1) - (rowPct(b) ?? -1) :
    f.sort === 'fee' ? b.days_overdue - a.days_overdue || b.overdue_amount - a.overdue_amount :
    f.sort === 'matches' ? b.matches - a.matches : a.name.localeCompare(b.name));

  const title = f.risk ? 'At-risk players' : f.irregular ? 'Irregular players' : f.away ? 'Not attending (30+ days)' : f.active ? 'Active players'
    : f.fee ? `Fees: ${FEE_LABEL[f.fee] || f.fee}` : f.session ? `${f.session} session` : 'All students';
  const Chip = ({ on, onClick, children, color = C.green }: { on:boolean; onClick:()=>void; children:React.ReactNode; color?:string }) => (
    <button onClick={onClick} aria-pressed={on} style={{ flexShrink:0, padding:'5px 10px', borderRadius:16, cursor:'pointer', fontSize:11.5, fontWeight:700, whiteSpace:'nowrap',
      border:`1px solid ${on?color:C.border}`, backgroundColor:on?color:'#fff', color:on?'#fff':'#374151' }}>{children}</button>
  );
  const anyFilter = f.session || f.fee || f.att || f.risk || f.irregular || f.active || f.away;

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title={title} subtitle={data ? `${rows.length} of ${data.students.length} students · ${monthLabel(month)}` : 'Loading…'}
        actions={<HeaderIconButton label="Refresh" onClick={() => reload(true)}>↻</HeaderIconButton>}/>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        <div style={{ ...CARD, padding:10, display:'flex', flexDirection:'column', gap:7 }}>
          <div style={{ display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none' }}>
            <Chip on={!f.session} onClick={() => set('session','')}>All sessions</Chip>
            <Chip on={f.session==='Morning'} onClick={() => set('session','Morning')}>🌅 Morning</Chip>
            <Chip on={f.session==='Evening'} onClick={() => set('session','Evening')}>🌆 Evening</Chip>
          </div>
          {data?.can_fees !== false && <div style={{ display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none' }}>
            <Chip on={!f.fee} onClick={() => set('fee','')}>Any fee status</Chip>
            {['overdue','partial','unpaid','paid','member'].map(k => <Chip key={k} on={f.fee===k} color={FEE_COLOR[k]} onClick={() => set('fee', f.fee===k?'':k)}>{FEE_LABEL[k]}</Chip>)}
          </div>}
          <div style={{ display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none' }}>
            <Chip on={!f.att} onClick={() => set('att','')}>Any attendance</Chip>
            <Chip on={f.att==='red'} color={C.bad} onClick={() => set('att', f.att==='red'?'':'red')}>Below 60%</Chip>
            <Chip on={f.att==='amber'} color={C.warn} onClick={() => set('att', f.att==='amber'?'':'amber')}>60–80%</Chip>
            <Chip on={f.att==='green'} color={C.good} onClick={() => set('att', f.att==='green'?'':'green')}>Above 80%</Chip>
            <Chip on={f.away} color={C.bad} onClick={() => set('away', f.away?'':'1')}>Not attending</Chip>
            {data?.can_fees !== false && <Chip on={f.risk} color={C.bad} onClick={() => set('risk', f.risk?'':'1')}>⚠ At risk only</Chip>}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontSize:11, fontWeight:800, color:C.muted }}>SORT</span>
            <select value={f.sort} onChange={e => set('sort', e.target.value)} aria-label="Sort"
              style={{ flex:1, padding:'5px 8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:12.5, backgroundColor:'#fff' }}>
              <option value="name">Name</option><option value="att">Attendance (lowest first)</option>
              {data?.can_fees !== false && <option value="fee">Overdue (oldest first)</option>}<option value="matches">Matches played</option>
            </select>
            {anyFilter && <button onClick={() => setParams({ month }, { replace:true })} style={{ background:'none', border:'none', color:C.green, fontWeight:800, fontSize:12, cursor:'pointer' }}>Clear</button>}
          </div>
        </div>

        {loading && !data && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading…</div>}
        {err && <Empty text={`⚠ ${err}`}/>}
        {data && (rows.length === 0 ? <Empty text="No students match these filters"/> : (
          <div style={CARD}>
            {rows.map((s:any, i:number) => <StudentRow key={s.id} s={s} first={i===0} onOpen={() => nav(`/kpi/student/${s.id}?month=${month}`)}
              extra={s.fee_status === 'overdue' ? <WaButton s={s}/> : undefined}/>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══ Level 3 — Student profile ═════════════════════════════════════════════════
export function KpiStudent() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setErr('');
    fetch(`${base()}/api/data/kpi/student/${id}?month=${month}`, { headers: apiAuthHeaders(false) })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(
        r.status === 403 ? "You don't have access to the KPI dashboard"
        : r.status === 405 ? 'This server does not have the KPI dashboard yet — update the server'
        : (j.error || `Server error ${r.status}`)); return j; })
      .then(setP).catch(e => setErr(/failed to fetch/i.test(e.message) ? 'Cannot reach the server' : e.message));
  }, [id, month]);
  if (!canKpi()) return <AdminOnly/>;

  const s = p?.student, a = p?.attendance, fee = p?.fees, m = p?.matches;
  const wa = s ? waLink(s, s.fee_status === 'overdue' ? feeReminder(s) : `Hello from Quickies Cricket Academy regarding ${s.name}.`) : null;
  const cell = (label:string, value:React.ReactNode, color:string, first?:boolean) => (
    <div style={{ flex:1, padding:'7px 4px', textAlign:'center', borderLeft:first?'none':`1px solid ${C.border}` }}>
      <div style={{ fontSize:15, fontWeight:900, color }}>{value}</div>
      <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'0.4px' }}>{label}</div>
    </div>
  );
  const th: React.CSSProperties = { fontSize:10, fontWeight:800, color:C.muted, textTransform:'uppercase', padding:'5px 6px', textAlign:'right' };
  const td: React.CSSProperties = { fontSize:12.5, padding:'5px 6px', textAlign:'right', color:C.text };

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title={s?.name || 'Student'} subtitle={s ? [ids(s), s.sessions].filter(Boolean).join(' · ') : 'Loading…'}/>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {err && <Empty text={`⚠ ${err}`}/>}
        {!p && !err && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading profile…</div>}
        {p && (<>
          {/* Header */}
          <div style={{ ...CARD, display:'flex', alignItems:'center', gap:12, padding:12 }}>
            <StudentPhoto student={{ name:s.name, profile_image:s.profile_image }} size={54}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:900, fontSize:16 }}>{s.name}</div>
              <div style={{ fontSize:11.5, color:C.muted, marginTop:1 }}>
                {s.sessions} · joined {s.enrollment_date ? new Date(s.enrollment_date+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—'}
              </div>
              <div style={{ fontSize:11.5, color:C.muted }}>{s.parent_name ? `${s.parent_name} · ` : ''}{s.parent_phone || s.phone || 'no phone'}</div>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
              {(s.parent_phone || s.phone) && <a href={`tel:${String(s.parent_phone || s.phone).replace(/\s/g,'')}`} style={{ padding:'5px 10px', borderRadius:8, backgroundColor:'#f0f4f0', color:C.green, fontWeight:800, fontSize:12, textDecoration:'none', textAlign:'center' }}>📞 Call</a>}
              {wa && <button onClick={() => openWa(wa)} style={{ padding:'5px 10px', borderRadius:8, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer' }}>💬 WhatsApp</button>}
            </div>
          </div>

          {/* Summary */}
          <div style={{ ...CARD, display:'flex' }}>
            {cell(s.att_basis === '30d' ? 'Attend. 30d' : 'Attendance', rowPct(s) == null ? '—' : `${Math.round(rowPct(s)!)}%`, attColor(rowPct(s)), true)}
            {fee && cell('Fees', FEE_LABEL[fee.status] || fee.status, FEE_COLOR[fee.status] || C.muted)}
            {cell('Matches', `${m.played}/${m.total}`, C.green)}
            {fee ? cell('Risk', s.at_risk ? 'At risk' : 'OK', s.at_risk ? C.bad : C.good)
              : cell('Overall', a.overall_pct == null ? '—' : `${Math.round(a.overall_pct)}%`, attColor(a.overall_pct))}
          </div>

          {/* Attendance */}
          <SectionLabel>Attendance</SectionLabel>
          <MonthBar month={month} setMonth={mm => setParams(q => { q.set('month', mm); return q; }, { replace:true })}/>
          {a.absence_alert && (
            <div style={{ padding:'8px 12px', borderRadius:10, backgroundColor:'#fee2e2', border:'1px solid #fca5a5', color:C.bad, fontWeight:800, fontSize:12.5 }}>
              ⚠ Not attended for {a.days_since_present ?? 'many'} days
            </div>
          )}
          <div style={CARD}>
            <div style={{ display:'flex' }}>
              {cell('This month', a.month_pct == null ? '—' : `${Math.round(a.month_pct)}%`, attColor(a.month_pct), true)}
              {cell('Overall', a.overall_pct == null ? '—' : `${Math.round(a.overall_pct)}%`, attColor(a.overall_pct))}
              {cell(a.streak.kind === 'present' ? 'In a row' : 'Missed in a row', a.streak.count || '—', a.streak.kind === 'present' ? C.good : C.warn)}
              {cell('Last came', a.days_since_present == null ? '—' : a.days_since_present === 0 ? 'Today' : `${a.days_since_present}d ago`, (a.days_since_present ?? 99) >= 7 ? C.bad : C.text)}
            </div>
            <div style={{ fontSize:11, color:C.muted, padding:'4px 12px', borderTop:`1px solid ${C.border}` }}>
              {a.month_present} days present of {a.month_days} expected this month (3 days/week)
            </div>
          </div>
          {/* Calendar heatmap, Monday first */}
          <div style={{ ...CARD, padding:10 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:4 }}>
              {['M','T','W','T','F','S','S'].map((d,i) => <div key={i} style={{ textAlign:'center', fontSize:10, fontWeight:800, color:C.muted }}>{d}</div>)}
              {Array.from({ length: (new Date(a.calendar[0].date+'T00:00:00').getDay() + 6) % 7 }).map((_,i) => <div key={`e${i}`}/>)}
              {a.calendar.map((c:any) => {
                const bg = c.state === 'present' ? C.good : c.state === 'absent' ? '#fca5a5' : c.state === 'future' ? 'transparent' : '#eef0f2';
                return <div key={c.date} title={`${c.date}: ${c.state}`} style={{ aspectRatio:'1', borderRadius:6, backgroundColor:bg,
                  border: c.state === 'future' ? `1px dashed ${C.border}` : 'none', display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:10.5, fontWeight:700, color: c.state === 'present' ? '#fff' : C.muted }}>{Number(c.date.slice(8))}</div>;
              })}
            </div>
            <div style={{ display:'flex', gap:12, justifyContent:'center', marginTop:8, fontSize:10.5, color:C.muted }}>
              <span><span style={{ display:'inline-block', width:9, height:9, borderRadius:2, backgroundColor:C.good, marginRight:4 }}/>Present</span>
              <span><span style={{ display:'inline-block', width:9, height:9, borderRadius:2, backgroundColor:'#fca5a5', marginRight:4 }}/>Session, not attended</span>
              <span><span style={{ display:'inline-block', width:9, height:9, borderRadius:2, backgroundColor:'#eef0f2', marginRight:4 }}/>No session</span>
            </div>
          </div>
          {a.trend.length >= 2 && (
            <div style={{ ...CARD, padding:'8px 10px' }}>
              <div style={{ fontSize:11, fontWeight:800, color:C.muted, marginBottom:2 }}>Monthly attendance (dashed line = 60%)</div>
              <Spark points={a.trend.map((t:any) => ({ label: monthLabel(t.month, false), value: t.pct }))}/>
            </div>
          )}

          {/* Fees (only for users who may see payments) */}
          {fee && (<>
          <SectionLabel>Fees</SectionLabel>
          <div style={CARD}>
            <div style={{ display:'flex' }}>
              {cell('Status', FEE_LABEL[fee.status] || fee.status, FEE_COLOR[fee.status] || C.muted, true)}
              {cell('Total paid', fmtAmt(fee.total_paid), C.green)}
              {cell('Overdue', fmtAmt(fee.total_due), fee.total_due ? C.bad : C.good)}
              {cell('Next due', fee.next_due_date ? new Date(fee.next_due_date+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—', C.text)}
            </div>
            {fee.joining_paid && !fee.month_rows?.length && s.status !== 'Club Member' && (
              <div style={{ fontSize:11, color:C.muted, padding:'5px 12px', borderTop:`1px solid ${C.border}` }}>
                Admission / registration fee paid — covers the first months (billing starts in the 3rd month).
              </div>
            )}
          </div>
          {fee.month_rows?.length > 0 ? (
            <div style={{ ...CARD, overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', minWidth:300 }}>
                <thead><tr style={{ backgroundColor:'#fafafa' }}>
                  <th style={{ ...th, textAlign:'left', paddingLeft:12 }}>Month</th><th style={{ ...th, textAlign:'left' }}>Status</th>
                  <th style={th}>Paid</th><th style={{ ...th, paddingRight:12 }}>Paid on</th>
                </tr></thead>
                <tbody>{fee.month_rows.map((mm:any) => {
                  const settled = mm.status === 'paid' || mm.status === 'written off';
                  const col = settled ? C.good : mm.overdue ? C.bad : mm.status === 'partial' ? C.warn : C.muted;
                  const label = mm.status === 'written off' ? 'Written off' : settled ? 'Paid'
                    : mm.overdue ? `Overdue ${mm.days_overdue}d` : mm.status === 'partial' ? 'Partial' : `Due ${Number(mm.due_date.slice(8))} ${monthLabel(mm.month, false)}`;
                  return (
                    <tr key={mm.month} style={{ borderTop:`1px solid ${C.border}`, backgroundColor: mm.overdue ? '#fef2f2' : undefined }}>
                      <td style={{ ...td, textAlign:'left', paddingLeft:12, fontWeight:700 }}>{monthLabel(mm.month, false)} {mm.month.slice(2,4)}</td>
                      <td style={{ ...td, textAlign:'left', fontWeight:800, color:col }}>{label}</td>
                      <td style={td}>{fmtAmt(mm.paid)}{!settled && <span style={{ color:C.muted }}> / {fmtAmt(mm.due)}</span>}</td>
                      <td style={{ ...td, paddingRight:12, color:C.muted }}>
                        {mm.paid_on ? new Date(mm.paid_on+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—'}{mm.mode ? ` · ${mm.mode}` : ''}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          ) : !fee.joining_payments?.length && fee.history.length > 0 && (
            <div style={{ ...CARD, overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', minWidth:300 }}>
                <thead><tr style={{ backgroundColor:'#fafafa' }}>
                  <th style={{ ...th, textAlign:'left', paddingLeft:12 }}>Month</th><th style={th}>Amount</th><th style={th}>Paid on</th><th style={{ ...th, paddingRight:12 }}>Mode</th>
                </tr></thead>
                <tbody>{fee.history.map((h:any, i:number) => (
                  <tr key={i} style={{ borderTop:`1px solid ${C.border}` }}>
                    <td style={{ ...td, textAlign:'left', paddingLeft:12, fontWeight:700 }}>{/^\d{4}-\d{2}$/.test(h.month) ? monthLabel(h.month, false) + ' ' + h.month.slice(2,4) : h.month}</td>
                    <td style={td}>{fmtAmt(h.amount)}</td>
                    <td style={td}>{h.date ? new Date(h.date+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—'}</td>
                    <td style={{ ...td, paddingRight:12 }}>{h.mode || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {fee.joining_payments?.length > 0 && (
            <div style={CARD}>
              <div style={{ fontSize:10, fontWeight:800, color:C.muted, textTransform:'uppercase', padding:'6px 12px', backgroundColor:'#fafafa' }}>Joining fees</div>
              {fee.joining_payments.map((j:any, i:number) => (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', borderTop:`1px solid ${C.border}`, fontSize:12.5 }}>
                  <span style={{ flex:1, fontWeight:700, color:C.text }}>{j.type}</span>
                  <span style={{ fontWeight:800 }}>{fmtAmt(j.amount)}</span>
                  <span style={{ color:C.muted, minWidth:96, textAlign:'right' }}>
                    {j.date ? new Date(j.date+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'}) : '—'}{j.mode ? ` · ${j.mode}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          {fee.status === 'overdue' && wa && (
            <button onClick={() => openWa(wa)} style={{ padding:'10px', borderRadius:11, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:900, fontSize:14, cursor:'pointer' }}>
              💬 Send fee reminder on WhatsApp
            </button>
          )}

          </>)}

          {/* Matches */}
          <SectionLabel>Matches</SectionLabel>
          <div style={CARD}>
            <div style={{ display:'flex' }}>
              {cell('Played', `${m.played}/${m.total}`, C.green, true)}
              {cell('Runs', m.runs, C.text)}
              {cell('Wickets', m.wickets, C.text)}
              {cell('Catches', m.catches, C.text)}
            </div>
            {(m.rank_runs || m.rank_wickets) && (
              <div style={{ fontSize:11.5, color:C.muted, padding:'5px 12px', borderTop:`1px solid ${C.border}` }}>
                {m.rank_runs ? `#${m.rank_runs} in runs` : ''}{m.rank_runs && m.rank_wickets ? ' · ' : ''}{m.rank_wickets ? `#${m.rank_wickets} in wickets` : ''} across the academy
              </div>
            )}
          </div>
          {m.per_match.length > 0 ? (
            <div style={{ ...CARD, overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', minWidth:300 }}>
                <thead><tr style={{ backgroundColor:'#fafafa' }}>
                  <th style={{ ...th, textAlign:'left', paddingLeft:12 }}>Match</th><th style={th}>R (B)</th><th style={th}>W</th><th style={{ ...th, paddingRight:12 }}>Ct</th>
                </tr></thead>
                <tbody>{m.per_match.map((x:any) => (
                  <tr key={x.match_id} style={{ borderTop:`1px solid ${C.border}` }}>
                    <td style={{ ...td, textAlign:'left', paddingLeft:12 }}>
                      <div style={{ fontWeight:700 }}>vs {x.opponent}</div>
                      <div style={{ fontSize:10.5, color:C.muted }}>{x.date ? new Date(x.date.slice(0,10)+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'}) : ''}{x.result ? ` · ${x.result}` : ''}</div>
                    </td>
                    <td style={{ ...td, fontWeight:800 }}>{x.runs} <span style={{ color:C.muted, fontWeight:500 }}>({x.balls})</span></td>
                    <td style={{ ...td, fontWeight:800 }}>{x.wickets}</td>
                    <td style={{ ...td, paddingRight:12 }}>{x.catches}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <Empty text="Hasn't played a recorded match yet"/>}
        </>)}
      </div>
    </div>
  );
}
