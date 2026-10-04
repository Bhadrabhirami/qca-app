import { matchesStudentSearch, formatRegno } from './studentUtils';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScreenHeader, { HeaderSearch, HeaderPill } from '../shared/ScreenHeader';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions, isDataRestricted, getLinkedStudentIds } from './usePermissions';
import {
  getActiveStudents, getAllStudentsInclInactive,
  getAttendanceMapWithSync,
  upsertAttendance,
  deleteStudentAttendance,
  deleteAttendanceSession,
  getCachedImageUrl,
  getUnsyncedAttendance,
  markAttendanceSynced,
} from '../database/db';
import StudentPhoto from '../shared/StudentPhoto';
import { NAV_CLEARANCE } from '../shared/BottomNav';

const SESSIONS = ['Morning', 'Evening', 'Night'];

function getDateBounds() {
  const today = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = fmt(today);
  const min = new Date(today);
  min.setDate(min.getDate() - 6);
  return { todayStr, minStr: fmt(min) };
}

const C = {
  green: '#1a472a', gold: '#d4af37', white: '#ffffff',
  bg: '#f4f7f6', border: '#e0e0e0', gray: '#888', red: '#c0392b',
  orange: '#e67e22',
};

// ─── Attendance record type ───────────────────────────────────────────────────
interface AttRec { present: boolean; synced: boolean; }

