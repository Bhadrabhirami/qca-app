import { matchesStudentSearch } from './studentUtils';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePullToRefresh } from './usePullToRefresh';
import { syncAttendanceOnly } from './useSyncService';
import { usePermissions, getLinkedStudentIds, isDataRestricted } from './usePermissions';
import {
  getAllStudents,
  getHistAttendanceForStudentMonth,
  getStudentAttendanceSummary,
  getHistMonthsForStudent,
  getSessionDaysForMonth,
  getHistOverview,
} from '../database/db';
import StudentPhoto from '../shared/StudentPhoto';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';
import EmptyAreaLogo from '../shared/EmptyAreaLogo';

function hdr() {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) { window.dispatchEvent(new Event('jwt-expired')); return {}; }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return {'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};
}


const C = {
  bg: '#0f1a13', card: '#162218', border: '#243828',
  green: '#1a472a', gold: '#d4af37', text: '#e8f5ec', muted: '#6b8f73',
  present: '#2e7d52', absent: '#8b1a1a', none: '#1e2e22', blue: '#2980b9',
};
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function daysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate(); }
function firstDayOfMonth(y: number, m: number) { return new Date(y, m-1, 1).getDay(); }
function fmtDate(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}



interface DayPopover { day:number; date:string; sessions:{present:boolean;session_type:string}[]; }

