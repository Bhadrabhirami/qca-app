/**
 * QCA Local Database — sql.js + OPFS
 * Tables: students | attendance | hist_attendance
 */
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';

let _SQL: SqlJsStatic | null = null;
let _db:  Database   | null = null;
const DB_FILENAME = 'qca_mobile.db';

const _opfsLoad = async (): Promise<Uint8Array | null> => {
  try {
    const root = await navigator.storage.getDirectory();
    const fh   = await root.getFileHandle(DB_FILENAME);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch { return null; }
};

const _save = async (): Promise<void> => {
  if (!_db) return;
  try {
    const root     = await navigator.storage.getDirectory();
    const fh       = await root.getFileHandle(DB_FILENAME, { create: true });
    const writable = await fh.createWritable();
    await writable.write(_db.export());
    await writable.close();
  } catch (e) { console.warn('QCA: OPFS save failed', e); }
};

export const saveDb = _save;  // exported AFTER declaration — no circular ref

// Singleton promise — prevents multiple simultaneous initialisations
let _initPromise: Promise<Database> | null = null;

export const getDb = (): Promise<Database> => {
  if (_db) return Promise.resolve(_db);
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!_SQL) {
      _SQL = await initSqlJs({
        locateFile: () => '/sql-wasm.wasm',
      });
    }
    const saved = await _opfsLoad();
    _db = saved ? new _SQL.Database(saved) : new _SQL.Database();
    return _db;
  })();
  return _initPromise;
};

const queryRows = (db: Database, sql: string, params: any[] = []): any[] => {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
};

export const initDatabase = async (): Promise<void> => {
  const db = await getDb();

  // ── Core tables (must exist before app renders) ───────────────────────────
  // students
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id                      INTEGER PRIMARY KEY,
    name                    TEXT    NOT NULL,
    age                     INTEGER,
    phone                   TEXT,
    email                   TEXT,
    level                   TEXT,
    user_id                 INTEGER,
    status                  TEXT    DEFAULT 'Active',
    school_name             TEXT,
    date_of_birth           TEXT,
    parent_name             TEXT,
    student_type            TEXT    DEFAULT 'Academy',
    blood_group             TEXT,
    dominant_side           TEXT,
    profile_image           TEXT,
    monthly_fee             REAL    DEFAULT 1000.0,
    student_category        TEXT    DEFAULT 'REGULAR',
    enrollment_date         TEXT,
    gender                  TEXT,
    current_grade           TEXT,
    parent_phone            TEXT,
    parent_email            TEXT,
    emergency_contact_name  TEXT,
    emergency_contact_phone TEXT,
    medical_conditions      TEXT,
    kit_size                TEXT,
    referral_source         TEXT,
    regno                   TEXT,
    address                 TEXT,
    qca_id                  INTEGER
  )`);

  // Safe migrations — add columns to existing DB if upgrading
  const _addCol = (col: string, colDef: string) => {
    try { db.run('ALTER TABLE students ADD COLUMN ' + col + ' ' + colDef); } catch (_) {}
  };
  _addCol('enrollment_date',         'TEXT');
  _addCol('gender',                  'TEXT');
  _addCol('current_grade',           'TEXT');
  _addCol('parent_phone',            'TEXT');
  _addCol('parent_email',            'TEXT');
  _addCol('emergency_contact_name',  'TEXT');
  _addCol('emergency_contact_phone', 'TEXT');
  _addCol('medical_conditions',      'TEXT');
  _addCol('kit_size',                'TEXT');
  _addCol('referral_source',         'TEXT');
  _addCol('updated_at',              "TEXT DEFAULT (datetime('now'))");
  _addCol('exit_date',               'TEXT');
  _addCol('exit_reason',             'TEXT');
  _addCol('coach_id',                'INTEGER');
  _addCol('regno',                   'TEXT');
  _addCol('address',                 'TEXT');
  _addCol('qca_id',                  'INTEGER');

  // attendance
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    session_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      INTEGER NOT NULL,
    attendance_date TEXT    NOT NULL,
    session_type    TEXT    NOT NULL,
    status          INTEGER NOT NULL DEFAULT 0,
    synced          INTEGER NOT NULL DEFAULT 0,
    UNIQUE(student_id, attendance_date, session_type)
  )`);
  // updated_at — last local write time. Used by applyAttendanceDeletions to
  // tell a freshly re-captured row apart from the old row a deletion
  // tombstone refers to (see below). NULL on rows from before this column
  // existed — treated as "old data, safe to delete" by the guard.
  try { db.run("ALTER TABLE attendance ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"); } catch (_) {}

  // hist_attendance — migrate if old schema (no AUTOINCREMENT)
  const schemaRows = queryRows(db, `SELECT sql FROM sqlite_master WHERE type='table' AND name='hist_attendance'`);
  const existingSql: string = (schemaRows[0]?.sql as string) ?? '';
  if (existingSql && !existingSql.toUpperCase().includes('AUTOINCREMENT')) {
    db.run('DROP INDEX IF EXISTS idx_hist_student_date');
    db.run('DROP TABLE IF EXISTS hist_attendance');
  }

  db.run(`CREATE TABLE IF NOT EXISTS hist_attendance (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      INTEGER NOT NULL,
    attendance_date TEXT    NOT NULL,
    session_type    TEXT    NOT NULL,
    status          INTEGER NOT NULL DEFAULT 0,
    source          TEXT    NOT NULL DEFAULT 'hager',
    fetched_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(student_id, attendance_date, session_type)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_hist_student_date ON hist_attendance(student_id, attendance_date)`);

  // session_days — calendar metadata: dates+sessions where a "real" practice
  // happened (>=2 students present, computed server-side from FULL data).
  // Needed because restricted roles (Student/Parent) only sync their OWN
  // attendance, so hist_attendance alone can't tell them which days were
  // real sessions vs. days with no practice.
  db.run(`CREATE TABLE IF NOT EXISTS session_days (
    attendance_date TEXT NOT NULL,
    session_type    TEXT NOT NULL,
    UNIQUE(attendance_date, session_type)
  )`);

  // ── attendance table indexes (speeds up records page, upload, dashboard) ──
  db.run(`CREATE INDEX IF NOT EXISTS idx_att_date         ON attendance(attendance_date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_att_student_date ON attendance(student_id, attendance_date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_att_synced_date  ON attendance(synced, attendance_date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_att_session_date ON attendance(session_type, attendance_date)`);

  // ── Temp students — pending server ID assignment ─────────────────────────
  // Coach adds a new student locally; attendance is captured immediately.
  // Once server assigns a real student_id, temp rows are migrated to students.
  db.run(`CREATE TABLE IF NOT EXISTS temp_students (
    temp_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    date_of_birth TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'Active',
    student_category TEXT NOT NULL DEFAULT 'REGULAR',
    enrollment_date  TEXT NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT '',
    server_id     INTEGER DEFAULT NULL  -- filled once server assigns real ID
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_temp_pending ON temp_students(server_id)`);

  // ── Fee categories (INCOME only, from account_categories) ─────────────────
  db.run(`CREATE TABLE IF NOT EXISTS fee_categories (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    txn_type    TEXT    NOT NULL DEFAULT 'INCOME',
    description TEXT
  )`);

  // ── Student payments (INCOME direction only) ───────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id                     INTEGER PRIMARY KEY,
    student_id             INTEGER,
    student_name           TEXT,
    fee_type_id            INTEGER,
    fee_type_name          TEXT,
    amount_paid            REAL    DEFAULT 0,
    payment_date           TEXT,
    payment_mode           TEXT,
    receipt_no             TEXT,
    billing_month          TEXT,
    billing_month_canonical TEXT,
    billing_month_display  TEXT,
    remarks                TEXT,
    status                 TEXT    DEFAULT 'Paid',
    txn_direction          TEXT    DEFAULT 'IN',
    is_posted              INTEGER DEFAULT 0,
    fetched_at             TEXT    DEFAULT (datetime('now'))
  )`);
  try { db.run('ALTER TABLE payments ADD COLUMN billing_month_canonical TEXT'); } catch (_) {}
  try { db.run('ALTER TABLE payments ADD COLUMN billing_month_display TEXT'); } catch (_) {}

  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_billing  ON payments(student_id, billing_month)`);

  // ── Offline match tables ──────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS local_matches (
    local_id        TEXT PRIMARY KEY,
    server_match_id INTEGER DEFAULT 0,
    opponent_name   TEXT NOT NULL DEFAULT '',
    match_date      TEXT NOT NULL DEFAULT '',
    match_type      TEXT DEFAULT 'Friendly',
    venue           TEXT DEFAULT '',
    toss_winner     TEXT DEFAULT '',
    toss_decision   TEXT DEFAULT 'Bat',
    match_status    TEXT DEFAULT 'Scheduled',
    result_status   TEXT DEFAULT '',
    current_innings INTEGER DEFAULT 1,
    synced          INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT '',
    updated_at      TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS local_lineup (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        TEXT NOT NULL,
    student_id      INTEGER NOT NULL,
    student_name    TEXT NOT NULL DEFAULT '',
    batting_pos     INTEGER DEFAULT 0,
    is_captain      INTEGER DEFAULT 0,
    is_wicketkeeper INTEGER DEFAULT 0,
    UNIQUE(match_id, student_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS local_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        TEXT NOT NULL,
    student_id      INTEGER NOT NULL,
    student_name    TEXT NOT NULL DEFAULT '',
    innings_no      INTEGER DEFAULT 1,
    runs_scored     INTEGER DEFAULT 0,
    balls_faced     INTEGER DEFAULT 0,
    fours           INTEGER DEFAULT 0,
    sixes           INTEGER DEFAULT 0,
    how_out         TEXT DEFAULT 'Not Out',
    batting_done    INTEGER DEFAULT 0,
    overs_bowled    REAL DEFAULT 0,
    runs_conceded   INTEGER DEFAULT 0,
    wickets_taken   INTEGER DEFAULT 0,
    wides_bowled    INTEGER DEFAULT 0,
    no_balls_bowled INTEGER DEFAULT 0,
    catches         INTEGER DEFAULT 0,
    stumpings       INTEGER DEFAULT 0,
    run_outs        INTEGER DEFAULT 0,
    updated_at      TEXT DEFAULT '',
    UNIQUE(match_id, student_id, innings_no)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS local_innings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        TEXT NOT NULL,
    innings_no      INTEGER NOT NULL DEFAULT 1,
    batting_team    TEXT DEFAULT 'QCA',
    total_runs      INTEGER DEFAULT 0,
    total_wickets   INTEGER DEFAULT 0,
    total_overs     REAL DEFAULT 0,
    extras_wides    INTEGER DEFAULT 0,
    extras_noballs  INTEGER DEFAULT 0,
    extras_byes     INTEGER DEFAULT 0,
    extras_legbyes  INTEGER DEFAULT 0,
    extras_penalty  INTEGER DEFAULT 0,
    declared        INTEGER DEFAULT 0,
    target_runs     INTEGER DEFAULT 0,
    synced          INTEGER DEFAULT 0,
    updated_at      TEXT DEFAULT '',
    UNIQUE(match_id, innings_no)
  )`);

  // ── pending_media ─────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS pending_media (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    local_path            TEXT,
    resource_type         TEXT    NOT NULL DEFAULT 'image',
    file_size_bytes       INTEGER DEFAULT 0,
    student_ids_json      TEXT    NOT NULL DEFAULT '[]',
    tag_type              TEXT    NOT NULL DEFAULT 'Training',
    coach_note            TEXT    DEFAULT '',
    session_type          TEXT    DEFAULT '',
    attendance_date       TEXT    DEFAULT '',
    video_mime            TEXT    DEFAULT '',
    cloudinary_public_id  TEXT    DEFAULT '',
    secure_url            TEXT    DEFAULT '',
    status                TEXT    NOT NULL DEFAULT 'pending',
    error_msg             TEXT    DEFAULT '',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    synced_at             TEXT    DEFAULT NULL
  )`);
  try { db.run("ALTER TABLE pending_media ADD COLUMN video_mime TEXT DEFAULT ''"); } catch (_) {}

  // ── Purge corrupted pending_media rows ────────────────────────────────────
  // Rows where student_ids_json has "[object" were stored before Number() fix.
  // The blobs are gone too (in-memory only), so deletion is safe.
  // This runs every startup — harmless if no bad rows exist.
  db.run(`DELETE FROM pending_media WHERE student_ids_json LIKE '%[object%'`);

  // ── Payment summary cache (months due etc.) ────────────────────────────────
  // Stored as JSON blob per student — avoids recomputing on every render.
  db.run(`CREATE TABLE IF NOT EXISTS payment_summary (
    student_id        INTEGER PRIMARY KEY,
    student_name      TEXT,
    enrollment_date   TEXT,
    monthly_fee       REAL    DEFAULT 0,
    total_paid        REAL    DEFAULT 0,
    total_purchases   REAL    DEFAULT 0,
    last_payment_date TEXT,
    paid_months_json  TEXT    DEFAULT '[]',
    due_months_json   TEXT    DEFAULT '[]',
    months_due_count  INTEGER DEFAULT 0,
    updated_at        TEXT    DEFAULT (datetime('now'))
  )`);
  // Migration: add total_purchases if upgrading existing DB
  try { db.run('ALTER TABLE payment_summary ADD COLUMN total_purchases REAL DEFAULT 0'); } catch (_) {}

  // Coaching library — cached from server for offline viewing
  db.run(`CREATE TABLE IF NOT EXISTS coaching_library (
    video_id      TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT,
    category      TEXT,
    url           TEXT,
    url_image     TEXT,
    duration_secs INTEGER DEFAULT 0,
    difficulty    TEXT DEFAULT 'All',
    skill_tags    TEXT DEFAULT '[]',
    views         INTEGER DEFAULT 0,
    likes         INTEGER DEFAULT 0,
    fetched_at    TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run("ALTER TABLE coaching_library ADD COLUMN duration_secs INTEGER DEFAULT 0"); } catch(_){}
  try { db.run("ALTER TABLE coaching_library ADD COLUMN difficulty TEXT DEFAULT 'All'"); } catch(_){}
  try { db.run("ALTER TABLE coaching_library ADD COLUMN skill_tags TEXT DEFAULT '[]'"); } catch(_){}
  db.run(`CREATE INDEX IF NOT EXISTS idx_lib_category ON coaching_library(category)`);

  // Academy YouTube channel videos
  db.run(`CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id      TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT,
    thumbnail_url TEXT,
    view_count    INTEGER DEFAULT 0,
    is_popular    INTEGER DEFAULT 0,
    display_order INTEGER DEFAULT 9999,
    published_at  TEXT,
    fetched_at    TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_yt_display ON youtube_videos(display_order)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_yt_popular ON youtube_videos(is_popular, display_order)`);

  // ── Cricket Hub: News cache ─────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS hub_news (
    id            INTEGER PRIMARY KEY,
    headline      TEXT    NOT NULL,
    summary       TEXT,
    short_summary TEXT,
    media_url     TEXT,
    category      TEXT    DEFAULT 'Cricket',
    coaching_insight TEXT,
    source_url    TEXT,
    published_at  TEXT,
    is_bookmarked INTEGER DEFAULT 0,
    is_read       INTEGER DEFAULT 0,
    fetched_at    TEXT    DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hub_news_cat ON hub_news(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hub_news_bm  ON hub_news(is_bookmarked)`);

  // ── Cricket Hub: Insights cache ──────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS hub_insights (
    id            INTEGER PRIMARY KEY,
    insight_title TEXT    NOT NULL,
    skill_focus   TEXT    DEFAULT 'General',
    match_context TEXT,
    player_name   TEXT,
    match_teams   TEXT,
    coaching_text TEXT,
    drill_tip     TEXT,
    source_url    TEXT,
    media_url     TEXT,
    content_type  TEXT    DEFAULT 'TEXT_STORY',
    is_active     INTEGER DEFAULT 1,
    is_bookmarked INTEGER DEFAULT 0,
    is_read       INTEGER DEFAULT 0,
    published_at  TEXT,
    fetched_at    TEXT    DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hub_ins_skill ON hub_insights(skill_focus)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hub_ins_bm    ON hub_insights(is_bookmarked)`);

  // Library user activity — bookmarks, watch history, notes, progress
  db.run(`CREATE TABLE IF NOT EXISTS library_activity (
    video_id      TEXT PRIMARY KEY,
    is_bookmarked INTEGER DEFAULT 0,
    is_watched    INTEGER DEFAULT 0,
    watch_count   INTEGER DEFAULT 0,
    last_watched  TEXT,
    user_note     TEXT,
    watch_pct     INTEGER DEFAULT 0,
    resume_secs   INTEGER DEFAULT 0,
    rating        INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run("ALTER TABLE library_activity ADD COLUMN resume_secs INTEGER DEFAULT 0"); } catch(_){}
  try { db.run("ALTER TABLE library_activity ADD COLUMN rating INTEGER DEFAULT 0"); } catch(_){}

  // Library assignments — coach assigns videos to students (stored locally when synced)
  db.run(`CREATE TABLE IF NOT EXISTS library_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      TEXT NOT NULL,
    assigned_by   TEXT,               -- coach username
    assigned_to   TEXT,               -- student username or 'all'
    due_date      TEXT,
    message       TEXT,
    is_completed  INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  )`);

  await _save();
};

