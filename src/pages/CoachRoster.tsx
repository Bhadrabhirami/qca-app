import React, { useEffect, useState, useMemo } from 'react';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';

const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', muted:'#6b7280', text:'#1f2937',
  morn:'#d97706', mornBg:'#fffbeb', eve:'#4f46e5', eveBg:'#eef2ff' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function getHdr(): Record<string,string> {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && Date.now() < exp - 60000)
    return { 'Authorization': 'Bearer '+jwt, 'X-Username': localStorage.getItem('auth_user')||'' };
  return { 'X-Username': localStorage.getItem('auth_user')||'' };
}
function getBase() {
  return (localStorage.getItem('server_ip')||'').replace(/\/+$/,'');
}
const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// One download per photo URL for the whole screen (the grid shows the same coaches many times)
const photoCache = new Map<string, Promise<string|null>>();
function loadPhoto(imageUrl: string): Promise<string|null> {
  if (!photoCache.has(imageUrl)) {
    const src = imageUrl.startsWith('http') ? imageUrl : `${getBase()}${imageUrl}`;
    photoCache.set(imageUrl, fetch(src, { headers: getHdr() })
      .then(r => r.ok ? r.blob() : null)
      .then(b => b ? URL.createObjectURL(b) : null)
      .catch(() => null));
  }
  return photoCache.get(imageUrl)!;
}

