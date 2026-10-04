import React, { useCallback, useEffect, useRef, useState } from 'react';
import { matchesStudentSearch, formatRegno } from './studentUtils';
import { getAllStudents } from '../database/db';
import { useNavigate } from 'react-router-dom';
import StudentPhoto from '../shared/StudentPhoto';
import { usePermissions } from './usePermissions';
import { runBackgroundSync } from './useSyncService';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';
import TileGrid from '../shared/TileGrid';
import EmptyAreaLogo from '../shared/EmptyAreaLogo';

function getApiHeaders(): Record<string,string> {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && Date.now() < exp - 60000) {
    return { 'Authorization': 'Bearer ' + jwt, 'X-Username': localStorage.getItem('auth_user') || '' };
  }
  return (()=>{const _j=localStorage.getItem('jwt_token'),_e=parseInt(localStorage.getItem('jwt_expiry')||'0');if(_j&&Date.now()<_e-60000)return{'Content-Type':'application/json','Authorization':'Bearer '+_j,'X-Username':localStorage.getItem('auth_user')||''};return{'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};})();
}

import {
  getPaymentOverview,
  getPendingUploadCount,
  getPendingByDateSession,
} from '../database/db';
import {
  IconUsers, IconUserPlus, IconBell, IconNotes,
  IconChecklist, IconCloudUpload, IconAlertTriangle, IconCloudDownload,
  IconChevronRight, IconCrown, IconUserCheck, IconTrophy, IconEye, IconX,
  IconNews, IconPhoto, IconBrandYoutube, IconBook, IconMail, IconLogin, IconTool,
} from '@tabler/icons-react';

const C = { green: '#1a472a', gold: '#d4af37', red: '#c0392b', orange: '#e67e22' };

// ─── Pending upload drawer ────────────────────────────────────────────────────
function PendingDrawer({
  items, onClose, onGoToDate,
}: {
  items: { attendance_date:string; session_type:string; total:number; present:number; absent:number }[];
  onClose: () => void;
  onGoToDate: (date:string, session:string) => void;
}) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDate(d: string) {
    const [y,m,day] = d.split('-');
    return `${parseInt(day)} ${MONTHS[parseInt(m)-1]} ${y}`;
  }

  // Group rows by date for cleaner display
  const byDate: Record<string, typeof items> = {};
  items.forEach(r => {
    if (!byDate[r.attendance_date]) byDate[r.attendance_date] = [];
    byDate[r.attendance_date].push(r);
  });

  return (
    <div onClick={onClose} style={{
      position:'fixed', inset:0, zIndex:1000,
      backgroundColor:'rgba(0,0,0,0.6)',
      display:'flex', alignItems:'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor:'#fff', width:'100%', maxHeight:'80vh',
        borderRadius:'20px 20px 0 0', overflowY:'auto', paddingBottom:32,
      }}>
        {/* Header */}
        <div style={{
          backgroundColor: C.green, padding:'18px 18px 14px',
          borderRadius:'20px 20px 0 0',
          display:'flex', alignItems:'center', justifyContent:'space-between',
        }}>
          <div>
            <div style={{ color:'#fff', fontWeight:800, fontSize:16, display:'flex', alignItems:'center', gap:8 }}>
              <IconCloudUpload size={18} /> Pending Upload
            </div>
            <div style={{ color:'rgba(255,255,255,0.65)', fontSize:12, marginTop:2 }}>
              {items.length} session{items.length>1?'s':''} not yet synced to server
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(255,255,255,0.8)', cursor:'pointer' }}><IconX size={22}/></button>
        </div>

        <div style={{ padding:'14px 16px 0' }}>
          {/* Explain */}
          <div style={{
            backgroundColor:'#fff8e1', border:'1px solid #ffe082',
            borderRadius:10, padding:'10px 14px', marginBottom:14, fontSize:13, color:'#7b5800',
          }}>
            Tap a session to view or edit it, then go to <strong>Sync → Upload Attendance</strong> to push to server.
          </div>

          {Object.entries(byDate).map(([date, sessions]) => (
            <div key={date} style={{ marginBottom:14 }}>
              {/* Date header */}
              <div style={{
                fontSize:12, fontWeight:800, color:'#555',
                textTransform:'uppercase', letterSpacing:'0.5px',
                marginBottom:6, paddingLeft:2,
              }}>
                {fmtDate(date)}
              </div>

              {sessions.map(s => (
                <button
                  key={s.session_type}
                  onClick={() => onGoToDate(date, s.session_type)}
                  style={{
                    display:'flex', alignItems:'center', width:'100%',
                    backgroundColor:'#fff', borderRadius:12, padding:'12px 14px',
                    marginBottom:8, border:`1.5px solid ${C.orange}44`,
                    cursor:'pointer', textAlign:'left',
                    boxShadow:'0 1px 4px rgba(0,0,0,0.08)',
                  }}
                >
                  {/* Session pill */}
                  <div style={{
                    backgroundColor: s.session_type==='Morning' ? '#fff8e1' : '#e8f4fd',
                    color: s.session_type==='Morning' ? '#f57f17' : '#1565c0',
                    borderRadius:8, padding:'4px 10px',
                    fontSize:12, fontWeight:800, marginRight:12, flexShrink:0,
                  }}>
                    {s.session_type}
                  </div>

                  {/* Counts */}
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', gap:14 }}>
                      <span style={{ fontSize:13, fontWeight:700, color:C.green }}>
                        {s.present} present
                      </span>
                      <span style={{ fontSize:13, fontWeight:700, color:C.red }}>
                        {s.absent} absent
                      </span>
                    </div>
                    <div style={{ fontSize:11, color:'#888', marginTop:2 }}>
                      {s.total} students total
                    </div>
                  </div>

                  {/* Arrow */}
                  <IconChevronRight size={18} color="#aaa" />
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Role badge ────────────────────────────────────────────────────────────
const ROLE_BADGE: Record<string, { Icon: any; bg: string; fg: string }> = {
  admin:  { Icon: IconCrown,     bg: C.gold,                  fg: C.green },
  coach:  { Icon: IconUserCheck, bg: 'rgba(255,255,255,0.2)', fg: '#fff'  },
  scorer: { Icon: IconTrophy,    bg: 'rgba(255,255,255,0.2)', fg: '#fff'  },
};

// ─── Students & fees tiles ───────────────────────────────────────────────────
type Tile = { Icon: any; label: string; sub: string; path: string; slug: string; badge?: number };

// ─── Main Menu (Home) ────────────────────────────────────────────────────────
export default function MainMenu() {
  const navigate = useNavigate();
  const { can: canPerm, isLoaded: permsLoaded, roleLabel, isDataRestricted: restricted, isAnonymous: anon } = usePermissions();
  const role    = (localStorage.getItem('user_role') || 'viewer').toLowerCase();

  // "New data on server" badge — set by background status check, cleared on tap
  const [hasNewData, setHasNewData] = useState(false);

  // Birthday banner - once per day
  const _todayKey = new Date().toISOString().slice(0,10);
  const [bdayKids,      setBdayKids]      = useState<any[]>([]);
  const [bdayDismissed, setBdayDismissed] = useState(
    localStorage.getItem('bday_dismissed') === _todayKey
  );
  const [announcements,  setAnnouncements]  = useState<any[]>([]);
  const [playerOfMonth,  setPlayerOfMonth]  = useState<any>(null);
  const [annDismissed,   setAnnDismissed]   = useState<number[]>([]);
  const _potmKey = 'potm_dismissed_' + new Date().toISOString().slice(0,7);
  const [potmDismissed,  setPotmDismissed]  = useState(
    localStorage.getItem(_potmKey) === '1'
  );
  const dismissPotm = () => {
    localStorage.setItem(_potmKey, '1');
    setPotmDismissed(true);
  };

  const dismissBday = () => {
    localStorage.setItem('bday_dismissed', _todayKey);
    setBdayDismissed(true);
  };

  useEffect(() => {
    const base2 = (localStorage.getItem('server_ip')||'').trim().replace(/\/+$/,'');
    const H2 = getApiHeaders();
    if (!bdayDismissed) {
      fetch(`${base2}/api/data/utils/birthdays?month=0`,{headers:H2})
        .then(r=>r.json()).then(j=>{if(j.today?.length>0)setBdayKids(j.today);})
        .catch(()=>{});
    }
    fetch(`${base2}/api/data/announcements`,{headers:H2})
      .then(r=>r.json()).then(j=>{if(j.announcements)setAnnouncements(j.announcements);})
      .catch(()=>{});
    const monthStr = new Date().toISOString().slice(0,7);
    fetch(`${base2}/api/data/player-of-month?month=${monthStr}`,{headers:H2})
      .then(r=>r.json()).then(j=>{if(j.player)setPlayerOfMonth(j.player);})
      .catch(()=>{});
  }, []);
  const [syncing,    setSyncing]    = useState(false);
  const [syncMsg,    setSyncMsg]    = useState('');
  const syncMsgTimer = useRef<any>(null);

  useEffect(() => {
    const onNew = () => setHasNewData(true);
    window.addEventListener('qca-new-data', onNew);
    return () => window.removeEventListener('qca-new-data', onNew);
  }, []);

  const [duesCount,    setDuesCount]    = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingItems, setPendingItems] = useState<any[]>([]);
  const [showPending,  setShowPending]  = useState(false);
  const [showLogo,     setShowLogo]     = useState(false);

  const refresh = useCallback(async () => {
    if (anon) return; // nothing signed-in to read — avoid pointless local DB queries
    const [ov, pc, pi] = await Promise.all([
      getPaymentOverview(),
      getPendingUploadCount(),
      getPendingByDateSession(),
    ]);
    setDuesCount(ov.studentsWithDues);
    setPendingCount(pc);
    setPendingItems(pi);
  }, [anon]);

  const doSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await runBackgroundSync();
      const total = r.students + r.payments + r.attendance + r.writeoffs;
      setSyncMsg(total > 0 ? `✅ ${total} record${total > 1 ? 's' : ''} updated` : '✅ Already up to date');
      if (total > 0) { refresh(); setHasNewData(false); }
    } catch {
      setSyncMsg('⚠ Could not reach server');
    } finally {
      setSyncing(false);
      clearTimeout(syncMsgTimer.current);
      syncMsgTimer.current = setTimeout(() => setSyncMsg(''), 3000);
    }
  }, [syncing, refresh]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const goToDate = (date: string, session: string) => {
    setShowPending(false);
    navigate('/attendance', { state: { date, session } });
  };

  const STUDENT_TILES: Tile[] = [
    { Icon: IconUsers,    label: 'Students',    sub: 'Roster & profiles',           path: 'students',  slug: 'student:view' },
    { Icon: IconUserPlus, label: 'Add Student', sub: 'Register offline student',   path: 'addstudent', slug: 'student:add' },
    { Icon: IconBell,     label: 'Reminders',
      sub: duesCount > 0 ? `${duesCount} student${duesCount>1?'s':''} with fee dues` : 'Send payment reminders',
      path: 'reminders', slug: 'payments:alerts', badge: duesCount },
    { Icon: IconNotes,    label: 'Remarks',     sub: 'Coach notes per student',     path: 'remarks',   slug: 'remarks:view' },
    { Icon: IconChecklist, label: 'Net Booking',  sub: 'Dashboard, calendar & admin', path: 'nets-hub', slug: 'nets:view' },
    { Icon: IconCrown,    label: 'Finance',     sub: 'Record income & expenses',    path: 'finance',   slug: 'payments:record' },
    { Icon: IconTool,     label: 'Utilities',   sub: 'Reports & monitoring',        path: 'utilities', slug: 'utils:report' },
      ];
  // Public content — what an anonymous visitor sees instead of Students & fees
  const PUBLIC_TILES: Tile[] = [
    { Icon: IconNews,         label: 'Cricket Hub',   sub: 'AI news & coaching insights',        path: 'news',    slug: '' },
    { Icon: IconTrophy,       label: 'Matches',       sub: 'Live scoring & results',             path: 'matches', slug: '' },
    { Icon: IconPhoto,        label: 'Academy Pulse', sub: 'Daily photos, videos & moments',     path: 'pulse',   slug: '' },
    { Icon: IconBrandYoutube, label: 'QCA Channel',   sub: 'Academy YouTube channel',            path: 'videos',  slug: '' },
    { Icon: IconBook,         label: 'Library',       sub: 'Coaching videos & resources',        path: 'library', slug: '' },
    { Icon: IconMail,         label: 'Contact Us',    sub: 'Enquiries, phone, WhatsApp, social', path: 'contact', slug: '' },
  ];
  const UTILS_SLUGS = ['utils:students','utils:attendance','utils:payments','utils:report','utils:inactive'];
  const hasAnyUtils = !anon && permsLoaded && UTILS_SLUGS.some(s => canPerm(s));
  const tiles = anon ? PUBLIC_TILES : (permsLoaded
    ? STUDENT_TILES.filter(t => t.path === 'utilities' ? hasAnyUtils : canPerm(t.slug))
    : STUDENT_TILES);

  const badge = ROLE_BADGE[role] ?? { Icon: IconEye, bg: 'rgba(255,255,255,0.2)', fg: '#fff' };
  const showAttendanceCta = !anon && (permsLoaded ? canPerm('attendance:view') : true);
  const showStatusRow = !anon && !restricted;
  const hasSyncAccess = !anon && (permsLoaded
    ? ['sync:upload','sync:download','sync:students','sync:payments','sync:reupload','sync:runall'].some(canPerm)
    : true);

  return (
    <div style={S.page}>
      {/* Sync status toast */}
      {syncMsg && (
        <div style={{
          position:'fixed', bottom:80, left:'50%', transform:'translateX(-50%)',
          backgroundColor:'#0d1b2a', color:'#fff', padding:'10px 20px',
          borderRadius:30, fontSize:13, fontWeight:700, zIndex:9999,
          boxShadow:'0 4px 16px rgba(0,0,0,0.3)', whiteSpace:'nowrap',
        }}>{syncMsg}</div>
      )}
      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>

      <ScreenHeader
        back={false}
        title={<span style={{ fontSize:15, fontWeight:800 }}>Quickies Cricket Club</span>}
        subtitle={<span style={{ color:C.gold, fontSize:9, letterSpacing:'0.8px', fontWeight:700 }}>QUICKIES CRICKET ACADEMY</span>}
        leading={
          <button onClick={() => setShowLogo(true)} aria-label="View academy logo"
            style={{ ...S.logoRing, border:'none', padding:0, cursor:'zoom-in' }}>
            <img
              src="/logo.png"
              alt="QCA"
              onError={(e) => {
                const t = e.target as HTMLImageElement;
                t.style.display = 'none';
                t.nextElementSibling && ((t.nextElementSibling as HTMLElement).style.display = 'flex');
              }}
              style={{ width:34, height:34, objectFit:'contain', borderRadius:8 }}
            />
            <span style={{ fontSize:18, display:'none', alignItems:'center', justifyContent:'center' }}>🏏</span>
          </button>
        }
        actions={<>
          {!anon && (
            <HeaderIconButton label="Refresh data from server" onClick={doSync} disabled={syncing}>
              <span style={{ display:'inline-block', fontSize:18,
                animation: syncing ? 'spin 0.8s linear infinite' : 'none' }}>🔄</span>
            </HeaderIconButton>
          )}
          <div style={{
            backgroundColor: anon ? 'rgba(255,255,255,0.15)' : badge.bg,
            color: anon ? 'rgba(255,255,255,0.85)' : badge.fg,
            borderRadius:20, padding:'4px 8px', fontSize:11, fontWeight:800,
            display:'flex', alignItems:'center', gap:4, marginRight:4,
          }}>
            {anon ? 'Guest' : <><badge.Icon size={13} /> {roleLabel}</>}
          </div>
        </>}>
        {/* Alert strip — only when there's something to say (signed-in users only) */}
        {!anon && (hasNewData || pendingCount > 0) && (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {hasNewData && (
              <button onClick={() => setHasNewData(false)}
                style={{
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  backgroundColor:'rgba(212,175,55,0.15)', border:'1px solid rgba(212,175,55,0.4)',
                  borderRadius:10, padding:'9px 14px', cursor:'pointer', textAlign:'left',
                }}>
                <span style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, fontWeight:700, color:C.gold }}>
                  <IconCloudDownload size={15} /> New data on server — pull down on any page to refresh
                </span>
                <IconX size={14} color="rgba(255,255,255,0.5)" />
              </button>
            )}
            {pendingCount > 0 && (
              <button
                onClick={() => hasSyncAccess ? navigate('/syncscreen') : setShowPending(true)}
                style={{
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  backgroundColor:'rgba(192,57,43,0.85)', borderRadius:12, padding:'10px 14px',
                  border:'none', cursor:'pointer', width:'100%', textAlign:'left',
                }}
              >
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <IconCloudUpload size={16} color="#fff" />
                  <div>
                    <div style={{ color:'#fff', fontWeight:800, fontSize:13 }}>
                      {pendingCount} attendance record{pendingCount>1?'s':''} pending upload
                    </div>
                    <div style={{ color:'rgba(255,255,255,0.7)', fontSize:11, marginTop:1 }}>
                      {pendingItems.length} session{pendingItems.length!==1?'s':''} across{' '}
                      {new Set(pendingItems.map(p=>p.attendance_date)).size} date{new Set(pendingItems.map(p=>p.attendance_date)).size!==1?'s':''} — tap to view
                    </div>
                  </div>
                </div>
                <IconChevronRight size={20} color="rgba(255,255,255,0.7)" />
              </button>
            )}
          </div>
        )}
      </ScreenHeader>

      {/* Player of Month */}
      {playerOfMonth && !potmDismissed && (
        <div style={{margin:'8px 16px 4px',padding:'14px',
          background:'linear-gradient(135deg,#001f3f,#1a2f4a)',
          borderRadius:16,boxShadow:'0 4px 16px rgba(0,31,63,0.3)'}}>
          <div style={{fontSize:10,fontWeight:800,color:'#c5a059',
            textTransform:'uppercase' as const,letterSpacing:'1.5px',marginBottom:8}}>
            🏆 Player of the Month
          </div>
          <div style={{display:'flex',alignItems:'center',gap:14}}>
            <div style={{width:56,height:56,borderRadius:12,overflow:'hidden',
              border:'3px solid #c5a059',backgroundColor:'#1a472a',flexShrink:0,
              display:'flex',alignItems:'center',justifyContent:'center'}}>
              <StudentPhoto
                  student={{name:playerOfMonth.name,profile_image:playerOfMonth.profile_image}}
                  size={56}
                  style={{borderRadius:10,objectFit:'cover' as const}}
                />
            </div>
            <div style={{flex:1}}>
              <div style={{fontWeight:900,fontSize:16,color:'#fff'}}>{playerOfMonth.name}</div>
              <div style={{fontSize:11,color:'#c5a059',fontWeight:700,marginTop:2}}>
                {playerOfMonth.regno_fmt} · {playerOfMonth.level||'Academy'}
              </div>
              {playerOfMonth.reason && (
                <div style={{fontSize:11,color:'rgba(255,255,255,0.65)',
                  marginTop:4,fontStyle:'italic'}}>"{playerOfMonth.reason}"</div>
              )}
            </div>
            <div style={{display:'flex',flexDirection:'column' as const,alignItems:'center',gap:4}}>
              <span style={{fontSize:22}}>⭐</span>
              <button onClick={dismissPotm}
                style={{background:'none',border:'none',color:'rgba(255,255,255,0.5)',
                  fontSize:16,cursor:'pointer',padding:0,lineHeight:1}}>✕</button>
            </div>
          </div>
        </div>
      )}

      {/* Announcements */}
      {announcements.filter((a:any)=>!annDismissed.includes(a.id)).map((a:any)=>(
        <div key={a.id} style={{margin:'4px 16px 0',padding:'10px 14px',
          background:!!a.pinned?'linear-gradient(135deg,#1a472a,#2d6a4f)':'#fff',
          borderRadius:12,borderLeft:`4px solid ${!!a.pinned?'#c5a059':'#001f3f'}`,
          boxShadow:'0 1px 6px rgba(0,0,0,0.08)',
          display:'flex',alignItems:'flex-start',gap:10}}>
          <div style={{flex:1}}>
            {!!a.pinned && <div style={{fontSize:9,fontWeight:800,color:'#c5a059',
              textTransform:'uppercase' as const,letterSpacing:'1px',marginBottom:3}}>📌 Pinned</div>}
            <div style={{fontWeight:800,fontSize:13,
              color:!!a.pinned?'#fff':'#001f3f'}}>{a.title}</div>
            <div style={{fontSize:12,marginTop:3,lineHeight:1.4,
              color:!!a.pinned?'rgba(255,255,255,0.8)':'#4b5563'}}>{a.body}</div>
          </div>
          {!(a.pinned) && (
            <button onClick={()=>setAnnDismissed((v:number[])=>[...v,a.id])}
              style={{background:'none',border:'none',color:'#9ca3af',
                fontSize:16,cursor:'pointer',padding:0,flexShrink:0}}>✕</button>
          )}
        </div>
      ))}

      {/* Birthday Banner */}
      {bdayKids.length > 0 && !bdayDismissed && (
        <div style={{margin:'4px 16px 0',
          background:'linear-gradient(135deg,#f59e0b,#d97706)',
          padding:'10px 16px',display:'flex',alignItems:'center',gap:10,
          borderRadius:12,boxShadow:'0 2px 8px rgba(245,158,11,0.3)'}}>
          <span style={{fontSize:22}}>🎂</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:'#fff'}}>Happy Birthday!</div>
            <div style={{fontSize:11,color:'rgba(255,255,255,0.9)',marginTop:2}}>
              {bdayKids.map((s:any)=>`${s.name}${s.regno&&s.regno!=='—'?' ('+s.regno+')':''}`).join(' · ')}
            </div>
          </div>
          <button onClick={dismissBday}
            style={{background:'none',border:'none',color:'rgba(255,255,255,0.8)',
              fontSize:20,cursor:'pointer',padding:4}}>✕</button>
        </div>
      )}

      {/* Status row — quick numbers for staff roles */}
      {showStatusRow && (
        <div style={{ padding:'12px 12px 0', display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:10 }}>
          <button onClick={() => hasSyncAccess ? navigate('/syncscreen') : setShowPending(true)} disabled={pendingItems.length===0} style={S.statCard}>
            <div style={{ ...S.statIcon, backgroundColor:'#e8f4fd', color:'#1565c0' }}>
              <IconCloudUpload size={18} />
            </div>
            <div style={{ textAlign:'left' }}>
              <div style={S.statValue}>{pendingCount}</div>
              <div style={S.statLabel}>Pending upload</div>
            </div>
          </button>
          <button onClick={() => navigate('/payments')} style={S.statCard}>
            <div style={{ ...S.statIcon, backgroundColor: duesCount>0 ? '#fdecea' : '#eafaf1', color: duesCount>0 ? C.red : '#27ae60' }}>
              <IconAlertTriangle size={18} />
            </div>
            <div style={{ textAlign:'left' }}>
              <div style={{ ...S.statValue, color: duesCount>0 ? C.red : '#27ae60' }}>{duesCount}</div>
              <div style={S.statLabel}>Fee dues</div>
            </div>
          </button>
        </div>
      )}

      {/* Primary CTA — mark today's attendance (signed-in) or sign in (anon) */}
      {showAttendanceCta && (
        <div style={{ padding:'10px 12px 0' }}>
          <button onClick={() => navigate('/attendance')} style={S.cta}>
            <div style={{ ...S.statIcon, backgroundColor:'rgba(255,255,255,0.18)', color:'#fff' }}>
              <IconChecklist size={20} />
            </div>
            <div style={{ flex:1, textAlign:'left' }}>
              <div style={{ color:'#fff', fontWeight:800, fontSize:15 }}>Mark attendance</div>
              <div style={{ color:'rgba(255,255,255,0.7)', fontSize:12, marginTop:1 }}>Take today's session attendance</div>
            </div>
            <IconChevronRight size={20} color="rgba(255,255,255,0.7)" />
          </button>
        </div>
      )}
      {anon && (
        <div style={{ padding:'10px 12px 0' }}>
          <button onClick={() => navigate('/settings')} style={S.cta}>
            <div style={{ ...S.statIcon, backgroundColor:'rgba(255,255,255,0.18)', color:'#fff' }}>
              <IconLogin size={20} />
            </div>
            <div style={{ flex:1, textAlign:'left' }}>
              <div style={{ color:'#fff', fontWeight:800, fontSize:15 }}>Sign in</div>
              <div style={{ color:'rgba(255,255,255,0.7)', fontSize:12, marginTop:1 }}>Connect to the academy server</div>
            </div>
            <IconChevronRight size={20} color="rgba(255,255,255,0.7)" />
          </button>
        </div>
      )}

      {/* Students & fees (signed-in) / Cricket & academy (anon) */}
      <div style={{ padding:'12px 12px 0' }}>
        <TileGrid
          title={anon ? 'Cricket & academy' : 'Students & fees'}
          color="#b8902c"
          items={tiles}
          onSelect={item => navigate(`/${item.path}`)}
        />
      </div>

      <EmptyAreaLogo />
      <p style={S.footer}>Trivandrum · Kerala</p>

      {/* Enlarged logo — tap anywhere to close */}
      {showLogo && (
        <div onClick={() => setShowLogo(false)} role="dialog" aria-label="Academy logo"
          style={{
            position:'fixed', inset:0, zIndex:3000, cursor:'zoom-out',
            background:'radial-gradient(circle at 50% 42%, #1f4d30 0%, #0b1f14 70%)',
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            padding:24, animation:'qcaLogoIn 0.22s ease-out',
          }}>
          <style>{`@keyframes qcaLogoIn { from { opacity:0; transform:scale(0.85); } to { opacity:1; transform:scale(1); } }`}</style>
          <img src="/logo.png" alt="Quickies Cricket Academy"
            style={{ width:'min(78vw, 360px)', height:'auto', borderRadius:24,
              boxShadow:'0 12px 40px rgba(0,0,0,0.5)' }} />
          <div style={{ color:'#fff', fontWeight:800, fontSize:18, marginTop:22 }}>Quickies Cricket Club</div>
          <div style={{ color:C.gold, fontWeight:700, fontSize:11, letterSpacing:'1.5px', marginTop:4 }}>
            QUICKIES CRICKET ACADEMY
          </div>
          {/* Academy motto */}
          <div style={{ color:'#fff', fontStyle:'italic', fontWeight:600, fontSize:15, marginTop:18,
            textAlign:'center', lineHeight:1.4, opacity:0.92 }}>
            “Build Character before Champions”
          </div>
          <div style={{ width:40, height:2, borderRadius:1, backgroundColor:C.gold, margin:'14px 0 10px', opacity:0.7 }} />
          <div style={{ color:'rgba(255,255,255,0.45)', fontSize:12 }}>Trivandrum · Kerala</div>
          <button onClick={() => setShowLogo(false)} aria-label="Close"
            style={{ position:'absolute', top:'calc(14px + env(safe-area-inset-top, 0px))', right:14,
              width:44, height:44, borderRadius:22, border:'none', cursor:'pointer',
              backgroundColor:'rgba(255,255,255,0.12)', color:'#fff', fontSize:20 }}>✕</button>
        </div>
      )}

      {/* Pending drawer */}
      {showPending && pendingItems.length > 0 && (
        <PendingDrawer
          items={pendingItems}
          onClose={() => setShowPending(false)}
          onGoToDate={goToDate}
        />
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:      { backgroundColor:'#f4f7f6', minHeight:'100%', fontFamily:'sans-serif', paddingBottom:24, display:'flex', flexDirection:'column' },
  logoRing:  { width:40, height:40, borderRadius:12, backgroundColor:'rgba(255,255,255,0.15)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' },
  statCard:  { backgroundColor:'#fff', border:'none', borderRadius:14, padding:'12px 14px', cursor:'pointer', boxShadow:'0 2px 8px rgba(0,0,0,0.06)', display:'flex', alignItems:'center', gap:10, textAlign:'left' },
  statIcon:  { width:34, height:34, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 },
  statValue: { fontSize:18, fontWeight:900, color:'#111827', lineHeight:1.1 },
  statLabel: { fontSize:10.5, color:'#9ca3af', marginTop:1, textTransform:'uppercase', letterSpacing:'0.5px', fontWeight:700 },
  cta:       { backgroundColor:C.green, border:'none', borderRadius:14, padding:'12px 14px', cursor:'pointer', width:'100%', display:'flex', alignItems:'center', gap:12, boxShadow:'0 2px 8px rgba(0,0,0,0.1)' },
  footer:    { textAlign:'center', color:'#aaa', fontSize:11, padding:'8px 0 4px' },
};