import { matchesStudentSearch, formatRegno, fmtRegNo } from './studentUtils';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePullToRefresh } from './usePullToRefresh';
import { syncStudentsOnly } from './useSyncService';
import { useNavigate } from 'react-router-dom';
import { usePermissions, getLinkedStudentIds, isDataRestricted } from './usePermissions';
import { getAllStudents, getPaymentSummary, getStudentPayments } from '../database/db';
import StudentPhoto from '../shared/StudentPhoto';
import ScreenHeader, { HeaderIconButton, HeaderSearch } from '../shared/ScreenHeader';

const C = { green: '#1a472a', gold: '#d4af37', bg: '#f4f7f6', border: '#e8e8e8', gray: '#888', red: '#c0392b', orange: '#e67e22' };

const LEVEL_COLORS: Record<string, string> = {
  Beginner: '#3498db', Intermediate: '#e67e22', Advanced: '#27ae60',
  Elite: '#8e44ad', Recreational: '#16a085',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtMonth(raw: string | null | undefined): string {
  if (!raw) return '—';
  const s = raw.trim();
  if (/^\d{4}-\d{2}/.test(s)) { const [y,m]=s.split('-'); return `${MONTHS[parseInt(m)-1]} ${y}`; }
  const monYY = s.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (monYY) { const yy=parseInt(monYY[2]); const year=yy<50?2000+yy:1900+yy; const i=MONTHS.findIndex(mn=>mn.toLowerCase()===monYY[1].toLowerCase()); return i>=0?`${MONTHS[i]} ${year}`:s; }
  const monYYYY = s.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (monYYYY) { const i=MONTHS.findIndex(mn=>mn.toLowerCase()===monYYYY[1].toLowerCase()); return i>=0?`${MONTHS[i]} ${monYYYY[2]}`:s; }
  return s;
}
function fmtPaymentMonth(row: any): string {
  if (row?.billing_month_display) return row.billing_month_display;
  return fmtMonth(row?.billing_month);
}
function fmtAmt(n: number) { return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function dueColor(n: number) { return n >= 3 ? C.red : n >= 1 ? C.orange : '#27ae60'; }

// ─── Fee status badge (used in card list) ────────────────────────────────────
function FeeStatusBadge({ studentId }: { studentId: number }) {
  const [summary, setSummary] = useState<any|null|'loading'>('loading');
  useEffect(() => {
    getPaymentSummary(studentId).then(s => setSummary(s));
  }, [studentId]);

  if (summary === 'loading') return null;
  if (!summary) return null; // no payment data for this student

  if (summary.months_due_count === 0) {
    return (
      <span style={{ fontSize: 10, color: '#27ae60', fontWeight: 700 }}>✅ Paid</span>
    );
  }
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 10,
      backgroundColor: dueColor(summary.months_due_count) + '18',
      color: dueColor(summary.months_due_count),
      border: `1px solid ${dueColor(summary.months_due_count)}33`,
    }}>
      {summary.months_due_count} mo due
    </span>
  );
}