function Avatar({ name, imageUrl, size=36, ring }: { name:string; imageUrl?:string|null; size?:number; ring?:string }) {
  const [url, setUrl] = useState<string|null>(null);
  const initials = (name||'?').split(' ').map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
  const hue = ((name||'A').charCodeAt(0)||65) * 37 % 360;
  useEffect(() => {
    let live = true;
    if (imageUrl) loadPhoto(imageUrl).then(u => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [imageUrl]);
  const base: React.CSSProperties = { width:size, height:size, borderRadius:'50%', flexShrink:0, border:`${size > 24 ? 2 : 1.5}px solid ${ring || '#fff'}`, boxSizing:'border-box' };
  if (url) return <img src={url} alt={name} style={{ ...base, objectFit:'cover' }} />;
  return (
    <div style={{ ...base, backgroundColor:`hsl(${hue},35%,88%)`, color:`hsl(${hue},45%,28%)`,
      display:'inline-flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:size*0.38 }}>
      {initials}
    </div>
  );
}

/** Overlapping faces + count, fits a narrow calendar cell */
function FaceStack({ rows, color }: { rows:any[]; color:string }) {
  if (!rows.length) return null;
  return (
    <div style={{ display:'flex', alignItems:'center', height:18 }}>
      <span style={{ width:3, height:14, borderRadius:2, backgroundColor:color, marginRight:3, flexShrink:0 }} />
      {rows.slice(0,2).map((r,i) => (
        <span key={i} style={{ marginLeft: i ? -6 : 0, display:'inline-flex' }}>
          <Avatar name={r.member_name} imageUrl={r.image_url} size={16} />
        </span>
      ))}
      {rows.length > 2 && <span style={{ fontSize:9, fontWeight:800, color, marginLeft:2 }}>+{rows.length-2}</span>}
    </div>
  );
}

function ShiftList({ title, icon, rows, color, bg }: { title:string; icon:string; rows:any[]; color:string; bg:string }) {
  return (
    <div style={{ flex:1, minWidth:0 }}>
      <div style={{ fontSize:10.5, fontWeight:800, color, textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:5 }}>{icon} {title}</div>
      {rows.length === 0
        ? <div style={{ fontSize:12, color:C.muted }}>No one assigned</div>
        : rows.map((r:any) => (
            <div key={r.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:9, backgroundColor:bg, marginBottom:4 }}>
              <Avatar name={r.member_name} imageUrl={r.image_url} size={28} />
              <span style={{ fontSize:13, fontWeight:700, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.member_name}</span>
            </div>
          ))}
    </div>
  );
}

function DayModal({ date, slots, onClose }: { date:string; slots:{morning:any[];evening:any[]}; onClose:()=>void }) {
  const d = new Date(date+'T12:00:00');
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:1000, backgroundColor:'rgba(0,0,0,0.5)', display:'flex', alignItems:'flex-end' }}>
      <div onClick={e=>e.stopPropagation()} role="dialog" aria-label={`Roster for ${d.toDateString()}`}
        style={{ backgroundColor:C.bg, width:'100%', borderRadius:'16px 16px 0 0', maxHeight:'75vh', overflowY:'auto',
          paddingBottom:'calc(16px + env(safe-area-inset-bottom))' }}>
        <div style={{ backgroundColor:C.green, padding:'12px 14px', display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ width:42, height:42, borderRadius:10, backgroundColor:'rgba(255,255,255,0.12)',
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
            <div style={{ color:C.gold, fontSize:9, fontWeight:800 }}>{DAYS_SHORT[d.getDay()].toUpperCase()}</div>
            <div style={{ color:'#fff', fontSize:19, fontWeight:900, lineHeight:1 }}>{d.getDate()}</div>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:800, fontSize:15, color:'#fff' }}>{DAYS_SHORT[d.getDay()]}, {d.getDate()} {MONTHS[d.getMonth()]}</div>
            <div style={{ fontSize:11.5, color:'rgba(255,255,255,0.7)' }}>{slots.morning.length + slots.evening.length} assignment(s)</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(255,255,255,0.85)', fontSize:20, cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ padding:12, display:'flex', flexDirection:'column', gap:12 }}>
          <ShiftList title="Morning" icon="🌅" rows={slots.morning} color={C.morn} bg={C.mornBg} />
          <ShiftList title="Evening" icon="🌆" rows={slots.evening} color={C.eve}  bg={C.eveBg} />
        </div>
      </div>
    </div>
  );
}

export default function CoachRosterScreen() {
  const today = new Date();
  const todayKey = keyOf(today);
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
      const j = await res.json().catch(() => ({}));
      if (res.ok) setData(j.data||[]);
      else setError(j.error || `Server error ${res.status}`);
    } catch { setError('Cannot reach the server'); }
    setLoading(false);
  };

  useEffect(() => { load(year, month); }, [year, month]);

  const prevMonth = () => { if(month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1); };
  const nextMonth = () => { if(month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1); };
  const goToday   = () => { setYear(today.getFullYear()); setMonth(today.getMonth()+1); };

  const byDate = useMemo(() => {
    const map: Record<string,{morning:any[];evening:any[]}> = {};
    for (const row of data) {
      if (!map[row.roster_date]) map[row.roster_date] = {morning:[],evening:[]};
      if ((row.shift||'').toLowerCase()==='morning') map[row.roster_date].morning.push(row);
      else map[row.roster_date].evening.push(row);
    }
    return map;
  }, [data]);

  // Shifts per coach this month (most first)
  const perCoach = useMemo(() => {
    const m: Record<string,{name:string;image_url:any;morning:number;evening:number}> = {};
    for (const r of data) {
      const k = r.member_id ?? r.member_name;
      if (!m[k]) m[k] = { name:r.member_name, image_url:r.image_url, morning:0, evening:0 };
      if ((r.shift||'').toLowerCase()==='morning') m[k].morning++; else m[k].evening++;
    }
    return Object.values(m).sort((a,b) => (b.morning+b.evening)-(a.morning+a.evening) || a.name.localeCompare(b.name));
  }, [data]);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, month-1, 1).getDay();
    const total = new Date(year, month, 0).getDate();
    const cells:(number|null)[] = Array(firstDay).fill(null);
    for (let d=1; d<=total; d++) cells.push(d);
    while (cells.length%7!==0) cells.push(null);
    return cells;
  }, [year, month]);

  const dk = (d:number) => `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const isCurrentMonth = year===today.getFullYear() && month===today.getMonth()+1;
  const todaySlots = byDate[todayKey] || { morning:[], evening:[] };

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', fontFamily:'sans-serif', color:C.text, paddingBottom:24 }}>
      <ScreenHeader title="Coach Roster"
        subtitle={loading ? 'Loading…' : `${MONTHS[month-1]} ${year} · ${data.length} shift${data.length===1?'':'s'} · ${perCoach.length} coach${perCoach.length===1?'':'es'}`}
        actions={<>
          {!isCurrentMonth && (
            <button onClick={goToday}
              style={{ background:'rgba(255,255,255,0.14)', border:'none', color:C.gold, fontSize:11.5, fontWeight:800, height:28, padding:'0 10px', borderRadius:8, cursor:'pointer' }}>
              Today
            </button>
          )}
          <HeaderIconButton label="Previous month" onClick={prevMonth}><span style={{ fontSize:24, lineHeight:1 }}>‹</span></HeaderIconButton>
          <HeaderIconButton label="Next month" onClick={nextMonth}><span style={{ fontSize:24, lineHeight:1 }}>›</span></HeaderIconButton>
        </>} />

      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>

        {/* Today */}
        {isCurrentMonth && !loading && !error && (
          <div style={{ ...CARD, padding:12 }}>
            <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:8 }}>
              Today · {DAYS_SHORT[today.getDay()]} {today.getDate()} {MONTHS[today.getMonth()].slice(0,3)}
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <ShiftList title="Morning" icon="🌅" rows={todaySlots.morning} color={C.morn} bg={C.mornBg} />
              <ShiftList title="Evening" icon="🌆" rows={todaySlots.evening} color={C.eve}  bg={C.eveBg} />
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign:'center', color:C.muted, padding:32, fontSize:13 }}>Loading roster…</div>
        ) : error ? (
          <div style={{ ...CARD, padding:'18px 16px', textAlign:'center' }}>
            <div style={{ color:'#dc2626', fontWeight:800, fontSize:13, marginBottom:10 }}>⚠ {error}</div>
            <button onClick={() => load(year, month)} style={{ padding:'8px 18px', borderRadius:9, border:'none', backgroundColor:C.green,
              color:'#fff', fontWeight:800, fontSize:13, cursor:'pointer' }}>Retry</button>
          </div>
        ) : (<>
          {/* Calendar */}
          <div style={CARD}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', backgroundColor:'#fafafa', borderBottom:`1px solid ${C.border}` }}>
              {DAYS_SHORT.map(d => (
                <div key={d} style={{ textAlign:'center', fontSize:10.5, fontWeight:800, color:C.muted, padding:'5px 0' }}>{d}</div>
              ))}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:1, backgroundColor:C.border }}>
              {calendarDays.map((day, idx) => {
                if (!day) return <div key={`e${idx}`} style={{ backgroundColor:'#fafafa', minHeight:58 }} />;
                const key = dk(day);
                const slots = byDate[key];
                const isToday = key===todayKey;
                const hasAny = !!slots && (slots.morning.length + slots.evening.length) > 0;
                return (
                  <button key={key} onClick={()=>hasAny&&setSelected(key)} disabled={!hasAny}
                    aria-label={`${day} ${MONTHS[month-1]}${hasAny ? `, ${slots.morning.length} morning, ${slots.evening.length} evening` : ', nobody assigned'}`}
                    style={{ backgroundColor: isToday ? '#fdf8e7' : '#fff', minHeight:58, padding:'4px 3px', border:'none', textAlign:'left',
                      cursor:hasAny?'pointer':'default', display:'flex', flexDirection:'column', gap:2,
                      boxShadow: isToday ? `inset 0 0 0 2px ${C.gold}` : 'none' }}>
                    <span style={{ fontSize:11.5, fontWeight: isToday ? 900 : 700, color: isToday ? '#a8862a' : hasAny ? C.text : '#c0c4cc', paddingLeft:2 }}>{day}</span>
                    {slots && <FaceStack rows={slots.morning} color={C.morn} />}
                    {slots && <FaceStack rows={slots.evening} color={C.eve} />}
                  </button>
                );
              })}
            </div>
            <div style={{ display:'flex', gap:14, padding:'6px 10px', justifyContent:'center', borderTop:`1px solid ${C.border}`, fontSize:11, color:C.muted }}>
              <span><span style={{ display:'inline-block', width:3, height:11, borderRadius:2, backgroundColor:C.morn, marginRight:5, verticalAlign:'middle' }} />Morning</span>
              <span><span style={{ display:'inline-block', width:3, height:11, borderRadius:2, backgroundColor:C.eve,  marginRight:5, verticalAlign:'middle' }} />Evening</span>
              <span>Tap a day for names</span>
            </div>
          </div>

          {data.length===0 && (
            <div style={{ ...CARD, padding:'22px 16px', textAlign:'center', color:C.muted }}>
              <div style={{ fontSize:28, marginBottom:6 }}>📋</div>
              <div style={{ fontWeight:800, fontSize:13.5, color:C.text }}>No roster for {MONTHS[month-1]} {year}</div>
            </div>
          )}

          {/* Shifts per coach */}
          {perCoach.length > 0 && (<>
            <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase', letterSpacing:'0.8px', margin:'4px 2px 0' }}>
              Shifts this month
            </div>
            <div style={CARD}>
              {perCoach.map((c, i) => (
                <div key={c.name+i} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
                  <Avatar name={c.name} imageUrl={c.image_url} size={30} ring={C.border} />
                  <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</span>
                  <span style={{ fontSize:11, fontWeight:800, color:C.morn, backgroundColor:C.mornBg, padding:'2px 7px', borderRadius:8 }}>🌅 {c.morning}</span>
                  <span style={{ fontSize:11, fontWeight:800, color:C.eve,  backgroundColor:C.eveBg,  padding:'2px 7px', borderRadius:8 }}>🌆 {c.evening}</span>
                  <span style={{ fontSize:12, fontWeight:900, color:C.green, minWidth:22, textAlign:'right' }}>{c.morning + c.evening}</span>
                </div>
              ))}
            </div>
          </>)}
        </>)}
      </div>

      {selected && byDate[selected] && (
        <DayModal date={selected} slots={byDate[selected]} onClose={()=>setSelected(null)} />
      )}
    </div>
  );
}