// ─── Coaching Library ────────────────────────────────────────────────────────
/** Full background sync — pulls ALL videos from server in batches of 200.
 *  Stores everything locally so browsing works offline with all 700+ videos.
 *  Tracks last_sync_time to avoid re-downloading unchanged content.
 */
export const syncLibraryFromServer = async (
  base: string,
  headers: Record<string,string>,
  onProgress?: (fetched: number, total: number) => void
): Promise<{ fetched: number; total: number }> => {
  const BATCH = 200;
  let offset  = 0;
  let fetched = 0;
  let grandTotal = 0;

  try {
    // First call — get total count and first batch
    const r0 = await fetch(
      `${base}/api/data/library?limit=${BATCH}&offset=0`,
      { headers }
    );
    if (!r0.ok) throw new Error(`HTTP ${r0.status}`);
    const j0 = await r0.json();
    grandTotal = j0.total ?? j0.count ?? 0;
    if (j0.data?.length) {
      await upsertLibraryItems(j0.data);
      fetched += j0.data.length;
      onProgress?.(fetched, grandTotal);
    }
    offset = BATCH;

    // Subsequent batches
    while (offset < grandTotal) {
      try {
        const r = await fetch(
          `${base}/api/data/library?limit=${BATCH}&offset=${offset}`,
          { headers }
        );
        if (!r.ok) break;
        const j = await r.json();
        if (!j.data?.length) break;
        await upsertLibraryItems(j.data);
        fetched += j.data.length;
        onProgress?.(fetched, grandTotal);
        offset += BATCH;
        // Small delay between batches — don't hammer the server
        await new Promise(res => setTimeout(res, 300));
      } catch { break; }
    }

    // Save sync timestamp
    localStorage.setItem('library_last_sync', Date.now().toString());
    console.log(`Library sync complete: ${fetched}/${grandTotal} videos`);
    return { fetched, total: grandTotal };
  } catch (e) {
    console.warn('Library sync failed:', e);
    return { fetched, total: grandTotal };
  }
};

/** How many minutes since last full sync */
export const libraryMinutesSinceSync = (): number => {
  const t = parseInt(localStorage.getItem('library_last_sync') || '0');
  if (!t) return Infinity;
  return Math.floor((Date.now() - t) / 60000);
};

/** Upsert library items from server response */
export const upsertLibraryItems = async (rows: any[]): Promise<void> => {
  const db = await getDb();
  const now = new Date().toISOString();
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO coaching_library
           (video_id, title, description, category, url, url_image, views, likes, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          r.video_id, r.title, r.description ?? null,
          r.category ?? null, r.url ?? null, r.url_image ?? null,
          r.views ?? 0, r.likes ?? 0, now,
        ]
      );
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  await _save();
};

/** Get all library items, optionally filtered by category */
export const getLibraryItems = async (category?: string): Promise<any[]> => {
  const db = await getDb();
  if (category) {
    return queryRows(db,
      'SELECT * FROM coaching_library WHERE category=? ORDER BY category, rowid DESC',
      [category]
    );
  }
  return queryRows(db,
    'SELECT * FROM coaching_library ORDER BY category ASC, rowid DESC',
    []
  );
};

/** Count cached library items */
export const getLibraryCount = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT COUNT(*) as n FROM coaching_library', [])[0]?.n as number) ?? 0;
};

/** Get library items joined with user activity */
export const getLibraryWithActivity = async (
  category?: string, limit = 10, offset = 0, search?: string
): Promise<any[]> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (category) { where.push('l.category = ?'); params.push(category); }
  if (search)   {
    where.push('(l.title LIKE ? OR l.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  return queryRows(db, `
    SELECT l.*,
           COALESCE(a.is_bookmarked, 0) AS is_bookmarked,
           COALESCE(a.is_watched,    0) AS is_watched,
           COALESCE(a.watch_count,   0) AS watch_count,
           a.last_watched,
           a.user_note,
           COALESCE(a.watch_pct,     0) AS watch_pct
    FROM coaching_library l
    LEFT JOIN library_activity a ON a.video_id = l.video_id
    ${w}
    ORDER BY l.category ASC, l.rowid DESC
    LIMIT ? OFFSET ?
  `, params);
};

/** Count with filters */
export const countLibrary = async (category?: string, search?: string): Promise<number> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (search)   {
    where.push('(title LIKE ? OR description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return (queryRows(db, `SELECT COUNT(*) as n FROM coaching_library ${w}`, params)[0]?.n as number) ?? 0;
};

/** Get bookmarked videos */
export const getBookmarks = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db, `
    SELECT l.*, a.last_watched, a.watch_count, a.watch_pct, a.user_note
    FROM coaching_library l
    JOIN library_activity a ON a.video_id = l.video_id
    WHERE a.is_bookmarked = 1
    ORDER BY a.updated_at DESC
  `, []);
};

/** Get recently watched */
export const getRecentlyWatched = async (limit = 5): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db, `
    SELECT l.*, a.last_watched, a.watch_count, a.watch_pct
    FROM coaching_library l
    JOIN library_activity a ON a.video_id = l.video_id
    WHERE a.last_watched IS NOT NULL
    ORDER BY a.last_watched DESC
    LIMIT ?
  `, [limit]);
};

/** Get assigned videos (for student role) */
export const getAssignments = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db, `
    SELECT ass.*, l.title, l.category, l.url, l.url_image,
           COALESCE(act.is_watched, 0) AS is_watched
    FROM library_assignments ass
    LEFT JOIN coaching_library l ON l.video_id = ass.video_id
    LEFT JOIN library_activity act ON act.video_id = ass.video_id
    ORDER BY ass.is_completed ASC, ass.due_date ASC
  `, []);
};

/** Mark video watched / update progress */
export const markWatched = async (videoId: string, pct = 100): Promise<void> => {
  const db = await getDb();
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO library_activity (video_id, is_watched, watch_count, last_watched, watch_pct, updated_at)
    VALUES (?, 1, 1, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      is_watched  = 1,
      watch_count = watch_count + 1,
      last_watched = excluded.last_watched,
      watch_pct   = MAX(watch_pct, excluded.watch_pct),
      updated_at  = excluded.updated_at
  `, [videoId, now, pct, now]);
  await _save();
};

/** Toggle bookmark */
export const toggleBookmark = async (videoId: string): Promise<boolean> => {
  const db = await getDb();
  const row = queryRows(db, 'SELECT is_bookmarked FROM library_activity WHERE video_id=?', [videoId])[0];
  const newVal = row ? (row.is_bookmarked ? 0 : 1) : 1;
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO library_activity (video_id, is_bookmarked, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      is_bookmarked = excluded.is_bookmarked,
      updated_at    = excluded.updated_at
  `, [videoId, newVal, now]);
  await _save();
  return newVal === 1;
};

/** Save user note on a video */
export const saveVideoNote = async (videoId: string, note: string): Promise<void> => {
  const db = await getDb();
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO library_activity (video_id, user_note, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      user_note  = excluded.user_note,
      updated_at = excluded.updated_at
  `, [videoId, note.trim(), now]);
  await _save();
};

/** Upsert assignments from server */
export const upsertAssignments = async (rows: any[]): Promise<void> => {
  const db = await getDb();
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(`
        INSERT OR REPLACE INTO library_assignments
          (id, video_id, assigned_by, assigned_to, due_date, message, is_completed, created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `, [r.id, r.video_id, r.assigned_by, r.assigned_to,
          r.due_date, r.message, r.is_completed ?? 0, r.created_at]);
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};

/** Get library stats summary */
export const getLibraryStats = async (): Promise<{total:number;watched:number;bookmarks:number;assigned:number}> => {
  const db = await getDb();
  const total     = (queryRows(db, 'SELECT COUNT(*) as n FROM coaching_library', [])[0]?.n as number) ?? 0;
  const watched   = (queryRows(db, 'SELECT COUNT(*) as n FROM library_activity WHERE is_watched=1', [])[0]?.n as number) ?? 0;
  const bookmarks = (queryRows(db, 'SELECT COUNT(*) as n FROM library_activity WHERE is_bookmarked=1', [])[0]?.n as number) ?? 0;
  const assigned  = (queryRows(db, 'SELECT COUNT(*) as n FROM library_assignments WHERE is_completed=0', [])[0]?.n as number) ?? 0;
  return { total, watched, bookmarks, assigned };
};

// ─── Library: Save star rating ───────────────────────────────────────────────
export const saveVideoRating = async (videoId: string, rating: number): Promise<void> => {
  const db  = await getDb();
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO library_activity (video_id, rating, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET rating=excluded.rating, updated_at=excluded.updated_at
  `, [videoId, Math.min(5, Math.max(0, rating)), now]);
  await _save();
};

// ─── Library: Save resume position (seconds) ─────────────────────────────────
export const saveResumePosition = async (videoId: string, secs: number, pct: number): Promise<void> => {
  const db  = await getDb();
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO library_activity (video_id, resume_secs, watch_pct, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      resume_secs = excluded.resume_secs,
      watch_pct   = MAX(watch_pct, excluded.watch_pct),
      updated_at  = excluded.updated_at
  `, [videoId, secs, pct, now]);
  await _save();
};

// ─── Library: Get stats per category ─────────────────────────────────────────
export const getLibraryCategoryStats = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db, `
    SELECT
      l.category,
      COUNT(l.video_id)                                  AS total,
      SUM(COALESCE(a.is_watched,0))                      AS watched,
      SUM(COALESCE(a.is_bookmarked,0))                   AS bookmarked
    FROM coaching_library l
    LEFT JOIN library_activity a ON a.video_id = l.video_id
    WHERE l.category IS NOT NULL
    GROUP BY l.category
    ORDER BY l.category
  `, []);
};

// ─── Academy YouTube Videos ─────────────────────────────────────────────────

/** Upsert videos from server */
export const upsertYoutubeVideos = async (rows: any[]): Promise<void> => {
  const db  = await getDb();
  const now = new Date().toISOString();
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO youtube_videos
           (video_id, title, description, thumbnail_url,
            view_count, is_popular, display_order, published_at, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          r.video_id, r.title, r.description ?? null,
          r.thumbnail_url ?? null,
          r.view_count ?? 0, r.is_popular ?? 0,
          r.display_order ?? 9999, r.published_at ?? null, now,
        ]
      );
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};

