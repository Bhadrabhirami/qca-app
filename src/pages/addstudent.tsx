import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getPendingTempStudents, resolveTempStudent,
  deleteTempStudent, syncAllStudents, TempStudent,
} from '../database/db';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

const C = {
  navy:'#001f3f', gold:'#c5a059', green:'#1a472a', red:'#dc2626',
  gray:'#6b7280', bg:'#f0f4f0', border:'#d1d5db', muted:'#9ca3af', blue:'#2563eb',
};
const INP: React.CSSProperties = {
  width:'100%', padding:'10px 12px', borderRadius:10,
  border:`1px solid ${C.border}`, fontSize:14, fontFamily:'sans-serif',
  outline:'none', backgroundColor:'#fff',
};

const STATUS_OPTS   = ['Active','Club Member','Camp','Inactive'];
const CATEGORY_OPTS = ['REGULAR','TEMPORARY','SCHOLARSHIP'];

function buildBase(ip: string) {
  const u = (ip||'').trim().replace(/\/+$/,'');
  return u.startsWith('http') ? u : `http://${u}`;
}
function hdrs() {
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

// ── Smart date picker (reused from editprofile) ───────────────────────────────
function SmartDatePicker({ value, onChange, maxDate }: {
  value:string; onChange:(v:string)=>void; maxDate?:string;
}) {
  const now  = new Date();
  const maxY = maxDate ? parseInt(maxDate.split('-')[0]) : now.getFullYear();

  // Keep internal state for each part independently
  const parts = value ? value.split('-') : ['','',''];
  const [yr, setYr] = React.useState(parts[0]||'');
  const [mo, setMo] = React.useState(parts[1]||'');
  const [dy, setDy] = React.useState(parts[2]||'');

  // Sync from external value changes
  React.useEffect(()=>{
    const p = value ? value.split('-') : ['','',''];
    setYr(p[0]||''); setMo(p[1]||''); setDy(p[2]||'');
  }, [value]);

  const years  = Array.from({length: maxY-1990+1}, (_,i)=>String(maxY-i));
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const daysInMonth = (y:string, m:string) =>
    (!y||!m) ? 31 : new Date(parseInt(y), parseInt(m), 0).getDate();

  const days = Array.from(
    {length: daysInMonth(yr, mo)},
    (_,i) => String(i+1).padStart(2,'0')
  );

  // Called whenever any part changes — emits full date only when all 3 set
  const emit = (y:string, m:string, d:string) => {
    if (y && m && d) {
      // Clamp day to valid range for selected month/year
      const maxD = daysInMonth(y, m);
      const clampedD = String(Math.min(parseInt(d), maxD)).padStart(2,'0');
      onChange(`${y}-${m}-${clampedD}`);
    } else {
      onChange('');
    }
  };

  const handleDay = (v:string) => { setDy(v); emit(yr, mo, v); };
  const handleMo  = (v:string) => {
    setMo(v);
    // Clamp day when month changes (e.g. Jan 31 → Feb = clamp to 28)
    const clampedD = dy && v && yr
      ? String(Math.min(parseInt(dy), daysInMonth(yr,v))).padStart(2,'0')
      : dy;
    setDy(clampedD);
    emit(yr, v, clampedD);
  };
  const handleYr  = (v:string) => { setYr(v); emit(v, mo, dy); };

  const sel:React.CSSProperties = {
    padding:'10px 6px', borderRadius:8, border:`1px solid ${C.border}`,
    fontSize:14, backgroundColor:'#fff', flex:1, cursor:'pointer',
    WebkitAppearance:'menulist',  // ensures native dropdown on Android
  };

  return (
    <div style={{display:'flex',gap:8}}>
      <select value={dy} onChange={e=>handleDay(e.target.value)} style={sel}>
        <option value="">Day</option>
        {days.map(d=><option key={d} value={d}>{parseInt(d)}</option>)}
      </select>
      <select value={mo} onChange={e=>handleMo(e.target.value)} style={{...sel,flex:1.5}}>
        <option value="">Month</option>
        {months.map((m,i)=><option key={m} value={m}>{mNames[i]}</option>)}
      </select>
      <select value={yr} onChange={e=>handleYr(e.target.value)} style={{...sel,flex:1.5}}>
        <option value="">Year</option>
        {years.map(y=><option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ msg, onDone }: { msg:{text:string;type:'success'|'error'|'info'}|null; onDone:()=>void }) {
  useEffect(()=>{ if(!msg)return; const t=setTimeout(onDone,msg.type==='success'?3000:5000); return()=>clearTimeout(t); },[msg]);
  if (!msg) return null;
  const bg = msg.type==='success'?'#166534':msg.type==='error'?'#991b1b':'#1e40af';
  return (
    <div style={{position:'fixed',bottom:20,left:16,right:16,zIndex:9999,backgroundColor:bg,
      color:'#fff',borderRadius:14,padding:'14px 18px',fontSize:14,fontWeight:700,
      boxShadow:'0 8px 30px rgba(0,0,0,0.3)',display:'flex',alignItems:'center',gap:10}}>
      <span style={{flex:1}}>{msg.text}</span>
      <button onClick={onDone} style={{background:'none',border:'none',color:'rgba(255,255,255,0.7)',fontSize:20,cursor:'pointer'}}>✕</button>
    </div>
  );
}

// ── Pending student card ──────────────────────────────────────────────────────
function PendingCard({ s, onDelete }: {
  s: TempStudent;
  onDelete: (tempId:number)=>void;
}) {
  return (
    <div style={{backgroundColor:'#fff',borderRadius:12,padding:'12px 14px',marginBottom:10,
      boxShadow:'0 1px 6px rgba(0,0,0,0.07)',borderLeft:`4px solid ${C.gold}`}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div style={{flex:1}}>
          <div style={{fontWeight:800,fontSize:14,color:C.navy}}>{s.name}</div>
          <div style={{fontSize:11,color:C.muted,marginTop:2}}>
            DOB: {s.date_of_birth} · {s.status} · {s.student_category}
          </div>
          <div style={{fontSize:11,color:C.muted}}>
            Added: {s.created_at.split('T')[0]} · TMP-{s.temp_id}
          </div>
        </div>
        <button onClick={()=>onDelete(s.temp_id)}
          style={{padding:'4px 10px',borderRadius:8,border:'none',cursor:'pointer',
            backgroundColor:C.red+'15',color:C.red,fontWeight:700,fontSize:11,flexShrink:0}}>
          🗑 Remove
        </button>
      </div>
      <div style={{marginTop:8,padding:'6px 10px',borderRadius:8,
        backgroundColor:'#fef3c7',fontSize:11,color:'#92400e',fontWeight:600,lineHeight:1.5}}>
        ⏳ Pending server ID — attendance is being captured locally as TMP-{s.temp_id}.<br/>
        <strong>Auto-registers on next Sync → Upload Attendance.</strong> No action needed.
      </div>
    </div>
  );
}

// ── Resolve modal — link temp to real server ID ───────────────────────────────
function ResolveModal({ tempStudent, onClose, onResolved }: {
  tempStudent: TempStudent;
  onClose: ()=>void;
  onResolved: (tempId:number, serverId:number)=>void;
}) {
  const base = buildBase(localStorage.getItem('server_ip')||'');
  const H = hdrs();
  const [serverId, setServerId] = useState('');
  const [searching, setSearching] = useState(false);
  const [serverStudent, setServerStudent] = useState<any>(null);
  const [err, setErr] = useState('');

  const search = async () => {
    if (!serverId.trim()) return;
    setSearching(true); setErr(''); setServerStudent(null);
    try {
      const res = await fetch(`${base}/api/data/students/${serverId}/profile`, {headers:H});
      const j = await res.json();
      if (!res.ok) throw new Error(j.error||`HTTP ${res.status}`);
      setServerStudent(j.data);
    } catch(e:any) { setErr(e.message); }
    setSearching(false);
  };

  const confirm = async () => {
    if (!serverStudent) return;
    try {
      await resolveTempStudent(tempStudent.temp_id, serverStudent.id);
      onResolved(tempStudent.temp_id, serverStudent.id);
    } catch(e:any) { setErr(e.message); }
  };

  return (
    <div style={{position:'fixed',inset:0,backgroundColor:'rgba(0,0,0,0.6)',zIndex:9000,
      display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
      <div style={{backgroundColor:'#fff',borderRadius:'20px 20px 0 0',padding:20,
        width:'100%',maxWidth:480,paddingBottom:36}}>
        <div style={{fontWeight:900,fontSize:16,color:C.navy,marginBottom:4}}>Link to Server Student</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:16}}>
          Find the server-registered student for <strong>{tempStudent.name}</strong> (TMP-{tempStudent.temp_id})
        </div>

        <div style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6}}>
          Enter Server Student ID
        </div>
        <div style={{display:'flex',gap:8,marginBottom:12}}>
          <input type="number" value={serverId} onChange={e=>setServerId(e.target.value)}
            placeholder="e.g. 1234" style={{...INP,flex:1}}/>
          <button onClick={search} disabled={searching}
            style={{padding:'10px 14px',borderRadius:10,border:'none',backgroundColor:C.navy,
              color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13}}>
            {searching?'…':'Search'}
          </button>
        </div>

        {err && <div style={{color:C.red,fontSize:13,marginBottom:10}}>⚠ {err}</div>}

        {serverStudent && (
          <div style={{backgroundColor:'#f0fdf4',borderRadius:10,padding:'12px 14px',marginBottom:14,
            border:`1px solid #86efac`}}>
            <div style={{fontWeight:800,fontSize:14,color:C.green}}>✓ Found: {serverStudent.name}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>
              ID: {serverStudent.id} · {serverStudent.status} · {serverStudent.student_category}
            </div>
            <div style={{fontSize:11,color:C.muted}}>DOB: {serverStudent.date_of_birth}</div>
          </div>
        )}

        <div style={{display:'flex',gap:10}}>
          {serverStudent && (
            <button onClick={confirm}
              style={{flex:1,padding:'12px',borderRadius:10,border:'none',backgroundColor:C.green,
                color:'#fff',fontWeight:800,fontSize:14,cursor:'pointer'}}>
              ✔ Confirm Link
            </button>
          )}
          <button onClick={onClose}
            style={{flex:1,padding:'12px',borderRadius:10,border:`1px solid ${C.border}`,
              backgroundColor:'#fff',color:C.gray,fontWeight:700,fontSize:14,cursor:'pointer'}}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ══════════════════════════════════════════════════════════════════════════════
export default function AddStudentScreen() {
  const navigate = useNavigate();
  const today    = new Date().toISOString().split('T')[0];

  // Form state
  const [name,     setName]     = useState('');
  const [dob,      setDob]      = useState('');
  const [status,   setStatus]   = useState('Active');
  const [category, setCategory] = useState('REGULAR');
  const [enrollDate, setEnrollDate] = useState(today);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<{text:string;type:'success'|'error'|'info'}|null>(null);

  // Pending list
  const [pending,  setPending]  = useState<TempStudent[]>([]);

  const [tab,      setTab]      = useState<'add'|'pending'>('add');

  const showToast = (text:string, type:'success'|'error'|'info'='info') => setToast({text,type});

  useEffect(() => { loadPending(); }, []);

  const loadPending = async () => {
    const rows = await getPendingTempStudents();
    setPending(rows);
  };

  const calcAge = (d:string) => {
    if (!d) return '';
    const b=new Date(d), t=new Date();
    let a=t.getFullYear()-b.getFullYear();
    if(t.getMonth()<b.getMonth()||(t.getMonth()===b.getMonth()&&t.getDate()<b.getDate()))a--;
    return a>=0?`${a} yrs`:'';
  };

  const handleAdd = async () => {
    if (!name.trim())  { showToast('⚠ Name is required','error'); return; }
    if (!dob)          { showToast('⚠ Date of Birth is required','error'); return; }
    if (!enrollDate)   { showToast('⚠ Enrollment date is required','error'); return; }

    const ip = localStorage.getItem('server_ip') || '';
    if (!ip) { showToast('⚠ No server configured - set this up in Settings first','error'); return; }

    setSaving(true);
    try {
      const base = buildBase(ip);

      // Register directly on the server - same endpoint the Sync screen
      // already uses to register pending temp students.
      const res = await fetch(`${base}/api/data/students/register`, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({
          name: name.trim(), date_of_birth: dob,
          status, student_category: category, enrollment_date: enrollDate,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Server error (HTTP ${res.status})`);
      const serverId = j.student_id ?? j.id;
      if (!serverId) throw new Error('Server did not return a student ID');

      // Sync the canonical record straight back into the local DB - the
      // student exists locally with their real server ID immediately,
      // no TMP placeholder and nothing to resolve later.
      const profRes = await fetch(`${base}/api/data/students/${serverId}/profile`, { headers: hdrs() });
      const profJ = await profRes.json().catch(() => ({}));
      if (!profRes.ok || !profJ.data) {
        throw new Error(`Registered as ID ${serverId}, but couldn't sync the profile back - pull-to-refresh Students to pick it up.`);
      }
      await syncAllStudents([profJ.data]);

      showToast(`✔ ${name.trim()} registered (ID ${serverId}) and saved locally.`, 'success');
      setName(''); setDob(''); setStatus('Active'); setCategory('REGULAR');
      setEnrollDate(today);
    } catch(e:any) {
      showToast(`⚠ ${e.message || 'Network error - check connection'}`, 'error');
    }
    setSaving(false);
  };

  const handleDelete = async (tempId:number) => {
    if (!window.confirm('Delete this temp student and all their attendance records?')) return;
    await deleteTempStudent(tempId);
    await loadPending();
    showToast('Deleted','info');
  };

  // NOTE: ResolveModal / handleResolved are currently not reachable — no
  // button opens the modal (removed by an earlier patch). Kept for restoring.
  const handleResolved = async (tempId:number, serverId:number) => {
    await loadPending();
    showToast(`✔ TMP-${tempId} linked to server ID ${serverId}. Attendance migrated ✓`,'success');
  };

  return (
    <div style={{backgroundColor:C.bg,minHeight:'100vh',fontFamily:'sans-serif',paddingBottom:80}}>
      <ScreenHeader title="➕ Add Student" background={C.navy}
        subtitle="Registers directly on the server - requires a connection"
        actions={pending.length > 0 ? (
          <div style={{backgroundColor:C.gold,color:C.navy,borderRadius:12,
            padding:'3px 10px',fontSize:12,fontWeight:800,marginRight:8}}>
            {pending.length} pending
          </div>
        ) : undefined}>
        <HeaderTabs color={C.navy} value={tab as string} onChange={k => setTab(k as any)}
          tabs={[{ id:'add', label:'➕ Add New' }, { id:'pending', label:`⏳ Pending (${pending.length})` }]} />
      </ScreenHeader>

      <div style={{padding:'14px 16px'}}>

        {/* ── Add tab ─────────────────────────────────────────────── */}
        {tab==='add' && (
          <div style={{backgroundColor:'#fff',borderRadius:14,padding:16,boxShadow:'0 2px 10px rgba(0,0,0,0.08)'}}>
            <div style={{fontWeight:800,fontSize:15,color:C.navy,marginBottom:4}}>New Student</div>
            <div style={{fontSize:11,color:C.muted,marginBottom:14,padding:'7px 10px',
              backgroundColor:'#fef3c7',borderRadius:8,lineHeight:1.5}}>
              📋 Minimum info only. Full profile editing is available after the student is registered on the server.
              Attendance recorded here will be automatically migrated once linked.
            </div>

            {/* Name */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',
                letterSpacing:'0.5px',marginBottom:5}}>
                Full Name <span style={{color:C.red}}>*</span>
              </div>
              <input type="text" value={name} onChange={e=>setName(e.target.value)}
                placeholder="Student full name" style={INP}/>
            </div>

            {/* DOB */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',
                letterSpacing:'0.5px',marginBottom:5}}>
                Date of Birth <span style={{color:C.red}}>*</span>
                {dob && <span style={{marginLeft:8,fontSize:11,color:C.blue,fontWeight:600,textTransform:'none'}}>
                  {calcAge(dob)}
                </span>}
              </div>
              <SmartDatePicker value={dob} onChange={setDob} maxDate={today}/>
            </div>

            {/* Enrollment date */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',
                letterSpacing:'0.5px',marginBottom:5}}>
                Enrollment Date <span style={{color:C.red}}>*</span>
              </div>
              <SmartDatePicker value={enrollDate} onChange={setEnrollDate} maxDate={today}/>
            </div>

            {/* Status */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',
                letterSpacing:'0.5px',marginBottom:5}}>
                Account Status <span style={{color:C.red}}>*</span>
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {STATUS_OPTS.map(s=>(
                  <button key={s} onClick={()=>setStatus(s)}
                    style={{padding:'6px 14px',borderRadius:8,border:`2px solid ${status===s?C.navy:C.border}`,
                      backgroundColor:status===s?C.navy:'#fff',
                      color:status===s?'#fff':C.gray,fontWeight:700,fontSize:12,cursor:'pointer'}}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Category */}
            <div style={{marginBottom:20}}>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',
                letterSpacing:'0.5px',marginBottom:5}}>
                Category <span style={{color:C.red}}>*</span>
              </div>
              <div style={{display:'flex',gap:6}}>
                {CATEGORY_OPTS.map(c=>(
                  <button key={c} onClick={()=>setCategory(c)}
                    style={{flex:1,padding:'8px 4px',borderRadius:8,border:`2px solid ${category===c?C.green:C.border}`,
                      backgroundColor:category===c?C.green+'15':'#fff',
                      color:category===c?C.green:C.gray,fontWeight:700,fontSize:11,cursor:'pointer'}}>
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={handleAdd} disabled={saving}
              style={{width:'100%',padding:'14px',borderRadius:12,border:'none',
                backgroundColor:saving?C.muted:C.navy,color:'#fff',
                fontWeight:900,fontSize:15,cursor:saving?'not-allowed':'pointer'}}>
              {saving?'Adding…':'➕ Add Student Locally'}
            </button>
          </div>
        )}

        {/* ── Pending tab ─────────────────────────────────────────── */}
        {tab==='pending' && (
          <>
            {pending.length===0 ? (
              <div style={{textAlign:'center',padding:40,color:C.muted}}>
                <div style={{fontSize:40,marginBottom:10}}>✅</div>
                <div style={{fontWeight:700}}>No pending students</div>
                <div style={{fontSize:12,marginTop:4}}>All temp students have been linked to server IDs</div>
              </div>
            ) : (
              <>
                <div style={{fontSize:11,color:C.muted,marginBottom:12,padding:'8px 12px',
                  backgroundColor:'#fff7ed',borderRadius:8,lineHeight:1.5}}>
                  ℹ Register these students on the web admin, then tap <strong>Link ID</strong>
                  to migrate their attendance to the real server student ID.
                </div>
                {pending.map(s=>(
                  <PendingCard key={s.temp_id} s={s}
              
                    onDelete={handleDelete}/>
                ))}
              </>
            )}
          </>
        )}
      </div>



      <Toast msg={toast} onDone={()=>setToast(null)}/>
    </div>
  );
}
