import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import { checkSyncStatus, repairAttendance } from './useSyncService';
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
  bg: '#0f1a13', card: '#162218', border: '#243828',
  green: '#1a472a', gold: '#d4af37', text: '#e8f5ec', muted: '#6b8f73',
  red: '#c0392b', blue: '#2980b9', teal: '#16a085',
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
  const lc: Record<string,string> = { info:C.muted, ok:'#4caf77', warn:'#e6a817', err:C.red };
  const pfx: Record<string,string> = { info:'›', ok:'✔', warn:'⚠', err:'✖' };
  return (
    <div ref={ref} style={{ backgroundColor:'#080e0a', borderRadius:10, padding:'10px 14px', fontFamily:'monospace', fontSize:11.5, maxHeight:180, overflowY:'auto', border:`1px solid ${C.border}` }}>
      {lines.length === 0
        ? <span style={{ color:C.border }}>// awaiting operation…</span>
        : lines.map((l,i) => (
          <div key={i} style={{ display:'flex', gap:7, marginBottom:2 }}>
            <span style={{ color:'#3a5040', flexShrink:0 }}>{l.ts}</span>
            <span style={{ color:lc[l.level], flexShrink:0 }}>{pfx[l.level]}</span>
            <span style={{ color:lc[l.level] }}>{l.msg}</span>
          </div>
        ))
      }
    </div>
  );
}