/** Get videos with optional search and sort */
export const getYoutubeVideos = async (
  sort: 'popular'|'newest'|'featured' = 'popular',
  limit = 10,
  offset = 0,
  search?: string
): Promise<any[]> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[]   = [];
  if (search) {
    where.push('(title LIKE ? OR description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = sort === 'newest'   ? 'ORDER BY published_at DESC'
              : sort === 'featured' ? 'ORDER BY is_popular DESC, display_order ASC'
              : 'ORDER BY display_order ASC, view_count DESC';
  params.push(limit, offset);
  return queryRows(db,
    `SELECT * FROM youtube_videos ${w} ${order} LIMIT ? OFFSET ?`,
    params
  );
};

/** Count with optional search */
export const countYoutubeVideos = async (search?: string): Promise<number> => {
  const db = await getDb();
  const params: any[] = [];
  let w = '';
  if (search) {
    w = 'WHERE (title LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  return (queryRows(db, `SELECT COUNT(*) as n FROM youtube_videos ${w}`, params)[0]?.n as number) ?? 0;
};

/** Full background sync — pulls ALL academy videos in batches */
export const syncYoutubeFromServer = async (
  base: string,
  headers: Record<string, string>,
  sort = 'popular',
  onProgress?: (fetched: number, total: number) => void
): Promise<{ fetched: number; total: number }> => {
  const BATCH = 200;
  let offset  = 0;
  let fetched = 0;
  let grandTotal = 0;
  try {
    const r0 = await fetch(
      `${base}/api/data/videos?sort=${sort}&limit=${BATCH}&offset=0`,
      { headers }
    );
    if (!r0.ok) throw new Error(`HTTP ${r0.status}`);
    const j0 = await r0.json();
    grandTotal = j0.total ?? 0;
    if (j0.data?.length) {
      await upsertYoutubeVideos(j0.data);
      fetched += j0.data.length;
      onProgress?.(fetched, grandTotal);
    }
    offset = BATCH;
    while (offset < grandTotal) {
      try {
        const r = await fetch(
          `${base}/api/data/videos?sort=${sort}&limit=${BATCH}&offset=${offset}`,
          { headers }
        );
        if (!r.ok) break;
        const j = await r.json();
        if (!j.data?.length) break;
        await upsertYoutubeVideos(j.data);
        fetched += j.data.length;
        onProgress?.(fetched, grandTotal);
        offset += BATCH;
        await new Promise(res => setTimeout(res, 300));
      } catch { break; }
    }
    localStorage.setItem('yt_last_sync', Date.now().toString());
    return { fetched, total: grandTotal };
  } catch (e) {
    console.warn('YouTube sync failed:', e);
    return { fetched, total: grandTotal };
  }
};

export const ytMinutesSinceSync = (): number => {
  const t = parseInt(localStorage.getItem('yt_last_sync') || '0');
  if (!t) return Infinity;
  return Math.floor((Date.now() - t) / 60000);
};

// ─── Image URL helper ─────────────────────────────────────────────────────────
// profile_image stores the relative filename e.g. "abc.jpg"  (may also be a
// full path like "images/students/abc.jpg" — we always take the basename).
// Server serves at:  http://SERVER:PORT/static/images/students/<filename>
export const getProfileImageUrl = (profileImage: string | null, _fallbackName?: string): string | null => {
  if (!profileImage) return null;
  const serverIp = localStorage.getItem('server_ip') || '';
  if (!serverIp) return null;
  // Use server_ip exactly as stored — supports both localhost:3125 and remote:80/443
  // Never hardcode a port; whatever the user configured is correct
  const clean    = serverIp.trim().replace(/\/+$/, '');
  const base     = clean.startsWith('http') ? clean : `http://${clean}`;
  const filename = profileImage.includes('/') ? profileImage.split('/').pop()! : profileImage;
  return `${base}/static/images/students/${filename}`;
};

/** Fallback avatar URL (always works, no server needed) */
export const getAvatarUrl = (name: string): string =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1a472a&color=d4af37&size=128`;

const IMAGE_CACHE = 'qca-student-images-v2';  // v2 — fixed port URL

// Per-session bookkeeping: photos already revalidated this session, and
// photos the server doesn't have (404) — so a list of 100 students doesn't
// re-request the same missing photos on every render.
const _imgRevalidated = new Set<string>();
const _imgMissing     = new Set<string>();

/**
 * Background check whether a cached photo changed on the server (same
 * filename, new content — photos are saved as "<id>.jpg"). Uses the HTTP
 * cache's conditional request (ETag), so an unchanged photo costs a 304.
 * At most once per photo per app session.
 */
const revalidateImage = (remoteUrl: string, cached: Response) => {
  if (_imgRevalidated.has(remoteUrl)) return;
  _imgRevalidated.add(remoteUrl);
  (async () => {
    try {
      const res = await fetch(remoteUrl, { mode: 'cors', cache: 'no-cache' });
      const cache = await caches.open(IMAGE_CACHE);
      if (res.status === 404) { await cache.delete(remoteUrl); return; }
      if (!res.ok) return;
      const oldTag = cached.headers.get('etag') || cached.headers.get('last-modified');
      const newTag = res.headers.get('etag') || res.headers.get('last-modified');
      if (newTag && newTag !== oldTag) await cache.put(remoteUrl, res);
    } catch { /* offline — keep the cached copy */ }
  })();
};

/** Drop a student photo from the cache (after upload/delete on this device). */
export const invalidateStudentImage = async (profileImage: string | null): Promise<void> => {
  const remoteUrl = profileImage ? getProfileImageUrl(profileImage) : null;
  if (!remoteUrl) return;
  _imgMissing.delete(remoteUrl);
  _imgRevalidated.delete(remoteUrl);
  try { await (await caches.open(IMAGE_CACHE)).delete(remoteUrl); } catch {}
};

/**
 * Returns an object-URL for the student photo.
 * Strategy:
 *  1. Check Cache API for a previously cached copy  →  use it (works offline),
 *     and revalidate it once per session in the background
 *  2. Fetch from server, store in cache              →  use it
 *  3. On any failure, return null so caller shows avatar
 */
export const getCachedImageUrl = async (profileImage: string | null): Promise<string | null> => {
  if (!profileImage) return null;
  const remoteUrl = getProfileImageUrl(profileImage);
  if (!remoteUrl || _imgMissing.has(remoteUrl)) return null;

  try {
    const cache = await caches.open(IMAGE_CACHE);

    // 1. Cache hit
    const cached = await cache.match(remoteUrl);
    if (cached) {
      revalidateImage(remoteUrl, cached.clone());
      const blob = await cached.blob();
      return URL.createObjectURL(blob);
    }

    // 2. Network fetch → cache
    const res = await fetch(remoteUrl, { mode: 'cors' });
    if (res.status === 404) { _imgMissing.add(remoteUrl); return null; }
    if (!res.ok) return null;
    _imgRevalidated.add(remoteUrl);   // just fetched — fresh for this session
    await cache.put(remoteUrl, res.clone());
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
};

/**
 * Member photo URL (club_members.image_url) — full relative path is
 * already stored, e.g. "/static/club_assets/member_1.jpg" — so unlike
 * student profile_image (bare filename only), this just needs server_ip
 * prefixed, never a hardcoded host/port.
 */
export const getMemberPhotoUrl = (imageUrl: string | null): string | null => {
  if (!imageUrl) return null;
  const serverIp = localStorage.getItem('server_ip') || '';
  if (!serverIp) return null;
  const clean = serverIp.trim().replace(/\/+$/, '');
  const base  = clean.startsWith('http') ? clean : `http://${clean}`;
  const path  = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
  return `${base}${path}`;
};

const MEMBER_IMAGE_CACHE = 'qca-member-images-v1';

/**
 * Returns an object-URL for a club member's photo — same caching/blob
 * strategy as getCachedImageUrl (student photos): fetch via JS with
 * mode:'cors', convert to a local blob: URL. This is what actually
 * makes images reliable in the Capacitor WebView — a raw <img src>
 * pointed straight at a remote https:// URL is subject to whatever
 * CSP/mixed-content restrictions the WebView has; a blob: URL is
 * locally-generated and same-origin, so none of that applies once the
 * fetch has already succeeded once.
 */
export const getCachedMemberImageUrl = async (imageUrl: string | null): Promise<string | null> => {
  if (!imageUrl) return null;
  const remoteUrl = getMemberPhotoUrl(imageUrl);
  if (!remoteUrl) return null;

  try {
    const cache = await caches.open(MEMBER_IMAGE_CACHE);

    const cached = await cache.match(remoteUrl);
    if (cached) {
      const blob = await cached.blob();
      return URL.createObjectURL(blob);
    }

    const res = await fetch(remoteUrl, { mode: 'cors' });
    if (!res.ok) return null;
    await cache.put(remoteUrl, res.clone());
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
};

// ─── Students ─────────────────────────────────────────────────────────────────

export const syncAllStudents = async (studentList: any[]): Promise<void> => {
  const db = await getDb();
  db.run('BEGIN TRANSACTION');
  try {
    for (const s of studentList) {
      db.run(
        `INSERT OR REPLACE INTO students
           (id, name, age, phone, email, level, user_id, status,
            school_name, date_of_birth, parent_name, student_type,
            blood_group, dominant_side, profile_image, monthly_fee,
            student_category, enrollment_date, gender, current_grade,
            parent_phone, parent_email, emergency_contact_name,
            emergency_contact_phone, medical_conditions, kit_size, referral_source,
            regno, address, qca_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [s.id,             s.name            ?? 'Unknown',
         s.age             ?? 0,
         s.phone           ?? '',
         s.email           ?? '',
         s.level           ?? 'Beginner',
         s.user_id         ?? null,
         s.status          ?? 'Active',
         s.school_name     ?? '',
         s.date_of_birth   ?? null,
         s.parent_name     ?? '',
         s.student_type    ?? 'Academy',
         s.blood_group     ?? '',
         s.dominant_side   ?? '',
         s.profile_image   ?? null,
         s.monthly_fee     ?? 1000.0,
         s.student_category?? 'REGULAR',
         s.enrollment_date ?? null,
         s.gender          ?? '',
         s.current_grade   ?? '',
         s.parent_phone    ?? '',
         s.parent_email    ?? '',
         s.emergency_contact_name  ?? '',
         s.emergency_contact_phone ?? '',
         s.medical_conditions      ?? '',
         s.kit_size        ?? '',
         s.referral_source ?? '',
         s.regno           ?? null,
         s.address         ?? null,
         s.qca_id          ?? null,
        ]
      );
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};


// Update a single student's editable fields in local DB after server save
export const updateLocalStudent = async (studentId: number, fields: Record<string, any>): Promise<void> => {
  const db = await getDb();
  const allowed = [
    // Personal
    'gender', 'age', 'date_of_birth', 'blood_group',
    'email', 'phone',
    'school_name', 'current_grade', 'medical_conditions',
    // Contact
    'parent_name', 'parent_phone', 'parent_email',
    'emergency_contact_name', 'emergency_contact_phone',
    // Academy
    'enrollment_date', 'level', 'student_type',
    'dominant_side', 'kit_size', 'referral_source',
    'student_category', 'status', 'monthly_fee',
    // Photo
    'profile_image',
    'regno', 'address', 'qca_id',
  ];
  const toSet: string[] = [];
  const vals: any[]     = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k) && v !== undefined) {
      toSet.push(`${k}=?`);
      vals.push(v ?? null);
    }
  }
  if (!toSet.length) return;
  vals.push(studentId);
  db.run(`UPDATE students SET ${toSet.join(', ')} WHERE id=?`, vals);
  await _save();
  console.log(`[DB] updateLocalStudent id=${studentId} updated: ${toSet.map(s=>s.split('=')[0]).join(', ')}`);
};

export const getActiveStudents = async (): Promise<any[]> => {
  const db = await getDb();
  // Real students
  const real = queryRows(db, `SELECT id,name,level,profile_image,enrollment_date,regno,qca_id FROM students WHERE status IN ('Active','Club Member') ORDER BY CASE WHEN qca_id IS NULL THEN 1 ELSE 0 END, qca_id ASC, name ASC`);
  // Temp students (pending server ID) — use negative ID to avoid collision
  const temps = queryRows(db, `SELECT temp_id,name,enrollment_date FROM temp_students WHERE server_id IS NULL ORDER BY temp_id ASC`);
  const tempRows = temps.map((t:any) => ({
    id:             -t.temp_id,   // negative = temp student marker
    name:           t.name + ' [TMP]',
    level:          'Temp',
    profile_image:  null,
    enrollment_date:t.enrollment_date,
    is_temp:        true,
    temp_id:        t.temp_id,
  }));
  return [...real, ...tempRows];
};
export const getAllStudentsInclInactive = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT id, name, level, profile_image, enrollment_date, regno, qca_id, status
     FROM students
     WHERE status IN ('Active', 'Club Member', 'Inactive')
     ORDER BY CASE WHEN qca_id IS NULL THEN 1 ELSE 0 END, qca_id ASC, name ASC`
  );
};


export const getAllStudents = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT id,name,level,status,phone,email,age,parent_name,school_name,
            blood_group,dominant_side,student_type,student_category,monthly_fee,
            date_of_birth,profile_image,enrollment_date,
            parent_phone,parent_email,emergency_contact_name,emergency_contact_phone,
            medical_conditions,kit_size,referral_source,gender,current_grade,
            regno,address,qca_id
     FROM students
     ORDER BY
       CASE WHEN regno IS NULL OR regno = '' THEN 1 ELSE 0 END ASC,
       CAST(regno AS INTEGER) ASC,
       id ASC`
  );
};

export const getStudentById = async (id: number): Promise<any|null> => {
  const db = await getDb();
  return queryRows(db, 'SELECT * FROM students WHERE id=?', [id])[0] ?? null;
};

export const getStudentCount = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT COUNT(*) as n FROM students')[0]?.n as number) ?? 0;
};

// ─── Coach Attendance ─────────────────────────────────────────────────────────

export const getAttendanceMap = async (date: string, session: string): Promise<Record<number,boolean>> => {
  const db = await getDb();
  const rows = queryRows(db, `SELECT student_id,status FROM attendance WHERE attendance_date=? AND session_type=?`, [date, session]);
  const map: Record<number,boolean> = {};
  rows.forEach(r => { map[r.student_id as number] = r.status === 1; });
  return map;
};

/**
 * Returns per-student attendance WITH synced flag for the attendance screen.
 * Keyed by student_id → { present, synced }
 * synced=true means already uploaded to server — row must be locked in UI.
 */
export const getAttendanceMapWithSync = async (
  date: string,
  session: string
): Promise<Record<number, { present: boolean; synced: boolean }>> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT student_id, status, synced FROM attendance
     WHERE attendance_date = ? AND session_type = ?`,
    [date, session]
  );
  const map: Record<number, { present: boolean; synced: boolean }> = {};
  rows.forEach(r => {
    map[r.student_id as number] = {
      present: r.status === 1,
      synced:  r.synced === 1,
    };
  });
  return map;
};

/**
 * Delete ALL local attendance records for a date+session.
 * ONLY deletes unsynced records — synced ones are never touched.
 * Returns { deleted, blockedCount } where blockedCount > 0 means
 * some records were synced and could not be deleted.
 */
export const deleteAttendanceSession = async (
  date: string,
  session: string
): Promise<{ deleted: number; blockedCount: number }> => {
  const db = await getDb();
  // Count synced rows — we will NOT delete these
  const syncedRows = queryRows(db,
    `SELECT COUNT(*) as n FROM attendance
     WHERE attendance_date = ? AND session_type = ? AND synced = 1`,
    [date, session]
  );
  const blockedCount = (syncedRows[0]?.n as number) ?? 0;

  // Delete only unsynced rows
  db.run(
    `DELETE FROM attendance
     WHERE attendance_date = ? AND session_type = ? AND synced = 0`,
    [date, session]
  );

  // Count what we actually deleted
  const remaining = queryRows(db,
    `SELECT COUNT(*) as n FROM attendance
     WHERE attendance_date = ? AND session_type = ?`,
    [date, session]
  );
  const remainingCount = (remaining[0]?.n as number) ?? 0;
  // deleted = original total - blocked - remaining
  const deleted = blockedCount > 0 ? 0 : (remainingCount === 0 ? 1 : 0); // simplified: just report blockedCount
  await _save();
  return { deleted: blockedCount === 0 ? 1 : 0, blockedCount };
};

/**
 * Force-delete ALL attendance for a date+session including synced rows.
 * Used by sync service when server data replaces local session data.
 * NOT for coach use — sync service only.
 */
export const forceDeleteAttendanceSession = async (
  date: string,
  session: string
): Promise<number> => {
  const db = await getDb();
  const before = (queryRows(db,
    `SELECT COUNT(*) as n FROM attendance WHERE attendance_date=? AND session_type=?`,
    [date, session]
  )[0]?.n as number) ?? 0;
  db.run(
    `DELETE FROM attendance WHERE attendance_date=? AND session_type=?`,
    [date, session]
  );
  return before;
};

/**
 * Delete a single student's attendance record for a date+session.
 * Only deletes if NOT synced. Returns true if deleted, false if blocked.
 */
export const deleteStudentAttendance = async (
  studentId: number,
  date: string,
  session: string
): Promise<boolean> => {
  const db = await getDb();
  const row = queryRows(db,
    `SELECT synced FROM attendance
     WHERE student_id = ? AND attendance_date = ? AND session_type = ?`,
    [studentId, date, session]
  )[0];
  if (!row) return true;       // nothing to delete
  if (row.synced === 1) return false;  // synced — block deletion
  db.run(
    `DELETE FROM attendance
     WHERE student_id = ? AND attendance_date = ? AND session_type = ? AND synced = 0`,
    [studentId, date, session]
  );
  await _save();
  return true;
};

export const upsertAttendance = async (studentId: number, date: string, session: string, present: boolean): Promise<void> => {
  const db = await getDb();
  db.run(
    `INSERT INTO attendance (student_id,attendance_date,session_type,status,synced,updated_at) VALUES (?,?,?,?,0,datetime('now'))
     ON CONFLICT(student_id,attendance_date,session_type) DO UPDATE SET status=excluded.status,synced=0,updated_at=datetime('now')`,
    [studentId, date, session, present ? 1 : 0]
  );
  await _save();
};

/**
 * RECOVERY TOOL: marks every local attendance row for the given
 * (date, session) as unsynced (synced=0), regardless of its current
 * synced state — so the next "Upload Attendance" re-sends the whole
 * session to the server.
 *
 * Use this when the server has fewer records for a session than the
 * local cache (e.g. caused by the old /upload/attendance bug where a
 * partial re-upload from the same coach wiped out previously-uploaded
 * records for the same date+session). Safe to use with the corrected
 * server-side upload logic, which now deletes-then-inserts PER STUDENT
 * rather than per (coach, date, session) — re-uploading the full local
 * session will restore any records the server lost without affecting
 * records uploaded by other coaches for the same session.
 *
 * Returns the number of local rows marked for re-upload.
 */
export const markSessionForResync = async (date: string, session: string): Promise<number> => {
  const db = await getDb();
  db.run(
    `UPDATE attendance SET synced=0, updated_at=datetime('now')
       WHERE attendance_date=? AND session_type=?`,
    [date, session]
  );
  const count = db.getRowsModified();
  await _save();
  return count;
};

export const getUnsyncedAttendance = async (): Promise<any[]> => {
  const db = await getDb();
  const c=new Date(); c.setDate(c.getDate()-7);
  const cs=c.toISOString().split('T')[0];
  return queryRows(db,'SELECT * FROM attendance WHERE synced=0 AND attendance_date>=?',[cs]);
};

export const markAttendanceSynced = async (sessionIds: number[]): Promise<void> => {
  if (!sessionIds.length) return;
  const db = await getDb();
  db.run(`UPDATE attendance SET synced=1 WHERE session_id IN (${sessionIds.map(()=>'?').join(',')})`, [...sessionIds]);
  await _save();
};

export const getPendingUploadCount = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT COUNT(*) as n FROM attendance WHERE synced=0')[0]?.n as number) ?? 0;
};

/**
 * Returns pending (unsynced) attendance grouped by date + session.
 * Each row: { attendance_date, session_type, total, present, absent }
 * Sorted newest date first.
 */
export const getPendingByDateSession = async (): Promise<{
  attendance_date: string;
  session_type: string;
  total: number;
  present: number;
  absent: number;
}[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT
       attendance_date,
       session_type,
       COUNT(*)                          AS total,
       SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) AS present,
       SUM(CASE WHEN status=0 THEN 1 ELSE 0 END) AS absent
     FROM attendance
     WHERE synced = 0
     GROUP BY attendance_date, session_type
     ORDER BY attendance_date DESC, session_type ASC`
  ) as any[];
};

export interface AttendanceRow {
  session_id: number; attendance_date: string; session_type: string;
  student_id: number; name: string; status: number; synced: number;
}

// ═══════════════════════════════════════════════════════════════════
// TEMP STUDENTS — local-only until server assigns a real ID
// ═══════════════════════════════════════════════════════════════════

export interface TempStudent {
  temp_id: number;
  name: string;
  date_of_birth: string;
  status: string;
  student_category: string;
  enrollment_date: string;
  created_at: string;
  server_id: number | null;
}

/** Add a new temp student — returns the local temp_id immediately */
export const addTempStudent = async (data: {
  name: string;
  date_of_birth: string;
  status?: string;
  student_category?: string;
  enrollment_date?: string;
}): Promise<number> => {
  const db  = await getDb();
  const now = new Date().toISOString();
  const enroll = data.enrollment_date || now.split('T')[0];
  db.run(
    `INSERT INTO temp_students (name, date_of_birth, status, student_category, enrollment_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.name.trim(), data.date_of_birth,
     data.status || 'Active', data.student_category || 'REGULAR',
     enroll, now]
  );
  const row = queryRows(db, 'SELECT last_insert_rowid() as id')[0];
  await _save();
  return (row?.id as number) ?? 0;
};

/** Get all temp students not yet assigned a server ID */
export const getPendingTempStudents = async (): Promise<TempStudent[]> => {
  const db = await getDb();
  return queryRows(db,
    'SELECT * FROM temp_students WHERE server_id IS NULL ORDER BY created_at DESC'
  ) as TempStudent[];
};

/** Get all temp students (including resolved) */
export const getAllTempStudents = async (): Promise<TempStudent[]> => {
  const db = await getDb();
  return queryRows(db,
    'SELECT * FROM temp_students ORDER BY created_at DESC'
  ) as TempStudent[];
};

/**
 * Link a temp student to a real server-assigned student_id.
 * Also migrates all attendance recorded under temp_id to the real student_id.
 */
export const resolveTempStudent = async (tempId: number, serverId: number): Promise<void> => {
  const db = await getDb();
  db.run('BEGIN TRANSACTION');
  try {
    // Update temp record with server ID
    db.run('UPDATE temp_students SET server_id=? WHERE temp_id=?', [serverId, tempId]);

    // Migrate attendance: temp students are stored with negative student_id (-temp_id)
    // to avoid collision with real student IDs
    db.run(
      'UPDATE attendance SET student_id=?, synced=0 WHERE student_id=?',
      [serverId, -tempId]
    );
    db.run('COMMIT');
    await _save();
  } catch (e: any) {
    db.run('ROLLBACK');
    throw new Error(`resolveTempStudent failed: ${e?.message}`);
  }
};

/** Delete a temp student and their attendance records */
export const deleteTempStudent = async (tempId: number): Promise<void> => {
  const db = await getDb();
  db.run('DELETE FROM attendance WHERE student_id=?', [-tempId]);
  db.run('DELETE FROM temp_students WHERE temp_id=?', [tempId]);
  await _save();
};

/** Get present attendance for a student in last 7 days — checks local attendance table */
export const getAttendanceForStudentLast7Days = async (studentId: number): Promise<any[]> => {
  const db = await getDb();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const fromStr = cutoff.toISOString().split('T')[0];
  return queryRows(db,
    `SELECT attendance_date, session_type, status FROM attendance
     WHERE student_id=? AND status=1 AND attendance_date>=?
     ORDER BY attendance_date DESC`,
    [studentId, fromStr]
  );
};

