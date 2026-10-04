"""
database.py — QCA Application Database Module
──────────────────────────────────────────────
Single source of truth for all SQLite connection management.

Features:
  • WAL mode enabled  — concurrent reads during writes (multi-coach safe)
  • NORMAL sync       — faster writes, crash-safe with WAL
  • busy_timeout 5s   — waits instead of erroring on lock contention
  • row_factory       — all rows returned as sqlite3.Row (dict-like access)
  • execute_with_retry — automatic retry on OperationalError (lock)
  • init_db()         — safe schema migration (CREATE IF NOT EXISTS)
  • ensure_account_bridge() — guarantees student has a matching account row
"""

import os
import sqlite3
import time
import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("xxgs_database")

# ── Database path ──────────────────────────────────────────────────────────────
DATABASE_PATH = os.getenv("DATABASE_PATH", "/opt/qca_app/qca.db")


# ── Connection factory ─────────────────────────────────────────────────────────
def get_db_connection() -> sqlite3.Connection:
    """
    Returns a configured SQLite connection.

    Settings applied on every connection:
      WAL journal mode  — readers never block writers, writers never block readers
      NORMAL sync       — safe with WAL, significantly faster than FULL
      busy_timeout 5s   — retry on lock instead of raising OperationalError
      foreign_keys ON   — enforce referential integrity
      row_factory       — rows accessible as dict-like objects (row["column"])
    """
    conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA cache_size=-8000")   # 8MB page cache
    return conn


# ── Retry helper ───────────────────────────────────────────────────────────────
def execute_with_retry(
    conn: sqlite3.Connection,
    sql: str,
    params: tuple = (),
    max_retries: int = 3,
    retry_delay: float = 0.15,
) -> sqlite3.Cursor:
    """
    Execute a SQL statement with automatic retry on OperationalError.

    Handles transient "database is locked" errors that can occur during
    concurrent writes from multiple coaches/devices.

    Args:
        conn:        Active SQLite connection
        sql:         SQL statement to execute
        params:      Bound parameters (tuple)
        max_retries: Maximum retry attempts (default 3)
        retry_delay: Seconds between retries (default 0.15s)

    Returns:
        sqlite3.Cursor on success

    Raises:
        sqlite3.OperationalError if all retries exhausted
    """
    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            return conn.execute(sql, params)
        except sqlite3.OperationalError as e:
            last_err = e
            if "locked" in str(e).lower() and attempt < max_retries:
                logger.warning(
                    "xxgs_ [DB] Lock contention on attempt %d/%d — retrying in %.2fs",
                    attempt, max_retries, retry_delay
                )
                time.sleep(retry_delay * attempt)  # exponential back-off
            else:
                raise
    raise last_err  # type: ignore


# ── Account bridge ─────────────────────────────────────────────────────────────
def ensure_account_bridge(
    conn: sqlite3.Connection,
    student_id: int,
) -> int:
    """
    Guarantees a student has exactly one matching row in the accounts table.

    The accounts table is used for payment ledger tracking. Every active
    student must have an account row. This function is idempotent — safe
    to call multiple times for the same student.

    Args:
        conn:       Active SQLite connection
        student_id: The student's ID

    Returns:
        account_id (int) — the student's account row ID
    """
    existing = conn.execute(
        "SELECT id FROM accounts WHERE student_id = ? LIMIT 1",
        (student_id,)
    ).fetchone()

    if existing:
        return existing["id"]

    # Fetch student name for account label
    student = conn.execute(
        "SELECT name FROM students WHERE id = ?",
        (student_id,)
    ).fetchone()
    student_name = student["name"] if student else f"Student {student_id}"

    conn.execute(
        """INSERT INTO accounts (student_id, account_name, account_type, is_active, created_at)
           VALUES (?, ?, 'Student', 1, datetime('now'))""",
        (student_id, student_name)
    )
    conn.commit()

    row = conn.execute(
        "SELECT id FROM accounts WHERE student_id = ? LIMIT 1",
        (student_id,)
    ).fetchone()
    logger.info("xxgs_ [DB] Account bridge created for student_id=%d", student_id)
    return row["id"]


