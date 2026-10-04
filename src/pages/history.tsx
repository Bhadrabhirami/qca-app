/**
 * history.tsx — Attendance History Calendar
 * - Month calendar with dot indicators for recorded days
 * - Tap date → session breakdown with student list (photo + name)
 * - Present shown with photo, absent shown with name only
 * - Search within day's list
 * - Month/year navigation
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePullToRefresh } from './usePullToRefresh';
import { syncAttendanceOnly } from './useSyncService';
import { getActiveDatesInMonth, getAttendanceHistory } from '../database/db';
import StudentPhoto from '../shared/StudentPhoto';
import EmptyAreaLogo from '../shared/EmptyAreaLogo';
import ScreenHeader from '../shared/ScreenHeader';

const C = {
  green: '#1a472a', gold: '#d4af37', white: '#ffffff',
  bg: '#f0f4f1', card: '#ffffff', border: '#e0e0e0',
  gray: '#888', red: '#c0392b', navy: '#0d1b2a',
};

const DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

function getDaysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate(); }
function weekdayOf(y: number, m: number, d: number) { return (new Date(y,m-1,d).getDay()+6)%7; }
function toStr(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}


/** "001 · Q030" — reg no and QCA ID, as shown on the other screens */
function studentIds(s: any): string {
  const t = String(s.regno ?? '').trim(), n = parseInt(t, 10);
  const reg = !t || t === '—' || t === '-' ? '' : isNaN(n) ? t : String(n).padStart(3, '0');
  return [reg,
          s.qca_id ? `Q${String(s.qca_id).padStart(3, '0')}` : ''].filter(Boolean).join(' · ');
}