export const getAllAttendanceRecords = async (
  fromDate?:   string,    // YYYY-MM-DD filter start (optional)
  limit      = 200,       // max rows to return
  studentIds?: number[]   // restrict to specific students (student/parent roles)
): Promise<AttendanceRow[]> => {
  const db = await getDb();
  const params: any[] = [];
  let where = 'WHERE a.status=1';
  if (fromDate) { where += ' AND a.attendance_date>=?'; params.push(fromDate); }
  if (studentIds && studentIds.length > 0) {
    const ph = studentIds.map(() => '?').join(',');
    where += ` AND a.student_id IN (${ph})`;
    params.push(...studentIds);
  }
  params.push(limit);
  return queryRows(db,
    `SELECT a.session_id,a.attendance_date,a.session_type,a.student_id,s.name,a.status,a.synced
     FROM attendance a JOIN students s ON s.id=a.student_id
     ${where}
     ORDER BY a.attendance_date DESC,a.session_type ASC,a.student_id ASC
     LIMIT ?`,
    params
  ) as AttendanceRow[];
};

/**
 * Get all attendance records for a specific date+session regardless of synced flag.
 * Used for force re-upload — sends already-synced records again to server.
 */
export const getAttendanceByDateSession = async (
  date: string,
  session: string
): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT session_id, student_id, attendance_date, session_type, status, synced
     FROM attendance
     WHERE attendance_date = ? AND session_type = ?
     ORDER BY student_id ASC`,
    [date, session]
  );
};

/**
 * Get all distinct dates that have any attendance recorded locally.
 * Returns sorted descending (most recent first).
 */
export const getAttendanceDates = async (): Promise<string[]> => {
  const db = await getDb();
  // Only show last 7 days — re-upload window restriction
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const rows = queryRows(db,
    `SELECT DISTINCT attendance_date FROM attendance
     WHERE attendance_date >= ? ORDER BY attendance_date DESC`,
    [cutoffStr]
  );
  return rows.map(r => r.attendance_date as string);
};

/**
 * Get distinct sessions recorded for a specific date.
 */
export const getSessionsForDate = async (date: string): Promise<string[]> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT DISTINCT session_type FROM attendance WHERE attendance_date = ? ORDER BY session_type ASC`,
    [date]
  );
  return rows.map(r => r.session_type as string);
};

export const getActiveDatesInMonth = async (
  year: number, month: number, studentIds?: number[]
): Promise<Set<string>> => {
  const db = await getDb();
  const prefix = `${year}-${String(month).padStart(2,'0')}`;
  let rows;
  if (studentIds && studentIds.length > 0) {
    const ph = studentIds.map(() => '?').join(',');
    rows = queryRows(db,
      `SELECT DISTINCT attendance_date FROM attendance
       WHERE attendance_date LIKE ? AND student_id IN (${ph})
       ORDER BY attendance_date ASC`,
      [`${prefix}-%`, ...studentIds]
    );
  } else {
    rows = queryRows(db,
      `SELECT DISTINCT attendance_date FROM attendance WHERE attendance_date LIKE ? ORDER BY attendance_date ASC`,
      [`${prefix}-%`]
    );
  }
  return new Set(rows.map(r => r.attendance_date as string));
};

/**
 * Per-session attendance breakdown for a date, keyed by session_type.
 *
 * IMPORTANT: the local `attendance` table is a present-only mirror for any
 * session synced from the server (background sync / 7-day reconcile only
 * ever upsert status=1 rows - see useSyncService's upsertAttendanceLocal).
 * Absent rows only exist locally for sessions taken on THIS device that
 * haven't gone through a sync/reconcile cycle yet. Querying `attendance`
 * directly therefore returns present students only for most dates, which
 * made the History screen's "absent" list empty and its percentage pill
 * always read 100%.
 *
 * Fix: for each session that has at least one present record on this
 * date, build the roster from `students` (active as of this date, by
 * enrollment_date - plus anyone with an actual present record that date,
 * even if no longer active) and LEFT JOIN against that session's present
 * records. Anyone in the roster without a present record is "absent".
 */
export const getAttendanceHistory = async (
  date: string, studentIds?: number[]
): Promise<Record<string,{id:number;name:string;present:boolean;regno?:any;qca_id?:any;profile_image?:any}[]>> => {
  const db = await getDb();

  // Sessions that actually occurred on this date (any local attendance row -
  // present or absent - marks a session as having happened)
  const sessRows = queryRows(db,
    `SELECT DISTINCT session_type FROM attendance
     WHERE attendance_date=?
     ORDER BY session_type`,
    [date]
  );

  const studentFilter = studentIds && studentIds.length > 0
    ? ` AND s.id IN (${studentIds.map(() => '?').join(',')})`
    : '';

  const grouped: Record<string,any[]> = {};
  for (const { session_type } of sessRows) {
    const params: any[] = [date, session_type, date];
    if (studentIds && studentIds.length > 0) params.push(...studentIds);
    const rows = queryRows(db,
      `SELECT s.id, s.name, s.regno, s.qca_id, s.profile_image,
              CASE WHEN a.student_id IS NOT NULL THEN 1 ELSE 0 END as present
       FROM students s
       LEFT JOIN attendance a
         ON a.student_id=s.id AND a.attendance_date=? AND a.session_type=? AND a.status=1
       WHERE s.status IN ('Active','Club Member')
         AND (s.enrollment_date IS NULL OR s.enrollment_date='' OR s.enrollment_date<=?)${studentFilter}
       ORDER BY
         CASE WHEN s.regno IS NULL OR s.regno = '' THEN 1 ELSE 0 END ASC,
         CAST(s.regno AS INTEGER) ASC,
         s.id ASC`,
      params
    );
    grouped[session_type] = rows.map(row => ({
      id: row.id, name: row.name, present: row.present === 1,
      regno: row.regno, qca_id: row.qca_id, profile_image: row.profile_image,
    }));
  }
  return grouped;
};


// ════════════════════════════════════════════════════════════════════════════
//  CRICKET HUB — NEWS & INSIGHTS  (offline-first, same pattern as Library)
// ════════════════════════════════════════════════════════════════════════════

// ── Upsert news from server ───────────────────────────────────────────────────
export const upsertHubNews = async (rows: any[]): Promise<void> => {
  const db  = await getDb();
  const now = new Date().toISOString();
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO hub_news
           (id, headline, summary, short_summary, media_url, category,
            coaching_insight, source_url, published_at, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          r.id, r.headline, r.summary ?? null,
          r.short_summary ?? r.summary?.slice(0,200) ?? null,
          r.media_url ?? null, r.category ?? 'Cricket',
          r.coaching_insight ?? null, r.source_url ?? null,
          r.created_at ?? now, now,
        ]
      );
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};

// ── Get news from local DB ────────────────────────────────────────────────────
export const getHubNews = async (
  opts: { category?: string; bookmarked?: boolean; search?: string;
          limit?: number; offset?: number } = {}
): Promise<any[]> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[]   = [];
  if (opts.category)   { where.push('category = ?');        params.push(opts.category); }
  if (opts.bookmarked) { where.push('is_bookmarked = 1');   }
  if (opts.search)     {
    where.push('(headline LIKE ? OR summary LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  return queryRows(db,
    `SELECT * FROM hub_news ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, params);
};

export const countHubNews = async (category?: string, search?: string): Promise<number> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[]   = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (search)   { where.push('(headline LIKE ? OR summary LIKE ?)'); params.push(`%${search}%`,`%${search}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return (queryRows(db, `SELECT COUNT(*) as n FROM hub_news ${w}`, params)[0]?.n as number) ?? 0;
};

export const toggleNewsBookmark = async (id: number): Promise<boolean> => {
  const db  = await getDb();
  const row = queryRows(db, 'SELECT is_bookmarked FROM hub_news WHERE id=?', [id])[0];
  const val = row ? (row.is_bookmarked ? 0 : 1) : 1;
  db.run('UPDATE hub_news SET is_bookmarked=? WHERE id=?', [val, id]);
  await _save();
  return val === 1;
};

export const markNewsRead = async (id: number): Promise<void> => {
  const db = await getDb();
  db.run('UPDATE hub_news SET is_read=1 WHERE id=?', [id]);
  await _save();
};

// ── Upsert insights from server ───────────────────────────────────────────────
export const upsertHubInsights = async (rows: any[]): Promise<void> => {
  const db  = await getDb();
  const now = new Date().toISOString();
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO hub_insights
           (id, insight_title, skill_focus, match_context, player_name,
            match_teams, coaching_text, drill_tip, source_url, media_url,
            content_type, is_active, published_at, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          r.id, r.insight_title, r.skill_focus ?? 'General',
          r.match_context ?? null, r.player_name ?? null,
          r.match_teams ?? null, r.coaching_text ?? null,
          r.drill_tip ?? null, r.source_url ?? null,
          r.media_url ?? null, r.content_type ?? 'TEXT_STORY',
          r.is_active ?? 1, r.created_at ?? now, now,
        ]
      );
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};

export const getHubInsights = async (
  opts: { skill?: string; bookmarked?: boolean; search?: string;
          limit?: number; offset?: number } = {}
): Promise<any[]> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[]   = [];
  if (opts.skill)      { where.push('skill_focus = ?');     params.push(opts.skill); }
  if (opts.bookmarked) { where.push('is_bookmarked = 1');   }
  if (opts.search)     {
    where.push('(insight_title LIKE ? OR coaching_text LIKE ? OR player_name LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`, `%${opts.search}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  return queryRows(db,
    `SELECT * FROM hub_insights ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, params);
};

export const countHubInsights = async (skill?: string, search?: string): Promise<number> => {
  const db = await getDb();
  const where: string[] = [];
  const params: any[]   = [];
  if (skill)  { where.push('skill_focus = ?'); params.push(skill); }
  if (search) { where.push('(insight_title LIKE ? OR coaching_text LIKE ?)'); params.push(`%${search}%`,`%${search}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return (queryRows(db, `SELECT COUNT(*) as n FROM hub_insights ${w}`, params)[0]?.n as number) ?? 0;
};

export const toggleInsightBookmark = async (id: number): Promise<boolean> => {
  const db  = await getDb();
  const row = queryRows(db, 'SELECT is_bookmarked FROM hub_insights WHERE id=?', [id])[0];
  const val = row ? (row.is_bookmarked ? 0 : 1) : 1;
  db.run('UPDATE hub_insights SET is_bookmarked=? WHERE id=?', [val, id]);
  await _save();
  return val === 1;
};

export const markInsightRead = async (id: number): Promise<void> => {
  const db = await getDb();
  db.run('UPDATE hub_insights SET is_read=1 WHERE id=?', [id]);
  await _save();
};

// ── Full sync — news ──────────────────────────────────────────────────────────
export const syncHubNewsFromServer = async (
  base: string, headers: Record<string,string>,
  onProgress?: (fetched: number, total: number) => void
): Promise<{ fetched: number; total: number }> => {
  let fetched = 0; let grandTotal = 0;
  try {
    const r0 = await fetch(`${base}/api/data/news?show_all=1`, { headers });
    if (!r0.ok) throw new Error(`HTTP ${r0.status}`);
    const j0 = await r0.json();
    grandTotal = j0.total ?? 0;
    if (j0.data?.length) {
      await upsertHubNews(j0.data);
      fetched = j0.data.length;
      onProgress?.(fetched, grandTotal);
    }
    localStorage.setItem('hub_news_last_sync', Date.now().toString());
    return { fetched, total: grandTotal };
  } catch (e) {
    console.warn('Hub news sync failed:', e);
    return { fetched, total: grandTotal };
  }
};

// ── Full sync — insights ──────────────────────────────────────────────────────
export const syncHubInsightsFromServer = async (
  base: string, headers: Record<string,string>,
  onProgress?: (fetched: number, total: number) => void
): Promise<{ fetched: number; total: number }> => {
  let fetched = 0; let grandTotal = 0;
  try {
    const r0 = await fetch(`${base}/api/data/insights?show_all=1`, { headers });
    if (!r0.ok) throw new Error(`HTTP ${r0.status}`);
    const j0 = await r0.json();
    grandTotal = j0.total ?? 0;
    if (j0.data?.length) {
      await upsertHubInsights(j0.data);
      fetched = j0.data.length;
      onProgress?.(fetched, grandTotal);
    }
    localStorage.setItem('hub_insights_last_sync', Date.now().toString());
    return { fetched, total: grandTotal };
  } catch (e) {
    console.warn('Hub insights sync failed:', e);
    return { fetched, total: grandTotal };
  }
};

// ── Check latest only ─────────────────────────────────────────────────────────
export const checkLatestHubNews = async (
  base: string, headers: Record<string,string>
): Promise<boolean> => {
  try {
    const r = await fetch(`${base}/api/data/news?limit=5&offset=0`, { headers });
    if (!r.ok) return false;
    const j = await r.json();
    if (!j.data?.length) return false;
    await upsertHubNews(j.data);
    return true;
  } catch { return false; }
};

export const checkLatestHubInsights = async (
  base: string, headers: Record<string,string>
): Promise<boolean> => {
  try {
    const r = await fetch(`${base}/api/data/insights?limit=5&offset=0`, { headers });
    if (!r.ok) return false;
    const j = await r.json();
    if (!j.data?.length) return false;
    await upsertHubInsights(j.data);
    return true;
  } catch { return false; }
};

// ── Minutes since last sync ───────────────────────────────────────────────────
export const hubNewsMinutesSinceSync = (): number => {
  const t = parseInt(localStorage.getItem('hub_news_last_sync') || '0');
  return t ? Math.floor((Date.now() - t) / 60000) : Infinity;
};
export const hubInsightsMinutesSinceSync = (): number => {
  const t = parseInt(localStorage.getItem('hub_insights_last_sync') || '0');
  return t ? Math.floor((Date.now() - t) / 60000) : Infinity;
};

// ── Distinct categories & skills ─────────────────────────────────────────────
export const getHubNewsCategories = async (): Promise<string[]> => {
  const db = await getDb();
  return queryRows(db, 'SELECT DISTINCT category FROM hub_news ORDER BY category').map(r => r.category as string);
};
export const getHubInsightSkills = async (): Promise<string[]> => {
  const db = await getDb();
  return queryRows(db, 'SELECT DISTINCT skill_focus FROM hub_insights ORDER BY skill_focus').map(r => r.skill_focus as string);
};


// ── Count attendance for a student within a date range ───────────────────────
export const getAttendanceCountForRange = async (
  studentId: number,
  fromDate:  string,
  toDate:    string
): Promise<number> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT COUNT(*) as n FROM attendance
     WHERE student_id=? AND status=1
       AND attendance_date >= ? AND attendance_date <= ?`,
    [studentId, fromDate, toDate]
  );
  return (rows[0]?.n as number) ?? 0;
};

// ── Write-offs local table (read-only mirror of server) ──────────────────────
export const upsertWriteOffs = async (rows: any[]): Promise<number> => {
  if (!rows.length) return 0;
  const db = await getDb();
  // Ensure table exists
  db.run(`CREATE TABLE IF NOT EXISTS fee_write_offs (
    id               INTEGER PRIMARY KEY,
    student_id       INTEGER NOT NULL,
    billing_month    TEXT NOT NULL,
    amount           REAL DEFAULT 0,
    reason           TEXT DEFAULT '',
    remarks          TEXT DEFAULT '',
    approved_by      TEXT DEFAULT '',
    is_active        INTEGER DEFAULT 1,
    reversed_at      TEXT,
    reversed_by      TEXT,
    reversal_reason  TEXT,
    created_at       TEXT DEFAULT (CURRENT_TIMESTAMP)
  )`);
  let count = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(
        `INSERT INTO fee_write_offs
           (id, student_id, billing_month, amount, reason, remarks,
            approved_by, is_active, reversed_at, reversed_by, reversal_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           is_active       = excluded.is_active,
           reversed_at     = excluded.reversed_at,
           reversed_by     = excluded.reversed_by,
           reversal_reason = excluded.reversal_reason`,
        [
          r.id, r.student_id, r.billing_month, r.amount ?? 0,
          r.reason ?? '', r.remarks ?? '', r.approved_by ?? '',
          r.is_active ?? 1, r.reversed_at ?? null,
          r.reversed_by ?? null, r.reversal_reason ?? null,
          r.created_at ?? null,
        ]
      );
      count++;
    }
    db.run('COMMIT');
    await _save();
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  return count;
};

/**
 * Delete local attendance records for specific students on a given date+session.
 * Call this after a successful server-side delete (Attendance Correction) so
 * the local cache reflects the deletion immediately — without requiring a
 * Full Refresh. Removes from BOTH `attendance` (current) and
 * `hist_attendance` (calendar/summary source).
 */
export const deleteLocalAttendance = async (
  date: string, session: string, studentIds: number[]
): Promise<void> => {
  if (!studentIds.length) return;
  const db = await getDb();
  const ph = studentIds.map(() => '?').join(',');
  db.run('BEGIN TRANSACTION');
  try {
    db.run(
      `DELETE FROM attendance
         WHERE attendance_date=? AND session_type=? AND student_id IN (${ph})`,
      [date, session, ...studentIds]
    );
    db.run(
      `DELETE FROM hist_attendance
         WHERE attendance_date=? AND session_type=? AND student_id IN (${ph})`,
      [date, session, ...studentIds]
    );
    db.run('COMMIT');
    await _save();
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
};

/**
 * Apply a batch of attendance deletion tombstones (from
 * /sync/attendance/deletions) — each row is {student_id, attendance_date,
 * session_type}. Removes matching rows from local `attendance` and
 * `hist_attendance` if present. Safe to call repeatedly / for rows that
 * were never synced locally (no-op DELETE).
 *
 * This lets a correction made on one device propagate to all other devices
 * on their next sync, without requiring a Full Refresh.
 */
export const applyAttendanceDeletions = async (
  rows: {student_id:number; attendance_date:string; session_type:string; corrected_at?:string|null}[]
): Promise<number> => {
  if (!rows.length) return 0;
  const db = await getDb();
  let count = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      // Only delete a local row if it's NO NEWER than this tombstone's
      // correction time. A row written/synced AFTER the correction is a
      // re-capture for the same (student,date,session) slot, not the
      // deleted record — it must survive this tombstone.
      // (If corrected_at is missing — old tombstones predating this
      // column — fall back to the original unconditional delete.)
      const cutoff = r.corrected_at ?? null;
      db.run(
        `DELETE FROM attendance
           WHERE attendance_date=? AND session_type=? AND student_id=?
             AND (updated_at IS NULL OR ? IS NULL OR updated_at <= ?)`,
        [r.attendance_date, r.session_type, r.student_id, cutoff, cutoff]
      );
      const removedAtt = db.getRowsModified();

      db.run(
        `DELETE FROM hist_attendance
           WHERE attendance_date=? AND session_type=? AND student_id=?
             AND (fetched_at IS NULL OR ? IS NULL OR fetched_at <= ?)`,
        [r.attendance_date, r.session_type, r.student_id, cutoff, cutoff]
      );

      if (removedAtt > 0) count++;
    }
    db.run('COMMIT');
    await _save();
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  return count;
};

/**
 * Returns the set of all present-record ids (session_id) currently stored
 * in the local `attendance` table. Used by gap-detection ("Sync Missing")
 * to find server ids that were never pulled locally — regardless of date,
 * unlike the 7-day reconcile.
 */
export const getLocalAttendanceIds = async (): Promise<Set<number>> => {
  const db = await getDb();
  const rows = queryRows(db, `SELECT session_id FROM attendance`);
  return new Set(rows.map(r => r.session_id as number));
};

/**
 * Remove local attendance rows (and matching hist_attendance) by session_id.
 * Used by gap-detection to clean up local rows that no longer exist on the
 * server (e.g. a deletion whose tombstone predates this device's last sync,
 * or was made before the tombstone log existed).
 */
export const removeLocalAttendanceByIds = async (ids: number[]): Promise<number> => {
  if (!ids.length) return 0;
  const db = await getDb();
  const ph = ids.map(() => '?').join(',');
  let removed = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const id of ids) {
      const rowRes = db.exec(`SELECT student_id, attendance_date, session_type FROM attendance WHERE session_id=?`, [id]);
      const row = rowRes[0]?.values?.[0];
      if (row) {
        const [sid, date, session] = row as [number, string, string];
        db.run(`DELETE FROM hist_attendance WHERE student_id=? AND attendance_date=? AND session_type=?`, [sid, date, session]);
        removed++;
      }
    }
    db.run(`DELETE FROM attendance WHERE session_id IN (${ph})`, ids);
    db.run('COMMIT');
    await _save();
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  return removed;
};

/**
 * Upsert "real session day" calendar metadata synced from server.
 * This is computed server-side from the FULL attendance table (all
 * students), so it works correctly even for restricted roles (Student/
 * Parent) whose hist_attendance only contains their own records.
 */
export const upsertSessionDays = async (rows: {attendance_date:string; session_type:string}[]): Promise<number> => {
  if (!rows.length) return 0;
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS session_days (
    attendance_date TEXT NOT NULL,
    session_type    TEXT NOT NULL,
    UNIQUE(attendance_date, session_type)
  )`);
  let count = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const r of rows) {
      db.run(
        `INSERT OR IGNORE INTO session_days (attendance_date, session_type) VALUES (?, ?)`,
        [r.attendance_date, r.session_type]
      );
      count++;
    }
    db.run('COMMIT');
    await _save();
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  return count;
};

