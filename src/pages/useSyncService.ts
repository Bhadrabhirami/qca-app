/**
 * useSyncService — Background sync engine
 *
 * DATA FLOW:
 *   Payments    → Server creates → sync pulls to local (read-only mirror)
 *   Write-offs  → Server creates → sync pulls to local (read-only mirror)
 *   Reversals   → Server updates is_active=0 → sync pulls updated row
 *   Students    → Server updates → sync pulls changed rows (updated_at strategy)
 *   Attendance  → Local creates (offline) → upload to server → sync pulls back
 *                 (ON CONFLICT UPDATE — idempotent, same data returns)
 *
 * STRATEGIES:
 *   students   → WHERE updated_at > last_sync_time  (handles edits + new)
 *   payments   → WHERE id > local_max_id            (append-only)
 *   attendance → WHERE id > local_max_id            (append-only)
 *   write_offs → WHERE id > local_max_id            (append + reversals via updated_at)
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  getDb,
  upsertPayments,
  getPaymentsMaxId,
  upsertPaymentSummaries,
  getPaymentSummaryCount,
  upsertWriteOffs,
  getWriteOffsMaxId,
  syncFeeCategories,
  backfillFeeTypeNames,
  saveDb,
  replaceSessionDays,
  applyAttendanceDeletions,
  getLocalAttendanceIds,
  removeLocalAttendanceByIds,
} from '../database/db';
import { isDataRestricted } from './usePermissions';

// ── Helpers ───────────────────────────────────────────────────────────────────
function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
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
async function apiFetch(url: string, opts?: RequestInit): Promise<any> {
  const r = await fetch(url, {
    ...opts,
    headers: { ...hdr(), ...(opts?.headers || {}) },
    signal:  AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Sync metadata ─────────────────────────────────────────────────────────────
const META_KEY = 'qca_sync_meta';

interface SyncMeta {
  students_last_sync:    string;  // ISO timestamp — for updated_at strategy
  writeoffs_last_sync:   string;  // ISO timestamp — for reversal catch
  last_sync_at:          string;  // last completed full sync
  att_deletions_last_id: number;  // last applied attendance_corrections.id
  summary_last_sync?:    string;  // ISO timestamp — last payment_summary (dues) refresh
}

function loadMeta(): SyncMeta {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || 'null') || {
      students_last_sync:    '',
      writeoffs_last_sync:   '',
      last_sync_at:          '',
      att_deletions_last_id: 0,
    };
  } catch {
    return { students_last_sync: '', writeoffs_last_sync: '', last_sync_at: '', att_deletions_last_id: 0 };
  }
}
function saveMeta(m: SyncMeta) {
  localStorage.setItem(META_KEY, JSON.stringify(m));
}

// ── Payment summaries (per-student dues) ─────────────────────────────────────
// The server computes dues only from the payment rows in the same /payments
// response, so the incremental /sync/payments feed can never produce them.
// Refresh with one full /payments fetch — but only when something could have
// changed (new payments/write-offs, empty table, or a day passed, since dues
// roll over with the month). Sets meta.summary_last_sync; caller saves meta.
const SUMMARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function refreshPaymentSummaries(
  base: string, meta: SyncMeta, changed: boolean,
): Promise<boolean> {
  const age = Date.now() - (Date.parse(meta.summary_last_sync || '') || 0);
  if (!changed && age < SUMMARY_MAX_AGE_MS && (await getPaymentSummaryCount()) > 0) return false;

  // Larger timeout than apiFetch: this downloads every payment row
  const r = await fetch(`${base}/api/data/payments?limit=50000`, {
    headers: hdr(),
    signal:  AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  await upsertPaymentSummaries(j.summary || {});
  meta.summary_last_sync = new Date().toISOString();
  window.dispatchEvent(new Event('qca-dues-updated'));
  return true;
}

// ── Local upsert for students (server is source of truth — read-only local) ──
async function upsertStudentsLocal(rows: any[]): Promise<void> {
  if (!rows.length) return;
  const db = await getDb();
  db.run('BEGIN TRANSACTION');
  try {
    for (const s of rows) {
      db.run(
        `INSERT INTO students
           (id,name,level,status,phone,email,age,parent_name,parent_phone,
            school_name,blood_group,dominant_side,student_type,student_category,
            monthly_fee,date_of_birth,profile_image,enrollment_date,
            gender,current_grade,parent_email,emergency_contact_name,
            emergency_contact_phone,medical_conditions,kit_size,referral_source,
            regno,address,qca_id,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, level=excluded.level, status=excluded.status,
           phone=excluded.phone, email=excluded.email, age=excluded.age,
           parent_name=excluded.parent_name, parent_phone=excluded.parent_phone,
           school_name=excluded.school_name, monthly_fee=excluded.monthly_fee,
           student_type=excluded.student_type, student_category=excluded.student_category,
           date_of_birth=excluded.date_of_birth, profile_image=excluded.profile_image,
           enrollment_date=excluded.enrollment_date, gender=excluded.gender,
           current_grade=excluded.current_grade, parent_email=excluded.parent_email,
           emergency_contact_name=excluded.emergency_contact_name,
           emergency_contact_phone=excluded.emergency_contact_phone,
           medical_conditions=excluded.medical_conditions,
           kit_size=excluded.kit_size, referral_source=excluded.referral_source,
           regno=excluded.regno, address=excluded.address, qca_id=excluded.qca_id, qca_id=excluded.qca_id,
           updated_at=excluded.updated_at`,
        [
          s.id, s.name, s.level, s.status, s.phone, s.email,
          s.age, s.parent_name, s.parent_phone, s.school_name,
          s.blood_group, s.dominant_side, s.student_type, s.student_category,
          s.monthly_fee, s.date_of_birth, s.profile_image,
          s.enrollment_date, s.gender, s.current_grade,
          s.parent_email ?? null, s.emergency_contact_name ?? null,
          s.emergency_contact_phone ?? null, s.medical_conditions ?? null,
          s.kit_size ?? null, s.referral_source ?? null,
          s.regno ?? null, s.address ?? null, s.qca_id ?? null, s.updated_at ?? null,
        ]
      );
    }
    db.run('COMMIT');
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
}

// ── Local upsert for attendance (server is source of truth for permanent table)
async function upsertAttendanceLocal(rows: any[]): Promise<void> {
  if (!rows.length) return;
  const db = await getDb();

  // Ensure both tables exist
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    session_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      INTEGER NOT NULL,
    attendance_date TEXT    NOT NULL,
    session_type    TEXT    NOT NULL,
    status          INTEGER DEFAULT 0,
    uploaded_by     TEXT    DEFAULT '',
    synced          INTEGER DEFAULT 1,
    UNIQUE(student_id, attendance_date, session_type)
  )`);
  try { db.run('ALTER TABLE attendance ADD COLUMN uploaded_by TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE attendance ADD COLUMN synced INTEGER DEFAULT 1'); } catch {}
  try { db.run("ALTER TABLE attendance ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"); } catch {}
  // Use the same schema as db.ts — must match exactly
  db.run(`CREATE TABLE IF NOT EXISTS hist_attendance (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      INTEGER NOT NULL,
    attendance_date TEXT    NOT NULL,
    session_type    TEXT    NOT NULL,
    status          INTEGER NOT NULL DEFAULT 0,
    source          TEXT    NOT NULL DEFAULT 'sync',
    fetched_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(student_id, attendance_date, session_type)
  )`);

  // Only sync PRESENT rows — no absent data stored per requirement
  const presentRows = rows.filter(r => Number(r.status) === 1);
  if (!presentRows.length) return;

  // Per-row upsert — does NOT wipe other rows for the same (date,session).
  // IMPORTANT: this function may be called with a PARTIAL set of rows for a
  // session (e.g. the 7-day reconcile's "missing ids" fetch returns only the
  // records that were missing locally, not the full session). A session-wide
  // DELETE-then-reinsert here would wrongly remove already-correct local rows
  // that aren't in this particular batch. Per-row ON CONFLICT upsert is safe
  // for full batches (since_id catch-up, full refresh) AND partial batches
  // (reconcile missing-ids fetch) alike. Removal of stale/no-longer-present
  // rows is handled separately by the 7-day reconcile's serverIdSet/localIdSet
  // comparison (and attendance-deletion tombstones), not here.
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of presentRows) {
      db.run(
        `INSERT INTO attendance (session_id,student_id,attendance_date,session_type,status,uploaded_by,synced,updated_at)
         VALUES (?,?,?,?,?,?,1,datetime('now'))
         ON CONFLICT(student_id, attendance_date, session_type) DO UPDATE SET
           session_id  = excluded.session_id,
           status      = excluded.status,
           uploaded_by = excluded.uploaded_by,
           synced      = 1,
           updated_at  = datetime('now')`,
        [r.id, r.student_id, r.attendance_date, r.session_type, r.status, r.uploaded_by ?? '']
      );
      db.run(
        `INSERT INTO hist_attendance
           (student_id, attendance_date, session_type, status, source, fetched_at)
         VALUES (?, ?, ?, 1, 'sync', datetime('now'))
         ON CONFLICT(student_id, attendance_date, session_type)
         DO UPDATE SET status=1, source='sync', fetched_at=datetime('now')`,
        [r.student_id, r.attendance_date, r.session_type]
      );
    }
    db.run('COMMIT');
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
}

async function getLocalMaxId(table: string): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    // attendance table uses session_id as its primary key (matches db.ts schema)
    const idCol = table === 'attendance' ? 'session_id' : 'id';
    const rows = db.exec(`SELECT MAX(${idCol}) as m FROM ${table}`);
    return (rows[0]?.values?.[0]?.[0] as number) ?? 0;
  } catch {
    return 0;
  }
}

// ── Main sync function ────────────────────────────────────────────────────────
export interface SyncResult {
  students:   number;
  payments:   number;
  attendance: number;
  writeoffs:  number;
  errors:     string[];
}

export async function runBackgroundSync(signal?: AbortSignal): Promise<SyncResult> {
  const ip = localStorage.getItem('server_ip');
  if (!ip || !localStorage.getItem('auth_user')) {
    return { students:0, payments:0, attendance:0, writeoffs:0, errors:[] };
  }

  const base   = bld(ip);
  const meta   = loadMeta();
  const result: SyncResult = { students:0, payments:0, attendance:0, writeoffs:0, errors:[] };
  const abort  = () => signal?.aborted;
  let   dirty  = false;  // track if any data changed (for OPFS save)

  // ── 1. Get server max IDs in one call ────────────────────────────────────
  let srv: any;
  try {
    srv = await apiFetch(`${base}/api/data/sync/status`);
  } catch(e: any) {
    result.errors.push(`Cannot reach server: ${e.message}`);
    return result;
  }
  if (abort()) return result;

  // ── 2. Students — updated_at strategy ────────────────────────────────────
  // If the local table is empty (local DB lost/reset while the sync meta in
  // localStorage survived), the timestamp would say "up to date" forever —
  // so ignore it and pull everything.
  const srvStudentTs = srv.students?.last_updated || '';
  const localStudentsEmpty = (await getLocalMaxId('students')) === 0;
  if (localStudentsEmpty) meta.students_last_sync = '';
  if (srvStudentTs > meta.students_last_sync || localStudentsEmpty) {
    try {
      const localMax = await getLocalMaxId('students');
      const since    = encodeURIComponent(meta.students_last_sync);
      const j = await apiFetch(
        `${base}/api/data/sync/students?since=${since}&since_id=${localMax}&limit=500`
      );
      if (j.data?.length) {
        await upsertStudentsLocal(j.data);
        result.students        = j.data.length;
        meta.students_last_sync = new Date().toISOString();
        dirty = true;
      }
    } catch(e: any) { result.errors.push(`Students: ${e.message}`); }
  }
  if (abort()) { saveMeta(meta); return result; }

  // ── 3. Payments — since_id strategy (append-only, server writes only) ────
  // Restricted users: server already filters to their own payments (data isolation)
  const srvPayMax   = srv.payments?.max_id || 0;
  const localPayMax = await getPaymentsMaxId();
  if (srvPayMax > localPayMax) {
    try {
      let sinceId = localPayMax;
      let hasMore = true;
      while (hasMore && !abort()) {
        const j = await apiFetch(
          `${base}/api/data/sync/payments?since_id=${sinceId}&limit=500`
        );
        if (j.data?.length) {
          await upsertPayments(j.data);
          result.payments += j.data.length;
          sinceId = Math.max(...j.data.map((p: any) => p.id));
          dirty   = true;
        }
        hasMore = !!j.has_more && j.data?.length > 0;
      }
    } catch(e: any) { result.errors.push(`Payments: ${e.message}`); }
  }
  if (abort()) { saveMeta(meta); return result; }

  // ── 4. Attendance — 7-day reconcile (handles additions AND deletions) ────
  // Restricted users (student/parent): present-only, their students only
  // Full users (coach/admin): all attendance
  try {
    // Server handles data isolation (restricted users get only their students)
    const j = await apiFetch(`${base}/api/data/sync/attendance/recent?days=30`);
    const sessions: any[] = j.sessions || [];

    const db = await getDb();

    // Ensure local table exists
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
      session_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id      INTEGER NOT NULL,
      attendance_date TEXT    NOT NULL,
      session_type    TEXT    NOT NULL,
      status          INTEGER DEFAULT 0,
      uploaded_by     TEXT    DEFAULT '',
      synced          INTEGER DEFAULT 1,
      UNIQUE(student_id, attendance_date, session_type)
    )`);
    // Add server-sync columns if upgrading from older local schema
    try { db.run('ALTER TABLE attendance ADD COLUMN uploaded_by TEXT DEFAULT \'\''); } catch {}
    try { db.run('ALTER TABLE attendance ADD COLUMN synced INTEGER DEFAULT 1'); } catch {}
    try { db.run("ALTER TABLE attendance ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"); } catch {}

    const missingIds: number[] = [];

    for (const session of sessions) {
      if (abort()) break;
      const { date, session: sess, ids: serverIds } = session;
      const serverIdSet = new Set<number>(serverIds);

      // Get local ids for this session
      const localRows = db.exec(
        `SELECT session_id AS id FROM attendance
         WHERE attendance_date=? AND session_type=?`,
        [date, sess]
      );
      const localIds: number[] = localRows[0]?.values?.map((r: any) => r[0] as number) || [];
      const localIdSet = new Set<number>(localIds);

      // Delete local rows that no longer exist on server (correction page removed them)
      for (const lid of localIds) {
        if (!serverIdSet.has(lid)) {
          // Also remove from hist_attendance
          const rowRes = db.exec(`SELECT student_id FROM attendance WHERE session_id=?`, [lid]);
          const sid = rowRes[0]?.values?.[0]?.[0] as number | undefined;
          db.run(`DELETE FROM attendance WHERE session_id=?`, [lid]);
          if (sid !== undefined) {
            db.run(
              `DELETE FROM hist_attendance WHERE student_id=? AND attendance_date=? AND session_type=?`,
              [sid, date, sess]
            );
          }
          result.attendance++;
          dirty = true;
        }
      }

      // Collect server ids missing locally — need to fetch full rows
      for (const sid of serverIds) {
        if (!localIdSet.has(sid)) {
          missingIds.push(sid);
        }
      }
    }

    // Fetch missing rows in one call (batch)
    if (missingIds.length > 0 && !abort()) {
      const chunkSize = 200;
      for (let i = 0; i < missingIds.length; i += chunkSize) {
        if (abort()) break;
        const chunk = missingIds.slice(i, i + chunkSize);
        const fj    = await apiFetch(
          `${base}/api/data/sync/attendance/fetch?ids=${chunk.join(',')}`
        );
        if (fj.data?.length) {
          await upsertAttendanceLocal(fj.data);
          result.attendance += fj.data.length;
          dirty = true;
        }
      }
    }

    // For attendance older than 7 days: since_id append-only
    const srvAttMax   = srv.attendance?.max_id || 0;
    const localAttMax = await getLocalMaxId('attendance');
    if (srvAttMax > localAttMax && !abort()) {
      const j2 = await apiFetch(
        `${base}/api/data/sync/attendance?since_id=${localAttMax}&limit=500&present_only=1`
      );
      if (j2.data?.length) {
        await upsertAttendanceLocal(j2.data);
        result.attendance += j2.data.length;
        dirty = true;
      }
    }
  } catch(e: any) { result.errors.push(`Attendance: ${e.message}`); }
  if (abort()) { saveMeta(meta); return result; }

  // ── 5. Write-offs — since_id + updated_at (server writes + reversals) ────
  const srvWoMax   = srv.write_offs?.max_id      || 0;
  const srvWoTs    = srv.write_offs?.last_updated || '';
  const localWoMax = await getWriteOffsMaxId();
  const needWo     = srvWoMax > localWoMax || srvWoTs > (meta.writeoffs_last_sync || '');
  if (needWo) {
    try {
      const since = encodeURIComponent(meta.writeoffs_last_sync);
      const j = await apiFetch(
        `${base}/api/data/sync/write-offs?since_id=${localWoMax}&since=${since}&limit=500`
      );
      if (j.data?.length) {
        await upsertWriteOffs(j.data);
        result.writeoffs         = j.data.length;
        meta.writeoffs_last_sync = new Date().toISOString();
        dirty = true;
      }
    } catch(e: any) { result.errors.push(`Write-offs: ${e.message}`); }
  }
  if (abort()) { saveMeta(meta); return result; }

  // ── 5b. Payment summaries (dues) — Payments overview & fee alerts ────────
  // Restricted users never see the dues overview, so skip the big download
  if (!isDataRestricted()) {
    try {
      await refreshPaymentSummaries(base, meta, result.payments + result.writeoffs > 0);
    } catch(e: any) { result.errors.push(`Dues: ${e.message}`); }
  }

  // ── 6. Persist OPFS if anything changed ──────────────────────────────────
  if (dirty) {
    try { await saveDb(); } catch {}
  }

  meta.last_sync_at = new Date().toISOString();
  saveMeta(meta);

  const total = result.students + result.payments + result.attendance + result.writeoffs;
  if (total > 0 || result.errors.length) {
    console.log(`[SYNC] students:${result.students} payments:${result.payments} attendance:${result.attendance} writeoffs:${result.writeoffs}${result.errors.length ? ' errors:'+result.errors.join(';') : ''}`);
  }

  return result;
}

// ── Targeted per-page sync functions (for pull-to-refresh) ───────────────────
// Each page pulls ONLY the data it displays. Much lighter than a full sync.

function getBase(): string {
  const ip = localStorage.getItem('server_ip') || '';
  return bld(ip);
}

/** Students page pull-to-refresh */
export async function syncStudentsOnly(): Promise<number> {
  if (!localStorage.getItem('server_ip')) return 0;
  const base = getBase();
  let count = 0;
  try {
    // Always fetch ALL students — only ~100-200 students, ~30KB.
    // Incremental since_id approach misses server-side edits if trigger is stale.
    // Full pull + upsert is reliable and fast enough.
    let sinceId = 0;
    let hasMore = true;
    while (hasMore) {
      const j = await apiFetch(
        `${base}/api/data/sync/students?since=&since_id=${sinceId}&limit=500`
      );
      if (j.data?.length) {
        await upsertStudentsLocal(j.data);
        count  += j.data.length;
        sinceId = Math.max(...j.data.map((s: any) => s.id));
      }
      // Less than 500 returned = no more pages
      hasMore = j.count === 500;
    }
    if (count > 0) {
      const meta = loadMeta();
      meta.students_last_sync = new Date().toISOString();
      saveMeta(meta);
      await saveDb();
    }
  } catch(e) { console.error('[SYNC] students refresh failed:', e); }
  return count;
}