// ─── Photo zoom modal ─────────────────────────────────────────────────────────
function PhotoZoomModal({ student, resolvedSrc, onClose }: {
  student: any; resolvedSrc: string | null; onClose: () => void;
}) {
  const initials = student.name.split(' ').map((w: string) => w[0] ?? '').slice(0,2).join('').toUpperCase();
  const hue = student.name.charCodeAt(0) * 37 % 360;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      backgroundColor: 'rgba(0,0,0,0.93)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: 28,
    }}>
      {resolvedSrc ? (
        <img src={resolvedSrc} alt={student.name} style={{
          width: 260, height: 260, borderRadius: '50%', objectFit: 'cover',
          border: '4px solid rgba(255,255,255,0.25)', marginBottom: 20,
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }} />
      ) : (
        <div style={{
          width: 260, height: 260, borderRadius: '50%', marginBottom: 20,
          backgroundColor: `hsl(${hue},40%,26%)`, border: `4px solid hsl(${hue},40%,36%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: `hsl(${hue},60%,74%)`, fontWeight: 900, fontSize: 90,
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}>{initials}</div>
      )}
      <p style={{ color: '#fff', fontWeight: 800, fontSize: 24, textAlign: 'center', margin: '0 0 6px' }}>
        {student.name}
      </p>
      <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, margin: 0 }}>
        {student.qca_id ? `QCA-${String(student.qca_id).padStart(3,'0')}` : ''}{student.level ? ` · ${student.level}` : ''}
      </p>
      <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: 12, marginTop: 28 }}>
        Tap anywhere to close
      </p>
    </div>
  );
}

// ─── Share modal — native share sheet (WhatsApp / Email / SMS / any app) ──────
function ShareTableModal({ date, students, morningRec, eveningRec, nightRec={}, sessions, onClose }: {
  date: string; students: any[];
  morningRec: Record<number, AttRec>;
  eveningRec: Record<number, AttRec>;
  nightRec?: Record<number, AttRec>;
  sessions: string[]; onClose: () => void;
}) {
  const includeMorning = sessions.includes('Morning');
  const includeEvening = sessions.includes('Evening');
    const includeNight   = sessions.includes('Night');
  const [shared, setShared] = React.useState(false);

  const [y, m, d] = date.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateLabel = parseInt(d) + ' ' + months[parseInt(m)-1] + ' ' + y;

  const morningPresent = students.filter(s => morningRec[s.id]?.present).sort((a,b)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999));
  const eveningPresent = students.filter(s => eveningRec[s.id]?.present).sort((a,b)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999));
  const nightPresent = students.filter(s => nightRec[s.id]?.present).sort((a,b)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999));
  const bothPresent    = students.filter(s => morningRec[s.id]?.present && eveningRec[s.id]?.present).sort((a,b)=>(Number(a.qca_id)||9999)-(Number(b.qca_id)||9999));
  const total = includeMorning && includeEvening
    ? students.filter(s => morningRec[s.id]?.present || eveningRec[s.id]?.present).length
    : includeMorning ? morningPresent.length : eveningPresent.length;

  const buildText = (): string => {
    const L: string[] = [];
    const fmt = (s:any,i:number) => (i+1)+'. '+(s.qca_id ? '['+String(s.qca_id).padStart(3,'0')+']' : '['+String(parseInt(s.regno||'0')||0).padStart(3,'0')+']')+' '+s.name;
    L.push('\u{1F3CF} *QCA Attendance \u2014 ' + dateLabel + '*');
    L.push('');

    if (includeMorning) {
      L.push('*Morning \u2014 ' + morningPresent.length + ' present*');
      morningPresent.forEach((s,i) => L.push(fmt(s,i)));
      L.push('');
    }
    if (includeEvening) {
      L.push('*Evening \u2014 ' + eveningPresent.length + ' present*');
      eveningPresent.forEach((s,i) => L.push(fmt(s,i)));
      L.push('');
    }
    if (includeNight) {
      L.push('*Night \u2014 ' + nightPresent.length + ' present*');
      nightPresent.forEach((s,i) => L.push(fmt(s,i)));
      L.push('');
    }

    // Summary line
    const parts = [];
    if (includeMorning) parts.push('M: ' + morningPresent.length);
    if (includeEvening) parts.push('E: ' + eveningPresent.length);
    if (includeNight)   parts.push('N: ' + nightPresent.length);
    const unique = students.filter(s =>
      (includeMorning && morningRec[s.id]?.present) ||
      (includeEvening && eveningRec[s.id]?.present) ||
      (includeNight   && (nightRec||{})[s.id]?.present)
    ).length;
    parts.push('Unique: ' + unique);
    L.push('\uD83D\uDCCB ' + parts.join(' \u00B7 '));
    L.push('');
    L.push('_Shared from QCA App_');
    return L.join(String.fromCharCode(10));
  };

  const doShare = async () => {
    const text = buildText();
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({ title: 'QCA Attendance ' + dateLabel, text });
        setShared(true);
      } else {
        await (navigator as any).clipboard.writeText(text);
        setShared(true);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setShared(true); // treat cancel as ok
    }
  };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:3000, backgroundColor:'rgba(0,0,0,0.7)',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end' }}>
      <div style={{ backgroundColor:'#fff', borderRadius:'20px 20px 0 0', width:'100%',
        maxWidth:480, padding:'0 0 32px', boxShadow:'0 -8px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 6px' }}>
          <div style={{ width:40, height:4, borderRadius:2, backgroundColor:'#d1d5db' }}/>
        </div>
        <div style={{ padding:'8px 20px 14px', borderBottom:'1px solid #f0f0f0' }}>
          <div style={{ fontWeight:900, fontSize:16, color:'#0d1b2a' }}>📤 Share Attendance</div>
          <div style={{ fontSize:12, color:'#9ca3af', marginTop:3 }}>{dateLabel}</div>
        </div>
        <div style={{ margin:'14px 20px', padding:'12px 14px', borderRadius:12,
          backgroundColor:'#f0fdf4', border:'1px solid #bbf7d0' }}>
          <div style={{ fontWeight:800, fontSize:13, color:'#166534', marginBottom:8 }}>Summary</div>
          {includeMorning && (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:4 }}>
              <span>🌅 Morning present</span>
              <span style={{ fontWeight:800, color:'#166534' }}>{morningPresent.length}</span>
            </div>
          )}
          {includeEvening && (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:4 }}>
              <span>🌆 Evening present</span>
              <span style={{ fontWeight:800, color:'#166534' }}>{eveningPresent.length}</span>
            </div>
          )}
          {includeMorning && includeEvening && (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13,
              paddingTop:6, borderTop:'1px solid #bbf7d0', marginTop:4 }}>
              <span>Both sessions</span>
              <span style={{ fontWeight:800, color:'#166534' }}>{bothPresent.length}</span>
            </div>
          )}
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12,
            paddingTop:6, borderTop:'1px solid #bbf7d0', marginTop:4, color:'#6b7280' }}>
            <span>Total unique present</span>
            <span style={{ fontWeight:700 }}>{total}</span>
          </div>
        </div>
        <div style={{ padding:'0 20px' }}>
          <button onClick={doShare}
            style={{ width:'100%', padding:'14px', borderRadius:12, border:'none',
              backgroundColor: shared ? '#166534' : '#1a472a',
              color:'#fff', fontWeight:900, fontSize:15, cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
            <span style={{ fontSize:20 }}>{shared ? '✅' : '📤'}</span>
            <span>{shared ? 'Shared!' : 'Share via WhatsApp / Email / SMS…'}</span>
          </button>
          {shared && (
            <div style={{ textAlign:'center', marginTop:8, fontSize:12, color:'#6b7280' }}>
              Text copied to clipboard if share sheet did not open
            </div>
          )}
          <button onClick={onClose}
            style={{ width:'100%', marginTop:10, padding:'12px', borderRadius:12,
              border:'1px solid #d1d5db', backgroundColor:'#fff',
              color:'#374151', fontWeight:700, fontSize:14, cursor:'pointer' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Clear session confirm modal ──────────────────────────────────────────────
function ClearSessionModal({ date, session, syncedCount, onConfirm, onCancel }: {
  date: string; session: string; syncedCount: number;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 4000, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ backgroundColor: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 360, boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 32, textAlign: 'center', marginBottom: 12 }}>🗑️</div>
        <div style={{ fontWeight: 800, fontSize: 17, color: '#222', textAlign: 'center', marginBottom: 8 }}>
          Clear {session} — {date}?
        </div>
        {syncedCount > 0 ? (
          <div style={{ backgroundColor: '#fdecea', border: '1px solid #f5c6cb', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: C.red }}>
            ⚠ <strong>{syncedCount} record(s) already synced to server</strong> — these cannot be deleted locally. Only the <strong>unsynced</strong> records will be removed.
          </div>
        ) : (
          <div style={{ backgroundColor: '#fff3cd', border: '1px solid #ffc107', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#856404' }}>
            This will delete <strong>all unsynced records</strong> for this session from your device. The server is not affected.
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: '1.5px solid #ddd', backgroundColor: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', color: '#666' }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: 'none', backgroundColor: C.red, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            {syncedCount > 0 ? 'Clear Unsynced' : 'Clear All'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function AttendanceScreen() {
  const navigate = useNavigate();
  const { can, roleLabel }  = usePermissions();
  const canWrite = can('attendance:take');
  const restricted          = isDataRestricted();   // true for student/parent
  const linkedIds           = getLinkedStudentIds(); // their student IDs
  const location  = useLocation();
  const { todayStr, minStr } = getDateBounds();

  // Accept pre-selected date+session from navigation state (e.g. from pending drawer)
  const navState = location.state as { date?: string; session?: string } | null;
  const initDate    = navState?.date    && navState.date >= minStr && navState.date <= todayStr
    ? navState.date : todayStr;
  const initSession = navState?.session && SESSIONS.includes(navState.session)
    ? navState.session
    : (new Date().getHours() < 14 ? 'Morning' : 'Evening');

  const [date, setDate]                   = useState(initDate);
  const [selectedSession, setSession]     = useState(initSession);
  const [searchQuery, setSearch]          = useState('');
  const [students, setStudents]           = useState<any[]>([]);
  // attendance map now carries both present AND synced per student
  const [attMap, setAttMap]               = useState<Record<number, AttRec>>({});
  const [isLoaded, setIsLoaded]           = useState(false);
  const [saveStatus, setSaveStatus]       = useState('');
  const [showPresentOnly, setShowPresent] = useState(false);
  const [showInactive, setShowInactive]   = useState(false);
  const [zoomStudent, setZoomStudent]     = useState<any|null>(null);
  const [zoomSrc, setZoomSrc]             = useState<string|null>(null);
  const [shareData, setShareData]         = useState<{
    morningRec: Record<number, AttRec>;
    eveningRec:  Record<number, AttRec>;
    sessions: string[];
  } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showAllConfirm,   setShowAllConfirm]   = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setIsLoaded(false);
    try {
      // Read fresh each time — not from stale closure
      const freshRestricted = isDataRestricted();
      const freshLinkedIds  = getLinkedStudentIds();
      const allRows = showInactive ? await getAllStudentsInclInactive() : await getActiveStudents();
      let studentRows = allRows;
      if (freshRestricted) {
        if (freshLinkedIds.length > 0) {
          studentRows = allRows.filter((s: any) => freshLinkedIds.includes(Number(s.id)));
        } else {
          studentRows = [];
        }
      }
      studentRows.sort((a: any, b: any) => {
        const an = a.regno ? parseInt(a.regno) : null;
        const bn = b.regno ? parseInt(b.regno) : null;
        if (an === null && bn === null) return 0;
        if (an === null) return 1;
        if (bn === null) return -1;
        return an - bn;
      });
      setStudents(studentRows);
      const map = await getAttendanceMapWithSync(date, selectedSession);
      setAttMap(map);
    } catch (e) { console.error('AttendanceLoad', e); }
    finally { setIsLoaded(true); }
  }, [date, selectedSession, showInactive]);

  useEffect(() => { loadData(); }, [loadData]);

  // Re-load when permissions arrive from background ping
  useEffect(() => {
    const onPermsChanged = () => loadData();
    window.addEventListener('permissions-changed', onPermsChanged);
    return () => window.removeEventListener('permissions-changed', onPermsChanged);
  }, [loadData]);

  const handleDateChange = (val: string) => {
    if (val > todayStr || val < minStr) return;
    setDate(val);
  };

  // ── Derived counts ────────────────────────────────────────────────────────
  const presentCount = useMemo(() =>
    students.filter(s => !!attMap[s.id]?.present).length,
  [students, attMap]);

  const syncedCount = useMemo(() =>
    students.filter(s => !!attMap[s.id]?.synced).length,
  [students, attMap]);

  const unsyncedCount = useMemo(() =>
    students.filter(s => attMap[s.id] !== undefined && !attMap[s.id].synced).length,
  [students, attMap]);

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filteredStudents = useMemo(() => {
    let list = students.filter(s =>
      matchesStudentSearch(s, searchQuery)
    );
    if (showPresentOnly) {
      list = list.filter(s => !!attMap[s.id]?.present);
    } else if (searchQuery) {
      // When searching: hide already-marked present students to shorten the list
      // Coach only needs to find students NOT yet marked
      list = list.filter(s => !attMap[s.id]?.present);
    }
    return list;
  }, [searchQuery, students, attMap, showPresentOnly, showInactive]);

  const isFuture    = date > todayStr;
  const isTooOld    = date < minStr;
  const dateBlocked = isFuture || isTooOld;

  // ── Toggle — tap = mark Present. Tap again = remove (not absent). ────────────
  // We never store ABSENT explicitly — absence is inferred from missing records.
  const toggleAttendance = async (studentId: number) => {
    if (!can('attendance:take')) { setSaveStatus('🔒 Permission denied: attendance:take'); setTimeout(() => setSaveStatus(''), 3000); return; }
    if (dateBlocked) return;
    const rec = attMap[studentId];

    // Synced rows are locked
    if (rec?.synced) {
      setSaveStatus('⚠ Already synced — cannot change.');
      setTimeout(() => setSaveStatus(''), 2500);
      return;
    }

    if (rec?.present) {
      // Already present — remove the record (not mark absent)
      await deleteStudentAttendance(studentId, date, selectedSession);
      setAttMap(prev => { const n = {...prev}; delete n[studentId]; return n; });
    } else {
      // Not present — mark as present
      await upsertAttendance(studentId, date, selectedSession, true);
      setAttMap(prev => ({ ...prev, [studentId]: { present: true, synced: false } }));
      if (searchQuery) { setSearch(''); setTimeout(() => searchRef.current?.focus(), 50); }
    }
  };

  // ── Delete single student record — blocked if synced ─────────────────────
  const handleDeleteStudent = async (student: any) => {
    const rec = attMap[student.id];
    if (!rec) return; // nothing to delete
    if (rec.synced) {
      setSaveStatus(`⚠ ${student.name}'s record is synced — cannot delete.`);
      setTimeout(() => setSaveStatus(''), 3000);
      return;
    }
    const ok = await deleteStudentAttendance(student.id, date, selectedSession);
    if (ok) {
      setAttMap(prev => {
        const next = { ...prev };
        delete next[student.id];
        return next;
      });
    }
  };

  // ── Mark all present — skips synced rows ──────────────────────────────────
  const markAllPresent = async () => {
    if (dateBlocked) return;
    try {
      const updates: Record<number, AttRec> = { ...attMap };
      for (const s of students) {
        if (attMap[s.id]?.synced) continue; // skip synced rows
        await upsertAttendance(s.id, date, selectedSession, true);
        updates[s.id] = { present: true, synced: false };
      }
      setAttMap(updates);
      const skipped = students.filter(s => attMap[s.id]?.synced).length;
      setSaveStatus(`All marked present${skipped > 0 ? ` (${skipped} synced rows skipped)` : ''}`);
      setTimeout(() => setSaveStatus(''), 2500);
    } catch (e) { console.error('MarkAll failed', e); }
  };

  // ── Clear session — only unsynced rows ────────────────────────────────────
  const handleClearSession = async () => {
    setShowClearConfirm(false);
    const { deleted, blockedCount } = await deleteAttendanceSession(date, selectedSession);
    // Reload from DB to get accurate state
    const map = await getAttendanceMapWithSync(date, selectedSession);
    setAttMap(map);
    if (blockedCount > 0) {
      setSaveStatus(`${blockedCount} synced record(s) kept · unsynced records cleared`);
    } else {
      setSaveStatus('Session cleared from local DB');
    }
    setTimeout(() => setSaveStatus(''), 3000);
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const autoSync = async (): Promise<string> => {
    try {
      const serverIp = localStorage.getItem('server_ip') || '';
      if (!serverIp) return 'offline';
      const base = serverIp.trim().replace(/\/+$/, '');
      const baseUrl = base.startsWith('http') ? base : `http://${base}`;
      const unsync = await getUnsyncedAttendance();
      if (unsync.length === 0) return 'nothing';
      const payload = unsync.map((rec: any) => ({
        student_id: rec.student_id,
        date:       rec.attendance_date,
        session:    rec.session_type,
        status:     rec.status === 1 ? 'PRESENT' : 'ABSENT',
      }));
      const r = await fetch(`${baseUrl}/api/data/upload/attendance`, {
        method: 'POST',
        headers: (()=>{const _j=localStorage.getItem('jwt_token'),_e=parseInt(localStorage.getItem('jwt_expiry')||'0');if(_j&&Date.now()<_e-60000)return{'Content-Type':'application/json','Authorization':'Bearer '+_j,'X-Username':localStorage.getItem('auth_user')||''};return{'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};})(),
        body: JSON.stringify({ temp_attendance: payload }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return 'failed';
      const ids = unsync.map((rec: any) => rec.session_id);
      await markAttendanceSynced(ids);
      return `synced:${unsync.length}`;
    } catch {
      return 'offline';
    }
  };

  const handleSave = async () => {
    if (!can('attendance:upload')) { setSaveStatus('🔒 Your role cannot upload attendance'); return; }
    try {
      setSaveStatus('Saving…');
      const map = await getAttendanceMapWithSync(date, selectedSession);
      setAttMap(map);
      const present = Object.values(map).filter(r => r.present).length;
      setSaveStatus(`Saved! ${present} present · ${students.length - present} absent`);
      // Auto-sync if online
      const syncResult = await autoSync();
      if (syncResult.startsWith('synced:')) {
        const n = syncResult.split(':')[1];
        setSaveStatus(`✓ Saved & synced ${n} record${n==='1'?'':'s'} to server`);
      } else if (syncResult === 'offline' || syncResult === 'failed') {
        setSaveStatus(`Saved locally · ${present} present (sync pending)`);
      }
      setTimeout(() => setSaveStatus(''), 5000);
    } catch { setSaveStatus('Save failed.'); }
  };

  // ── Photo zoom ────────────────────────────────────────────────────────────
  const handlePhotoTap = async (student: any) => {
    const src = await getCachedImageUrl(student.profile_image ?? null);
    setZoomSrc(src);
    setZoomStudent(student);
  };

  // ── Share ─────────────────────────────────────────────────────────────────
  const handleShare = async (sessions: string[]) => {
    const [morningRec, eveningRec, nightRec] = await Promise.all([
      getAttendanceMapWithSync(date, 'Morning'),
      getAttendanceMapWithSync(date, 'Evening'),
      getAttendanceMapWithSync(date, 'Night'),
    ]);
    setShareData({ morningRec, eveningRec, nightRec, sessions });
  };

  if (!isLoaded) {
    return (
      <div style={{ display:'flex', justifyContent:'center', alignItems:'center', minHeight:'100vh', backgroundColor: C.bg }}>
        <div style={{ textAlign:'center', color: C.green }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🏏</div>
          <p style={{ fontWeight: 700 }}>Loading QCA Database…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', fontFamily: 'sans-serif', paddingBottom: 24 }}>

      {/* ── Header (pinned): date, session, live count, search ── */}
      <ScreenHeader
        title="Attendance"
        subtitle={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={date} min={minStr} max={todayStr}
              aria-label="Attendance date"
              onChange={e => handleDateChange(e.target.value)}
              style={{ color: C.gold, fontSize: 13, fontWeight: 700, border: 'none', background: 'transparent', outline: 'none', padding: 0, colorScheme: 'dark' }}
            />
            {date < todayStr && (
              <span style={{ fontSize: 10, backgroundColor: 'rgba(255,165,0,0.3)', color: '#ffd580', padding: '1px 7px', borderRadius: 10, fontWeight: 700 }}>Past date</span>
            )}
          </span>
        }
        actions={date !== todayStr ? (
          <button onClick={() => setDate(todayStr)} style={{ backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', height: 32, padding: '0 12px', marginRight: 6, borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Today</button>
        ) : undefined}>

        {/* Session segmented control */}
        <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.2)' }}>
          {SESSIONS.map(s => (
            <button key={s} onClick={() => setSession(s)} style={{
              flex: 1, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
              fontWeight: 800, fontSize: 13,
              backgroundColor: selectedSession === s ? '#fff' : 'transparent',
              color: selectedSession === s ? C.green : 'rgba(255,255,255,0.85)',
            }}>{s}</button>
          ))}
        </div>

        {/* Live count + sync state */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 12, fontWeight: 700, color: '#fff' }}>
          <span>✔ {presentCount} present</span>
          <span style={{ color: 'rgba(255,255,255,0.7)' }}>✗ {students.length - presentCount} absent</span>
          <div style={{ flex: 1, height: 5, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: students.length ? `${Math.round(presentCount/students.length*100)}%` : '0%', height: '100%', backgroundColor: C.gold, borderRadius: 3 }} />
          </div>
          {syncedCount > 0 && <span title="Synced" style={{ fontSize: 11, color: '#a8d4f5' }}>🔒 {syncedCount}</span>}
          {unsyncedCount > 0 && <span title="Pending upload" style={{ fontSize: 11, color: '#ffd580' }}>⬆ {unsyncedCount}</span>}
        </div>

        {/* Search + list controls */}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <HeaderSearch inputRef={searchRef} value={searchQuery} onChange={setSearch}
              placeholder={`Search ${students.length} students…`} />
          </div>
          <HeaderPill active={showPresentOnly} onClick={() => setShowPresent(p => !p)}>
            {showPresentOnly ? '✔ Present' : 'All'}
          </HeaderPill>
          {can('student:manage:inactive') && (
            <HeaderPill active={showInactive} onClick={() => setShowInactive((p:boolean) => !p)} title="Include inactive students">
              {showInactive ? '+Inactive' : 'Active'}
            </HeaderPill>
          )}
          {/* Mark All — only for users with attendance:take permission */}
          {canWrite && (
            <HeaderPill onClick={() => !dateBlocked && setShowAllConfirm(true)} disabled={dateBlocked} title="Mark all present">
              ✔✔ All
            </HeaderPill>
          )}
        </div>
      </ScreenHeader>

      {/* ── Viewer banner ── */}
      {!canWrite && (
        <div style={{ backgroundColor:'#fef3c7', padding:'10px 16px', margin:'10px 16px 0',
          borderRadius:8, borderLeft:'4px solid #f59e0b', fontSize:13, fontWeight:700, color:'#92400e',
          display:'flex', alignItems:'center', gap:8 }}>
          🔒 Viewer mode — attendance is read-only
        </div>
      )}

      {/* ── Date blocked warning ── */}
      {dateBlocked && (
        <div style={{ backgroundColor: '#fff3cd', padding: '12px 18px', borderLeft: '4px solid orange', margin: '12px 16px', borderRadius: 8 }}>
          <strong>⚠ {isFuture ? 'Future dates are not allowed.' : 'Only the last 7 days are available.'}</strong>
          <br /><span style={{ fontSize: 12 }}>Allowed window: {minStr} to {todayStr}</span>
        </div>
      )}

      {/* ── Student list — one card, hairline-separated rows ── */}
      <div style={{ padding: '8px 10px 0' }}>
        {filteredStudents.length === 0 && (
          <p style={{ textAlign: 'center', color: C.gray, marginTop: 30, fontSize: 14 }}>
            {students.length === 0 ? '👆 Sync students from the server first.' : 'No students match your search.'}
          </p>
        )}
        {filteredStudents.length > 0 && (
        <div style={{ backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)', opacity: dateBlocked ? 0.6 : 1 }}>
        {filteredStudents.map((item, i) => {
          const rec       = attMap[item.id];
          const isPresent = !!rec?.present;
          const isSynced  = !!rec?.synced;
          const hasRecord = rec !== undefined;

          return (
            <div key={item.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              minHeight: 54, padding: '7px 8px 7px 12px',
              borderTop: i ? `1px solid ${C.border}` : 'none',
              // Present = soft green tint; synced rows get a blue edge (locked)
              backgroundColor: isPresent ? '#e8f5e9' : '#fff',
              boxShadow: isSynced ? 'inset 3px 0 0 #2980b9' : isPresent ? `inset 3px 0 0 ${C.green}` : 'none',
              transition: 'background-color 0.15s',
            }}>
              {/* Photo → zoom */}
              <div onClick={() => handlePhotoTap(item)} style={{ cursor: 'pointer', flexShrink: 0 }}>
                <StudentPhoto student={item} size={38} />
              </div>

              {/* Name + level — tap to toggle (blocked if synced) */}
              <div style={{ flex: 1, minWidth: 0, cursor: isSynced || dateBlocked ? 'default' : 'pointer' }}
                onClick={() => !dateBlocked && toggleAttendance(item.id)}>
                <p style={{ fontSize: 14.5, fontWeight: 700, margin: 0, color: '#1f2937',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </p>
                <p style={{ fontSize: 11.5, margin: '2px 0 0', color: C.gray,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.qca_id ? `QCA-${String(item.qca_id).padStart(3,'0')}` : ''}{item.level ? ` · ${item.level}` : ''}
                  {isSynced && <span style={{ color: '#2980b9', fontWeight: 700 }}> · 🔒 synced</span>}
                </p>
              </div>

              {/* Delete button — only shown for unsynced records that have a value */}
              {hasRecord && !isSynced && (
                <button onClick={() => handleDeleteStudent(item)} title="Remove this record"
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    width: 36, height: 40, opacity: 0.55, fontSize: 15, color: C.red }}>
                  🗑
                </button>
              )}

              {/* Check circle — disabled if synced */}
              <button
                onClick={() => !dateBlocked && toggleAttendance(item.id)}
                disabled={dateBlocked || isSynced}
                aria-label={isPresent ? `${item.name} present — tap to remove` : `Mark ${item.name} present`}
                title={isSynced ? 'Synced' : isPresent ? 'Tap to remove' : 'Tap to mark present'}
                style={{ background: 'none', border: 'none', width: 44, height: 44, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: (dateBlocked || isSynced) ? 'not-allowed' : 'pointer', opacity: isSynced ? 0.55 : 1 }}
              >
                <span style={{
                  width: 30, height: 30, borderRadius: '50%',
                  backgroundColor: isPresent ? (isSynced ? '#2980b9' : C.green) : 'transparent',
                  border: isPresent ? 'none' : `2px solid ${isSynced ? '#2980b9' : '#9ca3af'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 17, fontWeight: 800,
                }}>
                  {isPresent ? '✓' : ''}
                </span>
              </button>
            </div>
          );
        })}
        </div>
        )}
      </div>

      {/* ── Action bar — normal page flow, not floating, so it can't
          overlap the bottom nav or cause accidental taps near it ── */}
      <div style={{
        backgroundColor: '#fff', borderTop: '1px solid #eee',
        padding: '14px 16px 20px', marginTop: 8,
        marginBottom: `calc(16px + ${NAV_CLEARANCE})`,
      }}>
        {saveStatus && (
          <div style={{ textAlign: 'center', color: saveStatus.startsWith('⚠') ? C.red : C.green, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            {saveStatus}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Share current session */}
          <button onClick={() => navigate('/media', { state:{ session_type: selectedSession, attendance_date: date } })} style={{ padding: '13px 10px', borderRadius: 12, border: '1.5px solid #8e44ad', backgroundColor: '#fff', color: '#8e44ad', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace:'nowrap' }}>
            📷
          </button>
          <button onClick={() => { if (!can('attendance:share')) { alert('Permission denied: attendance:share'); return; } handleShare([selectedSession]); }} style={{ flex: 1, padding: '13px 0', borderRadius: 12, border: `1.5px solid ${C.green}`, backgroundColor: '#fff', color: C.green, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            📋 {selectedSession}
          </button>
          {/* Share both */}
          <button onClick={() => { if (!can('attendance:share')) { alert('Permission denied: attendance:share'); return; } handleShare(['Morning','Evening']); }} style={{ flex: 1, padding: '13px 0', borderRadius: 12, border: `1.5px solid ${C.gold}`, backgroundColor: '#fff', color: C.gold, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            📋 M+E
          </button>
          <button onClick={() => { if (!can('attendance:share')) { alert('Permission denied: attendance:share'); return; } handleShare(['Morning','Evening','Night']); }} style={{ flex: 1, padding: '13px 0', borderRadius: 12, border: `1.5px solid ${C.gold}`, backgroundColor: '#fff', color: C.gold, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            📋 M+E+N
          </button>
          {/* Clear session */}
          <button onClick={() => { if (!can('attendance:delete')) { setSaveStatus('🔒 Permission denied: attendance:delete'); setTimeout(()=>setSaveStatus(''),3000); return; } setShowClearConfirm(true); }} disabled={dateBlocked || Object.keys(attMap).length === 0}
            style={{ padding: '13px 12px', borderRadius: 12, border: `1.5px solid ${C.red}`, backgroundColor: '#fff', color: C.red, fontWeight: 700, fontSize: 13, cursor: (dateBlocked || Object.keys(attMap).length === 0) ? 'not-allowed' : 'pointer', opacity: (dateBlocked || Object.keys(attMap).length === 0) ? 0.4 : 1 }}>
            🗑
          </button>
          {/* Save */}
          <button onClick={handleSave} disabled={dateBlocked} style={{ flex: 1, padding: '13px 0', borderRadius: 12, border: 'none', backgroundColor: dateBlocked ? '#ccc' : C.green, color: '#fff', fontWeight: 800, fontSize: 14, cursor: dateBlocked ? 'not-allowed' : 'pointer' }}>
            💾 Save
          </button>
        </div>
      </div>

      {/* ── Modals ── */}
      {zoomStudent && (
        <PhotoZoomModal student={zoomStudent} resolvedSrc={zoomSrc}
          onClose={() => { setZoomStudent(null); setZoomSrc(null); }} />
      )}
      {shareData && (
        <ShareTableModal date={date} students={students}
          morningRec={shareData.morningRec} eveningRec={shareData.eveningRec}
          nightRec={shareData.nightRec||{}}
          sessions={shareData.sessions} onClose={() => setShareData(null)} />
      )}
      {/* ── Mark all present confirmation ── */}
      {showAllConfirm && (
        <div onClick={() => setShowAllConfirm(false)} style={{
          position:'fixed', inset:0, zIndex:4000, backgroundColor:'rgba(0,0,0,0.6)',
          display:'flex', alignItems:'center', justifyContent:'center', padding:24,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            backgroundColor:'#fff', borderRadius:16, padding:24,
            width:'100%', maxWidth:340, boxShadow:'0 12px 40px rgba(0,0,0,0.35)',
          }}>
            <div style={{ fontSize:36, textAlign:'center', marginBottom:12 }}>✔✔</div>
            <div style={{ fontWeight:800, fontSize:17, color:'#222', textAlign:'center', marginBottom:8 }}>
              Mark all as Present?
            </div>
            <div style={{
              backgroundColor:'#fff3cd', border:'1px solid #ffc107',
              borderRadius:10, padding:'10px 14px', marginBottom:18, fontSize:13, color:'#856404',
            }}>
              This will mark <strong>all {students.filter(s => !attMap[s.id]?.synced).length} unsynced student{students.filter(s => !attMap[s.id]?.synced).length !== 1 ? 's' : ''}</strong> as present for <strong>{selectedSession}</strong> on <strong>{date}</strong>.
              {syncedCount > 0 && ` (${syncedCount} already-synced row${syncedCount>1?'s':''} will be skipped.)`}
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setShowAllConfirm(false)} style={{
                flex:1, padding:'12px 0', borderRadius:10,
                border:'1.5px solid #ddd', backgroundColor:'#fff',
                fontWeight:700, fontSize:14, cursor:'pointer', color:'#666',
              }}>Cancel</button>
              <button onClick={() => { if (!canWrite) return; setShowAllConfirm(false); markAllPresent(); }} style={{
                flex:1, padding:'12px 0', borderRadius:10, border:'none',
                backgroundColor: C.green, color:'#fff',
                fontWeight:700, fontSize:14, cursor:'pointer',
              }}>Yes, Mark All</button>
            </div>
          </div>
        </div>
      )}

      {showClearConfirm && (
        <ClearSessionModal
          date={date} session={selectedSession}
          syncedCount={syncedCount}
          onConfirm={handleClearSession}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
}
