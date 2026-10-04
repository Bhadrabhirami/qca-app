/**
 * utilities.tsx — Admin Utilities
 * Four tabs: Students · Attendance · Payments · Monthly Report
 * Admin-only. Reads directly from server — no local cache.
 */

import { matchesStudentSearch, formatRegno } from './studentUtils';
import { getAllStudents, getCachedImageUrl, getCachedMemberImageUrl } from '../database/db';
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  navy:'#001f3f', gold:'#c5a059', green:'#1a472a',
  red:'#dc2626', blue:'#2563eb', bg:'#f0f2f5',
  card:'#fff', border:'#e5e7eb', muted:'#6b7280',
};

function bld(ip:string){const h=(ip||'').trim().replace(/\/+$/,'');return h.startsWith('http')?h:`http://${h}`;}
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
function today(){return new Date().toISOString().split('T')[0];}
function monthAgo(){const d=new Date();d.setMonth(d.getMonth()-1);return d.toISOString().split('T')[0];}
function currMonth(){return new Date().toISOString().slice(0,7);}
function fmtAmt(n:number){return`₹${(n||0).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:0})}`;}
/** Short money for tight stats: ₹1.13L, ₹57.0K, ₹850 (full amount goes in a tooltip) */
function fmtShort(n:number){const v=n||0;return v>=1e5?`₹${(v/1e5).toFixed(2)}L`:v>=1e4?`₹${(v/1e3).toFixed(1)}K`:fmtAmt(v);}
/** Reg no as "001"; non-numeric reg nos (club members) shown as-is, placeholders dropped */
function fmtReg(r:any):string{const t=String(r??'').trim();if(!t||t==='—'||t==='-')return'';const n=parseInt(t,10);return isNaN(n)?t:String(n).padStart(3,'0');}
/** "001 · Q030" — reg no and QCA ID, as on the other screens */
function studentIds(s:any):string{return[fmtReg(s.regno),s.qca_id?`Q${String(s.qca_id).padStart(3,'0')}`:''].filter(Boolean).join(' · ');}

