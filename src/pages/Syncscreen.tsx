import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import { checkSyncStatus, repairAttendance, reconcilePaymentDeletions } from './useSyncService';
import {
  clearHistAttendance, getHistAttendanceCount, getHistLastFetchedAt, getHistMaxId,
  getPendingUploadCount, getStudentCount,
  getUnsyncedAttendance, markAttendanceSynced, syncAllStudents, upsertHistAttendance, syncHistToAttendance,
  getAttendanceDates, getSessionsForDate, getAttendanceByDateSession,
  getPendingTempStudents, resolveTempStudent,
  syncFeeCategories, upsertPayments, upsertPaymentSummaries,
  getPaymentsCount, getPaymentsMaxId,
} from '../database/db';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';

const LS = {
  ip: 'server_ip', user: 'auth_user', pass: 'auth_pass', key: 'secret_key',
  lastStu: 'last_sync_time', lastStuId: 'last_sync_student_id', lastHager: 'last_hager_sync_time',
};

const C = {
  bg: '#f4f7f6', card: '#ffffff', border: '#e8e8e8',
  green: '#1a472a', gold: '#d4af37', text: '#1f2937', muted: '#6b7280',
  red: '#c0392b', amber: '#b45309', okBg: '#dcfce7', ok: '#166534',
};
const CARD: React.CSSProperties = { backgroundColor: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' };
const fmtDay = (d: string) => {
  const x = new Date(d + 'T00:00:00');
  return isNaN(x.getTime()) ? d : x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

type Phase = 'idle' | 'running' | 'done' | 'error';
interface LogLine { ts: string; level: 'info'|'ok'|'warn'|'err'; msg: string; }
type StuMode  = 'incremental' | 'full' | 'latest';
type HagMode  = 'smart' | 'full';   // smart = skip if data exists; full = wipe + re-download

function nowTs() {
  return new Date().toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function buildBaseUrl(ip: string) {
  const u = (ip || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  return u.startsWith('http') ? u : `http://${u}`;
}
function getHeaders() {
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
function checkConfig(): string|null {
  if (!localStorage.getItem(LS.ip))   return 'No server endpoint — go to Settings';
  if (!localStorage.getItem(LS.user)) return 'No username — go to Settings';
  // Accept either JWT token OR legacy pass+key
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  const hasJwt = jwt && Date.now() < exp - 60000;
  if (!hasJwt) {
    if (!localStorage.getItem(LS.pass)) return 'No password — go to Settings';
    if (!localStorage.getItem(LS.key))  return 'No API secret key — go to Settings';
  }
  return null;
}

// ─── Log view ─────────────────────────────────────────────────────────────────
function LogView({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  const lc: Record<string,string> = { info:C.muted, ok:C.ok, warn:C.amber, err:C.red };
  const pfx: Record<string,string> = { info:'›', ok:'✔', warn:'⚠', err:'✖' };
  return (
    <div ref={ref} style={{ backgroundColor:'#f9fafb', borderTop:`1px solid ${C.border}`, padding:'8px 12px',
      fontFamily:'monospace', fontSize:11.5, maxHeight:220, overflowY:'auto' }}>
      {lines.map((l,i) => (
        <div key={i} style={{ display:'flex', gap:7, marginBottom:2, lineHeight:1.35 }}>
          <span style={{ color:'#9ca3af', flexShrink:0 }}>{l.ts}</span>
          <span style={{ color:lc[l.level], flexShrink:0 }}>{pfx[l.level]}</span>
          <span style={{ color:lc[l.level], overflowWrap:'anywhere' }}>{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Operation row: title + status line + Run on the right ───────────────────
function OpRow({ icon, title, sub, phase, locked, onRun, children }: {
  icon:string; title:string; sub:React.ReactNode;
  phase:Phase; locked?:boolean; onRun:()=>void; children?: React.ReactNode;
}) {
  const running = phase === 'running';
  const off     = running || !!locked;
  const btn = running        ? { t:'⏳',        bg:'#e5e7eb', c:C.muted }
            : phase==='error' ? { t:'⚠ Retry',  bg:'#fee2e2', c:C.red }
            : phase==='done'  ? { t:'✔ Again',  bg:C.okBg,    c:C.ok }
            :                   { t:'Run',      bg:C.green,   c:'#fff' };
  return (
    <div style={{ padding:'9px 12px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:20, width:26, textAlign:'center', flexShrink:0 }}>{icon}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{title}</div>
          <div style={{ fontSize:11.5, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{sub}</div>
        </div>
        <button onClick={onRun} disabled={off} style={{
          flexShrink:0, minWidth:74, padding:'8px 12px', borderRadius:9, border:'none',
          backgroundColor: locked && !running ? '#e5e7eb' : btn.bg,
          color: locked && !running ? '#9ca3af' : btn.c,
          fontWeight:800, fontSize:12.5, cursor: off ? 'not-allowed' : 'pointer',
        }}>{btn.t}</button>
      </div>
      {running && (
        <div style={{ height:3, backgroundColor:C.border, borderRadius:2, overflow:'hidden', marginTop:8 }}>
          <div style={{ height:'100%', backgroundColor:C.green, borderRadius:2, animation:'ss-slide 1.6s ease-in-out infinite' }} />
        </div>
      )}
      {children && <div style={{ marginTop:7, paddingLeft:36 }}>{children}</div>}
    </div>
  );
}

// ─── Mode switch (segmented) ──────────────────────────────────────────────────
function ModeChips<T extends string>({ value, options, onChange }: {
  value:T; options:{val:T;label:string;sub:string}[]; onChange:(v:T)=>void;
}) {
  const cur = options.find(o => o.val === value);
  return (
    <div>
      <div style={{ display:'flex', gap:3, padding:3, borderRadius:8, backgroundColor:'#f3f4f6' }}>
        {options.map(o => (
          <button key={o.val} onClick={() => onChange(o.val)} aria-pressed={value===o.val} style={{
            flex:1, height:26, borderRadius:6, border:'none', cursor:'pointer', fontSize:11.5, fontWeight:700,
            backgroundColor: value===o.val ? '#fff' : 'transparent',
            color: value===o.val ? C.green : C.muted,
            boxShadow: value===o.val ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
          }}>{o.label}</button>
        ))}
      </div>
      {cur && <div style={{ fontSize:10.5, color:C.muted, marginTop:3 }}>{cur.sub}</div>}
    </div>
  );
}

const Warn = ({ children }: { children: React.ReactNode }) => (
  <div style={{ marginTop:6, padding:'5px 8px', borderRadius:7, backgroundColor:'#fffbeb',
    border:'1px solid #fcd34d', fontSize:11, color:'#92400e', fontWeight:600 }}>⚠ {children}</div>
);

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px',
    textTransform:'uppercase' as const, margin:'4px 2px -2px' }}>{children}</div>
);

const Hair = () => <div style={{ height:1, backgroundColor:C.border, marginLeft:48 }} />;

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function SyncScreen() {
  const navigate = useNavigate();
  const { can, roleLabel } = usePermissions();
  const isRestrictedUser = localStorage.getItem('qca_is_restricted') === '1';
  const isAdminOrCoach   = can('sync:upload') || can('sync:download');
  const [syncCheck,      setSyncCheck]     = useState<any[]|null>(null);
  const [repairing,      setRepairing]     = useState(false);
  const [repairMsg,      setRepairMsg]     = useState('');
  const [checkLoading,   setCheckLoading]  = useState(false);

  const base = localStorage.getItem('server_ip') || '';
  const [log, setLog]         = useState<LogLine[]>([]);
  const [stuCount,  setStuCount]  = useState(0);
  const [pendCount, setPendCount] = useState(0);
  const [hagCount,  setHagCount]  = useState(0);
  const [lastStu,    setLastStu]    = useState<string|null>(null);
  const [lastHag,    setLastHag]    = useState<string|null>(null);
  const [paymentsCount, setPaymentsCount] = useState(0);
  const [lastPayments,  setLastPayments]  = useState<string|null>(null);

  const addLog = (level: LogLine['level'], msg: string) =>
    setLog(l => [...l, { ts: nowTs(), level, msg }]);

  const refreshStats = async () => {
    setStuCount(await getStudentCount());
    setPendCount(await getPendingUploadCount());
    setHagCount(await getHistAttendanceCount());
    setPaymentsCount(await getPaymentsCount());
  };

  useEffect(() => {
    refreshStats();
    setLastStu(localStorage.getItem(LS.lastStu));
    setLastHag(localStorage.getItem(LS.lastHager));
    setLastPayments(localStorage.getItem('last_payments_sync'));
  }, []);

  // ── Students ────────────────────────────────────────────────────────────────
  const [stuMode,  setStuMode]  = useState<StuMode>('incremental');
  const [stuPhase, setStuPhase] = useState<Phase>('idle');

  const runStudents = async () => {
    if (!can('sync:students')) { addLog('err', '🔒 Permission denied: sync:students'); return; }
    const e = checkConfig(); if (e) { addLog('err', e); return; }
    setStuPhase('running');
    const base    = buildBaseUrl(localStorage.getItem(LS.ip)!);
    const headers = getHeaders();
    try {
      addLog('info', 'Students: pinging server…');
      const ping = await fetch(`${base}/api/data/ping`, { method:'GET', headers });
      if (!ping.ok) throw new Error(ping.status === 401 ? 'Invalid credentials' : `Server ${ping.status}`);
      const { authenticated_as } = await ping.json();
      addLog('ok', `Authenticated as ${authenticated_as}`);

      const lastId = parseInt(localStorage.getItem(LS.lastStuId) || '0', 10);
      let sinceId  = stuMode === 'incremental' ? lastId
                   : stuMode === 'latest'      ? Math.max(lastId - 50, 0)
                   : 0;  // full
      if (stuMode === 'full') localStorage.removeItem(LS.lastStuId);

      addLog('info', `Students: fetching (mode=${stuMode}, since_id=${sinceId})…`);
      const res  = await fetch(`${base}/api/data/students?since_id=${sinceId}&limit=50000`, { method:'GET', headers });
      if (!res.ok) throw new Error(`Student fetch ${res.status}`);
      const data: any[] = (await res.json()).data || [];

      if (data.length > 0) {
        addLog('info', `Students: saving ${data.length} record(s)…`);
        await syncAllStudents(data);
        const maxId = Math.max(...data.map((s:any) => s.id ?? 0));
        if (maxId > lastId) localStorage.setItem(LS.lastStuId, String(maxId));
        addLog('ok', `Students: ${data.length} saved ✓`);
      } else {
        addLog('ok', 'Students: already up to date');
      }
      localStorage.setItem(LS.lastStu, new Date().toLocaleString());
      setLastStu(localStorage.getItem(LS.lastStu));
      setStuPhase('done');
      await refreshStats();
    } catch (e: any) { addLog('err', `Students: ${e?.message ?? e}`); setStuPhase('error'); }
  };

  // ── Upload attendance ───────────────────────────────────────────────────────
  const [upPhase, setUpPhase] = useState<Phase>('idle');

  const runUpload = async () => {
    if (!can('sync:upload')) { addLog('err', '🔒 Permission denied: sync:upload'); return; }
    const e = checkConfig(); if (e) { addLog('err', e); return; }
    setUpPhase('running');
    const base    = buildBaseUrl(localStorage.getItem(LS.ip)!);
    const headers = getHeaders();
    try {

      // ── Step 0: Auto-register pending temp students ──────────────────────
      const pendingTemps = await getPendingTempStudents();
      if (pendingTemps.length > 0) {
        addLog('info', `Found ${pendingTemps.length} temp student(s) — registering on server first…`);
        for (const tmp of pendingTemps) {
          try {
            addLog('info', `Registering temp student: ${tmp.name} (TMP-${tmp.temp_id})…`);
            const res = await fetch(`${base}/api/data/students/register`, {
              method: 'POST', headers,
              body: JSON.stringify({
                name:             tmp.name,
                date_of_birth:    tmp.date_of_birth,
                status:           tmp.status,
                student_category: tmp.student_category,
                enrollment_date:  tmp.enrollment_date,
              }),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) {
              addLog('err', `Failed to register ${tmp.name}: ${j.error || 'HTTP ' + res.status}`);
              continue;  // skip this temp — don't block other students
            }
            const serverId = j.student_id ?? j.id;
            if (!serverId) {
              addLog('err', `Server did not return student_id for ${tmp.name}`);
              continue;
            }
            // Migrate all attendance from temp_id → real server ID
            await resolveTempStudent(tmp.temp_id, serverId);
            addLog('ok', `${tmp.name} registered → server ID ${serverId}. Attendance migrated ✓`);
          } catch (tempErr: any) {
            addLog('err', `Error registering ${tmp.name}: ${tempErr?.message}`);
          }
        }
      }

      addLog('info', 'Upload: checking pending attendance…');
      const unsync = await getUnsyncedAttendance();
      if (unsync.length === 0 && pendingTemps.length === 0) {
        addLog('ok', 'Upload: nothing pending');
        setUpPhase('done');
        await refreshStats();
        return;
      }

      // Map local DB columns → server expected fields
      // Local:  student_id | attendance_date | session_type | status (0/1 int)
      // Server: student_id | date            | session      | status ('PRESENT'/'ABSENT')
      //
      // Server groups records by (date, session) and for each group:
      //   1. DELETE all rows previously uploaded by THIS coach for that date+session
      //      (so corrections on re-upload are applied, old stale rows are replaced)
      //   2. INSERT fresh rows stamped with uploaded_by = this coach's username
      // Other coaches' rows for the same date+session are never touched.
      // Filter out any remaining temp students (negative IDs) that failed registration
      const validUnsync = unsync.filter((r: any) => r.student_id > 0);
      const skipped = unsync.length - validUnsync.length;
      if (skipped > 0) addLog('info', `Skipped ${skipped} temp student record(s) — pending server registration`);

      const formattedRecords = validUnsync.map((r: any, index: number) => {
        addLog('info', `Row[${index}] student_id=${r.student_id} date=${r.attendance_date} session=${r.session_type} status=${r.status}`);
        return {
          student_id: r.student_id,
          date:       r.attendance_date,
          session:    r.session_type,
          status:     (r.status === 1 || r.status === '1') ? 'PRESENT' : 'ABSENT',
        };
      });

      // Show summary before sending
      const groups = new Map<string, number>();
      formattedRecords.forEach(r => {
        const k = `${r.date} ${r.session}`;
        groups.set(k, (groups.get(k) ?? 0) + 1);
      });
      groups.forEach((count, key) => addLog('info', `Group: ${key} — ${count} record(s)`));

      const payload = { temp_attendance: formattedRecords };
      addLog('info', `Sending ${formattedRecords.length} record(s) in ${groups.size} group(s)…`);
      if (formattedRecords.length === 0) { addLog('ok', 'Nothing to upload after filtering'); setUpPhase('done'); await refreshStats(); return; }

      const res = await fetch(`${base}/api/data/upload/attendance`, {
        method: 'POST', headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Upload failed (${res.status}): ${errBody.error ?? errBody.message ?? res.statusText}`);
      }

      // Read response text first (safer than .json() with connection-close)
      let inserted = formattedRecords.length;
      let replaced = 0;
      try {
        const text = await res.text();
        const resBody = JSON.parse(text);
        inserted = resBody.inserted ?? formattedRecords.length;
        replaced = resBody.replaced ?? 0;
        if (replaced > 0) addLog('info', `Server cleared ${replaced} stale row(s)`);
      } catch { /* response body read failed but status was 200 — still success */ }

      addLog('ok', `${inserted} record(s) inserted on server ✓`);

      // Mark synced locally
      try {
        await markAttendanceSynced(validUnsync.map((r: any) => r.session_id));
        addLog('ok', `Upload complete — ${unsync.length} local record(s) marked synced ✓`);
      } catch (dbErr: any) {
        addLog('info', `Data saved on server. Local mark failed: ${dbErr?.message}`);
      }
      setUpPhase('done');
      await refreshStats();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Never mark records synced on a failed request: offline at the ground
      // looks exactly like this, and the attendance would be lost for good.
      // Records stay pending; re-uploading is safe — the server replaces this
      // coach's earlier row per student/date/session instead of duplicating.
      if (msg.toLowerCase().includes('failed to fetch')) {
        addLog('err', `Network error: ${msg}`);
        addLog('info', 'Records kept as pending — they will upload on the next try');
      }
      addLog('err', `Upload error: ${msg}`);
      setUpPhase('error');
    }
  };

  // ── Hager register ──────────────────────────────────────────────────────────
  const [hagMode,  setHagMode]  = useState<HagMode>('smart');
  const [hagPhase, setHagPhase] = useState<Phase>('idle');

  const runHager = async () => {
    if (!can('sync:download')) { addLog('err', '🔒 Permission denied: sync:download'); return; }
    const e = checkConfig(); if (e) { addLog('err', e); return; }
    setHagPhase('running');
    const base    = buildBaseUrl(localStorage.getItem(LS.ip)!);
    const headers = getHeaders();
    try {
      // Smart mode: check if we already have data; if so use max(id) as since_id
      const currentCount = await getHistAttendanceCount();
      const maxId        = await getHistMaxId();

      let url = `${base}/api/data/hager`;

      if (hagMode === 'full') {
        addLog('warn', 'Hager: full mode — wiping local mirror…');
        await clearHistAttendance();
        // fetch all
      } else {
        // smart: skip entirely if data exists and we want incremental
        if (currentCount > 0 && maxId > 0) {
          url = `${base}/api/data/hager?since_id=${maxId}`;
          addLog('info', `Hager: smart incremental — local has ${currentCount} records, fetching since id=${maxId}…`);
        } else if (currentCount > 0) {
          addLog('info', `Hager: local has ${currentCount} records, fetching new records…`);
        } else {
          addLog('info', 'Hager: no local data — downloading full register…');
        }
      }

      const res = await fetch(url, { method:'GET', headers });
      if (!res.ok) throw new Error(`Hager fetch ${res.status}`);
      const json   = await res.json();
      const raw: any[] = json.data || json.records || (Array.isArray(json) ? json : []);

      if (!Array.isArray(raw)) throw new Error('Unexpected response shape: ' + JSON.stringify(json).slice(0, 80));

      if (raw.length === 0) {
        addLog('ok', `Hager: server returned 0 new records — already up to date`);
        // Still mirror existing hist_attendance to attendance table
        try {
          const mirrored = await syncHistToAttendance();
          if (mirrored > 0) addLog('ok', `Local attendance mirrored: ${mirrored} row(s) ✓`);
        } catch (_) {}
        setHagPhase('done');
        await refreshStats();
        return;
      }

      addLog('info', `Hager: ${raw.length} rows received. Keys: ${Object.keys(raw[0]).join(', ')}`);
      addLog('info', 'Hager: inserting in batches of 500…');
      const saved = await upsertHistAttendance(raw);
      addLog('ok', `Hager: ${saved} row(s) → hist_attendance ✓`);

      // Mirror hist_attendance → attendance table so local = server
      addLog('info', 'Syncing hist_attendance → local attendance table…');
      try {
        const mirrored = await syncHistToAttendance();
        addLog('ok', `Local attendance table updated: ${mirrored} row(s) mirrored ✓`);
      } catch (mirrorErr: any) {
        addLog('info', `Mirror warning: ${mirrorErr?.message} — hist_attendance still updated`);
      }

      const now = new Date().toLocaleString();
      localStorage.setItem(LS.lastHager, now);
      setLastHag(now);
      setHagPhase('done');
      await refreshStats();
    } catch (e: any) { addLog('err', `Hager: ${e?.message ?? e}`); setHagPhase('error'); }
  };

  // ── Payments sync ──────────────────────────────────────────────────────────
  const [payMode,  setPayMode]  = useState<'smart'|'full'>('smart');
  const [payPhase, setPayPhase] = useState<Phase>('idle');

  const runPayments = async () => {
    if (!can('sync:payments')) { addLog('err', '🔒 Permission denied: sync:payments'); return; }
    const e = checkConfig(); if (e) { addLog('err', e); return; }
    setPayPhase('running');
    const base    = buildBaseUrl(localStorage.getItem(LS.ip)!);
    const headers = getHeaders();
    try {
      // Step 1 — fee categories (always full, tiny table)
      addLog('info', 'Payments: fetching fee categories…');
      const catRes = await fetch(`${base}/api/data/fee-categories`, { method:'GET', headers });
      if (!catRes.ok) throw new Error(`Fee categories fetch ${catRes.status}`);
      const catJson = await catRes.json();
      const cats: any[] = catJson.data || [];
      await syncFeeCategories(cats);
      addLog('ok', `Payments: ${cats.length} fee category/ies cached ✓`);

      // Step 2 — payments (incremental or full)
      const localMax   = await getPaymentsMaxId();
      const localCount = await getPaymentsCount();
      let url = `${base}/api/data/payments?limit=50000`;

      if (payMode === 'full') {
        addLog('info', 'Payments: full mode — fetching all…');
      } else {
        // Smart: fetch since max local id if we already have data
        if (localCount > 0 && localMax > 0) {
          url += `&since_id=${localMax}`;
          addLog('info', `Payments: incremental — local has ${localCount} rows, fetching since id=${localMax}…`);
        } else {
          addLog('info', 'Payments: no local data — full download…');
        }
      }

      const payRes = await fetch(url, { method:'GET', headers });
      if (!payRes.ok) throw new Error(`Payments fetch ${payRes.status}`);
      const payJson = await payRes.json();
      const payRows: any[] = payJson.data || [];
      const summary = payJson.summary || {};

      if (payRows.length === 0) {
        addLog('ok', 'Payments: already up to date');
      } else {
        addLog('info', `Payments: ${payRows.length} row(s) received — saving…`);
        const saved = await upsertPayments(payRows);
        addLog('ok', `Payments: ${saved} row(s) saved ✓`);
      }

      // Step 3 — upsert summary blobs (always included in response)
      const summaryKeys = Object.keys(summary);
      if (summaryKeys.length > 0) {
        await upsertPaymentSummaries(summary);
        addLog('ok', `Payments: summary updated for ${summaryKeys.length} student(s) ✓`);
      }

      // Step 4 — drop payments voided on the server (sync only ever adds rows)
      const removed = await reconcilePaymentDeletions(base);
      if (removed) addLog('ok', `Payments: removed ${removed} voided row(s) ✓`);

      const now = new Date().toLocaleString();
      localStorage.setItem('last_payments_sync', now);
      setLastPayments(now);
      setPayPhase('done');
      await refreshStats();
    } catch (e: any) { addLog('err', `Payments: ${e?.message ?? e}`); setPayPhase('error'); }
  };

  // ── Re-upload by date ──────────────────────────────────────────────────────
  // Allows a coach to force re-send attendance for a specific date+session
  // even if those records were already marked synced. The server will replace
  // only this coach's previous rows for that date+session (uploaded_by scoped).

  const [reupDate,     setReupDate]     = useState<string>('');
  const [reupSessions, setReupSessions] = useState<string[]>([]);  // sessions available for chosen date
  const [reupSelected, setReupSelected] = useState<Set<string>>(new Set());
  const [reupPhase,    setReupPhase]    = useState<Phase>('idle');
  const [availDates,   setAvailDates]   = useState<string[]>([]);

  // Load available dates when component mounts
  useEffect(() => {
    getAttendanceDates().then(dates => setAvailDates(dates));
  }, []);

  // When date changes load its sessions
  const handleReupDateChange = async (date: string) => {
    setReupDate(date);
    setReupSelected(new Set());
    if (date) {
      const sessions = await getSessionsForDate(date);
      setReupSessions(sessions);
      // Auto-select all sessions for that date
      setReupSelected(new Set(sessions));
    } else {
      setReupSessions([]);
    }
  };

  const toggleReupSession = (sess: string) => {
    setReupSelected(prev => {
      const next = new Set(prev);
      if (next.has(sess)) next.delete(sess); else next.add(sess);
      return next;
    });
  };

  const runReupload = async () => {
    if (!can('sync:reupload')) { addLog('err', '🔒 Permission denied: sync:reupload'); return; }
    if (!reupDate || reupSelected.size === 0) {
      addLog('warn', 'Re-upload: select a date and at least one session');
      return;
    }
    const e = checkConfig(); if (e) { addLog('err', e); return; }
    setReupPhase('running');
    const base    = buildBaseUrl(localStorage.getItem(LS.ip)!);
    const headers = getHeaders();
    try {
      let allRecords: any[] = [];
      for (const sess of reupSelected) {
        const rows = await getAttendanceByDateSession(reupDate, sess);
        addLog('info', `Re-upload: ${reupDate} ${sess} — ${rows.length} local record(s)`);
        allRecords = [...allRecords, ...rows];
      }

      if (allRecords.length === 0) {
        addLog('warn', 'Re-upload: no local records found for selected date/session');
        setReupPhase('error');
        return;
      }

      const formattedRecords = allRecords.map((r: any) => ({
        student_id: r.student_id,
        date:       r.attendance_date,
        session:    r.session_type,
        status:     (r.status === 1 || r.status === '1') ? 'PRESENT' : 'ABSENT',
      }));

      addLog('info', `Re-upload: sending ${formattedRecords.length} record(s) to server…`);
      const res = await fetch(`${base}/api/data/upload/attendance`, {
        method: 'POST', headers,
        body: JSON.stringify({ temp_attendance: formattedRecords }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Re-upload failed (${res.status}): ${errBody.error ?? res.statusText}`);
      }
      const resBody = await res.json().catch(() => ({}));
      const inserted = resBody.inserted ?? formattedRecords.length;
      const replaced = resBody.replaced ?? 0;
      if (replaced > 0) addLog('info', `Server cleared ${replaced} stale row(s) from previous upload`);
      addLog('ok', `Re-upload: ${inserted} record(s) refreshed on server ✓`);
      setReupPhase('done');
    } catch (e: any) { addLog('err', `Re-upload: ${e?.message ?? e}`); setReupPhase('error'); }
  };

  const anyRunning = stuPhase === 'running' || upPhase === 'running' || hagPhase === 'running' || reupPhase === 'running' || payPhase === 'running';

  const runAll = async () => {
    if (!can('sync:runall')) { addLog('err', '🔒 Permission denied: sync:runall'); return; }
    await runStudents();
    await runUpload();
    await runHager();
    await runPayments();
  };

  // Session (the password is never stored — the JWT is the credential)
  const jwtExp     = parseInt(localStorage.getItem('jwt_expiry') || '0', 10);
  const sessionOk  = !!localStorage.getItem('jwt_token') && Date.now() < jwtExp;
  const sessionTxt = sessionOk
    ? `session valid till ${new Date(jwtExp).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}`
    : 'session expired — sign in again';

  // Log: collapsed to its last line; opens by itself when something fails
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => { if (log.length && log[log.length-1].level === 'err') setLogOpen(true); }, [log]);
  const lastLine = log[log.length-1];

  const showDownload = isAdminOrCoach && (can('sync:students') || can('sync:download') || can('sync:payments'));
  const statCell = (label: string, value: number, color: string, first?: boolean) => (
    <div style={{ flex:1, padding:'7px 4px', textAlign:'center' as const, borderLeft: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize:16, fontWeight:900, color }}>{value.toLocaleString('en-IN')}</div>
      <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.4px' }}>{label}</div>
    </div>
  );

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', fontFamily:'sans-serif', color:C.text, paddingBottom:24 }}>

      <ScreenHeader title="Data Sync" back={() => navigate('/')}
        subtitle="Server ↔ this device"
        actions={<HeaderIconButton label="Settings" onClick={() => navigate('/settings')}>⚙️</HeaderIconButton>} />

      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>

        {/* ── Server, session, counts ── */}
        <div style={CARD}>
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px' }}>
            <span style={{ fontSize:16 }}>🖥️</span>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {localStorage.getItem(LS.ip) || <span style={{ color:C.red }}>No server configured</span>}
              </div>
              <div style={{ fontSize:11, marginTop:1, color: sessionOk ? C.muted : C.red, fontWeight: sessionOk ? 400 : 700 }}>
                {localStorage.getItem(LS.user) || '—'} · {sessionTxt}
              </div>
            </div>
            <button onClick={() => navigate('/settings')} style={{ backgroundColor:'#f0f4f0', color:C.green, border:'none',
              borderRadius:8, padding:'5px 10px', cursor:'pointer', fontSize:12, fontWeight:700 }}>Edit</button>
          </div>
          <div style={{ display:'flex', borderTop:`1px solid ${C.border}`, backgroundColor:'#fafafa' }}>
            {statCell('Students', stuCount,      C.green, true)}
            {statCell('Pending',  pendCount,     pendCount > 0 ? C.amber : C.ok)}
            {statCell('Hager',    hagCount,      C.text)}
            {statCell('Payments', paymentsCount, C.text)}
          </div>
        </div>

        {/* ── Run all ── */}
        {can('sync:runall') && (
          <button onClick={runAll} disabled={anyRunning} style={{
            width:'100%', padding:'11px', borderRadius:11, border:'none',
            backgroundColor: anyRunning ? '#e5e7eb' : C.green,
            color: anyRunning ? C.muted : C.gold, fontWeight:900, fontSize:14,
            cursor: anyRunning ? 'not-allowed' : 'pointer',
          }}>
            {anyRunning ? '⏳ Sync running…' : '⇅ Sync Everything'}
            {!anyRunning && <div style={{ fontSize:10.5, fontWeight:600, color:'rgba(255,255,255,0.7)', marginTop:1 }}>
              Students → Upload → Hager → Payments
            </div>}
          </button>
        )}

        {/* ── Upload (daily) ── */}
        {can('sync:upload') && (<>
          <SectionLabel>⬆ Upload to server</SectionLabel>
          <div style={CARD}>
            <OpRow icon="📤" title="Upload Attendance" phase={upPhase} locked={anyRunning} onRun={runUpload}
              sub={pendCount > 0
                ? <b style={{ color:C.amber }}>{pendCount} record{pendCount===1?'':'s'} waiting</b>
                : 'All attendance uploaded ✔'} />
          </div>
        </>)}

        {/* ── Download ── */}
        {showDownload && (<>
          <SectionLabel>⬇ Download from server</SectionLabel>
          <div style={CARD}>
            {can('sync:students') && <OpRow icon="👨‍🎓" title="Students" phase={stuPhase} locked={anyRunning} onRun={runStudents}
              sub={lastStu ? `Last: ${lastStu}` : 'Student roster'}>
              <ModeChips value={stuMode} onChange={setStuMode} options={[
                { val:'incremental', label:'New',    sub:'New students since last sync' },
                { val:'latest',      label:'Latest', sub:'Re-check the most recent 50' },
                { val:'full',        label:'Full',   sub:'Re-download every student' },
              ]} />
              {stuMode === 'full' && <Warn>Resets the sync cursor — downloads all students</Warn>}
            </OpRow>}

            {can('sync:students') && can('sync:download') && <Hair />}
            {can('sync:download') && <OpRow icon="📋" title="Hager Register" phase={hagPhase} locked={anyRunning} onRun={runHager}
              sub={lastHag ? `Last: ${lastHag}` : 'Full attendance history'}>
              <ModeChips value={hagMode} onChange={setHagMode} options={[
                { val:'smart', label:'Smart', sub: hagCount > 0 ? `Has ${hagCount.toLocaleString('en-IN')} rows — fetch new only` : 'Empty — will download everything' },
                { val:'full',  label:'Full',  sub:'Wipe and re-download all' },
              ]} />
              {hagMode === 'full' && <Warn>Wipes the local history first — safe, the server keeps the master copy</Warn>}
            </OpRow>}

            {(can('sync:students') || can('sync:download')) && can('sync:payments') && <Hair />}
            {can('sync:payments') && <OpRow icon="💰" title="Payments & Fees" phase={payPhase} locked={anyRunning} onRun={runPayments}
              sub={lastPayments ? `Last: ${lastPayments}` : 'Payment history and dues'}>
              <ModeChips value={payMode} onChange={setPayMode} options={[
                { val:'smart', label:'Smart', sub: paymentsCount > 0 ? `Has ${paymentsCount.toLocaleString('en-IN')} rows — fetch new only` : 'Empty — will download everything' },
                { val:'full',  label:'Full',  sub:'Re-download all payments' },
              ]} />
            </OpRow>}
          </div>
        </>)}

        {/* ── Log ── */}
        <div style={CARD}>
          <button onClick={() => log.length && setLogOpen(v => !v)} aria-expanded={logOpen}
            style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 12px',
              background:'none', border:'none', cursor: log.length ? 'pointer' : 'default', textAlign:'left' as const }}>
            <span style={{ fontSize:12, fontWeight:800, color:C.text, flexShrink:0 }}>📋 Log</span>
            <span style={{ flex:1, minWidth:0, fontSize:11.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
              color: !lastLine ? C.muted : lastLine.level === 'err' ? C.red : lastLine.level === 'ok' ? C.ok : C.muted }}>
              {lastLine ? lastLine.msg : 'No activity yet'}
            </span>
            {log.length > 0 && <span style={{ fontSize:11, color:C.muted, flexShrink:0 }}>{log.length} {logOpen ? '▲' : '▼'}</span>}
          </button>
          {logOpen && log.length > 0 && <LogView lines={log} />}
        </div>

        {/* ── Tools ── */}
        <details style={{ ...CARD, padding:0 }}>
          <summary style={{ padding:'9px 12px', fontSize:12.5, fontWeight:800, color:C.text, cursor:'pointer' }}>
            🧰 Tools <span style={{ fontWeight:500, color:C.muted }}>— check, repair, re-upload, full refresh</span>
          </summary>

          {/* Sync validation */}
          <div style={{ padding:'9px 12px', borderTop:`1px solid ${C.border}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:18, width:26, textAlign:'center' }}>🔍</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13.5, fontWeight:800 }}>Check sync</div>
                <div style={{ fontSize:11.5, color:C.muted }}>Compare this device with the server</div>
              </div>
              <button disabled={checkLoading} onClick={async () => {
                setCheckLoading(true); setSyncCheck(null); setRepairMsg('');
                try {
                  const results = await checkSyncStatus(base);
                  setSyncCheck(results);
                } catch(e) {
                  setSyncCheck([{table:'Error', local:0, server:0, match:false}]);
                }
                setCheckLoading(false);
              }} style={{ flexShrink:0, minWidth:74, padding:'8px 12px', borderRadius:9, border:'none',
                backgroundColor: checkLoading ? '#e5e7eb' : C.green, color: checkLoading ? C.muted : '#fff',
                fontWeight:800, fontSize:12.5, cursor:'pointer' }}>
                {checkLoading ? '⏳' : 'Check'}
              </button>
            </div>
            {syncCheck && (
              <div style={{ marginTop:8 }}>
                {syncCheck.map(row => (
                  <div key={row.table} style={{ padding:'6px 10px', borderRadius:8, marginBottom:4,
                    backgroundColor: row.match ? '#f0fdf4' : '#fee2e2',
                    border: `1px solid ${row.match ? '#86efac' : '#fca5a5'}` }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:12.5, fontWeight:700 }}>{row.table}</span>
                      <span style={{ fontSize:11.5, color: row.match ? C.ok : '#dc2626', fontWeight:800 }}>
                        {row.match ? `✅ ${row.local} = ${row.server}` : `⚠ device ${row.local} · server ${row.server}`}
                      </span>
                    </div>
                    {row.detail && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{row.detail}</div>}
                  </div>
                ))}
                {syncCheck.some(r => r.canRepair) && (
                  <div style={{ marginTop:6 }}>
                    <button disabled={repairing || anyRunning} onClick={async () => {
                      setRepairing(true); setRepairMsg('');
                      const result = await repairAttendance(msg => setRepairMsg(msg));
                      setRepairing(false);
                      if (result.error) {
                        setRepairMsg(`⚠ ${result.error}`);
                      } else {
                        setRepairMsg(`✅ Added ${result.added}, removed ${result.removed}`);
                        try {
                          const results = await checkSyncStatus(base);
                          setSyncCheck(results);
                        } catch {}
                      }
                    }}
                      style={{ width:'100%', padding:'9px', borderRadius:9, border:'none',
                        backgroundColor: repairing ? '#e5e7eb' : C.amber, color: repairing ? C.muted : '#fff',
                        fontWeight:800, fontSize:12.5, cursor: repairing ? 'default' : 'pointer' }}>
                      {repairing ? '⏳ Syncing missing records…' : '🔧 Sync missing attendance'}
                    </button>
                    {repairMsg && <div style={{ fontSize:11.5, color:C.muted, marginTop:5, textAlign:'center' as const }}>{repairMsg}</div>}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Re-upload by date */}
          {can('sync:reupload') && (
            <div style={{ padding:'9px 12px', borderTop:`1px solid ${C.border}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:7 }}>
                <span style={{ fontSize:18, width:26, textAlign:'center' }}>🔄</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13.5, fontWeight:800 }}>Re-upload a day</div>
                  <div style={{ fontSize:11.5, color:C.muted }}>Replaces your earlier upload for that day</div>
                </div>
              </div>
              {availDates.length === 0 ? (
                <div style={{ fontSize:12, color:C.muted, paddingLeft:36 }}>No attendance recorded on this device yet</div>
              ) : (
                <div style={{ display:'flex', flexWrap:'wrap' as const, gap:5, paddingLeft:36 }}>
                  {availDates.map(d => (
                    <button key={d} onClick={() => handleReupDateChange(reupDate === d ? '' : d)} style={{
                      padding:'5px 9px', borderRadius:14, cursor:'pointer', fontSize:11.5, fontWeight:700,
                      border:`1px solid ${reupDate === d ? C.green : C.border}`,
                      backgroundColor: reupDate === d ? C.green : '#fff',
                      color: reupDate === d ? '#fff' : C.text,
                    }}>{fmtDay(d)}</button>
                  ))}
                </div>
              )}
              {reupDate && (
                <div style={{ paddingLeft:36, marginTop:8 }}>
                  {reupSessions.length === 0
                    ? <div style={{ fontSize:12, color:C.muted }}>No sessions found for {fmtDay(reupDate)}</div>
                    : <>
                        <div style={{ display:'flex', gap:3, padding:3, borderRadius:8, backgroundColor:'#f3f4f6' }}>
                          {reupSessions.map(sess => {
                            const active = reupSelected.has(sess);
                            return (
                              <button key={sess} onClick={() => toggleReupSession(sess)} aria-pressed={active} style={{
                                flex:1, height:28, borderRadius:6, border:'none', cursor:'pointer', fontWeight:700, fontSize:12,
                                backgroundColor: active ? '#fff' : 'transparent', color: active ? C.green : C.muted,
                                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
                              }}>{active ? '✔ ' : ''}{sess}</button>
                            );
                          })}
                        </div>
                        <button onClick={runReupload} disabled={reupPhase === 'running' || reupSelected.size === 0 || anyRunning} style={{
                          width:'100%', marginTop:7, padding:'9px', borderRadius:9, border:'none',
                          backgroundColor: reupPhase === 'running' || reupSelected.size === 0 ? '#e5e7eb'
                            : reupPhase === 'error' ? '#fee2e2' : reupPhase === 'done' ? C.okBg : C.green,
                          color: reupPhase === 'running' || reupSelected.size === 0 ? C.muted
                            : reupPhase === 'error' ? C.red : reupPhase === 'done' ? C.ok : '#fff',
                          fontWeight:800, fontSize:12.5,
                          cursor: reupPhase === 'running' || reupSelected.size === 0 ? 'not-allowed' : 'pointer',
                        }}>
                          {reupPhase === 'running' ? '⏳ Re-uploading…'
                            : reupPhase === 'done'  ? `✔ Done — re-upload ${fmtDay(reupDate)} again`
                            : reupPhase === 'error' ? '⚠ Error — retry'
                            : `Re-upload ${fmtDay(reupDate)}`}
                        </button>
                      </>}
                </div>
              )}
            </div>
          )}

          {/* Full refresh lives in Settings */}
          <button onClick={() => navigate('/settings')} style={{ width:'100%', display:'flex', alignItems:'center', gap:10,
            padding:'10px 12px', background:'none', border:'none', borderTop:`1px solid ${C.border}`, cursor:'pointer', textAlign:'left' as const }}>
            <span style={{ fontSize:18, width:26, textAlign:'center' }}>♻️</span>
            <span style={{ flex:1, minWidth:0 }}>
              <span style={{ display:'block', fontSize:13.5, fontWeight:800, color:C.text }}>Full refresh</span>
              <span style={{ display:'block', fontSize:11.5, color:C.muted }}>Clear this device and re-download — in Settings</span>
            </span>
            <span style={{ color:C.muted, fontSize:16 }}>›</span>
          </button>
        </details>

      </div>
      <style>{`@keyframes ss-slide { 0%{width:5%} 50%{width:80%} 100%{width:95%} }`}</style>
    </div>
  );
}
