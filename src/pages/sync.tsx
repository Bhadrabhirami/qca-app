import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  syncAllStudents, getStudentCount,
  getUnsyncedAttendance, markAttendanceSynced, getPendingUploadCount,
  getPendingTempStudents, resolveTempStudent,
} from '../database/db';
import ScreenHeader from '../shared/ScreenHeader';
import { usePermissions } from './usePermissions';
import { apiAuthHeaders } from './apiHeaders';

// Quick sync: the two everyday jobs (student roster down, attendance up).
// Uses the same /api/data endpoints, JWT auth and upload rules as the full
// Sync screen (Syncscreen.tsx) — keep the two in step.

// Fetch with timeout — prevents hanging requests
const fetchT = (url: string, opts: RequestInit = {}, ms = 30000): Promise<Response> => {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
};

const C = { green: '#1a472a', gold: '#d4af37', bg: '#f4f7f6', border: '#e8e8e8', gray: '#888', red: '#c0392b', amber: '#e67e22' };

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogEntry { time: string; level: 'info'|'ok'|'warn'|'error'; text: string; }
type ActionState = 'idle'|'running'|'done'|'error';

interface SummaryData {
  title:   string;
  icon:    string;
  status:  'success'|'error';
  entries: LogEntry[];
  duration: string;
}

const ts = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const buildBaseUrl = (ip: string): string => {
  const clean = (ip || '').trim().replace(/\/+$/, '');
  return clean.startsWith('http') ? clean : `http://${clean}`;
};

/** Signed in with a live token? (the server accepts nothing else) */
const hasLiveToken = () =>
  !!localStorage.getItem('jwt_token') &&
  Date.now() < parseInt(localStorage.getItem('jwt_expiry') || '0', 10);

// ─── Summary popup ────────────────────────────────────────────────────────────