/** Replace all session_days with a fresh server list (used by full refresh) */
export const replaceSessionDays = async (rows: {attendance_date:string; session_type:string}[]): Promise<number> => {
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS session_days (
    attendance_date TEXT NOT NULL,
    session_type    TEXT NOT NULL,
    UNIQUE(attendance_date, session_type)
  )`);
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM session_days');
    for (const r of rows) {
      db.run(
        `INSERT OR IGNORE INTO session_days (attendance_date, session_type) VALUES (?, ?)`,
        [r.attendance_date, r.session_type]
      );
    }
    db.run('COMMIT');
    await _save();
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  return rows.length;
};

export const getWriteOffsForStudents = async (studentIds: number[]): Promise<any[]> => {
  if (!studentIds.length) return [];
  const db = await getDb();
  try {
    const ph   = studentIds.map(() => '?').join(',');
    const rows = db.exec(
      `SELECT id, student_id, billing_month, amount, reason, remarks,
              approved_by, is_active, reversed_at, created_at
       FROM fee_write_offs
       WHERE student_id IN (${ph}) AND is_active=1
       ORDER BY student_id, billing_month DESC`,
      studentIds
    );
    if (!rows[0]?.values?.length) return [];
    const cols = rows[0].columns;
    return rows[0].values.map(row => {
      const obj: any = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  } catch {
    return [];   // table may not exist yet — sync hasn't run
  }
};

export const getWriteOffsMaxId = async (): Promise<number> => {
  const db = await getDb();
  try {
    const rows = db.exec('SELECT MAX(id) as m FROM fee_write_offs');
    return (rows[0]?.values?.[0]?.[0] as number) ?? 0;
  } catch {
    return 0;
  }
};

// ─── Sync hist_attendance → attendance (mirror server data locally) ────────────
/**
 * After a hager download, copy all hist_attendance rows into the local
 * attendance table so both tables reflect the same server state.
 * Rows already in attendance (locally marked by coach) are preserved if
 * they are unsynced — server data only overwrites synced=1 rows.
 */
export const syncHistToAttendance = async (): Promise<number> => {
  const db  = await getDb();

  // Step 1: Save unsynced rows (coach-marked, not yet uploaded to server)
  const unsynced = queryRows(db,
    `SELECT student_id, attendance_date, session_type, status
     FROM attendance WHERE synced = 0`
  );

  // Step 2: Wipe entire attendance table — replace with server data
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM attendance');

    // Step 3: Re-populate from hist_attendance — ALL dates (full server mirror)
    const rows = queryRows(db,
      `SELECT student_id, attendance_date, session_type, status FROM hist_attendance`
    );
    let count = 0;
    for (const r of rows) {
      const s = String(r.status ?? '').toLowerCase().trim();
      const statusInt = (s === '1' || s === 'present' || s === 'true') ? 1 : 0;
      db.run(
        `INSERT OR IGNORE INTO attendance (student_id, attendance_date, session_type, status, synced)
         VALUES (?, ?, ?, ?, 1)`,
        [r.student_id, r.attendance_date, r.session_type, statusInt]
      );
      count++;
    }

    // Step 4: Re-insert unsynced rows (coach local data not yet pushed)
    // These take priority — overwrite server value for same slot if exists
    for (const u of unsynced) {
      db.run(
        `INSERT INTO attendance (student_id, attendance_date, session_type, status, synced)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(student_id, attendance_date, session_type) DO UPDATE SET
           status = excluded.status,
           synced = 0`,
        [u.student_id, u.attendance_date, u.session_type, u.status]
      );
    }

    db.run('COMMIT');
    await _save();
    return count;
  } catch (e: any) {
    db.run('ROLLBACK');
    throw new Error(`syncHistToAttendance failed: ${e?.message}`);
  }
};

// ─── hist_attendance ──────────────────────────────────────────────────────────

/** Max id in hist_attendance — used for incremental fetch */
export const getHistMaxId = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT MAX(id) as m FROM hist_attendance')[0]?.m as number) ?? 0;
};

export const upsertHistAttendance = async (rows: any[]): Promise<number> => {
  if (!rows.length) return 0;
  const db  = await getDb();
  const now = new Date().toISOString();
  let inserted = 0;

  const parseStatus = (r: any): number => {
    // Server attendance table stores status as TEXT: 'Present' or 'Absent'
    // Must check string value — NOT truthy check (both 'Present' and 'Absent' are truthy)
    const s = r.status ?? r.Status ?? r.present ?? '';
    if (typeof s === 'number') return s ? 1 : 0;
    if (typeof s === 'boolean') return s ? 1 : 0;
    const str = String(s).toLowerCase().trim();
    if (str === 'present' || str === '1' || str === 'true') return 1;
    if (str === 'absent'  || str === '0' || str === 'false') return 0;
    return 0; // default absent — safer than defaulting to present
  };

  const normalise = (r: any) => ({
    id:              r.id              ?? null,
    student_id:      r.student_id      ?? r.StudentID     ?? null,
    attendance_date: r.attendance_date ?? r.AttendanceDate ?? r.date    ?? null,
    session_type:    r.session_type    ?? r.SessionType    ?? r.session ?? 'Training',
    status:          parseStatus(r),
  });

  const CHUNK = 500;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const chunk = rows.slice(offset, offset + CHUNK);
    db.run('BEGIN TRANSACTION');
    try {
      for (const raw of chunk) {
        const r = normalise(raw);
        if (!r.student_id || !r.attendance_date) continue;
        // INSERT OR REPLACE — always update with latest server data
        // so corrected attendance is reflected immediately
        db.run(
          `INSERT OR REPLACE INTO hist_attendance
             (student_id,attendance_date,session_type,status,source,fetched_at)
           VALUES (?,?,?,?,?,?)`,
          [r.student_id, r.attendance_date, r.session_type, r.status, 'hager', now]
        );
        inserted++;
      }
      db.run('COMMIT');
    } catch (e: any) {
      db.run('ROLLBACK');
      throw new Error(`hist insert failed at offset ${offset}: ${e?.message ?? e}`);
    }
  }
  await _save();
  return inserted;
};

export const clearHistAttendance = async (): Promise<void> => {
  const db = await getDb();
  db.run('DELETE FROM hist_attendance');
  await _save();
};

export const getHistAttendanceCount = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT COUNT(*) as n FROM hist_attendance')[0]?.n as number) ?? 0;
};

export const getHistLastFetchedAt = async (): Promise<string|null> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT MAX(fetched_at) as t FROM hist_attendance')[0]?.t as string) ?? null;
};

export const getHistAttendanceForStudentMonth = async (
  studentId: number, year: number, month: number
): Promise<Record<string,{present:boolean;session_type:string}[]>> => {
  const db = await getDb();
  const prefix = `${year}-${String(month).padStart(2,'0')}`;
  const rows = queryRows(db,
    `SELECT attendance_date,session_type,status FROM hist_attendance
     WHERE student_id=? AND attendance_date LIKE ? ORDER BY attendance_date ASC,session_type ASC`,
    [studentId, `${prefix}-%`]
  );
  const map: Record<string,{present:boolean;session_type:string}[]> = {};
  rows.forEach(r => {
    const d = r.attendance_date as string;
    if (!map[d]) map[d] = [];
    map[d].push({ present: r.status === 1, session_type: r.session_type as string });
  });
  return map;
};

/**
 * Returns set of dates in a month where a session happened —
 * i.e. at least one student was present.
 * Used to distinguish "no session" from "absent".
 */
export const getSessionDaysForMonth = async (year: number, month: number): Promise<Set<string>> => {
  const db = await getDb();
  const prefix = `${year}-${String(month).padStart(2,'0')}`;
  // session_days is synced from server (computed from FULL data, all students)
  // — works correctly even for restricted roles whose hist_attendance only
  // contains their own records.
  const rows = queryRows(db,
    `SELECT DISTINCT attendance_date FROM session_days WHERE attendance_date LIKE ?`,
    [`${prefix}-%`]
  );
  if (rows.length > 0) return new Set(rows.map(r => r.attendance_date as string));

  // Fallback for older local DBs that haven't synced session_days yet:
  // use the old heuristic on hist_attendance.
  const fallback = queryRows(db,
    `SELECT attendance_date FROM hist_attendance
     WHERE status=1 AND attendance_date LIKE ?
     GROUP BY attendance_date, session_type
     HAVING COUNT(DISTINCT student_id) >= 2`,
    [`${prefix}-%`]
  );
  return new Set(fallback.map(r => r.attendance_date as string));
};

export const getStudentAttendanceSummary = async (
  studentId: number, fromDate?: string, toDate?: string
): Promise<{total:number;present:number;pct:number}> => {
  const db = await getDb();

  let dateFilter = '';
  const dateParams: any[] = [];
  if (fromDate) { dateFilter += ' AND attendance_date>=?'; dateParams.push(fromDate); }
  if (toDate)   { dateFilter += ' AND attendance_date<=?'; dateParams.push(toDate); }

  // Total valid sessions = (date, session_type) pairs from session_days
  // (synced from server, computed across ALL students — works correctly
  // even for restricted roles). Falls back to the old hist_attendance
  // heuristic if session_days hasn't been synced yet.
  let sdFilter = '';
  const sdParams: any[] = [];
  if (fromDate) { sdFilter += ' AND attendance_date>=?'; sdParams.push(fromDate); }
  if (toDate)   { sdFilter += ' AND attendance_date<=?'; sdParams.push(toDate); }

  let totalRow = queryRows(db,
    `SELECT COUNT(*) as n FROM session_days WHERE 1=1${sdFilter}`,
    sdParams
  )[0];
  let total = (totalRow?.n as number) ?? 0;

  if (total === 0) {
    // Fallback for older local DBs without session_days
    const fbRow = queryRows(db,
      `SELECT COUNT(*) as n FROM (
         SELECT attendance_date, session_type
         FROM hist_attendance
         WHERE status=1${dateFilter}
         GROUP BY attendance_date, session_type
         HAVING COUNT(DISTINCT student_id) >= 2
       )`,
      dateParams
    )[0];
    total = (fbRow?.n as number) ?? 0;
  }

  if (total === 0) return { total:0, present:0, pct:0 };

  // Student present sessions = distinct (date, session_type) pairs
  const presentRow = queryRows(db,
    `SELECT COUNT(*) as n FROM (
       SELECT DISTINCT attendance_date, session_type
       FROM hist_attendance
       WHERE student_id=? AND status=1${dateFilter}
     )`,
    [studentId, ...dateParams]
  )[0];
  const present = (presentRow?.n as number) ?? 0;

  // Cap at 100% — should never exceed now but guards against edge cases
  return { total, present, pct: Math.min(100, Math.round((present/total)*100)) };
};

export const getHistMonthsForStudent = async (studentId: number): Promise<string[]> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT DISTINCT substr(attendance_date,1,7) as ym FROM hist_attendance WHERE student_id=? ORDER BY ym DESC`,
    [studentId]
  );
  return rows.map(r => r.ym as string);
};

/** Dashboard overview: total hist records + how many distinct students have data */
export const getHistOverview = async (): Promise<{totalRecords:number;studentsWithData:number;presentCount:number}> => {
  const db = await getDb();
  // totalRecords = only PRESENT records (we don't store absent explicitly)
  // percentage = presentCount / totalSessions * 100 would be misleading without absent data
  // Instead: show raw present count and sessions, let dashboard display "X present sessions"
  const r1 = queryRows(db, 'SELECT COUNT(*) as n FROM hist_attendance WHERE status=1')[0];
  const r2 = queryRows(db, 'SELECT COUNT(DISTINCT student_id) as n FROM hist_attendance WHERE status=1')[0];
  return {
    totalRecords:    (r1?.n as number) ?? 0,
    studentsWithData:(r2?.n as number) ?? 0,
    presentCount:    (r1?.n as number) ?? 0,
  };
};

/**
 * Most recent PRESENT (date + session) per student, from synced attendance
 * history (hist_attendance). Used on the Payments page to show how recently
 * a student has been attending alongside their fee-due status — e.g. a
 * student with dues AND no recent attendance may have dropped out rather
 * than just being behind on payment.
 *
 * On the same date, "Evening"/"Both" rank ahead of "Morning" (later in the
 * day = more recent). Returns one entry per student that has ANY present
 * record; students never marked present are simply absent from the map.
 */
export const getLastAttendanceMap = async (): Promise<Record<number, {date: string; session: string}>> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT student_id, attendance_date, session_type
     FROM (
       SELECT student_id, attendance_date, session_type,
              ROW_NUMBER() OVER (
                PARTITION BY student_id
                ORDER BY attendance_date DESC,
                         CASE session_type WHEN 'Morning' THEN 1 ELSE 0 END ASC,
                         id DESC
              ) AS rn
       FROM hist_attendance
       WHERE status = 1
     )
     WHERE rn = 1`
  );
  const map: Record<number, {date: string; session: string}> = {};
  for (const r of rows) {
    map[r.student_id as number] = {
      date:    r.attendance_date as string,
      session: r.session_type as string,
    };
  }
  return map;
};

// ══════════════════════════════════════════════════════════════════════
// PAYMENTS  —  fee categories + payment history
// ══════════════════════════════════════════════════════════════════════

// ─── Fee categories ───────────────────────────────────────────────────────────

export const syncFeeCategories = async (rows: any[]): Promise<void> => {
  if (!rows.length) return;
  const db = await getDb();
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM fee_categories'); // small table, full replace is fine
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO fee_categories (id, name, txn_type, description)
         VALUES (?,?,?,?)`,
        [r.id, r.name, r.txn_type ?? 'INCOME', r.description ?? null]
      );
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};

