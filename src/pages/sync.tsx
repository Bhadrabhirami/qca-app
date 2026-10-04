import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Fetch with timeout — prevents hanging requests
const fetchT = (url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> => {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetchT(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
};


import {
  syncAllStudents, getStudentCount,
  getUnsyncedAttendance, markAttendanceSynced, getPendingUploadCount,
} from '../database/db';
import ScreenHeader from '../shared/ScreenHeader';

const C = { green: '#1a472a', gold: '#d4af37', bg: '#f4f7f6', border: '#e8e8e8', gray: '#888' };

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

// ─── Summary popup ────────────────────────────────────────────────────────────

function SummaryModal({ data, onClose }: { data: SummaryData; onClose: () => void }) {
  const iconColor: Record<string, string> = {
    info: C.gray, ok: C.green, warn: '#e67e22', error: '#c0392b',
  };
  const prefix: Record<string, string> = {
    info: '  ›', ok: '  ✔', warn: '  ⚠', error: '  ✖',
  };
  return (
    <div style={M.overlay} onClick={onClose}>
      <div style={M.sheet} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          ...M.header,
          backgroundColor: data.status === 'success' ? C.green : '#c0392b',
        }}>
          <span style={M.headerIcon}>{data.icon}</span>
          <div style={{ flex: 1 }}>
            <p style={M.headerTitle}>{data.title}</p>
            <p style={M.headerSub}>
              {data.status === 'success' ? 'Completed successfully' : 'Completed with errors'}
              &nbsp;·&nbsp;{data.duration}
            </p>
          </div>
          <button onClick={onClose} style={M.closeBtn}>✕</button>
        </div>

        {/* Log lines */}
        <div style={M.logPane}>
          <p style={M.logHeader}>OPERATION LOG</p>
          {data.entries.map((e, i) => (
            <div key={i} style={M.logRow}>
              <span style={{ ...M.logPrefix, color: iconColor[e.level] }}>
                {prefix[e.level]}
              </span>
              <span style={{ ...M.logText, color: iconColor[e.level] }}>{e.text}</span>
              <span style={M.logTime}>{e.time}</span>
            </div>
          ))}
        </div>

        <button onClick={onClose} style={M.doneBtn}>Close</button>
      </div>
    </div>
  );
}

// ─── Action card ──────────────────────────────────────────────────────────────

