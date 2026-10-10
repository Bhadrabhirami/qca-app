/**
 * nets_calendar.tsx — Net Booking Calendar (Admin/Staff view)
 * Shows month calendar + daily slot grid with booking details
 * Permission: nets:view
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader from '../shared/ScreenHeader';
import { canBookNets } from './nets_book';
import { localIso, fmtAmt, fmtDay, defaultSession, netApi, netMsg, isFree, shareBookingUrl, shareBooking } from './nets_util';

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

const NET_NAMES: Record<string,string> = {
  syn1: 'Synthetic Turf 1',
  syn2: 'Synthetic Turf 2',
  con:  'Concrete Wicket',
  mat:  'Matting Wicket',
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
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function getMonthDays(year: number, month: number) {
  const first = new Date(year, month, 1).getDay();
  const days  = new Date(year, month+1, 0).getDate();
  const cells: (number|null)[] = Array(first).fill(null);
  for (let d=1; d<=days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}


export default function NetsCalendarScreen() {
  const navigate    = useNavigate();
  const { can }     = usePermissions();
  const isAdmin     = (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
  const canView     = isAdmin || can('nets:view' as any);
  const canManage   = isAdmin || can('nets:manage' as any);
  const canBook     = canBookNets();

  const today       = new Date();
  const todayIso    = localIso(today);
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selDate, setSelDate] = useState(todayIso);
  const [session, setSession] = useState<'day'|'night'>(defaultSession());
  const [calData, setCalData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [selBooking, setSelBooking] = useState<any>(null);
  const [actionMsg, setActionMsg]   = useState('');
  const [showReschedule, setShowReschedule] = useState(false);
  const [rsDate,    setRsDate]    = useState('');
  const [rsSession, setRsSession] = useState<'day'|'night'>('day');
  const [rsCalData, setRsCalData] = useState<any>(null);
  const [rsLoading, setRsLoading] = useState(false);
  const [rsSel,     setRsSel]     = useState<Record<string,number[]>>({});
  const [rsPreview, setRsPreview] = useState<any>(null);
  const [rsSaving,  setRsSaving]  = useState(false);

  const loadDay = useCallback(async (date: string, sess: string) => {
    setLoading(true); setCalData(null); setSelBooking(null);
    try {
      const r = await fetch(
        `${bld()}/api/data/nets/calendar?view_date=${date}&session_type=${sess}`,
        { headers: hdr() }
      );
      const j = await r.json();
      if (j.data) setCalData(j.data);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { loadDay(selDate, session); }, [selDate, session]);

  const selectDay = (d: number) => {
    const dt = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    setSelDate(dt);
  };

  const prevMonth = () => { if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1); };
  const nextMonth = () => { if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1); };

  const doAction = async (endpoint: string, question: string, body: any = {}) => {
    if (question && !confirm(question)) return;
    setActionMsg('');
    try { await netApi(endpoint, body); setActionMsg('✓ Done'); loadDay(selDate, session); setSelBooking(null); }
    catch (e) { setActionMsg(netMsg(e)); }
  };
  // A booking whose day has passed: only settling what's owed (paid / expire) still applies
  const selPast = !!selBooking && String(selBooking.booking_date || selDate).slice(0, 10) < todayIso;
  const cancelBooking = (b: any) => {
    const reason = window.prompt(`Cancel ${b.booking_ref}? The slots are released.\n\nReason (optional):`, '');
    if (reason !== null) doAction(`/bookings/${b.booking_ref}/cancel`, '', { reason });
  };
  const selPaid = !!selBooking && (selBooking.payment_status === 'paid' || Number(selBooking.amount_paid || 0) > 0);
  const canUndoPay = isAdmin || can('nets:admin' as any);
  const undoPay = (b: any) => {
    const reason = window.prompt(`Undo the ${fmtAmt(b.amount_paid || b.total_amount)} payment on ${b.booking_ref}?\nIt goes back to "payment pending" — then it can be collected again or cancelled.\n\nReason (required, e.g. refunded / marked by mistake):`, '');
    if (reason !== null) doAction(`/bookings/${b.booking_ref}/unpay`, '', { reason });
  };

  const cells = getMonthDays(year, month);

  // Slot grid helpers
  const slots     = calData?.slots || [];
  const slotData  = calData?.slot_data || {};
  const nets      = calData?.nets || NET_NAMES;

  const fetchFullBooking = async (ref: string) => {
    try {
      const r = await fetch(`${bld()}/api/data/nets/bookings/${ref}`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setSelBooking(j.data);
    } catch {}
  };

  const loadRsDay = async (date: string, sess: string) => {
    setRsLoading(true); setRsCalData(null); setRsSel({}); setRsPreview(null);
    try {
      const r = await fetch(`${bld()}/api/data/nets/calendar?view_date=${date}&session_type=${sess}`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setRsCalData(j.data);
    } catch {} finally { setRsLoading(false); }
  };

  const toggleRsSlot = (netId: string, hour: number) => {
    setRsSel(prev => {
      const cur = prev[netId] || [];
      const has = cur.includes(hour);
      const next = has ? cur.filter(h=>h!==hour) : [...cur, hour];
      const result = {...prev, [netId]: next};
      if (!next.length) delete result[netId];
      return result;
    });
    setRsPreview(null);
  };

  const totalSelSlots = Object.values(rsSel).reduce((a,b)=>a+b.length,0);

  const getOrigSlotCount = () => {
    // From full booking detail (nets_booked)
    if (selBooking?.nets_booked && Object.keys(selBooking.nets_booked).length > 0) {
      return Object.values(selBooking.nets_booked).reduce((a:number,b:any)=>a+(Array.isArray(b)?b.length:1),0);
    }
    // From slot_count field if available
    if (selBooking?.slot_count) return selBooking.slot_count;
    // Fallback: 1 slot
    return 1;
  };

  const previewReschedule = async () => {
    if (!selBooking || !rsDate || totalSelSlots===0) return;
    const sel = encodeURIComponent(JSON.stringify(rsSel));
    try {
      const r = await fetch(`${bld()}/api/data/nets/bookings/${selBooking.booking_ref}/reschedule-preview?new_date=${rsDate}&new_session_type=${rsSession}&selection=${sel}`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setRsPreview(j.data);
      else setRsPreview({error: j.error||'Error'});
    } catch { setRsPreview({error:'Network error'}); }
  };

  const confirmReschedule = async () => {
    if (!selBooking || !rsPreview || rsPreview.error) return;
    setRsSaving(true);
    try {
      const r = await fetch(`${bld()}/api/data/nets/bookings/${selBooking.booking_ref}/reschedule`, {
        method:'POST', headers: hdr(),
        body: JSON.stringify({new_date:rsDate, new_session_type:rsSession, selection:rsSel})
      });
      const j = await r.json();
      if (r.ok) {
        setActionMsg(`✓ Moved to ${fmtDay(rsDate)}. New total: ${fmtAmt(j.new_total)}`);
        setShowReschedule(false); setSelBooking(null);
        loadDay(selDate, session);
      } else setRsPreview({error: j.error||'Error'});
    } catch { setRsPreview({error:'Network error'}); }
    finally { setRsSaving(false); }
  };

  if (!canView) return (
    <div style={{padding:32,textAlign:'center',color:C.muted}}>
      Permission required: nets:view
    </div>
  );

  return (
    <div style={{backgroundColor:C.bg,minHeight:'100vh',paddingBottom:80}}>
      <ScreenHeader background={`linear-gradient(150deg,${C.navy},#1a2f4a)`}
        title={<>📅 Nets <span style={{color:C.gold}}>Calendar</span></>}
        subtitle={<span style={{color:C.gold,fontWeight:700,letterSpacing:'1px',fontSize:10}}>NET BOOKING</span>} />

      <div style={{padding:'12px 16px'}}>
        {/* Session toggle */}
        <div style={{display:'flex',gap:8,marginBottom:12}}>
          {(['day','night'] as const).map(s => (
            <button key={s} onClick={()=>setSession(s)}
              style={{flex:1,padding:'9px',borderRadius:10,border:'none',
                backgroundColor:session===s?C.navy:'#fff',
                color:session===s?'#fff':C.muted,
                fontWeight:700,fontSize:13,cursor:'pointer',
                boxShadow:session===s?'0 2px 8px rgba(0,0,0,0.15)':'none'}}>
              {s==='day'?'☀️ Daylight':'🌙 Flood-lit'}
            </button>
          ))}
        </div>

        {/* Month calendar */}
        <div style={{backgroundColor:C.card,borderRadius:14,padding:14,
          marginBottom:12,border:`1px solid ${C.border}`}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <button onClick={prevMonth}
              style={{background:'none',border:'none',fontSize:20,cursor:'pointer',color:C.navy}}>‹</button>
            <div style={{fontWeight:800,fontSize:15,color:C.navy}}>
              {MONTHS[month]} {year}
            </div>
            <button onClick={nextMonth}
              style={{background:'none',border:'none',fontSize:20,cursor:'pointer',color:C.navy}}>›</button>
          </div>

          {/* Day headers */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',marginBottom:4}}>
            {DAYS.map(d => (
              <div key={d} style={{textAlign:'center',fontSize:10,fontWeight:700,
                color:C.muted,paddingBottom:4}}>{d}</div>
            ))}
          </div>

          {/* Day cells */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}}>
            {cells.map((d,i) => {
              if (!d) return <div key={i}/>;
              const dt = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
              const isToday = dt === todayIso;
              const isSel   = dt === selDate;
              return (
                <button key={i} onClick={()=>selectDay(d)}
                  style={{padding:'6px 2px',borderRadius:8,border:'none',cursor:'pointer',
                    backgroundColor:isSel?C.navy:isToday?'#dbeafe':'transparent',
                    color:isSel?'#fff':isToday?'#1d4ed8':'#111',
                    fontWeight:isSel||isToday?800:400,fontSize:13}}>
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected date + slot grid */}
        <div style={{backgroundColor:C.card,borderRadius:14,padding:14,
          border:`1px solid ${C.border}`,marginBottom:12}}>
          <div style={{fontWeight:800,fontSize:14,color:C.navy,marginBottom:10}}>
            {selDate} · {session==='day'?'☀️ Daylight':'🌙 Flood-lit'}
          </div>

          {loading && <div style={{textAlign:'center',padding:24,color:C.muted}}>Loading...</div>}

          {!loading && slots.length === 0 && (
            <div style={{textAlign:'center',padding:24,color:C.muted,fontSize:13}}>
              No sessions available for this date
            </div>
          )}

          {!loading && slots.length > 0 && (
            <div style={{overflowX:'auto' as const}}>
              <table style={{width:'100%',borderCollapse:'collapse' as const,fontSize:12}}>
                <thead>
                  <tr>
                    <th style={{textAlign:'left' as const,padding:'6px 4px',
                      color:C.muted,fontWeight:700,fontSize:11,minWidth:90}}>NET</th>
                    {slots.map((h: number) => (
                      <th key={h} style={{padding:'6px 4px',textAlign:'center' as const,
                        color:'#1a472a',fontWeight:700,fontSize:10,minWidth:52}}>
                        {calData?.slot_labels?.[h] || `${h}:00`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(nets).map(([netId, netName]: any) => (
                    <tr key={netId}>
                      <td style={{padding:'5px 4px',fontWeight:600,fontSize:11,
                        color:'#111',whiteSpace:'nowrap' as const}}>{netName}</td>
                      {slots.map((h: number) => {
                        const cell = slotData?.[netId]?.[h];
                        const taken   = cell?.taken;
                        const blocked = cell?.blocked;
                        const paid    = cell?.payment_status === 'paid';
                        let bg = '#f0f2f5';
                        let color = 'transparent';
                        if (blocked) { bg='#fed7aa'; color='#ea580c'; }
                        else if (taken && paid) { bg='#bbf7d0'; color='#16a34a'; }
                        else if (taken) { bg='#fef08a'; color='#ca8a04'; }
                        return (
                          <td key={h} style={{padding:'3px'}}>
                            <button onClick={()=>{
                              if(!taken&&!blocked&&canBook){
                                navigate(`/nets-book?date=${selDate}&session=${session}&net=${netId}&hour=${h}`);
                                return;
                              }
                              if(taken&&!blocked){
                                // Find full booking from bookings_today list
                                const full = (calData?.bookings_today||[]).find((b:any)=>b.booking_ref===cell?.booking_ref);
                                setSelBooking(full||cell);
                              }
                            }}
                              style={{width:'100%',height:32,borderRadius:6,border:'none',
                                backgroundColor:bg,cursor:(taken||canBook)&&!blocked?'pointer':'default',
                                display:'flex',alignItems:'center',justifyContent:'center'}}>
                              {taken && !blocked && (
                                <span style={{width:8,height:8,borderRadius:'50%',
                                  backgroundColor:color,display:'block'}}/>
                              )}
                              {blocked && <span style={{fontSize:10}}>🔧</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Legend */}
              <div style={{display:'flex',gap:12,marginTop:10,flexWrap:'wrap' as const}}>
                {[
                  {color:'#f0f2f5',label:canBook?'Open — tap to book':'Open'},
                  {color:'#bbf7d0',label:'Paid'},
                  {color:'#fef08a',label:'Pay at venue'},
                  {color:'#fed7aa',label:'Maintenance'},
                ].map(l => (
                  <div key={l.label} style={{display:'flex',alignItems:'center',gap:4}}>
                    <div style={{width:12,height:12,borderRadius:3,
                      backgroundColor:l.color,border:'1px solid #e0e0e0'}}/>
                    <span style={{fontSize:10,color:C.muted}}>{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Today's bookings list */}
        {!loading && calData?.bookings_today?.length > 0 && (
          <div style={{backgroundColor:C.card,borderRadius:14,padding:14,
            border:`1px solid ${C.border}`}}>
            <div style={{fontWeight:800,fontSize:13,color:C.navy,marginBottom:10}}>
              Bookings — {selDate} ({calData.bookings_today.length})
            </div>
            {calData.bookings_today.map((b: any) => (
              <button key={b.booking_ref} onClick={()=>setSelBooking(b)}
                style={{width:'100%',backgroundColor:'#f8fafc',borderRadius:10,
                  padding:'10px 12px',marginBottom:6,border:`1px solid ${C.border}`,
                  display:'flex',justifyContent:'space-between',alignItems:'center',
                  cursor:'pointer',textAlign:'left' as const}}>
                <div>
                  <div style={{fontWeight:700,fontSize:13,fontFamily:'monospace',
                    color:C.navy}}>{b.booking_ref}</div>
                  <div style={{fontWeight:600,fontSize:13}}>{b.member_name}</div>
                  <div style={{fontSize:11,color:C.muted}}>{b.mobile}</div>
                </div>
                <div style={{textAlign:'right' as const}}>
                  <div style={{fontWeight:800,fontSize:13,color:C.navy}}>{isFree(b) ? 'Free' : fmtAmt(b.total_amount)}</div>
                  <span style={{fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:20,
                    backgroundColor:b.payment_status==='paid'?'#bbf7d0':'#fef08a',
                    color:b.payment_status==='paid'?'#16a34a':'#ca8a04'}}>
                    {b.payment_status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Booking detail bottom sheet */}
      {selBooking && (
        <div style={{position:'fixed' as const,inset:0,zIndex:200,
          backgroundColor:'rgba(0,0,0,0.6)',display:'flex',
          alignItems:'flex-end' as const}} onClick={()=>{setSelBooking(null);setActionMsg('');}}>
          <div onClick={e=>e.stopPropagation()}
            style={{backgroundColor:'#fff',width:'100%',borderRadius:'20px 20px 0 0',
              padding:20,paddingBottom:40,maxHeight:'85vh',overflowY:'auto' as const}}>

            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
              <div>
                <div style={{fontWeight:900,fontSize:16,fontFamily:'monospace',color:C.navy}}>
                  {selBooking.booking_ref}
                </div>
                <div style={{display:'flex',gap:6,marginTop:4,flexWrap:'wrap' as const}}>
                  <span style={{fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:20,
                    backgroundColor:selBooking.status==='confirmed'?'#dcfce7':selBooking.status==='expired'?'#f3f4f6':'#fee2e2',
                    color:selBooking.status==='confirmed'?'#16a34a':selBooking.status==='expired'?'#6b7280':'#dc2626',
                    textTransform:'uppercase' as const}}>
                    {selBooking.status||'confirmed'}
                  </span>
                  <span style={{fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:20,
                    backgroundColor:selBooking.payment_status==='paid'?'#dbeafe':'#fef9c3',
                    color:selBooking.payment_status==='paid'?'#1d4ed8':'#ca8a04',
                    textTransform:'uppercase' as const}}>
                    {selBooking.payment_status||'pending'}
                  </span>
                </div>
              </div>
              <button onClick={()=>{setSelBooking(null);setActionMsg('');}}
                style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.muted}}>✕</button>
            </div>

            <div style={{backgroundColor:'#f8fafc',borderRadius:10,padding:12,marginBottom:12}}>
              <div style={{fontWeight:800,fontSize:15,color:'#111',marginBottom:2}}>{selBooking.member_name}</div>
              <div style={{fontSize:12,color:C.muted}}>📞 {selBooking.mobile||'—'}</div>
              <div style={{fontWeight:900,fontSize:22,color:C.navy,marginTop:8}}>
                {isFree(selBooking) ? 'Free / pass' : fmtAmt(selBooking.total_amount)}
              </div>
            </div>

            {selBooking.nets_booked && Object.keys(selBooking.nets_booked).length>0 && (
              <div style={{backgroundColor:'#f0fdf4',borderRadius:10,padding:10,marginBottom:12}}>
                <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:6,textTransform:'uppercase' as const}}>Nets & Slots</div>
                {Object.entries(selBooking.nets_booked).map(([net,slots]:any)=>(
                  <div key={net} style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'2px 0'}}>
                    <span style={{fontWeight:700}}>{NET_NAMES[net]||net}</span>
                    <span style={{color:C.muted}}>{Array.isArray(slots)?slots.join(', '):slots}</span>
                  </div>
                ))}
              </div>
            )}

            {actionMsg && (
              <div style={{borderRadius:8,padding:'8px 12px',marginBottom:10,
                backgroundColor:actionMsg.startsWith('✓')?'#f0fdf4':'#fef2f2',
                color:actionMsg.startsWith('✓')?'#16a34a':C.red,fontSize:13,fontWeight:600}}>
                {actionMsg}
              </div>
            )}

            {(selBooking.status==='confirmed'||!selBooking.status) && !selPast && shareBookingUrl(selBooking) && (
              <button onClick={()=>shareBooking(selBooking)}
                style={{width:'100%',padding:11,borderRadius:10,border:'none',marginBottom:8,
                  backgroundColor:'#25d366',color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer'}}>
                💬 Share on WhatsApp
              </button>
            )}
            {canManage && (selBooking.status==='confirmed'||!selBooking.status) && (
              <div style={{display:'flex',flexDirection:'column' as const,gap:8}}>
                {!isFree(selBooking) && selBooking.payment_status==='pending' && (
                  <button onClick={()=>doAction(`/bookings/${selBooking.booking_ref}/paid`,`Mark ${fmtAmt(selBooking.total_amount)} paid?`)}
                    style={{width:'100%',padding:13,borderRadius:10,border:'none',
                      background:'linear-gradient(135deg,#16a34a,#15803d)',
                      color:'#fff',fontWeight:800,fontSize:14,cursor:'pointer'}}>
                    💵 Mark Paid
                  </button>
                )}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  {String(selBooking.booking_date||selDate).slice(0,10) === todayIso && (
                    <button onClick={()=>doAction(`/bookings/${selBooking.booking_ref}/no-show`,`${selBooking.member_name||'They'} didn't turn up? The net is released for walk-ins.`)}
                      style={{padding:12,borderRadius:10,border:'1px solid #f59e0b',
                        backgroundColor:'#fffbeb',color:'#b45309',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                      🚫 No-show
                    </button>
                  )}
                  {!isFree(selBooking) && selBooking.payment_status==='pending' && String(selBooking.booking_date||selDate).slice(0,10) < todayIso && (
                    <button onClick={()=>doAction(`/bookings/${selBooking.booking_ref}/expire`,'Expire this unpaid booking? Its slots are released.')}
                      style={{padding:12,borderRadius:10,border:'1px solid #d97706',
                        backgroundColor:'#fffbeb',color:'#d97706',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                      ⏱ Expire
                    </button>
                  )}
                  {!selPast && selPaid && canUndoPay && <button onClick={()=>undoPay(selBooking)}
                    style={{padding:12,borderRadius:10,border:'1px solid #9ca3af',
                      backgroundColor:'#fff',color:'#6b7280',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                    ↩ Undo payment
                  </button>}
                  {!selPast && !selPaid && <button onClick={()=>cancelBooking(selBooking)}
                    style={{padding:12,borderRadius:10,border:`2px solid ${C.red}`,
                      backgroundColor:'#fff',color:C.red,fontWeight:700,fontSize:13,cursor:'pointer'}}>
                    ✕ Cancel
                  </button>}
                </div>
                {!selPast && !(selBooking.price_type==='pass'||selBooking.pass_id) && <button onClick={()=>{
                    setShowReschedule(true);
                    setRsSession(selBooking.session_type||'day');
                    setRsDate(''); setRsSel({}); setRsPreview(null); setRsCalData(null);
                    fetchFullBooking(selBooking.booking_ref);
                  }}
                  style={{width:'100%',padding:12,borderRadius:10,
                    border:'1px solid #7c3aed',backgroundColor:'#f5f3ff',
                    color:'#7c3aed',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                  🔄 Reschedule
                </button>}
              </div>
            )}

            {(selBooking.status==='expired'||selBooking.status==='cancelled') && (
              <div style={{textAlign:'center' as const,padding:16,color:C.muted}}>
                <div style={{fontSize:28,marginBottom:4}}>{selBooking.status==='expired'?'⏱':'✕'}</div>
                <div style={{fontWeight:700,fontSize:13,textTransform:'capitalize' as const}}>Booking {selBooking.status}</div>
              </div>
            )}
            {/* Always visible close button */}
            <button onClick={()=>{setSelBooking(null);setActionMsg('');}}
              style={{width:'100%',padding:12,borderRadius:10,marginTop:12,
                border:`1px solid ${C.border}`,backgroundColor:'#f8fafc',
                color:C.muted,fontWeight:700,fontSize:13,cursor:'pointer'}}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* Reschedule sheet */}
      {showReschedule && selBooking && (
        <div style={{position:'fixed' as const,inset:0,zIndex:300,
          backgroundColor:'rgba(0,0,0,0.7)',display:'flex',alignItems:'flex-end' as const}}>
          <div style={{backgroundColor:'#fff',width:'100%',borderRadius:'20px 20px 0 0',
            maxHeight:'92vh',overflowY:'auto' as const,paddingBottom:40}}>
            <div style={{padding:'16px 16px 0',position:'sticky' as const,top:0,
              backgroundColor:'#fff',borderBottom:`1px solid ${C.border}`,marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{fontWeight:900,fontSize:15,color:C.navy}}>
                  🔄 Reschedule {selBooking.booking_ref}
                </div>
                <button onClick={()=>setShowReschedule(false)}
                  style={{background:'none',border:'none',fontSize:22,cursor:'pointer'}}>✕</button>
              </div>
              <div style={{fontSize:11,color:C.muted,padding:'6px 0 10px'}}>
                Pick session, date and same number of slots ({getOrigSlotCount()} slot{getOrigSlotCount()!==1?'s':''})
              </div>
            </div>

            <div style={{padding:'0 16px'}}>
              {/* Session toggle */}
              <div style={{fontWeight:700,fontSize:11,color:C.muted,marginBottom:6,textTransform:'uppercase' as const}}>1. Session</div>
              <div style={{display:'flex',gap:8,marginBottom:14}}>
                {(['day','night'] as const).map(s=>(
                  <button key={s} onClick={()=>{setRsSession(s);setRsDate('');setRsCalData(null);setRsSel({});setRsPreview(null);}}
                    style={{flex:1,padding:10,borderRadius:10,border:'none',
                      backgroundColor:rsSession===s?C.navy:'#f0f2f5',
                      color:rsSession===s?'#fff':C.muted,fontWeight:700,fontSize:13,cursor:'pointer'}}>
                    {s==='day'?'☀️ Daylight':'🌙 Flood-lit'}
                  </button>
                ))}
              </div>

              {/* Date picker */}
              <div style={{fontWeight:700,fontSize:11,color:C.muted,marginBottom:6,textTransform:'uppercase' as const}}>2. Select Date</div>
              <input type="date" value={rsDate}
                min={todayIso}
                onChange={e=>{setRsDate(e.target.value);setRsSel({});setRsPreview(null);if(e.target.value)loadRsDay(e.target.value,rsSession);}}
                style={{width:'100%',padding:'10px',borderRadius:10,marginBottom:14,
                  border:`1px solid ${C.border}`,fontSize:14,outline:'none',
                  boxSizing:'border-box' as const}}/>

              {/* Slot grid */}
              {rsDate && (
                <>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <div style={{fontWeight:700,fontSize:11,color:C.muted,textTransform:'uppercase' as const}}>3. Select Slots</div>
                    <span style={{fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:20,
                      backgroundColor:totalSelSlots===getOrigSlotCount()?'#dcfce7':'#fef9c3',
                      color:totalSelSlots===getOrigSlotCount()?'#16a34a':'#ca8a04'}}>
                      {totalSelSlots} of {getOrigSlotCount()} selected
                    </span>
                  </div>
                  {rsLoading && <div style={{textAlign:'center',padding:20,color:C.muted}}>Loading slots...</div>}
                  {!rsLoading && rsCalData && (
                    <div style={{overflowX:'auto' as const,marginBottom:14}}>
                      <table style={{width:'100%',borderCollapse:'collapse' as const,fontSize:12}}>
                        <thead>
                          <tr>
                            <th style={{textAlign:'left' as const,padding:'4px',color:C.muted,fontSize:10,minWidth:80}}>NET</th>
                            {(rsCalData.slots||[]).map((h:number)=>(
                              <th key={h} style={{padding:'4px',textAlign:'center' as const,
                                color:'#1a472a',fontSize:10,minWidth:52}}>
                                {rsCalData.slot_labels?.[h]||`${h}:00`}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(NET_NAMES).map(([netId,netName])=>(
                            <tr key={netId}>
                              <td style={{padding:'3px 4px',fontSize:11,fontWeight:600}}>{netName}</td>
                              {(rsCalData.slots||[]).map((h:number)=>{
                                const cell = rsCalData.slot_data?.[netId]?.[h];
                                const own = cell?.booking_ref && cell.booking_ref === selBooking.booking_ref;
                                const taken = cell?.taken && !own && !(rsSel[netId]||[]).includes(h);
                                const blocked = cell?.blocked;
                                const selected = (rsSel[netId]||[]).includes(h);
                                const origCount = getOrigSlotCount(); const disabled = taken || blocked || (origCount>0 && totalSelSlots>=origCount&&!selected);
                                let bg = selected?'#4f46e5':taken?'#fee2e2':blocked?'#fed7aa':'#f0f2f5';
                                return (
                                  <td key={h} style={{padding:'3px'}}>
                                    <button onClick={()=>!disabled&&toggleRsSlot(netId,h)}
                                      style={{width:'100%',height:32,borderRadius:6,border:selected?'2px solid #4f46e5':'none',
                                        backgroundColor:bg,cursor:disabled?'not-allowed':'pointer',
                                        opacity:disabled&&!selected?0.4:1}}>
                                      {selected&&<span style={{color:'#fff',fontSize:14}}>✓</span>}
                                      {taken&&!selected&&<span style={{fontSize:10,color:C.red}}>✗</span>}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Preview */}
                  {totalSelSlots>0 && (totalSelSlots===getOrigSlotCount() || getOrigSlotCount()===0) && (
                    <>
                      {!rsPreview && (
                        <button onClick={previewReschedule}
                          style={{width:'100%',padding:11,borderRadius:10,border:'none',
                            backgroundColor:'#7c3aed',color:'#fff',fontWeight:800,
                            fontSize:13,cursor:'pointer',marginBottom:10}}>
                          Check New Price
                        </button>
                      )}
                      {rsPreview && !rsPreview.error && (
                        <div style={{backgroundColor:'#f5f3ff',borderRadius:10,padding:12,marginBottom:10}}>
                          <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}>
                            <span style={{color:C.muted}}>Original total</span>
                            <span style={{fontWeight:700}}>{fmtAmt(rsPreview.original_total)}</span>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}>
                            <span style={{color:C.muted}}>New total</span>
                            <span style={{fontWeight:800,color:C.navy}}>{fmtAmt(rsPreview.new_total)}</span>
                          </div>
                          {rsPreview.balance_due>0 && (
                            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:C.red}}>
                              <span>Balance due</span>
                              <span style={{fontWeight:800}}>{fmtAmt(rsPreview.balance_due)}</span>
                            </div>
                          )}
                          {rsPreview.new_total===rsPreview.original_total && (
                            <div style={{fontSize:11,color:'#16a34a',fontWeight:600,marginTop:4}}>✓ No price change</div>
                          )}
                        </div>
                      )}
                      {rsPreview?.error && (
                        <div style={{backgroundColor:'#fef2f2',borderRadius:8,padding:10,
                          color:C.red,fontSize:12,marginBottom:10}}>{rsPreview.error}</div>
                      )}
                      {rsPreview && !rsPreview.error && (
                        <button onClick={confirmReschedule} disabled={rsSaving}
                          style={{width:'100%',padding:13,borderRadius:10,border:'none',
                            background:'linear-gradient(135deg,#7c3aed,#6d28d9)',
                            color:'#fff',fontWeight:800,fontSize:14,cursor:'pointer'}}>
                          {rsSaving?'Rescheduling...':'Confirm Reschedule'}
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
              <button onClick={()=>setShowReschedule(false)}
                style={{width:'100%',padding:12,borderRadius:10,marginTop:12,
                  border:'1px solid #e0e0e0',backgroundColor:'#f8fafc',
                  color:'#6b7280',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}