# ── Schema initialisation ──────────────────────────────────────────────────────
def init_db() -> None:
    """
    Safe schema migration — creates all tables if they don't exist.
    Safe to call on every startup. Never drops or alters existing data.
    """
    conn = get_db_connection()
    try:
        _create_core_tables(conn)
        try:
            _create_attendance_tables(conn)
        except Exception as att_e:
            # Duplicate rows in attendance — log and continue
            # The dedup inside _create_attendance_tables handles this
            logger.warning("xxgs_ [DB] _create_attendance_tables warning: %s", att_e)
            conn.rollback()
        _create_finance_tables(conn)
        _create_media_tables(conn)
        _create_system_tables(conn)
        _safe_migrations(conn)
        conn.commit()
        logger.info("xxgs_ [DB] init_db() complete — path: %s", DATABASE_PATH)
    except Exception as e:
        conn.rollback()
        logger.error("xxgs_ [DB] init_db() failed: %s", e, exc_info=True)
        raise
    finally:
        conn.close()


def _create_core_tables(conn: sqlite3.Connection) -> None:
    """Users, roles, permissions, students, accounts."""

    conn.execute("""
        CREATE TABLE IF NOT EXISTS roles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL UNIQUE,
            description TEXT,
            is_active   INTEGER DEFAULT 1,
            created_at  TEXT    DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS permissions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            slug        TEXT NOT NULL UNIQUE,
            label       TEXT NOT NULL,
            module      TEXT NOT NULL DEFAULT 'app',
            description TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS role_permissions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            role_id       INTEGER NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
            permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
            UNIQUE(role_id, permission_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rp_role ON role_permissions(role_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            username        TEXT    NOT NULL UNIQUE,
            password        TEXT    NOT NULL,
            role            TEXT    NOT NULL DEFAULT 'viewer',
            user_type       TEXT    NOT NULL DEFAULT 'staff',
            is_active       INTEGER DEFAULT 1,
            is_restricted   INTEGER DEFAULT 0,
            login_attempts  INTEGER DEFAULT 0,
            last_login      TEXT,
            created_at      TEXT    DEFAULT (datetime('now')),
            updated_at      TEXT    DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS students (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            name                   TEXT    NOT NULL,
            age                    INTEGER DEFAULT 0,
            phone                  TEXT    DEFAULT '',
            email                  TEXT    DEFAULT '',
            level                  TEXT    DEFAULT 'Beginner',
            user_id                INTEGER,
            status                 TEXT    DEFAULT 'Active',
            exit_date              TEXT,
            exit_reason            TEXT,
            coach_id               INTEGER,
            school_name            TEXT    DEFAULT '',
            date_of_birth          TEXT,
            parent_name            TEXT    DEFAULT '',
            parent_phone           TEXT    DEFAULT '',
            parent_email           TEXT    DEFAULT '',
            student_type           TEXT    DEFAULT 'Academy',
            student_category       TEXT    DEFAULT 'Regular',
            blood_group            TEXT    DEFAULT '',
            dominant_side          TEXT    DEFAULT 'Right',
            profile_image          TEXT,
            monthly_fee            REAL    DEFAULT 0,
            enrollment_date        TEXT    DEFAULT (DATE('now')),
            gender                 TEXT    DEFAULT 'Male',
            current_grade          TEXT    DEFAULT '',
            emergency_contact_name TEXT    DEFAULT '',
            emergency_contact_phone TEXT   DEFAULT '',
            medical_conditions     TEXT    DEFAULT '',
            kit_size               TEXT    DEFAULT '',
            referral_source        TEXT    DEFAULT '',
            updated_at             TEXT    DEFAULT (CURRENT_TIMESTAMP),
            created_at             TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_students_status ON students(status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_students_type   ON students(student_type)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS accounts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id   INTEGER NOT NULL UNIQUE REFERENCES students(id),
            account_name TEXT    NOT NULL DEFAULT '',
            account_type TEXT    NOT NULL DEFAULT 'Student',
            is_active    INTEGER DEFAULT 1,
            created_at   TEXT    DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_student_links (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            link_type  TEXT    NOT NULL DEFAULT 'parent',
            is_primary INTEGER DEFAULT 1,
            created_at TEXT    DEFAULT (datetime('now')),
            created_by TEXT,
            UNIQUE(user_id, student_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usl_user    ON user_student_links(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usl_student ON user_student_links(student_id)")


def _create_attendance_tables(conn: sqlite3.Connection) -> None:
    """Permanent attendance + temp staging table."""

    conn.execute("""
        CREATE TABLE IF NOT EXISTS attendance (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id      INTEGER NOT NULL REFERENCES students(id),
            date            TEXT    NOT NULL,
            session         TEXT    NOT NULL DEFAULT 'Morning',
            status          TEXT    NOT NULL DEFAULT 'Present',
            uploaded_by     TEXT    DEFAULT '',
            created_at      TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    # UNIQUE index — deduplicate existing rows first, then enforce uniqueness
    # Existing data may have duplicates from before this constraint existed
    try:
        # Step 1: Remove duplicate rows — keep the row with the lowest id
        conn.execute("""
            DELETE FROM attendance
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM attendance
                GROUP BY student_id, date, session
            )
        """)
        conn.commit()
    except Exception as e:
        logger.warning("xxgs_ [DB] Attendance dedup: %s", e)

    try:
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique
            ON attendance(student_id, date, session)
        """)
    except Exception as e:
        logger.warning("xxgs_ [DB] Attendance unique index: %s (may already exist)", e)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attendance_date    ON attendance(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS temp_attendance (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id  INTEGER NOT NULL,
            date        TEXT    NOT NULL,
            session     TEXT    NOT NULL DEFAULT 'Morning',
            status      TEXT    NOT NULL DEFAULT 'PRESENT',
            uploaded_by TEXT    DEFAULT '',
            created_at  TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE(student_id, date, session, uploaded_by)
        )
    """)

    conn.execute("""
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


def _create_finance_tables(conn: sqlite3.Connection) -> None:
    """Payments, fee categories, write-offs, counters."""

    conn.execute("""
        CREATE TABLE IF NOT EXISTS account_categories (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL UNIQUE,
            description TEXT    DEFAULT '',
            is_active   INTEGER DEFAULT 1,
            created_at  TEXT    DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS payments (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id     INTEGER NOT NULL REFERENCES students(id),
            fee_type_id    INTEGER REFERENCES account_categories(id),
            amount_paid    REAL    NOT NULL DEFAULT 0,
            payment_date   TEXT    NOT NULL DEFAULT (DATE('now')),
            payment_mode   TEXT    DEFAULT 'Cash',
            billing_month  TEXT    DEFAULT '',
            account_id     INTEGER REFERENCES accounts(id),
            txn_direction  TEXT    DEFAULT 'IN',
            remarks        TEXT    DEFAULT '',
            status         TEXT    DEFAULT 'Paid',
            receipt_no     TEXT    DEFAULT '',
            session_id     TEXT    DEFAULT '',
            created_at     TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_date    ON payments(payment_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_billing ON payments(billing_month)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_receipt ON payments(receipt_no)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS sys_counters (
            counter_name TEXT PRIMARY KEY,
            next_value   INTEGER DEFAULT 1
        )
    """)
    conn.execute("""
        INSERT OR IGNORE INTO sys_counters (counter_name, next_value)
        VALUES ('receipt_no', 1)
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS fee_write_offs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id       INTEGER NOT NULL REFERENCES students(id),
            billing_month    TEXT    NOT NULL,
            amount           REAL    NOT NULL DEFAULT 0,
            reason           TEXT    NOT NULL DEFAULT 'Other',
            remarks          TEXT    DEFAULT '',
            approved_by      TEXT    NOT NULL DEFAULT '',
            is_active        INTEGER DEFAULT 1,
            reversed_at      TEXT    DEFAULT NULL,
            reversed_by      TEXT    DEFAULT NULL,
            reversal_reason  TEXT    DEFAULT NULL,
            created_at       TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE(student_id, billing_month)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_writeoffs_student ON fee_write_offs(student_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_writeoffs_active  ON fee_write_offs(is_active)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS reminder_config (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """)

    conn.execute("""
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


def _create_media_tables(conn: sqlite3.Connection) -> None:
    """Media library, Academy Pulse gallery."""

    conn.execute("""
        CREATE TABLE IF NOT EXISTS media (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            secure_url           TEXT    NOT NULL,
            resource_type        TEXT    NOT NULL DEFAULT 'image',
            upload_date          TEXT    NOT NULL DEFAULT (DATE('now')),
            file_type            TEXT    DEFAULT 'Photo',
            caption              TEXT    DEFAULT '',
            cloudinary_public_id TEXT    DEFAULT '',
            uploaded_by          TEXT    DEFAULT '',
            created_at           TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS media_student_tags (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            UNIQUE(media_id, student_id)
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS academy_pulse (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            secure_url           TEXT    NOT NULL,
            resource_type        TEXT    NOT NULL DEFAULT 'image',
            caption              TEXT    DEFAULT '',
            tag_type             TEXT    DEFAULT 'Training',
            activity_date        TEXT    DEFAULT (DATE('now')),
            uploaded_by          TEXT    DEFAULT '',
            cloudinary_public_id TEXT    DEFAULT '',
            is_highlight         INTEGER DEFAULT 0,
            created_at           TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pulse_date ON academy_pulse(activity_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pulse_tag  ON academy_pulse(tag_type)")


def _create_system_tables(conn: sqlite3.Connection) -> None:
    """Auth, rate limiting, remarks, contact messages."""

    conn.execute("""
        CREATE TABLE IF NOT EXISTS auth_rate_limit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address  TEXT    NOT NULL,
            username    TEXT    NOT NULL DEFAULT '',
            attempt_at  TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS remarks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id  INTEGER NOT NULL REFERENCES students(id),
            coach_name  TEXT    NOT NULL DEFAULT '',
            remark_text TEXT    NOT NULL DEFAULT '',
            remark_date TEXT    NOT NULL DEFAULT (DATE('now')),
            remark_type TEXT    DEFAULT 'General',
            is_private  INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (CURRENT_TIMESTAMP),
            updated_at  TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_remarks_student ON remarks(student_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS contact_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT    NOT NULL,
            name        TEXT    NOT NULL,
            email       TEXT    NOT NULL,
            phone       TEXT    DEFAULT '',
            message     TEXT    NOT NULL,
            category    TEXT    DEFAULT 'General',
            status      TEXT    DEFAULT 'new',
            created_at  TEXT    DEFAULT (CURRENT_TIMESTAMP)
        )
    """)


def _safe_migrations(conn: sqlite3.Connection) -> None:
    """
    Add columns that may be missing from older DB versions.
    Uses ALTER TABLE — safe to run repeatedly (errors silently ignored).
    """
    migrations = [
        # students table
        ("students", "updated_at",              "TEXT DEFAULT (CURRENT_TIMESTAMP)"),
        ("students", "parent_phone",            "TEXT DEFAULT ''"),
        ("students", "parent_email",            "TEXT DEFAULT ''"),
        ("students", "emergency_contact_name",  "TEXT DEFAULT ''"),
        ("students", "emergency_contact_phone", "TEXT DEFAULT ''"),
        ("students", "medical_conditions",      "TEXT DEFAULT ''"),
        ("students", "kit_size",                "TEXT DEFAULT ''"),
        ("students", "referral_source",         "TEXT DEFAULT ''"),
        ("students", "current_grade",           "TEXT DEFAULT ''"),
        # attendance table
        ("attendance",  "uploaded_by", "TEXT DEFAULT ''"),
        # fee_write_offs
        ("fee_write_offs", "reversed_at",     "TEXT DEFAULT NULL"),
        ("fee_write_offs", "reversed_by",     "TEXT DEFAULT NULL"),
        ("fee_write_offs", "reversal_reason", "TEXT DEFAULT NULL"),
        ("fee_write_offs", "is_active",       "INTEGER DEFAULT 1"),
        # payments
        ("payments", "billing_month", "TEXT DEFAULT ''"),
        ("payments", "receipt_no",    "TEXT DEFAULT ''"),
        ("payments", "txn_direction", "TEXT DEFAULT 'IN'"),
        # reminder_logs
        ("reminder_logs", "tier",         "INTEGER DEFAULT 1"),
        ("reminder_logs", "email_ok",     "INTEGER DEFAULT 0"),
        ("reminder_logs", "whatsapp_ok",  "INTEGER DEFAULT 0"),
    ]

    for table, column, definition in migrations:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            logger.debug("xxgs_ [DB] Migration: added %s.%s", table, column)
        except sqlite3.OperationalError:
            pass  # Column already exists — expected on re-run

    # students updated_at trigger (only create if not exists)
    triggers = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='students_updated_at'"
    ).fetchone()
    if not triggers:
        conn.execute("""
            CREATE TRIGGER students_updated_at
            AFTER UPDATE ON students
            FOR EACH ROW
            BEGIN
                UPDATE students SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END
        """)
        logger.info("xxgs_ [DB] Created trigger: students_updated_at")

    # Reset receipt counter to max actual payment if counter has drifted behind
    try:
        max_receipt = conn.execute(
            "SELECT MAX(CAST(SUBSTR(receipt_no, 5) AS INTEGER)) AS m "
            "FROM payments WHERE receipt_no LIKE 'REC-%'"
        ).fetchone()
        if max_receipt and max_receipt["m"]:
            conn.execute("""
                UPDATE sys_counters
                SET next_value = MAX(next_value, ?)
                WHERE counter_name = 'receipt_no'
            """, (max_receipt["m"] + 1,))
    except Exception:
        pass
