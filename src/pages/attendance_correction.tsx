/**
 * attendance_correction.tsx — Attendance Correction Page
 * Admin/Coach with attendance:delete permission only.
 * Select date + session → Load from server → Mark wrong records → Delete.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import { deleteLocalAttendance, markSessionForResync } from '../database/db';
import ScreenHeader from '../shared/ScreenHeader';
import StudentPhoto from '../shared/StudentPhoto';
import { fmtRegNo } from './studentUtils';

const C = {
  navy:'#0d1b2a', gold:'#c5a059', bg:'#f0f2f5', card:'#fff',
  red:'#dc2626', green:'#166534', muted:'#6b7280', border:'#e5e7eb',
};

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
export default function AttendanceCorrectionScreen() {
  const navigate   = useNavigate();
  const { can }    = usePermissions();
  const base       = localStorage.getItem('server_ip') || '';
  const isAdmin    = (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';

  // Non-admin: last 7 days only. Admin: unrestricted.
  const today      = new Date().toISOString().split('T')[0];
  const sevenAgo   = (() => {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return d.toISOString().split('T')[0];
  })();
  const minDate    = isAdmin ? undefined : sevenAgo;

  const [date,       setDate]       = useState(today);
  const [session,    setSession]    = useState('Morning');
  const [students,   setStudents]   = useState<any[]>([]);
  const [marked,     setMarked]     = useState<Set<number>>(new Set());
  const [loading,    setLoading]    = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [msg,        setMsg]        = useState('');
  const [loaded,     setLoaded]     = useState(false);
  const [resyncing,  setResyncing]  = useState(false);
  const [resyncConfirm, setResyncConfirm] = useState(false);

  if (!can('attendance:delete')) {
    return (
      <div style={{ padding:40, textAlign:'center' as const, color:C.red }}>
        🔒 Admin or Senior Coach access required
      </div>
    );
  }

  const loadFromServer = async () => {
    setLoading(true); setMsg(''); setStudents([]); setMarked(new Set()); setLoaded(false);
    try {
      // Detect column names
      const r = await fetch(
        `${base}/api/data/attendance?date_from=${date}&date_to=${date}&session=${encodeURIComponent(session)}&limit=500`,
        { headers: hdr() }
      );
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const j = await r.json();

      // Get student names
      const studentIds = [...new Set((j.data || []).map((a: any) => a.student_id))] as number[];
      if (!studentIds.length) {
        setMsg('No attendance records found for this session.');
        setLoaded(true);
        setLoading(false);
        return;
      }

      // Fetch student names from local or server
      const sr = await fetch(`${base}/api/data/students`, { headers: hdr() });
      const sj = await sr.json();
      const byId: Record<number, any> = {};
      (sj.data || sj.students || []).forEach((s: any) => { byId[s.id] = s; });

      const rows = (j.data || []).map((a: any) => {
        const st = byId[a.student_id] || {};
        return {
          ...a,
          student_name:  st.name || `Student #${a.student_id}`,
          regno:         st.regno, qca_id: st.qca_id, profile_image: st.profile_image,
        };
      }).sort((x: any, y: any) => (parseInt(x.regno) || 9999) - (parseInt(y.regno) || 9999));

      setStudents(rows);
      setLoaded(true);
      setMsg('');
    } catch(e: any) {
      setMsg('⚠ ' + e.message);
    }
    setLoading(false);
  };

  const toggle = (id: number) => {
    setMarked(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  const handleDelete = async () => {
    if (!marked.size) return;
    setDeleting(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/attendance/delete-records`, {
        method: 'POST',
        headers: hdr(),
        body: JSON.stringify({
          date, session,
          student_ids: [...marked],
        }),
      });
      const j = await r.json();
      if (j.status === 'success') {
        setMsg(`✅ ${j.deleted} record(s) deleted`);
        // Clean local cache so the deletion is reflected immediately —
        // without this, the same (now-deleted) record stays in local
        // attendance/hist_attendance until a Full Refresh is run.
        try {
          await deleteLocalAttendance(date, session, [...marked]);
        } catch (e) {
          console.warn('[AttCorrection] local cleanup failed:', e);
        }
        setStudents(prev => prev.filter(s => !marked.has(s.student_id)));
        setMarked(new Set());
        setConfirming(false);
      } else {
        setMsg('⚠ ' + (j.error || 'Failed'));
      }
    } catch(e: any) {
      setMsg('⚠ ' + e.message);
    }
    setDeleting(false);
  };

  // RECOVERY: marks every LOCAL record for this date+session as unsynced,
  // so "Upload Attendance" (Sync screen) re-sends the whole session. Use
  // this if the server is missing records that this device previously
  // uploaded (e.g. wiped by a partial re-upload — fixed server-side, but
  // already-lost records need a manual re-push to come back).
  const handleResync = async () => {
    setResyncing(true); setMsg('');
    try {
      const n = await markSessionForResync(date, session);
      if (n > 0) {
        setMsg(`✅ Marked ${n} local record(s) for ${session} — ${dateLabel} for re-upload. `
             + `Go to Sync → Upload Attendance to push them now.`);
      } else {
        setMsg('⚠ No local records found for this date+session on this device — '
             + 'nothing to re-upload from here. Try the device that originally captured this session.');
      }
      setResyncConfirm(false);
    } catch(e: any) {
      setMsg('⚠ ' + e.message);
    }
    setResyncing(false);
  };

  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday:'short', day:'numeric', month:'short', year:'numeric',
  });

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh', fontFamily:"'DM Sans','Segoe UI',sans-serif", paddingBottom:40 }}>

      <ScreenHeader title="Attendance Correction" background={C.navy}
        subtitle={<span style={{ color:C.gold, fontWeight:700, letterSpacing:'1px', fontSize:10 }}>ADMIN / SENIOR COACH ONLY</span>} />

      <div style={{ padding:'10px' }}>

        {/* Warning */}
        <div style={{ padding:'7px 10px', borderRadius:9, marginBottom:8,
          backgroundColor:'#fffbeb', border:'1px solid #fcd34d',
          fontSize:11.5, color:'#92400e', fontWeight:600, lineHeight:1.4 }}>
          ⚠ Deletions are permanent and logged with your username — only fix wrong marks.
        </div>

        {/* Date + session */}
        <div style={{ backgroundColor:C.card, borderRadius:12, padding:'8px',
          border:`1px solid ${C.border}`, marginBottom:8 }}>
          <input type="date" value={date} aria-label="Date"
            onChange={e => {
              const v = e.target.value;
              if (minDate && v < minDate) {
                setMsg('⚠ Corrections allowed for last 7 days only');
                return;
              }
              setMsg(''); setDate(v); setLoaded(false); setStudents([]);
            }}
            min={minDate}
            max={today}
            style={{ width:'100%', padding:'8px 10px', borderRadius:8,
              border:`1px solid ${C.border}`, fontSize:14, outline:'none',
              boxSizing:'border-box' as const }} />
          <div style={{ display:'flex', gap:4, marginTop:6, padding:3, borderRadius:9, backgroundColor:'#f3f4f6' }}>
            {['Morning', 'Evening', 'Night'].map(s => (
              <button key={s} onClick={() => { setSession(s); setLoaded(false); setStudents([]); }}
                style={{ flex:1, height:32, borderRadius:7, border:'none',
                  cursor:'pointer', fontWeight:700, fontSize:13,
                  backgroundColor: session === s ? C.navy : 'transparent',
                  color: session === s ? C.gold : C.muted }}>
                {s}
              </button>
            ))}
          </div>
          {!isAdmin && (
            <div style={{ fontSize:11, color:C.muted, marginTop:5 }}>
              ℹ Non-admin corrections limited to last 7 days.
            </div>
          )}
        </div>

        {/* Load button */}
        <button onClick={loadFromServer} disabled={loading}
          style={{ width:'100%', padding:'10px', borderRadius:10, border:'none',
            backgroundColor: loading ? '#9ca3af' : C.navy,
            color: C.gold, fontWeight:800, fontSize:13.5,
            cursor: loading ? 'not-allowed' : 'pointer', marginBottom:8 }}>
          {loading ? '⏳ Loading from server…' : `📋 Load ${session} — ${dateLabel}`}
        </button>

        {/* Recovery: re-upload this device's local data for this session.
            Use if the server is missing records this device already
            uploaded (e.g. a previous partial re-upload wiped them out). */}
        <details style={{ backgroundColor:C.card, borderRadius:12, padding:'8px 10px',
          border:`1px solid ${C.border}`, marginBottom:8 }}>
          <summary style={{ fontWeight:800, fontSize:12, color:C.navy, cursor:'pointer',
            textTransform:'uppercase' as const, letterSpacing:'0.5px' }}>
            🔄 Recovery <span style={{ textTransform:'none' as const, fontWeight:600, color:C.muted, letterSpacing:0 }}>· re-upload this device's data</span>
          </summary>
          <div style={{ fontSize:11, color:C.muted, margin:'8px 0', lineHeight:1.5 }}>
            If the server is showing fewer records than expected for{' '}
            {session} — {dateLabel} (e.g. after a partial re-upload), and{' '}
            <b>this is the device that originally captured the session</b>,
            you can mark all of this device's local records for that
            date+session as unsynced and re-upload them.
          </div>
          {!resyncConfirm ? (
            <button onClick={()=>setResyncConfirm(true)} disabled={resyncing}
              style={{ width:'100%', padding:'9px', borderRadius:9,
                border:`1px solid ${C.border}`, backgroundColor:'#fff7ed',
                color:'#92400e', fontWeight:700, fontSize:12.5, cursor:'pointer' }}>
              Mark {session} — {dateLabel} for Re-upload
            </button>
          ) : (
            <div style={{display:'flex', gap:8}}>
              <button onClick={handleResync} disabled={resyncing}
                style={{ flex:2, padding:'11px', borderRadius:9, border:'none',
                  backgroundColor: resyncing ? '#9ca3af' : '#f59e0b',
                  color:'#fff', fontWeight:800, fontSize:13,
                  cursor: resyncing ? 'not-allowed' : 'pointer' }}>
                {resyncing ? '⏳ Marking…' : 'Confirm — Mark for Re-upload'}
              </button>
              <button onClick={()=>setResyncConfirm(false)} disabled={resyncing}
                style={{ flex:1, padding:'11px', borderRadius:9,
                  border:`1px solid ${C.border}`, backgroundColor:C.card,
                  color:C.muted, fontWeight:700, fontSize:13, cursor:'pointer' }}>
                Cancel
              </button>
            </div>
          )}
        </details>

        {/* Message */}
        {msg && (
          <div style={{ padding:'8px 12px', borderRadius:9, marginBottom:8,
            backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
            color: msg.startsWith('✅') ? C.green : C.red,
            fontWeight:700, fontSize:13 }}>
            {msg}
          </div>
        )}

        {/* Student list */}
        {loaded && students.length > 0 && (
          <>
            <div style={{ fontWeight:800, fontSize:12.5, color:C.navy, margin:'0 2px 6px' }}>
              {students.length} student{students.length !== 1 ? 's' : ''} present
              {marked.size > 0 && (
                <span style={{ color:C.red, marginLeft:8 }}>
                  · {marked.size} marked for deletion
                </span>
              )}
            </div>

            <div style={{ backgroundColor:C.card, borderRadius:12,
              border:`1px solid ${C.border}`, overflow:'hidden', marginBottom:8 }}>
              {students.map((s, i) => {
                const isMarked = marked.has(s.student_id);
                return (
                  <div key={s.student_id} onClick={() => toggle(s.student_id)}
                    style={{ display:'flex', alignItems:'center', gap:10,
                      padding:'6px 12px', cursor:'pointer', minHeight:48,
                      borderBottom: i < students.length - 1 ? `1px solid ${C.border}` : 'none',
                      backgroundColor: isMarked ? '#fee2e2' : C.card }}>
                    {/* Checkbox */}
                    <div style={{ width:22, height:22, borderRadius:6, flexShrink:0,
                      border: `2px solid ${isMarked ? C.red : C.border}`,
                      backgroundColor: isMarked ? C.red : C.card,
                      display:'flex', alignItems:'center', justifyContent:'center' }}>
                      {isMarked && <span style={{ color:'#fff', fontSize:13, fontWeight:900 }}>✕</span>}
                    </div>
                    <StudentPhoto student={{ name: s.student_name, profile_image: s.profile_image }} size={32} />
                    {/* Name */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const,
                        color: isMarked ? C.red : C.navy }}>
                        {s.student_name}
                      </div>
                      <div style={{ fontSize:11, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>
                        <span style={{ fontWeight:700, color: isMarked ? C.red : C.green }}>{fmtRegNo(s.regno) || '—'}{s.qca_id ? ` · Q${String(s.qca_id).padStart(3,'0')}` : ''}</span>
                        {s.uploaded_by && ` · by ${s.uploaded_by}`}
                      </div>
                    </div>
                    {isMarked && (
                      <span style={{ fontSize:11, backgroundColor:'#fee2e2',
                        color:C.red, padding:'3px 8px', borderRadius:20, fontWeight:700 }}>
                        DELETE
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Select All / Clear */}
            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <button onClick={() => setMarked(new Set(students.map(s => s.student_id)))}
                style={{ flex:1, padding:'9px', borderRadius:8,
                  border:`1px solid ${C.red}`, backgroundColor:'#fee2e2',
                  color:C.red, fontWeight:700, fontSize:12, cursor:'pointer' }}>
                ☑ Select All ({students.length})
              </button>
              <button onClick={() => setMarked(new Set())}
                style={{ padding:'9px 14px', borderRadius:8,
                  border:`1px solid ${C.border}`, backgroundColor:C.card,
                  color:C.muted, fontWeight:700, fontSize:12, cursor:'pointer' }}>
                Clear
              </button>
            </div>

            {/* Delete confirm */}
            {marked.size > 0 && (
              confirming ? (
                <div style={{ backgroundColor:'#fee2e2', borderRadius:12, padding:'14px',
                  border:`1px solid #fca5a5` }}>
                  <div style={{ fontWeight:800, color:C.red, fontSize:14, marginBottom:8 }}>
                    Delete {marked.size} attendance record{marked.size !== 1 ? 's' : ''}?
                  </div>
                  <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>
                    Session: {session} · {dateLabel}. This cannot be undone.
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button onClick={() => setConfirming(false)}
                      style={{ flex:1, padding:'11px', borderRadius:8,
                        border:`1px solid ${C.border}`, backgroundColor:C.card,
                        cursor:'pointer', fontWeight:700 }}>
                      Cancel
                    </button>
                    <button onClick={handleDelete} disabled={deleting}
                      style={{ flex:2, padding:'11px', borderRadius:8, border:'none',
                        backgroundColor: deleting ? '#9ca3af' : C.red,
                        color:'#fff', fontWeight:800, cursor: deleting ? 'not-allowed' : 'pointer' }}>
                      {deleting ? '⏳ Deleting…' : `🗑 Confirm Delete (${marked.size})`}
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setConfirming(true)}
                  style={{ width:'100%', padding:'14px', borderRadius:10, border:'none',
                    backgroundColor:C.red, color:'#fff', fontWeight:900, fontSize:14,
                    cursor:'pointer', boxShadow:'0 4px 14px rgba(220,38,38,0.3)' }}>
                  🗑 Delete {marked.size} Record{marked.size !== 1 ? 's' : ''}
                </button>
              )
            )}
          </>
        )}

        {loaded && students.length === 0 && !msg && (
          <div style={{ textAlign:'center' as const, padding:40, color:C.muted }}>
            No attendance records for {session} · {dateLabel}
          </div>
        )}
      </div>
    </div>
  );
}