/**
 * Pull attendance deletion tombstones since last check, and apply them to
 * local attendance/hist_attendance. This is how a correction made on one
 * device (e.g. admin deletes a record via Attendance Correction) propagates
 * to ALL other devices — without requiring a Full Refresh.
 *
 * Cheap to call often: returns 0 quickly if nothing new (most calls).
 */
export async function syncAttendanceDeletions(): Promise<number> {
  if (!localStorage.getItem('server_ip')) return 0;
  const base = getBase();
  const meta = loadMeta();
  let count = 0;
  try {
    let sinceId = meta.att_deletions_last_id || 0;
    let hasMore = true;
    while (hasMore) {
      const j = await apiFetch(
        `${base}/api/data/sync/attendance/deletions?since_id=${sinceId}&limit=500`
      );
      if (j.data?.length) {
        await applyAttendanceDeletions(j.data);
        count   += j.data.length;
        sinceId  = Math.max(...j.data.map((d: any) => d.id));
      }
      hasMore = !!j.has_more && j.data?.length > 0;
    }
    if (sinceId !== (meta.att_deletions_last_id || 0)) {
      meta.att_deletions_last_id = sinceId;
      saveMeta(meta);
    }
  } catch (e) {
    console.warn('[SYNC] attendance deletions failed:', e);
  }
  return count;
}