export const getFeeCategories = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db, 'SELECT * FROM fee_categories ORDER BY name ASC');
};

/**
 * Backfill payments.fee_type_name (shown as "Transaction Type" in
 * Payment Details) from fee_categories for any local rows missing it.
 *
 * Payments pull-to-refresh is incremental (since_id) — it never revisits
 * rows already synced. If a payment was pulled before fee_type_name was
 * available, or its category was assigned/renamed afterwards, the local
 * copy stays stale with fee_type_name = NULL until a Full Refresh wipes
 * and re-pulls everything. This local-only repair re-resolves the name
 * from fee_categories (kept fresh by syncFeeCategories) without requiring
 * a full wipe-and-repull. Cheap — single UPDATE, safe to run on every
 * pull-to-refresh.
 */
export const backfillFeeTypeNames = async (): Promise<number> => {
  const db = await getDb();
  db.run(
    `UPDATE payments
     SET fee_type_name = (SELECT name FROM fee_categories WHERE id = payments.fee_type_id)
     WHERE (fee_type_name IS NULL OR fee_type_name = '')
       AND fee_type_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM fee_categories WHERE id = payments.fee_type_id)`
  );
  const changed = db.getRowsModified();
  if (changed > 0) await _save();
  return changed;
};

// ─── Payments ─────────────────────────────────────────────────────────────────

/**
 * Upsert payment rows from /api/data/payments into local payments table.
 * Uses INSERT OR REPLACE keyed on payment id (server primary key).
 */
export const upsertPayments = async (rows: any[]): Promise<number> => {
  if (!rows.length) return 0;
  const db  = await getDb();
  const now = new Date().toISOString();
  let count = 0;
  const CHUNK = 500;
  for (let off = 0; off < rows.length; off += CHUNK) {
    const chunk = rows.slice(off, off + CHUNK);
    db.run('BEGIN TRANSACTION');
    try {
      for (const r of chunk) {
        // Skip rows with no student association (institution-level
        // write-offs/expenses) — local payments table is per-student only.
        if (r.student_id === null || r.student_id === undefined) {
          console.warn('[upsertPayments] skipping payment id=' + r.id + ' — no student_id');
          continue;
        }
        // Two endpoints feed this table and older servers' /sync/payments
        // sends fewer columns — never let a missing field blank one we have.
        db.run(
          `INSERT INTO payments
             (id, student_id, student_name, fee_type_id, fee_type_name,
              amount_paid, payment_date, payment_mode, receipt_no,
              billing_month, billing_month_canonical, billing_month_display,
              remarks, status, txn_direction, is_posted, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             student_id              = excluded.student_id,
             student_name            = COALESCE(excluded.student_name,            payments.student_name),
             fee_type_id             = COALESCE(excluded.fee_type_id,             payments.fee_type_id),
             fee_type_name           = COALESCE(excluded.fee_type_name,           payments.fee_type_name),
             amount_paid             = excluded.amount_paid,
             payment_date            = COALESCE(excluded.payment_date,            payments.payment_date),
             payment_mode            = COALESCE(excluded.payment_mode,            payments.payment_mode),
             receipt_no              = COALESCE(excluded.receipt_no,              payments.receipt_no),
             billing_month           = COALESCE(excluded.billing_month,           payments.billing_month),
             billing_month_canonical = COALESCE(excluded.billing_month_canonical, payments.billing_month_canonical),
             billing_month_display   = COALESCE(excluded.billing_month_display,   payments.billing_month_display),
             remarks                 = COALESCE(excluded.remarks,                 payments.remarks),
             status                  = excluded.status,
             txn_direction           = excluded.txn_direction,
             is_posted               = COALESCE(excluded.is_posted,               payments.is_posted, 0),
             fetched_at              = excluded.fetched_at`,
          [
            r.id, r.student_id, r.student_name ?? null,
            r.fee_type_id ?? null, r.fee_type_name ?? null,
            r.amount_paid ?? 0, r.payment_date ?? null,
            r.payment_mode ?? null, r.receipt_no ?? null,
            r.billing_month ?? null,
            r.billing_month_canonical ?? null,
            r.billing_month_display ?? null,
            r.remarks ?? null,
            r.status ?? 'Paid', r.txn_direction ?? 'IN',
            r.is_posted == null ? null : (r.is_posted ? 1 : 0), now,
          ]
        );
        count++;
      }
      db.run('COMMIT');
    } catch (e) { db.run('ROLLBACK'); throw e; }
  }
  db.run('UPDATE payments SET is_posted = 0 WHERE is_posted IS NULL');
  await _save();
  return count;
};

/** Drop local payments the server no longer has (voids hard-delete there,
 *  the payments sync itself is append-only). Returns rows removed. */
export const pruneDeletedPayments = async (serverIds: number[]): Promise<number> => {
  const db = await getDb();
  const keep  = new Set(serverIds);
  const stale = queryRows(db, 'SELECT id FROM payments')
    .map(r => r.id as number)
    .filter(id => !keep.has(id));
  if (stale.length === 0) return 0;
  for (let off = 0; off < stale.length; off += 500) {
    const chunk = stale.slice(off, off + 500);
    db.run(`DELETE FROM payments WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
  }
  await _save();
  return stale.length;
};

/**
 * Upsert per-student summary blobs from /api/data/payments response.summary
 */
export const upsertPaymentSummaries = async (summaryMap: Record<string, any>): Promise<void> => {
  if (!summaryMap || !Object.keys(summaryMap).length) return;
  const db  = await getDb();
  const now = new Date().toISOString();
  db.run('BEGIN TRANSACTION');
  try {
    for (const [sidStr, s] of Object.entries(summaryMap)) {
      db.run(
        `INSERT OR REPLACE INTO payment_summary
           (student_id, student_name, enrollment_date, monthly_fee,
            total_paid, total_purchases, last_payment_date,
            paid_months_json, due_months_json, months_due_count, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          parseInt(sidStr),
          s.student_name ?? null,
          s.enrollment_date ?? null,
          s.monthly_fee ?? 0,
          s.total_paid ?? 0,
          s.total_purchases ?? 0,
          s.last_payment_date ?? null,
          JSON.stringify(s.paid_months ?? []),
          JSON.stringify(s.due_months ?? []),
          s.months_due_count ?? 0,
          now,
        ]
      );
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  await _save();
};

/** All payments for a student, newest first */
export const getStudentPayments = async (studentId: number): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT * FROM payments WHERE student_id = ?
     ORDER BY payment_date DESC, id DESC`,
    [studentId]
  );
};

/** Payment summary for a student from local cache */
export const getPaymentSummary = async (studentId: number): Promise<any | null> => {
  const db = await getDb();
  const rows = queryRows(db,
    'SELECT * FROM payment_summary WHERE student_id = ?',
    [studentId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...r,
    paid_months: JSON.parse(r.paid_months_json as string || '[]'),
    due_months:  JSON.parse(r.due_months_json  as string || '[]'),
  };
};

/**
 * Apply a successful write-off to the local cache immediately -- removes
 * the given months from due_months_json/months_due_count right away,
 * instead of waiting for the next full payments sync to pick it up.
 * No-op if nothing is cached locally yet for this student (next full
 * sync will populate it correctly anyway).
 */
export const applyWriteOffLocally = async (studentId: number, months: string[]): Promise<void> => {
  const db = await getDb();
  const rows = queryRows(db,
    'SELECT due_months_json FROM payment_summary WHERE student_id = ?',
    [studentId]
  );
  if (!rows[0]) return;
  const due: string[] = JSON.parse((rows[0].due_months_json as string) || '[]');
  const remaining = due.filter(m => !months.includes(m));
  db.run(
    'UPDATE payment_summary SET due_months_json = ?, months_due_count = ? WHERE student_id = ?',
    [JSON.stringify(remaining), remaining.length, studentId]
  );
  await _save();
};

/**
 * Apply a successful bulk payment to the local cache immediately --
 * removes the paid months from due_months_json, adds them to
 * paid_months_json, and bumps total_paid/last_payment_date right away,
 * instead of waiting for the next full payments sync. Does NOT insert
 * into the local `payments` table itself (individual receipt rows still
 * arrive via the next sync) -- this only updates the summary fields the
 * drawer and overview strip read from.
 */
export const applyPaymentLocally = async (
  studentId: number, months: string[], amountPerMonth: number, paymentDate: string
): Promise<void> => {
  const db = await getDb();
  const rows = queryRows(db,
    'SELECT due_months_json, paid_months_json FROM payment_summary WHERE student_id = ?',
    [studentId]
  );
  if (!rows[0]) return;
  const due:  string[] = JSON.parse((rows[0].due_months_json  as string) || '[]');
  const paid: string[] = JSON.parse((rows[0].paid_months_json as string) || '[]');
  const remaining = due.filter(m => !months.includes(m));
  const newPaid   = Array.from(new Set([...paid, ...months]));
  const addedTotal = months.length * amountPerMonth;
  db.run(
    `UPDATE payment_summary
     SET due_months_json = ?, paid_months_json = ?, months_due_count = ?,
         total_paid = total_paid + ?, last_payment_date = ?
     WHERE student_id = ?`,
    [JSON.stringify(remaining), JSON.stringify(newPaid), remaining.length, addedTotal, paymentDate, studentId]
  );
  await _save();
};

/** Students with overdue payments (months_due_count > 0), sorted by most due */
export const getStudentsWithDues = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT ps.*, s.level, s.phone, s.status as student_status, s.profile_image, s.regno, s.qca_id
     FROM payment_summary ps
     JOIN students s ON s.id = ps.student_id
     WHERE ps.months_due_count > 0
       AND s.status NOT IN ('Club Member', 'Inactive')
     ORDER BY ps.months_due_count DESC, ps.student_id ASC`
  );
};

/** Total payment stats across all students */
export const getPaymentOverview = async (): Promise<{
  totalStudents: number; studentsWithDues: number;
  totalMonthsDue: number; totalCollected: number;
}> => {
  const db = await getDb();
  // Exclude Club Member students — they pay no fees
  const excl = `JOIN students s ON s.id = ps.student_id WHERE s.status NOT IN ('Club Member', 'Inactive')`;
  const r1 = queryRows(db, `SELECT COUNT(*) as n FROM payment_summary ps ${excl}`)[0];
  const r2 = queryRows(db, `SELECT COUNT(*) as n FROM payment_summary ps ${excl} AND ps.months_due_count > 0`)[0];
  const r3 = queryRows(db, `SELECT SUM(ps.months_due_count) as n FROM payment_summary ps ${excl}`)[0];
  const r4 = queryRows(db, `SELECT SUM(ps.total_paid) as n FROM payment_summary ps ${excl}`)[0];
  return {
    totalStudents:    (r1?.n as number) ?? 0,
    studentsWithDues: (r2?.n as number) ?? 0,
    totalMonthsDue:   (r3?.n as number) ?? 0,
    totalCollected:   Math.round(((r4?.n as number) ?? 0) * 100) / 100,
  };
};

/**
 * Remove a voided payment from the local mirror. The server hard-deletes
 * voided receipts and payment sync is append-only (since_id), so without
 * this the voided payment would keep showing on this device.
 */
/** Local details for payments (student ids/photo, fee type, month) — keyed by
 *  payment id. By id, not receipt_no: the server reuses a voided receipt's
 *  number, so a stale local row can share it. Missing ids = not on this device. */
export const getPaymentDetailsById = async (ids: number[]): Promise<Record<number, any>> => {
  if (ids.length === 0) return {};
  const db = await getDb();
  const rows = queryRows(db, `
    SELECT p.id, p.student_id, s.regno, s.qca_id, s.profile_image,
           p.fee_type_name,
           COALESCE(p.billing_month_display, p.billing_month) AS month
    FROM payments p
    LEFT JOIN students s ON s.id = p.student_id
    WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids);
  return Object.fromEntries(rows.map(r => [r.id, r]));
};

export const deleteLocalPaymentByReceipt = async (receiptNo: string): Promise<void> => {
  const db = await getDb();
  db.run('DELETE FROM payments WHERE receipt_no = ?', [receiptNo]);
  await _save();
};

/** Number of per-student fee summaries stored locally (0 = never fetched) */
export const getPaymentSummaryCount = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT COUNT(*) as n FROM payment_summary')[0]?.n as number) ?? 0;
};

/** Max payment id stored locally — used for incremental sync */
export const getPaymentsMaxId = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT MAX(id) as m FROM payments')[0]?.m as number) ?? 0;
};

/**
 * Per-student fee summary for every fee-tracked student - the drill-down
 * behind the Payments overview's "Students" tile. Same student filter as
 * getPaymentOverview()/getStudentsWithDues() (excludes Club Member /
 * Inactive, who don't pay fees), so the row count matches totalStudents.
 */
export const getAllPaymentSummaries = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT ps.*, s.level, s.phone, s.status as student_status, s.profile_image, s.regno, s.qca_id
     FROM payment_summary ps
     JOIN students s ON s.id = ps.student_id
     WHERE s.status NOT IN ('Club Member', 'Inactive')
     ORDER BY ps.student_name ASC`
  );
};

/**
 * Most recent income transactions across all students - the drill-down
 * behind the Payments overview's "Collected" tile. Unlike the page's
 * "Recent Paid" tab (capped at 20, built by per-student lookups), this
 * pulls directly from `payments` so it reflects the full collected total.
 */
export const getRecentPayments = async (limit = 200): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT p.*, s.profile_image
     FROM payments p
     LEFT JOIN students s ON s.id = p.student_id
     -- txn_direction is 'IN' or 'INCOME' depending on how the row was entered
     WHERE UPPER(COALESCE(p.txn_direction, 'IN')) NOT IN ('OUT', 'EXPENSE')
     ORDER BY p.payment_date DESC, p.id DESC
     LIMIT ?`,
    [limit]
  );
};

/** All student payments received in a month ('YYYY-MM'), newest first, with student details */
export const getPaymentsForMonth = async (ym: string): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db,
    `SELECT p.*, COALESCE(s.name, p.student_name) AS student_name,
            s.profile_image, s.regno, s.qca_id
     FROM payments p
     JOIN students s ON s.id = p.student_id
     WHERE substr(p.payment_date, 1, 7) = ?
       -- txn_direction is 'IN' or 'INCOME' depending on how the row was entered
       AND UPPER(COALESCE(p.txn_direction, 'IN')) NOT IN ('OUT', 'EXPENSE')
     ORDER BY p.payment_date DESC, p.id DESC`,
    [ym]
  );
};

/** Count of payment rows stored locally */
export const getPaymentsCount = async (): Promise<number> => {
  const db = await getDb();
  return (queryRows(db, 'SELECT COUNT(*) as n FROM payments')[0]?.n as number) ?? 0;
};

// ══════════════════════════════════════════════════════════════════════
// MEDIA  —  pending_media table + sync state tracking
// ══════════════════════════════════════════════════════════════════════

// pending_media table is created inside initDatabase — no separate call needed

// ─── Insert new pending media item ───────────────────────────────────
export const insertPendingMedia = async (item: {
  local_path:       string;
  resource_type:    'image' | 'video';
  file_size_bytes:  number;
  student_ids:      number[];
  tag_type:         string;
  coach_note?:      string;
  session_type?:    string;
  attendance_date?: string;
  video_mime?:      string;
}): Promise<number> => {
  const db = await getDb();
  db.run(
    `INSERT INTO pending_media
       (local_path, resource_type, file_size_bytes, student_ids_json,
        tag_type, coach_note, session_type, attendance_date, video_mime, status)
     VALUES (?,?,?,?,?,?,?,?,?,'pending')`,
    [
      item.local_path,
      item.resource_type,
      item.file_size_bytes,
      JSON.stringify(item.student_ids.map(Number)),
      item.tag_type,
      item.coach_note      ?? '',
      item.session_type    ?? '',
      item.attendance_date ?? '',
      item.video_mime      ?? '',
    ]
  );
  const rows = queryRows(db, 'SELECT last_insert_rowid() as id');
  await _save();
  return (rows[0]?.id as number) ?? 0;
};

// ─── Update after Cloudinary upload succeeds (Step 2 done) ────────────
export const markMediaCldUploaded = async (
  id: number,
  cloudinary_public_id: string,
  secure_url: string,
): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE pending_media
     SET status='cld_uploaded', cloudinary_public_id=?, secure_url=?, error_msg=''
     WHERE id=?`,
    [cloudinary_public_id, secure_url, id]
  );
  await _save();
};

// ─── Mark fully saved (Step 3 done) — local_path cleared ─────────────
export const markMediaSaved = async (id: number): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE pending_media
     SET status='saved', local_path='', synced_at=datetime('now'), error_msg=''
     WHERE id=?`,
    [id]
  );
  await _save();
};

// ─── Mark error with message ──────────────────────────────────────────
export const markMediaError = async (id: number, msg: string): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE pending_media SET status='error', error_msg=? WHERE id=?`,
    [msg.slice(0, 300), id]
  );
  await _save();
};