function ActionCard({
  icon, title, description, accent, state, meta,
  onPress, onViewLog, lastLog,
}: {
  icon: string; title: string; description: string; accent: string;
  state: ActionState; meta: string;
  onPress: () => void; onViewLog: () => void; lastLog: SummaryData | null;
}) {
  const stateLabel: Record<ActionState, string> = {
    idle:    '', running: 'Running…', done: 'Done', error: 'Failed',
  };
  const stateColor: Record<ActionState, string> = {
    idle: C.gray, running: '#e67e22', done: C.green, error: '#c0392b',
  };

  return (
    <div style={{ ...AC.card, borderLeft: `5px solid ${accent}` }}>
      <div style={AC.top}>
        <span style={{ fontSize: '36px' }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <p style={AC.title}>{title}</p>
          <p style={AC.desc}>{description}</p>
          <p style={{ ...AC.meta, color: C.gold }}>{meta}</p>
        </div>
      </div>
      {state === 'running' && (
        <div style={AC.progressBar}>
          <div style={{ ...AC.progressFill, backgroundColor: accent }} />
        </div>
      )}
      <div style={AC.btnRow}>
        <button
          style={{
            ...AC.mainBtn,
            backgroundColor: state === 'running' ? '#ccc' : accent,
            cursor: state === 'running' ? 'not-allowed' : 'pointer',
          }}
          disabled={state === 'running'}
          onClick={onPress}
        >
          {state === 'running' ? 'RUNNING…' : title.toUpperCase()}
        </button>
        {lastLog && (
          <button onClick={onViewLog} style={AC.logBtn}>
            <span style={{ color: stateColor[state], fontWeight: '700', marginRight: '5px' }}>
              {stateLabel[state] || '✔ Done'}
            </span>
            View Log ›
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function SyncScreen() {
  const navigate  = useNavigate();
  const [serverIp, setServerIp] = useState('Not Configured');
  const [authUser, setAuthUser] = useState('Guest');
  const [studentCount,  setStudentCount]  = useState(0);
  const [pendingCount,  setPendingCount]  = useState(0);

  const [dlState,  setDlState]  = useState<ActionState>('idle');
  const [ulState,  setUlState]  = useState<ActionState>('idle');
  const [dlLog,    setDlLog]    = useState<SummaryData | null>(null);
  const [ulLog,    setUlLog]    = useState<SummaryData | null>(null);
  const [showLog,  setShowLog]  = useState<SummaryData | null>(null);

  useEffect(() => {
    setServerIp(localStorage.getItem('server_ip') || 'Not Configured');
    setAuthUser(localStorage.getItem('auth_user') || 'Guest');
    refreshCounts();
  }, []);

  const refreshCounts = async () => {
    setStudentCount(await getStudentCount());
    setPendingCount(await getPendingUploadCount());
  };

  const ts = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const buildBaseUrl = (ip: string): string => {
    // Use server_ip exactly as stored — includes correct port already
    const clean = ip.trim().replace(/\/+$/, '');
    return clean.startsWith('http') ? clean : `http://${clean}`;
  };

  const headers = () => ({
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-User-ID': authUser,
    'Authorization': `Bearer ${localStorage.getItem('secret_key') || authUser}`,
  });

  // ── Download Students ────────────────────────────────────────────────────
  const downloadStudents = async () => {
    if (serverIp === 'Not Configured') {
      alert('Set server IP in Settings first.');
      return;
    }
    const start   = Date.now();
    const entries: LogEntry[] = [];
    const log = (level: LogEntry['level'], text: string) =>
      entries.push({ time: ts(), level, text });

    setDlState('running');
    setDlLog(null);

    try {
      log('info', `Connecting to ${serverIp}…`);
      const baseUrl = buildBaseUrl(serverIp);
      const res = await fetchT(`${baseUrl}/api/sync/students`, {
        method: 'GET', headers: headers(),
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error('Unauthorized — check credentials');
        throw new Error(`Server responded with HTTP ${res.status}`);
      }
      log('ok', `Server responded HTTP ${res.status}`);

      const result = await res.json();
      const data: any[] = result.data || result.students || result || [];
      log('info', `Received ${data.length} student records`);

      if (data.length === 0) {
        log('warn', 'Server returned 0 students — nothing saved');
      } else {
        log('info', 'Saving to local database…');
        await syncAllStudents(data);
        const active   = data.filter((s: any) => s.status === 'Active').length;
        const inactive = data.length - active;
        log('ok', `Saved ${data.length} students (${active} active, ${inactive} inactive)`);
      }

      await refreshCounts();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log('ok', `Download complete in ${elapsed}s`);

      setDlState('done');
      setDlLog({ title: 'Download Students', icon: '📥', status: 'success', entries, duration: `${elapsed}s` });
      setShowLog({ title: 'Download Students', icon: '📥', status: 'success', entries, duration: `${elapsed}s` });
    } catch (err: any) {
      log('error', err.message ?? String(err));
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const summary: SummaryData = { title: 'Download Students', icon: '📥', status: 'error', entries, duration: `${elapsed}s` };
      setDlState('error');
      setDlLog(summary);
      setShowLog(summary);
    }
  };

  // ── Upload Attendance ────────────────────────────────────────────────────
  const uploadAttendance = async () => {
    if (serverIp === 'Not Configured') {
      alert('Set server IP in Settings first.');
      return;
    }
    const start   = Date.now();
    const entries: LogEntry[] = [];
    const log = (level: LogEntry['level'], text: string) =>
      entries.push({ time: ts(), level, text });

    setUlState('running');
    setUlLog(null);

    try {
      log('info', 'Scanning local DB for unsynced records…');
      const unsync = await getUnsyncedAttendance();
      log(unsync.length === 0 ? 'warn' : 'info',
        `Found ${unsync.length} record${unsync.length !== 1 ? 's' : ''} pending upload`);

      if (unsync.length === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log('ok', 'Nothing to upload — all records are already synced');
        setUlState('done');
        const summary: SummaryData = { title: 'Upload Attendance', icon: '📤', status: 'success', entries, duration: `${elapsed}s` };
        setUlLog(summary);
        setShowLog(summary);
        return;
      }

      log('info', `Uploading ${unsync.length} records to ${serverIp}…`);
      const baseUrl = buildBaseUrl(serverIp);
      const res = await fetchT(`${baseUrl}/api/upload/attendance`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ attendance: unsync }),
      });

      if (!res.ok) {
        throw new Error(`Server responded with HTTP ${res.status}`);
      }
      log('ok', `Server accepted the upload (HTTP ${res.status})`);

      const ids = unsync.map((r: any) => r.session_id);
      await markAttendanceSynced(ids);
      log('ok', `Marked ${ids.length} records as synced in local DB`);

      // Breakdown by session type
      const bySession: Record<string, number> = {};
      unsync.forEach((r: any) => {
        bySession[r.session_type] = (bySession[r.session_type] || 0) + 1;
      });
      Object.entries(bySession).forEach(([s, n]) => log('info', `  ${s}: ${n} records`));

      const presentCount = unsync.filter((r: any) => r.status === 1).length;
      log('info', `  Present: ${presentCount}  |  Absent: ${unsync.length - presentCount}`);

      await refreshCounts();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log('ok', `Upload complete in ${elapsed}s`);

      setUlState('done');
      const summary: SummaryData = { title: 'Upload Attendance', icon: '📤', status: 'success', entries, duration: `${elapsed}s` };
      setUlLog(summary);
      setShowLog(summary);
    } catch (err: any) {
      log('error', err.message ?? String(err));
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const summary: SummaryData = { title: 'Upload Attendance', icon: '📤', status: 'error', entries, duration: `${elapsed}s` };
      setUlState('error');
      setUlLog(summary);
      setShowLog(summary);
    }
  };

  return (
    <div style={S.page}>
      <ScreenHeader title="Data Sync" subtitle="Quickies Cricket Academy" />

      {/* Server info card */}
      <div style={S.serverCard}>
        <div style={S.serverRow}>
          <span style={S.serverIcon}>🌐</span>
          <div>
            <p style={S.serverLabel}>SERVER</p>
            <p style={S.serverValue}>{serverIp}</p>
          </div>
          <button onClick={() => navigate('/settings')} style={S.configBtn}>Configure</button>
        </div>
        <div style={S.divider} />
        <div style={S.serverRow}>
          <span style={S.serverIcon}>👤</span>
          <div>
            <p style={S.serverLabel}>USER</p>
            <p style={S.serverValue}>{authUser}</p>
          </div>
          <div style={S.dbMeta}>
            <p style={S.dbMetaLine}>📋 {studentCount} students locally</p>
            <p style={S.dbMetaLine}>⏳ {pendingCount} records pending</p>
          </div>
        </div>
      </div>

      {/* Action cards */}
      <div style={S.cards}>
        <ActionCard
          icon="📥"
          title="Download Students"
          description="Pull the latest student roster from the server and update your local database."
          accent="#2a5a8a"
          state={dlState}
          meta={studentCount > 0 ? `${studentCount} students in local DB` : 'Local DB is empty'}
          onPress={downloadStudents}
          onViewLog={() => dlLog && setShowLog(dlLog)}
          lastLog={dlLog}
        />

        <ActionCard
          icon="📤"
          title="Upload Attendance"
          description="Push all locally recorded attendance that hasn't been synced to the server yet."
          accent={C.green}
          state={ulState}
          meta={pendingCount > 0 ? `${pendingCount} records pending upload` : 'All records synced ✔'}
          onPress={uploadAttendance}
          onViewLog={() => ulLog && setShowLog(ulLog)}
          lastLog={ulLog}
        />
      </div>

      {/* Summary popup */}
      {showLog && (
        <SummaryModal data={showLog} onClose={() => setShowLog(null)} />
      )}

      <style>{`
        @keyframes slide { 0%{width:5%} 50%{width:80%} 100%{width:95%} }
      `}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:        { backgroundColor: C.bg, minHeight: '100vh', fontFamily: 'sans-serif', paddingBottom: '40px' },
  header:      { backgroundColor: C.green, display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 18px', paddingTop: '50px' },
  backBtn:     { background: 'none', border: 'none', color: '#fff', fontSize: '26px', cursor: 'pointer', lineHeight: 1, padding: '4px' },
  headerTitle: { color: '#fff', fontWeight: '700', fontSize: '20px', margin: 0 },
  headerSub:   { color: C.gold, fontSize: '12px', margin: '2px 0 0 0', letterSpacing: '0.5px' },
  serverCard:  { margin: '16px', backgroundColor: '#fff', borderRadius: '14px', padding: '16px', boxShadow: '0 2px 6px rgba(0,0,0,0.08)' },
  serverRow:   { display: 'flex', alignItems: 'center', gap: '12px' },
  serverIcon:  { fontSize: '24px', flexShrink: 0 },
  serverLabel: { fontSize: '10px', fontWeight: '800', color: C.gray, letterSpacing: '1px', margin: 0, textTransform: 'uppercase' },
  serverValue: { fontSize: '14px', color: '#333', fontWeight: '600', margin: '2px 0 0 0' },
  configBtn:   { marginLeft: 'auto', backgroundColor: '#f0f4f0', color: C.green, border: 'none', borderRadius: '8px', padding: '6px 12px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' },
  divider:     { height: '1px', backgroundColor: C.border, margin: '12px 0' },
  dbMeta:      { marginLeft: 'auto', textAlign: 'right' },
  dbMetaLine:  { fontSize: '12px', color: C.gray, margin: '2px 0 0 0' },
  cards:       { padding: '0 16px', display: 'flex', flexDirection: 'column', gap: '14px' },
};

const AC: Record<string, React.CSSProperties> = {
  card:        { backgroundColor: '#fff', borderRadius: '14px', padding: '18px', boxShadow: '0 2px 6px rgba(0,0,0,0.08)' },
  top:         { display: 'flex', gap: '14px', alignItems: 'flex-start', marginBottom: '14px' },
  title:       { fontWeight: '700', fontSize: '17px', color: '#222', margin: 0 },
  desc:        { fontSize: '13px', color: C.gray, margin: '4px 0 6px 0', lineHeight: '1.4' },
  meta:        { fontSize: '12px', fontWeight: '600', margin: 0 },
  progressBar: { height: '4px', backgroundColor: C.border, borderRadius: '2px', overflow: 'hidden', marginBottom: '12px' },
  progressFill:{ height: '100%', borderRadius: '2px', animation: 'slide 2s ease-in-out infinite' },
  btnRow:      { display: 'flex', alignItems: 'center', gap: '10px' },
  mainBtn:     { flex: 1, color: '#fff', border: 'none', padding: '14px', borderRadius: '10px', fontWeight: '800', fontSize: '14px', letterSpacing: '0.5px' },
  logBtn:      { background: 'none', border: 'none', fontSize: '12px', color: C.gray, cursor: 'pointer', whiteSpace: 'nowrap', padding: '8px 4px' },
};

const M: Record<string, React.CSSProperties> = {
  overlay:     { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', zIndex: 2000 },
  sheet:       { backgroundColor: '#fff', width: '100%', maxHeight: '85vh', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header:      { display: 'flex', alignItems: 'center', gap: '12px', padding: '18px 18px 14px', flexShrink: 0 },
  headerIcon:  { fontSize: '32px' },
  headerTitle: { color: '#fff', fontWeight: '700', fontSize: '18px', margin: 0 },
  headerSub:   { color: 'rgba(255,255,255,0.75)', fontSize: '12px', margin: '3px 0 0 0' },
  closeBtn:    { marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: '22px', cursor: 'pointer' },
  logPane:     { flex: 1, overflowY: 'auto', padding: '16px 18px' },
  logHeader:   { fontSize: '10px', fontWeight: '800', color: C.gray, letterSpacing: '1.5px', margin: '0 0 10px 0' },
  logRow:      { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '5px 0', borderBottom: '1px solid #f5f5f5' },
  logPrefix:   { fontSize: '13px', fontWeight: '700', flexShrink: 0, width: '20px', marginTop: '1px' },
  logText:     { fontSize: '13px', flex: 1, lineHeight: '1.4' },
  logTime:     { fontSize: '11px', color: C.gray, flexShrink: 0, marginTop: '2px', fontFamily: 'monospace' },
  doneBtn:     { margin: '12px 18px 24px', backgroundColor: C.green, color: '#fff', border: 'none', padding: '15px', borderRadius: '12px', fontWeight: '700', fontSize: '15px', cursor: 'pointer', flexShrink: 0 },
};