function CalendarGrid({ year, month, dayMap, sessionDays, onDayClick }: {
  year:number; month:number;
  dayMap:Record<string,{present:boolean;session_type:string}[]>;
  sessionDays?: Set<string>;
  onDayClick:(d:DayPopover)=>void;
}) {
  const totalDays = daysInMonth(year, month);
  const firstDay  = firstDayOfMonth(year, month);
  const cells: (number|null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({length:totalDays},(_,i)=>i+1),
  ];
  function cellColor(d: number) {
    const k = fmtDate(year, month, d);
    const s = dayMap[k];
    const hadSession = sessionDays?.has(k) ?? false;

    if (!hadSession) return C.none;               // no session this day (holiday, Monday etc.)

    const pc = s ? s.filter(x=>x.present).length : 0;
    if (pc === 0) return C.absent;                // session happened, student absent
    if (!s || pc === s.length) return C.present;  // all sessions present
    return '#8b6914';                             // partial
  }
  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:4, marginBottom:6 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign:'center', fontSize:9.5, color:C.muted, fontWeight:700, letterSpacing:'0.5px', textTransform:'uppercase' as const }}>{d}</div>
        ))}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:4 }}>
        {cells.map((d,i) => {
          if (d===null) return <div key={`e${i}`} />;
          const k = fmtDate(year, month, d);
          const sessions = dayMap[k] || [];
          const hadSession  = sessionDays?.has(k) ?? false;
          const hasSessions = hadSession;
          const bg = cellColor(d);
          const today = new Date();
          const isToday = today.getFullYear()===year && today.getMonth()+1===month && today.getDate()===d;
          return (
            <button key={d} onClick={() => hasSessions && onDayClick({day:d,date:k,sessions})}
              style={{
                height:36, borderRadius:8,
                border: isToday ? `2px solid ${C.gold}` : `1.5px solid ${hasSessions ? bg : C.border}`,
                backgroundColor: bg, cursor: hasSessions ? 'pointer' : 'default',
                display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:1,
              }}>
              <span style={{ fontSize:11, fontWeight:700, color: hasSessions ? '#fff' : C.muted }}>{d}</span>
              {hasSessions && (
                <div style={{ display:'flex', gap:2 }}>
                  {sessions.filter(s=>s.present).length > 0
                    ? sessions.filter(s=>s.present).slice(0,3).map((_,si) => (
                        <div key={si} style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'#81e8ad' }} />
                      ))
                    : <div style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'#f0808088' }} />
                  }
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayModal({ popover, onClose }: { popover:DayPopover; onClose:()=>void }) {
  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.7)', display:'flex', alignItems:'flex-end', zIndex:100 }} onClick={onClose}>
      <div style={{ backgroundColor:C.card, borderRadius:'20px 20px 0 0', padding:'20px 20px 36px', width:'100%', maxWidth:480, border:`1px solid ${C.border}` }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800, color:C.text }}>{popover.date}</div>
            <div style={{ fontSize:12, color:C.muted }}>{popover.sessions.length} session(s)</div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:`1px solid ${C.border}`, color:C.muted, borderRadius:8, padding:'4px 10px', cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {popover.sessions.map((s,i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:12, backgroundColor: s.present ? C.present+'33' : C.absent+'22', border:`1px solid ${s.present ? C.present : C.absent}44`, borderRadius:10, padding:'10px 14px' }}>
              <span style={{ fontSize:20 }}>{s.present ? '✅' : '❌'}</span>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.session_type}</div>
                <div style={{ fontSize:11, color: s.present ? '#81e8ad' : '#f08080' }}>{s.present ? 'Present' : 'Absent'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
/** "001 · Q030" — reg no and QCA ID, as shown on the other screens */
function studentIds(s: any): string {
  const t = String(s.regno ?? '').trim(), n = parseInt(t, 10);
  const reg = !t || t === '—' || t === '-' ? '' : isNaN(n) ? t : String(n).padStart(3, '0');
  return [reg,
          s.qca_id ? `Q${String(s.qca_id).padStart(3, '0')}` : ''].filter(Boolean).join(' · ');
}

export default function DashboardScreen() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const restricted = isDataRestricted();
  const linkedIds  = getLinkedStudentIds();
  const [query,    setQuery]    = useState('');

  // Announcements + Player of Month
  const [announcements,  setAnnouncements]  = React.useState<any[]>([]);
  const [playerOfMonth,  setPlayerOfMonth]  = React.useState<any>(null);

  React.useEffect(() => {
    const base2 = (localStorage.getItem('server_ip')||'').trim().replace(/\/+$/,'');
    if (!base2) return;
    const H2 = hdr();
    fetch(`${base2}/api/data/announcements`, {headers:H2})
      .then(r=>r.json()).then(j=>{ if(j.announcements) setAnnouncements(j.announcements.slice(0,5)); })
      .catch(()=>{});
    const monthStr = new Date().toISOString().slice(0,7);
    fetch(`${base2}/api/data/player-of-month?month=${monthStr}`, {headers:H2})
      .then(r=>r.json()).then(j=>{ if(j.player) setPlayerOfMonth(j.player); })
      .catch(()=>{});
  }, []);
  const [students, setStudents] = useState<any[]>([]);
  const [filtered, setFiltered] = useState<any[]>([]);
  const [selected, setSelected] = useState<any|null>(null);
  const [showDrop, setShowDrop] = useState(false);

  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()+1);

  const [dayMap,   setDayMap]   = useState<Record<string,{present:boolean;session_type:string}[]>>({});
  const [sessionDays, setSessionDays] = useState<Set<string>>(new Set());
  const [summary,  setSummary]  = useState<{total:number;present:number;pct:number}|null>(null);
  const [months,   setMonths]   = useState<string[]>([]);
  const [popover,  setPopover]  = useState<DayPopover|null>(null);
  const [loading,  setLoading]  = useState(false);
  const [overview, setOverview] = useState<{totalRecords:number;studentsWithData:number;presentCount:number}|null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAllStudents().catch(() => []).then(rows => {
      // Student/parent: filter to linked students only
      const filtered = restricted && linkedIds.length
        ? rows.filter((s: any) => linkedIds.includes(Number(s.id)))
        : restricted && linkedIds.length === 0 && restricted
          ? []
          : rows;
      setStudents(filtered);
      // Auto-select for student role (single student)
      if (restricted && filtered.length === 1) {
        setSelected(filtered[0]);
      }
    });
    getHistOverview().then(ov => setOverview(ov)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!query.trim()) { setFiltered([]); return; }
    const q = query.toLowerCase();
    setFiltered(students.filter(s =>
      matchesStudentSearch(s, q)
    ).slice(0, 8));
  }, [query, students]);

  const pickStudent = useCallback(async (s: any) => {
    setSelected(s);
    setQuery(s.name);
    setShowDrop(false);
    setLoading(true);

    // Decide which month to land on: enrollment month or current month
    let initYear = year;
    let initMonth = month;
    if (s.enrollment_date) {
      const [ey, em] = s.enrollment_date.split('-').map(Number);
      if (!isNaN(ey) && !isNaN(em)) {
        // Jump to current month but we know enrollment — months list will show all
      }
    }

    try {
      const fromDate = `${initYear}-${String(initMonth).padStart(2,'0')}-01`;
      const lastDay = new Date(initYear, initMonth, 0).getDate();
      const toDate = `${initYear}-${String(initMonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const [m, sum, ms, sd] = await Promise.all([
        getHistAttendanceForStudentMonth(s.id, initYear, initMonth),
        getStudentAttendanceSummary(s.id, fromDate, toDate),
        getHistMonthsForStudent(s.id),
        getSessionDaysForMonth(initYear, initMonth),
      ]);
      setDayMap(m);
      setSummary(sum);
      setMonths(ms);
      setSessionDays(sd);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  // Pull-to-refresh: 7-day attendance reconcile, then refresh selected student
  const { pullProps, PullIndicator } = usePullToRefresh(async () => {
    await syncAttendanceOnly();
    if (selected) await pickStudent(selected);
  });

  const changeMonth = async (ny: number, nm: number) => {
    if (nm < 1)  { nm = 12; ny--; }
    if (nm > 12) { nm = 1;  ny++; }
    setYear(ny); setMonth(nm);
    if (selected) {
      setLoading(true);
      // Calculate from/to for this month
      const fromDate = `${ny}-${String(nm).padStart(2,'0')}-01`;
      const lastDay = new Date(ny, nm, 0).getDate();
      const toDate = `${ny}-${String(nm).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const [m, sum, sd] = await Promise.all([
        getHistAttendanceForStudentMonth(selected.id, ny, nm),
        getStudentAttendanceSummary(selected.id, fromDate, toDate),
        getSessionDaysForMonth(ny, nm),
      ]);
      setDayMap(m);
      setSummary(sum);
      setSessionDays(sd);
      setLoading(false);
    }
  };

  const pctColor = (pct: number) => pct >= 75 ? '#4caf77' : pct >= 50 ? C.gold : C.absent;

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh', fontFamily:"'DM Sans','Segoe UI',sans-serif", color:C.text, paddingBottom:40, display:'flex', flexDirection:'column' }}
      {...pullProps}>
      <PullIndicator />

      <ScreenHeader title="Attendance Dashboard" back={() => navigate('/')}
        subtitle={<span style={{ color:C.gold, fontWeight:700, letterSpacing:'1px', fontSize:10 }}>STUDENT DASHBOARD</span>}
        actions={<HeaderIconButton label="Sync" onClick={() => navigate('/syncscreen')}>🔄</HeaderIconButton>} />

      <div style={{ padding:'10px 10px 0' }}>

        {/* ── Overview hint ── */}
        {overview && (
          <div style={{ marginBottom:10 }} title="Hager register overview">
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6 }}>
              {[
                { v: overview.totalRecords.toLocaleString(), l: 'Records',   c: C.gold },
                { v: overview.studentsWithData,              l: 'Students',  c: '#4caf77' },
                { v: overview.presentCount.toLocaleString(), l: 'Present',   c: C.present },
              ].map(x => (
                <div key={x.l} style={{ backgroundColor:C.card, borderRadius:10, padding:'7px 4px 6px', textAlign:'center',
                  border:`1px solid ${C.border}`, boxShadow:`inset 0 -3px 0 ${x.c}` }}>
                  <div style={{ fontSize:16, fontWeight:900, color:x.c, lineHeight:1.15 }}>{x.v}</div>
                  <div style={{ fontSize:9, color:C.muted, fontWeight:700, marginTop:2, textTransform:'uppercase' as const, letterSpacing:'0.4px' }}>{x.l}</div>
                </div>
              ))}
            </div>
            {overview.studentsWithData === 0 && (
              <div style={{ marginTop:8, padding:'7px 10px', borderRadius:8, backgroundColor:'#1e2e22', fontSize:12, color:C.muted, textAlign:'center' }}>
                No Hager data yet — use Sync → Hager Register to download
              </div>
            )}
          </div>
        )}

        {/* ── Search ── */}
        <div style={{ position:'relative', marginBottom:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, backgroundColor:C.card, border:`1.5px solid ${showDrop ? C.gold : C.border}`, borderRadius:12, padding:'8px 12px', transition:'border-color 0.2s' }}>
            <span style={{ fontSize:15, flexShrink:0 }}>🔍</span>
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setShowDrop(true); }}
              onFocus={() => setShowDrop(true)}
              placeholder="Search student by name or ID…"
              style={{ flex:1, background:'none', border:'none', outline:'none', color:C.text, fontSize:14, fontFamily:'inherit' }}
            />
            {query && (
              <button onClick={() => { setQuery(''); setSelected(null); setDayMap({}); setSummary(null); setShowDrop(false); }}
                style={{ background:'none', border:'none', color:C.muted, cursor:'pointer', fontSize:16 }}>✕</button>
            )}
          </div>

          {showDrop && filtered.length > 0 && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:30, backgroundColor:C.card, border:`1px solid ${C.border}`, borderRadius:12, marginTop:4, overflow:'hidden', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
              {filtered.map(s => (
                <button key={s.id} onClick={() => pickStudent(s)} style={{ width:'100%', display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'none', border:'none', cursor:'pointer', textAlign:'left', borderBottom:`1px solid ${C.border}` }}>
                  <StudentPhoto student={s} size={36} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{s.name}</div>
                    <div style={{ fontSize:11, color:C.muted }}>
                      {studentIds(s) || '—'} · {s.level||'—'} · {s.status}
                      {s.enrollment_date ? ` · enrolled ${s.enrollment_date}` : ''}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Student card ── */}
        {selected && (
          <div style={{ backgroundColor:C.card, borderRadius:14, padding:'10px 12px', border:`1px solid ${C.border}`, marginBottom:10 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <StudentPhoto student={selected} size={44} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:800, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{selected.name}</div>
                <div style={{ fontSize:11.5, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>
                  {studentIds(selected) || '—'} · {selected.level||'—'} · {selected.student_type||'Academy'}
                </div>
                {selected.enrollment_date && (
                  <div style={{ fontSize:11, color:C.gold, marginTop:2 }}>
                    Enrolled {selected.enrollment_date}
                    {summary && summary.total > 0 && <span style={{ color:C.muted }}> · {summary.total} sessions</span>}
                  </div>
                )}
              </div>
              {summary && (
                <div style={{ textAlign:'right' as const, flexShrink:0 }}>
                  <div style={{ fontSize:20, fontWeight:900, color:pctColor(summary.pct), lineHeight:1.1 }}>{summary.total > 0 ? summary.pct : '—'}%</div>
                  <div style={{ fontSize:10, color:C.muted }}>{summary.present}/{summary.total} present</div>
                </div>
              )}
            </div>
            {summary && summary.total > 0 && (
              <div title={`Present ${summary.present} of ${summary.total} sessions (all time)`}
                style={{ height:5, borderRadius:3, backgroundColor:C.border, overflow:'hidden', marginTop:8 }}>
                <div style={{ width:`${Math.round(summary.present / summary.total * 100)}%`, height:'100%', backgroundColor:pctColor(summary.pct) }} />
              </div>
            )}
          </div>
        )}

        {/* ── Month chips — only from enrollment_date onwards ── */}
        {selected && months.length > 0 && (
          <div style={{ marginBottom:8, overflowX:'auto', display:'flex', gap:6, paddingBottom:2, scrollbarWidth:'none' as any }}>
            {months
              .filter(ym => {
                if (!selected.enrollment_date) return true;
                return ym >= selected.enrollment_date.slice(0,7);
              })
              .map(ym => {
                const [y, m] = ym.split('-').map(Number);
                const active = y===year && m===month;
                return (
                  <button key={ym} onClick={() => changeMonth(y, m)}
                    style={{ flexShrink:0, padding:'4px 12px', borderRadius:20, fontSize:11, fontWeight:700, border: active ? `1.5px solid ${C.gold}` : `1.5px solid ${C.border}`, backgroundColor: active ? C.gold+'22' : C.card, color: active ? C.gold : C.muted, cursor:'pointer' }}>
                    {MONTHS[m-1].slice(0,3)} {y}
                  </button>
                );
              })}
          </div>
        )}

        {/* ── Calendar ── */}
        {selected && (
          <div style={{ backgroundColor:C.card, borderRadius:14, padding:'8px 10px 10px', border:`1px solid ${C.border}`, marginBottom:10 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
              <button onClick={() => changeMonth(year, month-1)} style={{ background:'none', border:`1px solid ${C.border}`, color:C.muted, borderRadius:8, padding:'4px 12px', cursor:'pointer', fontSize:16 }}>‹</button>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:15, fontWeight:800, color:C.text }}>{MONTHS[month-1]} {year}</div>
                {loading && <div style={{ fontSize:11, color:C.gold }}>loading…</div>}
              </div>
              <button onClick={() => changeMonth(year, month+1)} style={{ background:'none', border:`1px solid ${C.border}`, color:C.muted, borderRadius:8, padding:'4px 12px', cursor:'pointer', fontSize:16 }}>›</button>
            </div>
            {!loading && <CalendarGrid year={year} month={month} dayMap={dayMap} sessionDays={sessionDays} onDayClick={setPopover} />}
            <div style={{ display:'flex', gap:12, marginTop:8, justifyContent:'center' }}>
              {[{ color:C.present,label:'Present'},{color:C.absent,label:'Absent'},{color:'#8b6914',label:'Partial'},{color:C.none,label:'No data'}].map(l => (
                <div key={l.label} style={{ display:'flex', alignItems:'center', gap:5, fontSize:10, color:C.muted }}>
                  <div style={{ width:10, height:10, borderRadius:3, backgroundColor:l.color }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Empty state ── */}
        {!selected && (
          <div style={{ textAlign:'center', padding:'28px 20px', color:C.muted }}>
            <div style={{ fontSize:40, marginBottom:10 }}>📊</div>
            <div style={{ fontSize:17, fontWeight:700, color:C.text, marginBottom:8 }}>Student Attendance Dashboard</div>
            <div style={{ fontSize:13, lineHeight:1.7 }}>
              Search for a student above to view their<br/>attendance calendar and overall stats.
            </div>
            {overview && overview.studentsWithData > 0 && (
              <div style={{ marginTop:16, padding:'12px 16px', backgroundColor:C.card, borderRadius:12, border:`1px solid ${C.border}`, display:'inline-block' }}>
                <span style={{ color:C.gold, fontWeight:700 }}>{overview.studentsWithData}</span>
                <span style={{ color:C.muted, fontSize:12 }}> students have Hager data</span>
              </div>
            )}
          </div>
        )}

        {/* ── No data for month ── */}
        {selected && !loading && Object.keys(dayMap).length === 0 && (
          <div style={{ backgroundColor:C.card, borderRadius:14, padding:'24px', border:`1px solid ${C.border}`, textAlign:'center', color:C.muted }}>
            <div style={{ fontSize:32, marginBottom:8 }}>📭</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.text }}>No data for {MONTHS[month-1]} {year}</div>
            {selected.enrollment_date && month < parseInt(selected.enrollment_date.split('-')[1]) && year <= parseInt(selected.enrollment_date.split('-')[0]) && (
              <div style={{ fontSize:12, color:C.gold, marginTop:6 }}>
                Student enrolled {selected.enrollment_date} — try a later month.
              </div>
            )}
            <div style={{ fontSize:12, marginTop:6 }}>Try a different month or sync Hager data first.</div>
          </div>
        )}
      </div>

      <EmptyAreaLogo opacity={0.16} mottoColor={C.gold} />
      {popover && <DayModal popover={popover} onClose={() => setPopover(null)} />}
    </div>
  );
}
