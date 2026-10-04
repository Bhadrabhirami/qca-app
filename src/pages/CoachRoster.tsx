import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';

const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e0e0e0', muted:'#6b7280', navy:'#001f3f' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function getHdr() {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && Date.now() < exp - 60000)
    return { 'Authorization': 'Bearer '+jwt, 'X-Username': localStorage.getItem('auth_user')||'' };
  return { 'X-Username': localStorage.getItem('auth_user')||'', 'X-Password': localStorage.getItem('auth_pass')||'' };
}
function getBase() {
  return (localStorage.getItem('server_ip')||'').replace(/\/+$/,'');
}

// Simple avatar with photo support — fetch as blob to bypass CORS on img tag
function Avatar({ name, imageUrl, size=36 }: { name:string; imageUrl?:string|null; size?:number }) {
  const [blobUrl, setBlobUrl] = useState<string|null>(null);
  const initials = name.split(' ').map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
  const hue = (name.charCodeAt(0)||65) * 37 % 360;

  useEffect(() => {
    if (!imageUrl) return;
    const base = getBase();
    const src = imageUrl.startsWith('http') ? imageUrl : `${base}${imageUrl}`;
    let objUrl: string|null = null;
    fetch(src, { headers: getHdr() })
      .then(r => r.ok ? r.blob() : null)
      .then(blob => {
        if (blob) { objUrl = URL.createObjectURL(blob); setBlobUrl(objUrl); }
      }).catch(() => {});
    return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [imageUrl]);

  if (blobUrl) {
    return (
      <img src={blobUrl} alt={name}
        style={{ width:size, height:size, borderRadius:'50%', objectFit:'cover',
          flexShrink:0, border:'2px solid rgba(255,255,255,0.2)' }} />
    );
  }
  return (
    <div style={{ width:size, height:size, borderRadius:'50%', flexShrink:0,
      backgroundColor:`hsl(${hue},40%,28%)`, display:'inline-flex',
      alignItems:'center', justifyContent:'center',
      color:`hsl(${hue},60%,82%)`, fontWeight:800, fontSize:size*0.36, letterSpacing:0.5 }}>
      {initials}
    </div>
  );
}

function DayModal({ date, slots, onClose }: { date:string; slots:{morning:any[];evening:any[]}; onClose:()=>void }) {
  const d = new Date(date+'T12:00:00');
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:1000,
      backgroundColor:'rgba(0,0,0,0.5)', display:'flex', alignItems:'flex-end' }}>
      <div onClick={e=>e.stopPropagation()} style={{ backgroundColor:'#fff', width:'100%',
        borderRadius:'20px 20px 0 0', padding:'20px 20px 40px', maxHeight:'75vh', overflowY:'auto' }}>
        <div style={{ width:40, height:4, backgroundColor:'#e5e7eb', borderRadius:2, margin:'0 auto 16px' }} />
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
          <div style={{ width:48, height:48, borderRadius:12, backgroundColor:C.navy,
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
            <div style={{ color:'rgba(255,255,255,0.6)', fontSize:9, fontWeight:700 }}>{DAYS_SHORT[d.getDay()].toUpperCase()}</div>
            <div style={{ color:'#fff', fontSize:22, fontWeight:900, lineHeight:1 }}>{d.getDate()}</div>
          </div>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:C.navy }}>
              {DAYS_SHORT[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()}
            </div>
            <div style={{ fontSize:12, color:C.muted }}>
              {slots.morning.length + slots.evening.length} assignment(s)
            </div>
          </div>
        </div>

        {slots.morning.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:800, color:'#d97706', textTransform:'uppercase' as const, letterSpacing:1, marginBottom:10 }}>
              🌅 Morning Session
            </div>
            {slots.morning.map((r:any) => (
              <div key={r.id} style={{ display:'flex', alignItems:'center', gap:12,
                padding:'10px 14px', backgroundColor:'#fffbeb', borderRadius:10, marginBottom:8, border:'1px solid #fde68a' }}>
                <Avatar name={r.member_name} imageUrl={r.image_url} size={40} />
                <span style={{ fontSize:15, fontWeight:700, color:'#92400e' }}>{r.member_name}</span>
              </div>
            ))}
          </div>
        )}

        {slots.evening.length > 0 && (
          <div>
            <div style={{ fontSize:12, fontWeight:800, color:'#4f46e5', textTransform:'uppercase' as const, letterSpacing:1, marginBottom:10 }}>
              🌆 Evening Session
            </div>
            {slots.evening.map((r:any) => (
              <div key={r.id} style={{ display:'flex', alignItems:'center', gap:12,
                padding:'10px 14px', backgroundColor:'#eef2ff', borderRadius:10, marginBottom:8, border:'1px solid #c7d2fe' }}>
                <Avatar name={r.member_name} imageUrl={r.image_url} size={40} />
                <span style={{ fontSize:15, fontWeight:700, color:'#4338ca' }}>{r.member_name}</span>
              </div>
            ))}
          </div>
        )}

        <button onClick={onClose} style={{ width:'100%', marginTop:16, padding:14,
          borderRadius:12, border:'none', backgroundColor:'#f3f4f6',
          color:C.muted, fontWeight:700, fontSize:14, cursor:'pointer' }}>
          Close
        </button>
      </div>
    </div>
  );
}