// ─── Get all items that still need work ──────────────────────────────
// Returns 'pending' and 'cld_uploaded' and 'error' items
export const getPendingMedia = async (): Promise<any[]> => {
  const db = await getDb();
  // First purge any rows with corrupted student_ids_json (contains '[object')
  db.run(`DELETE FROM pending_media WHERE student_ids_json LIKE '%[object%'`);
  await _save();

  const rows = queryRows(db,
    `SELECT * FROM pending_media
     WHERE status IN ('pending','cld_uploaded','error')
     ORDER BY created_at ASC`
  );
  return rows.map(r => ({
    ...r,
    student_ids: (JSON.parse(r.student_ids_json as string || '[]') as any[]).map(Number).filter((n: number) => !isNaN(n) && n > 0),
  }));
};

// ─── Count by status (for Sync Center badge) ──────────────────────────
export const getMediaSyncCounts = async (): Promise<{
  pending: number; cld_uploaded: number; error: number; saved: number;
}> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT status, COUNT(*) as n FROM pending_media GROUP BY status`
  );
  const m: Record<string,number> = {};
  rows.forEach(r => { m[r.status as string] = r.n as number; });
  return {
    pending:      m['pending']      ?? 0,
    cld_uploaded: m['cld_uploaded'] ?? 0,
    error:        m['error']        ?? 0,
    saved:        m['saved']        ?? 0,
  };
};

// ─── All items including saved (for history view) ─────────────────────
export const getAllMediaHistory = async (limit = 50): Promise<any[]> => {
  const db = await getDb();
  const rows = queryRows(db,
    `SELECT * FROM pending_media ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
  return rows.map(r => ({
    ...r,
    student_ids: (JSON.parse(r.student_ids_json as string || '[]') as any[]).map(Number),
  }));
};

// ─── Update tags/note on a pending_media row ──────────────────────────────
export const updatePendingMediaTags = async (
  id: number, studentIds: number[], tagType: string, coachNote: string
): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE pending_media SET student_ids_json=?, tag_type=?, coach_note=? WHERE id=?`,
    [JSON.stringify(studentIds.map(Number)), tagType, coachNote, id]
  );
  await _save();
};

// ─── Delete a pending_media row (after cleanup) ───────────────────────────
export const deletePendingMedia = async (id: number): Promise<void> => {
  const db = await getDb();
  db.run('DELETE FROM pending_media WHERE id=?', [id]);
  await _save();
};

// ══════════════════════════════════════════════════════════════════════
// OFFLINE MATCH FUNCTIONS
// ══════════════════════════════════════════════════════════════════════

function now(): string { return new Date().toISOString(); }

// Get next local match ID starting from 10000
// This avoids any conflict with server IDs (which start from 1)
async function nextLocalId(): Promise<number> {
  const db = await getDb();
  const rows = queryRows(db, 'SELECT MAX(CAST(local_id AS INTEGER)) as mx FROM local_matches WHERE CAST(local_id AS INTEGER) >= 10000');
  const current = rows[0]?.mx || 9999;
  return Number(current) + 1;
}

// ── Create new local match ────────────────────────────────────────────────────
export const createLocalMatch = async (data: {
  opponent_name: string; match_date: string; match_type: string;
  venue: string; toss_winner: string; toss_decision: string; total_overs?: number;
}): Promise<string> => {
  await ensureMatchTables();
  const db = await getDb();
  const id = await nextLocalId();  // integer >= 10000, never conflicts with server
  db.run(
    `INSERT INTO local_matches
     (local_id, opponent_name, match_date, match_type, venue,
      toss_winner, toss_decision, total_overs, match_status, synced, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'Scheduled',0,?,?)`,
    [String(id), data.opponent_name, data.match_date, data.match_type,
     data.venue, data.toss_winner, data.toss_decision, data.total_overs ?? null, now(), now()]
  );
  await _save();
  return String(id);
};

// ── Update match status ───────────────────────────────────────────────────────
export const updateLocalMatchStatus = async (
  matchId: string, status: string, resultStatus = ''
): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE local_matches SET match_status=?, result_status=?, updated_at=? WHERE local_id=?`,
    [status, resultStatus, now(), matchId]
  );
  await _save();
};

// ── Get all local matches ─────────────────────────────────────────────────────
// Create offline match tables if they don't exist yet
// (handles devices where DB was created before these tables were added)
const ensureMatchTables = async (): Promise<void> => {
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS local_matches (
    local_id TEXT PRIMARY KEY, server_match_id INTEGER DEFAULT 0,
    opponent_name TEXT NOT NULL DEFAULT '', match_date TEXT NOT NULL DEFAULT '',
    match_type TEXT DEFAULT 'Friendly', venue TEXT DEFAULT '',
    toss_winner TEXT DEFAULT '', toss_decision TEXT DEFAULT 'Bat',
    match_status TEXT DEFAULT 'Scheduled', result_status TEXT DEFAULT '',
    current_innings INTEGER DEFAULT 1, synced INTEGER DEFAULT 0,
    created_at TEXT DEFAULT '', updated_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS local_lineup (
    id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL,
    student_id INTEGER NOT NULL, student_name TEXT NOT NULL DEFAULT '',
    batting_pos INTEGER DEFAULT 0, is_captain INTEGER DEFAULT 0,
    is_wicketkeeper INTEGER DEFAULT 0, UNIQUE(match_id, student_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS local_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL,
    student_id INTEGER NOT NULL, student_name TEXT NOT NULL DEFAULT '',
    innings_no INTEGER DEFAULT 1, runs_scored INTEGER DEFAULT 0,
    balls_faced INTEGER DEFAULT 0, fours INTEGER DEFAULT 0, sixes INTEGER DEFAULT 0,
    how_out TEXT DEFAULT 'Not Out', batting_done INTEGER DEFAULT 0,
    overs_bowled REAL DEFAULT 0, runs_conceded INTEGER DEFAULT 0,
    wickets_taken INTEGER DEFAULT 0, wides_bowled INTEGER DEFAULT 0,
    no_balls_bowled INTEGER DEFAULT 0, catches INTEGER DEFAULT 0,
    stumpings INTEGER DEFAULT 0, run_outs INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT '', UNIQUE(match_id, student_id, innings_no)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS local_innings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL,
    innings_no INTEGER NOT NULL DEFAULT 1, batting_team TEXT DEFAULT 'QCA',
    total_runs INTEGER DEFAULT 0, total_wickets INTEGER DEFAULT 0,
    total_overs REAL DEFAULT 0, extras_wides INTEGER DEFAULT 0,
    extras_noballs INTEGER DEFAULT 0, extras_byes INTEGER DEFAULT 0,
    extras_legbyes INTEGER DEFAULT 0, extras_penalty INTEGER DEFAULT 0,
    declared INTEGER DEFAULT 0, target_runs INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0, updated_at TEXT DEFAULT '',
    UNIQUE(match_id, innings_no)
  )`);

  // ── Opponent players (just names, no registration) ─────────────
  db.run(`CREATE TABLE IF NOT EXISTS local_opp_players (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id    TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    batting_pos INTEGER DEFAULT 0,
    UNIQUE(match_id, name)
  )`);

  // ── Opponent batting ───────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS local_opp_batting (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      TEXT NOT NULL,
    innings_no    INTEGER DEFAULT 1,
    player_name   TEXT NOT NULL DEFAULT '',
    runs_scored   INTEGER DEFAULT 0,
    balls_faced   INTEGER DEFAULT 0,
    fours         INTEGER DEFAULT 0,
    sixes         INTEGER DEFAULT 0,
    how_out       TEXT DEFAULT 'Not Out',
    batting_done  INTEGER DEFAULT 0,
    bowler_name   TEXT DEFAULT '',
    fielder_name  TEXT DEFAULT '',
    batting_pos   INTEGER DEFAULT 0,
    UNIQUE(match_id, player_name, innings_no)
  )`);

  // ── Opponent bowling (when QCA is batting) ─────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS local_opp_bowling (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        TEXT NOT NULL,
    innings_no      INTEGER DEFAULT 1,
    player_name     TEXT NOT NULL DEFAULT '',
    overs_bowled    REAL DEFAULT 0,
    runs_conceded   INTEGER DEFAULT 0,
    wickets_taken   INTEGER DEFAULT 0,
    wides_bowled    INTEGER DEFAULT 0,
    no_balls_bowled INTEGER DEFAULT 0,
    UNIQUE(match_id, player_name, innings_no)
  )`);

  // Migrate existing local_matches with new columns (safe - fails silently if exists)
  try { db.run("ALTER TABLE local_matches ADD COLUMN total_overs INTEGER DEFAULT 20"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN toss_winner TEXT DEFAULT ''"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN toss_decision TEXT DEFAULT 'Bat'"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN innings1_team TEXT DEFAULT 'QCA'"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN innings2_team TEXT DEFAULT 'Opponent'"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN opp_total_runs INTEGER DEFAULT 0"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN opp_total_wickets INTEGER DEFAULT 0"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN opp_total_overs REAL DEFAULT 0"); } catch(_){}
  // refreshMatchFromServer writes QCA totals too — these were never migrated
  try { db.run("ALTER TABLE local_matches ADD COLUMN qca_total_runs INTEGER DEFAULT 0"); } catch(_){}
  try { db.run("ALTER TABLE local_matches ADD COLUMN qca_total_wickets INTEGER DEFAULT 0"); } catch(_){}

  await _save();
};

export const getLocalMatches = async (): Promise<any[]> => {
  await ensureMatchTables();
  const db = await getDb();
  return queryRows(db, `SELECT *, local_id AS id FROM local_matches ORDER BY match_date DESC, created_at DESC`);
};

// ── Get single local match with full data ─────────────────────────────────────
export const getLocalMatch = async (matchId: string): Promise<{
  match: any; lineup: any[]; stats: any[]; innings: any[];
} | null> => {
  const db = await getDb();
  const match = queryRows(db, `SELECT *, local_id AS id FROM local_matches WHERE local_id=?`, [matchId])[0];
  if (!match) return null;
  const lineup = queryRows(db, `SELECT * FROM local_lineup WHERE match_id=? ORDER BY batting_pos ASC`, [matchId]);
  const stats  = queryRows(db, `SELECT * FROM local_stats  WHERE match_id=? ORDER BY innings_no, id`, [matchId]);
  const innings = queryRows(db, `SELECT * FROM local_innings WHERE match_id=? ORDER BY innings_no`, [matchId]);
  return { match, lineup, stats, innings };
};

// ── Save lineup ───────────────────────────────────────────────────────────────
export const saveLocalLineup = async (
  matchId: string,
  players: { student_id: number; student_name: string; batting_pos: number; is_captain: number; is_wicketkeeper: number }[]
): Promise<void> => {
  const db = await getDb();
  db.run(`DELETE FROM local_lineup WHERE match_id=?`, [matchId]);
  for (const p of players) {
    db.run(
      `INSERT INTO local_lineup (match_id, student_id, student_name, batting_pos, is_captain, is_wicketkeeper)
       VALUES (?,?,?,?,?,?)`,
      [matchId, p.student_id, p.student_name, p.batting_pos, p.is_captain, p.is_wicketkeeper]
    );
  }
  await _save();
};

// ── Upsert player stats (called on every progressive update) ──────────────────
export const upsertLocalStats = async (
  matchId: string,
  studentId: number,
  studentName: string,
  inningsNo: number,
  stats: {
    runs_scored?: number; balls_faced?: number; fours?: number; sixes?: number;
    how_out?: string; batting_done?: number;
    overs_bowled?: number; runs_conceded?: number; wickets_taken?: number;
    wides_bowled?: number; no_balls_bowled?: number;
    catches?: number; stumpings?: number; run_outs?: number;
  }
): Promise<void> => {
  const db = await getDb();
  db.run(
    `INSERT INTO local_stats
     (match_id, student_id, student_name, innings_no,
      runs_scored, balls_faced, fours, sixes, how_out, batting_done,
      overs_bowled, runs_conceded, wickets_taken, wides_bowled, no_balls_bowled,
      catches, stumpings, run_outs, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id, student_id, innings_no) DO UPDATE SET
       runs_scored=excluded.runs_scored, balls_faced=excluded.balls_faced,
       fours=excluded.fours, sixes=excluded.sixes,
       how_out=excluded.how_out, batting_done=excluded.batting_done,
       overs_bowled=excluded.overs_bowled, runs_conceded=excluded.runs_conceded,
       wickets_taken=excluded.wickets_taken, wides_bowled=excluded.wides_bowled,
       no_balls_bowled=excluded.no_balls_bowled, catches=excluded.catches,
       stumpings=excluded.stumpings, run_outs=excluded.run_outs,
       updated_at=excluded.updated_at`,
    [
      matchId, studentId, studentName, inningsNo,
      stats.runs_scored ?? 0, stats.balls_faced ?? 0,
      stats.fours ?? 0, stats.sixes ?? 0,
      stats.how_out ?? 'Not Out', stats.batting_done ?? 0,
      stats.overs_bowled ?? 0, stats.runs_conceded ?? 0,
      stats.wickets_taken ?? 0, stats.wides_bowled ?? 0,
      stats.no_balls_bowled ?? 0, stats.catches ?? 0,
      stats.stumpings ?? 0, stats.run_outs ?? 0, now(),
    ]
  );
  await _save();
};

// ── Upsert innings extras ─────────────────────────────────────────────────────
export const upsertLocalInnings = async (
  matchId: string,
  inningsNo: number,
  data: {
    batting_team?: string;
    total_runs?: number; total_wickets?: number; total_overs?: number;
    extras_wides?: number; extras_noballs?: number;
    extras_byes?: number; extras_legbyes?: number; extras_penalty?: number;
    declared?: number; target_runs?: number;
  }
): Promise<void> => {
  const db = await getDb();
  db.run(
    `INSERT INTO local_innings
     (match_id, innings_no, batting_team,
      total_runs, total_wickets, total_overs,
      extras_wides, extras_noballs, extras_byes, extras_legbyes, extras_penalty,
      declared, target_runs, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id, innings_no) DO UPDATE SET
       batting_team=excluded.batting_team,
       total_runs=excluded.total_runs, total_wickets=excluded.total_wickets,
       total_overs=excluded.total_overs,
       extras_wides=excluded.extras_wides, extras_noballs=excluded.extras_noballs,
       extras_byes=excluded.extras_byes, extras_legbyes=excluded.extras_legbyes,
       extras_penalty=excluded.extras_penalty,
       declared=excluded.declared, target_runs=excluded.target_runs,
       updated_at=excluded.updated_at`,
    [
      matchId, inningsNo, data.batting_team ?? 'QCA',
      data.total_runs ?? 0, data.total_wickets ?? 0, data.total_overs ?? 0,
      data.extras_wides ?? 0, data.extras_noballs ?? 0,
      data.extras_byes ?? 0, data.extras_legbyes ?? 0, data.extras_penalty ?? 0,
      data.declared ?? 0, data.target_runs ?? 0, now(),
    ]
  );
  await _save();
};

// ── Get unsynced matches for push to server ───────────────────────────────────
// ── Refresh a local match from server (pull latest scores during live match) ──
/**
 * Store the server's per-innings extras locally. The server rebuilds
 * match_innings_extras from the upload payload, so a pulled match must
 * carry them or the next upload would erase them.
 */
export const importMatchExtras = async (localId: string, extras: any[]): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  db.run(`DELETE FROM local_innings WHERE match_id=?`, [localId]);
  for (const ex of extras || []) {
    db.run(
      `INSERT OR REPLACE INTO local_innings
       (match_id, innings_no, batting_team, extras_wides, extras_noballs,
        extras_byes, extras_legbyes, synced, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?)`,
      [localId, ex.innings_no || 1, ex.batting_team || 'QCA',
       ex.extras_wides || 0, ex.extras_noballs || 0, ex.extras_byes || 0, ex.extras_legbyes || 0, now()]
    );
  }
  await _save();
};

export const refreshMatchFromServer = async (
  localId: string,
  serverMatch: any,
  players: any[],
  oppBat: any[],
  oppBowl: any[]
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();

  // Update match header with latest server state
  db.run(
    `UPDATE local_matches
     SET opponent_name=?, match_date=?, match_type=?, match_status=?,
         result_status=?, total_overs=?, toss_winner=?, toss_decision=?,
         innings1_team=?, innings2_team=?,
         qca_total_runs=?, qca_total_wickets=?,
         opp_total_runs=?, opp_total_wickets=?,
         synced=1, updated_at=?
     WHERE local_id=?`,
    [
      serverMatch.opponent_name || '',
      serverMatch.match_date || '',
      serverMatch.match_type || 'Friendly',
      serverMatch.match_status || 'Scheduled',
      serverMatch.result_status || '',
      serverMatch.total_overs || 20,
      serverMatch.toss_winner || '',
      serverMatch.toss_decision || 'Bat',
      serverMatch.innings1_team || 'QCA',
      serverMatch.innings2_team || 'Opponent',
      serverMatch.qca_total_runs || 0,
      serverMatch.qca_total_wickets || 0,
      serverMatch.opp_total_runs || 0,
      serverMatch.opp_total_wickets || 0,
      now(), localId,
    ]
  );

  // Refresh QCA stats — DELETE + INSERT to get latest from server
  db.run(`DELETE FROM local_stats WHERE match_id=?`, [localId]);
  for (const p of players) {
    if (!p.student_id) continue;
    db.run(
      `INSERT OR IGNORE INTO local_lineup (match_id, student_id, student_name, batting_pos, is_captain, is_wicketkeeper)
       VALUES (?,?,?,?,?,?)`,
      [localId, p.student_id, p.name || p.student_name || '', p.batting_pos || 0, p.is_captain || 0, p.is_wicketkeeper || 0]
    );
    const hasStats = p.balls_faced > 0 || p.overs_bowled > 0 || p.runs_scored > 0 || p.batting_done;
    if (hasStats) {
      db.run(
        `INSERT OR REPLACE INTO local_stats
         (match_id, student_id, student_name, innings_no,
          runs_scored, balls_faced, fours, sixes, how_out, batting_done,
          overs_bowled, runs_conceded, wickets_taken, wides_bowled, no_balls_bowled,
          catches, stumpings, run_outs, updated_at)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [localId, p.student_id, p.name || p.student_name || '',
         p.runs_scored || 0, p.balls_faced || 0, p.fours || 0, p.sixes || 0,
         p.how_out || 'Not Out', p.batting_done || 0,
         p.overs_bowled || 0, p.runs_conceded || 0, p.wickets_taken || 0,
         p.wides_bowled || 0, p.no_balls_bowled || 0,
         p.catches || 0, p.stumpings || 0, p.run_outs || 0, now()]
      );
    }
  }

  // Refresh opponent data
  db.run(`DELETE FROM local_opp_batting WHERE match_id=?`, [localId]);
  db.run(`DELETE FROM local_opp_bowling WHERE match_id=?`, [localId]);
  for (const b of oppBat) {
    if (!b.player_name) continue;
    db.run(
      `INSERT OR REPLACE INTO local_opp_batting
       (match_id, innings_no, player_name, batting_pos,
        runs_scored, balls_faced, fours, sixes, how_out, batting_done,
        bowler_name, fielder_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [localId, b.innings_no || 2, b.player_name, b.batting_pos || 0,
       b.runs_scored || 0, b.balls_faced || 0, b.fours || 0, b.sixes || 0,
       b.how_out || 'Not Out', b.batting_done || 0,
       b.bowler_name || '', b.fielder_name || '']
    );
  }
  for (const b of oppBowl) {
    if (!b.player_name) continue;
    db.run(
      `INSERT OR REPLACE INTO local_opp_bowling
       (match_id, innings_no, player_name,
        overs_bowled, runs_conceded, wickets_taken, wides_bowled, no_balls_bowled)
       VALUES (?,?,?,?,?,?,?,?)`,
      [localId, b.innings_no || 1, b.player_name,
       b.overs_bowled || 0, b.runs_conceded || 0, b.wickets_taken || 0,
       b.wides_bowled || 0, b.no_balls_bowled || 0]
    );
  }

  await _save();
};

export const getUnsyncedMatches = async (): Promise<any[]> => {
  const db = await getDb();
  return queryRows(db, `SELECT *, local_id AS id FROM local_matches WHERE synced=0 ORDER BY match_date DESC`);
};

// ── Mark match synced ─────────────────────────────────────────────────────────
/**
 * Body for POST /api/data/matches/save — the server's flat shape:
 * match header + players[] (lineup merged with stats) + opp_batting[] +
 * opp_bowling[] + innings_extras[]. The server keeps one stats row per
 * player per match, so per-innings local stats are summed.
 */
export const buildMatchSyncPayload = async (localId: string): Promise<any | null> => {
  await ensureMatchTables();
  const db = await getDb();
  const m = queryRows(db, `SELECT * FROM local_matches WHERE local_id=?`, [localId])[0];
  if (!m) return null;

  const lineup = queryRows(db, `SELECT * FROM local_lineup WHERE match_id=? ORDER BY batting_pos ASC`, [localId]);
  const stats  = queryRows(db, `SELECT * FROM local_stats  WHERE match_id=? ORDER BY innings_no ASC`, [localId]);
  const SUM = ['runs_scored','balls_faced','fours','sixes','overs_bowled','runs_conceded','wickets_taken',
               'wides_bowled','no_balls_bowled','catches','stumpings','run_outs'] as const;
  const players = lineup.map((l: any) => {
    const rows = stats.filter((s: any) => s.student_id === l.student_id);
    const p: any = {
      student_id: l.student_id, student_name: l.student_name, batting_pos: l.batting_pos,
      is_captain: l.is_captain, is_wicketkeeper: l.is_wicketkeeper,
      how_out: rows.length ? rows[rows.length - 1].how_out : 'Did Not Bat',
    };
    for (const k of SUM) p[k] = rows.reduce((t: number, r: any) => t + (Number(r[k]) || 0), 0);
    return p;
  });

  const serverId = Number(m.server_match_id) || 0;
  return {
    match_id:      serverId > 0 ? serverId : null,   // null → server creates a new match
    opponent_name: m.opponent_name,
    match_date:    m.match_date,
    match_type:    m.match_type,
    venue:         m.venue,
    result_status: m.result_status,
    total_overs:   m.total_overs ?? 20,
    toss_winner:   m.toss_winner,
    toss_decision: m.toss_decision,
    players,
    opp_batting:    queryRows(db, `SELECT * FROM local_opp_batting WHERE match_id=? ORDER BY innings_no, batting_pos`, [localId]),
    opp_bowling:    queryRows(db, `SELECT * FROM local_opp_bowling WHERE match_id=? ORDER BY innings_no, id`, [localId]),
    innings_extras: queryRows(db, `SELECT * FROM local_innings     WHERE match_id=? ORDER BY innings_no`, [localId]),
  };
};

export const markMatchSynced = async (localId: string, serverMatchId: number): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE local_matches SET synced=1, server_match_id=?, updated_at=? WHERE local_id=?`,
    [serverMatchId, now(), localId]
  );
  await _save();
};