// ─── Op card ──────────────────────────────────────────────────────────────────
function OpCard({ icon, title, desc, accent, phase, onRun, children }: {
  icon:string; title:string; desc:string; accent:string;
  phase:Phase; onRun:()=>void; children?: React.ReactNode;
}) {
  const running = phase === 'running';
  const done    = phase === 'done';
  const error   = phase === 'error';
  const btnBg   = running ? C.border : error ? C.red : done ? '#4caf77' : accent;
  return (
    <div style={{ backgroundColor:C.card, borderRadius:14, border:`1.5px solid ${phase!=='idle' ? accent : C.border}`, overflow:'hidden', transition:'border-color 0.2s' }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 14px 10px' }}>
        <span style={{ fontSize:22 }}>{icon}</span>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{title}</div>
          <div style={{ fontSize:11, color:C.muted, marginTop:1 }}>{desc}</div>
        </div>
      </div>
      {children && <div style={{ padding:'0 14px 8px' }}>{children}</div>}
      <div style={{ padding:'0 14px 14px' }}>
        <button onClick={onRun} disabled={running} style={{
          width:'100%', padding:'11px', borderRadius:10, border:'none',
          backgroundColor:btnBg, color:'#fff', fontWeight:800, fontSize:13,
          cursor:running ? 'not-allowed' : 'pointer',
          boxShadow: running ? 'none' : `0 3px 10px ${btnBg}55`,
          transition:'all 0.2s',
        }}>
          {running ? '⏳  Running…' : done ? '✔  Done — Run again' : error ? '⚠  Error — Retry' : '▶  Run'}
        </button>
      </div>
    </div>
  );
}

// ─── Mode chips ───────────────────────────────────────────────────────────────
function ModeChips<T extends string>({ value, options, onChange, accent }: {
  value:T; options:{val:T;label:string;sub:string}[]; onChange:(v:T)=>void; accent:string;
}) {
  return (
    <div style={{ display:'flex', gap:6 }}>
      {options.map(o => (
        <button key={o.val} onClick={() => onChange(o.val)} style={{
          flex:1, padding:'6px 4px', borderRadius:8, border:'none', cursor:'pointer', fontSize:10,
          fontWeight:700, textTransform:'uppercase' as const, letterSpacing:'0.3px',
          backgroundColor: value===o.val ? accent+'33' : '#0a1209',
          color: value===o.val ? accent : C.muted,
          outline: `1.5px solid ${value===o.val ? accent : C.border}`,
        }}>
          <div>{o.label}</div>
          <div style={{ fontSize:9, fontWeight:400, marginTop:2, opacity:0.8 }}>{o.sub}</div>
        </button>
      ))}
    </div>
  );
}

// ─── Stat chip ────────────────────────────────────────────────────────────────
function Stat({ icon, label, value, color }: { icon:string; label:string; value:string|number; color:string }) {
  return (
    <div style={{ backgroundColor:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:'9px 12px', display:'flex', alignItems:'center', gap:8, flex:1 }}>
      <span style={{ fontSize:18 }}>{icon}</span>
      <div>
        <div style={{ fontSize:9, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.5px' }}>{label}</div>
        <div style={{ fontSize:17, fontWeight:800, color }}>{value}</div>
      </div>
    </div>
  );
}

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

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh', fontFamily:"'DM Sans','Segoe UI',sans-serif", color:C.text, paddingBottom:40 }}>

      <ScreenHeader title="Data Sync" back={() => navigate('/')}
        subtitle={<span style={{ color:C.gold, fontWeight:700, letterSpacing:'1px', fontSize:10 }}>QCA PORTAL</span>}
        actions={<HeaderIconButton label="Settings" onClick={() => navigate('/settings')}>⚙️</HeaderIconButton>} />

      <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:12 }}>

        {/* Server info */}
        <div style={{ backgroundColor:C.card, borderRadius:12, padding:'11px 14px', border:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:18 }}>🖥️</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.text, wordBreak:'break-all' }}>
              {localStorage.getItem(LS.ip) || <span style={{ color:C.red }}>Not configured</span>}
            </div>
            <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
              {localStorage.getItem(LS.user)||'—'} · {localStorage.getItem(LS.pass) ? '●●● set' : <span style={{color:C.red}}>no password</span>}
            </div>
          </div>
          <button onClick={() => navigate('/settings')} style={{ background:'none', border:`1px solid ${C.border}`, color:C.muted, borderRadius:8, padding:'5px 10px', cursor:'pointer', fontSize:11 }}>Edit</button>
        </div>

        {/* Stats */}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <Stat icon="👨‍🎓" label="Students"  value={stuCount}       color={C.gold} />
          <Stat icon="⬆"   label="Pending"   value={pendCount}      color={pendCount > 0 ? C.red : '#4caf77'} />
          <Stat icon="📋"   label="Hager DB"  value={hagCount}       color={C.blue} />
          <Stat icon="💰"   label="Payments"  value={paymentsCount}  color='#27ae60' />
        </div>

        {/* ═══════════════════════════════════════════════════════
            SECTION A — DATA DOWNLOAD (server → mobile)
        ═══════════════════════════════════════════════════════ */}
        {/* ── Full Refresh — see Settings page ── */}
        <div style={{ backgroundColor:'#f0fdf4', borderRadius:12, padding:'14px',
          border:'1px solid #86efac', marginBottom:4 }}>
          <div style={{ fontWeight:800, fontSize:14, color:'#166534', marginBottom:4 }}>
            🔄 Full Refresh
          </div>
          <div style={{ fontSize:12, color:'#6b7280', marginBottom:8 }}>
            Full Refresh is available in <strong>Settings</strong>.
            It clears all local data and re-downloads from server based on your role.
          </div>
          <button onClick={() => window.location.hash = '/settings'}
            style={{ padding:'10px 18px', borderRadius:8, border:'none',
              backgroundColor:'#166534', color:'#fff', fontWeight:700,
              fontSize:13, cursor:'pointer' }}>
            → Go to Settings
          </button>
        </div>

                {/* ── Sync validation check — available to all ── */}
        <div style={{ backgroundColor:'#f8f9fa', borderRadius:12, padding:'14px', border:'1px solid #e5e7eb' }}>
          <div style={{ fontWeight:800, fontSize:14, marginBottom:6, color:'#111827' }}>
            🔍 Sync Validation
          </div>
          <div style={{ fontSize:12, color:'#6b7280', marginBottom:10 }}>
            Compare local records with server to verify sync is working.
          </div>
          <button onClick={async () => {
            setCheckLoading(true); setSyncCheck(null); setRepairMsg('');
            try {
              const results = await checkSyncStatus(base);
              setSyncCheck(results);
            } catch(e) {
              setSyncCheck([{table:'Error', local:0, server:0, match:false}]);
            }
            setCheckLoading(false);
          }}
            style={{ width:'100%', padding:'10px', borderRadius:8, border:'none',
              backgroundColor:'#0d1b2a', color:'#c5a059', cursor:'pointer',
              fontWeight:800, fontSize:13, marginBottom: syncCheck ? 10 : 0 }}>
            {checkLoading ? '⏳ Checking…' : '🔍 Check Now'}
          </button>
          {syncCheck && (
            <div style={{ marginTop:8 }}>
              {syncCheck.map(row => (
                <div key={row.table} style={{ padding:'8px 10px', borderRadius:8, marginBottom:4,
                  backgroundColor: row.match ? '#f0fdf4' : '#fee2e2',
                  border: `1px solid ${row.match ? '#86efac' : '#fca5a5'}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span style={{ fontSize:13, fontWeight:700, color:'#111827' }}>{row.table}</span>
                    <span style={{ fontSize:12, color: row.match ? '#166534' : '#dc2626', fontWeight:800 }}>
                      {row.match
                        ? `✅ Local: ${row.local} = Server: ${row.server}`
                        : `⚠ Local: ${row.local} | Server: ${row.server}`}
                    </span>
                  </div>
                  {row.detail && (
                    <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{row.detail}</div>
                  )}
                </div>
              ))}

              {/* Repair button — shown if any row needs fixing */}
              {syncCheck.some(r => r.canRepair) && (
                <div style={{ marginTop:8 }}>
                  <button disabled={repairing} onClick={async () => {
                    setRepairing(true); setRepairMsg('');
                    const result = await repairAttendance(msg => setRepairMsg(msg));
                    setRepairing(false);
                    if (result.error) {
                      setRepairMsg(`⚠ ${result.error}`);
                    } else {
                      setRepairMsg(`✅ Added ${result.added}, removed ${result.removed}`);
                      // Re-check after repair
                      try {
                        const results = await checkSyncStatus(base);
                        setSyncCheck(results);
                      } catch {}
                    }
                  }}
                    style={{ width:'100%', padding:'10px', borderRadius:8, border:'none',
                      backgroundColor: repairing ? '#9ca3af' : '#b45309', color:'#fff',
                      fontWeight:800, fontSize:13, cursor: repairing ? 'default' : 'pointer' }}>
                    {repairing ? '⏳ Syncing missing records…' : '🔧 Sync Missing Attendance'}
                  </button>
                  {repairMsg && (
                    <div style={{ fontSize:12, color:'#374151', marginTop:6, textAlign:'center' as const }}>
                      {repairMsg}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Full sync controls — admin/coach only ── */}
        {isAdminOrCoach && (can('sync:students') || can('sync:download') || can('sync:payments')) && (
          <div style={{ marginBottom:4 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:2 }}>
              <div style={{ height:1, flex:1, backgroundColor:C.border }} />
              <span style={{ fontSize:10, fontWeight:800, color:C.gold, letterSpacing:'1.5px', textTransform:'uppercase' as const }}>
                ⬇ Download from Server
              </span>
              <div style={{ height:1, flex:1, backgroundColor:C.border }} />
            </div>

            {/* Students */}
            {can('sync:students') && <OpCard icon="👨‍🎓" title="Get Students" desc="Download student roster from server" accent={C.gold} phase={stuPhase} onRun={runStudents}>
              <ModeChips value={stuMode} onChange={setStuMode} accent={C.gold} options={[
                { val:'incremental', label:'Incremental', sub:'New since last sync' },
                { val:'latest',      label:'Latest',      sub:'Most recent batch' },
                { val:'full',        label:'Full',        sub:'Re-download all' },
              ]} />
              {stuMode === 'full' && (
                <div style={{ marginTop:8, padding:'7px 10px', borderRadius:8, backgroundColor:C.red+'18', border:`1px solid ${C.red}44`, fontSize:11, color:C.red }}>
                  ⚠ Full resets sync cursor — re-downloads all students
                </div>
              )}
            </OpCard>}

            {/* Hager */}
            {can('sync:download') && <OpCard icon="📋" title="Hager Register" desc="Mirror full attendance history from server" accent={C.blue} phase={hagPhase} onRun={runHager}>
              <ModeChips value={hagMode} onChange={setHagMode} accent={C.blue} options={[
                { val:'smart', label:'Smart', sub: hagCount > 0 ? `Has ${hagCount} rows — fetch new only` : 'Auto full if empty' },
                { val:'full',  label:'Full',  sub:'Wipe + re-download all' },
              ]} />
              {hagMode === 'full' && (
                <div style={{ marginTop:8, padding:'7px 10px', borderRadius:8, backgroundColor:C.red+'18', border:`1px solid ${C.red}44`, fontSize:11, color:C.red }}>
                  ⚠ Full wipes hist_attendance — safe, server is the source of truth
                </div>
              )}
            </OpCard>}

            {/* Payments */}
            {can('sync:payments') && <OpCard icon="💰" title="Payments & Fees" desc="Sync payment history and fee dues" accent="#27ae60" phase={payPhase} onRun={runPayments}>
              <ModeChips value={payMode} onChange={setPayMode} accent="#27ae60" options={[
                { val:'smart', label:'Smart', sub: paymentsCount > 0 ? `Has ${paymentsCount} rows — fetch new only` : 'Auto full if empty' },
                { val:'full',  label:'Full',  sub:'Re-download all payments' },
              ]} />
            </OpCard>}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
            SECTION B — DATA UPLOAD (mobile → server)
        ═══════════════════════════════════════════════════════ */}
        {(can('sync:upload') || can('sync:reupload')) && (
          <div style={{ marginBottom:4 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:2 }}>
              <div style={{ height:1, flex:1, backgroundColor:C.border }} />
              <span style={{ fontSize:10, fontWeight:800, color:'#16a085', letterSpacing:'1.5px', textTransform:'uppercase' as const }}>
                ⬆ Upload to Server
              </span>
              <div style={{ height:1, flex:1, backgroundColor:C.border }} />
            </div>

            {/* Upload attendance */}
            {can('sync:upload') && <OpCard icon="⬆" title="Upload Attendance" desc={`Push ${pendCount} unsynced coach record(s) to server`} accent={C.teal} phase={upPhase} onRun={runUpload} />}

            {/* Re-upload by date */}
            {can('sync:reupload') && <div style={{ backgroundColor:C.card, borderRadius:14, border:`1.5px solid ${reupPhase !== 'idle' ? '#8e44ad' : C.border}`, overflow:'hidden' }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 14px 10px' }}>
                <span style={{ fontSize:22 }}>🔄</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:C.text }}>Re-upload by Date</div>
                  <div style={{ fontSize:11, color:C.muted, marginTop:1 }}>Force re-send a specific date — replaces your previous upload on server</div>
                </div>
              </div>
              <div style={{ padding:'0 14px 14px', display:'flex', flexDirection:'column' as const, gap:10 }}>
                <div>
                  <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:6, fontWeight:700 }}>Select Date</div>
                  {availDates.length === 0 ? (
                    <div style={{ fontSize:12, color:C.muted, padding:'8px 0' }}>No attendance recorded locally yet</div>
                  ) : (
                    <div style={{ display:'flex', flexWrap:'wrap' as const, gap:6 }}>
                      {availDates.map(d => (
                        <button key={d} onClick={() => handleReupDateChange(reupDate === d ? '' : d)} style={{
                          padding:'5px 10px', borderRadius:8, border:'none', cursor:'pointer',
                          fontSize:12, fontWeight:700,
                          backgroundColor: reupDate === d ? '#8e44ad33' : '#0a1209',
                          color: reupDate === d ? '#c39bd3' : C.muted,
                          outline: `1.5px solid ${reupDate === d ? '#8e44ad' : C.border}`,
                        }}>{d}</button>
                      ))}
                    </div>
                  )}
                </div>
                {reupDate && reupSessions.length > 0 && (
                  <div>
                    <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:6, fontWeight:700 }}>Sessions</div>
                    <div style={{ display:'flex', gap:8 }}>
                      {reupSessions.map(sess => {
                        const active = reupSelected.has(sess);
                        return (
                          <button key={sess} onClick={() => toggleReupSession(sess)} style={{
                            flex:1, padding:'8px 0', borderRadius:8, border:'none', cursor:'pointer',
                            fontWeight:800, fontSize:13,
                            backgroundColor: active ? '#8e44ad33' : '#0a1209',
                            color: active ? '#c39bd3' : C.muted,
                            outline: `1.5px solid ${active ? '#8e44ad' : C.border}`,
                          }}>{active ? '✔ ' : ''}{sess}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {reupDate && reupSessions.length === 0 && (
                  <div style={{ fontSize:12, color:C.muted }}>No sessions found for {reupDate}</div>
                )}
                {reupDate && reupSessions.length > 0 && (
                  <button onClick={runReupload} disabled={reupPhase === 'running' || reupSelected.size === 0} style={{
                    width:'100%', padding:'11px', borderRadius:10, border:'none',
                    backgroundColor: reupPhase === 'running' ? C.border : reupPhase === 'done' ? '#4caf77' : reupPhase === 'error' ? C.red : '#8e44ad',
                    color:'#fff', fontWeight:800, fontSize:13,
                    cursor: reupPhase === 'running' ? 'not-allowed' : 'pointer',
                    boxShadow: reupPhase === 'running' ? 'none' : '0 3px 10px #8e44ad55',
                  }}>
                    {reupPhase === 'running' ? '⏳  Re-uploading…' : reupPhase === 'done' ? '✔  Done — Re-upload again' : reupPhase === 'error' ? '⚠  Error — Retry' : `🔄  Re-upload ${reupDate}`}
                  </button>
                )}
              </div>
            </div>}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
            OPERATION LOG
        ═══════════════════════════════════════════════════════ */}
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:2 }}>
          <div style={{ height:1, flex:1, backgroundColor:C.border }} />
          <span style={{ fontSize:10, fontWeight:800, color:C.muted, letterSpacing:'1.5px', textTransform:'uppercase' as const }}>
            📋 Operation Log
          </span>
          <div style={{ height:1, flex:1, backgroundColor:C.border }} />
        </div>
        <LogView lines={log} />

        {/* Run All — only shown if user has permission */}
        {can('sync:runall') && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
              <div style={{ height:1, flex:1, backgroundColor:C.border }} />
              <span style={{ fontSize:10, fontWeight:800, color:'#4caf77', letterSpacing:'1.5px', textTransform:'uppercase' as const }}>
                ⚡ Quick Actions
              </span>
              <div style={{ height:1, flex:1, backgroundColor:C.border }} />
            </div>
            <button onClick={runAll} disabled={anyRunning} style={{
              width:'100%', padding:16, borderRadius:13, border:'none',
              backgroundColor: anyRunning ? C.border : C.green,
              color: anyRunning ? C.muted : '#fff',
              fontWeight:800, fontSize:14, letterSpacing:'0.8px',
              cursor: anyRunning ? 'not-allowed' : 'pointer',
              boxShadow: anyRunning ? 'none' : `0 4px 16px ${C.green}66`,
            }}>
              {anyRunning ? '⏳  Running…' : '▶▶  RUN ALL OPERATIONS'}
            </button>
          </>
        )}

        {/* Timestamps */}
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
          {lastStu      && <div style={{ fontSize:11, color:C.muted, textAlign:'center' }}>Last student sync: <span style={{ color:C.text }}>{lastStu}</span></div>}
          {lastHag      && <div style={{ fontSize:11, color:C.muted, textAlign:'center' }}>Last Hager pull: <span style={{ color:C.text }}>{lastHag}</span></div>}
          {lastPayments && <div style={{ fontSize:11, color:C.muted, textAlign:'center' }}>Last payments sync: <span style={{ color:C.text }}>{lastPayments}</span></div>}
        </div>

        {/* Nav shortcuts */}
        <div style={{ display:'flex', gap:8 }}>
          {[{l:'👨‍🎓 Students',p:'/students'},{l:'📊 Dashboard',p:'/dashboard'},{l:'✅ Attendance',p:'/attendance'}].map(n => (
            <button key={n.p} onClick={() => navigate(n.p)} style={{ flex:1, padding:'10px 4px', borderRadius:10, border:`1px solid ${C.border}`, backgroundColor:C.card, color:C.muted, cursor:'pointer', fontSize:11, fontWeight:600 }}>
              {n.l}
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}