export default function CoachRosterScreen() {
  const navigate = useNavigate();
  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()+1);
  const [data,  setData]  = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [selected, setSelected] = useState<string|null>(null);

  const load = async (y:number, m:number) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`${getBase()}/api/data/coach-roster?year=${y}&month=${m}`, { headers:getHdr() });
      const j = await res.json();
      if (res.ok) setData(j.data||[]);
      else setError(j.error||'Failed');
    } catch(e:any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { load(year, month); }, [year, month]);

  const prevMonth = () => { if(month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1); };
  const nextMonth = () => { if(month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1); };

  const byDate = useMemo(() => {
    const map: Record<string,{morning:any[];evening:any[]}> = {};
    for (const row of data) {
      if (!map[row.roster_date]) map[row.roster_date] = {morning:[],evening:[]};
      if ((row.shift||'').toLowerCase()==='morning') map[row.roster_date].morning.push(row);
      else map[row.roster_date].evening.push(row);
    }
    return map;
  }, [data]);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, month-1, 1).getDay();
    const total = new Date(year, month, 0).getDate();
    const cells:(number|null)[] = Array(firstDay).fill(null);
    for (let d=1; d<=total; d++) cells.push(d);
    while (cells.length%7!==0) cells.push(null);
    return cells;
  }, [year, month]);

  const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const dk = (d:number) => `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const isCurrentMonth = year===today.getFullYear() && month===today.getMonth()+1;

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh', fontFamily:'sans-serif', paddingBottom:80 }}>
      <ScreenHeader title="🏏 Coach Roster" background={C.navy}
        subtitle={<span style={{ color:'#fff', fontWeight:700, fontSize:13 }}>{MONTHS_SHORT[month-1]} {year}</span>}
        actions={<>
          {!isCurrentMonth && (
            <button onClick={()=>{setYear(today.getFullYear());setMonth(today.getMonth()+1);}}
              style={{ background:'rgba(255,255,255,0.12)', border:'none', color:C.gold, fontSize:11, fontWeight:700, height:28, padding:'0 10px', borderRadius:8, cursor:'pointer' }}>
              Today
            </button>
          )}
          <HeaderIconButton label="Previous month" onClick={prevMonth}><span style={{ color:C.gold, fontSize:28 }}>‹</span></HeaderIconButton>
          <HeaderIconButton label="Next month" onClick={nextMonth}><span style={{ color:C.gold, fontSize:28 }}>›</span></HeaderIconButton>
        </>}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', margin:'0 -8px -6px' }}>
          {DAYS_SHORT.map(d=>(
            <div key={d} style={{ textAlign:'center', fontSize:11, fontWeight:700,
              color:'rgba(255,255,255,0.45)', padding:'2px 0' }}>{d}</div>
          ))}
        </div>
      </ScreenHeader>

      {loading ? (
        <div style={{ textAlign:'center', color:C.muted, padding:40 }}>Loading…</div>
      ) : error ? (
        <div style={{ margin:16, backgroundColor:'#fef2f2', borderRadius:10, padding:16, color:'#dc2626', fontWeight:700 }}>⚠ {error}</div>
      ) : (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:1, backgroundColor:C.border }}>
            {calendarDays.map((day, idx) => {
              if (!day) return <div key={`e${idx}`} style={{ backgroundColor:'#f9fafb', minHeight:70 }} />;
              const key = dk(day);
              const slots = byDate[key];
              const isToday = key===todayKey;
              const hasMorn = (slots?.morning?.length||0)>0;
              const hasEve  = (slots?.evening?.length||0)>0;
              const hasAny  = hasMorn||hasEve;
              return (
                <div key={key} onClick={()=>hasAny&&setSelected(key)}
                  style={{ backgroundColor:'#fff', minHeight:80, padding:'5px 3px',
                    cursor:hasAny?'pointer':'default',
                    borderTop:`3px solid ${isToday?C.gold:'transparent'}` }}>
                  <div style={{ width:22, height:22, borderRadius:'50%', display:'flex',
                    alignItems:'center', justifyContent:'center', marginBottom:3,
                    backgroundColor:isToday?C.gold:'transparent' }}>
                    <span style={{ fontSize:12, fontWeight:isToday?900:400,
                      color:isToday?'#fff':hasAny?C.navy:'#9ca3af' }}>{day}</span>
                  </div>
                  {hasMorn && (
                    <div style={{ marginBottom:3 }}>
                      <div style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'#f59e0b', marginBottom:2 }} />
                      <div style={{ display:'flex', flexWrap:'wrap' as const, gap:2 }}>
                        {slots.morning.slice(0,3).map((r:any,i:number)=>(
                          <Avatar key={i} name={r.member_name} imageUrl={r.image_url} size={20} />
                        ))}
                        {slots.morning.length>3&&(
                          <div style={{ width:20, height:20, borderRadius:'50%', backgroundColor:'#f59e0b',
                            display:'flex', alignItems:'center', justifyContent:'center',
                            fontSize:8, fontWeight:800, color:'#fff' }}>
                            +{slots.morning.length-3}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {hasEve && (
                    <div>
                      <div style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'#6366f1', marginBottom:2 }} />
                      <div style={{ display:'flex', flexWrap:'wrap' as const, gap:2 }}>
                        {slots.evening.slice(0,3).map((r:any,i:number)=>(
                          <Avatar key={i} name={r.member_name} imageUrl={r.image_url} size={20} />
                        ))}
                        {slots.evening.length>3&&(
                          <div style={{ width:20, height:20, borderRadius:'50%', backgroundColor:'#6366f1',
                            display:'flex', alignItems:'center', justifyContent:'center',
                            fontSize:8, fontWeight:800, color:'#fff' }}>
                            +{slots.evening.length-3}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {data.length===0 && (
            <div style={{ textAlign:'center', padding:40, color:C.muted }}>
              <div style={{ fontSize:36, marginBottom:12 }}>📋</div>
              <div style={{ fontWeight:700 }}>No roster for {MONTHS_SHORT[month-1]} {year}</div>
            </div>
          )}

          <div style={{ display:'flex', gap:16, padding:'10px 16px', justifyContent:'center' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', backgroundColor:'#f59e0b' }} />
              <span style={{ fontSize:12, color:C.muted }}>Morning</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', backgroundColor:'#6366f1' }} />
              <span style={{ fontSize:12, color:C.muted }}>Evening</span>
            </div>
          </div>
        </>
      )}

      {selected && byDate[selected] && (
        <DayModal date={selected} slots={byDate[selected]} onClose={()=>setSelected(null)} />
      )}
    </div>
  );
}