// ── Delete local match ────────────────────────────────────────────────────────
export const deleteLocalMatch = async (matchId: string): Promise<void> => {
  const db = await getDb();
  db.run(`DELETE FROM local_stats   WHERE match_id=?`, [matchId]);
  db.run(`DELETE FROM local_lineup  WHERE match_id=?`, [matchId]);
  db.run(`DELETE FROM local_innings WHERE match_id=?`, [matchId]);
  // Opposition scorecard + fall of wickets (tables may not exist on very old installs)
  for (const t of ['local_opp_batting', 'local_opp_bowling', 'local_opp_players', 'local_fow']) {
    try { db.run(`DELETE FROM ${t} WHERE match_id=?`, [matchId]); } catch { /* table not created yet */ }
  }
  db.run(`DELETE FROM local_matches WHERE local_id=?`, [matchId]);
  await _save();
};

// ── Mark match as unsynced (for corrections/re-upload) ────────────────────────
export const markMatchUnsynced = async (localId: string): Promise<void> => {
  const db = await getDb();
  db.run(
    `UPDATE local_matches SET synced=0, updated_at=? WHERE local_id=?`,
    [new Date().toISOString(), localId]
  );
  await _save();
};

// ── Import a match from server into local SQLite ──────────────────────────────
// Called when coach pulls incomplete server matches for offline scoring.
// Uses server_match_id as the local_id key so duplicates are avoided.
export const importServerMatch = async (serverMatch: any, players: any[] = []): Promise<string> => {
  await ensureMatchTables();
  const db = await getDb();
  // Server-created matches use the server match_id as local_id (small ints);
  // device-created ones start at 10000 and remember server_match_id after
  // upload — so look up by either, or the pull would duplicate them.
  const sid = Number(serverMatch.match_id);
  const existing = queryRows(db,
    `SELECT local_id, synced FROM local_matches WHERE local_id=? OR server_match_id=?
     ORDER BY (local_id=?) DESC LIMIT 1`,
    [String(sid), sid, String(sid)]);
  const localId = existing.length ? String(existing[0].local_id) : String(sid);

  // Unsynced local edits win: never wipe a match scored on this device
  // that hasn't been uploaded yet.
  if (existing.length && !Number(existing[0].synced)) return localId;

  if (existing.length === 0) {
    db.run(
      `INSERT INTO local_matches
       (local_id, server_match_id, opponent_name, match_date, match_type,
        venue, match_status, result_status, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
      [
        localId,
        serverMatch.match_id,
        serverMatch.opponent_name || '',
        serverMatch.match_date || '',
        serverMatch.match_type || 'Friendly',
        serverMatch.venue || '',
        serverMatch.match_status || 'Scheduled',
        serverMatch.result_status || '',
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
  } else {
    // Update status from server
    db.run(
      `UPDATE local_matches SET match_status=?, result_status=?, updated_at=? WHERE local_id=?`,
      [serverMatch.match_status || 'Scheduled', serverMatch.result_status || '', new Date().toISOString(), localId]
    );
  }

  // Import lineup + existing stats
  // Wipe all child data before re-import — prevents duplicates
  db.run(`DELETE FROM local_lineup      WHERE match_id=?`, [localId]);
  db.run(`DELETE FROM local_stats       WHERE match_id=?`, [localId]);
  db.run(`DELETE FROM local_opp_batting WHERE match_id=?`, [localId]);
  db.run(`DELETE FROM local_opp_bowling WHERE match_id=?`, [localId]);
  db.run(`DELETE FROM local_innings     WHERE match_id=?`, [localId]);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    db.run(
      `INSERT OR REPLACE INTO local_lineup
       (match_id, student_id, student_name, batting_pos, is_captain, is_wicketkeeper)
       VALUES (?,?,?,?,?,?)`,
      [localId, p.student_id, p.name || p.student_name || '', p.batting_pos || i+1, p.is_captain || 0, p.is_wicketkeeper || 0]
    );
    // Import existing stats if any
    const hasStats = p.balls_faced > 0 || p.overs_bowled > 0 || p.runs_scored > 0;
    if (hasStats) {
      db.run(
        `INSERT OR IGNORE INTO local_stats
         (match_id, student_id, student_name, innings_no,
          runs_scored, balls_faced, fours, sixes, how_out, batting_done,
          overs_bowled, runs_conceded, wickets_taken, wides_bowled, no_balls_bowled,
          catches, stumpings, run_outs, updated_at)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          localId, p.student_id, p.name || p.student_name || '', 
          p.runs_scored || 0, p.balls_faced || 0, p.fours || 0, p.sixes || 0,
          p.how_out || 'Not Out', p.batting_done || 0,
          p.overs_bowled || 0, p.runs_conceded || 0, p.wickets_taken || 0,
          p.wides_bowled || 0, p.no_balls_bowled || 0,
          p.catches || 0, p.stumpings || 0, p.run_outs || 0,
          new Date().toISOString(),
        ]
      );
    }
  }

  await _save();
  return localId;
};

// ══════════════════════════════════════════════════════════════════════
// OPPONENT SCORECARD FUNCTIONS
// ══════════════════════════════════════════════════════════════════════

// ── Upsert opponent batting row ───────────────────────────────────────────────
export const upsertOppBatting = async (
  matchId: string, inningsNo: number,
  data: {
    player_name: string; batting_pos?: number;
    runs_scored?: number; balls_faced?: number; fours?: number; sixes?: number;
    how_out?: string; batting_done?: number;
    bowler_name?: string; fielder_name?: string;
  }
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  db.run(
    `INSERT INTO local_opp_batting
     (match_id, innings_no, player_name, batting_pos,
      runs_scored, balls_faced, fours, sixes, how_out, batting_done,
      bowler_name, fielder_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id, player_name, innings_no) DO UPDATE SET
       batting_pos=excluded.batting_pos,
       runs_scored=excluded.runs_scored, balls_faced=excluded.balls_faced,
       fours=excluded.fours, sixes=excluded.sixes,
       how_out=excluded.how_out, batting_done=excluded.batting_done,
       bowler_name=excluded.bowler_name, fielder_name=excluded.fielder_name`,
    [
      matchId, inningsNo, data.player_name, data.batting_pos ?? 0,
      data.runs_scored ?? 0, data.balls_faced ?? 0,
      data.fours ?? 0, data.sixes ?? 0,
      data.how_out ?? 'Not Out', data.batting_done ?? 0,
      data.bowler_name ?? '', data.fielder_name ?? '',
    ]
  );
  await _save();
};

// ── Upsert opponent bowling row ───────────────────────────────────────────────
export const upsertOppBowling = async (
  matchId: string, inningsNo: number,
  data: {
    player_name: string;
    overs_bowled?: number; runs_conceded?: number; wickets_taken?: number;
    wides_bowled?: number; no_balls_bowled?: number;
  }
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  db.run(
    `INSERT INTO local_opp_bowling
     (match_id, innings_no, player_name,
      overs_bowled, runs_conceded, wickets_taken, wides_bowled, no_balls_bowled)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id, player_name, innings_no) DO UPDATE SET
       overs_bowled=excluded.overs_bowled, runs_conceded=excluded.runs_conceded,
       wickets_taken=excluded.wickets_taken, wides_bowled=excluded.wides_bowled,
       no_balls_bowled=excluded.no_balls_bowled`,
    [
      matchId, inningsNo, data.player_name,
      data.overs_bowled ?? 0, data.runs_conceded ?? 0,
      data.wickets_taken ?? 0, data.wides_bowled ?? 0, data.no_balls_bowled ?? 0,
    ]
  );
  await _save();
};

// ── Get full opponent data for a match ────────────────────────────────────────
export const getOppData = async (matchId: string): Promise<{
  batting: any[]; bowling: any[];
}> => {
  await ensureMatchTables();
  const db = await getDb();
  const batting = queryRows(db,
    `SELECT * FROM local_opp_batting WHERE match_id=? ORDER BY innings_no, batting_pos, id`,
    [matchId]
  );
  const bowling = queryRows(db,
    `SELECT * FROM local_opp_bowling WHERE match_id=? ORDER BY innings_no, id`,
    [matchId]
  );
  return { batting, bowling };
};

// ── Update opponent team totals on the match record ───────────────────────────
export const updateOppTotals = async (
  matchId: string,
  runs: number, wickets: number, overs: number
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  db.run(
    `UPDATE local_matches SET opp_total_runs=?, opp_total_wickets=?, opp_total_overs=?, updated_at=? WHERE local_id=?`,
    [runs, wickets, overs, new Date().toISOString(), matchId]
  );
  await _save();
};

// ── Update match overs and team assignments ────────────────────────────────────
export const updateMatchMeta = async (
  matchId: string,
  data: { total_overs?: number; innings1_team?: string; innings2_team?: string; result_status?: string; }
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  const fields: string[] = [], vals: any[] = [];
  if (data.total_overs   !== undefined) { fields.push('total_overs=?');   vals.push(data.total_overs); }
  if (data.innings1_team !== undefined) { fields.push('innings1_team=?'); vals.push(data.innings1_team); }
  if (data.innings2_team !== undefined) { fields.push('innings2_team=?'); vals.push(data.innings2_team); }
  if (data.result_status !== undefined) { fields.push('result_status=?'); vals.push(data.result_status); }
  if (!fields.length) return;
  fields.push('updated_at=?'); vals.push(new Date().toISOString());
  vals.push(matchId);
  db.run(`UPDATE local_matches SET ${fields.join(',')} WHERE local_id=?`, vals);
  await _save();
};

// ── Add/remove player from local match lineup ──────────────────────────────
export const addPlayerToMatch = async (
  matchId: string,
  player: { student_id: number; student_name: string; batting_pos: number; is_captain?: number; is_wicketkeeper?: number }
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  db.run(
    `INSERT OR IGNORE INTO local_lineup (match_id, student_id, student_name, batting_pos, is_captain, is_wicketkeeper)
     VALUES (?,?,?,?,?,?)`,
    [matchId, player.student_id, player.student_name, player.batting_pos,
     player.is_captain || 0, player.is_wicketkeeper || 0]
  );
  await _save();
};

export const removePlayerFromMatch = async (matchId: string, studentId: number): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  // Only remove if no scoring activity
  const hasStats = queryRows(db,
    `SELECT id FROM local_stats WHERE match_id=? AND student_id=? AND (runs_scored>0 OR balls_faced>0 OR overs_bowled>0 OR catches>0)`,
    [matchId, studentId]
  );
  if (hasStats.length > 0) throw new Error('Player has scoring activity — cannot remove');
  db.run(`DELETE FROM local_lineup WHERE match_id=? AND student_id=?`, [matchId, studentId]);
  await _save();
};

// ── Fall of wickets ────────────────────────────────────────────────────────
export const saveFallOfWicket = async (
  matchId: string, inningsNo: number, wicketNo: number,
  data: { score: number; overs: number; batsman_name: string; how_out: string }
): Promise<void> => {
  await ensureMatchTables();
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS local_fow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL, innings_no INTEGER NOT NULL,
    wicket_no INTEGER NOT NULL, score INTEGER DEFAULT 0,
    overs REAL DEFAULT 0, batsman_name TEXT DEFAULT '', how_out TEXT DEFAULT '',
    UNIQUE(match_id, innings_no, wicket_no)
  )`);
  db.run(
    `INSERT OR REPLACE INTO local_fow (match_id, innings_no, wicket_no, score, overs, batsman_name, how_out)
     VALUES (?,?,?,?,?,?,?)`,
    [matchId, inningsNo, wicketNo, data.score, data.overs, data.batsman_name, data.how_out]
  );
  await _save();
};

export const getFallOfWickets = async (matchId: string): Promise<any[]> => {
  await ensureMatchTables();
  const db = await getDb();
  try {
    return queryRows(db,
      `SELECT * FROM local_fow WHERE match_id=? ORDER BY innings_no, wicket_no`,
      [matchId]
    );
  } catch { return []; }
};