/**
 * Diff local attendance against ALL server present-record ids (not just the
 * last 7 days) and fix gaps:
 *  - ids present on server but missing locally → fetched and added
 *  - ids present locally but no longer present on server → removed
 *
 * This is the explicit "Sync Missing" repair action — heavier than the
 * regular reconcile (downloads a full id list), so it's user-triggered from
 * Sync Validation, not run automatically in the background.
 */
export async function repairAttendance(
  onProgress?: (msg: string) => void
): Promise<{ added: number; removed: number; error?: string }> {
  if (!localStorage.getItem('server_ip')) return { added: 0, removed: 0, error: 'Not configured' };
  const base = getBase();
  try {
    onProgress?.('Fetching server attendance list…');
    const j = await apiFetch(`${base}/api/data/sync/attendance/all-ids`);
    const serverIds = new Set<number>(j.ids || []);

    const localIds = await getLocalAttendanceIds();

    const missing = [...serverIds].filter(id => !localIds.has(id));
    const extra   = [...localIds].filter(id => !serverIds.has(id));

    onProgress?.(`Found ${missing.length} missing, ${extra.length} stale…`);

    // Fetch and add missing rows
    let added = 0;
    const chunkSize = 200;
    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize);
      const fj = await apiFetch(`${base}/api/data/sync/attendance/fetch?ids=${chunk.join(',')}`);
      if (fj.data?.length) {
        await upsertAttendanceLocal(fj.data);
        added += fj.data.length;
        onProgress?.(`Added ${added}/${missing.length}…`);
      }
    }

    // Remove stale rows (server no longer has these as present —
    // e.g. corrected/deleted before the deletion-tombstone feature existed,
    // or tombstone not yet propagated)
    let removed = 0;
    if (extra.length) {
      removed = await removeLocalAttendanceByIds(extra);
    }

    if (added > 0 || removed > 0) await saveDb();
    onProgress?.(`Done — added ${added}, removed ${removed}`);
    return { added, removed };
  } catch (e: any) {
    console.error('[REPAIR] attendance failed:', e);
    return { added: 0, removed: 0, error: e?.message || 'Unknown error' };
  }
}


