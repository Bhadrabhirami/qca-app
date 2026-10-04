#!/usr/bin/env python3
"""
QCA Mobile App — Database Patch Script v3
==========================================
Run: python3 run_patch.py

Safe to run multiple times. All operations use
IF NOT EXISTS / INSERT OR IGNORE / try/except.
"""

import sqlite3
import os
import sys
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("qca_patch")

DB_PATH = os.getenv("DATABASE_PATH", "/opt/qca_app/qca.db")


def run(conn, sql, params=()):
    """Execute SQL, log result, return cursor."""
    try:
        cur = conn.execute(sql, params)
        return cur
    except sqlite3.OperationalError as e:
        # Expected for ALTER TABLE on existing columns — not an error
        if "duplicate column" in str(e).lower() or "already exists" in str(e).lower():
            log.debug("Skip (already exists): %s", str(e)[:80])
        else:
            log.warning("OperationalError: %s | SQL: %s", e, sql[:80])
    except sqlite3.IntegrityError as e:
        log.debug("IntegrityError (likely already exists): %s", str(e)[:80])
    return None


def section(title):
    log.info("")
    log.info("━━━ %s", title)


# ─────────────────────────────────────────────────────────────────────────────
def main():
    if not os.path.exists(DB_PATH):
        log.error("Database not found: %s", DB_PATH)
        sys.exit(1)

    log.info("Connecting to: %s", DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = OFF")

    try:
        s1_new_tables(conn)
        s2_column_additions(conn)
        s3_data_fixes(conn)
        s4_indexes(conn)
        s5_triggers(conn)
        s6_permissions(conn)
        conn.commit()
        s7_verify(conn)
        log.info("")
        log.info("✅  Patch complete. Restart the service: systemctl restart qca")
    except Exception as e:
        conn.rollback()
        log.error("PATCH FAILED: %s", e, exc_info=True)
        sys.exit(1)
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
def s1_new_tables(conn):
    section("SECTION 1 — New Tables")

    run(conn, """
        CREATE TABLE IF NOT EXISTS fee_write_offs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id       INTEGER NOT NULL,
            billing_month    TEXT    NOT NULL,
            amount           REAL    NOT NULL DEFAULT 0,
            reason           TEXT    NOT NULL DEFAULT 'Other',
            remarks          TEXT    DEFAULT '',
            approved_by      TEXT    NOT NULL DEFAULT '',
            is_active        INTEGER DEFAULT 1,
            reversed_at      TEXT    DEFAULT NULL,
            reversed_by      TEXT    DEFAULT NULL,
            reversal_reason  TEXT    DEFAULT NULL,
            created_at       TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    log.info("  ✓ fee_write_offs")

    run(conn, """
        CREATE TABLE IF NOT EXISTS reminder_config (
            key        TEXT PRIMARY KEY,
            value      TEXT DEFAULT '',
            updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    log.info("  ✓ reminder_config")

    run(conn, """
        CREATE TABLE IF NOT EXISTS reminder_logs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id    INTEGER NOT NULL,
            billing_month TEXT    NOT NULL,
            tier          INTEGER DEFAULT 1,
            email_ok      INTEGER DEFAULT 0,
            whatsapp_ok   INTEGER DEFAULT 0,
            sent_at       TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE(student_id, billing_month)
        )
    """)
    log.info("  ✓ reminder_logs")

    run(conn, """
        CREATE TABLE IF NOT EXISTS attendance_corrections (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id   INTEGER NOT NULL,
            date         TEXT    NOT NULL,
            session      TEXT    NOT NULL,
            corrected_by TEXT    NOT NULL,
            reason       TEXT    DEFAULT '',
            corrected_at TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    log.info("  ✓ attendance_corrections")

    run(conn, """
        CREATE TABLE IF NOT EXISTS sys_counters (
            counter_name TEXT PRIMARY KEY,
            next_value   INTEGER DEFAULT 1
        )
    """)
    run(conn, "INSERT OR IGNORE INTO sys_counters (counter_name, next_value) VALUES ('receipt_no', 1)")
    log.info("  ✓ sys_counters")

    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
def s2_column_additions(conn):
    section("SECTION 2 — Column Additions")

    columns = [
        # (table, column, definition)
        # students
        ("students", "updated_at",              "TEXT DEFAULT (CURRENT_TIMESTAMP)"),
        ("students", "parent_phone",            "TEXT DEFAULT ''"),
        ("students", "parent_email",            "TEXT DEFAULT ''"),
        ("students", "emergency_contact_name",  "TEXT DEFAULT ''"),
        ("students", "emergency_contact_phone", "TEXT DEFAULT ''"),
        ("students", "medical_conditions",      "TEXT DEFAULT ''"),
        ("students", "kit_size",                "TEXT DEFAULT ''"),
        ("students", "referral_source",         "TEXT DEFAULT ''"),
        ("students", "current_grade",           "TEXT DEFAULT ''"),
        ("students", "student_category",        "TEXT DEFAULT 'Regular'"),
        # attendance
        ("attendance", "uploaded_by", "TEXT DEFAULT ''"),
        # fee_write_offs
        ("fee_write_offs", "reversed_at",     "TEXT DEFAULT NULL"),
        ("fee_write_offs", "reversed_by",     "TEXT DEFAULT NULL"),
        ("fee_write_offs", "reversal_reason", "TEXT DEFAULT NULL"),
        ("fee_write_offs", "is_active",       "INTEGER DEFAULT 1"),
        # payments
        ("payments", "billing_month", "TEXT DEFAULT ''"),
        ("payments", "receipt_no",    "TEXT DEFAULT ''"),
        ("payments", "txn_direction", "TEXT DEFAULT 'IN'"),
    ]

    added = 0
    for table, col, defn in columns:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {defn}")
            log.info("  ✓ %s.%s added", table, col)
            added += 1
        except sqlite3.OperationalError:
            log.debug("  · %s.%s already exists", table, col)

    log.info("  → %d column(s) added", added)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
def s3_data_fixes(conn):
    section("SECTION 3 — Data Fixes")

    # Backfill updated_at for existing students
    cur = conn.execute("""
        UPDATE students
        SET updated_at = CURRENT_TIMESTAMP
        WHERE updated_at IS NULL OR updated_at = ''
    """)
    log.info("  ✓ students.updated_at backfilled: %d rows", cur.rowcount)

    # Fix receipt counter to max actual receipt
    row = conn.execute("""
        SELECT COALESCE(MAX(CAST(SUBSTR(receipt_no, 5) AS INTEGER)), 0) AS m
        FROM payments WHERE receipt_no LIKE 'REC-%'
    """).fetchone()
    max_receipt = (row["m"] or 0) + 1
    conn.execute("""
        UPDATE sys_counters
        SET next_value = MAX(next_value, ?)
        WHERE counter_name = 'receipt_no'
    """, (max_receipt,))
    log.info("  ✓ receipt counter set to: %d", max_receipt)

    # Deduplicate attendance — MUST run before UNIQUE index creation
    # Detect column names (date vs attendance_date)
    att_cols = {r[1] for r in conn.execute("PRAGMA table_info(attendance)").fetchall()}
    date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
    session_col = "session_type"    if "session_type"    in att_cols else "session"

    before = conn.execute("SELECT COUNT(*) AS n FROM attendance").fetchone()["n"]
    conn.execute(f"""
        DELETE FROM attendance
        WHERE id NOT IN (
            SELECT MIN(id)
            FROM attendance
            GROUP BY student_id, {date_col}, {session_col}
        )
    """)
    after = conn.execute("SELECT COUNT(*) AS n FROM attendance").fetchone()["n"]
    removed = before - after
    log.info("  ✓ attendance deduplication: %d duplicate(s) removed (%d → %d)",
             removed, before, after)

    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
def s4_indexes(conn):
    section("SECTION 4 — Indexes")

    # Detect attendance column names
    att_cols    = {r[1] for r in conn.execute("PRAGMA table_info(attendance)").fetchall()}
    date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
    session_col = "session_type"    if "session_type"    in att_cols else "session"

    indexes = [
        # UNIQUE indexes
        (f"CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique "
         f"ON attendance(student_id, {date_col}, {session_col})"),

        ("CREATE UNIQUE INDEX IF NOT EXISTS idx_write_offs_unique "
         "ON fee_write_offs(student_id, billing_month)"),

        # Performance indexes
        "CREATE INDEX IF NOT EXISTS idx_students_status    ON students(status)",
        "CREATE INDEX IF NOT EXISTS idx_students_type      ON students(student_type)",
        "CREATE INDEX IF NOT EXISTS idx_students_updated   ON students(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_payments_student   ON payments(student_id)",
        "CREATE INDEX IF NOT EXISTS idx_payments_date      ON payments(payment_date)",
        "CREATE INDEX IF NOT EXISTS idx_payments_billing   ON payments(billing_month)",
        "CREATE INDEX IF NOT EXISTS idx_payments_receipt   ON payments(receipt_no)",
        "CREATE INDEX IF NOT EXISTS idx_attendance_date    ON attendance(date)",
        "CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id)",
        "CREATE INDEX IF NOT EXISTS idx_writeoffs_student  ON fee_write_offs(student_id)",
        "CREATE INDEX IF NOT EXISTS idx_writeoffs_active   ON fee_write_offs(is_active)",
    ]

    for sql in indexes:
        name = sql.split("INDEX IF NOT EXISTS")[1].split("ON")[0].strip()
        try:
            conn.execute(sql)
            log.info("  ✓ %s", name)
        except sqlite3.OperationalError as e:
            log.warning("  ⚠ %s: %s", name, e)

    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
def s5_triggers(conn):
    section("SECTION 5 — Triggers")

    conn.execute("DROP TRIGGER IF EXISTS students_updated_at")
    conn.execute("""
        CREATE TRIGGER students_updated_at
        AFTER UPDATE ON students
        FOR EACH ROW
        BEGIN
            UPDATE students SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END
    """)
    log.info("  ✓ students_updated_at trigger created")
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
def s6_permissions(conn):
    section("SECTION 6 — Roles & Permissions")

    # ── Roles ────────────────────────────────────────────────────────────────
    roles = [
        ("Admin",   "Full access to all features"),
        ("Coach",   "Attendance, students, payments, media"),
        ("Scorer",  "Match scoring only"),
        ("Parent",  "Own child data only (restricted)"),
        ("Student", "Own data only (restricted)"),
        ("Viewer",  "Read-only match scorecards"),
    ]
    for name, desc in roles:
        conn.execute(
            "INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)",
            (name, desc)
        )
    log.info("  ✓ %d roles ensured", len(roles))

    # ── Permissions ──────────────────────────────────────────────────────────
    permissions = [
        # Attendance
        ("attendance:view",      "View Attendance",           "attendance"),
        ("attendance:take",      "Mark Attendance",           "attendance"),
        ("attendance:upload",    "Upload Attendance",         "attendance"),
        ("attendance:download",  "Download Attendance",       "attendance"),
        ("attendance:delete",    "Delete Attendance Records", "attendance"),
        ("attendance:share",     "Share Attendance",          "attendance"),
        ("attendance:history",   "Attendance History",        "attendance"),
        ("attendance:records",   "Attendance Records",        "attendance"),
        ("attendance:dashboard", "Attendance Dashboard",      "attendance"),
        # Students
        ("student:view",         "View Students",             "student"),
        ("student:add",          "Add Students",              "student"),
        ("student:edit",         "Edit Students",             "student"),
        ("student:photo:upload", "Upload Student Photo",      "student"),
        ("student:photo:delete", "Delete Student Photo",      "student"),
        # Remarks
        ("remarks:view",         "View Remarks",              "remarks"),
        ("remarks:add",          "Add Remarks",               "remarks"),
        ("remarks:edit:own",     "Edit Own Remarks",          "remarks"),
        ("remarks:edit:any",     "Edit Any Remarks",          "remarks"),
        ("remarks:delete:own",   "Delete Own Remarks",        "remarks"),
        ("remarks:delete:any",   "Delete Any Remarks",        "remarks"),
        # Sync
        ("sync:upload",          "Sync Upload",               "sync"),
        ("sync:download",        "Sync Download",             "sync"),
        ("sync:students",        "Sync Students",             "sync"),
        ("sync:payments",        "Sync Payments",             "sync"),
        ("sync:reupload",        "Sync Re-upload",            "sync"),
        ("sync:runall",          "Sync Run All",              "sync"),
        # Payments
        ("payments:view",        "View Payments",             "payments"),
        ("payments:add",         "Record Payments",           "payments"),
        ("payments:alerts",      "Payment Reminders",         "payments"),
        ("payments:summary",     "Payment Summary",           "payments"),
        # Media
        ("media:view",           "View Media",                "media"),
        ("media:upload",         "Upload Media",              "media"),
        ("media:delete",         "Delete Media",              "media"),
        ("media:tag",            "Tag Media",                 "media"),
        # Matches
        ("matches:view",         "View Matches",              "matches"),
        ("matches:create",       "Create Matches",            "matches"),
        ("matches:score",        "Score Matches",             "matches"),
        ("matches:edit",         "Edit Matches",              "matches"),
        ("matches:delete",       "Delete Matches",            "matches"),
        # App features
        ("app:settings",         "App Settings",              "app"),
        ("app:biometric",        "Biometric Auth",            "app"),
        ("app:library",          "Training Library",          "app"),
        ("app:videos",           "Videos",                    "app"),
        ("app:contact",          "Contact",                   "app"),
        ("app:news",             "Cricket Hub",               "app"),
        ("app:pulse",            "Academy Pulse",             "app"),
    ]
    for slug, label, module in permissions:
        conn.execute(
            "INSERT OR IGNORE INTO permissions (slug, label, module) VALUES (?, ?, ?)",
            (slug, label, module)
        )
    log.info("  ✓ %d permissions ensured", len(permissions))

    # ── Role → Permission assignments ────────────────────────────────────────
    role_perms = {
        "Admin": [
            "attendance:view","attendance:take","attendance:upload","attendance:download",
            "attendance:delete","attendance:share","attendance:history","attendance:records",
            "attendance:dashboard",
            "student:view","student:add","student:edit",
            "student:photo:upload","student:photo:delete",
            "remarks:view","remarks:add","remarks:edit:own","remarks:edit:any",
            "remarks:delete:own","remarks:delete:any",
            "sync:upload","sync:download","sync:students","sync:payments",
            "sync:reupload","sync:runall",
            "payments:view","payments:add","payments:alerts","payments:summary",
            "media:view","media:upload","media:delete","media:tag",
            "matches:view","matches:create","matches:score","matches:edit","matches:delete",
            "app:settings","app:biometric","app:library","app:videos","app:contact",
            "app:news","app:pulse",
        ],
        "Coach": [
            "attendance:view","attendance:take","attendance:upload","attendance:download",
            "attendance:delete","attendance:share","attendance:history","attendance:records",
            "attendance:dashboard",
            "student:view","student:add",
            "remarks:view","remarks:add","remarks:edit:own","remarks:delete:own",
            "sync:upload","sync:download","sync:students","sync:payments",
            "sync:reupload","sync:runall",
            "payments:view","payments:add","payments:alerts","payments:summary",
            "media:view","media:upload","media:delete","media:tag",
            "matches:view","matches:create","matches:score","matches:edit",
            "app:settings","app:biometric","app:library","app:videos","app:contact",
            "app:news","app:pulse",
        ],
        "Scorer": [
            "matches:view","matches:score",
            "app:settings","app:biometric","app:library","app:videos","app:contact",
        ],
        "Parent": [
            "student:view",
            "attendance:view","attendance:history",
            "payments:view",
            "remarks:view",
            "matches:view",
            "app:settings","app:biometric","app:library","app:videos","app:contact",
            "app:news",
        ],
        "Student": [
            "student:view",
            "attendance:view",
            "payments:view",
            "matches:view",
            "app:settings","app:biometric","app:library","app:videos","app:contact",
            "app:news",
        ],
        "Viewer": [
            "matches:view",
            "app:settings","app:biometric","app:library","app:videos","app:contact",
        ],
    }

    total_granted = 0
    for role_name, slugs in role_perms.items():
        role = conn.execute(
            "SELECT id FROM roles WHERE name = ?", (role_name,)
        ).fetchone()
        if not role:
            log.warning("  ⚠ Role not found: %s", role_name)
            continue
        granted = 0
        for slug in slugs:
            perm = conn.execute(
                "SELECT id FROM permissions WHERE slug = ?", (slug,)
            ).fetchone()
            if not perm:
                log.warning("  ⚠ Permission not found: %s", slug)
                continue
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
                    (role["id"], perm["id"])
                )
                granted += 1
            except sqlite3.IntegrityError:
                pass
        log.info("  ✓ %-10s → %d permissions granted", role_name, granted)
        total_granted += granted

    log.info("  → %d total role_permissions ensured", total_granted)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
def s7_verify(conn):
    section("SECTION 7 — Verification")

    # Roles with permission counts
    rows = conn.execute("""
        SELECT r.name, COUNT(rp.id) AS cnt
        FROM roles r
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        GROUP BY r.name ORDER BY r.id
    """).fetchall()
    log.info("  Role permissions:")
    for r in rows:
        log.info("    %-12s %d permissions", r["name"], r["cnt"])

    # Table counts
    tables = [
        "students", "payments", "attendance",
        "fee_write_offs", "reminder_config", "reminder_logs",
        "permissions", "role_permissions",
    ]
    log.info("  Table row counts:")
    for t in tables:
        try:
            n = conn.execute(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"]
            log.info("    %-25s %d rows", t, n)
        except Exception:
            log.info("    %-25s (not found)", t)

    # Receipt counter vs DB max
    counter = conn.execute(
        "SELECT next_value FROM sys_counters WHERE counter_name='receipt_no'"
    ).fetchone()
    db_max = conn.execute(
        "SELECT COALESCE(MAX(CAST(SUBSTR(receipt_no,5) AS INTEGER)),0) AS m "
        "FROM payments WHERE receipt_no LIKE 'REC-%'"
    ).fetchone()
    log.info("  Receipt counter : %s", counter["next_value"] if counter else "N/A")
    log.info("  DB max receipt  : REC-%s", db_max["m"] if db_max else "0")

    # Students with updated_at
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM students WHERE updated_at IS NOT NULL AND updated_at != ''"
    ).fetchone()["n"]
    log.info("  Students with updated_at: %d", n)

    # Trigger check
    t = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='students_updated_at'"
    ).fetchone()
    log.info("  students_updated_at trigger: %s", "✓ exists" if t else "✗ missing")


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    main()
