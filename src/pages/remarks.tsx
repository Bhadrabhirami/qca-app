import React, { useState, useEffect } from 'react';
import StudentPhoto from '../shared/StudentPhoto';
import { matchesStudentSearch, formatRegno } from './studentUtils';
import { getAllStudents, getAttendanceForStudentLast7Days } from '../database/db';
import { usePermissions, isDataRestricted, getLinkedStudentIds } from './usePermissions';
import { useNavigate } from 'react-router-dom';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

// Fetch with timeout — prevents hanging requests
const fetchT = (url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> => {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
};



// ── constants ────────────────────────────────────────────────────────
const C = {
  green:  '#1a472a', gold:   '#c9a84c', navy:   '#0d1b2a',
  blue:   '#2563eb', orange: '#d97706', red:    '#dc2626',
  teal:   '#0d9488', gray:   '#6b7280', bg:     '#f0f4f0',
  border: '#d1d5db', muted:  '#9ca3af',
};

const REMARK_TYPES = ['TECHNICAL', 'TACTICAL', 'PHYSICAL', 'MENTAL', 'BATTING', 'BOWLING', 'FIELDING', 'MATCH_PERFORMANCE'];
const TYPE_LABELS: Record<string,string> = {
  TECHNICAL:'Technical', TACTICAL:'Tactical', PHYSICAL:'Physical', MENTAL:'Mental',
  BATTING:'Batting', BOWLING:'Bowling', FIELDING:'Fielding', MATCH_PERFORMANCE:'Match Perf',
};
const TYPE_COLORS: Record<string,string> = {
  TECHNICAL:C.navy, TACTICAL:C.blue, PHYSICAL:'#7c3aed', MENTAL:C.teal,
  BATTING:C.green, BOWLING:C.orange, FIELDING:'#0891b2', MATCH_PERFORMANCE:C.gold,
};

function buildBase(ip: string) {
  const u = (ip || '').trim().replace(/\/+$/, '');
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

// ── student search — same display as attendance page ─────────────────
function StudentSearch({ students, onSelect }: { students: any[]; onSelect: (s: any) => void }) {
  const [q,    setQ]    = useState('');
  const [open, setOpen] = useState(false);
  // Store onSelect in ref — calling it never triggers re-render of this component
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;

  const filtered = q.trim().length > 1
    ? students.filter(s => matchesStudentSearch(s, q.trim())).slice(0, 8)
    : [];

  const select = (s: any) => {
    setQ(s.name);
    setOpen(false);
    // Call via ref — does not cause this component to re-render
    onSelectRef.current(s);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onFocus={() => q.trim().length > 1 && setOpen(true)}
        placeholder="Name, QCA ID or r+Reg No…"
        style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
          border: `1px solid ${C.border}`, fontSize: 14, outline: 'none' }}
      />
      {open && filtered.length > 0 && (
        <div style={{ position: 'absolute', top: '105%', left: 0, right: 0,
          backgroundColor: '#fff', borderRadius: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)', zIndex: 100,
          maxHeight: 280, overflowY: 'auto', border: `1px solid ${C.border}` }}>
          {filtered.map(s => (
            <div key={s.id}
              onMouseDown={() => select(s)}
              style={{ display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
                cursor: 'pointer', backgroundColor: '#fff' }}>
              <StudentPhoto student={s} size={36} style={{borderRadius:8,flexShrink:0}}/>
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontWeight:800, fontSize:11, color:'#1a472a', minWidth:28 }}>{formatRegno(s.regno)}</span>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.navy }}>{s.name}</div>
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
                  {s.level ? s.level + ' · ' : ''}QCA-{s.id}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── remark card ──────────────────────────────────────────────────────
function RemarkCard({ r, onEdit, onDelete, canEdit=false, canDelete=false }: { r: any; onEdit?: (r: any) => void; onDelete?: (id: number) => void; canEdit?: boolean; canDelete?: boolean }) {
  const color = TYPE_COLORS[r.remark_type] || C.gray;
  const stars = r.rating ? '⭐'.repeat(Math.min(5, r.rating)) : '';
  return (
    <div style={{ backgroundColor: '#fff', borderRadius: 12, padding: '12px 14px', marginBottom: 10, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', borderLeft: `4px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: C.navy }}>{r.student_name}
            {r.is_private ? <span style={{ marginLeft: 6, fontSize: 10, color: C.muted }}>🔒</span> : null}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {r.remark_date} · {r.coach_name}
            {stars ? <span style={{ marginLeft: 6 }}>{stars}</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, backgroundColor: color + '22', color, borderRadius: 6, padding: '2px 7px' }}>
            {TYPE_LABELS[r.remark_type] || r.remark_type}
          </span>
          <button onClick={() => canEdit && onEdit(r)} style={{ opacity: canEdit ? 1 : 0.3, background: 'none', border: 'none', cursor: canEdit ? 'pointer' : 'default', fontSize: 16, padding: '0 2px' }}>✏️</button>
          <button onClick={() => canDelete && onDelete(r.id)} style={{ opacity: canDelete ? 1 : 0.3, background: 'none', border: 'none', cursor: canDelete ? 'pointer' : 'default', fontSize: 16, padding: '0 2px' }}>🗑️</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{r.remark}</div>
      {r.video_url ? <a href={r.video_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.blue, marginTop: 6, display: 'block' }}>🎥 Video clip</a> : null}
    </div>
  );
}

// ── main ─────────────────────────────────────────────────────────────
export default function RemarksScreen() {
  const navigate = useNavigate();
  const { can, roleLabel }  = usePermissions();
  const canWrite = can('remarks:add');
  const isAdmin  = can('remarks:delete:any');
  const authUser = localStorage.getItem('auth_user') || '';
  const restricted          = isDataRestricted();
  const linkedIds           = getLinkedStudentIds();
  const base = buildBase(localStorage.getItem('server_ip') || '');
  const H = hdrs();

  const [students, setStudents]   = useState<any[]>([]);
  const [remarks,  setRemarks]    = useState<any[]>([]);
  const [loading,  setLoading]    = useState(false);
  const [msg,      setMsg]        = useState('');
  const [tab,      setTab]        = useState<'feed'|'add'|'student'>('feed');

  // Add / edit form
  const [selStudent,  setSelStudent]  = useState<any>(null);
  const [remarkText,  setRemarkText]  = useState('');
  const [remarkType,  setRemarkType]  = useState('TECHNICAL');
  const [rating,      setRating]      = useState(0);
  const [isPrivate,   setIsPrivate]   = useState(false);
  const [videoUrl,    setVideoUrl]    = useState('');
  const [remarkDate,  setRemarkDate]  = useState(new Date().toISOString().split('T')[0]);
  const [editingId,   setEditingId]   = useState<number|null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number|null>(null);
  const [saving, setSaving] = useState(false);
  // Feed pagination
  const PAGE_SIZE = 15;
  const [feedPage,    setFeedPage]    = useState(1);
  const [feedTotal,   setFeedTotal]   = useState(0);
  const [feedHasMore, setFeedHasMore] = useState(false);
  const [feedSearch,  setFeedSearch]  = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // Student remarks pagination
  const [stuPage,    setStuPage]    = useState(1);
  const [stuHasMore, setStuHasMore] = useState(false);
  const [loadingMoreStu, setLoadingMoreStu] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle'|'saving'|'success'|'error'>('idle');

  // Student view
  const [viewStudent, setViewStudent] = useState<any>(null);
  const [stuRemarks,  setStuRemarks]  = useState<any[]>([]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const loadFeed = async (search = feedSearch, page = 1) => {
    if (page === 1) setLoading(true); else setLoadingMore(true);
    try {
      const q = search.trim();
      const url = `${base}/api/data/remarks?limit=${PAGE_SIZE}&offset=${(page-1)*PAGE_SIZE}${q ? '&search='+encodeURIComponent(q) : ''}`;
      const res = await fetchT(url, { headers: H });
      if (res.ok) {
        const j = await res.json();
        const rows = j.data || [];
        // Read fresh — not stale closure values
        const freshRestricted = isDataRestricted();
        const freshLinkedIds  = getLinkedStudentIds();
        const filtered = freshRestricted && freshLinkedIds.length
          ? rows.filter((r: any) => freshLinkedIds.includes(Number(r.student_id)))
          : rows;
        const total = freshRestricted ? filtered.length : (j.total ?? rows.length);
        setFeedTotal(total);
        setFeedHasMore(!freshRestricted && page * PAGE_SIZE < (j.total ?? rows.length));
        setFeedPage(page);
        if (page === 1) setRemarks(filtered);
        else setRemarks(prev => [...prev, ...filtered]);
      }
    } catch { /* offline */ }
    if (page === 1) setLoading(false); else setLoadingMore(false);
  };

  const loadMoreFeed = () => { if (!loadingMore && feedHasMore) loadFeed(feedSearch, feedPage + 1); };

  // Load students + feed — placed AFTER loadFeed definition to avoid hoisting crash
  useEffect(() => {
    const freshRestricted = isDataRestricted();
    if (!freshRestricted) {
      getAllStudents?.().then((s: any[]) => setStudents(s)).catch(() => {});
    }
    loadFeed();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-load when permissions arrive from background ping
  useEffect(() => {
    const onPermsChanged = () => {
      const freshRestricted = isDataRestricted();
      if (!freshRestricted) {
        getAllStudents?.().then((s: any[]) => setStudents(s)).catch(() => {});
      } else {
        setStudents([]);
      }
      loadFeed();
    };
    window.addEventListener('permissions-changed', onPermsChanged);
    return () => window.removeEventListener('permissions-changed', onPermsChanged);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFeedSearch = (v: string) => { setFeedSearch(v); setFeedPage(1); loadFeed(v, 1); };

  const loadStudentRemarks = async (student: any, page = 1) => {
    setViewStudent(student);
    setTab('student');
    if (page === 1) { setStuRemarks([]); setStuPage(1); }
    if (page === 1) setLoading(true); else setLoadingMoreStu(true);
    try {
      const url = `${base}/api/data/remarks?student_id=${student.id}&limit=${PAGE_SIZE}&offset=${(page-1)*PAGE_SIZE}`;
      const res = await fetchT(url, { headers: H });
      if (res.ok) {
        const j = await res.json();
        const rows = j.data || [];
        setStuHasMore(page * PAGE_SIZE < (j.total ?? rows.length));
        setStuPage(page);
        if (page === 1) setStuRemarks(rows); else setStuRemarks(prev => [...prev, ...rows]);
      }
    } catch {}
    if (page === 1) setLoading(false); else setLoadingMoreStu(false);
  };

  const loadMoreStu = () => {
    if (!loadingMoreStu && stuHasMore && viewStudent) loadStudentRemarks(viewStudent, stuPage + 1);
  };

  // Fetch attendance dates for selected student within 7-day window
  const [attendedDates, setAttendedDates] = useState<string[]>([]);
  const [loadingDates,  setLoadingDates]  = useState(false);

  const fetchAttendedDates = async (student: any) => {
    if (!student?.id) return;
    setLoadingDates(true);
    setAttendedDates([]);
    try {
      const today   = new Date();
      const from    = new Date(today); from.setDate(today.getDate() - 7);
      const fromStr = from.toISOString().split('T')[0];
      const toStr   = today.toISOString().split('T')[0];

      const dateSet = new Set<string>();

      // Source 1: Local attendance table (synced + unsynced coach marks)
      try {
        const localRows = await getAttendanceForStudentLast7Days(student.id);
        localRows.forEach((r: any) => {
          if (r.attendance_date >= fromStr && r.attendance_date <= toStr) {
            dateSet.add(r.attendance_date);
          }
        });
      } catch { /* db not ready */ }

      // Source 2: Server hager endpoint — catches any server-only data
      try {
        const res = await fetchT(
          `${base}/api/data/hager?student_id=${student.id}&since_date=${fromStr}`,
          { headers: H }
        );
        if (res.ok) {
          const j = await res.json();
          (j.data || []).forEach((r: any) => {
            const d = r.attendance_date || r.date || '';
            const s = String(r.status || '').toLowerCase();
            const isPresent = s === 'present' || s === '1' || s === 'true';
            if (d >= fromStr && d <= toStr && isPresent) dateSet.add(d);
          });
        }
      } catch { /* offline — local data is sufficient */ }

      const dates = Array.from(dateSet).sort().reverse(); // most recent first
      setAttendedDates(dates);
      if (dates.length > 0 && !editingId) setRemarkDate(dates[0]);
    } catch { /* ignore */ }
    setLoadingDates(false);
  };

  // Stable select handlers — defined with useRef so identity never changes
  // Student selection handlers — simple direct calls
  const handleSelectForAdd  = (s: any) => { setSelStudent(s); fetchAttendedDates(s); };
  const handleSelectForView = (s: any) => { loadStudentRemarks(s); };

  const submitRemark = async () => {
    if (!can('remarks:add') && !editingId) { flash('🔒 Permission denied: remarks:add'); return; }
    if (!selStudent) { flash('⚠ Select a student first'); return; }
    if (!remarkText.trim()) { flash('⚠ Enter remark text'); return; }
    if (!editingId) {
      const today  = new Date(); today.setHours(0,0,0,0);
      const picked = new Date(remarkDate); picked.setHours(0,0,0,0);
      if (picked.getTime() > today.getTime()) {
        flash('⚠ Cannot add remarks for a future date');
        return;
      }
    }
    setSaving(true); setSaveStatus('saving');
    try {
      const url    = editingId ? `${base}/api/data/remarks/${editingId}` : `${base}/api/data/remarks`;
      const method = editingId ? 'PUT' : 'POST';
      const res    = await fetchT(url, {
        method, headers: H,
        body: JSON.stringify({
          student_id: selStudent.id, remark: remarkText.trim(),
          remark_type: remarkType, remark_date: remarkDate,
          rating, is_private: isPrivate, video_url: videoUrl,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSaveStatus('success');
      // Brief success display then clear form
      setTimeout(() => {
        setSaving(false); setSaveStatus('idle');
        setRemarkText(''); setEditingId(null); setSelStudent(null);
        setRemarkType('TECHNICAL'); setRemarkDate(new Date().toISOString().split('T')[0]);
        setRating(0); setIsPrivate(false); setVideoUrl(''); setAttendedDates([]);
        loadFeed();
        setTab('feed');
      }, 1500);
    } catch (e: any) {
      setSaveStatus('error');
      flash(`⚠ Failed to save: ${e.message || 'Check connection'}`);
      setSaving(false);
      setTimeout(() => setSaveStatus('idle'), 4000);
    }
  };

  const startEdit = (r: any) => {
    setSelStudent({ id: r.student_id, name: r.student_name });
    setRemarkText(r.remark);
    setRemarkType(r.remark_type || 'TECHNICAL');
    setRemarkDate(r.remark_date);
    setRating(r.rating || 0);
    setIsPrivate(!!r.is_private);
    setVideoUrl(r.video_url || '');
    setEditingId(r.id);
    setTab('add');
  };

  const deleteRemark = async (id: number) => {
    setConfirmDeleteId(id);
  };
  const confirmDelete = async () => {
    const id = confirmDeleteId; if (!id) return; setConfirmDeleteId(null);
    try {
      const res = await fetchT(`${base}/api/data/remarks/${id}`, { method: 'DELETE', headers: H });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      flash('✔ Deleted');
      setRemarks(prev => prev.filter(r => r.id !== id));
      setStuRemarks(prev => prev.filter(r => r.id !== id));
    } catch (e: any) { flash(`⚠ ${e.message}`); }
  };

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'sans-serif' }}>
      <ScreenHeader title="📝 Coach Remarks" subtitle="Add & view player feedback" background={C.navy}>
        <HeaderTabs color={C.navy} value={tab as string} onChange={k => setTab(k as any)}
          tabs={([['feed','📋 Feed'], ...(can('remarks:add') ? [['add', editingId ? '✏️ Edit' : '➕ Add'] as [string,string]] : []), ...(!restricted ? [['student','👤 By Student'] as [string,string]] : [])] as [string,string][]).map(([id, label]) => ({ id, label }))} />
      </ScreenHeader>

      {msg && (
        <div style={{ margin: '10px 16px 0', padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600,
          backgroundColor: msg.startsWith('✔') ? '#e8f5e9' : '#fdecea',
          color: msg.startsWith('✔') ? '#27ae60' : C.red }}>
          {msg}
        </div>
      )}

      <div style={{ padding: '14px 16px 80px' }}>

        {/* ── Feed tab ─────────────────────────────────────────── */}
        {tab === 'feed' && (
          <>
            {/* Search bar */}
            <div style={{ display:'flex', gap:8, marginBottom:10 }}>
              <input
                value={feedSearch}
                onChange={e => handleFeedSearch(e.target.value)}
                placeholder="Search remarks…"
                style={{ flex:1, padding:'9px 12px', borderRadius:10,
                  border:`1px solid ${C.border}`, fontSize:13, outline:'none' }}
              />
              <button onClick={() => loadFeed(feedSearch, 1)}
                style={{ padding:'9px 12px', borderRadius:10, border:'none',
                  backgroundColor:C.green, color:'#fff', fontWeight:700, fontSize:12, cursor:'pointer' }}>
                🔄
              </button>
            </div>

            {/* Count */}
            {!loading && feedTotal > 0 && (
              <div style={{ fontSize:11, color:C.muted, marginBottom:8, paddingLeft:2 }}>
                Showing {remarks.length} of {feedTotal} remarks
                {feedSearch && <span> · filtered by "{feedSearch}"</span>}
              </div>
            )}

            {loading && (
              <div style={{ textAlign:'center', padding:30, color:C.muted }}>
                <div style={{ fontSize:24, marginBottom:8 }}>⏳</div>Loading remarks…
              </div>
            )}
            {restricted && linkedIds.length === 0 && (
              <div style={{ padding: '12px 14px', borderRadius: 12, margin: '8px 0',
                backgroundColor: '#fef3c7', border: '1px solid #fcd34d' }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: '#92400e' }}>⚠ Account not linked</div>
                <div style={{ fontSize: 12, color: '#92400e', marginTop: 4 }}>
                  Your account is not linked to a student record. Contact the academy admin.
                </div>
              </div>
            )}

            {!loading && remarks.length === 0 && (
              <div style={{ textAlign:'center', padding:40, color:C.muted }}>
                <div style={{ fontSize:40, marginBottom:10 }}>📝</div>
                <div style={{ fontWeight:700 }}>
                  {feedSearch ? `No remarks matching "${feedSearch}"` : 'No remarks yet'}
                </div>
                <div style={{ fontSize:12, marginTop:4 }}>
                  {feedSearch ? 'Try a different search' : 'Tap ➕ Add to write the first one'}
                </div>
              </div>
            )}

            {remarks.map(r => (
              <RemarkCard key={r.id} r={r}
                canEdit={canWrite && (isAdmin || r.coach_name === authUser)}
                canDelete={canWrite && (isAdmin || r.coach_name === authUser)}
                onEdit={startEdit}
                onDelete={deleteRemark} />
            ))}

            {/* Load more */}
            {feedHasMore && (
              <button onClick={loadMoreFeed} disabled={loadingMore}
                style={{ width:'100%', padding:'12px', borderRadius:10, marginTop:8,
                  border:`1px solid ${C.border}`, backgroundColor:'#fff',
                  color:C.navy, fontWeight:700, fontSize:13, cursor:'pointer' }}>
                {loadingMore ? 'Loading…' : `Load more (${feedTotal - remarks.length} remaining)`}
              </button>
            )}
            {!feedHasMore && remarks.length >= PAGE_SIZE && (
              <div style={{ textAlign:'center', fontSize:11, color:C.muted, padding:'12px 0' }}>
                All {feedTotal} remarks loaded
              </div>
            )}
          </>
        )}

        {/* ── Add / Edit tab ────────────────────────────────────── */}
        {tab === 'add' && canWrite && (
          <div style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 2px 10px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 14 }}>
              {editingId ? '✏️ Edit Remark' : '➕ Add Remark'}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Student</div>
              <StudentSearch students={students} onSelect={handleSelectForAdd} />
              {selStudent && (
                <div style={{ marginTop: 6, padding: '6px 10px', backgroundColor: C.green + '15', borderRadius: 8, fontSize: 13, fontWeight: 700, color: C.green }}>
                  ✓ {selStudent.name}
                </div>
              )}
            </div>

            {/* Remark Type */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Type</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {REMARK_TYPES.map(t => {
                  const col = TYPE_COLORS[t];
                  return (
                    <button key={t} onClick={() => setRemarkType(t)}
                      style={{ padding: '5px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                        backgroundColor: remarkType === t ? col : '#f3f4f6',
                        color: remarkType === t ? '#fff' : C.gray }}>
                      {TYPE_LABELS[t]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Rating + Private */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Rating</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[1,2,3,4,5].map(n => (
                    <button key={n} onClick={() => setRating(rating === n ? 0 : n)}
                      style={{ fontSize: 22, background: 'none', border: 'none', cursor: 'pointer', opacity: n <= rating ? 1 : 0.3 }}>
                      ⭐
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <button onClick={() => setIsPrivate(v => !v)}
                  style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                    backgroundColor: isPrivate ? C.red + '22' : '#f3f4f6',
                    color: isPrivate ? C.red : C.gray }}>
                  {isPrivate ? '🔒 Private' : '🌐 Visible'}
                </button>
              </div>
            </div>

            {/* Video URL (optional) */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Video URL (optional)</div>
              <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)}
                placeholder="https://cloudinary.com/… or leave blank"
                style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 13 }} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                Session Date
                {!editingId && <span style={{ marginLeft: 8, fontSize: 10, color: C.muted, fontWeight: 400, textTransform: 'none' }}>
                  (last 7 days only · must have attended)
                </span>}
              </div>
              {loadingDates && <div style={{ fontSize: 12, color: C.muted, padding: '6px 0' }}>Loading attended sessions…</div>}
              {!loadingDates && attendedDates.length > 0 && !editingId && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: C.green, fontWeight: 700, marginBottom: 6 }}>✅ Attended sessions (last 7 days)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {attendedDates.map(d => (
                      <button key={d} onClick={() => setRemarkDate(d)}
                        style={{ padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                          backgroundColor: remarkDate === d ? C.green : '#e8f5e9',
                          color: remarkDate === d ? '#fff' : C.green }}>
                        {new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!loadingDates && attendedDates.length === 0 && selStudent && !editingId && (
                <div style={{ backgroundColor: '#fef3c7', borderRadius: 8, padding: '8px 12px', marginBottom: 8, fontSize: 12, color: '#92400e', fontWeight: 600 }}>
                  ⚠ No attended sessions found in the last 7 days for {selStudent.name}
                </div>
              )}
              {/* Fallback / edit: manual date picker */}
              {(editingId || attendedDates.length === 0) && (
                <input type="date" value={remarkDate} onChange={e => setRemarkDate(e.target.value)}
                  max={new Date().toISOString().split('T')[0]}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 14 }} />
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Remark</div>
              <textarea
                value={remarkText} onChange={e => setRemarkText(e.target.value)}
                rows={5} placeholder="Enter detailed coaching feedback…"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 14, resize: 'vertical', fontFamily: 'sans-serif' }}
              />
              <div style={{ fontSize: 11, color: C.muted, textAlign: 'right', marginTop: 4 }}>{remarkText.length} chars</div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              {/* Status banner — shows above buttons when saving/done/error */}
              {saveStatus !== 'idle' && (
                <div style={{ width:'100%', marginBottom: 10, padding: '12px 14px', borderRadius: 10,
                  display:'flex', alignItems:'center', gap: 10,
                  backgroundColor:
                    saveStatus==='saving' ? '#e0f2fe' :
                    saveStatus==='success'? '#dcfce7' : '#fee2e2',
                  border: `1px solid ${
                    saveStatus==='saving' ? '#93c5fd' :
                    saveStatus==='success'? '#86efac' : '#fca5a5'}` }}>
                  <span style={{ fontSize: 20 }}>
                    {saveStatus==='saving' ? '⏳' : saveStatus==='success' ? '✅' : '❌'}
                  </span>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 13,
                      color: saveStatus==='saving'?'#1d4ed8':saveStatus==='success'?'#166534':'#991b1b' }}>
                      {saveStatus==='saving'
                        ? (editingId ? 'Updating remark on server…' : 'Saving remark to server…')
                        : saveStatus==='success'
                        ? (editingId ? 'Remark updated successfully ✓' : 'Remark saved to server ✓')
                        : 'Failed to save — not uploaded to server'}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      {saveStatus==='saving' ? 'Please wait…'
                        : saveStatus==='success' ? 'Redirecting to feed…'
                        : 'Check your connection and try again'}
                    </div>
                  </div>
                </div>
              )}
              <button onClick={submitRemark} disabled={saving}
                style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  backgroundColor: saving ? '#9ca3af' : C.green,
                  color: '#fff', fontWeight: 800, fontSize: 14,
                  cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving
                  ? (saveStatus==='success' ? '✅ Saved!' : '⏳ Saving…')
                  : (editingId ? '✔ Update Remark' : '✔ Save Remark')}
              </button>
              <button
                onClick={() => {
                  setEditingId(null); setRemarkText(''); setSelStudent(null);
                  setRemarkType('TECHNICAL'); setRating(0); setIsPrivate(false);
                  setVideoUrl(''); setAttendedDates([]);
                  setRemarkDate(new Date().toISOString().split('T')[0]);
                  setTab('feed');
                }}
                style={{ padding: '12px 16px', borderRadius: 10, border: `1px solid ${C.border}`,
                  backgroundColor: '#fff', color: C.gray, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                ✕ Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── By Student tab ────────────────────────────────────── */}
        {tab === 'student' && (
          <>
            <div style={{ marginBottom: 12 }}>
              <StudentSearch students={students} onSelect={handleSelectForView} />
            </div>

            {/* No student selected */}
            {!viewStudent && (
              <div style={{ textAlign:'center', padding:40, color:C.muted }}>
                <div style={{ fontSize:36, marginBottom:10 }}>👤</div>
                <div style={{ fontWeight:700 }}>Search for a student above</div>
                <div style={{ fontSize:12, marginTop:4 }}>View all remarks by player</div>
              </div>
            )}

            {/* Student selected */}
            {viewStudent && (
              <>
                {/* Student header bar */}
                <div style={{ backgroundColor:C.navy, borderRadius:12, padding:'10px 14px',
                  marginBottom:12, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div>
                    <div style={{ color:'#fff', fontWeight:800 }}>{viewStudent.name}</div>
                    <div style={{ color:'rgba(255,255,255,0.55)', fontSize:11, marginTop:2 }}>
                      {stuRemarks.length} remark{stuRemarks.length !== 1 ? 's' : ''}
                      {stuHasMore ? '+' : ''} loaded
                    </div>
                  </div>
                  <button onClick={() => { setSelStudent(viewStudent); setTab('add'); }}
                    style={{ padding:'6px 12px', borderRadius:8, border:'none',
                      backgroundColor:C.gold, color:C.navy, fontWeight:700, fontSize:12, cursor:'pointer' }}>
                    + Add Remark
                  </button>
                </div>

                {/* Loading first page */}
                {loading && (
                  <div style={{ textAlign:'center', padding:30, color:C.muted }}>⏳ Loading…</div>
                )}

                {/* Empty */}
                {!loading && stuRemarks.length === 0 && (
                  <div style={{ textAlign:'center', padding:30, color:C.muted }}>
                    No remarks yet for {viewStudent.name}
                  </div>
                )}

                {/* Remarks list */}
                {stuRemarks.map(r => (
                  <RemarkCard key={r.id} r={r}
                canEdit={canWrite && (isAdmin || r.coach_name === authUser)}
                canDelete={canWrite && (isAdmin || r.coach_name === authUser)}
                onEdit={startEdit}
                onDelete={deleteRemark} />
                ))}

                {/* Load more */}
                {stuHasMore && (
                  <button onClick={loadMoreStu} disabled={loadingMoreStu}
                    style={{ width:'100%', padding:'12px', borderRadius:10, marginTop:8,
                      border:`1px solid ${C.border}`, backgroundColor:'#fff',
                      color:C.navy, fontWeight:700, fontSize:13, cursor:'pointer' }}>
                    {loadingMoreStu ? 'Loading…' : 'Load more remarks'}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDeleteId && (
        <div style={{position:'fixed',inset:0,backgroundColor:'rgba(0,0,0,0.6)',
          zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div style={{backgroundColor:'#fff',borderRadius:16,padding:24,maxWidth:320,width:'100%',
            boxShadow:'0 8px 40px rgba(0,0,0,0.3)'}}>
            <div style={{fontWeight:800,fontSize:16,color:C.navy,marginBottom:8}}>Delete Remark?</div>
            <div style={{fontSize:13,color:C.muted,marginBottom:20}}>
              This remark will be permanently removed from the server. This cannot be undone.
            </div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={confirmDelete}
                style={{flex:1,padding:'12px',borderRadius:10,border:'none',
                  backgroundColor:'#dc2626',color:'#fff',fontWeight:800,fontSize:14,cursor:'pointer'}}>
                🗑 Delete
              </button>
              <button onClick={()=>setConfirmDeleteId(null)}
                style={{flex:1,padding:'12px',borderRadius:10,
                  border:'1px solid #d1d5db',backgroundColor:'#fff',
                  color:'#374151',fontWeight:700,fontSize:14,cursor:'pointer'}}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