// ── Shared components ─────────────────────────────────────────────────────────
// One white card holding hairline-separated rows
const LIST_CARD: React.CSSProperties = { backgroundColor: C.card, borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}` };

function Pill({label,value,color,title}:{label:string;value:string|number;color:string;title?:string}){
  return(
    <div title={title} style={{flex:1,minWidth:0,backgroundColor:C.card,borderRadius:10,padding:'7px 4px 6px',
      textAlign:'center' as const,border:`1px solid ${C.border}`,boxShadow:`inset 0 -3px 0 ${color}`}}>
      <div style={{fontWeight:900,fontSize:15,color,lineHeight:1.15,whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>{value}</div>
      <div style={{fontSize:9,color:C.muted,fontWeight:700,textTransform:'uppercase' as const,letterSpacing:'0.3px',marginTop:2,whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>{label}</div>
    </div>
  );
}
function ErrBox({msg}:{msg:string}){
  return msg?<div style={{padding:'8px 12px',borderRadius:10,margin:'8px 10px',backgroundColor:'#fee2e2',color:C.red,fontWeight:700,fontSize:13}}>{msg}</div>:null;
}
function LoadBtn({loading,onClick,label,disabled}:{loading:boolean;onClick:()=>void;label:string;disabled?:boolean}){
  return(
    <button onClick={onClick} disabled={loading||disabled}
      style={{flex:2,padding:'9px',borderRadius:10,border:'none',
        backgroundColor:loading||disabled?'#9ca3af':C.green,
        color:'#fff',fontWeight:800,fontSize:13,cursor:loading||disabled?'not-allowed':'pointer'}}>
      {loading?'⏳ Loading…':label}
    </button>
  );
}
function ResetBtn({onClick}:{onClick:()=>void}){
  return(
    <button onClick={onClick}
      style={{flex:1,padding:'9px',borderRadius:10,border:`1px solid ${C.border}`,
        backgroundColor:C.card,color:C.muted,fontWeight:700,fontSize:12,cursor:'pointer'}}>
      Reset
    </button>
  );
}
function DateRow({fromVal,toVal,onFrom,onTo}:{fromVal:string;toVal:string;onFrom:(v:string)=>void;onTo:(v:string)=>void}){
  const inp={flex:1,minWidth:0,padding:'7px 8px',borderRadius:9,border:`1.5px solid ${C.border}`,fontSize:13,outline:'none',boxSizing:'border-box' as const};
  return(
    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
      <input type="date" aria-label="From date" value={fromVal} onChange={e=>onFrom(e.target.value)} style={inp}/>
      <span style={{fontSize:12,color:C.muted}}>to</span>
      <input type="date" aria-label="To date" value={toVal} onChange={e=>onTo(e.target.value)} style={inp}/>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 1 — STUDENTS
// ══════════════════════════════════════════════════════════════════════════════
function StudentsTab({base}:{base:string}){
  const [rows,   setRows]   = useState<any[]>([]);
  const [summary,setSummary]= useState<Record<string,number>>({});
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [level,  setLevel]  = useState('');
  const [loading,setLoading]= useState(false);
  const [msg,    setMsg]    = useState('');
  const [fetched,setFetched]= useState(false);

  const load=useCallback(async()=>{
    setLoading(true);setMsg('');
    try{
      const p=new URLSearchParams({limit:'500'});
      if(search) p.set('search',search);
      if(status) p.set('status',status);
      if(level)  p.set('level',level);
      const r=await fetch(`${base}/api/data/utils/students?${p}`,{headers:hdr()});
      const j=await r.json();
      if(r.ok){setRows(j.data||[]);setSummary(j.summary||{});setFetched(true);}
      else setMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{setMsg('⚠ Cannot reach server');}
    finally{setLoading(false);}
  },[search,status,level]);

  const reset=()=>{setSearch('');setStatus('');setLevel('');setRows([]);setFetched(false);};

  const STATUSES=['','Active','Inactive','Club Member','Left'];
  const LEVELS=['','Beginner','Intermediate','Advanced','Elite'];

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:80}}>
      {/* Filters */}
      <div style={{backgroundColor:C.card,borderBottom:`1px solid ${C.border}`,padding:'8px 12px'}}>
        <div style={{position:'relative',marginBottom:8}}>
          <span style={{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',fontSize:13,color:C.muted}}>🔍</span>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&load()}
            placeholder="Name or Reg No…"
            style={{width:'100%',padding:'7px 12px 7px 30px',borderRadius:10,
              border:`1.5px solid ${C.border}`,fontSize:13,outline:'none',boxSizing:'border-box' as const}}/>
        </div>
        <div style={{display:'flex',gap:6,marginBottom:8,overflowX:'auto' as const,scrollbarWidth:'none' as any}}>
          {STATUSES.map(s=>(
            <button key={s||'all'} onClick={()=>setStatus(s)}
              style={{padding:'4px 12px',borderRadius:16,border:'none',cursor:'pointer',
                fontSize:11,fontWeight:800,whiteSpace:'nowrap' as const,flexShrink:0,
                backgroundColor:status===s?C.navy:'#f3f4f6',
                color:status===s?C.gold:C.muted}}>
              {s||'All Status'}
            </button>
          ))}
        </div>
        <div style={{display:'flex',gap:6,marginBottom:8,overflowX:'auto' as const,scrollbarWidth:'none' as any}}>
          {LEVELS.map(l=>(
            <button key={l||'all'} onClick={()=>setLevel(l)}
              style={{padding:'4px 12px',borderRadius:16,border:'none',cursor:'pointer',
                fontSize:11,fontWeight:800,whiteSpace:'nowrap' as const,flexShrink:0,
                backgroundColor:level===l?C.green:'#f3f4f6',
                color:level===l?'#fff':C.muted}}>
              {l||'All Levels'}
            </button>
          ))}
        </div>
        <div style={{display:'flex',gap:8}}>
          <LoadBtn loading={loading} onClick={load} label="🔍 Load Students"/>
          <ResetBtn onClick={reset}/>
        </div>
      </div>

      <ErrBox msg={msg}/>

      {/* Summary pills */}
      {Object.keys(summary).length>0&&(
        <div style={{display:'flex',gap:6,padding:'8px 10px 0',overflowX:'auto' as const}}>
          {Object.entries(summary).map(([k,v])=>(
            <Pill key={k} label={k||'Active'} value={v} color={C.navy}/>
          ))}
        </div>
      )}

      {/* Results */}
      {fetched&&(
        <div style={{padding:'8px 14px 4px',fontSize:12,color:C.muted}}>
          {rows.length} students
        </div>
      )}

      <div style={{padding:'0 10px'}}>
        {rows.length>0&&(
        <div style={LIST_CARD}>
        {rows.map((s,i)=>(
          <div key={s.id} title={s.email||undefined} style={{display:'flex',alignItems:'center',gap:10,
            padding:'7px 12px',borderTop:i?`1px solid ${C.border}`:'none'}}>
            <MemberAvatar item={s} size={38}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <div style={{fontWeight:700,fontSize:14,color:'#111',flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</div>
                <span style={{padding:'1px 7px',borderRadius:10,fontSize:9.5,fontWeight:800,flexShrink:0,
                  backgroundColor:s.status==='Active'||!s.status?'#dcfce7':s.status==='Club Member'?'#f3f4f6':'#fee2e2',
                  color:s.status==='Active'||!s.status?'#166534':s.status==='Club Member'?'#374151':'#dc2626'}}>
                  {s.status||'Active'}
                </span>
              </div>
              <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                <span style={{color:'#1a472a',fontWeight:700}}>{studentIds(s)||'—'}</span> · {s.level||'—'}{s.phone?` · ${s.phone}`:''}
              </div>
              <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                {s.student_type||'—'} · {fmtAmt(s.monthly_fee)}/mo{s.enrollment_date?` · since ${s.enrollment_date}`:''}{s.school_name?` · ${s.school_name}`:''}
              </div>
            </div>
          </div>
        ))}
        </div>
        )}
        {fetched&&rows.length===0&&(
          <div style={{textAlign:'center' as const,padding:'40px 20px',color:C.muted}}>
            <div style={{fontSize:36,marginBottom:8}}>👥</div>
            <div style={{fontWeight:700,fontSize:14}}>No students found</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 2 — ATTENDANCE
// ══════════════════════════════════════════════════════════════════════════════
function AttendanceTab({base}:{base:string}){
  const [rows,    setRows]    = useState<any[]>([]);
  const [sessSumm,setSessSumm]= useState<Record<string,number>>({});
  const [coaches, setCoaches] = useState<string[]>([]);
  const [from,    setFrom]    = useState(monthAgo());
  const [to,      setTo]      = useState(today());
  const [session, setSession] = useState('');
  const [coach,   setCoach]   = useState('');
  const [loading, setLoading] = useState(false);
  const [msg,     setMsg]     = useState('');
  const [fetched, setFetched] = useState(false);

  const load=useCallback(async()=>{
    setLoading(true);setMsg('');
    try{
      const p=new URLSearchParams({date_from:from,date_to:to});
      if(session) p.set('session',session);
      if(coach)   p.set('uploaded_by',coach);
      const r=await fetch(`${base}/api/data/utils/attendance?${p}`,{headers:hdr()});
      const j=await r.json();
      if(r.ok){
        setRows(j.data||[]);
        setSessSumm(j.session_summary||{});
        setCoaches(j.coaches||[]);
        setFetched(true);
      }else setMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{setMsg('⚠ Cannot reach server');}
    finally{setLoading(false);}
  },[from,to,session,coach]);

  const reset=()=>{setFrom(monthAgo());setTo(today());setSession('');setCoach('');setRows([]);setFetched(false);};

  // Group rows by date+session
  const grouped = rows.reduce((g,r)=>{
    const key=`${r.date}|${r.session}`;
    if(!g[key]) g[key]={date:r.date,session:r.session,students:[]};
    g[key].students.push(r);
    return g;
  },{} as Record<string,any>);

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:80}}>
      <div style={{backgroundColor:C.card,borderBottom:`1px solid ${C.border}`,padding:'8px 12px'}}>
        <DateRow fromVal={from} toVal={to} onFrom={setFrom} onTo={setTo}/>
        <div style={{display:'flex',gap:6,marginBottom:10}}>
          {['','Morning','Evening'].map(s=>(
            <button key={s||'all'} onClick={()=>setSession(s)}
              style={{padding:'4px 12px',borderRadius:16,border:'none',cursor:'pointer',
                fontSize:11,fontWeight:800,
                backgroundColor:session===s?C.navy:'#f3f4f6',
                color:session===s?C.gold:C.muted}}>
              {s||'All Sessions'}
            </button>
          ))}
        </div>
        {coaches.length>0&&(
          <div style={{display:'flex',gap:6,marginBottom:8,overflowX:'auto' as const,scrollbarWidth:'none' as any}}>
            <button onClick={()=>setCoach('')}
              style={{padding:'4px 12px',borderRadius:16,border:'none',cursor:'pointer',
                fontSize:11,fontWeight:800,whiteSpace:'nowrap' as const,flexShrink:0,
                backgroundColor:coach===''?C.green:'#f3f4f6',
                color:coach===''?'#fff':C.muted}}>All Coaches</button>
            {coaches.map(c=>(
              <button key={c} onClick={()=>setCoach(c)}
                style={{padding:'4px 12px',borderRadius:16,border:'none',cursor:'pointer',
                  fontSize:11,fontWeight:800,whiteSpace:'nowrap' as const,flexShrink:0,
                  backgroundColor:coach===c?C.green:'#f3f4f6',
                  color:coach===c?'#fff':C.muted}}>{c}</button>
            ))}
          </div>
        )}
        <div style={{display:'flex',gap:8}}>
          <LoadBtn loading={loading} onClick={load} label="🔍 Load Attendance"/>
          <ResetBtn onClick={reset}/>
        </div>
      </div>

      <ErrBox msg={msg}/>

      {fetched&&(
        <div style={{padding:'8px 14px 4px',fontSize:12,color:C.muted}}>
          {rows.length} records · {Object.keys(grouped).length} sessions
        </div>
      )}

      <div style={{padding:'4px 16px 0'}}>
        {Object.values(grouped).sort((a:any,b:any)=>
          `${a.date}${a.session}`.localeCompare(`${b.date}${b.session}`)
        ).map((g:any)=>(
          <div key={`${g.date}${g.session}`} style={{backgroundColor:C.card,borderRadius:14,
            marginBottom:8,border:`1px solid ${C.border}`,overflow:'hidden'}}>
            {/* Session header */}
            <div style={{backgroundColor:C.navy,padding:'7px 12px',
              display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{color:'#fff',fontWeight:800,fontSize:13}}>
                📅 {g.date} · {g.session}
              </div>
              <span style={{backgroundColor:C.gold,color:C.navy,borderRadius:12,
                padding:'2px 10px',fontSize:11,fontWeight:900}}>
                ✓ {g.students.length}
              </span>
            </div>
            {/* Students in session */}
            <div style={{padding:'2px 12px'}}>
              {g.students.map((s:any,i:number)=>(
                <div key={s.id} style={{display:'flex',justifyContent:'space-between',
                  alignItems:'center',padding:'5px 0',
                  borderBottom:i<g.students.length-1?`1px solid ${C.border}`:'none'}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <MemberAvatar item={{name:s.student_name||'?',profile_image:s.profile_image||null}} size={32}/>
                    <span style={{fontWeight:800,fontSize:11,color:'#1a472a',marginRight:6}}>{studentIds(s)||'—'}</span>
                    <span style={{fontWeight:600,fontSize:13}}>{s.student_name||'—'}</span>
                  </div>
                  <span style={{fontSize:10,color:C.muted}}>{s.uploaded_by}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {fetched&&Object.keys(grouped).length===0&&(
          <div style={{textAlign:'center' as const,padding:'40px 20px',color:C.muted}}>
            <div style={{fontSize:36,marginBottom:8}}>📋</div>
            <div style={{fontWeight:700,fontSize:14}}>No attendance records found</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 3 — PAYMENTS
// ══════════════════════════════════════════════════════════════════════════════
function PaymentsTab({base}:{base:string}){
  const [rows,    setRows]    = useState<any[]>([]);
  const [total,   setTotal]   = useState(0);
  const [income,  setIncome]  = useState(0);
  const [expense, setExpense] = useState(0);
  const [from,    setFrom]    = useState(monthAgo());
  const [to,      setTo]      = useState(today());
  const [billing, setBilling] = useState('');
  const [mode,    setMode]    = useState('');
  const [loading, setLoading] = useState(false);
  const [msg,     setMsg]     = useState('');
  const [fetched, setFetched] = useState(false);

  const load=useCallback(async()=>{
    setLoading(true);setMsg('');
    try{
      const p=new URLSearchParams({date_from:from,date_to:to,limit:'500'});
      if(billing) p.set('billing_month',billing);
      if(mode)    p.set('mode',mode);
      const r=await fetch(`${base}/api/data/utils/payments?${p}`,{headers:hdr()});
      const j=await r.json();
      if(r.ok){setRows(j.data||[]);setTotal(j.total||j.total_amount||0);setIncome(j.income||j.total_amount||0);setExpense(j.expense||0);setFetched(true);}
      else setMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{setMsg('⚠ Cannot reach server');}
    finally{setLoading(false);}
  },[from,to,billing,mode]);

  const reset=()=>{setFrom(monthAgo());setTo(today());setBilling('');setMode('');setRows([]);setFetched(false);};

  const MODES=['','Cash','UPI','Bank Transfer','Card','Online'];

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:80}}>
      <div style={{backgroundColor:C.card,borderBottom:`1px solid ${C.border}`,padding:'8px 12px'}}>
        <DateRow fromVal={from} toVal={to} onFrom={setFrom} onTo={setTo}/>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,fontWeight:800,color:C.muted,textTransform:'uppercase' as const,
            letterSpacing:'0.5px',marginBottom:4}}>Billing Month</div>
          <input value={billing} onChange={e=>setBilling(e.target.value)}
            placeholder="e.g. Jun-26 (optional)"
            style={{width:'100%',padding:'9px 12px',borderRadius:10,
              border:`1.5px solid ${C.border}`,fontSize:13,outline:'none',
              boxSizing:'border-box' as const}}/>
        </div>
        <div style={{display:'flex',gap:6,marginBottom:8,overflowX:'auto' as const,scrollbarWidth:'none' as any}}>
          {MODES.map(m=>(
            <button key={m||'all'} onClick={()=>setMode(m)}
              style={{padding:'4px 12px',borderRadius:16,border:'none',cursor:'pointer',
                fontSize:11,fontWeight:800,whiteSpace:'nowrap' as const,flexShrink:0,
                backgroundColor:mode===m?C.navy:'#f3f4f6',
                color:mode===m?C.gold:C.muted}}>
              {m||'All Modes'}
            </button>
          ))}
        </div>
        <div style={{display:'flex',gap:8}}>
          <LoadBtn loading={loading} onClick={load} label="🔍 Load Payments"/>
          <ResetBtn onClick={reset}/>
        </div>
      </div>

      <ErrBox msg={msg}/>

      {fetched&&(
        <div style={{display:'flex',gap:6,padding:'8px 10px 0'}}>
          <Pill label="Payments" value={rows.length} color={C.navy}/>
          <Pill label="Income" value={fmtAmt(income)} color={C.green}/>
          {expense>0&&<Pill label="Expense" value={fmtAmt(expense)} color="#dc2626"/>}
          {expense>0&&<Pill label="Net" value={fmtAmt(total)} color="#7c3aed"/>}
        </div>
      )}

      <div style={{padding:'8px 10px 0'}}>
        {rows.length>0&&(
        <div style={LIST_CARD}>
        {rows.map((r,i)=>(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:10,
            padding:'7px 12px',borderTop:i?`1px solid ${C.border}`:'none'}}>
            <MemberAvatar item={{name:r.student_name||'?',profile_image:r.profile_image||null}} size={36}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14,color:'#111',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{r.student_name||'—'}</div>
              <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                <span style={{color:'#1a472a',fontWeight:700}}>{studentIds(r)||'—'}</span> · 🧾 {r.receipt_no||'—'} · {r.payment_mode||'—'}
              </div>
              <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                {r.fee_type||'Standard Fee'} · {r.billing_month||'—'}
              </div>
            </div>
            <div style={{textAlign:'right' as const,flexShrink:0}}>
              <div style={{fontWeight:900,fontSize:14,
                color:(r.txn_type||'INCOME')==='EXPENSE'?'#dc2626':C.green}}>
                {(r.txn_type||'INCOME')==='EXPENSE'?'− ':'+ '}{fmtAmt(r.amount_paid)}
              </div>
              <div style={{fontSize:10,color:C.muted,marginTop:2}}>{r.payment_date}</div>
            </div>
          </div>
        ))}
        </div>
        )}
        {fetched&&rows.length===0&&(
          <div style={{textAlign:'center' as const,padding:'40px 20px',color:C.muted}}>
            <div style={{fontSize:36,marginBottom:8}}>💰</div>
            <div style={{fontWeight:700,fontSize:14}}>No payments found</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 4 — MONTHLY REPORT
// ══════════════════════════════════════════════════════════════════════════════
function MonthlyReportTab({base}:{base:string}){
  const { can } = usePermissions();
  const canRoster   = can('utils:students' as any);
  const canPayments = can('utils:payments' as any);
  const [data,      setData]     = useState<any>(null);
  const [month,     setMonth]    = useState(currMonth());
  const [hideZero,  setHideZero] = useState(false);
  const [tab,       setTab]      = useState<'roster'|'payments'|'unpaid'>(canRoster ? 'roster' : 'payments');
  const [loading,   setLoading]  = useState(false);
  const [msg,       setMsg]      = useState('');
  const [exporting, setExporting] = useState(false);

  const exportPdf = useCallback(async (withPayment=true) => {
    if (exporting) return;
    setExporting(true);
    try {
      const p = new URLSearchParams({ month, hide_zero_attendance: hideZero ? '1' : '0' });
      const r = await fetch(`${base}/api/data/utils/monthly-report/roster-pdf?${p}&include_payment=${withPayment?1:0}`, { headers: hdr() });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error||`Server ${r.status}`); }
      const buf   = await r.arrayBuffer();
      const uint8 = new Uint8Array(buf);
      let bin = ''; uint8.forEach(b => { bin += String.fromCharCode(b); });
      const b64  = btoa(bin);
      const name = `roster_${month}${withPayment?'':'_attendance'}.pdf`;
      const saved = await Filesystem.writeFile({ path: name, data: b64, directory: Directory.Cache });
      await Share.share({ title: `Roster ${month}`, text: `Attendance Roster ${month}`, url: saved.uri, dialogTitle: 'Share Roster PDF' });
    } catch (err: any) {
      alert('Export failed: ' + (err?.message || String(err)));
    } finally { setExporting(false); }
  }, [exporting, base, month, hideZero]);

  const load=useCallback(async()=>{
    setLoading(true);setMsg('');
    try{
      const p=new URLSearchParams({month,hide_zero_attendance:hideZero?'1':'0'});
      const r=await fetch(`${base}/api/data/utils/monthly-report?${p}`,{headers:hdr()});
      const j=await r.json();
      if(r.ok) setData(j);
      else setMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{setMsg('⚠ Cannot reach server');}
    finally{setLoading(false);}
  },[month,hideZero]);

  const sum = data?.summary;

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:80}}>
      <div style={{backgroundColor:C.card,borderBottom:`1px solid ${C.border}`,padding:'8px 12px'}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr auto',gap:10,marginBottom:10,alignItems:'flex-end'}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.muted,textTransform:'uppercase' as const,
              letterSpacing:'0.5px',marginBottom:4}}>Month</div>
            <input type="month" value={month} onChange={e=>setMonth(e.target.value)}
              style={{width:'100%',padding:'9px 12px',borderRadius:10,
                border:`1.5px solid ${C.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const}}/>
          </div>
          <button onClick={()=>setHideZero(v=>!v)}
            style={{padding:'9px 14px',borderRadius:10,border:`1.5px solid ${hideZero?C.green:C.border}`,
              backgroundColor:hideZero?'#f0fdf4':C.card,cursor:'pointer',
              color:hideZero?C.green:C.muted,fontWeight:700,fontSize:12}}>
            {hideZero?'✓ Hide Zero':'Hide Zero Att.'}
          </button>
        </div>
        <div style={{display:'flex',gap:8}}>
          <LoadBtn loading={loading} onClick={load} label="📊 Generate Report"/>
        </div>
      </div>

      <ErrBox msg={msg}/>

      {sum&&(
        <>
          {/* Summary */}
          <div style={{display:'flex',gap:5,padding:'8px 10px 0'}}>
            <Pill label="Students"  value={sum.total_students}  color={C.navy}/>
            <Pill label="Sessions"  value={sum.total_sessions}  color={C.blue}/>
            <Pill label="Payments"  value={sum.total_payments}  color={C.green}/>
            <Pill label="Revenue"   value={fmtShort(sum.total_revenue)} color={C.green} title={fmtAmt(sum.total_revenue)}/>
            <Pill label="Unpaid"    value={sum.unpaid_students} color={C.red}/>
          </div>

          {/* Sub-tabs */}
          <div style={{display:'flex',margin:'8px 10px 0',backgroundColor:'rgba(0,0,0,0.06)',
            borderRadius:10,padding:3}}>
            {([['roster','📋 Roster','utils:students'],['payments','💰 Payments','utils:payments'],['unpaid','🔴 Unpaid','utils:payments']] as const)
              .filter(([,,slug]) => can(slug as any))
              .map(([k,label])=>(
              <button key={k} onClick={()=>setTab(k as 'roster'|'payments'|'unpaid')}
                style={{flex:1,padding:'6px 0',borderRadius:8,border:'none',cursor:'pointer',
                  fontWeight:700,fontSize:12,
                  backgroundColor:tab===k?C.card:'transparent',
                  color:tab===k?C.navy:C.muted}}>
                {label}
              </button>
            ))}
          </div>

          {/* Roster */}
          {tab==='roster'&&canRoster&&(
            <div style={{padding:'8px 10px 0'}}>
              {can('utils:export' as any) && (
              <div style={{display:'flex',gap:6,marginBottom:8}}>
              {([[false,'📄 Roster PDF',C.green],[true,'📄 Full PDF (with payments)','#7c3aed']] as const).map(([full,label,bg])=>(
                <button key={label} onClick={()=>exportPdf(full)} disabled={exporting||!data?.roster?.length}
                  style={{flex:1,padding:'7px 8px',borderRadius:9,border:'none',
                    backgroundColor:data?.roster?.length?bg:'#e5e7eb',
                    color:data?.roster?.length?'#fff':C.muted,whiteSpace:'nowrap' as const,
                    fontWeight:700,fontSize:11.5,cursor:data?.roster?.length?'pointer':'not-allowed'}}>
                  {exporting?'⏳ Generating…':label}
                </button>
              ))}
              </div>
              )}
              <div style={LIST_CARD}>
                {/* Column header */}
                <div style={{display:'flex',alignItems:'center',gap:4,padding:'5px 12px',backgroundColor:'#f3f4f6'}}>
                  <span style={{flex:1,fontSize:9.5,fontWeight:800,color:C.muted}}>STUDENT</span>
                  {['MRN','EVN','TOT'].map(h=>(
                    <span key={h} style={{width:34,fontSize:9.5,fontWeight:800,color:C.muted,textAlign:'center' as const}}>{h}</span>
                  ))}
                </div>
                {([...(data.roster||[])].sort((a,b)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999))).map((s:any)=>(
                  <div key={s.id} title={s.status} style={{display:'flex',gap:8,alignItems:'center',
                    padding:'5px 12px',borderTop:`1px solid ${C.border}`,minHeight:44}}>
                    <MemberAvatar item={s} size={30}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:'flex',alignItems:'center',gap:5}}>
                        <div style={{fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</div>
                        <span style={{width:6,height:6,borderRadius:3,flexShrink:0,
                          backgroundColor:s.status==='Active'?'#22c55e':s.status==='Club Member'?'#9ca3af':'#ef4444'}}/>
                      </div>
                      <div style={{fontSize:10.5,fontWeight:700,color:'#1a472a'}}>{studentIds(s)||'—'}</div>
                    </div>
                    <span style={{width:34,textAlign:'center' as const,fontWeight:700,
                      fontSize:13.5,color:s.morning_count>0?C.green:C.muted}}>{s.morning_count}</span>
                    <span style={{width:34,textAlign:'center' as const,fontWeight:700,
                      fontSize:13.5,color:s.evening_count>0?C.blue:C.muted}}>{s.evening_count}</span>
                    <span style={{width:34,textAlign:'center' as const,fontWeight:800,
                      fontSize:14,color:s.total_present>0?C.navy:C.muted}}>{s.total_present}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Payments */}
          {tab==='payments'&&canPayments&&(
            <div style={{padding:'8px 10px 0'}}>
              {(data.payments||[]).length>0&&(
              <div style={LIST_CARD}>
              {([...(data.payments||[])].sort((a,b)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999))).map((p:any,i:number)=>(
                <div key={i} style={{display:'flex',alignItems:'center',gap:10,
                  padding:'7px 12px',borderTop:i?`1px solid ${C.border}`:'none'}}>
                  <MemberAvatar item={{name:p.student_name||p.name||'?',profile_image:p.profile_image||null}} size={34}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:13.5,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{p.student_name||'—'}</div>
                    <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                      <span style={{color:'#1a472a',fontWeight:700}}>{studentIds(p)||'—'}</span> · 🧾 {p.receipt_no||'—'} · {p.payment_mode||'—'}
                    </div>
                    <div style={{fontSize:11,color:C.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{p.fee_type||'—'} · {p.billing_month||'—'}</div>
                  </div>
                  <div style={{textAlign:'right' as const,flexShrink:0}}>
                    <div style={{fontWeight:900,fontSize:14,color:(p.txn_type||'INCOME')==='EXPENSE'?'#dc2626':C.green}}>
                      {(p.txn_type||'INCOME')==='EXPENSE'?'− ':'+'}{fmtAmt(p.amount_paid)}
                    </div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2}}>{p.payment_date}</div>
                  </div>
                </div>
              ))}
              {/* Total */}
              <div style={{padding:'9px 12px',backgroundColor:C.navy,
                display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:'rgba(255,255,255,0.75)',fontWeight:700,fontSize:12.5}}>
                  Total ({data.payments.length} payments)
                </span>
                <span style={{color:C.gold,fontWeight:900,fontSize:16}}>{fmtAmt(sum.total_revenue)}</span>
              </div>
              </div>
              )}
            </div>
          )}

          {tab==='unpaid'&&canPayments&&(()=>{
            // One rule for both the list and the "all paid" message
            const pays = data?.payments||[];
            const unpaid = (data?.roster||[])
              .filter((s:any)=>s.status==='Active' && !pays.find((p:any)=>p.id===s.id||p.student_id===s.id||p.student_name===s.name))
              .sort((a:any,b:any)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999));
            return (
            <div style={{padding:'8px 10px 0'}}>
              <div style={{fontSize:11.5,color:'#6b7280',margin:'0 2px 6px',fontWeight:600}}>
                {unpaid.length} active student{unpaid.length!==1?'s':''} with no payment in this month
              </div>
              {unpaid.length>0 ? (
                <div style={LIST_CARD}>
                  {unpaid.map((s:any,i:number)=>(
                    <div key={s.id} style={{display:'flex',gap:10,alignItems:'center',
                      padding:'6px 12px',borderTop:i?`1px solid ${C.border}`:'none',
                      boxShadow:'inset 3px 0 0 #dc2626'}}>
                      <MemberAvatar item={s} size={32}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:13.5,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</div>
                        <div style={{fontSize:11,color:'#6b7280',marginTop:1}}>
                          <span style={{color:'#dc2626',fontWeight:700}}>{studentIds(s)||'—'}</span> · {s.level||'—'} · {fmtAmt(s.monthly_fee||0)}/mo
                        </div>
                      </div>
                      <span style={{fontSize:9.5,fontWeight:800,padding:'2px 7px',borderRadius:10,
                        backgroundColor:'#fee2e2',color:'#dc2626',flexShrink:0}}>UNPAID</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{textAlign:'center',padding:24,color:'#16a34a',fontWeight:700}}>✓ All active students paid</div>
              )}
            </div>
            );
          })()}
        </>
      )}

      {!data&&!loading&&(
        <div style={{textAlign:'center' as const,padding:'32px 20px',color:C.muted}}>
          <div style={{fontSize:40,marginBottom:10}}>📊</div>
          <div style={{fontWeight:800,fontSize:15,color:'#111',marginBottom:6}}>Monthly Executive Report</div>
          <div style={{fontSize:13,lineHeight:1.7}}>
            Select a month and tap Generate.<br/>
            Shows full student roster with attendance<br/>
            and complete payment ledger.
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 5 — INACTIVE REVIEW (no attendance in N months → write off dues + Inactive)
// ══════════════════════════════════════════════════════════════════════════════
function InactiveTab({base}:{base:string}){
  const [rows,      setRows]      = useState<any[]>([]);
  const [selected,  setSelected]  = useState<Set<number>>(new Set());
  const [months,    setMonths]    = useState(6);
  const [monthsTxt, setMonthsTxt] = useState('6');  // raw input text — avoids snap-back while typing
  const [loading,   setLoading]   = useState(false);
  const [processing,setProcessing]= useState(false);
  const [msg,       setMsg]       = useState('');
  const [fetched,   setFetched]   = useState(false);
  const [confirming,setConfirming]= useState(false);
  const [result,    setResult]    = useState<any|null>(null);
  const [totalDue,  setTotalDue]  = useState(0);

  // Recently Processed / Restore
  const [showProcessed, setShowProcessed] = useState(false);
  const [procRows,      setProcRows]      = useState<any[]>([]);
  const [procLoading,   setProcLoading]   = useState(false);
  const [procFetched,   setProcFetched]   = useState(false);
  const [procMsg,       setProcMsg]       = useState('');
  const [restoreConfirm,setRestoreConfirm]= useState<number|null>(null);
  const [restoring,     setRestoring]     = useState<number|null>(null);

  const loadProcessed = useCallback(async()=>{
    setProcLoading(true); setProcMsg('');
    try{
      const r = await fetch(`${base}/api/data/admin/inactive-processed?days=90`, {headers:hdr()});
      const j = await r.json();
      if(r.ok){ setProcRows(j.data||[]); setProcFetched(true); }
      else setProcMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{ setProcMsg('⚠ Cannot reach server'); }
    finally{ setProcLoading(false); }
  },[]);

  const restore = async(studentId:number)=>{
    setRestoring(studentId); setProcMsg('');
    try{
      const r = await fetch(`${base}/api/data/admin/restore-student`,{
        method:'POST', headers:hdr(),
        body:JSON.stringify({student_id:studentId}),
      });
      const j = await r.json();
      if(r.ok){
        setProcRows(prev=>prev.filter(p=>p.student_id!==studentId));
        setRestoreConfirm(null);
        setProcMsg(`✅ Restored ${j.student_name} — reversed ${j.reversed_count} write-off(s) (${fmtAmt(j.reversed_amount)})`);
      } else setProcMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{ setProcMsg('⚠ Cannot reach server'); }
    finally{ setRestoring(null); }
  };

  const toggleProcessed = ()=>{
    const next = !showProcessed;
    setShowProcessed(next);
    if(next && !procFetched) loadProcessed();
  };

  const load = useCallback(async()=>{
    setLoading(true); setMsg(''); setResult(null); setSelected(new Set());
    try{
      const r = await fetch(`${base}/api/data/admin/inactive-candidates?months=${months}`, {headers:hdr()});
      const j = await r.json();
      if(r.ok){ setRows(j.data||[]); setTotalDue(j.total_balance_due||0); setFetched(true); }
      else setMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{ setMsg('⚠ Cannot reach server'); }
    finally{ setLoading(false); }
  },[months]);

  const toggle=(id:number)=>{
    setSelected(prev=>{
      const next=new Set(prev);
      if(next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll=()=>{
    setSelected(prev=> prev.size===rows.length ? new Set() : new Set(rows.map(r=>r.student_id)));
  };

  const process=async()=>{
    setProcessing(true); setMsg('');
    try{
      const r=await fetch(`${base}/api/data/admin/process-inactive`,{
        method:'POST', headers:hdr(),
        body:JSON.stringify({student_ids:[...selected], months}),
      });
      const j=await r.json();
      if(r.ok){
        setResult(j);
        setConfirming(false);
        await load(); // refresh list — processed students should drop off
      } else setMsg('⚠ '+(j.error||`Server ${r.status}`));
    }catch{ setMsg('⚠ Cannot reach server'); }
    finally{ setProcessing(false); }
  };

  const selRows   = rows.filter(r=>selected.has(r.student_id));
  const selBalance= selRows.reduce((s,r)=>s+(r.balance_due||0),0);
  const selMonths = selRows.reduce((s,r)=>s+(r.months_due_count||0),0);

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:80}}>
      <div style={{backgroundColor:C.card,borderBottom:`1px solid ${C.border}`,padding:'8px 12px'}}>
        <div style={{fontSize:11.5,color:C.muted,marginBottom:8,lineHeight:1.45}}>
          <b>Active</b> students with <b>no attendance</b> in the last N months. Processing writes off
          their pending months (<i>Long Absence</i>, reversible) and sets them <b>Inactive</b>.
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:800,color:C.muted,whiteSpace:'nowrap' as const}}>Months</span>
          <div style={{width:64,flexShrink:0}} title="No-attendance threshold (6–24 months)">
            <input type="number" min={6} max={24} value={monthsTxt}
              onChange={e=>{
                const v = e.target.value;
                setMonthsTxt(v);
                const n = Number(v);
                // Only commit while typing if it's a valid in-range number —
                // an empty/partial value (e.g. while clearing the field to
                // type a new number) is kept in monthsTxt without resetting
                // `months`, so the input doesn't snap back mid-edit.
                if(v!=='' && !isNaN(n) && n>=6 && n<=24) setMonths(n);
              }}
              onBlur={()=>{
                const n = Number(monthsTxt);
                const clamped = (!monthsTxt || isNaN(n)) ? 6 : Math.max(6,Math.min(24,n));
                setMonthsTxt(String(clamped));
                setMonths(clamped);
              }}
              style={{width:'100%',padding:'8px 10px',borderRadius:9,
                border:`1.5px solid ${C.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const}}/>
          </div>
          <LoadBtn loading={loading} onClick={load} label="🔍 Find Candidates"/>
        </div>

        {/* Recently Processed / Restore (undo) */}
        <button onClick={toggleProcessed}
          style={{width:'100%',padding:'7px',borderRadius:9,border:`1px solid ${C.border}`,
            backgroundColor:C.card,color:C.navy,fontWeight:700,fontSize:12,cursor:'pointer'}}>
          {showProcessed ? '▲ Hide' : '▼ Show'} recently processed (undo available)
        </button>

        {showProcessed && (
          <div style={{marginTop:10}}>
            {procLoading && (
              <div style={{textAlign:'center' as const,padding:'12px',color:C.muted,fontSize:12}}>
                ⏳ Loading…
              </div>
            )}
            {procMsg && (
              <div style={{padding:'8px 12px',borderRadius:8,marginBottom:8,fontSize:12,fontWeight:700,
                backgroundColor: procMsg.startsWith('✅') ? '#f0fdf4' : '#fee2e2',
                color: procMsg.startsWith('✅') ? '#166534' : C.red}}>
                {procMsg}
              </div>
            )}
            {procFetched && procRows.length===0 && !procLoading && (
              <div style={{textAlign:'center' as const,padding:'12px',color:C.muted,fontSize:12}}>
                No auto-processed students in the last 90 days.
              </div>
            )}
            {procRows.length>0&&(
            <div style={LIST_CARD}>
            {procRows.map((p,i)=>(
              <div key={p.student_id} style={{display:'flex',alignItems:'center',gap:10,
                padding:'7px 10px',borderTop:i?`1px solid ${C.border}`:'none'}}>
                <MemberAvatar item={{name:p.student_name||'?',profile_image:p.profile_image||null}} size={32}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:13,color:'#111',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{p.student_name}</div>
                  <div style={{fontSize:11,color:C.muted,marginTop:1}}>
                    Inactive {p.exit_date} · {p.writeoffs_count} mo · {fmtAmt(p.writeoffs_amount)}
                  </div>
                </div>
                {restoreConfirm===p.student_id ? (
                  <div style={{display:'flex',gap:5,flexShrink:0}}>
                    <button onClick={()=>restore(p.student_id)} disabled={restoring===p.student_id}
                      style={{padding:'6px 10px',borderRadius:8,border:'none',
                        backgroundColor:restoring===p.student_id?'#9ca3af':C.green,
                        color:'#fff',fontWeight:800,fontSize:11,
                        cursor:restoring===p.student_id?'not-allowed':'pointer'}}>
                      {restoring===p.student_id?'⏳':'Confirm'}
                    </button>
                    <button onClick={()=>setRestoreConfirm(null)} disabled={restoring===p.student_id}
                      style={{padding:'6px 10px',borderRadius:8,border:`1px solid ${C.border}`,
                        backgroundColor:C.card,color:C.muted,fontWeight:700,fontSize:11,cursor:'pointer'}}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={()=>setRestoreConfirm(p.student_id)}
                    style={{padding:'6px 10px',borderRadius:8,border:'none',flexShrink:0,
                      backgroundColor:C.blue,color:'#fff',fontWeight:800,fontSize:11,cursor:'pointer'}}>
                    ↩ Restore
                  </button>
                )}
              </div>
            ))}
            </div>
            )}
          </div>
        )}
      </div>

      <ErrBox msg={msg}/>

      {result && (
        <div style={{margin:'8px 10px',padding:'9px 12px',borderRadius:10,
          backgroundColor:'#f0fdf4',border:'1px solid #86efac'}}>
          <div style={{fontWeight:800,fontSize:13,color:'#166534',marginBottom:4}}>
            ✅ Processed {result.processed} student(s)
            {result.skipped>0 && `, skipped ${result.skipped}`}
          </div>
          <div style={{fontSize:12,color:'#166534'}}>
            Total written off: {fmtAmt(result.total_written_off)}
          </div>
        </div>
      )}

      {fetched && (
        <div style={{display:'flex',gap:6,padding:'8px 10px 0'}}>
          <Pill label="Candidates" value={rows.length} color={C.navy}/>
          <Pill label="Total Due" value={fmtShort(totalDue)} color={C.red} title={fmtAmt(totalDue)}/>
          <Pill label="Selected" value={selected.size} color={C.green}/>
        </div>
      )}

      {fetched && rows.length>0 && (
        <div style={{padding:'8px 10px 0'}}>
          <button onClick={toggleAll}
            style={{width:'100%',padding:'7px',borderRadius:9,border:`1px solid ${C.border}`,
              backgroundColor:C.card,color:C.navy,fontWeight:700,fontSize:12,cursor:'pointer',marginBottom:8}}>
            {selected.size===rows.length ? '☑ Deselect All' : '☐ Select All'}
          </button>
        </div>
      )}

      <div style={{padding:'0 10px'}}>
        {rows.length>0&&(
        <div style={LIST_CARD}>
        {rows.map((r,i)=>{
          const isSel = selected.has(r.student_id);
          return(
            <div key={r.student_id} onClick={()=>toggle(r.student_id)}
              title={r.due_months_display?.length>0 ? `Pending: ${r.due_months_display.join(', ')}` : undefined}
              style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',cursor:'pointer',
                borderTop:i?`1px solid ${C.border}`:'none',
                backgroundColor:isSel?'#f0fdf4':C.card,
                boxShadow:isSel?`inset 3px 0 0 ${C.green}`:'none'}}>
              <div style={{width:20,height:20,borderRadius:5,flexShrink:0,
                border:`2px solid ${isSel?C.green:C.border}`,
                backgroundColor:isSel?C.green:'transparent',
                display:'flex',alignItems:'center',justifyContent:'center',
                color:'#fff',fontSize:12,fontWeight:900}}>
                {isSel?'✓':''}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13.5,color:'#111',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{r.student_name}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                  Last {r.last_attendance ? r.last_attendance : <span style={{color:C.red,fontWeight:700}}>never</span>}
                  {r.months_inactive!=null && ` (${r.months_inactive} mo)`} · {r.months_due_count} mo pending
                </div>
              </div>
              <div style={{textAlign:'right' as const,flexShrink:0}}>
                <div style={{fontWeight:900,fontSize:14,color:r.balance_due>0?C.red:C.muted}}>{fmtAmt(r.balance_due)}</div>
                <div style={{fontSize:10,color:C.muted,marginTop:1}}>{fmtAmt(r.monthly_fee)}/mo</div>
              </div>
            </div>
          );
        })}
        </div>
        )}
        {fetched && rows.length===0 && (
          <div style={{textAlign:'center' as const,padding:'28px 20px',color:C.muted}}>
            <div style={{fontSize:32,marginBottom:8}}>✅</div>
            <div style={{fontWeight:700,fontSize:14}}>No candidates found</div>
            <div style={{fontSize:12,marginTop:4}}>
              All active students have attended within the last {months} month(s).
            </div>
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      {selected.size>0 && !confirming && (
        <div style={{position:'sticky',bottom:0,backgroundColor:C.card,borderTop:`1px solid ${C.border}`,
          padding:'12px 16px',marginTop:12,boxShadow:'0 -2px 8px rgba(0,0,0,0.06)'}}>
          <button onClick={()=>setConfirming(true)}
            style={{width:'100%',padding:'12px',borderRadius:11,border:'none',
              backgroundColor:C.red,color:'#fff',fontWeight:800,fontSize:14,cursor:'pointer'}}>
            Process {selected.size} Student(s) — Write off {fmtAmt(selBalance)}
          </button>
        </div>
      )}

      {/* Confirmation panel */}
      {confirming && (
        <div style={{position:'sticky',bottom:0,backgroundColor:'#fff7ed',borderTop:`2px solid #f59e0b`,
          padding:'16px',marginTop:12,boxShadow:'0 -2px 8px rgba(0,0,0,0.08)'}}>
          <div style={{fontWeight:900,fontSize:14,color:'#92400e',marginBottom:8}}>
            ⚠ Confirm Action
          </div>
          <div style={{fontSize:13,color:'#92400e',marginBottom:12,lineHeight:1.6}}>
            This will write off <b>{selMonths} billing month(s)</b> totalling{' '}
            <b>{fmtAmt(selBalance)}</b> across <b>{selected.size}</b> student(s)
            (reason: Long Absence, reversible from Write-Offs report), and set
            their status to <b>Inactive</b> with today's exit date. This cannot
            be easily undone in bulk.
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={process} disabled={processing}
              style={{flex:2,padding:'12px',borderRadius:11,border:'none',
                backgroundColor:processing?'#9ca3af':C.red,color:'#fff',
                fontWeight:800,fontSize:13,cursor:processing?'not-allowed':'pointer'}}>
              {processing?'⏳ Processing…':`Confirm — Process ${selected.size}`}
            </button>
            <button onClick={()=>setConfirming(false)} disabled={processing}
              style={{flex:1,padding:'12px',borderRadius:11,border:`1px solid ${C.border}`,
                backgroundColor:C.card,color:C.muted,fontWeight:700,fontSize:13,
                cursor:processing?'not-allowed':'pointer'}}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ══════════════════════════════════════════════════════════════════════════════
type UtilTab = 'students'|'attendance'|'payments'|'report'|'inactive'|'agegroups'|'birthdays'|'leaderboard'|'announce'|'potm';



// ── MemberAvatar — works for students (profile_image) and club members (image_url)
function MemberAvatar({ item, size=40, onClick }: { item:any; size?:number; onClick?:()=>void }) {
  const isStudent = !!item.profile_image;
  const src = item.profile_image || item.image_url || null;
  const name = item.name || '?';
  const [objUrl, setObjUrl] = React.useState<string|null>(null);
  const [ready,  setReady]  = React.useState(false);
  const initials = name.trim().split(/\s+/).slice(0,2).map((w:string)=>w[0]?.toUpperCase()||'').join('');

  React.useEffect(() => {
    let cancelled = false;
    let created: string|null = null;
    (async () => {
      const url = isStudent
        ? await getCachedImageUrl(src)
        : await getCachedMemberImageUrl(src);
      if (cancelled) return;
      if (url) { created = url; setObjUrl(url); }
      setReady(true);
    })();
    return () => { cancelled = true; if (created) setTimeout(()=>URL.revokeObjectURL(created!),10000); };
  }, [src]);

  const style: React.CSSProperties = {
    width:size, height:size, borderRadius:8, objectFit:'cover' as const,
    flexShrink:0, cursor:onClick?'pointer':'default',
  };

  if (!ready || !objUrl) {
    return (
      <div onClick={onClick} style={{...style, backgroundColor:'#1a472a',
        display:'flex',alignItems:'center',justifyContent:'center'}}>
        <span style={{fontWeight:900,fontSize:size*0.38,color:'#fff'}}>{initials||'?'}</span>
      </div>
    );
  }
  return <img src={objUrl} alt={name} onClick={onClick}
    onError={()=>setObjUrl(null)} style={style}/>;
}

// ── Shared: load students from local DB ──────────────────────────────────────
const MN = ['January','February','March','April','May','June',
             'July','August','September','October','November','December'];

function ageOnCutoff(dobStr: string, year: number): number|null {
  if (!dobStr) return null;
  try {
    const dob = new Date(dobStr);
    const cutoff = new Date(year, 7, 1); // Aug 1
    let age = cutoff.getFullYear() - dob.getFullYear();
    if (cutoff.getMonth() < dob.getMonth() ||
       (cutoff.getMonth() === dob.getMonth() && cutoff.getDate() < dob.getDate())) age--;
    return age;
  } catch { return null; }
}

function getAgeGroup(dob: string, year: number): string {
  const age = ageOnCutoff(dob, year);
  if (age === null) return 'Unknown';
  if (age <= 7)  return 'U8';
  if (age <= 9)  return 'U10';
  if (age <= 11) return 'U12';
  if (age <= 13) return 'U14';
  if (age <= 16) return 'U17';
  if (age <= 18) return 'U19';
  return 'Open';
}

const GRP_COLOR: Record<string,string> = {
  'U8':'#8b5cf6','U10':'#3b82f6','U12':'#06b6d4',
  'U14':'#10b981','U17':'#f59e0b','U19':'#ef4444',
  'Open':'#6b7280','Unknown':'#9ca3af',
};

const AGE_GROUP_DEFS = [
  {label:'U8',   desc:'Age 7 & under'},
  {label:'U10',  desc:'Age 8–9'},
  {label:'U12',  desc:'Age 10–11'},
  {label:'U14',  desc:'Age 12–13'},
  {label:'U17',  desc:'Age 14–16'},
  {label:'U19',  desc:'Age 17–18'},
  {label:'Open', desc:'Age 19+'},
  {label:'Unknown', desc:'No DOB recorded'},
];

// ── Age Groups Tab (local DB) ─────────────────────────────────────────────────
function AgeGroupsTab({ base }: { base: string }) {
  const year     = new Date().getFullYear();
  const cutoff   = new Date(year, 7, 1); // Aug 1

  function ageOnAug1(dob: string): number|null {
    if (!dob) return null;
    try {
      const d = new Date(dob);
      let age = cutoff.getFullYear() - d.getFullYear();
      if (cutoff < new Date(cutoff.getFullYear(), d.getMonth(), d.getDate())) age--;
      return age;
    } catch { return null; }
  }

  // BCCI: eligible if age <= max on Aug 1
  const TOURNAMENT_GROUPS = [
    { label: 'U8',      maxAge: 7,   desc: 'All students eligible for U8 (age ≤ 7 on Aug 1)' },
    { label: 'U12',     maxAge: 11,  desc: 'All students eligible for U12 (age ≤ 11 on Aug 1)' },
    { label: 'U14',     maxAge: 13,  desc: 'All students eligible for U14 (age ≤ 13 on Aug 1)' },
    { label: 'U17',     maxAge: 16,  desc: 'All students eligible for U17 (age ≤ 16 on Aug 1)' },
    { label: 'U19',     maxAge: 18,  desc: 'All students eligible for U19 (age ≤ 18 on Aug 1)' },
    { label: 'Seniors', maxAge: 999, desc: 'Age 19+ on Aug 1 (Open category)' },
  ];

  const GRP_CLR: Record<string,string> = {
    'U8':'#8b5cf6','U12':'#06b6d4','U14':'#10b981','U17':'#3b82f6','U19':'#f59e0b','Seniors':'#6b7280',
  };

  const [groups,    setGroups]   = React.useState<Record<string,any[]>>({});
  const [allStuds,  setAllStuds] = React.useState<any[]>([]);
  const [loading,   setLoading]  = React.useState(true);
  const [expanded,  setExpanded] = React.useState<string|null>(null);
  const [noAge,     setNoAge]    = React.useState<any[]>([]);
  // customAge handled by CustomAgeLookup component

  React.useEffect(() => {
    getAllStudents().then((all: any[]) => {
      const active = all.filter((s:any) =>
        (s.student_type||'').toLowerCase() === 'academy' &&
        (s.status||'').toLowerCase() !== 'inactive'
      );
      const g: Record<string,any[]> = { U8:[], U12:[], U14:[], U17:[], U19:[], Seniors:[] };
      const noDob: any[] = [];

      active.forEach((s:any) => {
        const age = ageOnAug1(s.date_of_birth||'');
        if (age === null) { noDob.push(s); return; }
        // Each student goes into every group they're eligible for
        if (age <= 7)  { g.U8.push(s);  g.U12.push(s); g.U14.push(s); g.U17.push(s); g.U19.push(s); }
        else if (age <= 11) { g.U12.push(s); g.U14.push(s); g.U17.push(s); g.U19.push(s); }
        else if (age <= 13) { g.U14.push(s); g.U17.push(s); g.U19.push(s); }
        else if (age <= 16) { g.U17.push(s); g.U19.push(s); }
        else if (age <= 18) { g.U19.push(s); }
        else { g.Seniors.push(s); }
      });

      setGroups(g);
      setAllStuds(active);
      setNoAge(noDob);
      setLoading(false);
    });
  }, []);

  if (loading) return <div style={{textAlign:'center',padding:40,color:C.muted}}>Loading…</div>;

  return (
    <div style={{padding:'8px 10px'}}>
      <div style={{margin:'0 0 8px',padding:'6px 10px',backgroundColor:'#eff6ff',
        borderRadius:9,fontSize:11,color:'#1d4ed8',fontWeight:600}}>
        🏏 BCCI cutoff: Aug 1 {year} — each group shows all eligible students for that tournament
      </div>

      {/* Custom age range lookup */}
      <CustomAgeLookup allStuds={allStuds} year={year} ageOnAug1={ageOnAug1} />

      <div style={LIST_CARD}>
      {TOURNAMENT_GROUPS.map((def, gi) => {
        const students = groups[def.label] || [];
        const color    = GRP_CLR[def.label];
        const open     = expanded===def.label;
        return (
          <div key={def.label} style={{borderTop:gi?`1px solid ${C.border}`:'none'}}>
            <button onClick={()=>setExpanded(open?null:def.label)} aria-expanded={open}
              style={{width:'100%',display:'flex',alignItems:'center',gap:10,
                padding:'7px 12px',border:'none',background:open?'#f9fafb':'none',cursor:'pointer'}}>
              <div style={{width:36,height:36,borderRadius:10,flexShrink:0,
                backgroundColor:color+'20',display:'flex',alignItems:'center',justifyContent:'center'}}>
                <span style={{fontWeight:900,fontSize:11.5,color}}>{def.label}</span>
              </div>
              <div style={{flex:1,minWidth:0,textAlign:'left'}}>
                <div style={{fontWeight:800,fontSize:13.5,color:C.navy}}>{def.label}</div>
                <div style={{fontSize:10.5,color:C.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{def.desc}</div>
              </div>
              <div style={{textAlign:'right',flexShrink:0}}>
                <span style={{fontWeight:900,fontSize:17,color}}>{students.length}</span>
                <span style={{fontSize:10,color:C.muted}}> eligible</span>
              </div>
              <span style={{color:C.muted,fontSize:11,width:12}}>{open?'▲':'▼'}</span>
            </button>

            {open && (
              <div style={{borderTop:`1px solid ${C.border}`}}>
                {students.length===0
                  ? <div style={{padding:'10px 12px',fontSize:13,color:C.muted}}>No students</div>
                  : students.map((s:any,i:number) => (
                    <div key={s.id} style={{display:'flex',alignItems:'center',gap:10,
                      padding:'5px 12px 5px 22px',
                      borderTop:i?`1px solid ${C.border}`:'none'}}>
                      <MemberAvatar item={s} size={30}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:600,fontSize:13,color:'#111',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</div>
                        <div style={{fontSize:10.5,color:C.muted}}>
                          <span style={{color,fontWeight:700}}>{studentIds(s)||'—'}</span>
                          {ageOnAug1(s.date_of_birth||'')!=null ? ` · ${ageOnAug1(s.date_of_birth||'')} yrs on Aug 1`:''}
                          {s.level?` · ${s.level}`:''}
                        </div>
                      </div>
                    </div>
                  ))
                }
              </div>
            )}
          </div>
        );
      })}
      </div>

      {noAge.length > 0 && (
        <div style={{marginTop:8,padding:'7px 10px',backgroundColor:'#fff7ed',borderRadius:9,
          fontSize:11.5,color:'#92400e',fontWeight:600}}>
          ⚠ {noAge.length} active student{noAge.length>1?'s':''} have no DOB recorded —
          not included in any group
        </div>
      )}
    </div>
  );
}


// ── Birthdays Tab (local DB) ──────────────────────────────────────────────────
function BirthdaysTab() {
  const today   = new Date();
  const todayMD = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const [students, setStudents] = React.useState<any[]>([]);
  const [selMonth,   setSelMonth]   = React.useState(today.getMonth()+1);
  const [zoomedPhoto, setZoomedPhoto] = React.useState<any>(null);
  const [loading,  setLoading]  = React.useState(true);

  React.useEffect(() => {
    const base = (localStorage.getItem('server_ip')||'').trim().replace(/\/+$/,'');
    fetch(`${base}/api/data/utils/birthdays?month=${selMonth}`, {
      headers:hdr()
    }).then(r=>r.json()).then(j=>{
      if (j.birthdays) setStudents(j.birthdays);
      setLoading(false);
    }).catch(()=>setLoading(false));
  }, [selMonth]);

  // Calculate birthdays
  // Server already returns day, month, age_next, is_today
  const withBday = React.useMemo(() => students.map((s:any) => ({
    ...s,
    bday_month: s.month  || s.bday_month,
    bday_day:   s.day    || s.bday_day,
    days_until: s.is_today ? 0 : 999,
  })), [students]);

  const todayBdays    = withBday.filter((s:any) => s.is_today);
  const monthBdays    = withBday.sort((a:any,b:any) => a.bday_day - b.bday_day);

  if (loading) return <div style={{textAlign:'center',padding:40,color:C.muted}}>Loading…</div>;

  const BdayCard = ({s, onPhotoClick}: {s:any, onPhotoClick?:(s:any)=>void}) => (
    <div style={{display:'flex',alignItems:'center',gap:10,padding:'6px 12px',
      backgroundColor:s.is_today?'#fefce8':'#fff',
      boxShadow:s.is_today?'inset 3px 0 0 #f59e0b':'none'}}>
      <div style={{position:'relative',flexShrink:0}}>
        <MemberAvatar item={s} size={34} onClick={()=>onPhotoClick?.(s)}/>
        <div style={{position:'absolute',bottom:-3,right:-4,minWidth:17,height:17,padding:'0 2px',
          borderRadius:9,backgroundColor:s.is_today?'#f59e0b':'#6b7280',
          display:'flex',alignItems:'center',justifyContent:'center',
          fontSize:9,fontWeight:900,color:'#fff',border:'2px solid #fff'}}>
          {s.bday_day}
        </div>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <span style={{fontWeight:700,fontSize:13.5,color:'#111',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</span>
          {s.is_today && <span style={{fontSize:13}}>🎉</span>}
        </div>
        <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
          {studentIds(s) && <span style={{color:'#1a472a',fontWeight:700}}>{studentIds(s)} · </span>}
          {MN[s.bday_month-1]?.slice(0,3)} {s.bday_day}
          {s.is_today ? ` · 🎂 turns ${s.age_next} today` : ` · Age ${s.age_next}`}
          {s.level ? ` · ${s.level}` : ''}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{padding:'8px 10px'}}>

      {/* Today */}
      {todayBdays.length > 0 && (
        <div style={{marginBottom:10}}>
          <div style={{fontWeight:800,fontSize:11,color:'#92400e',
            textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5,
            display:'flex',alignItems:'center',gap:6}}>
            <span>🎉</span> Today's Birthdays ({todayBdays.length})
          </div>
          <div style={{backgroundColor:'#fef9c3',borderRadius:14,overflow:'hidden',
            border:'2px solid #fde047',boxShadow:'0 2px 8px rgba(234,179,8,0.2)'}}>
            {todayBdays.map((s,i) => (
              <div key={s.id} style={{borderBottom:i<todayBdays.length-1?'1px solid #fde047':'none'}}>
                <BdayCard s={s} onPhotoClick={setZoomedPhoto}/>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Month browser */}
      <div style={{display:'flex',gap:5,overflowX:'auto' as const,scrollbarWidth:'none' as any,marginBottom:8}}>
        {MN.map((m,i) => (
          <button key={i} onClick={()=>setSelMonth(i+1)}
            ref={el=>{ if (el && selMonth===i+1) el.scrollIntoView({inline:'center',block:'nearest'}); }}
            style={{flexShrink:0,padding:'5px 11px',borderRadius:16,border:'none',cursor:'pointer',
              fontWeight:700,fontSize:11,
              backgroundColor:selMonth===i+1?C.navy:'#fff',
              color:selMonth===i+1?'#fff':'#374151',
              boxShadow:'0 1px 3px rgba(0,0,0,0.08)'}}>
            {m.slice(0,3)}
          </button>
        ))}
      </div>

      <div style={{...LIST_CARD,marginBottom:10}}>
        {monthBdays.length===0
          ? <div style={{padding:'20px 16px',textAlign:'center',color:C.muted,fontSize:13}}>
              No birthdays in {MN[selMonth-1]}
            </div>
          : <>
              <div style={{padding:'6px 12px',backgroundColor:C.navy,
                fontWeight:700,fontSize:12,color:'#fff'}}>
                {MN[selMonth-1]} — {monthBdays.length} birthday{monthBdays.length===1?'':'s'}
              </div>
              {monthBdays.map((s,i) => (
                <div key={s.id} style={{borderBottom:i<monthBdays.length-1?`1px solid ${C.border}`:'none'}}>
                  <BdayCard s={s} onPhotoClick={setZoomedPhoto}/>
                </div>
              ))}
            </>
        }
      </div>

      <div style={{textAlign:'center',fontSize:11,color:C.muted}}>
        {monthBdays.length} birthday{monthBdays.length===1?'':'s'} in {MN[selMonth-1]} · {todayBdays.length} today
      </div>
    </div>
  );
}



// ── Custom Age Lookup Component ───────────────────────────────────────────────
function Stepper({ label, value, onChange, min=1, max=40 }: {
  label: string; value: number; onChange: (v:number)=>void; min?:number; max?:number;
}) {
  const btn = (enabled: boolean, radius: string): React.CSSProperties => ({
    width:32, height:34, borderRadius:radius, border:`1px solid ${C.border}`,
    backgroundColor:'#f9fafb', fontSize:17, cursor:'pointer', fontWeight:700,
    color:enabled?C.navy:C.muted,
  });
  return (
    <div role="group" aria-label={label} title={label} style={{display:'flex',alignItems:'center',flexShrink:0}}>
      <button aria-label={`${label} down`} onClick={()=>onChange(Math.max(min,value-1))} style={btn(value>min,'9px 0 0 9px')}>−</button>
      <div style={{width:34,height:34,display:'flex',alignItems:'center',justifyContent:'center',
        border:`1px solid ${C.border}`,borderLeft:'none',borderRight:'none',
        fontWeight:900,fontSize:15,color:C.navy,backgroundColor:'#fff'}}>{value}</div>
      <button aria-label={`${label} up`} onClick={()=>onChange(Math.min(max,value+1))} style={btn(value<max,'0 9px 9px 0')}>+</button>
    </div>
  );
}

function CustomAgeLookup({ allStuds, year, ageOnAug1 }: {
  allStuds: any[]; year: number; ageOnAug1: (dob:string)=>number|null;
}) {
  const [minAge, setMinAge] = React.useState(10);
  const [maxAge, setMaxAge] = React.useState(13);
  const [active,  setActive] = React.useState(false);
  const [zoomed, setZoomed] = React.useState<any>(null);

  const filtered = React.useMemo(() => {
    if (!active) return [];
    return allStuds.filter((s:any) => {
      const age = ageOnAug1(s.date_of_birth||'');
      return age !== null && age >= minAge && age <= maxAge;
    });
  }, [active, minAge, maxAge, allStuds]);

  return (
    <div style={{marginBottom:10,backgroundColor:C.card,borderRadius:14,
      overflow:'hidden',border:`1px solid ${C.border}`}}>
      <div style={{padding:'8px 10px',borderBottom:active?`1px solid ${C.border}`:'none'}}>
        <div style={{fontWeight:800,fontSize:10,color:C.muted,marginBottom:6,
          textTransform:'uppercase',letterSpacing:'0.8px'}}>Custom age range (on Aug 1)</div>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <Stepper label="Min age" value={minAge} onChange={v=>setMinAge(Math.min(v,maxAge))}/>
          <span style={{fontSize:12,color:C.muted}}>to</span>
          <Stepper label="Max age" value={maxAge} onChange={v=>setMaxAge(Math.max(v,minAge))}/>
          <button onClick={()=>setActive(v=>!v)}
            style={{flex:1,minWidth:0,height:34,borderRadius:9,border:'none',cursor:'pointer',
              fontWeight:800,fontSize:12.5,whiteSpace:'nowrap' as const,
              backgroundColor:active?'#dc2626':C.navy,color:'#fff'}}>
            {active ? `✕ ${filtered.length} found` : '🔍 Find'}
          </button>
        </div>
      </div>

      {active && (
        <div>
          {filtered.length===0
            ? <div style={{padding:'16px',textAlign:'center',color:C.muted,fontSize:13}}>
                No students aged {minAge}–{maxAge} on Aug 1 {year}
              </div>
            : filtered.map((s:any,i:number) => (
              <div key={s.id} style={{display:'flex',alignItems:'center',gap:10,
                padding:'6px 12px',
                borderBottom:i<filtered.length-1?`1px solid ${C.border}`:'none'}}>
                <div onClick={()=>setZoomed(s)} style={{cursor:'pointer',flexShrink:0}}>
                  <MemberAvatar item={s} size={32} onClick={()=>setZoomed(s)}/>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</div>
                  <div style={{fontSize:10.5,color:C.muted}}>
                    <span style={{color:C.navy,fontWeight:700}}>{studentIds(s)||'—'}</span> · Age {ageOnAug1(s.date_of_birth||'')} · {s.date_of_birth?.slice(0,10)||'—'} · {s.level||'—'}
                  </div>
                </div>
              </div>
            ))
          }
        </div>
      )}

      {zoomed && (
        <div onClick={()=>setZoomed(null)}
          style={{position:'fixed',inset:0,backgroundColor:'rgba(0,0,0,0.92)',
            zIndex:3000,display:'flex',flexDirection:'column',
            alignItems:'center',justifyContent:'center',padding:20}}>
          <button onClick={()=>setZoomed(null)}
            style={{position:'absolute',top:16,right:16,background:'none',border:'none',
              color:'#fff',fontSize:28,cursor:'pointer'}}>✕</button>
          <MemberAvatar item={zoomed}
            size={Math.min(window.innerWidth-40, 320)}
            style={{borderRadius:16,border:'3px solid rgba(255,255,255,0.3)'}}/>
          <div style={{color:'#fff',fontWeight:700,fontSize:16,marginTop:14}}>{zoomed.name}</div>
          <div style={{color:'rgba(255,255,255,0.6)',fontSize:12,marginTop:4}}>
            {studentIds(zoomed)||'—'} · Age {ageOnAug1(zoomed.date_of_birth||'')} · {zoomed.level||'—'}
          </div>
          <div style={{color:'rgba(255,255,255,0.4)',fontSize:11,marginTop:20}}>Tap anywhere to close</div>
        </div>
      )}


    </div>
  );
}


// ── Leaderboard Tab ───────────────────────────────────────────────────────────
function LeaderboardTab({ base }: { base: string }) {
  const H = hdr();
  const now = new Date();
  const [data,    setData]    = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [month,   setMonth]   = React.useState(now.toISOString().slice(0,7));

  const load = React.useCallback(async (m?: string) => {
    setLoading(true);
    const target = m || month;
    try {
      const r = await fetch(`${base}/api/data/utils/leaderboard?month=${target}&limit=50`, { headers: H });
      const j = await r.json();
      if (r.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, [base, month]);

  React.useEffect(() => { load(); }, []);

  const MEDAL = ['🥇','🥈','🥉'];

  return (
    <div style={{padding:'8px 10px'}}>
      {/* Month selector */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
        <button onClick={()=>{
          const d = new Date(month+'-01');
          d.setMonth(d.getMonth()-1);
          const m = d.toISOString().slice(0,7);
          setMonth(m); load(m);
        }} aria-label="Previous month" style={{width:40,height:34,borderRadius:9,border:`1px solid ${C.border}`,
          backgroundColor:'#fff',cursor:'pointer',fontWeight:700}}>←</button>
        <div style={{flex:1,textAlign:'center',fontWeight:800,fontSize:14,color:C.navy}}>
          {new Date(month+'-01').toLocaleString('default',{month:'long',year:'numeric'})}
        </div>
        <button onClick={()=>{
          const d = new Date(month+'-01');
          d.setMonth(d.getMonth()+1);
          const m = d.toISOString().slice(0,7);
          setMonth(m); load(m);
        }} aria-label="Next month" style={{width:40,height:34,borderRadius:9,border:`1px solid ${C.border}`,
          backgroundColor:'#fff',cursor:'pointer',fontWeight:700}}>→</button>
      </div>

      {loading && <div style={{textAlign:'center',padding:40,color:C.muted}}>Loading…</div>}

      {!loading && data && (
        <>
          <div style={{marginBottom:8,padding:'6px 10px',backgroundColor:'#eff6ff',
            borderRadius:9,fontSize:11,color:'#1d4ed8',fontWeight:600}}>
            🏏 {data.total_sessions} sessions in {new Date(month+'-01').toLocaleString('default',{month:'long'})} · {data.leaderboard?.length || 0} students attended
          </div>

          {(!data.leaderboard || data.leaderboard.length === 0) ? (
            <div style={{textAlign:'center',padding:40,color:C.muted,fontSize:13}}>
              No attendance data for this month
            </div>
          ) : (
            <div style={LIST_CARD}>
            {data.leaderboard.map((s:any, i:number) => {
              const tint = i===0?'#fefce8':i===1?'#f0f9ff':i===2?'#fdf4ff':C.card;
              const edge = i===0?'#f59e0b':i===1?'#3b82f6':i===2?'#a855f7':'transparent';
              return (
            <div key={s.student_id} style={{display:'flex',alignItems:'center',gap:10,
              padding:'6px 12px',minHeight:46,backgroundColor:tint,
              borderTop:i?`1px solid ${C.border}`:'none',boxShadow:`inset 3px 0 0 ${edge}`}}>
              {/* Rank */}
              <div style={{width:26,textAlign:'center',flexShrink:0}}>
                {i < 3
                  ? <span style={{fontSize:19}}>{MEDAL[i]}</span>
                  : <span style={{fontWeight:900,fontSize:13,color:C.muted}}>{i+1}</span>
                }
              </div>
              <MemberAvatar item={s} size={32}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13.5,color:'#111',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{s.name}</div>
                <div style={{fontSize:10.5,color:C.muted,marginTop:1}}>
                  <span style={{color:'#1a472a',fontWeight:700}}>{studentIds(s) || s.regno_fmt || '—'}</span> · {s.level||'—'}
                </div>
              </div>
              <div style={{textAlign:'right',flexShrink:0}}>
                <div>
                  <span style={{fontWeight:900,fontSize:16,color:i===0?'#b45309':i===1?'#1d4ed8':i===2?'#7e22ce':C.navy}}>{s.sessions}</span>
                  <span style={{fontSize:10,color:C.muted}}> sessions</span>
                </div>
                <div style={{fontSize:10.5,fontWeight:700,
                  color:s.attendance_pct>=80?'#16a34a':s.attendance_pct>=50?'#d97706':'#dc2626'}}>
                  {s.attendance_pct}%
                </div>
              </div>
            </div>
              );
            })}
            </div>
          )}
        </>
      )}
    </div>
  );
}


// ── Announcements Management Tab ─────────────────────────────────────────────
function AnnouncementsTab({ base }: { base: string }) {
  const H = hdr();
  const [list,    setList]    = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [title,   setTitle]   = React.useState('');
  const [body,    setBody]    = React.useState('');
  const [pinned,  setPinned]  = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [error,   setError]   = React.useState('');
  const [expires, setExpires] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/announcements`, { headers: H });
      const j = await r.json();
      if (j.announcements) setList(j.announcements);
    } catch {}
    finally { setLoading(false); }
  }, [base]);

  React.useEffect(() => { load(); }, []);

  const post = async () => {
    if (!title.trim() || !body.trim()) { setError('Title and message required'); return; }
    setPosting(true); setError('');
    try {
      const r = await fetch(`${base}/api/data/announcements`, {
        method: 'POST', headers: {...H, 'Content-Type':'application/json'},
        body: JSON.stringify({ title: title.trim(), body: body.trim(), pinned, expires_at: expires || null })
      });
      if (r.ok) { setTitle(''); setBody(''); setPinned(false); setExpires(''); await load(); }
      else setError('Failed to post');
    } catch { setError('Network error'); }
    finally { setPosting(false); }
  };

  const del = async (id: number) => {
    if (!confirm('Delete this announcement?')) return;
    await fetch(`${base}/api/data/announcements/${id}`, { method: 'DELETE', headers: H });
    await load();
  };

  return (
    <div style={{padding:'8px 10px'}}>
      {/* Post form */}
      <div style={{backgroundColor:C.card,borderRadius:14,padding:'10px 12px',
        marginBottom:10,boxShadow:'0 1px 4px rgba(0,0,0,0.07)'}}>
        <div style={{fontWeight:800,fontSize:13,color:C.navy,marginBottom:10,
          textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>📢 New Announcement</div>
        <input value={title} onChange={e=>setTitle(e.target.value)}
          placeholder="Title" maxLength={100}
          style={{width:'100%',padding:'8px 10px',borderRadius:9,marginBottom:6,
            border:`1px solid ${C.border}`,fontSize:14,outline:'none',
            boxSizing:'border-box' as const}}/>
        <textarea value={body} onChange={e=>setBody(e.target.value)}
          placeholder="Message…" rows={3} maxLength={500}
          style={{width:'100%',padding:'8px 10px',borderRadius:9,marginBottom:6,
            border:`1px solid ${C.border}`,fontSize:13,outline:'none',resize:'none' as const,
            boxSizing:'border-box' as const}}/>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
          <button onClick={()=>setPinned(v=>!v)}
            style={{padding:'6px 14px',borderRadius:20,border:'none',cursor:'pointer',
              fontWeight:700,fontSize:12,
              backgroundColor:pinned?'#c5a059':'#f3f4f6',
              color:pinned?'#fff':'#374151'}}>
            📌 {pinned ? 'Pinned' : 'Pin it'}
          </button>
          <div style={{fontSize:11,color:C.muted}}>{body.length}/500</div>
        </div>
        {/* Expiry picker */}
        <div style={{marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:5}}>
            ⏰ Auto-expire (optional — leave blank for permanent)
          </div>
          <input type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)}
            style={{width:'100%',padding:'7px 10px',borderRadius:9,
              border:`1px solid ${C.border}`,fontSize:13,outline:'none',
              boxSizing:'border-box' as const,color:expires?'#111':'#9ca3af'}}/>
          {expires && (
            <div style={{fontSize:11,color:'#6b7280',marginTop:4}}>
              Will auto-hide after {new Date(expires).toLocaleString()}
              <button onClick={()=>setExpires('')}
                style={{background:'none',border:'none',color:'#dc2626',
                  cursor:'pointer',marginLeft:8,fontSize:11}}>Clear</button>
            </div>
          )}
        </div>
        {error && <div style={{color:'#dc2626',fontSize:12,marginBottom:8}}>{error}</div>}
        <button onClick={post} disabled={posting}
          style={{width:'100%',padding:'9px',borderRadius:10,border:'none',
            backgroundColor:C.navy,color:'#fff',fontWeight:800,fontSize:14,
            cursor:posting?'not-allowed':'pointer',opacity:posting?0.7:1}}>
          {posting ? 'Posting…' : 'Post Announcement'}
        </button>
      </div>

      {/* List */}
      {loading ? <div style={{textAlign:'center',padding:20,color:C.muted}}>Loading…</div>
      : list.length === 0 ? <div style={{textAlign:'center',padding:20,color:C.muted,fontSize:13}}>No announcements yet</div>
      : list.map((a:any) => (
        <div key={a.id} style={{backgroundColor:C.card,borderRadius:12,
          marginBottom:6,padding:'9px 12px',
          borderLeft:`4px solid ${a.pinned?'#c5a059':C.navy}`,
          boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div style={{flex:1}}>
              {a.pinned && <div style={{fontSize:10,fontWeight:800,color:'#c5a059',
                marginBottom:4}}>📌 PINNED</div>}
              <div style={{fontWeight:800,fontSize:13,color:C.navy}}>{a.title}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:3}}>{a.body}</div>
              <div style={{fontSize:10,color:C.muted,marginTop:6}}>
                By {a.created_by} · {new Date(a.created_at).toLocaleDateString()}
              </div>
            </div>
            <button onClick={()=>del(a.id)}
              style={{background:'none',border:'none',color:'#dc2626',
                fontSize:18,cursor:'pointer',padding:'0 0 0 10px',flexShrink:0}}>🗑</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Player of Month Tab ───────────────────────────────────────────────────────
function PlayerOfMonthTab({ base }: { base: string }) {
  const H = hdr();
  const now = new Date();
  const [month,    setMonth]    = React.useState(now.toISOString().slice(0,7));
  const [current,  setCurrent]  = React.useState<any>(null);
  const [students, setStudents] = React.useState<any[]>([]);
  const [search,   setSearch]   = React.useState('');
  const [reason,   setReason]   = React.useState('');
  const [highlights, setHighlights] = React.useState('');
  const [selected, setSelected] = React.useState<any>(null);
  const [saving,   setSaving]   = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [loading,  setLoading]  = React.useState(false);

  const loadMonth = React.useCallback(async (m: string) => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/player-of-month?month=${m}`, {headers:H});
      const j = await r.json();
      setCurrent(j.player || null);
      setReason(j.player?.reason || '');
      setHighlights(j.player?.highlights || '');
    } catch {} finally { setLoading(false); }
  }, [base]);

  React.useEffect(() => {
    loadMonth(month);
    fetch(`${base}/api/data/utils/students?limit=500`,{headers:H})
      .then(r=>r.json()).then(j=>{if(j.data)setStudents(j.data);}).catch(()=>{});
  }, [month]);

  const save = async () => {
    if (!selected && !current) return;
    setSaving(true);
    try {
      const r = await fetch(`${base}/api/data/player-of-month`, {
        method:'POST', headers:{...H,'Content-Type':'application/json'},
        body: JSON.stringify({
          student_id: selected?.id || current?.student_id,
          month, reason, highlights
        })
      });
      if (r.ok) { await loadMonth(month); setSelected(null); setSearch(''); }
    } catch {} finally { setSaving(false); }
  };

  const del = async () => {
    if (!confirm('Remove Player of Month for this period?')) return;
    setDeleting(true);
    try {
      const r = await fetch(`${base}/api/data/player-of-month/${month}`, {
        method:'DELETE', headers:H
      });
      if (r.ok) { setCurrent(null); setReason(''); setHighlights(''); }
    } catch {} finally { setDeleting(false); }
  };

  const filtered = search ? students.filter(s=>matchesStudentSearch(s,search)) : [];

  const monthLabel = new Date(month+'-01').toLocaleString('default',{month:'long',year:'numeric'});

  return (
    <div style={{padding:'8px 10px'}}>
      {/* Month selector */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
        <button onClick={()=>{const d=new Date(month+'-01');d.setMonth(d.getMonth()-1);const m=d.toISOString().slice(0,7);setMonth(m);loadMonth(m);}}
          style={{padding:'8px 14px',borderRadius:10,border:`1px solid ${C.border}`,backgroundColor:'#fff',cursor:'pointer',fontWeight:700}}>←</button>
        <div style={{flex:1,textAlign:'center',fontWeight:800,fontSize:14,color:C.navy}}>{monthLabel}</div>
        <button onClick={()=>{const d=new Date(month+'-01');d.setMonth(d.getMonth()+1);const m=d.toISOString().slice(0,7);setMonth(m);loadMonth(m);}}
          style={{padding:'8px 14px',borderRadius:10,border:`1px solid ${C.border}`,backgroundColor:'#fff',cursor:'pointer',fontWeight:700}}>→</button>
      </div>

      {loading && <div style={{textAlign:'center',padding:20,color:C.muted}}>Loading…</div>}

      {/* Current player card */}
      {!loading && current && (
        <div style={{backgroundColor:'#001f3f',borderRadius:16,padding:'16px',
          marginBottom:14,boxShadow:'0 4px 16px rgba(0,31,63,0.3)'}}>
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12}}>
            <span style={{fontSize:10,fontWeight:800,color:'#c5a059',
              textTransform:'uppercase' as const,letterSpacing:'1.5px'}}>
              ⭐ Player of the Month — {monthLabel}
            </span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:12}}>
            <MemberAvatar item={{name:current.name,profile_image:current.profile_image}} size={60}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:900,fontSize:17,color:'#fff'}}>{current.name}</div>
              <div style={{fontSize:11,color:'#c5a059',fontWeight:700,marginTop:2}}>
                {current.qca_id ? String(current.qca_id).padStart(3,'0') : current.regno_fmt} · {current.level||'Academy'}
              </div>
              <div style={{fontSize:10,color:'rgba(255,255,255,0.4)',marginTop:3}}>
                Set by {current.nominated_by} · {new Date(current.created_at).toLocaleDateString()}
              </div>
            </div>
          </div>

          {current.reason && (
            <div style={{backgroundColor:'rgba(255,255,255,0.08)',borderRadius:10,
              padding:'10px 12px',marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:'#c5a059',marginBottom:4}}>
                🏆 REASON FOR SELECTION
              </div>
              <div style={{fontSize:13,color:'rgba(255,255,255,0.85)',lineHeight:1.5}}>
                {current.reason}
              </div>
            </div>
          )}

          {current.highlights && (
            <div style={{backgroundColor:'rgba(255,255,255,0.06)',borderRadius:10,
              padding:'10px 12px',marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:'#c5a059',marginBottom:4}}>
                ✨ HIGHLIGHTS
              </div>
              <div style={{fontSize:13,color:'rgba(255,255,255,0.75)',lineHeight:1.5}}>
                {current.highlights}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{display:'flex',gap:8,marginTop:10}}>
            <button onClick={del} disabled={deleting}
              style={{flex:1,padding:'9px',borderRadius:10,border:'1px solid rgba(220,38,38,0.5)',
                backgroundColor:'rgba(220,38,38,0.15)',color:'#fca5a5',
                fontWeight:700,fontSize:13,cursor:'pointer'}}>
              {deleting?'Removing…':'🗑 Remove'}
            </button>
            <button onClick={()=>{setSelected({id:current.student_id,name:current.name,regno:current.regno,profile_image:current.profile_image,level:current.level});}}
              style={{flex:1,padding:'9px',borderRadius:10,border:'1px solid rgba(197,160,89,0.5)',
                backgroundColor:'rgba(197,160,89,0.15)',color:'#c5a059',
                fontWeight:700,fontSize:13,cursor:'pointer'}}>
              ✏️ Edit Details
            </button>
          </div>
        </div>
      )}

      {/* Select / Edit form */}
      <div style={{backgroundColor:C.card,borderRadius:14,padding:'10px 12px',
        boxShadow:'0 1px 4px rgba(0,0,0,0.07)'}}>
        <div style={{fontWeight:800,fontSize:13,color:C.navy,marginBottom:10,
          textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>
          {current && !selected ? '✏️ Update Details' : selected ? `📝 Editing: ${selected.name}` : '⭐ Set Player of the Month'}
        </div>

        {!selected ? (
          <>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search student by name or Reg No…"
              style={{width:'100%',padding:'8px 10px',borderRadius:9,marginBottom:6,
                border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const}}/>
            {filtered.slice(0,6).map((s:any)=>(
              <div key={s.id} onClick={()=>{setSelected(s);setSearch('');}}
                style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',
                  borderRadius:10,cursor:'pointer',marginBottom:4,
                  backgroundColor:'#f9fafb',border:`1px solid ${C.border}`}}>
                <MemberAvatar item={s} size={32}/>
                <div>
                  <div style={{fontWeight:600,fontSize:13}}>{s.name}</div>
                  <div style={{fontSize:11,color:C.muted}}>{s.qca_id ? String(s.qca_id).padStart(3,'0') : formatRegno(s.regno)} · {s.level||'—'}</div>
                </div>
              </div>
            ))}
            {current && (
              <div style={{textAlign:'center',padding:'8px 0',fontSize:12,color:C.muted}}>
                Or update reason/highlights below without changing student
              </div>
            )}
          </>
        ) : (
          <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',
            backgroundColor:'#f0f9ff',borderRadius:10,marginBottom:10,
            border:`1px solid ${C.border}`}}>
            <MemberAvatar item={selected} size={36}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:13}}>{selected.name}</div>
              <div style={{fontSize:11,color:C.muted}}>{selected.qca_id ? String(selected.qca_id).padStart(3,'0') : formatRegno(selected.regno)}</div>
            </div>
            <button onClick={()=>setSelected(null)}
              style={{background:'none',border:'none',color:'#dc2626',
                fontSize:18,cursor:'pointer'}}>✕</button>
          </div>
        )}

        <textarea value={reason} onChange={e=>setReason(e.target.value)}
          placeholder="Reason for selection e.g. Outstanding batting performance, scored 3 half-centuries…"
          rows={3} maxLength={300}
          style={{width:'100%',padding:'8px 10px',borderRadius:9,marginBottom:6,
            border:`1px solid ${C.border}`,fontSize:13,outline:'none',
            resize:'none' as const,boxSizing:'border-box' as const}}/>

        <textarea value={highlights} onChange={e=>setHighlights(e.target.value)}
          placeholder="Key highlights e.g. 245 runs in 5 matches, 89% attendance, Best fielder award…"
          rows={2} maxLength={200}
          style={{width:'100%',padding:'10px 12px',borderRadius:10,marginBottom:10,
            border:`1px solid ${C.border}`,fontSize:13,outline:'none',
            resize:'none' as const,boxSizing:'border-box' as const}}/>

        <button onClick={save} disabled={saving||(!selected&&!current)}
          style={{width:'100%',padding:'9px',borderRadius:10,border:'none',
            backgroundColor:(selected||current)?C.navy:'#e5e7eb',
            color:(selected||current)?'#fff':'#9ca3af',
            fontWeight:800,fontSize:14,
            cursor:(selected||current)?'pointer':'not-allowed'}}>
          {saving ? 'Saving…' : selected ? '⭐ Set as Player of Month' : '💾 Update Details'}
        </button>
      </div>
    </div>
  );
}



export default function UtilitiesScreen(){
  const navigate = useNavigate();
  const base     = bld(localStorage.getItem('server_ip')??'');
  const { can }  = usePermissions();

  // Tab visibility is permission-driven -- each tab has its own slug
  // so it can be assigned independently to any role via admin panel.
  const ALL_TABS:[UtilTab,string,string][] = [
    ['students',  '👥 Students',       'utils:students'],
    ['attendance','📋 Attendance',     'utils:attendance'],
    ['payments',  '💰 Payments',       'utils:payments'],
    ['report',    '📊 Report',         'utils:report'],
    ['inactive',  '🚫 Inactive Review','utils:inactive'],
      ['agegroups', '🏏 Age Groups',      'utils:agegroups'],
      ['birthdays',    '🎂 Birthdays',       'utils:agegroups'],
      ['leaderboard', '🏆 Leaderboard',    'utils:leaderboard'],
      ['announce',   '📢 Announcements', 'app:announcements:manage'],
      ['potm',       '⭐ Player of Month','app:player_of_month'],
  ];

  const TABS = ALL_TABS.filter(([,,slug]) => can(slug as any));

  // Access denied if no utils permissions at all
  if (TABS.length === 0) {
    return (
      <div style={{ backgroundColor:'#f0f4f1', minHeight:'100vh',
        display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
        <div style={{ textAlign:'center', color:'#6b7280' }}>
          <div style={{ fontSize:48, marginBottom:12 }}>🔒</div>
          <div style={{ fontWeight:800, fontSize:16, color:'#0d1b2a' }}>Access Restricted</div>
          <div style={{ fontSize:13, marginTop:6 }}>No utilities permissions assigned</div>
          <button onClick={() => navigate(-1)}
            style={{ marginTop:16, padding:'8px 20px', borderRadius:20, border:'none',
              backgroundColor:'#1a472a', color:'#fff', fontWeight:700, cursor:'pointer' }}>
            ← Go Back
          </button>
        </div>
      </div>
    );
  }

  const [tab,setTab] = useState<UtilTab>(TABS[0][0]);

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100vh',fontFamily:'sans-serif',paddingBottom:40}}>
      <ScreenHeader background={`linear-gradient(135deg,${C.navy} 0%,#0d2b4a 100%)`}
        title={<span style={{color:C.gold}}>🛠 Utilities</span>}
        subtitle="Admin monitoring & reports">
        <HeaderTabs color={C.navy} value={tab} onChange={k=>setTab(k as UtilTab)}
          tabs={TABS.map(([id,label])=>({id:id as UtilTab,label}))} />
      </ScreenHeader>

      {/* Content */}
      {tab==='students'   && <StudentsTab   base={base}/>}
      {tab==='attendance' && <AttendanceTab base={base}/>}
      {tab==='payments'   && <PaymentsTab   base={base}/>}
      {tab==='report'     && <MonthlyReportTab base={base}/>}
      {tab==='inactive'   && <InactiveTab   base={base}/>}
      {tab==='agegroups'  && <AgeGroupsTab  base={base}/>}
      {tab==='birthdays'    && <BirthdaysTab/>}
      {tab==='leaderboard' && <LeaderboardTab base={base}/>}
      {tab==='announce'   && <AnnouncementsTab base={base}/>}
      {tab==='potm'       && <PlayerOfMonthTab base={base}/>}
    </div>
  );
}