function SummaryModal({ data, onClose }: { data: SummaryData; onClose: () => void }) {
  const color: Record<string, string> = { info: C.gray, ok: C.green, warn: C.amber, error: C.red };
  const prefix: Record<string, string> = { info: '›', ok: '✔', warn: '⚠', error: '✖' };
  return (
    <div style={M.overlay} onClick={onClose}>
      <div style={M.sheet} onClick={e => e.stopPropagation()}>
        <div style={{ ...M.header, backgroundColor: data.status === 'success' ? C.green : C.red }}>
          <span style={{ fontSize: 24 }}>{data.icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={M.headerTitle}>{data.title}</p>
            <p style={M.headerSub}>
              {data.status === 'success' ? 'Completed' : 'Failed'} · {data.duration}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={M.closeBtn}>✕</button>
        </div>
        <div style={M.logPane}>
          {data.entries.map((e, i) => (
            <div key={i} style={M.logRow}>
              <span style={{ width: 14, flexShrink: 0, fontWeight: 700, color: color[e.level] }}>{prefix[e.level]}</span>
              <span style={{ flex: 1, color: color[e.level] }}>{e.text}</span>
              <span style={M.logTime}>{e.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Action row ───────────────────────────────────────────────────────────────

function ActionRow({
  icon, title, meta, accent, state, disabled, onPress, onViewLog, lastLog,
}: {
  icon: string; title: string; meta: string; accent: string; state: ActionState;
  disabled?: string; onPress: () => void; onViewLog: () => void; lastLog: SummaryData | null;
}) {
  const running = state === 'running';
  const status = state === 'done' ? { t: '✔ Done', c: C.green }
               : state === 'error' ? { t: '✖ Failed', c: C.red } : null;
  return (
    <div style={{ padding: '10px 12px', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 22, width: 28, textAlign: 'center' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#222' }}>{title}</div>
          <div style={{ fontSize: 11.5, color: disabled ? C.red : C.gray, marginTop: 1 }}>{disabled || meta}</div>
          {lastLog && (
            <button onClick={onViewLog} style={S.logLink}>
              {status && <b style={{ color: status.c }}>{status.t}</b>} · View log ›
            </button>
          )}
        </div>
        <button onClick={onPress} disabled={running || !!disabled}
          style={{ ...S.runBtn, backgroundColor: running || disabled ? '#c8c8c8' : accent,
            cursor: running || disabled ? 'not-allowed' : 'pointer' }}>
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      {running && <div style={S.progressBar}><div style={{ ...S.progressFill, backgroundColor: accent }} /></div>}
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function SyncScreen() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const serverIp = localStorage.getItem('server_ip') || '';
  const authUser = localStorage.getItem('auth_user') || '';
  const [studentCount, setStudentCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  const [dlState, setDlState] = useState<ActionState>('idle');
  const [ulState, setUlState] = useState<ActionState>('idle');
  const [dlLog,   setDlLog]   = useState<SummaryData | null>(null);
  const [ulLog,   setUlLog]   = useState<SummaryData | null>(null);
  const [showLog, setShowLog] = useState<SummaryData | null>(null);

  const refreshCounts = async () => {
    setStudentCount(await getStudentCount());
    setPendingCount(await getPendingUploadCount());
  };
  useEffect(() => { refreshCounts(); }, []);

  /** Shared runner: timing, log, state and summary for one action. */
  const run = async (
    title: string, icon: string,
    setState: (s: ActionState) => void, setLast: (d: SummaryData | null) => void,
    body: (log: (l: LogEntry['level'], t: string) => void, base: string) => Promise<void>,
  ) => {
    const start = Date.now();
    const entries: LogEntry[] = [];
    const log = (level: LogEntry['level'], text: string) => entries.push({ time: ts(), level, text });
    setState('running'); setLast(null);
    let ok = true;
    try {
      if (!serverIp) throw new Error('No server configured — set it in Settings');
      if (!hasLiveToken()) throw new Error('Session expired — sign in again, then retry');
      await body(log, buildBaseUrl(serverIp));
    } catch (err: any) {
      ok = false;
      const msg = err?.name === 'AbortError' ? 'Server did not respond in time' : (err?.message ?? String(err));
      if (/failed to fetch|network/i.test(msg)) log('warn', 'Network error — check Wi-Fi / server address');
      log('error', msg);
    }
    await refreshCounts();
    const summary: SummaryData = {
      title, icon, status: ok ? 'success' : 'error', entries,
      duration: `${((Date.now() - start) / 1000).toFixed(1)}s`,
    };
    setState(ok ? 'done' : 'error'); setLast(summary); setShowLog(summary);
  };

  // ── Download Students (full roster) ──────────────────────────────────────
  const downloadStudents = () => run('Download Students', '📥', setDlState, setDlLog, async (log, base) => {
    log('info', `Connecting to ${base}…`);
    const res = await fetchT(`${base}/api/data/students?since_id=0&limit=50000`, { headers: apiAuthHeaders(false) });
    if (res.status === 401) throw new Error('Unauthorized — sign in again');
    if (res.status === 403) throw new Error('Your role is not allowed to download students');
    if (!res.ok) throw new Error(`Server responded with HTTP ${res.status}`);

    const data: any[] = (await res.json()).data || [];
    log('ok', `Received ${data.length} student records`);
    if (data.length === 0) { log('warn', 'Server returned 0 students — nothing saved'); return; }

    await syncAllStudents(data);
    const active = data.filter((s: any) => s.status === 'Active').length;
    log('ok', `Saved ${data.length} students (${active} active, ${data.length - active} other)`);

    // Keep the incremental sync's bookmark in step with what we now hold
    const maxId  = Math.max(...data.map((s: any) => s.id ?? 0));
    const lastId = parseInt(localStorage.getItem('last_sync_student_id') || '0', 10);
    if (maxId > lastId) localStorage.setItem('last_sync_student_id', String(maxId));
    localStorage.setItem('last_sync_time', new Date().toLocaleString());
  });

  // ── Upload Attendance ────────────────────────────────────────────────────
  const uploadAttendance = () => run('Upload Attendance', '📤', setUlState, setUlLog, async (log, base) => {
    const headers = apiAuthHeaders();

    // 1. Temp students must exist on the server before their attendance can go up
    const temps = await getPendingTempStudents();
    for (const tmp of temps) {
      log('info', `Registering new student ${tmp.name}…`);
      const r = await fetchT(`${base}/api/data/students/register`, {
        method: 'POST', headers,
        body: JSON.stringify({
          name: tmp.name, date_of_birth: tmp.date_of_birth, status: tmp.status,
          student_category: tmp.student_category, enrollment_date: tmp.enrollment_date,
        }),
      });
      const j = await r.json().catch(() => ({}));
      const serverId = j.student_id ?? j.id;
      if (!r.ok || !serverId) { log('warn', `Could not register ${tmp.name}: ${j.error || 'HTTP ' + r.status} — their records stay pending`); continue; }
      await resolveTempStudent(tmp.temp_id, serverId);
      log('ok', `${tmp.name} registered (ID ${serverId})`);
    }

    // 2. Pending attendance (temp students that failed to register stay local)
    const unsync = (await getUnsyncedAttendance()).filter((r: any) => r.student_id > 0);
    if (unsync.length === 0) { log('ok', 'Nothing to upload — all records are synced'); return; }

    const records = unsync.map((r: any) => ({
      student_id: r.student_id,
      date:       r.attendance_date,
      session:    r.session_type,
      status:     (r.status === 1 || r.status === '1') ? 'PRESENT' : 'ABSENT',
    }));
    const groups = new Map<string, number>();
    records.forEach(r => groups.set(`${r.date} ${r.session}`, (groups.get(`${r.date} ${r.session}`) ?? 0) + 1));
    groups.forEach((n, k) => log('info', `${k}: ${n} record${n === 1 ? '' : 's'}`));
    const present = records.filter(r => r.status === 'PRESENT').length;
    log('info', `Uploading ${records.length} (present ${present}, absent ${records.length - present})…`);

    const res = await fetchT(`${base}/api/data/upload/attendance`, {
      method: 'POST', headers, body: JSON.stringify({ temp_attendance: records }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      // Never mark synced on failure — records stay pending and re-uploading is safe
      throw new Error(`Upload failed (${res.status}): ${e.error ?? e.message ?? res.statusText} — records kept pending`);
    }
    const body = await res.json().catch(() => ({}));
    if (body.replaced) log('info', `Server replaced ${body.replaced} earlier row(s) from you`);
    log('ok', `${body.inserted ?? records.length} record(s) saved on server`);

    await markAttendanceSynced(unsync.map((r: any) => r.session_id));
    log('ok', `Marked ${unsync.length} local record(s) as synced`);
  });

  const canUpload = can('sync:upload');

  return (
    <div style={S.page}>
      <ScreenHeader title="Quick Sync" subtitle="Students down · attendance up" />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Server + local DB */}
        <div style={S.card}>
          <div style={S.infoRow}>
            <span style={S.infoLabel}>Server</span>
            <span style={{ ...S.infoValue, color: serverIp ? '#333' : C.red }}>{serverIp || 'Not configured'}</span>
            <button onClick={() => navigate('/settings')} style={S.configBtn}>Configure</button>
          </div>
          <div style={{ ...S.infoRow, borderTop: `1px solid ${C.border}` }}>
            <span style={S.infoLabel}>User</span>
            <span style={S.infoValue}>{authUser || '—'}</span>
            <span style={{ fontSize: 11.5, color: C.gray, whiteSpace: 'nowrap' }}>
              📋 {studentCount} · <b style={{ color: pendingCount ? C.amber : C.green }}>⏳ {pendingCount}</b>
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={S.card}>
          <ActionRow
            icon="📥" title="Download Students" accent={C.green} state={dlState}
            meta={studentCount > 0 ? `Full roster refresh · ${studentCount} on this device` : 'Device has no students yet'}
            onPress={downloadStudents} onViewLog={() => dlLog && setShowLog(dlLog)} lastLog={dlLog}
          />
          <div style={{ height: 1, backgroundColor: C.border }} />
          <ActionRow
            icon="📤" title="Upload Attendance" accent={C.green} state={ulState}
            disabled={canUpload ? undefined : '🔒 Your role cannot upload attendance'}
            meta={pendingCount > 0 ? `${pendingCount} record${pendingCount === 1 ? '' : 's'} waiting to upload` : 'All records synced ✔'}
            onPress={uploadAttendance} onViewLog={() => ulLog && setShowLog(ulLog)} lastLog={ulLog}
          />
        </div>

        <button onClick={() => navigate('/syncscreen')} style={S.moreLink}>
          More sync options (payments, history, repair) ›
        </button>
      </div>

      {showLog && <SummaryModal data={showLog} onClose={() => setShowLog(null)} />}

      <style>{`@keyframes qs-slide { 0%{width:5%} 50%{width:80%} 100%{width:95%} }`}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:        { backgroundColor: C.bg, minHeight: '100%', fontFamily: 'sans-serif', paddingBottom: 24 },
  card:        { backgroundColor: '#fff', borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' },
  infoRow:     { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', minHeight: 36 },
  infoLabel:   { width: 46, flexShrink: 0, fontSize: 10, fontWeight: 800, color: C.gray, letterSpacing: '0.8px', textTransform: 'uppercase' },
  infoValue:   { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  configBtn:   { backgroundColor: '#f0f4f0', color: C.green, border: 'none', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  runBtn:      { flexShrink: 0, color: '#fff', border: 'none', borderRadius: 9, padding: '8px 16px', fontWeight: 800, fontSize: 13 },
  logLink:     { background: 'none', border: 'none', padding: '3px 0 0', fontSize: 11.5, color: C.gray, cursor: 'pointer' },
  progressBar: { height: 3, backgroundColor: C.border, borderRadius: 2, overflow: 'hidden', marginTop: 8 },
  progressFill:{ height: '100%', borderRadius: 2, animation: 'qs-slide 2s ease-in-out infinite' },
  moreLink:    { background: 'none', border: 'none', color: C.green, fontWeight: 700, fontSize: 12.5, padding: '6px', cursor: 'pointer' },
};

const M: Record<string, React.CSSProperties> = {
  overlay:     { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', zIndex: 2000 },
  sheet:       { backgroundColor: '#fff', width: '100%', maxHeight: '80vh', borderRadius: '16px 16px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' },
  header:      { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', flexShrink: 0 },
  headerTitle: { color: '#fff', fontWeight: 800, fontSize: 15, margin: 0 },
  headerSub:   { color: 'rgba(255,255,255,0.75)', fontSize: 11.5, margin: '2px 0 0' },
  closeBtn:    { background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)', fontSize: 20, cursor: 'pointer' },
  logPane:     { flex: 1, overflowY: 'auto', padding: '8px 14px 14px' },
  logRow:      { display: 'flex', gap: 6, padding: '4px 0', borderBottom: '1px solid #f3f3f3', fontSize: 12.5, lineHeight: 1.35 },
  logTime:     { fontSize: 10.5, color: C.gray, flexShrink: 0, fontFamily: 'monospace', marginTop: 2 },
};