/** Attendance pages pull-to-refresh — 7-day reconcile */
export async function syncAttendanceOnly(): Promise<number> {
  if (!localStorage.getItem('server_ip')) return 0;
  const base = getBase();
  let count = 0;
  try {
    // Capture local max BEFORE the 7-day reconcile inserts recent (high-id) rows.
    // Otherwise the catch-up loop would start past the older history and skip it.
    const preReconcileMax = await getLocalMaxId('attendance');

    const j = await apiFetch(`${base}/api/data/sync/attendance/recent?days=30`);
    const sessions: any[] = j.sessions || [];
    const db = await getDb();

    // CRITICAL: ensure local tables exist BEFORE any SELECT —
    // on a fresh device the SELECT below would throw and abort the whole sync
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
      session_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id      INTEGER NOT NULL,
      attendance_date TEXT    NOT NULL,
      session_type    TEXT    NOT NULL,
      status          INTEGER DEFAULT 0,
      uploaded_by     TEXT    DEFAULT '',
      synced          INTEGER DEFAULT 1,
      UNIQUE(student_id, attendance_date, session_type)
    )`);
    // Add server-sync columns if upgrading from older local schema
    try { db.run('ALTER TABLE attendance ADD COLUMN uploaded_by TEXT DEFAULT \'\''); } catch {}
    try { db.run('ALTER TABLE attendance ADD COLUMN synced INTEGER DEFAULT 1'); } catch {}
    try { db.run("ALTER TABLE attendance ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"); } catch {}
    db.run(`CREATE TABLE IF NOT EXISTS hist_attendance (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id      INTEGER NOT NULL,
      attendance_date TEXT    NOT NULL,
      session_type    TEXT    NOT NULL DEFAULT 'Morning',
      status          INTEGER DEFAULT 1,
      UNIQUE(student_id, attendance_date, session_type)
    )`);

    const missingIds: number[] = [];
    for (const session of sessions) {
      const { date, session: sess, ids: serverIds } = session;
      const serverIdSet = new Set<number>(serverIds);
      const localRows = db.exec(
        `SELECT session_id FROM attendance WHERE attendance_date=? AND session_type=?`,
        [date, sess]
      );
      const localIds: number[] = localRows[0]?.values?.map((r: any) => r[0] as number) || [];
      const localIdSet = new Set<number>(localIds);
      // Delete local rows not on server (corrections) — from BOTH tables
      for (const lid of localIds) {
        if (!serverIdSet.has(lid)) {
          // Look up the row first so hist_attendance can be cleaned too
          const rowRes = db.exec(
            `SELECT student_id FROM attendance WHERE session_id=?`, [lid]
          );
          const sid = rowRes[0]?.values?.[0]?.[0] as number | undefined;
          db.run(`DELETE FROM attendance WHERE session_id=?`, [lid]);
          if (sid !== undefined) {
            db.run(
              `DELETE FROM hist_attendance
               WHERE student_id=? AND attendance_date=? AND session_type=?`,
              [sid, date, sess]
            );
          }
          count++;
        }
      }
      for (const sid of serverIds) {
        if (!localIdSet.has(sid)) missingIds.push(sid);
      }
    }

    // Fetch missing rows in batches
    const chunkSize = 200;
    for (let i = 0; i < missingIds.length; i += chunkSize) {
      const chunk = missingIds.slice(i, i + chunkSize);
      const fj = await apiFetch(`${base}/api/data/sync/attendance/fetch?ids=${chunk.join(',')}`);
      if (fj.data?.length) {
        await upsertAttendanceLocal(fj.data);
        count += fj.data.length;
      }
    }

    // Older than 7 days: since_id append-only catch-up (fills full history
    // on a fresh device — present-only rows to keep volume small).
    // Starts from the PRE-reconcile max so older rows are never skipped.
    let sinceId = preReconcileMax;
    let hasMore = true;
    while (hasMore) {
      const j2 = await apiFetch(
        `${base}/api/data/sync/attendance?since_id=${sinceId}&limit=500&present_only=1`
      );
      if (j2.data?.length) {
        await upsertAttendanceLocal(j2.data);
        count  += j2.data.length;
        sinceId = Math.max(...j2.data.map((a: any) => a.id));
      }
      hasMore = !!j2.has_more && j2.data?.length > 0;
    }

    // Refresh session-days calendar metadata (lightweight — all session
    // dates ever, computed server-side from full data). Needed for
    // restricted roles to compute attendance % correctly.
    try {
      const sd = await apiFetch(`${base}/api/data/sync/session-days`);
      if (sd.data?.length) await replaceSessionDays(sd.data);
    } catch (e) {
      console.warn('[SYNC] session-days failed:', e);
    }

    // Apply any attendance corrections (deletions) made on OTHER devices —
    // propagates corrections without needing a Full Refresh.
    await syncAttendanceDeletions();

    if (count > 0) await saveDb();
  } catch(e) {
    console.error('[SYNC] attendance refresh FAILED:', e);
    // Surface the error so developer can see it in DevTools
    if (typeof e === 'object' && e !== null) {
      console.error('[SYNC] error details:', JSON.stringify(e, Object.getOwnPropertyNames(e)));
    }
  }
  return count;
}

/** Payments / Records pages pull-to-refresh — payments + write-offs */
export async function syncPaymentsOnly(): Promise<number> {
  if (!localStorage.getItem('server_ip')) return 0;
  const base = getBase();
  const meta = loadMeta();
  let count = 0;
  try {
    // Fee categories first — small table, always full replace. Needed so
    // "Transaction Type" can be resolved/backfilled below before display.
    try {
      const cj = await apiFetch(`${base}/api/data/fee-categories`);
      if (cj.data?.length) await syncFeeCategories(cj.data);
    } catch (e: any) { console.warn('[SYNC] fee categories refresh:', e?.message ?? e); }

    // Payments since local max
    let sinceId = await getPaymentsMaxId();
    let hasMore = true;
    while (hasMore) {
      const j = await apiFetch(`${base}/api/data/sync/payments?since_id=${sinceId}&limit=500`);
      if (j.data?.length) {
        await upsertPayments(j.data);
        count  += j.data.length;
        sinceId = Math.max(...j.data.map((p: any) => p.id));
      }
      hasMore = !!j.has_more && j.data?.length > 0;
    }

    // Repair any local payments whose Transaction Type (fee_type_name) is
    // still missing — incremental sync never revisits already-synced rows,
    // so this resolves it from the fee_categories just refreshed above.
    try { await backfillFeeTypeNames(); } catch (e) { console.warn('[SYNC] fee_type_name backfill:', e); }

    // Write-offs since local max + reversals since last sync
    const woMax  = await getWriteOffsMaxId();
    const since  = encodeURIComponent(meta.writeoffs_last_sync || '');
    const wj = await apiFetch(
      `${base}/api/data/sync/write-offs?since_id=${woMax}&since=${since}&limit=500`
    );
    if (wj.data?.length) {
      await upsertWriteOffs(wj.data);
      count += wj.data.length;
      meta.writeoffs_last_sync = new Date().toISOString();
      saveMeta(meta);
    }
    if (count > 0) await saveDb();
  } catch(e) { console.warn('[SYNC] payments refresh:', e); }

  // Dues (payment_summary) — kept separate so a failure here never hides
  // the payment rows already saved above
  if (!isDataRestricted()) {
    try {
      if (await refreshPaymentSummaries(base, meta, count > 0)) saveMeta(meta);
    } catch(e) { console.warn('[SYNC] dues refresh:', e); }
  }
  return count;
}

/** Force a dues (payment_summary) refresh — e.g. right after voiding a receipt */
export async function refreshDuesNow(): Promise<void> {
  if (!localStorage.getItem('server_ip') || isDataRestricted()) return;
  const meta = loadMeta();
  try {
    if (await refreshPaymentSummaries(getBase(), meta, true)) saveMeta(meta);
  } catch (e) { console.warn('[SYNC] dues refresh:', e); }
}

/** Status-check only — used by lightweight background check.
 *  Returns true if server has newer data than local. */
export async function serverHasNewData(): Promise<boolean> {
  if (!localStorage.getItem('server_ip')) return false;
  try {
    const base = getBase();
    const srv  = await apiFetch(`${base}/api/data/sync/status`);
    const meta = loadMeta();

    const localStu = await getLocalMaxId('students');
    const localPay = await getPaymentsMaxId();
    const localAtt = await getLocalMaxId('attendance');
    const localWo  = await getWriteOffsMaxId();

    return (
      (srv.students?.last_updated || '') > (meta.students_last_sync || '') ||
      (srv.students?.max_id   || 0) > localStu ||
      (srv.payments?.max_id   || 0) > localPay ||
      (srv.attendance?.max_id || 0) > localAtt ||
      (srv.write_offs?.max_id || 0) > localWo
    );
  } catch {
    return false;
  }
}

// ── Reset and re-sync (for student/parent refresh button) ────────────────────
// ── Progress callback type ───────────────────────────────────────────────────
export type RefreshProgress = {
  stage:   string;   // "Clearing…" | "Students" | "Attendance" | "Payments" | "Write-offs" | "Done"
  current: number;   // rows fetched so far in this stage
  total:   number;   // server total (0 = unknown)
  done:    boolean;
};

/**
 * Full refresh — wipes local DB and pulls EVERYTHING from server.
 * After completion local === server. No incremental delta.
 *
 * Role-aware:
 *   Restricted (student/parent) → server already filters to their data
 *   Unrestricted (admin/coach/members) → all data
 *
 * @param onProgress  optional callback for UI progress bar
 */
export async function fullRefreshFromServer(
  onProgress?: (p: RefreshProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  const ip = localStorage.getItem('server_ip');
  if (!ip || !localStorage.getItem('auth_user')) {
    return { ok: false, error: 'Not configured — set server IP first' };
  }
  const base = bld(ip);

  const prog = (stage: string, current = 0, total = 0, done = false) => {
    console.log(`[REFRESH] ${stage} ${current}/${total}`);
    onProgress?.({ stage, current, total, done });
  };

  try {
    // ── Step 1: Wipe local DB ───────────────────────────────────────────────
    prog('Clearing local data…');
    localStorage.removeItem('qca_sync_meta');

    const db = await getDb();
    for (const t of ['students','payments','attendance','hist_attendance',
                      'fee_write_offs','payment_summary','hub_news','hub_insights']) {
      try { db.run(`DELETE FROM ${t}`); } catch {}
    }

    // ── Step 2: Get server totals for progress bar ──────────────────────────
    let srvStatus: any = {};
    try {
      srvStatus = await apiFetch(`${base}/api/data/sync/status`);
    } catch {}

    // ── Step 3: Pull ALL students ────────────────────────────────────────────
    prog('Students', 0, srvStatus.students?.count || 0);
    let stuCount = 0;
    let stuSince = 0;
    let stuMore  = true;
    while (stuMore) {
      const j = await apiFetch(
        `${base}/api/data/sync/students?since=&since_id=${stuSince}&limit=500`
      );
      if (j.data?.length) {
        await upsertStudentsLocal(j.data);
        stuCount  += j.data.length;
        stuSince   = Math.max(...j.data.map((s: any) => s.id));
        prog('Students', stuCount, srvStatus.students?.count || 0);
      }
      stuMore = j.count === 500;   // server returned full page
    }

    // ── Step 4: Pull ALL attendance (present only) ───────────────────────────
    // Create local tables first
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL, session_type TEXT NOT NULL,
      status INTEGER DEFAULT 0, uploaded_by TEXT DEFAULT '', synced INTEGER DEFAULT 1,
      UNIQUE(student_id, attendance_date, session_type)
    )`);
    try { db.run("ALTER TABLE attendance ADD COLUMN uploaded_by TEXT DEFAULT ''"); } catch {}
    try { db.run("ALTER TABLE attendance ADD COLUMN synced INTEGER DEFAULT 1"); } catch {}
    try { db.run("ALTER TABLE attendance ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"); } catch {}
    db.run(`CREATE TABLE IF NOT EXISTS hist_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL, session_type TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'sync',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(student_id, attendance_date, session_type)
    )`);

    prog('Attendance', 0, srvStatus.attendance?.count || 0);
    let attCount = 0;
    let attSince = 0;
    let attMore  = true;
    while (attMore) {
      const j = await apiFetch(
        `${base}/api/data/sync/attendance?since_id=${attSince}&limit=500&present_only=1`
      );
      if (j.data?.length) {
        await upsertAttendanceLocal(j.data);
        attCount  += j.data.length;
        attSince   = Math.max(...j.data.map((a: any) => a.id));
        prog('Attendance', attCount, srvStatus.attendance?.count || 0);
      }
      attMore = !!j.has_more && j.data?.length > 0;
    }

    // ── Step 4b: Pull session-days calendar metadata ─────────────────────────
    // Needed so restricted roles (Student/Parent) can correctly compute their
    // attendance % — their own attendance sync alone can't tell them which
    // days were "real" practice sessions (requires seeing >=2 students,
    // which restricted sync doesn't include).
    prog('Session calendar…');
    try {
      const sd = await apiFetch(`${base}/api/data/sync/session-days`);
      if (sd.data?.length) await replaceSessionDays(sd.data);
    } catch (e) {
      console.warn('[REFRESH] session-days failed:', e);
    }

    // ── Step 5: Pull ALL payments ────────────────────────────────────────────
    prog('Payments', 0, srvStatus.payments?.count || 0);
    let payCount = 0;
    let paySince = 0;
    let payMore  = true;
    while (payMore) {
      const j = await apiFetch(
        `${base}/api/data/sync/payments?since_id=${paySince}&limit=500`
      );
      if (j.data?.length) {
        await upsertPayments(j.data);
        payCount  += j.data.length;
        paySince   = Math.max(...j.data.map((p: any) => p.id));
        prog('Payments', payCount, srvStatus.payments?.count || 0);
      }
      payMore = !!j.has_more && j.data?.length > 0;
    }

    // ── Step 6: Pull ALL write-offs ──────────────────────────────────────────
    prog('Write-offs', 0, srvStatus.write_offs?.count || 0);
    let woCount = 0;
    let woSince = 0;
    let woMore  = true;
    while (woMore) {
      const j = await apiFetch(
        `${base}/api/data/sync/write-offs?since_id=${woSince}&since=&limit=500`
      );
      if (j.data?.length) {
        await upsertWriteOffs(j.data);
        woCount  += j.data.length;
        woSince   = Math.max(...j.data.map((w: any) => w.id));
        prog('Write-offs', woCount, srvStatus.write_offs?.count || 0);
      }
      woMore = !!j.has_more && j.data?.length > 0;
    }

    // ── Step 6b: Rebuild dues (payment_summary) ──────────────────────────────
    const freshMeta: SyncMeta = {
      students_last_sync:    new Date().toISOString(),
      writeoffs_last_sync:   new Date().toISOString(),
      last_sync_at:          new Date().toISOString(),
      att_deletions_last_id: srvStatus.attendance_deletions?.max_id || 0,
    };
    if (!isDataRestricted()) {
      prog('Fee dues');
      try { await refreshPaymentSummaries(base, freshMeta, true); }
      catch (e: any) { console.warn('[REFRESH] dues:', e?.message ?? e); }
    }

    // ── Step 7: Save to OPFS ────────────────────────────────────────────────
    prog('Saving…');
    await saveDb();

    // Update sync meta so next background check is correct.
    // att_deletions_last_id = server's current max — local data is already
    // fully current post-refresh, so don't replay old corrections.
    saveMeta(freshMeta);

    prog('Done', stuCount + attCount + payCount + woCount, 0, true);
    console.log(`[REFRESH] Complete — students:${stuCount} attendance:${attCount} payments:${payCount} writeoffs:${woCount}`);
    return { ok: true };

  } catch (e: any) {
    console.error('[REFRESH] failed:', e);
    return { ok: false, error: e?.message || 'Unknown error' };
  }
}