export default function HistoryScreen() {
  const navigate = useNavigate();
  const today    = new Date();
  const todayStr = toStr(today.getFullYear(), today.getMonth()+1, today.getDate());

  const [year,      setYear]      = useState(today.getFullYear());
  const [month,     setMonth]     = useState(today.getMonth()+1);
  const [activeDates, setActiveDates] = useState<Set<string>>(new Set());
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [sessionData,  setSessionData]  = useState<Record<string,any[]>>({});
  const [loadingCal,   setLoadingCal]   = useState(false);
  const [loadingDay,   setLoadingDay]   = useState(false);
  const [expandedSess, setExpandedSess] = useState<string|null>(null);
  const [search,       setSearch]       = useState('');

  const loadMonth = useCallback(async () => {
    setLoadingCal(true);
    try { setActiveDates(await getActiveDatesInMonth(year, month)); }
    finally { setLoadingCal(false); }
  }, [year, month]);

  useEffect(() => { loadMonth(); }, [loadMonth]);

  const loadDay = useCallback(async (date: string) => {
    setLoadingDay(true); setExpandedSess(null); setSearch('');
    try { setSessionData(await getAttendanceHistory(date)); }
    finally { setLoadingDay(false); }
  }, []);

  useEffect(() => { loadDay(selectedDate); }, [selectedDate, loadDay]);

  const prevMonth = () => month===1 ? (setYear(y=>y-1), setMonth(12)) : setMonth(m=>m-1);
  const nextMonth = () => month===12 ? (setYear(y=>y+1), setMonth(1)) : setMonth(m=>m+1);

  const daysInMonth  = getDaysInMonth(year, month);
  const firstWeekday = weekdayOf(year, month, 1);
  const cells = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({length:daysInMonth},(_,i)=>i+1),
  ];
  while (cells.length%7!==0) cells.push(null);

  const sessionKeys  = Object.keys(sessionData);
  const totalPresent = sessionKeys.reduce((s,k)=>s+sessionData[k].filter((x:any)=>x.present).length,0);
  const totalStudents= sessionKeys.reduce((s,k)=>s+sessionData[k].length,0);

  const fmt = (d: string) => {
    const [y,m,dd]=d.split('-');
    return `${parseInt(dd)} ${MONTH_NAMES[parseInt(m)-1]} ${y}`;
  };

  // Pull-to-refresh: 7-day attendance reconcile, then reload calendar + day
  const { pullProps, PullIndicator } = usePullToRefresh(async () => {
    await syncAttendanceOnly();
    await loadMonth();
    await loadDay(selectedDate);
  });

  return (
    <div style={{backgroundColor:C.bg,minHeight:'100vh',fontFamily:'sans-serif',paddingBottom:40,display:'flex',flexDirection:'column'}} {...pullProps}>
      <PullIndicator />

      <ScreenHeader title="📅 Attendance History" background={`linear-gradient(135deg,${C.green},#0d3320)`}
        actions={
          <button onClick={()=>{
            setYear(today.getFullYear());
            setMonth(today.getMonth()+1);
            setSelectedDate(todayStr);
          }} style={{backgroundColor:'rgba(255,255,255,0.2)',border:'none',
            color:C.white,height:32,padding:'0 14px',marginRight:6,borderRadius:16,
            cursor:'pointer',fontSize:12,fontWeight:700}}>
            Today
          </button>
        } />

      {/* Calendar */}
      <div style={{backgroundColor:C.card,margin:'10px 10px 0',
        borderRadius:14,boxShadow:'0 1px 4px rgba(0,0,0,0.06)',overflow:'hidden'}}>

        {/* Month nav */}
        <div style={{display:'flex',alignItems:'center',
          justifyContent:'space-between',padding:'4px 4px 0'}}>
          <button onClick={prevMonth} aria-label="Previous month" style={{background:'none',border:'none',
            fontSize:26,color:C.green,cursor:'pointer',width:44,height:40,lineHeight:1,fontWeight:300}}>‹</button>
          <div style={{fontSize:15,fontWeight:800,color:C.green}}>
            {MONTH_NAMES[month-1]} <span style={{color:C.gray,fontWeight:600}}>{year}</span>
          </div>
          <button onClick={nextMonth} aria-label="Next month" style={{background:'none',border:'none',
            fontSize:26,color:C.green,cursor:'pointer',width:44,height:40,lineHeight:1,fontWeight:300}}>›</button>
        </div>

        {/* Day headers */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',
          borderBottom:`1px solid ${C.border}`,padding:'0 8px'}}>
          {DAY_LABELS.map(d=>(
            <div key={d} style={{textAlign:'center',fontSize:10,fontWeight:700,
              padding:'2px 0 4px',textTransform:'uppercase' as const,letterSpacing:'0.5px',
              color:d==='Sat'||d==='Sun'?C.gold:C.gray}}>{d}</div>
          ))}
        </div>

        {/* Grid */}
        {loadingCal ? (
          <div style={{textAlign:'center',padding:'30px',color:C.gray}}>Loading…</div>
        ) : (
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',
            padding:'6px 8px 8px',gap:'3px'}}>
            {cells.map((day,idx)=>{
              if(!day) return <div key={`e${idx}`} style={{height:34}}/>;
              const ds  = toStr(year,month,day);
              const isTd = ds===todayStr;
              const isSel= ds===selectedDate;
              const hasD = activeDates.has(ds);
              const wd   = (firstWeekday+day-1)%7;
              const isWE = wd===5||wd===6;
              return (
                <button key={day} onClick={()=>setSelectedDate(ds)} style={{
                  height:34, borderRadius:9, cursor:'pointer',
                  display:'flex', flexDirection:'column' as const,
                  alignItems:'center', justifyContent:'center', gap:2,
                  padding:0, border:'none',
                  backgroundColor: isSel?C.green:isTd?'#e8f5e9':C.white,
                  outline: isTd&&!isSel?`2px solid ${C.green}`:'none',
                  color: isSel?C.white:isWE?C.gold:'#333',
                  fontWeight: isTd||isSel?700:400,
                  boxShadow: isSel?'0 2px 8px rgba(26,71,42,0.3)':'none',
                }}>
                  <span style={{fontSize:14,lineHeight:1}}>{day}</span>
                  {hasD&&<div style={{width:5,height:5,borderRadius:'50%',
                    backgroundColor:isSel?C.gold:C.green}}/>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Day detail */}
      <div style={{backgroundColor:C.card,margin:'10px 10px 12px',
        borderRadius:14,padding:'10px 12px',boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}>

        {/* Date header */}
        <div style={{display:'flex',justifyContent:'space-between',
          alignItems:'center',gap:8,marginBottom:8}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:15,fontWeight:800,color:C.green}}>{fmt(selectedDate)}</div>
            {sessionKeys.length>0&&(
              <div style={{fontSize:11.5,color:C.gray,marginTop:2}}>
                {sessionKeys.length} session{sessionKeys.length>1?'s':''} &nbsp;·&nbsp;
                <span style={{color:C.green,fontWeight:700}}>{totalPresent} present</span>
                &nbsp;·&nbsp;
                <span style={{color:C.red,fontWeight:700}}>
                  {totalStudents-totalPresent} absent
                </span>
              </div>
            )}
          </div>
          {/* Attendance rate pill */}
          {totalStudents>0&&(
            <div style={{backgroundColor:C.green,color:C.white,flexShrink:0,
              fontWeight:800,fontSize:13,padding:'3px 10px',borderRadius:16}}>
              {Math.round((totalPresent/totalStudents)*100)}%
            </div>
          )}
        </div>

        {/* Search within day */}
        {sessionKeys.length>0&&(
          <div style={{position:'relative',marginBottom:8}}>
            <span style={{position:'absolute',left:10,top:'50%',
              transform:'translateY(-50%)',fontSize:14,color:C.gray}}>🔍</span>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search student…"
              style={{width:'100%',padding:'8px 12px 8px 32px',borderRadius:10,
                border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const,backgroundColor:'#f9fafb'}}/>
            {search&&<button onClick={()=>setSearch('')} style={{
              position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',
              background:'none',border:'none',cursor:'pointer',
              fontSize:14,color:C.gray}}>✕</button>}
          </div>
        )}

        {loadingDay ? (
          <div style={{textAlign:'center',padding:'24px',color:C.gray}}>Loading…</div>
        ) : sessionKeys.length===0 ? (
          <div style={{textAlign:'center',padding:'32px 0',color:C.gray}}>
            <div style={{fontSize:36,marginBottom:8}}>📋</div>
            <div style={{fontWeight:700}}>No sessions recorded</div>
            <div style={{fontSize:12,marginTop:4}}>for {fmt(selectedDate)}</div>
          </div>
        ) : (
          sessionKeys.map(sess=>{
            const students = sessionData[sess];
            const filtered = search
              ? students.filter((s:any)=>
                  s.name.toLowerCase().includes(search.toLowerCase()) || s.regno?.toLowerCase().includes(search.toLowerCase()))
              : students;
            const present  = filtered.filter((s:any)=>s.present);
            const absent   = filtered.filter((s:any)=>!s.present);
            const expanded = expandedSess===sess;

            return (
              <div key={sess} style={{borderRadius:10,overflow:'hidden',
                marginBottom:8,border:`1px solid ${C.border}`}}>

                {/* Session header row */}
                <button onClick={()=>setExpandedSess(expanded?null:sess)}
                  style={{width:'100%',background:'#fafafa',border:'none',
                    padding:'9px 12px',cursor:'pointer',display:'flex',
                    alignItems:'center',justifyContent:'space-between'}}>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{width:10,height:10,borderRadius:'50%',
                      backgroundColor:C.green,flexShrink:0}}/>
                    <div style={{textAlign:'left' as const}}>
                      <div style={{fontSize:14,fontWeight:700,color:'#222'}}>{sess}</div>
                      <div style={{fontSize:11,color:C.gray,marginTop:1}}>
                        {students.filter((s:any)=>s.present).length} present ·{' '}
                        {students.filter((s:any)=>!s.present).length} absent
                      </div>
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{backgroundColor:'#e8f5e9',color:C.green,
                      fontWeight:700,fontSize:13,padding:'3px 10px',borderRadius:20}}>
                      {students.filter((s:any)=>s.present).length}
                    </span>
                    <span style={{backgroundColor:'#fdecea',color:C.red,
                      fontWeight:700,fontSize:13,padding:'3px 10px',borderRadius:20}}>
                      {students.filter((s:any)=>!s.present).length}
                    </span>
                    <span style={{color:C.gray,fontSize:18}}>
                      {expanded?'▲':'▼'}
                    </span>
                  </div>
                </button>

                {/* Expanded student list */}
                {expanded&&(
                  <div style={{backgroundColor:C.white,
                    borderTop:`1px solid ${C.border}`,padding:'8px 12px'}}>

                    {/* Present students */}
                    {present.length>0&&(
                      <>
                        <div style={{fontSize:10,fontWeight:800,color:C.green,
                          textTransform:'uppercase' as const,letterSpacing:'1px',
                          marginBottom:8}}>
                          ✓ Present ({present.length})
                        </div>
                        {present.map((s:any)=>(
                          <div key={s.id} style={{display:'flex',alignItems:'center',
                            gap:10,padding:'4px 0',
                            borderBottom:`1px solid #f3f4f6`}}>
                            <StudentPhoto student={s} size={30}/>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:14,fontWeight:600,color:'#111',
                                overflow:'hidden',textOverflow:'ellipsis',
                                whiteSpace:'nowrap' as const}}>{s.name}</div>
                              <div style={{fontSize:11,color:C.gray}}>
                                {studentIds(s)}
                              </div>
                            </div>
                            <span style={{fontSize:16,color:C.green}}>✔</span>
                          </div>
                        ))}
                      </>
                    )}

                    {/* Absent students */}
                    {absent.length>0&&(
                      <>
                        <div style={{fontSize:10,fontWeight:800,color:C.red,
                          textTransform:'uppercase' as const,letterSpacing:'1px',
                          margin:'12px 0 8px'}}>
                          ✗ Absent ({absent.length})
                        </div>
                        {absent.map((s:any)=>(
                          <div key={s.id} style={{display:'flex',alignItems:'center',
                            gap:10,padding:'4px 0',
                            borderBottom:`1px solid #f3f4f6`,opacity:0.65}}>
                            <StudentPhoto student={s} size={30}/>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:14,fontWeight:600,color:'#666',
                                overflow:'hidden',textOverflow:'ellipsis',
                                whiteSpace:'nowrap' as const}}>{s.name}</div>
                              <div style={{fontSize:11,color:C.gray}}>
                                {studentIds(s)}
                              </div>
                            </div>
                            <span style={{fontSize:16,color:C.red}}>✗</span>
                          </div>
                        ))}
                      </>
                    )}

                    {filtered.length===0&&search&&(
                      <div style={{textAlign:'center',padding:'16px 0',
                        color:C.gray,fontSize:13}}>
                        No match for "{search}"
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <EmptyAreaLogo />
    </div>
  );
}