// ─── Detail modal with Payment tab ───────────────────────────────────────────
function StudentDetailModal({ student, onClose }: { student: any; onClose: () => void }) {
  const { can, canAny } = usePermissions();
  const navigate = useNavigate();
  // Own profile check — student can edit their own but not others
  const linkedIds = getLinkedStudentIds();
  const isOwn     = linkedIds.includes(Number(student.id));
  const role      = (localStorage.getItem('user_role') || '').toLowerCase();
  const isAdmin   = role === 'admin';
  const isCoach   = role === 'coach';
  // Admin always can edit; coach can edit; others need explicit permission
  const canEdit   = isAdmin || isCoach || can('student:edit') || can('student:edit:any') || (can('student:edit:own') && isOwn);
  const canFees   = can('student:view:fees') || can('payments:view');
  const [tab, setTab] = useState<'info'|'payments'>('info');
  const [zoomPhoto, setZoomPhoto] = useState(false);
  const [payments,  setPayments]  = useState<any[]>([]);
  const [summary,   setSummary]   = useState<any|null>(null);
  const [payLoaded, setPayLoaded] = useState(false);

  const loadPayments = useCallback(async () => {
    if (payLoaded) return;
    const [p, s] = await Promise.all([
      getStudentPayments(student.id),
      getPaymentSummary(student.id),
    ]);
    setPayments(p);
    setSummary(s);
    setPayLoaded(true);
  }, [student.id, payLoaded]);

  useEffect(() => {
    if (tab === 'payments') loadPayments();
  }, [tab, loadPayments]);

  const feePayments = useMemo(() =>
    payments.filter(p => [1,2,15,16].includes(p.fee_type_id))
  , [payments]);

  // Sensitive fields: admin/coach always see; own profile always see;
  // non-restricted users (members/viewers) see; restricted (student/parent) only own
  const canViewDetail = isAdmin || isCoach || isOwn || !isDataRestricted() || can('student:view:detail');
  // Age from DOB (the stored "age" column goes stale every birthday)
  const ageFromDob = (() => {
    const d = student.date_of_birth ? new Date(student.date_of_birth + 'T00:00:00') : null;
    if (!d || isNaN(d.getTime())) return null;
    const t = new Date();
    let a = t.getFullYear() - d.getFullYear();
    if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--;
    return a;
  })();
  const hidden = '🔒 Hidden';
  // Placeholder text typed into fields ("Not Available", "N/A"…) counts as empty
  const val = (v: any) => {
    const t = String(v ?? '').trim();
    return !t || /^(not available|n\/?a|na|nil|none|-+|—)$/i.test(t) ? null : t;
  };
  const tel  = (v: string) => <a href={`tel:${v.replace(/\s/g,'')}`} style={{ color: C.green, textDecoration: 'none' }}>{v}</a>;
  const mail = (v: string) => <a href={`mailto:${v}`} style={{ color: C.green, textDecoration: 'none', wordBreak: 'break-all' as const }}>{v}</a>;
  const contact = (v: any, kind?: 'tel'|'mail') =>
    !canViewDetail ? hidden : !val(v) ? null : kind === 'tel' ? tel(String(v)) : kind === 'mail' ? mail(String(v)) : v;

  // Reg no / QCA ID / level / status live in the header — not repeated here.
  // Rows with no value are skipped (except a few core ones) to keep it short.
  type Row = { label: string; value: React.ReactNode; always?: boolean };
  const sections: { title: string; rows: Row[] }[] = [
    { title: 'Personal', rows: [
      { label: 'Date of birth', value: student.date_of_birth
          ? `${student.date_of_birth}${ageFromDob != null ? ` · ${ageFromDob} yrs` : ''}` : null, always: true },
      { label: 'Gender',        value: val(student.gender) },
      { label: 'Blood group',   value: val(student.blood_group) },
      { label: 'Specialization',value: val(student.dominant_side) },
      { label: 'School',        value: [val(student.school_name), val(student.current_grade) && `Grade ${student.current_grade}`].filter(Boolean).join(' · ') || null },
    ]},
    { title: 'Contact', rows: [
      { label: 'Phone',         value: contact(student.phone, 'tel'), always: true },
      { label: 'Email',         value: contact(student.email, 'mail') },
      { label: 'Parent',        value: contact(student.parent_name || student.parent), always: true },
      { label: 'Parent phone',  value: contact(student.parent_phone, 'tel') },
      { label: 'Parent email',  value: contact(student.parent_email, 'mail') },
      { label: 'Emergency',     value: canViewDetail
          ? ([student.emergency_contact_name, student.emergency_contact_phone].filter(Boolean).length
              ? <>{student.emergency_contact_name}{student.emergency_contact_phone && <> · {tel(String(student.emergency_contact_phone))}</>}</>
              : null)
          : hidden },
      { label: 'Address',       value: contact(student.address) },
    ]},
    { title: 'Academy', rows: [
      { label: 'Admission',     value: [student.student_type, student.student_category].filter(Boolean).join(' · ') || null, always: true },
      { label: 'Enrolled',      value: student.enrollment_date, always: true },
      { label: 'Monthly fee',   value: student.monthly_fee ? fmtAmt(student.monthly_fee) : null, always: true },
      { label: 'Uniform size',  value: val(student.kit_size) },
      { label: 'Referred by',   value: val(student.referral_source) },
    ]},
    { title: 'Health', rows: [
      { label: 'Medical notes', value: val(student.medical_conditions) },
    ]},
  ].map(sec => ({ ...sec, rows: sec.rows.filter(r => r.always || (r.value != null && r.value !== '')) }))
   .filter(sec => sec.rows.length > 0);

  return (
    <div style={ms.overlay} onClick={onClose}>
      <div style={ms.sheet} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={ms.sheetHeader}>
          <div onClick={e => { e.stopPropagation(); if(student.profile_image) setZoomPhoto(true); }}
            style={{ cursor: student.profile_image ? 'zoom-in' : 'default' }}>
            <StudentPhoto student={student} size={60} style={{ border: '3px solid rgba(255,255,255,0.4)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={ms.bigName}>{student.name}</p>
            <p style={{ color: C.gold, fontWeight: 800, fontSize: 13, margin: '0 0 6px' }}>
              {[fmtRegNo(student.regno), student.qca_id ? `Q${String(student.qca_id).padStart(3,'0')}` : ''].filter(Boolean).join(' · ') || 'No reg no'}
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {student.level && <span style={{ ...ms.badge, backgroundColor: LEVEL_COLORS[student.level] || C.gray }}>{student.level}</span>}
              <span style={{ ...ms.badge, backgroundColor: student.status === 'Active' ? '#27ae60' : C.red }}>{student.status}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {canEdit && (
            <button onClick={() => navigate(`/student/${student.id}/edit`)}
              style={{ padding: '5px 12px', borderRadius: 8, border: 'none',
                backgroundColor: '#c9a84c', color: '#fff', fontWeight: 700,
                fontSize: 11, cursor: 'pointer' }}>
              ✏️ Edit
            </button>
            )}
            <button onClick={onClose} style={ms.closeX}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
          {([
            { key: 'info',     label: '📋 Details' },
            ...(canFees ? [{ key: 'payments', label: '💰 Fees' }] : []),
          ] as {key:string;label:string}[]).map(t => (
            <button key={t.key} onClick={() => setTab(t.key as any)} style={{
              flex: 1, padding: '12px 0', border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: 13, background: 'none',
              color: tab === t.key ? C.green : C.gray,
              borderBottom: tab === t.key ? `2px solid ${C.green}` : '2px solid transparent',
            }}>{t.label}</button>
          ))}
        </div>

        {/* Info tab */}
        {tab === 'info' && (
          <div style={{ padding: '6px 14px 24px' }}>
            {/* Unlinked warning for restricted users */}
            {isOwn === false && getLinkedStudentIds().length > 0 && (
              <div style={{ margin:'6px 0', padding:'8px 12px', borderRadius:10,
                backgroundColor:'#fef3c7', border:'1px solid #fcd34d', fontSize:12,
                fontWeight:700, color:'#92400e' }}>
                👁 Viewing another student's profile
              </div>
            )}
            {sections.map(sec => (
              <div key={sec.title} style={{ marginTop: 10 }}>
                <p style={ms.sectionTitle}>{sec.title}</p>
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                  {sec.rows.map((r, i) => (
                    <div key={r.label} style={{ display: 'flex', gap: 12, padding: '8px 12px',
                      borderTop: i ? `1px solid ${C.border}` : 'none',
                      backgroundColor: sec.title === 'Health' ? '#fff7ed' : '#fff' }}>
                      <span style={ms.rowLabel}>{r.label}</span>
                      <span style={ms.rowValue}>{r.value ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Payments tab — guarded by canFees */}
        {tab === 'payments' && canFees && (
          <div style={{ padding: '14px 16px 30px' }}>
            {!payLoaded ? (
              <div style={{ textAlign: 'center', padding: 30, color: C.gray }}>Loading…</div>
            ) : (
              <>
                {/* Summary strip */}
                {summary ? (
                  <div style={{
                    display: 'flex', gap: 0, backgroundColor: '#f8f9fa',
                    borderRadius: 12, overflow: 'hidden', marginBottom: 14,
                    border: `1px solid ${C.border}`,
                  }}>
                    {[
                      { label: 'Fee Paid',   value: fmtAmt(summary.total_paid),        color: '#27ae60' },
                      { label: 'Months Due', value: summary.months_due_count,            color: dueColor(summary.months_due_count) },
                      { label: 'Last Paid',  value: summary.last_payment_date ? fmtMonth(summary.last_payment_date.slice(0,7)) : 'Never', color: C.gray },
                    ].map((s, i) => (
                      <div key={i} style={{
                        flex: 1, padding: '12px 8px', textAlign: 'center',
                        borderRight: i < 2 ? `1px solid ${C.border}` : 'none',
                      }}>
                        <div style={{ fontSize: 16, fontWeight: 900, color: s.color }}>{s.value}</div>
                        <div style={{ fontSize: 10, color: C.gray, fontWeight: 700, marginTop: 2 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', color: C.gray, padding: '20px 0', fontSize: 13 }}>
                    No payment data — sync Payments & Fees first
                  </div>
                )}

                {/* Due months */}
                {summary && summary.due_months.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.red, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                      Overdue Months
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {summary.due_months.map((ym: string) => (
                        <span key={ym} style={{
                          padding: '5px 11px', borderRadius: 20,
                          backgroundColor: '#fdecea', color: C.red,
                          fontSize: 12, fontWeight: 700, border: `1px solid ${C.red}33`,
                        }}>{fmtMonth(ym)}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Fee payment rows */}
                {feePayments.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                      Payment History
                    </div>
                    {feePayments.map((p, i) => (
                      <div key={p.id ?? i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '10px 0', borderBottom: i < feePayments.length-1 ? `1px solid ${C.border}` : 'none',
                      }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: '#222' }}>
                            {p.billing_month ? fmtPaymentMonth(p) : p.payment_date || '—'}
                          </div>
                          <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>
                            {p.fee_type_name || '—'} · {p.payment_mode || '—'}
                          </div>
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 15, color: '#27ae60' }}>
                          {fmtAmt(p.amount_paid || 0)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Photo zoom overlay */}
      {zoomPhoto && student.profile_image && (
        <div onClick={() => setZoomPhoto(false)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)',
            zIndex: 2000, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <button onClick={() => setZoomPhoto(false)}
            style={{ position: 'absolute', top: 16, right: 16, background: 'none',
              border: 'none', color: '#fff', fontSize: 28, cursor: 'pointer' }}>✕</button>
          <StudentPhoto student={student}
            size={Math.min(window.innerWidth - 40, window.innerHeight - 120)}
            style={{ borderRadius: 16, border: '3px solid rgba(255,255,255,0.3)',
              objectFit: 'cover', maxWidth: '100%', maxHeight: '80vh' }}/>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 12 }}>
            Tap anywhere to close
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function StudentsScreen() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const restricted = isDataRestricted();
  const linkedIds  = getLinkedStudentIds();
  const [students,     setStudents]     = useState<any[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [filterLevel,  setFilterLevel]  = useState('All');
  const [filterStatus, setStatus]       = useState('Active');
  const [selected,     setSelected]     = useState<any|null>(null);
  const [syncing,      setSyncing]      = useState(false);
  const [syncMsg,      setSyncMsg]      = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllStudents();
      const filtered = restricted && linkedIds.length
        ? all.filter((s: any) => linkedIds.includes(s.id))
        : all;
      setStudents(filtered);
    }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [restricted, linkedIds.join(',')]);

  // Sync from server then reload — used by both ↻ button and pull-to-refresh
  const handleRefresh = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const count = await syncStudentsOnly();
      setSyncMsg(count > 0 ? `↓ ${count} updated` : '✓ Up to date');
      await load();
    } catch {
      setSyncMsg('⚠ Sync failed');
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 3000);
    }
  }, [load]);

  useEffect(() => {
    // On mount: load local, then if empty auto-sync from server
    load().then(async () => {
      const localCount = (await getAllStudents()).length;
      if (localCount === 0) {
        console.log('[Students] Local empty — auto-syncing from server');
        await handleRefresh();
      }
    });
  }, []); // eslint-disable-line

  // Pull-to-refresh: sync from server, then reload
  const { pullProps, PullIndicator } = usePullToRefresh(handleRefresh);

  const levels = useMemo(() =>
    ['All', ...Array.from(new Set(students.map(s => s.level).filter(Boolean)))],
  [students]);

  const statuses = useMemo(() =>
    ['All', ...Array.from(new Set(students.map(s => s.status).filter(Boolean)))],
  [students]);

  const filtered = useMemo(() => students.filter(s => {
    const q = search.toLowerCase();
    const matchSearch = matchesStudentSearch(s, q);
    const matchLevel  = filterLevel  === 'All' || s.level  === filterLevel;
    const matchStatus = filterStatus === 'All' || s.status === filterStatus;
    return matchSearch && matchLevel && matchStatus;
  }), [students, search, filterLevel, filterStatus]);

  const statusCounts = useMemo(() => {
    const m: Record<string,number> = {};
    students.forEach(s => { m[s.status] = (m[s.status] || 0) + 1; });
    return m;
  }, [students]);

  return (
    <div style={S.page} {...pullProps}>
      <PullIndicator />
      {syncMsg && (
        <div style={{ backgroundColor: syncMsg.startsWith('⚠') ? '#fee2e2' : '#dcfce7',
          color: syncMsg.startsWith('⚠') ? '#dc2626' : '#166534',
          textAlign:'center' as const, padding:'6px', fontSize:12, fontWeight:700 }}>
          {syncMsg}
        </div>
      )}
      <ScreenHeader
        title="Students"
        subtitle={`${filtered.length} shown · ${students.length} total`}
        actions={
          <HeaderIconButton label="Refresh" onClick={handleRefresh} disabled={syncing}>
            {syncing ? '⏳' : '↻'}
          </HeaderIconButton>
        }>
        <HeaderSearch value={search} onChange={setSearch} placeholder="Name, QCA ID or r+Reg No…" />
        {/* Status + level filters in one horizontally scrolling row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {statuses.map(st => {
            const count = st === 'All' ? students.length : (statusCounts[st] || 0);
            const isActive = filterStatus === st;
            return (
              <button key={st} onClick={() => setStatus(st)} style={{
                ...S.chip,
                backgroundColor: isActive ? '#fff' : 'rgba(255,255,255,0.14)',
                color: isActive ? C.green : '#fff',
              }}>{st} {count}</button>
            );
          })}
          {levels.length > 1 && <span style={{ width: 1, height: 20, flexShrink: 0, backgroundColor: 'rgba(255,255,255,0.3)', margin: '0 2px' }} />}
          {levels.filter(l => l !== 'All').map(l => {
            const isActive = filterLevel === l;
            return (
              <button key={l} onClick={() => setFilterLevel(isActive ? 'All' : l)} style={{
                ...S.chip,
                backgroundColor: isActive ? C.gold : 'transparent',
                color: isActive ? '#1a1a1a' : 'rgba(255,255,255,0.85)',
                border: `1px solid ${isActive ? C.gold : 'rgba(255,255,255,0.35)'}`,
              }}>{l}</button>
            );
          })}
        </div>
      </ScreenHeader>

      {/* Student list — one card, hairline-separated rows */}
      <div style={S.list}>
        {loading ? <p style={S.empty}>Loading students…</p>
          : filtered.length === 0 ? <p style={S.empty}>No students match your filters.</p>
          : (
          <div style={S.listCard}>
            {filtered.map((s, i) => (
              <button key={s.id} style={{ ...S.row, borderTop: i ? `1px solid ${C.border}` : 'none' }}
                onClick={() => setSelected(s)}>
                <StudentPhoto student={s} size={38} />
                <div style={S.rowBody}>
                  <div style={S.rowTop}>
                    <p style={S.rowName}>{s.name}</p>
                    <span style={{ ...S.statusDot, backgroundColor: s.status === 'Active' ? '#27ae60' : C.red }} />
                    <span style={{ marginLeft: 'auto', flexShrink: 0 }}><FeeStatusBadge studentId={s.id} /></span>
                  </div>
                  <p style={S.rowSub}>
                    <span style={{ color: '#9a7b1c', fontWeight: 700 }}>
                      {formatRegno(s.regno)}{s.qca_id ? ` · Q${String(s.qca_id).padStart(3,'0')}` : ''}
                    </span>
                    {` · ${s.level || 'No level'}`}{s.phone ? ` · ${s.phone}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && <StudentDetailModal student={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:       { backgroundColor: C.bg, minHeight: '100vh', fontFamily: 'sans-serif', paddingBottom: 30 },
  chip:       { flexShrink: 0, height: 30, padding: '0 12px', borderRadius: 15, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' },
  list:       { padding: '8px 10px' },
  empty:      { textAlign: 'center', color: C.gray, padding: '40px 0' },
  listCard:   { backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  row:        { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', minHeight: 54, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' },
  rowBody:    { flex: 1, minWidth: 0 },
  rowTop:     { display: 'flex', alignItems: 'center', gap: 6 },
  rowName:    { fontWeight: 700, fontSize: 14, color: '#1f2937', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusDot:  { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  rowSub:     { fontSize: 11.5, color: C.gray, margin: '2px 0 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
const ms: Record<string, React.CSSProperties> = {
  sectionTitle: { fontSize: 10, fontWeight: 800, color: C.gray, textTransform: 'uppercase', letterSpacing: '1px', margin: '0 2px 5px' },
  rowLabel:   { width: 104, flexShrink: 0, fontSize: 12, color: C.gray, fontWeight: 600, paddingTop: 1 },
  rowValue:   { flex: 1, minWidth: 0, fontSize: 13.5, color: '#1f2937', fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 },
  overlay:    { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', zIndex: 1000 },
  sheet:      { backgroundColor: '#fff', width: '100%', maxHeight: '92vh', borderRadius: '20px 20px 0 0', overflowY: 'auto', paddingBottom: 30 },
  sheetHeader:{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 18px 16px', borderBottom: `1px solid ${C.border}`, backgroundColor: C.green, borderRadius: '20px 20px 0 0' },
  bigName:    { color: '#fff', fontWeight: 700, fontSize: 17, margin: '0 0 2px 0', lineHeight: 1.2 },
  badge:      { color: '#fff', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 },
  closeX:     { marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 22, cursor: 'pointer', alignSelf: 'flex-start', padding: 4 },
};