// ── Sync validation — compare local vs server counts ─────────────────────────
export async function checkSyncStatus(base: string): Promise<{
  table: string; local: number; server: number; match: boolean;
  detail?: string; canRepair?: boolean;
}[]> {
  const headers = (()=>{const _j=localStorage.getItem('jwt_token'),_e=parseInt(localStorage.getItem('jwt_expiry')||'0');if(_j&&Date.now()<_e-60000)return{'Content-Type':'application/json','Authorization':'Bearer '+_j,'X-Username':localStorage.getItem('auth_user')||''};return{'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};})();
  const clean = (base || '').trim().replace(/\/+$/, '');
  const url   = clean.startsWith('http') ? clean : `http://${clean}`;

  const srv = await fetch(`${url}/api/data/sync/status`, { headers }).then(r => r.json());

  const { getDb, getPaymentsMaxId } = await import('../database/db');
  const db = await getDb();

  const localCount = (table: string) => {
    try {
      const rows = db.exec(`SELECT COUNT(*) as n FROM ${table}`);
      return (rows[0]?.values?.[0]?.[0] as number) ?? 0;
    } catch { return 0; }
  };

  const localMax = (table: string) => {
    try {
      const idCol = table === 'attendance' ? 'session_id' : 'id';
      const rows = db.exec(`SELECT MAX(${idCol}) as m FROM ${table}`);
      return (rows[0]?.values?.[0]?.[0] as number) ?? 0;
    } catch { return 0; }
  };

  // Use count for students (mutable), max_id for append-only tables
  const lStudents  = localCount('students');
  const lPayments  = localMax('payments');
  const lAttendCount = localCount('attendance');
  const lAttend       = localMax('attendance');
  const lWriteoffs = localMax('fee_write_offs');

  const sStudents  = srv.students?.count        || 0;
  const sPayments  = srv.payments?.max_id       || 0;
  // Compare against present-only max_id — local only stores present rows,
  // so comparing against overall max_id (which may include later absent
  // rows) would show a false mismatch.
  const sAttend      = srv.attendance?.present_max_id ?? srv.attendance?.max_id ?? 0;
  const sAttendCount = srv.attendance?.count || 0;
  const sWriteoffs = srv.write_offs?.max_id      || 0;

  return [
    {
      table:  'Students',
      local:  lStudents,
      server: sStudents,
      match:  lStudents === sStudents,
    },
    {
      table:  'Payments (max id)',
      local:  lPayments,
      server: sPayments,
      match:  lPayments >= sPayments,
    },
    {
      table:    'Attendance (present)',
      local:    lAttendCount,
      server:   sAttendCount,
      // "Correct" requires BOTH count and max id to match. Count alone can
      // miss cases with compensating gaps (one missing + one extra = same
      // count); max id alone can miss gaps in the middle of the history.
      match:    lAttendCount === sAttendCount && lAttend === sAttend,
      detail:   `max id: local ${lAttend} / server ${sAttend}`,
      canRepair: !(lAttendCount === sAttendCount && lAttend === sAttend),
    },
    {
      table:  'Write-offs (max id)',
      local:  lWriteoffs,
      server: sWriteoffs,
      match:  lWriteoffs >= sWriteoffs,
    },
  ];
}

// ── React hook ────────────────────────────────────────────────────────────────
export function useSyncService(opts?: {
  intervalMs?:     number;
  onSyncComplete?: (r: SyncResult) => void;
}) {
  const { intervalMs = 5 * 60 * 1000, onSyncComplete } = opts || {};
  const abortRef   = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const sync = useCallback(async () => {
    if (runningRef.current) return;
    if (!localStorage.getItem('server_ip'))  return;
    if (!localStorage.getItem('auth_user'))  return;
    runningRef.current = true;
    abortRef.current   = new AbortController();
    try {
      const r = await runBackgroundSync(abortRef.current.signal);
      onSyncComplete?.(r);
    } catch(e) {
      console.warn('[SYNC] unexpected error:', e);
    } finally {
      runningRef.current = false;
    }
  }, [onSyncComplete]);

  // Lightweight status check — one /sync/status request, no bulk data pull.
  // If the server has newer data, dispatch 'qca-new-data' so pages can show
  // a subtle "pull to refresh" badge. Actual bulk sync happens via
  // pull-to-refresh on each page (usePullToRefresh + sync*Only functions).
  //
  // EXCEPTION: attendance deletion tombstones are applied immediately here
  // (not just badged) — they're cheap (small JSON, simple local DELETEs) and
  // showing stale/deleted attendance is misleading. This is how a correction
  // made on one device propagates to all others within ~5 min / on resume,
  // without anyone needing to pull-to-refresh or Full Refresh.
  const statusCheck = useCallback(async () => {
    try {
      await syncAttendanceDeletions();
    } catch {}
    try {
      const hasNew = await serverHasNewData();   // defined in this module
      if (hasNew) {
        window.dispatchEvent(new CustomEvent('qca-new-data'));
      }
    } catch {}
  }, []);

  useEffect(() => {
    // On every app open: run incremental sync after a short delay
    // (lets the ping in App.jsx complete first so auth is ready).
    // runBackgroundSync checks sync/status first and only pulls what
    // is actually new -- zero data transfer if already up to date.
    const t0 = setTimeout(() => { sync(); }, 3000);

    // Periodic incremental sync every intervalMs (safety net)
    const interval = setInterval(sync, intervalMs);

    // Re-sync when app comes back to foreground (visibility API -- web/debug)
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    document.addEventListener('visibilitychange', onVisible);

    // Re-sync on Capacitor app resume (Android native foreground event)
    const onResume = () => { sync(); };
    document.addEventListener('resume', onResume);

    // Allow App.jsx ping to trigger sync immediately after auth
    const onTrigger = () => { sync(); };
    window.addEventListener('qca-trigger-sync', onTrigger);

    return () => {
      clearTimeout(t0);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('qca-trigger-sync', onTrigger);
      abortRef.current?.abort();
    };
  }, [sync, intervalMs]);

  return { sync }
}
export default useSyncService;
