# xxgs_ QCA MOBILE DATA API  —  routes/api_data.py
# ══════════════════════════════════════════════════════════════════════
# Self-contained API module for mobile app data sync.
# ══════════════════════════════════════════════════════════════════════

from __future__ import annotations

import os
import sqlite3
import time
import traceback
import logging
from collections   import OrderedDict
from datetime      import datetime

from fastapi           import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from passlib.context   import CryptContext
from dotenv import load_dotenv

from database import get_db_connection

logger      = logging.getLogger("xxgs_api_data")
router      = APIRouter(prefix="/api/data", tags=["Mobile Data API"])

# ── CORS headers added to every response ─────────────────────────────────────
# Also add CORSMiddleware in main.py:
#   from fastapi.middleware.cors import CORSMiddleware
#   app.add_middleware(CORSMiddleware, allow_origins=["*"],
#       allow_methods=["*"], allow_headers=["*"], allow_credentials=True)
# CORS handled by Nginx
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

load_dotenv()
API_SYNC_KEY: str = os.getenv("API_SYNC_KEY", "")

print("✅ api_data router loaded")

# ══════════════════════════════════════════════════════════════════════
# RATE LIMITER  (unchanged)
# ══════════════════════════════════════════════════════════════════════
_RATE_WINDOW_SEC  = 300
_RATE_MAX_USER    = 10
_RATE_MAX_IP      = 30
_RATE_BLOCK_SEC   = 900
_RATE_CACHE_MAX   = 5_000

_rate_store: OrderedDict = OrderedDict()

def _rate_entry(key: str) -> dict:
    if key in _rate_store:
        _rate_store.move_to_end(key)
        return _rate_store[key]
    if len(_rate_store) >= _RATE_CACHE_MAX:
        _rate_store.popitem(last=False)
    entry = {"ts": [], "blocked_until": None}
    _rate_store[key] = entry
    return entry

def _get_ip(request: Request) -> str:
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

def _check_rate(ip: str, username: str) -> bool:
    now = time.monotonic()
    for key, limit in (
        (f"u:{ip}:{username.lower()}", _RATE_MAX_USER),
        (f"ip:{ip}",                   _RATE_MAX_IP),
    ):
        entry = _rate_entry(key)
        if entry["blocked_until"] and now < entry["blocked_until"]:
            logger.warning("xxgs_ [AUTH] rate-blocked %s for %ds more — returning 429", key, int(entry["blocked_until"] - now))
            return True
        cutoff      = now - _RATE_WINDOW_SEC
        entry["ts"] = [t for t in entry["ts"] if t > cutoff]
        if len(entry["ts"]) >= limit:
            entry["blocked_until"] = now + _RATE_BLOCK_SEC
            logger.warning("xxgs_ [AUTH] rate-limit TRIGGERED for %s — blocked for %ds", key, _RATE_BLOCK_SEC)
            return True
    return False

def _record_fail(ip: str, username: str) -> None:
    now = time.monotonic()
    _rate_entry(f"u:{ip}:{username.lower()}")["ts"].append(now)
    _rate_entry(f"ip:{ip}")["ts"].append(now)

def _clear_rate(ip: str, username: str) -> None:
    for key in (f"u:{ip}:{username.lower()}", f"ip:{ip}"):
        if key in _rate_store:
            _rate_store[key] = {"ts": [], "blocked_until": None}


# ══════════════════════════════════════════════════════════════════════
# AUTH DEPENDENCY  (unchanged)
# ══════════════════════════════════════════════════════════════════════
# These must be Exception subclasses — FastAPI dependencies can only raise exceptions,
# not return Response objects. JSONResponse cannot be raised.
class _DenyException(HTTPException):
    def __init__(self):
        super().__init__(status_code=401, detail="Unauthorized — invalid credentials")

class _RateDenyException(HTTPException):
    def __init__(self):
        super().__init__(
            status_code=429,
            detail="Too many failed attempts — try again in 15 minutes",
            headers={"Retry-After": str(_RATE_BLOCK_SEC)},
        )

_DENY      = _DenyException()
_RATE_DENY = _RateDenyException()

async def verify_api_auth(request: Request) -> str:
    ip = _get_ip(request)
    if not API_SYNC_KEY:
        logger.error("xxgs_ [API] API_SYNC_KEY not set in .env")
        raise _DenyException()
    username   = request.headers.get("X-Username", "").strip()  # preserve case
    client_key = request.headers.get("X-Api-Key",  "").strip()
    password   = request.headers.get("X-Password", "").strip()
    if _check_rate(ip, username or "_no_user_"):
        raise _RateDenyException()
    import hmac as _hmac
    if not (bool(client_key) and _hmac.compare_digest(client_key, API_SYNC_KEY)):
        _record_fail(ip, username or "_bad_key_")
        logger.warning("xxgs_ [AUTH] 401 — bad X-Api-Key from ip=%s user='%s'", ip, username or "_none_")
        raise _DenyException()
    if not username or not password:
        _record_fail(ip, username or "_missing_")
        logger.warning("xxgs_ [AUTH] 401 — missing username or password from ip=%s", ip)
        raise _DenyException()
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT id, username, password, role, is_active FROM users "
            "WHERE lower(username) = lower(?) AND is_active = 1 LIMIT 1",
            (username,),
        ).fetchone()
    except Exception as exc:
        logger.error("xxgs_ [API] DB error during auth: %s", exc)
        raise _DenyException()
    finally:
        conn.close()
    if not row:
        _record_fail(ip, username)
        logger.warning("xxgs_ [AUTH] 401 — user not found or inactive: '%s' from ip=%s", username, ip)
        raise _DenyException()
    stored_hash = row["password"] if isinstance(row, sqlite3.Row) else row[2]
    if not pwd_context.verify(password, stored_hash):
        _record_fail(ip, username)
        logger.warning("xxgs_ [AUTH] 401 — wrong password for user='%s' from ip=%s", username, ip)
        raise _DenyException()
    _clear_rate(ip, username)
    # Return the stored username (correct case) not what client sent
    stored_username = row["username"] if isinstance(row, sqlite3.Row) else row[1]
    return stored_username


# ══════════════════════════════════════════════════════════════════════
# ROLE HELPER — used by all endpoints for RBAC
# ══════════════════════════════════════════════════════════════════════
def get_user_role(username: str) -> str:
    """Returns normalised role — uses role TEXT column (source of truth)."""
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT role, user_type FROM users WHERE lower(username)=lower(?) AND is_active=1 LIMIT 1",
            (username,)
        ).fetchone()
        if not row:
            return 'viewer'
        raw = (row['role'] or '').lower().strip()
        # Admin variants
        if raw in ('admin', 'administrator', 'superadmin', 'super_admin', 'owner'):
            return 'admin'
        # Coach variants
        if raw in ('coach', 'trainer', 'staff', 'manager'):
            return 'coach'
        # Scorer
        if raw in ('scorer', 'umpire'):
            return 'scorer'
        # Student
        if raw == 'student':
            return 'student'
        # Parent
        if raw == 'parent':
            return 'parent'
        # Viewer / unknown
        return 'viewer'
    except Exception:
        return 'viewer'
    finally:
        conn.close()

def get_user_permissions(username: str) -> list:
    """
    Returns list of permission slugs for a user.
    Tries role_permissions table first; falls back to role-based defaults.
    """
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Try permission tables (Phase 1 of PBAC implementation)
        try:
            rows = conn.execute("""
                SELECT p.slug
                FROM permissions p
                JOIN role_permissions rp ON rp.permission_id = p.id
                JOIN roles r ON r.id = rp.role_id
                JOIN users u ON u.role_id = r.id
                WHERE u.username = ? AND u.is_active = 1
                ORDER BY p.slug
            """, (username,)).fetchall()
            if rows:
                return [r["slug"] for r in rows]
        except Exception:
            pass  # Tables don't exist yet — fall through to role-based

        # Fallback: derive from role string
        role = get_user_role(username)
        DEFAULTS = {
            "admin": [
                "attendance:view","attendance:take","attendance:upload","attendance:download",
                "attendance:delete","attendance:share","attendance:history","attendance:records",
                "attendance:dashboard","student:view","student:view:detail","student:view:fees","student:add","student:edit:own","student:edit:any","student:photo:upload","student:photo:delete",
                "student:photo:upload","student:photo:delete","remarks:view","remarks:add",
                "remarks:edit:own","remarks:edit:any","remarks:delete:own","remarks:delete:any",
                "sync:upload","sync:download","sync:students","sync:payments","sync:reupload","sync:runall","payments:view","payments:alerts","payments:summary","payments:add","payments:export",
                "media:view","media:upload","media:delete","media:tag",
                "matches:view","matches:create","matches:score","matches:edit","matches:delete",
                "app:settings","app:biometric","app:library","app:videos","app:contact",
            ],
            "coach": [
                "attendance:view","attendance:take","attendance:upload","attendance:download",
                "attendance:delete","attendance:share","attendance:history","attendance:records",
                "attendance:dashboard","student:view","student:view:detail","student:view:fees","student:add","student:edit:any","student:photo:upload","student:photo:delete",
                "remarks:view","remarks:add","remarks:edit:own","remarks:delete:own",
                "sync:upload","sync:download","sync:students","sync:payments","sync:reupload","sync:runall",
                "payments:view","payments:alerts","payments:summary","payments:add",
                "media:view","media:upload","media:delete","media:tag",
                "matches:view","matches:create","matches:score","matches:edit",
                "app:settings","app:biometric","app:library","app:videos","app:contact",
            ],
            "scorer": ["matches:view","matches:score","app:settings","app:biometric"],
            "viewer": [
                "matches:view",   # viewer sees ONLY match scorecards
                "app:settings","app:biometric","app:library","app:videos","app:contact",
            ],
            "student": [
                "attendance:view","attendance:history","attendance:dashboard",
                "remarks:view","payments:view","student:view","student:view:detail","student:edit:own",
                "matches:view","media:view","app:settings","app:biometric","app:library","app:videos","app:contact",
            ],
            "parent": [
                "attendance:view","attendance:history","attendance:dashboard",
                "remarks:view","payments:view","student:view","student:view:detail","student:edit:own",
                "matches:view","media:view","app:settings","app:biometric","app:library","app:videos","app:contact",
            ],
        }
        return DEFAULTS.get(role, DEFAULTS["viewer"])
    except Exception:
        return ["app:settings","app:biometric"]
    finally:
        conn.close()


def get_linked_student_ids(user_id: int, conn) -> list:
    """
    Returns student IDs accessible to this user.
    Priority:
    1. user_student_links table (new PBAC)
    2. users.student_id column
    3. students.user_id column
    4. Derive from username pattern QCA-NNNN
    """
    # 1. Try user_student_links
    try:
        rows = conn.execute(
            "SELECT student_id FROM user_student_links WHERE user_id = ?",
            (user_id,)
        ).fetchall()
        if rows:
            return [r["student_id"] for r in rows]
    except Exception:
        pass

    # 2. Try users.student_id column
    try:
        row = conn.execute(
            "SELECT student_id, username FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if row:
            if row["student_id"]:
                return [row["student_id"]]
            # 3. Derive from username: QCA-1058 → student_id 1058
            username = row["username"] or ""
            if username.upper().startswith("QCA-"):
                try:
                    sid = int(username[4:])
                    # Verify student exists
                    exists = conn.execute(
                        "SELECT id FROM students WHERE id = ?", (sid,)
                    ).fetchone()
                    if exists:
                        # Auto-fix: save to users.student_id for next time
                        try:
                            conn.execute(
                                "UPDATE users SET student_id=? WHERE id=?",
                                (sid, user_id)
                            )
                            conn.commit()
                        except Exception:
                            pass
                        return [sid]
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass

    # 4. Legacy: students.user_id
    try:
        rows = conn.execute(
            "SELECT id FROM students WHERE user_id = ?", (user_id,)
        ).fetchall()
        return [r["id"] for r in rows]
    except Exception:
        return []


def get_user_context(username: str) -> dict:
    """
    Full user context for data isolation.
    Returns dict with:
      user_id, user_type, role, permissions,
      linked_student_ids, is_restricted
    """
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT id, username, role, role_id, user_type "
            "FROM users WHERE lower(username)=lower(?) AND is_active=1 LIMIT 1",
            (username,)
        ).fetchone()
        if not row:
            return {
                "user_id": 0, "user_type": "staff", "role": "viewer",
                "permissions": [], "linked_student_ids": [], "is_restricted": False,
            }

        user_id   = row["id"]
        # user_type — read from column, fall back to deriving from role text
        try:
            user_type = row["user_type"] or "staff"
        except Exception:
            user_type = "staff"
        # If user_type is missing/wrong, derive from role text
        role_text = (row["role"] or "").lower().strip()
        if not user_type or user_type == "staff":
            if role_text == "student":
                user_type = "student"
            elif role_text == "parent":
                user_type = "parent"

        is_restricted = user_type in ("student", "parent")
        linked = get_linked_student_ids(user_id, conn) if is_restricted else []
        permissions = get_user_permissions(username)

        return {
            "user_id":            user_id,
            "user_type":          user_type,
            "role":               row["role"] or "viewer",
            "permissions":        permissions,
            "linked_student_ids": linked,
            "is_restricted":      is_restricted,
        }
    except Exception as exc:
        logger.error("xxgs_ [get_user_context] error: %s", exc)
        return {
            "user_id": 0, "user_type": "staff", "role": "viewer",
            "permissions": [], "linked_student_ids": [], "is_restricted": False,
        }
    finally:
        conn.close()


def apply_student_filter(query: str, params: list, ctx: dict,
                          alias: str = "") -> tuple:
    """
    Applies student data isolation filter to a SQL query.

    If user is restricted (student/parent), adds
    WHERE student_id IN (linked_ids) or WHERE id IN (linked_ids)

    Returns (modified_query, modified_params) or raises 403 if no linked students.
    """
    if not ctx["is_restricted"]:
        return query, params   # staff sees everything

    linked = ctx["linked_student_ids"]
    if not linked:
        # Restricted user with no linked students — return empty result signal
        return None, []   # caller should return empty response

    col = f"{alias}.student_id" if alias else "student_id"
    placeholders = ",".join("?" * len(linked))
    where_clause = f"{col} IN ({placeholders})"

    if "WHERE" in query.upper():
        query = query + f" AND {where_clause}"
    else:
        query = query + f" WHERE {where_clause}"

    return query, list(params) + linked


def require_permission(auth_user: str, slug: str):
    """Raises 403 JSON response if user lacks a specific permission slug."""
    perms = get_user_permissions(auth_user)
    if slug not in perms:
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: {slug} required"
        )

def require_write_role(auth_user: str):
    """Raises 403 if user is viewer. Call at start of any write endpoint."""
    role = get_user_role(auth_user)
    if role == 'viewer':
        raise HTTPException(status_code=403,
            detail="Your role (Viewer) does not have write access")
    return role


# ── Admin: clear rate limit for a user (debugging only) ──────────────────────
@router.post("/admin/clear-rate-limit")
async def api_clear_rate_limit(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Clear rate limit block for a username. Admin only."""
    require_permission(auth_user, "sync:runall")
    try:
        body     = await request.json()
        username = body.get("username", "").strip()
        ip_addr  = body.get("ip", "").strip()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    cleared = 0
    for key in list(_rate_store.keys()):
        if (username and username.lower() in key) or (ip_addr and ip_addr in key):
            _rate_store[key] = {"ts": [], "blocked_until": None}
            cleared += 1
            logger.info("xxgs_ [AUTH] rate limit cleared for key=%s by admin=%s", key, auth_user)

    return JSONResponse({"status": "success", "cleared_keys": cleared})

# ══════════════════════════════════════════════════════════════════════
# SCHEMA MIGRATION HELPER
# ──────────────────────────────────────────────────────────────────────
# Adds the uploaded_by column to temp_attendance if it doesn't exist.
# Also ensures permanent attendance table has the uploaded_by column.
# Called once at startup (or lazily on first upload).
# Safe to call multiple times — ALTER TABLE is skipped if column exists.
# ══════════════════════════════════════════════════════════════════════
def _ensure_uploaded_by_column() -> None:
    """
    Add uploaded_by TEXT column to temp_attendance and attendance if not already present.

    This column records which coach uploaded each row, enabling per-coach
    refresh: when a coach re-uploads a date+session, we delete ONLY their
    previous rows (uploaded_by = coach) before inserting fresh ones.
    Other coaches' rows for the same date+session are completely untouched.
    """
    conn = get_db_connection()
    try:
        # Check existing columns
        # temp_attendance migration
        cols = conn.execute("PRAGMA table_info(temp_attendance)").fetchall()
        col_names = [c[1] for c in cols]
        if "uploaded_by" not in col_names:
            conn.execute("ALTER TABLE temp_attendance ADD COLUMN uploaded_by TEXT")
            conn.commit()
            logger.info("xxgs_ [MIGRATION] Added uploaded_by column to temp_attendance")

        # attendance table — ensure uploaded_by column exists
        att_cols = [c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()]
        if "uploaded_by" not in att_cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN uploaded_by TEXT")
            conn.commit()
            logger.info("xxgs_ [MIGRATION] Added uploaded_by column to attendance")
    except Exception as exc:
        logger.error("xxgs_ [MIGRATION] Failed to add uploaded_by column: %s", exc)
    finally:
        conn.close()

# Run migration on module load
_ensure_uploaded_by_column()


# ══════════════════════════════════════════════════════════════════════
# GET /api/data/ping
# ══════════════════════════════════════════════════════════════════════
@router.options("/ping")
async def api_ping_preflight(request: Request):
    return JSONResponse(content="ok")

@router.get("/ping")
async def api_ping(request: Request, auth_user: str = Depends(verify_api_auth)):
    role = get_user_role(auth_user)
    ctx = get_user_context(auth_user)
    # Email/WA config status from .env — never expose raw keys
    def _mask(e: str) -> str:
        if not e or "@" not in e: return e[:3] + "***" if e else ""
        loc, dom = e.split("@", 1)
        return loc[:3] + "***@" + dom

    # Email: Zoho primary (ZOHO_EMAIL configured) OR Resend fallback
    _zoho_email  = os.getenv("ZOHO_EMAIL",    "").strip()
    _zoho_pass   = os.getenv("ZOHO_PASSWORD", "").strip()
    _resend_key  = os.getenv("RESEND_API_KEY","").strip()
    zoho_ok   = bool(_zoho_email)  # Zoho primary
    resend_ok = bool(_resend_key)  # Resend fallback
    wa_ok     = bool(os.getenv("META_WA_TOKEN","").strip() and os.getenv("META_WA_PHONE_ID","").strip())

    return JSONResponse(content={
        "status":             "ok",
        "authenticated_as":   auth_user,
        "role":               ctx["role"],
        "user_type":          ctx["user_type"],
        "user_id":            ctx["user_id"],
        "permissions":        ctx["permissions"],
        "linked_student_ids": ctx["linked_student_ids"],
        "is_restricted":      ctx["is_restricted"],
        "server_time":        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "email_config": {
            "channel": "zoho"   if zoho_ok   else
                       "resend" if resend_ok  else "none",
            "enabled": zoho_ok or resend_ok,
        },
        "wa_config": {
            "enabled": wa_ok,
        },
    })


# ══════════════════════════════════════════════════════════════════════
# GET /api/data/students
# ══════════════════════════════════════════════════════════════════════
@router.get("/students")
async def api_get_students(
    request:   Request,
    limit:     int = Query(30_000, ge=1, le=50_000),
    since_id:  int = Query(0,      ge=0),
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "student:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        if since_id > 0:
            rows = conn.execute(
                "SELECT * FROM students WHERE id > ? ORDER BY id ASC LIMIT ?",
                (since_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM students ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        data = [dict(row) for row in rows]
        logger.info(
            "xxgs_ [API] /students — %d records → user='%s' ip=%s since_id=%d",
            len(data), auth_user, _get_ip(request), since_id,
        )
        return JSONResponse(content={
            "status":      "success",
            "count":       len(data),
            "synced_by":   auth_user,
            "since_id":    since_id,
            "data":        data,
            "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })
    except Exception as exc:
        logger.error("xxgs_ [API] /students error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# GET /api/data/hager
# ══════════════════════════════════════════════════════════════════════
@router.get("/hager")
async def api_get_hager(
    request:    Request,
    limit:      int = Query(30_000, ge=1, le=50_000),
    since_id:   int = Query(0,      ge=0),
    student_id: int = Query(None),   # filter for student/parent role
    auth_user:  str = Depends(verify_api_auth),
):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Apply data isolation — student/parent gets own records only
        ctx = get_user_context(auth_user)
        params = []
        where  = []

        if ctx["is_restricted"]:
            # Use server-side linked IDs (authoritative)
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse(content={"status":"success","count":0,"data":[],"since_id":since_id,"server_time":datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
            placeholders = ",".join("?" * len(linked))
            where.append(f"student_id IN ({placeholders})")
            params.extend(linked)
        elif student_id:
            # Staff requesting specific student
            where.append("student_id = ?")
            params.append(student_id)

        if since_id > 0:
            where.append("id > ?")
            params.append(since_id)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        order_sql = "ORDER BY id ASC LIMIT ?" if since_id > 0 else "ORDER BY id DESC LIMIT ?"
        params.append(limit)

        # where_sql and order_sql are built from safe constants only (no user input)
        # params list contains all user-supplied values — fully parameterised
        safe_sql = "SELECT * FROM attendance " + where_sql + " " + order_sql
        rows = conn.execute(safe_sql, params).fetchall()
        data = [dict(row) for row in rows]
        logger.info(
            "xxgs_ [API] /hager — %d records → user='%s' restricted=%s since_id=%d",
            len(data), auth_user, ctx["is_restricted"], since_id,
        )
        return JSONResponse(content={
            "status":      "success",
            "count":       len(data),
            "synced_by":   auth_user,
            "since_id":    since_id,
            "data":        data,
            "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })
    except Exception as exc:
        logger.error("xxgs_ [API] /hager error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# GET /api/data/attendance
# ──────────────────────────────────────────────────────────────────────
# Returns existing rows for a date+session so the client can inspect
# what is already on the server if needed.
# ══════════════════════════════════════════════════════════════════════
@router.get("/attendance")
async def api_get_attendance(
    request:    Request,
    date:       str = Query("",  description="Single date YYYY-MM-DD (legacy)"),
    date_from:  str = Query("",  description="Range start YYYY-MM-DD"),
    date_to:    str = Query("",  description="Range end  YYYY-MM-DD"),
    session:    str = Query("",  description="Morning or Evening — blank = all"),
    student_id: int = Query(0,   description="Filter by student ID (0 = all)"),
    auth_user:  str = Depends(verify_api_auth),
):
    """
    Returns attendance records from the PERMANENT `attendance` table.
    Supports single date (legacy) or date range (date_from / date_to).
    Maps server column names → mobile-compatible format:
      attendance_date → date
      session_type    → session
      status(Present/Absent text) → status(1/0 integer)
    """
    require_permission(auth_user, "attendance:view")

    # Resolve date range — support single date (legacy) and range
    d_from = date_from.strip() or date.strip()
    d_to   = date_to.strip()   or date.strip()
    if not d_from:
        return JSONResponse(
            content={"error": "date or date_from is required"},
            status_code=400,
        )

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        ctx = get_user_context(auth_user)
        where, params = [], []

        # Detect column names at runtime
        _att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        _date_col    = "attendance_date" if "attendance_date" in _att_cols else "date"
        _session_col = "session_type"    if "session_type"    in _att_cols else "session"

        # Date filter
        if d_from == d_to:
            where.append(f"{_date_col} = ?")
            params.append(d_from)
        else:
            where.append(f"{_date_col} BETWEEN ? AND ?")
            params.extend([d_from, d_to])

        # Session filter (optional)
        if session.strip():
            where.append(f"{_session_col} = ?")
            params.append(session.strip())

        # Data isolation — restricted users see only their students
        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse(content={
                    "status": "success", "count": 0, "data": []
                })
            placeholders = ",".join("?" * len(linked))
            where.append(f"student_id IN ({placeholders})")
            params.extend(linked)
        elif student_id > 0:
            where.append("student_id = ?")
            params.append(student_id)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        # Detect column names — table may use date/session or attendance_date/session_type
        att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"

        rows = conn.execute(
            f"""SELECT student_id,
                       {date_col}    AS date,
                       {session_col} AS session,
                       CASE WHEN status IN ('Present','PRESENT','1') THEN 1 ELSE 0 END AS status,
                       uploaded_by
                FROM attendance
                {where_sql}
                ORDER BY {date_col} DESC, {session_col}, student_id""",
            params,
        ).fetchall()

        data = [dict(row) for row in rows]
        logger.info(
            "xxgs_ [API] /attendance GET (permanent) — %d rows from=%s to=%s session=%s user='%s'",
            len(data), d_from, d_to, session or "all", auth_user,
        )
        return JSONResponse(content={"status": "success", "count": len(data), "data": data})

    except Exception as exc:
        logger.error("xxgs_ [API] /attendance GET error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# POST /api/data/upload/attendance
# ──────────────────────────────────────────────────────────────────────
# Upload strategy — per (date, session) group:
#
#   1. DELETE all rows WHERE uploaded_by = <this_coach>
#                         AND date       = <group_date>
#                         AND session    = <group_session>
#
#      This wipes only THIS coach's previous submission for that
#      date+session so corrections are reflected correctly on re-upload.
#      Other coaches' rows for the same date+session are untouched.
#
#   2. INSERT fresh rows for every student in the group, stamping
#      uploaded_by = <this_coach> on each row.
#
# Natural dedup key: (student_id, date, session, uploaded_by)
# A student can appear in the same date+session from two different
# coaches — that is intentional (two coaches, two batches of students).
# The same student should NOT appear twice from the same coach for the
# same date+session — step 1 guarantees that.
# ══════════════════════════════════════════════════════════════════════
# ── POST /api/data/attendance/delete-records ─────────────────────────────────
@router.post("/attendance/delete-records")
async def api_attendance_delete_records(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """
    Delete specific attendance records — correction page use only.
    Admin / senior coach with attendance:delete permission.
    Deletes from permanent attendance table only (not temp_attendance).
    Full audit log via attendance_corrections table.
    """
    require_permission(auth_user, "attendance:delete")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    date        = str(body.get("date",    "")).strip()
    session     = str(body.get("session", "")).strip()
    student_ids = [int(i) for i in (body.get("student_ids") or []) if str(i).isdigit()]

    if not date or not session:
        return JSONResponse({"error": "date and session required"}, status_code=400)
    if not student_ids:
        return JSONResponse({"error": "student_ids must be non-empty"}, status_code=400)
    if len(student_ids) > 100:
        return JSONResponse({"error": "Maximum 100 deletions per request"}, status_code=400)

    # Non-admin (coach) corrections limited to last 7 days; Admin unrestricted
    role = (get_user_role(auth_user) or "").lower()
    if role != "admin":
        from datetime import datetime as _dt, timedelta as _td
        try:
            cutoff = (_dt.now() - _td(days=6)).strftime("%Y-%m-%d")
            if date < cutoff:
                return JSONResponse(
                    {"error": "Corrections allowed for the last 7 days only. Contact admin for older records."},
                    status_code=403,
                )
        except Exception:
            pass

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Detect column names
        att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"

        # Get names for audit + response
        ph       = ",".join("?" * len(student_ids))
        students = conn.execute(
            f"SELECT id, name FROM students WHERE id IN ({ph})", student_ids
        ).fetchall()
        names = {r["id"]: r["name"] for r in students}

        # Delete from permanent attendance table
        result = conn.execute(
            f"DELETE FROM attendance WHERE {date_col}=? AND {session_col}=? AND student_id IN ({ph})",
            [date, session] + student_ids
        )
        deleted = result.rowcount

        # Audit log
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS attendance_corrections "
                "(id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, "
                "date TEXT, session TEXT, corrected_by TEXT, corrected_at TEXT DEFAULT (CURRENT_TIMESTAMP))"
            )
            for sid in student_ids:
                conn.execute(
                    "INSERT INTO attendance_corrections (student_id, date, session, corrected_by) VALUES (?,?,?,?)",
                    (sid, date, session, auth_user)
                )
        except Exception:
            pass

        conn.commit()

        name_list = ", ".join(names.get(s, str(s)) for s in student_ids)
        logger.info("xxgs_ [ATT-DEL] %s deleted %d records date=%s session=%s students=[%s]",
                    auth_user, deleted, date, session, name_list)

        return JSONResponse({
            "status":   "success",
            "deleted":  deleted,
            "date":     date,
            "session":  session,
            "students": [{"id": s, "name": names.get(s, "")} for s in student_ids],
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [ATT-DEL] error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.post("/upload/attendance")
async def api_upload_attendance(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "attendance:take")
    conn = get_db_connection()
    role = require_write_role(auth_user)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"error": "Invalid JSON format"}, status_code=400)

        attendance_records: list = body.get("temp_attendance", [])

        if not attendance_records:
            logger.warning("xxgs_ [API] Upload with no records by %s", auth_user)
            return JSONResponse(
                content={"error": "Key 'temp_attendance' missing or empty"},
                status_code=400,
            )

        # ── Validate all records up front before touching the DB ──────
        required_keys = {"student_id", "date", "status", "session"}
        for index, record in enumerate(attendance_records):
            missing = required_keys - record.keys()
            if missing:
                return JSONResponse(
                    content={"error": f"Record[{index}] missing fields: {sorted(missing)}"},
                    status_code=400,
                )
            if record["status"] not in ("PRESENT", "ABSENT"):
                return JSONResponse(
                    content={"error": f"Record[{index}] invalid status '{record['status']}' — must be PRESENT or ABSENT"},
                    status_code=400,
                )

        # ── Group records by (date, session) ─────────────────────────
        # Each group is processed as one atomic transaction:
        #   delete coach's old rows → insert fresh rows.
        from collections import defaultdict
        groups: dict = defaultdict(list)
        for record in attendance_records:
            key = (record["date"], record["session"])
            groups[key].append(record)

        cursor   = conn.cursor()
        inserted = 0
        deleted  = 0

        for (group_date, group_session), group_records in groups.items():

            # Step 1 — delete ONLY this coach's previous rows for this date+session
            result = cursor.execute(
                """
                DELETE FROM temp_attendance
                WHERE  uploaded_by = ?
                  AND  date        = ?
                  AND  session     = ?
                """,
                (auth_user, group_date, group_session),
            )
            rows_deleted = result.rowcount
            deleted += rows_deleted

            # Also clear from permanent attendance table (re-upload = fresh data)
            try:
                att_cols    = {c[1] for c in cursor.execute("PRAGMA table_info(attendance)").fetchall()}
                date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
                session_col = "session_type"    if "session_type"    in att_cols else "session"
                cursor.execute(
                    f"DELETE FROM attendance WHERE uploaded_by=? AND {date_col}=? AND {session_col}=?",
                    (auth_user, group_date, group_session),
                )
            except Exception:
                pass

            if rows_deleted:
                logger.info(
                    "xxgs_ [UPLOAD] Cleared %d old row(s) for coach='%s' date=%s session=%s",
                    rows_deleted, auth_user, group_date, group_session,
                )

            # Step 2 — insert into temp_attendance (staging, backward compat with web)
            # AND upsert into permanent attendance table simultaneously
            for record in group_records:
                status_text = record["status"]   # "PRESENT" or "ABSENT"
                status_int  = 1 if status_text == "PRESENT" else 0

                # Write to temp_attendance (web app staging — backward compat)
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO temp_attendance (student_id, date, status, session, uploaded_by)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        record["student_id"],
                        record["date"],
                        record["status"],
                        record["session"],
                        auth_user,
                    ),
                )

                # Write to permanent attendance table (source of truth for mobile)
                # Detect column names at runtime — table may use date/session or attendance_date/session_type
                status_word = "Present" if record["status"] == "PRESENT" else "Absent"
                try:
                    att_cols = {c[1] for c in cursor.execute("PRAGMA table_info(attendance)").fetchall()}
                    date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
                    session_col = "session_type"    if "session_type"    in att_cols else "session"
                    status_val  = status_word if "attendance_date" in att_cols else record["status"]

                    # INSERT OR IGNORE — first mark wins per student+date+session
                    # Prevents duplicates from multi-device/multi-coach uploads
                    # Same student marked twice → second is silently ignored
                    try:
                        cursor.execute(
                            f"""INSERT OR IGNORE INTO attendance
                                    (student_id, {date_col}, {session_col}, status, uploaded_by)
                                VALUES (?, ?, ?, ?, ?)""",
                            (record["student_id"], record["date"],
                             record["session"], status_val, auth_user),
                        )
                    except Exception as att_e:
                        logger.warning("xxgs_ [UPLOAD] attendance write failed: %s", att_e)
                except Exception as att_err2:
                    logger.warning("xxgs_ [UPLOAD] attendance table write failed: %s", att_err2)

                inserted += 1

        conn.commit()

        logger.info(
            "xxgs_ [UPLOAD] coach='%s' — deleted %d old, inserted %d fresh across %d group(s)",
            auth_user, deleted, inserted, len(groups),
        )

        return JSONResponse(content={
            "status":    "success",
            "inserted":  inserted,
            "replaced":  deleted,
            "groups":    len(groups),
            "synced_by": auth_user,
        })

    except Exception as exc:
        if conn:
            conn.rollback()
        logger.error("xxgs_ [ERROR] Attendance upload failed: %s", exc)
        traceback.print_exc()
        return JSONResponse(
            content={"error": "Internal server error during sync"},
            status_code=500,
        )
    finally:
        if conn:
            conn.close()

# ══════════════════════════════════════════════════════════════════════
# GET /api/data/fee-categories
# ──────────────────────────────────────────────────────────────────────
# Returns all INCOME account_categories so the mobile can label fee
# types (e.g. "Academy Fee", "Kit Fee") without a separate lookup table.
# Only INCOME categories are relevant for student payment history.
# Excludes is_gl_only = 1 (internal ledger categories, not shown to coaches).
#
# Response:
#   {
#     "status": "success",
#     "count": 3,
#     "data": [
#       { "id": 1, "name": "Academy Fee", "txn_type": "INCOME", "description": "..." },
#       ...
#     ]
#   }
# ══════════════════════════════════════════════════════════════════════
@router.get("/fee-categories")
async def api_get_fee_categories(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "student:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, name, txn_type, description
            FROM   account_categories
            WHERE  txn_type    = 'INCOME'
              AND  is_gl_only  = 0
            ORDER  BY name ASC
            """
        ).fetchall()
        data = [dict(row) for row in rows]
        logger.info(
            "xxgs_ [API] /fee-categories — %d categories → user='%s'",
            len(data), auth_user,
        )
        return JSONResponse(content={
            "status": "success",
            "count":  len(data),
            "data":   data,
        })
    except Exception as exc:
        logger.error("xxgs_ [API] /fee-categories error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# PAYMENT SQL
# ──────────────────────────────────────────────────────────────────────
# payments.fee_type_id → account_categories.id
# account_categories.name is the fee label (e.g. "Academy Fee").
# fee_lookup is NOT used.
# ══════════════════════════════════════════════════════════════════════

_PAYMENTS_SQL = """
    SELECT
        p.id,
        p.student_id,
        s.name                                                  AS student_name,
        p.fee_type_id,
        COALESCE(ac.name, CAST(p.fee_type_id AS TEXT))         AS fee_type_name,
        COALESCE(ac.txn_type, 'INCOME')                        AS txn_type,
        p.amount_paid,
        p.payment_date,
        p.payment_mode,
        p.receipt_no,
        p.billing_month,
        p.remarks,
        p.status,
        p.txn_direction,
        p.is_posted,
        p.account_id
    FROM payments p
    JOIN      students          s  ON s.id  = p.student_id
    LEFT JOIN account_categories ac ON ac.id = p.fee_type_id
    WHERE 1=1
"""


# ══════════════════════════════════════════════════════════════════════
# BILLING MONTH NORMALISER
# ──────────────────────────────────────────────────────────────────────
# billing_month in the DB is stored as "Aug-25" (Mon-YY) for fee_type
# 1 & 2, and possibly "Aug-2025" or "2025-08" for others.
# We normalise everything to YYYY-MM so due-month comparison works.
# ══════════════════════════════════════════════════════════════════════

import re as _re

_MONTH_MAP = {
    'jan':'01','feb':'02','mar':'03','apr':'04','may':'05','jun':'06',
    'jul':'07','aug':'08','sep':'09','oct':'10','nov':'11','dec':'12',
}

def _norm_billing_month(bm) -> str | None:
    """Normalise any billing_month format to YYYY-MM. Returns None on failure."""
    if not bm:
        return None
    bm = str(bm).strip()

    # Already YYYY-MM or YYYY-MM-DD
    if _re.match(r'^\d{4}-\d{2}', bm):
        return bm[:7]

    # Mon-YY  →  2025-08
    m = _re.match(r'^([A-Za-z]{3})-(\d{2})$', bm)
    if m:
        mon, yy = m.group(1).lower(), int(m.group(2))
        year = 2000 + yy if yy < 50 else 1900 + yy
        return f"{year}-{_MONTH_MAP.get(mon, '??')}"

    # Mon-YYYY  →  2025-08
    m = _re.match(r'^([A-Za-z]{3})-(\d{4})$', bm)
    if m:
        return f"{m.group(2)}-{_MONTH_MAP.get(m.group(1).lower(), '??')}"

    # Month YYYY  →  2025-08
    m = _re.match(r'^([A-Za-z]+)\s+(\d{4})$', bm)
    if m:
        return f"{m.group(2)}-{_MONTH_MAP.get(m.group(1)[:3].lower(), '??')}"

    return None


def _fmt_billing_display(bm) -> str:
    """Return a human-readable label e.g. 'Aug 2025' from any billing_month format."""
    canonical = _norm_billing_month(bm)
    if not canonical or '??' in canonical:
        return str(bm) if bm else '—'
    try:
        y, m = canonical.split('-')
        mon_names = ['Jan','Feb','Mar','Apr','May','Jun',
                     'Jul','Aug','Sep','Oct','Nov','Dec']
        return f"{mon_names[int(m)-1]} {y}"
    except Exception:
        return str(bm)


# ══════════════════════════════════════════════════════════════════════
# GET /api/data/payments
# ══════════════════════════════════════════════════════════════════════
@router.get("/payments")
async def api_get_payments(
    request:    Request,
    student_id: int  = Query(0,      ge=0,     description="Filter by student (0 = all)"),
    since_id:   int  = Query(0,      ge=0,     description="Incremental: payment id > this"),
    limit:      int  = Query(10_000, ge=1, le=50_000),
    auth_user:  str  = Depends(verify_api_auth),
):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        base_sql = _PAYMENTS_SQL
        params: list = []

        # Data isolation — student/parent sees only own/linked payments
        ctx = get_user_context(auth_user)
        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse(content={"status":"success","count":0,"data":[]})
            ph = ",".join("?" * len(linked))
            base_sql += f" AND p.student_id IN ({ph})"
            params.extend(linked)
        elif student_id > 0:
            base_sql += " AND p.student_id = ?"
            params.append(student_id)

        if since_id > 0:
            base_sql += " AND p.id > ?"
            params.append(since_id)

        base_sql += " ORDER BY p.id ASC LIMIT ?"
        params.append(limit)

        rows = conn.execute(base_sql, params).fetchall()
        data = []
        for row in rows:
            r = dict(row)
            # Add canonical YYYY-MM version so client never needs to parse formats
            r['billing_month_canonical'] = _norm_billing_month(r.get('billing_month'))
            r['billing_month_display']   = _fmt_billing_display(r.get('billing_month'))
            data.append(r)

        # ── Per-student summary + months-due calculation ──────────────
        # IMPORTANT:
        #   Only fee_type_id IN (1, 2, 15) are recurring academy fees.
        #   All other fee_type_ids are one-off purchases (kit, equipment etc.)
        #   and must NOT count as paid months or affect dues.
        #   due months are calculated from enrollment_date, not first payment.
        from collections import defaultdict
        from datetime import date as _date

        FEE_TYPE_IDS = {1, 2, 15}  # recurring academy fee types only

        student_payments: dict = defaultdict(list)
        for row in data:
            student_payments[row["student_id"]].append(row)

        # Fetch enrollment dates for all students that have payments
        student_ids_in_data = list(student_payments.keys())
        summary: dict = {}

        # Always compute summary for ALL active students — not just those in
        # current response. This ensures incremental sync still returns fresh
        # due counts even when no new payments exist for a student.
        all_active_rows = conn.execute(
            """SELECT id, name, enrollment_date, monthly_fee, status
                FROM students
                WHERE status NOT IN ('Terminated','Inactive')
                ORDER BY id"""
        ).fetchall()
        # Merge: prioritise all active students, but also include any in data
        seen_ids = set()
        merged_stu_rows = []
        for r in all_active_rows:
            seen_ids.add(r["id"])
            merged_stu_rows.append(r)
        # Add any students in data not already included (e.g. Inactive with payments)
        if student_ids_in_data:
            extra_ids = [i for i in student_ids_in_data if i not in seen_ids]
            if extra_ids:
                ph = ",".join("?" * len(extra_ids))
                extras = conn.execute(
                    "SELECT id, name, enrollment_date, monthly_fee, status FROM students WHERE id IN (" + ph + ")",
                    extra_ids
                ).fetchall()
                merged_stu_rows.extend(extras)

        if merged_stu_rows:
            placeholders = ",".join("?" * len(merged_stu_rows))
            stu_rows = merged_stu_rows

            today = _date.today()

            for stu in stu_rows:
                # Club Members pay no fees — exclude from due calculation entirely
                if (stu["status"] or '').strip() in ('Club Member', 'Inactive'):
                    summary[str(stu["id"])] = {
                        "student_id":        stu["id"],
                        "student_name":      stu["name"],
                        "enrollment_date":   stu["enrollment_date"],
                        "monthly_fee":       0,
                        "total_paid":        0,
                        "total_purchases":   0,
                        "last_payment_date": None,
                        "paid_months":       [],
                        "due_months":        [],
                        "months_due_count":  0,
                    }
                    continue

                sid         = stu["id"]
                sname       = stu["name"]
                enrollment  = stu["enrollment_date"]   # "YYYY-MM-DD" or None
                monthly_fee = stu["monthly_fee"] or 0.0

                # CRITICAL FIX: Always fetch ALL payments for this student from DB
                # using actual payments table columns only — no joins needed for dues calc
                all_pmts_rows = conn.execute(
                    """SELECT p.id, p.student_id, p.fee_type_id, p.amount_paid,
                              p.payment_date, p.billing_month, p.status,
                              p.txn_direction,
                              COALESCE(ac.txn_type, 'INCOME') AS cat_txn_type
                        FROM payments p
                        LEFT JOIN account_categories ac ON ac.id = p.fee_type_id
                        WHERE p.student_id = ?
                          AND COALESCE(p.status, 'Paid') != 'Cancelled'
                        ORDER BY p.billing_month""",
                    (sid,)
                ).fetchall()
                pmts = [dict(r) for r in all_pmts_rows]

                # Split: fee payments (count toward paid months) vs purchases (don't)
                # account_categories.txn_type='INCOME' via fee_type_id is authoritative.
                # fee_type_id IN (1,2,15,16) kept as fallback for legacy records.
                def _is_fee(p: dict) -> bool:
                    # Prefer category join result
                    cat_type = p.get("cat_txn_type") or ""
                    if cat_type == "INCOME":
                        return True
                    if cat_type == "EXPENSE":
                        return False
                    # Fallback: known recurring fee_type_ids
                    return (p.get("fee_type_id") or 0) in FEE_TYPE_IDS

                fee_pmts      = [p for p in pmts if _is_fee(p)]
                purchase_pmts = [p for p in pmts if not _is_fee(p)]

                # paid_months — normalise billing_month to YYYY-MM
                # billing_month stored as 'Aug-25' or 'YYYY-MM' or 'YYYY-MM-DD'
                paid_months = sorted(set(
                    nm
                    for p in fee_pmts
                    for nm in [_norm_billing_month(p.get("billing_month"))]
                    if nm and '??' not in nm
                ))

                # total_paid — only recurring fees (exclude kit/equipment purchases)
                total_paid = sum(p["amount_paid"] or 0 for p in fee_pmts)

                # total_purchases — informational: what they spent on kit/equipment
                total_purchases = sum(p["amount_paid"] or 0 for p in purchase_pmts)

                # last payment date across ALL payment types
                last_pmt_date = max(
                    (p["payment_date"] for p in pmts if p["payment_date"]),
                    default=None,
                )

                # due_months — months from enrollment up to LAST MONTH inclusive
                # (current month is never due — it's ongoing)
                # Example: today=May-16-2026 → end=(2026,05) → loop ends Apr-2026
                # If paid through May-26, Apr must be in paid_months → 0 dues
                due_months: list = []
                if enrollment:
                    try:
                        enroll_date  = _date.fromisoformat(enrollment[:10])
                        y, m         = enroll_date.year, enroll_date.month
                        # End = current month (exclusive) — student needn't pay May until month ends
                        end_y, end_m = today.year, today.month
                        expected: list = []
                        while (y, m) < (end_y, end_m):
                            expected.append(f"{y}-{m:02d}")
                            m += 1
                            if m > 12:
                                m = 1
                                y += 1
                        paid_set   = set(paid_months)
                        due_months = [mo for mo in expected if mo not in paid_set]
                        logger.debug(
                            "xxgs_ [DUES] student=%s enrollment=%s paid=%s expected_last=%s due=%s",
                            sid, enrollment,
                            paid_months[-3:] if paid_months else [],
                            expected[-1] if expected else 'none',
                            due_months
                        )
                    except (ValueError, TypeError) as ex:
                        logger.warning("xxgs_ [DUES] parse error student=%s: %s", sid, ex)
                        due_months = []

                summary[str(sid)] = {
                    "student_id":        sid,
                    "student_name":      sname,
                    "enrollment_date":   enrollment,
                    "monthly_fee":       monthly_fee,
                    "total_paid":        round(total_paid, 2),
                    "total_purchases":   round(total_purchases, 2),
                    "last_payment_date": last_pmt_date,
                    "paid_months":       paid_months,
                    "due_months":        due_months,
                    "months_due_count":  len(due_months),
                }

        logger.info(
            "xxgs_ [API] /payments — %d rows, %d students → user='%s' ip=%s since_id=%d",
            len(data), len(summary), auth_user, _get_ip(request), since_id,
        )

        return JSONResponse(content={
            "status":      "success",
            "count":       len(data),
            "data":        data,
            "summary":     summary,
            "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

    except Exception as exc:
        logger.error("xxgs_ [API] /payments error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# MOBILE MEDIA API  —  /api/data/media/*
# ──────────────────────────────────────────────────────────────────────
# Three-step flow matching the mobile app's foreground-only sync:
#
#   Step 1  POST /api/data/media/init
#           → Returns a Cloudinary upload signature so the mobile app
#             can upload directly to Cloudinary without exposing the
#             API secret. The server signs the upload params.
#
#   Step 2  Mobile app uploads file directly to Cloudinary
#           (no server bandwidth used)
#
#   Step 3  POST /api/data/media/save
#           → Mobile sends { cloudinary_public_id, secure_url,
#             resource_type, student_ids, tag_type, coach_note,
#             session_type, attendance_date }
#           → Server inserts into academy_media + media_tags
#             (same tables the webapp uses — fully compatible)
#
#   GET /api/data/media/student/{student_id}
#           → Student media gallery for the mobile app
#
# Resume safety: if Step 3 fails after Step 2 succeeded, the mobile
# retries Step 3 only (it stores cloudinary_public_id + secure_url
# locally, so it never re-uploads to Cloudinary).
# ══════════════════════════════════════════════════════════════════════

import hashlib
import hmac as _hmac_mod
import time as _time_mod


# ── Cloudinary config (same .env vars as pic_tag_upload.py) ──────────
_CLD_CLOUD  = os.getenv("CLOUDINARY_CLOUD_NAME", "")
_CLD_KEY    = os.getenv("CLOUDINARY_API_KEY",    "")
_CLD_SECRET = os.getenv("CLOUDINARY_API_SECRET", "")


def _cld_ok() -> bool:
    return bool(_CLD_CLOUD and _CLD_KEY and _CLD_SECRET)


def _cld_sign(params: dict) -> str:
    """
    Cloudinary upload signature.
    Concatenate sorted key=value pairs (excluding api_key, file, cloud_name)
    then SHA-1 with API_SECRET.
    """
    exclude = {"api_key", "file", "resource_type", "cloud_name"}
    s = "&".join(f"{k}={v}" for k, v in sorted(params.items()) if k not in exclude)
    s += _CLD_SECRET
    return hashlib.sha1(s.encode()).hexdigest()


# ─────────────────────────────────────────────────────────────────────
# POST /api/data/media/init
# ─────────────────────────────────────────────────────────────────────
# Returns a signed upload payload so the mobile app can POST directly
# to Cloudinary's upload endpoint without any server bandwidth.
#
# Request body (JSON):
#   { "resource_type": "image" | "video" }
#
# Response:
#   {
#     "upload_url":    "https://api.cloudinary.com/v1_1/<cloud>/image/upload",
#     "api_key":       "...",
#     "timestamp":     1234567890,
#     "folder":        "qca_mobile",
#     "signature":     "sha1hex...",
#     "eager":         "c_scale,w_1280,q_80"   (for images — resize on Cloudinary)
#   }
# ─────────────────────────────────────────────────────────────────────
@router.post("/media/init")
async def api_media_init(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "media:upload")
    if not _cld_ok():
        return JSONResponse(
            content={"error": "Cloudinary not configured on server"},
            status_code=503,
        )

    role = require_write_role(auth_user)
    try:
        body          = await request.json()
        resource_type = body.get("resource_type", "image")  # "image" or "video"
    except Exception:
        resource_type = "image"

    if resource_type not in ("image", "video"):
        return JSONResponse(content={"error": "resource_type must be 'image' or 'video'"}, status_code=400)

    ts     = int(_time_mod.time())
    folder = "qca_mobile"

    # Params to sign (must match what mobile sends to Cloudinary)
    # Sign only folder + timestamp — keep it minimal to avoid signature mismatch.
    # Client-side compression already handles photo resize (canvas, 75% JPEG).
    # Do NOT include eager here — it must be excluded from signature OR included
    # in BOTH signature and upload FormData consistently.
    sign_params: dict = {
        "folder":    folder,
        "timestamp": ts,
    }

    signature = _cld_sign(sign_params)

    upload_url = f"https://api.cloudinary.com/v1_1/{_CLD_CLOUD}/{resource_type}/upload"

    logger.info(
        "xxgs_ [MEDIA] init upload — resource=%s user='%s' ip=%s",
        resource_type, auth_user, _get_ip(request),
    )

    return JSONResponse(content={
        "upload_url":    upload_url,
        "api_key":       _CLD_KEY,
        "timestamp":     ts,
        "folder":        folder,
        "signature":     signature,
        "resource_type": resource_type,
    })


# ─────────────────────────────────────────────────────────────────────
# POST /api/data/media/save
# ─────────────────────────────────────────────────────────────────────
# Called AFTER mobile has successfully uploaded to Cloudinary.
# Inserts into academy_media + media_tags (same schema as webapp).
#
# If this call fails (network drop etc.), mobile retries with same
# cloudinary_public_id — the server is idempotent on public_id.
#
# Request body (JSON):
#   {
#     "cloudinary_public_id": "qca_mobile/abc123",
#     "secure_url":           "https://res.cloudinary.com/...",
#     "resource_type":        "image" | "video",
#     "student_ids":          [1046, 1058],   -- required, at least 1
#     "tag_type":             "Training" | "Match" | "Event" | "Other",
#     "coach_note":           "Great drive!",
#     "session_type":         "Morning",      -- optional, from attendance context
#     "attendance_date":      "2026-05-03"    -- optional
#   }
#
# Response:
#   { "status": "success", "media_id": 42, "tags_inserted": 2 }
# ─────────────────────────────────────────────────────────────────────
@router.post("/media/save")
async def api_media_save(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    role = require_write_role(auth_user)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON"}, status_code=400)

    public_id     = (body.get("cloudinary_public_id") or "").strip()
    secure_url    = (body.get("secure_url")           or "").strip()
    resource_type = (body.get("resource_type")        or "image").strip()
    student_ids   = body.get("student_ids",  [])
    tag_type      = (body.get("tag_type")             or "Training").strip()
    coach_note    = (body.get("coach_note")           or "").strip()
    session_type  = (body.get("session_type")         or "").strip()
    att_date      = (body.get("attendance_date")      or "").strip()

    # Validate
    if not public_id:
        return JSONResponse(content={"error": "cloudinary_public_id required"}, status_code=400)
    if not secure_url:
        return JSONResponse(content={"error": "secure_url required"}, status_code=400)
    if not student_ids or not isinstance(student_ids, list):
        return JSONResponse(content={"error": "student_ids must be a non-empty list"}, status_code=400)

    try:
        id_list = [int(i) for i in student_ids]
    except (ValueError, TypeError):
        return JSONResponse(content={"error": "student_ids must be integers"}, status_code=400)

    file_type = "Video" if resource_type == "video" else "Photo"
    description = coach_note
    if session_type or att_date:
        extra = " | ".join(filter(None, [att_date, session_type]))
        description = f"{coach_note} [{extra}]".strip(" |") if coach_note else f"[{extra}]"

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # ── Idempotency: check if this public_id already saved ────
        # (handles retry when save call failed after Cloudinary upload succeeded)
        existing = conn.execute(
            "SELECT media_id FROM academy_media WHERE drive_file_id = ?",
            (secure_url,),
        ).fetchone()

        if existing:
            media_id = existing["media_id"]
            logger.info(
                "xxgs_ [MEDIA] save — idempotent hit media_id=%d public_id=%s",
                media_id, public_id,
            )
        else:
            conn.execute(
                "INSERT INTO academy_media (drive_file_id, file_type, description) VALUES (?,?,?)",
                (secure_url, file_type, description),
            )
            media_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        # ── Tag students (skip already-tagged to be idempotent) ───
        tags_inserted = 0
        for sid in id_list:
            already = conn.execute(
                "SELECT 1 FROM media_tags WHERE media_id=? AND student_id=?",
                (media_id, sid),
            ).fetchone()
            if not already:
                conn.execute(
                    "INSERT INTO media_tags (media_id, student_id, coach_note, tag_type) VALUES (?,?,?,?)",
                    (media_id, sid, coach_note, tag_type),
                )
                tags_inserted += 1

        conn.commit()

        logger.info(
            "xxgs_ [MEDIA] saved — media_id=%d file_type=%s students=%s tags_new=%d user='%s'",
            media_id, file_type, id_list, tags_inserted, auth_user,
        )

        return JSONResponse(content={
            "status":        "success",
            "media_id":      media_id,
            "tags_inserted": tags_inserted,
        })

    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [MEDIA] save error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────
# GET /api/data/media/student/{student_id}
# ─────────────────────────────────────────────────────────────────────
# Returns the media gallery for a student — photos and videos tagged
# to them, newest first.
#
# Response:
#   {
#     "status": "success",
#     "student_id": 1046,
#     "count": 12,
#     "data": [
#       {
#         "media_id":   42,
#         "secure_url": "https://res.cloudinary.com/...",
#         "file_type":  "Photo" | "Video",
#         "tag_type":   "Training",
#         "coach_note": "...",
#         "upload_date": "2026-05-03 12:00:00"
#       }, ...
#     ]
#   }
# ─────────────────────────────────────────────────────────────────────
@router.get("/media/student/{student_id}")
async def api_media_student(
    request:    Request,
    student_id: int,
    limit:      int = Query(100, ge=1, le=500),
    auth_user:  str = Depends(verify_api_auth),
):
    require_permission(auth_user, "media:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT m.media_id,
                   m.drive_file_id  AS secure_url,
                   m.file_type,
                   m.upload_date,
                   t.tag_type,
                   t.coach_note
            FROM   academy_media m
            JOIN   media_tags    t ON t.media_id = m.media_id
            WHERE  t.student_id = ?
            ORDER  BY m.media_id DESC
            LIMIT  ?
            """,
            (student_id, limit),
        ).fetchall()

        data = [dict(row) for row in rows]

        logger.info(
            "xxgs_ [MEDIA] gallery — student_id=%d items=%d user='%s'",
            student_id, len(data), auth_user,
        )

        return JSONResponse(content={
            "status":     "success",
            "student_id": student_id,
            "count":      len(data),
            "data":       data,
        })

    except Exception as exc:
        logger.error("xxgs_ [MEDIA] gallery error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()

# ══════════════════════════════════════════════════════════════════════
# GET /api/data/media/list
# ──────────────────────────────────────────────────────────────────────
# List recent uploaded media items with their student tags.
# Used by the mobile History tab to show what's on the server.
#
# Query params:
#   limit    — max items (default 50)
#   offset   — for pagination (default 0)
#
# Response:
#   { "status": "success", "count": N, "data": [
#       { "media_id", "secure_url", "file_type", "upload_date",
#         "description", "students": [{"student_id","name","tag_type","coach_note"}] }
#   ]}
# ══════════════════════════════════════════════════════════════════════
@router.get("/media/list")
async def api_media_list(
    request:    Request,
    limit:      int  = Query(500, ge=1, le=500),
    offset:     int  = Query(0,   ge=0),
    date:       str  = Query("",  max_length=10, description="Single date YYYY-MM-DD (legacy)"),
    date_from:  str  = Query("",  max_length=10, description="Range start YYYY-MM-DD"),
    date_to:    str  = Query("",  max_length=10, description="Range end YYYY-MM-DD"),
    file_type:  str  = Query("",  max_length=10, description="Photo | Video | ''"),
    student_id: int  = Query(0,   ge=0),
    auth_user:  str  = Depends(verify_api_auth),
):
    require_permission(auth_user, "media:view")

    # Resolve date — support legacy single date and new date_from/date_to range
    d_from = date_from.strip() or date.strip()
    d_to   = date_to.strip()   or date.strip()

    if not d_from:
        return JSONResponse(content={
            "status": "error",
            "message": "date_from (or date) is required"
        }, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        ctx = get_user_context(auth_user)

        # Build date clause
        if d_from == d_to or not d_to:
            where  = ["DATE(m.upload_date) = ?"]
            params = [d_from]
        else:
            where  = ["DATE(m.upload_date) BETWEEN ? AND ?"]
            params = [d_from, d_to]

        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse(content={"status":"success","count":0,"data":[]})
            ph = ",".join("?" * len(linked))
            where.append(
                f"m.media_id IN (SELECT media_id FROM media_tags WHERE student_id IN ({ph}))"
            )
            params.extend(linked)
        elif student_id > 0:
            where.append("m.media_id IN (SELECT media_id FROM media_tags WHERE student_id = ?)")
            params.append(student_id)

        if file_type.strip() in ("Photo", "Video"):
            where.append("m.file_type = ?")
            params.append(file_type.strip())

        where_sql = "WHERE " + " AND ".join(where)
        params += [limit, offset]

        media_rows = conn.execute(
            f"""
            SELECT m.media_id, m.drive_file_id AS secure_url,
                   m.file_type, m.upload_date, m.description
            FROM   academy_media m
            {where_sql}
            ORDER  BY m.media_id DESC
            LIMIT  ? OFFSET ?
            """,
            params,
        ).fetchall()

        import re as _re_list

        data = []
        for m in media_rows:
            # Extract Cloudinary public_id from the stored URL so client
            # can pass it back on delete without server-side URL parsing
            sec_url = m["secure_url"] or ""
            cld_pub_id = ""
            if "cloudinary.com" in sec_url:
                _m = _re_list.search(r"/upload/(?:v\d+/)?(.+)\.[^.]+$", sec_url)
                if _m:
                    cld_pub_id = _m.group(1)

            # Fetch all tags for this media item
            tag_rows = conn.execute(
                """
                SELECT t.student_id, s.name, t.tag_type, t.coach_note
                FROM   media_tags t
                LEFT JOIN students s ON s.id = t.student_id
                WHERE  t.media_id = ?
                ORDER  BY s.name ASC
                """,
                (m["media_id"],),
            ).fetchall()

            data.append({
                "media_id":              m["media_id"],
                "secure_url":            m["secure_url"],
                "file_type":             m["file_type"],
                "upload_date":           m["upload_date"],
                "description":           m["description"],
                "cloudinary_public_id":  cld_pub_id,
                "students":              [dict(r) for r in tag_rows],
            })

        logger.info(
            "xxgs_ [MEDIA] list — %d items → user='%s'", len(data), auth_user
        )
        return JSONResponse(content={
            "status": "success",
            "count":  len(data),
            "data":   data,
        })

    except Exception as exc:
        logger.error("xxgs_ [MEDIA] list error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# DELETE /api/data/media/{media_id}
# ──────────────────────────────────────────────────────────────────────
# Delete a media item:
#   1. Fetch the Cloudinary public_id from the secure_url in academy_media
#   2. Delete from Cloudinary (video or image resource type)
#   3. Delete media_tags rows
#   4. Delete academy_media row
#
# Body (optional JSON):
#   { "cloudinary_public_id": "qca_mobile/abc" }   ← if known, skips URL parsing
#
# Response:
#   { "status": "success", "media_id": 42, "cloudinary_deleted": true }
# ══════════════════════════════════════════════════════════════════════
@router.delete("/media/{media_id}")
async def api_media_delete(
    request:  Request,
    media_id: int,
    auth_user: str = Depends(verify_api_auth),
):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    role = require_write_role(auth_user)
    try:
        # Fetch the media record
        row = conn.execute(
            "SELECT media_id, drive_file_id, file_type FROM academy_media WHERE media_id = ?",
            (media_id,),
        ).fetchone()

        if not row:
            return JSONResponse(
                content={"error": f"media_id {media_id} not found"},
                status_code=404,
            )

        secure_url = row["drive_file_id"]
        file_type  = row["file_type"]   # "Photo" or "Video"

        # ── Optional body for explicit public_id ─────────────────
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass

        # ── Step 1: Delete from Cloudinary ────────────────────────
        cloudinary_deleted = False
        import re as _re_cld

        if _cld_ok() and secure_url and "cloudinary.com" in secure_url:
            try:
                import cloudinary
                import cloudinary.uploader
                cloudinary.config(
                    cloud_name = _CLD_CLOUD,
                    api_key    = _CLD_KEY,
                    api_secret = _CLD_SECRET,
                    secure     = True,
                )

                # Get public_id — from body if explicitly provided, else extract from URL.
                # Cloudinary URL format:
                #   https://res.cloudinary.com/<cloud>/<type>/upload/v<ver>/<public_id>.<ext>
                #   https://res.cloudinary.com/<cloud>/<type>/upload/<public_id>.<ext>
                pub_id = (body.get("cloudinary_public_id") or "").strip()

                if not pub_id:
                    # Extract everything between /upload/ (optionally /v<digits>/) and the extension
                    m = _re_cld.search(r"/upload/(?:v\d+/)?(.+)\.[^.]+$", secure_url)
                    if m:
                        pub_id = m.group(1)   # e.g. "qca_mobile/abc123"

                logger.info(
                    "xxgs_ [MEDIA] Cloudinary delete attempt — pub_id=%r file_type=%s secure_url=%s",
                    pub_id, file_type, secure_url,
                )

                if pub_id:
                    resource_type = "video" if file_type == "Video" else "image"
                    result = cloudinary.uploader.destroy(pub_id, resource_type=resource_type)
                    cloudinary_deleted = result.get("result") == "ok"
                    logger.info(
                        "xxgs_ [MEDIA] Cloudinary destroy %s (%s) → result=%s",
                        pub_id, resource_type, result,
                    )
                    # If image delete returns "not found", try as video and vice versa
                    if not cloudinary_deleted and result.get("result") == "not found":
                        alt_type = "video" if resource_type == "image" else "image"
                        result2 = cloudinary.uploader.destroy(pub_id, resource_type=alt_type)
                        cloudinary_deleted = result2.get("result") == "ok"
                        logger.info(
                            "xxgs_ [MEDIA] Cloudinary retry as %s → result=%s",
                            alt_type, result2,
                        )
                else:
                    logger.warning(
                        "xxgs_ [MEDIA] Could not extract public_id from URL: %s", secure_url
                    )
            except Exception as cld_err:
                logger.warning("xxgs_ [MEDIA] Cloudinary delete warning: %s", cld_err)

        # ── Step 2: Delete from DB ────────────────────────────────
        conn.execute("DELETE FROM media_tags    WHERE media_id = ?", (media_id,))
        conn.execute("DELETE FROM academy_media WHERE media_id = ?", (media_id,))
        conn.commit()

        logger.info(
            "xxgs_ [MEDIA] deleted — media_id=%d cld_deleted=%s user='%s'",
            media_id, cloudinary_deleted, auth_user,
        )
        return JSONResponse(content={
            "status":             "success",
            "media_id":           media_id,
            "cloudinary_deleted": cloudinary_deleted,
        })

    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [MEDIA] delete error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# PUT /api/data/media/{media_id}/tags
# ──────────────────────────────────────────────────────────────────────
# Update student tags on an already-uploaded media item.
# Does NOT touch Cloudinary — purely a DB operation.
#
# Supports three operations controlled by "mode":
#   "replace" (default) — wipe all existing tags, insert new ones
#   "add"               — add new student_ids, skip already-tagged
#   "remove"            — remove specific student_ids from tags
#
# Body:
#   {
#     "student_ids": [1046, 1058],
#     "tag_type":    "Training",      ← optional
#     "coach_note":  "Good catch",    ← optional
#     "mode":        "replace"        ← "replace" | "add" | "remove"
#   }
#
# Response:
#   { "status": "success", "media_id": 42,
#     "tags_added": 2, "tags_removed": 1, "tags_total": 3 }
# ══════════════════════════════════════════════════════════════════════
@router.put("/media/{media_id}/tags")
async def api_media_update_tags(
    request:  Request,
    media_id: int,
    auth_user: str = Depends(verify_api_auth),
):
    role = require_write_role(auth_user)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON"}, status_code=400)

    student_ids = body.get("student_ids", [])
    tag_type    = (body.get("tag_type")    or "").strip()
    coach_note  = (body.get("coach_note")  or "").strip()
    mode        = (body.get("mode")        or "replace").strip().lower()

    if mode not in ("replace", "add", "remove"):
        return JSONResponse(
            content={"error": "mode must be 'replace', 'add', or 'remove'"},
            status_code=400,
        )

    try:
        id_list = [int(i) for i in student_ids]
    except (ValueError, TypeError):
        return JSONResponse(content={"error": "student_ids must be integers"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Verify media exists
        exists = conn.execute(
            "SELECT 1 FROM academy_media WHERE media_id = ?", (media_id,)
        ).fetchone()
        if not exists:
            return JSONResponse(
                content={"error": f"media_id {media_id} not found"},
                status_code=404,
            )

        tags_added   = 0
        tags_removed = 0

        if mode == "replace":
            # Wipe all existing tags and insert fresh
            result = conn.execute(
                "DELETE FROM media_tags WHERE media_id = ?", (media_id,)
            )
            tags_removed = result.rowcount
            for sid in id_list:
                conn.execute(
                    "INSERT INTO media_tags (media_id, student_id, coach_note, tag_type) VALUES (?,?,?,?)",
                    (media_id, sid, coach_note, tag_type or "Training"),
                )
                tags_added += 1
            # Update media description if note provided
            if coach_note:
                conn.execute(
                    "UPDATE academy_media SET description=? WHERE media_id=?",
                    (coach_note, media_id),
                )

        elif mode == "add":
            # Add only students not already tagged
            for sid in id_list:
                already = conn.execute(
                    "SELECT 1 FROM media_tags WHERE media_id=? AND student_id=?",
                    (media_id, sid),
                ).fetchone()
                if not already:
                    conn.execute(
                        "INSERT INTO media_tags (media_id, student_id, coach_note, tag_type) VALUES (?,?,?,?)",
                        (media_id, sid, coach_note, tag_type or "Training"),
                    )
                    tags_added += 1
                elif tag_type:
                    # Update tag_type if changed
                    conn.execute(
                        "UPDATE media_tags SET tag_type=? WHERE media_id=? AND student_id=?",
                        (tag_type, media_id, sid),
                    )

        elif mode == "remove":
            # Remove specific students from tags
            for sid in id_list:
                result = conn.execute(
                    "DELETE FROM media_tags WHERE media_id=? AND student_id=?",
                    (media_id, sid),
                )
                tags_removed += result.rowcount

        conn.commit()

        # Count total remaining tags
        total = conn.execute(
            "SELECT COUNT(*) FROM media_tags WHERE media_id=?", (media_id,)
        ).fetchone()[0]

        logger.info(
            "xxgs_ [MEDIA] tags updated — media_id=%d mode=%s added=%d removed=%d total=%d user='%s'",
            media_id, mode, tags_added, tags_removed, total, auth_user,
        )
        return JSONResponse(content={
            "status":       "success",
            "media_id":     media_id,
            "mode":         mode,
            "tags_added":   tags_added,
            "tags_removed": tags_removed,
            "tags_total":   total,
        })

    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [MEDIA] update tags error: %s", exc)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# MATCHES API  —  /api/data/matches/*
# ══════════════════════════════════════════════════════════════════════
#
# Tables used:
#   cricket_matches      — match header + live totals
#   match_lineup         — QCA player list per match
#   performance_stats    — QCA batting/bowling/fielding per player
#   opponent_players     — opponent player names (no registration)
#   opp_batting          — opponent batting scorecard
#   opp_bowling          — opponent bowling figures
#   match_innings_extras — extras per innings (both teams)
#
# All endpoints log every step with xxgs_ prefix for easy grep.
# Timeout guard: no DB operation > 30s, all loops have per-item try/except.
#
# Endpoints:
#   GET  /api/data/matches                 — list matches (incremental sync)
#   GET  /api/data/matches/{id}            — full match detail both teams
#   POST /api/data/matches/save            — create/update full scorecard
#   POST /api/data/matches/{id}/player     — upsert single QCA player (live)
#   PATCH /api/data/matches/{id}/status   — update match status/totals
# ══════════════════════════════════════════════════════════════════════


# ── helpers ───────────────────────────────────────────────────────────────────
def _safe_int(v, default=0):
    try: return int(v or default)
    except: return default

def _safe_float(v, default=0.0):
    try: return float(v or default)
    except: return default

def _safe_str(v, default=""):
    return str(v).strip() if v is not None else default

def _safe_col(row, col, default):
    """Get a column from a sqlite3.Row safely — returns default if col missing or None."""
    try:
        v = row[col]
        return v if v is not None else default
    except (IndexError, KeyError):
        return default

def _now_str():
    from datetime import datetime
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

def _auto_migrate(conn):
    """Add new columns to cricket_matches if missing. Always checks PRAGMA."""
    new_cols = [
        ("total_overs",       "INTEGER DEFAULT 20"),
        ("toss_winner",       "TEXT DEFAULT ''"),
        ("toss_decision",     "TEXT DEFAULT 'Bat'"),
        ("innings1_team",     "TEXT DEFAULT 'QCA'"),
        ("innings2_team",     "TEXT DEFAULT 'Opponent'"),
        ("match_status",      "TEXT DEFAULT 'Scheduled'"),
        ("qca_total_runs",    "INTEGER DEFAULT 0"),
        ("qca_total_wickets", "INTEGER DEFAULT 0"),
        ("qca_total_overs",   "REAL DEFAULT 0"),
        ("opp_total_runs",    "INTEGER DEFAULT 0"),
        ("opp_total_wickets", "INTEGER DEFAULT 0"),
        ("opp_total_overs",   "REAL DEFAULT 0"),
        ("updated_at",        "TEXT DEFAULT ''"),
    ]
    existing = {row[1] for row in conn.execute("PRAGMA table_info(cricket_matches)").fetchall()}
    for col, typedef in new_cols:
        if col not in existing:
            try:
                conn.execute(f"ALTER TABLE cricket_matches ADD COLUMN {col} {typedef}")  # safe: col/typedef from hardcoded tuple
                logger.info("xxgs_ [MIGRATE] added cricket_matches.%s", col)
            except Exception as e:
                logger.warning("xxgs_ [MIGRATE] skip %s: %s", col, e)
    # Ensure new tables exist
    for ddl in [
        ("opp_batting", "CREATE TABLE IF NOT EXISTS opp_batting (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL, player_name TEXT NOT NULL DEFAULT '', runs_scored INTEGER DEFAULT 0, how_out TEXT DEFAULT 'Not Out', bowler_name TEXT DEFAULT '', fielder_name TEXT DEFAULT '', batting_done INTEGER DEFAULT 0)"),
        ("opp_bowling", "CREATE TABLE IF NOT EXISTS opp_bowling (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL, player_name TEXT NOT NULL DEFAULT '', overs_bowled REAL DEFAULT 0, runs_conceded INTEGER DEFAULT 0, wickets_taken INTEGER DEFAULT 0, wides_bowled INTEGER DEFAULT 0, no_balls_bowled INTEGER DEFAULT 0)"),
        ("match_innings_extras", "CREATE TABLE IF NOT EXISTS match_innings_extras (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL, innings_no INTEGER DEFAULT 1, batting_team TEXT DEFAULT 'QCA', extras_wides INTEGER DEFAULT 0, extras_noballs INTEGER DEFAULT 0, extras_byes INTEGER DEFAULT 0, extras_legbyes INTEGER DEFAULT 0)"),
    ]:
        try:
            conn.execute(ddl[1])
        except Exception as e:
            logger.warning("xxgs_ [MIGRATE] table %s skip: %s", ddl[0], e)
    try:
        conn.commit()
    except Exception:
        pass
    logger.info("xxgs_ [MIGRATE] cricket_matches schema up to date")


# ── GET /api/data/matches ─────────────────────────────────────────────────────
@router.get("/matches")
async def api_get_matches(
    request:   Request,
    since_id:  int = Query(0,   ge=0),
    limit:     int = Query(200, ge=1, le=1000),
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "matches:view")
    logger.info("xxgs_ [MATCHES-LIST] start since_id=%d limit=%d user='%s'", since_id, limit, auth_user)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _auto_migrate(conn)
        if since_id > 0:
            rows = conn.execute(
                "SELECT * FROM cricket_matches WHERE match_id > ? ORDER BY match_id ASC LIMIT ?",
                (since_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM cricket_matches ORDER BY match_date DESC, match_id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        data = []
        for r in rows:
            d = dict(r)
            # Safe defaults for columns that may not exist in older DBs
            d["qca_total_runs"]    = d.get("qca_total_runs")    or 0
            d["qca_total_wickets"] = d.get("qca_total_wickets") or 0
            d["qca_total_overs"]   = d.get("qca_total_overs")   or 0
            d["opp_total_runs"]    = d.get("opp_total_runs")    or 0
            d["opp_total_wickets"] = d.get("opp_total_wickets") or 0
            d["opp_total_overs"]   = d.get("opp_total_overs")   or 0
            d["match_status"]      = d.get("match_status")      or "Scheduled"
            d["total_overs"]       = d.get("total_overs")       or 20
            d["toss_winner"]       = d.get("toss_winner")       or ""
            d["toss_decision"]     = d.get("toss_decision")     or "Bat"
            d["innings1_team"]     = d.get("innings1_team")     or "QCA"
            d["innings2_team"]     = d.get("innings2_team")     or "Opponent"
            data.append(d)
        logger.info("xxgs_ [MATCHES-LIST] returning %d matches user='%s'", len(data), auth_user)
        return JSONResponse(content={"status": "success", "count": len(data), "data": data})
    except Exception as exc:
        logger.error("xxgs_ [MATCHES-LIST] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── GET /api/data/matches/{match_id} ─────────────────────────────────────────
@router.get("/matches/{match_id}")
async def api_get_match(
    request:   Request,
    match_id:  int,
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "matches:view")
    logger.info("xxgs_ [MATCHES-DETAIL] match_id=%d user='%s'", match_id, auth_user)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _auto_migrate(conn)
        # Use COALESCE so missing/NULL columns return safe defaults
        match_row = conn.execute(
            "SELECT * FROM cricket_matches WHERE match_id=?", (match_id,)
        ).fetchone()
        if not match_row:
            logger.warning("xxgs_ [MATCHES-DETAIL] not found match_id=%d", match_id)
            return JSONResponse(content={"error": "Match not found"}, status_code=404)
        # Build match dict with safe defaults for new columns
        match = {
            "match_id":          match_row["match_id"],
            "opponent_name":     match_row["opponent_name"] or "",
            "match_date":        match_row["match_date"] or "",
            "match_type":        match_row["match_type"] or "Friendly",
            "venue":             match_row["venue"] or "",
            "result_status":     match_row["result_status"] or "",
            "match_status":      _safe_col(match_row, "match_status", "Scheduled"),
            "total_overs":       _safe_col(match_row, "total_overs", 20),
            "toss_winner":       _safe_col(match_row, "toss_winner", ""),
            "toss_decision":     _safe_col(match_row, "toss_decision", "Bat"),
            "innings1_team":     _safe_col(match_row, "innings1_team", "QCA"),
            "innings2_team":     _safe_col(match_row, "innings2_team", "Opponent"),
            "qca_total_runs":    _safe_col(match_row, "qca_total_runs", 0),
            "qca_total_wickets": _safe_col(match_row, "qca_total_wickets", 0),
            "qca_total_overs":   _safe_col(match_row, "qca_total_overs", 0),
            "opp_total_runs":    _safe_col(match_row, "opp_total_runs", 0),
            "opp_total_wickets": _safe_col(match_row, "opp_total_wickets", 0),
            "opp_total_overs":   _safe_col(match_row, "opp_total_overs", 0),
        }

        # QCA lineup + stats
        # wides/no_balls columns may not exist on older DBs — use safe per-column fetch
        # First get column list of performance_stats
        players = conn.execute(
            """
            SELECT
                s.id                                AS student_id,
                s.name,
                IFNULL(l.batting_pos, 0)            AS batting_pos,
                IFNULL(l.is_captain, 0)             AS is_captain,
                IFNULL(l.is_wicketkeeper, 0)        AS is_wicketkeeper,
                IFNULL(p.runs_scored, 0)            AS runs_scored,
                IFNULL(p.balls_faced, 0)            AS balls_faced,
                IFNULL(p.fours, 0)                  AS fours,
                IFNULL(p.sixes, 0)                  AS sixes,
                IFNULL(p.how_out, 'Not Out')        AS how_out,
                IFNULL(p.batting_done, 0)           AS batting_done,
                IFNULL(p.overs_bowled, 0)           AS overs_bowled,
                IFNULL(p.runs_conceded, 0)          AS runs_conceded,
                IFNULL(p.wickets_taken, 0)          AS wickets_taken,
                IFNULL(p.wides_bowled, 0)           AS wides_bowled,
                IFNULL(p.no_balls_bowled, 0)        AS no_balls_bowled,
                IFNULL(p.catches, 0)                AS catches,
                IFNULL(p.stumpings, 0)              AS stumpings,
                IFNULL(p.run_outs, 0)               AS run_outs
            FROM match_lineup l
            JOIN students s ON s.id = l.student_id
            LEFT JOIN performance_stats p
                ON p.match_id = l.match_id
                AND p.student_id = l.student_id
                AND p.innings = 1
            WHERE l.match_id = ?
            ORDER BY l.batting_pos ASC
            """,
            (match_id,),
        ).fetchall()

        # Opponent batting
        opp_bat = []
        try:
            opp_bat = [dict(r) for r in conn.execute(
                "SELECT * FROM opp_batting WHERE match_id=? ORDER BY innings_no, batting_pos, id",
                (match_id,)
            ).fetchall()]
        except Exception as e:
            logger.warning("xxgs_ [MATCHES-DETAIL] opp_batting read skip: %s", e)

        # Opponent bowling
        opp_bowl = []
        try:
            opp_bowl = [dict(r) for r in conn.execute(
                "SELECT * FROM opp_bowling WHERE match_id=? ORDER BY innings_no, id",
                (match_id,)
            ).fetchall()]
        except Exception as e:
            logger.warning("xxgs_ [MATCHES-DETAIL] opp_bowling read skip: %s", e)

        # Innings extras
        extras = []
        try:
            extras = [dict(r) for r in conn.execute(
                "SELECT * FROM match_innings_extras WHERE match_id=? ORDER BY innings_no",
                (match_id,)
            ).fetchall()]
        except Exception as e:
            logger.warning("xxgs_ [MATCHES-DETAIL] extras read skip: %s", e)

        logger.info(
            "xxgs_ [MATCHES-DETAIL] match_id=%d players=%d opp_bat=%d opp_bowl=%d",
            match_id, len(players), len(opp_bat), len(opp_bowl)
        )
        return JSONResponse(content={
            "match":    match,
            "players":  [dict(r) for r in players],
            "opp_bat":  opp_bat,
            "opp_bowl": opp_bowl,
            "extras":   extras,
        })
    except Exception as exc:
        logger.error("xxgs_ [MATCHES-DETAIL] error match_id=%d: %s", match_id, exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── POST /api/data/matches/save ───────────────────────────────────────────────
# Schema aligned with routes/matches.py (the working web app route):
#   performance_stats: columns are 'wides' + 'no_balls' (NOT wides_bowled/no_balls_bowled)
#                      NO innings column, NO batting_done column
#   opp_batting:       player_name, runs_scored, how_out, bowler_name, fielder_name, batting_done
#                      NO innings_no, balls_faced, fours, sixes columns
#   opp_bowling:       player_name, overs_bowled, runs_conceded, wickets_taken only
#   match_innings_extras: batting_team = 'QCA' or 'OPPONENT' (uppercase)
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/matches/save")
async def api_save_match(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    role = require_write_role(auth_user)
    logger.info("xxgs_ [MATCHES-SAVE] request user='%s' ip=%s", auth_user, _get_ip(request))
    try:
        body = await request.json()
        logger.info("xxgs_ [MATCHES-SAVE] keys: %s", list(body.keys()))
    except Exception as e:
        logger.error("xxgs_ [MATCHES-SAVE] JSON parse error: %s", e)
        return JSONResponse(content={"error": "Invalid JSON body"}, status_code=400)

    match_id      = body.get("match_id")
    opponent      = _safe_str(body.get("opponent_name"))
    match_date    = _safe_str(body.get("match_date"))
    match_type    = _safe_str(body.get("match_type"),    "Friendly")
    result_status = _safe_str(body.get("result_status"))
    venue         = _safe_str(body.get("venue"))
    total_overs   = _safe_int(body.get("total_overs"),   20)
    toss_winner   = _safe_str(body.get("toss_winner"))
    toss_decision = _safe_str(body.get("toss_decision"), "Bat")
    players       = body.get("players",        []) or []
    opp_batting   = body.get("opp_batting",    []) or []
    opp_bowling   = body.get("opp_bowling",    []) or []
    inns_extras   = body.get("innings_extras", []) or []

    if not opponent:
        return JSONResponse(content={"error": "opponent_name required"}, status_code=400)
    if not match_date:
        return JSONResponse(content={"error": "match_date required"}, status_code=400)

    # Compute totals from submitted data
    qca_bat_runs = sum(_safe_int(p.get("runs_scored")) for p in players)
    qca_wkts     = sum(1 for p in players if _safe_str(p.get("how_out"), "Not Out") not in ("Not Out", "Did Not Bat", "Retired Hurt"))
    qca_overs    = max((_safe_float(p.get("overs_bowled")) for p in players), default=0.0)
    opp_bat_runs = sum(_safe_int(b.get("runs_scored")) for b in opp_batting)
    opp_wkts     = sum(1 for b in opp_batting if _safe_int(b.get("batting_done")))
    # Add extras to team totals
    qca_extras = opp_extras_total = 0
    for ex in inns_extras:
        ext = (_safe_int(ex.get("extras_wides")) + _safe_int(ex.get("extras_noballs")) +
               _safe_int(ex.get("extras_byes"))  + _safe_int(ex.get("extras_legbyes")))
        if _safe_str(ex.get("batting_team"), "").upper() == "QCA":
            qca_extras += ext
        else:
            opp_extras_total += ext
    qca_total_runs = qca_bat_runs + qca_extras
    opp_total_runs = opp_bat_runs + opp_extras_total

    logger.info(
        "xxgs_ [MATCHES-SAVE] opp='%s' date='%s' players=%d opp_bat=%d opp_bowl=%d match_id=%s",
        opponent, match_date, len(players), len(opp_batting), len(opp_bowling), match_id
    )

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _auto_migrate(conn)
        # ── Step 1: Match header ─────────────────────────────────────────────
        logger.info("xxgs_ [MATCHES-SAVE] step1 match_id=%s", match_id)

        # If match_id provided, check it actually exists on THIS server
        # Device-created IDs (>=10000) or IDs from another server won't exist here
        server_match_exists = False
        if match_id:
            row = conn.execute(
                "SELECT match_id FROM cricket_matches WHERE match_id=?", (match_id,)
            ).fetchone()
            server_match_exists = row is not None
            logger.info("xxgs_ [MATCHES-SAVE] match_id=%s exists_on_server=%s", match_id, server_match_exists)

        if match_id and server_match_exists:
            conn.execute(
                """UPDATE cricket_matches SET
                   opponent_name=?, match_date=?, match_type=?, venue=?, result_status=?,
                   total_overs=?, toss_winner=?, toss_decision=?,
                   qca_total_runs=?, qca_total_wickets=?, qca_total_overs=?,
                   opp_total_runs=?, opp_total_wickets=?
                   WHERE match_id=?""",
                (opponent, match_date, match_type, venue, result_status,
                 total_overs, toss_winner, toss_decision,
                 qca_total_runs, qca_wkts, qca_overs,
                 opp_total_runs, opp_wkts, match_id),
            )
            # tbl is hardcoded — not from user input (safe from injection)
            for tbl in ["performance_stats", "match_lineup", "opp_batting", "opp_bowling", "match_innings_extras"]:
                try:
                    conn.execute(f"DELETE FROM {tbl} WHERE match_id=?", (match_id,))  # safe: tbl from hardcoded list
                except Exception as e:
                    logger.warning("xxgs_ [MATCHES-SAVE] delete %s skip: %s", tbl, e)
            logger.info("xxgs_ [MATCHES-SAVE] updated existing match_id=%d", match_id)
        if not (match_id and server_match_exists):
            try:
                cur = conn.execute(
                    """INSERT INTO cricket_matches
                       (opponent_name, match_date, match_type, venue, result_status,
                        total_overs, toss_winner, toss_decision,
                        qca_total_runs, qca_total_wickets, qca_total_overs,
                        opp_total_runs, opp_total_wickets)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (opponent, match_date, match_type, venue, result_status,
                     total_overs, toss_winner, toss_decision,
                     qca_total_runs, qca_wkts, qca_overs, opp_total_runs, opp_wkts),
                )
            except Exception as e:
                logger.warning("xxgs_ [MATCHES-SAVE] full insert failed, trying basic: %s", e)
                cur = conn.execute(
                    "INSERT INTO cricket_matches (opponent_name, match_date, match_type, venue, result_status) VALUES (?,?,?,?,?)",
                    (opponent, match_date, match_type, venue, result_status),
                )
            match_id = cur.lastrowid
            logger.info("xxgs_ [MATCHES-SAVE] created new match_id=%d", match_id)

        # ── Step 2: QCA lineup + performance stats ───────────────────────────
        # DB uses 'wides' and 'no_balls' — mobile sends 'wides_bowled' and 'no_balls_bowled'
        logger.info("xxgs_ [MATCHES-SAVE] step2 QCA players=%d", len(players))
        qca_saved = 0
        for i, p in enumerate(players):
            sid = _safe_int(p.get("student_id"))
            if not sid:
                logger.warning("xxgs_ [MATCHES-SAVE] player[%d] no student_id, skip", i)
                continue
            try:
                conn.execute(
                    """INSERT INTO match_lineup (match_id, student_id, batting_pos, is_captain, is_wicketkeeper)
                       VALUES (?,?,?,?,?)""",
                    (match_id, sid,
                     _safe_int(p.get("batting_pos"), i + 1),
                     _safe_int(p.get("is_captain")),
                     _safe_int(p.get("is_wicketkeeper"))),
                )
                # Accept both mobile field names and DB field names
                wides   = _safe_int(p.get("wides_bowled")   or p.get("wides")    or 0)
                noballs = _safe_int(p.get("no_balls_bowled") or p.get("no_balls") or 0)
                # Check if wides/no_balls columns exist (added in later migration)
                how_out_val      = _safe_str(p.get("how_out"), "Not Out")
                batting_done_val = 0 if how_out_val in ("Not Out","Did Not Bat","Retired Hurt") else 1
                conn.execute(
                    """INSERT INTO performance_stats
                       (match_id, student_id, innings,
                        runs_scored, balls_faced, fours, sixes, how_out, batting_done,
                        overs_bowled, runs_conceded, wickets_taken,
                        wides_bowled, no_balls_bowled,
                        catches, stumpings, run_outs, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(match_id, student_id, innings) DO UPDATE SET
                           runs_scored=excluded.runs_scored, balls_faced=excluded.balls_faced,
                           fours=excluded.fours, sixes=excluded.sixes,
                           how_out=excluded.how_out, batting_done=excluded.batting_done,
                           overs_bowled=excluded.overs_bowled, runs_conceded=excluded.runs_conceded,
                           wickets_taken=excluded.wickets_taken,
                           wides_bowled=excluded.wides_bowled, no_balls_bowled=excluded.no_balls_bowled,
                           catches=excluded.catches, stumpings=excluded.stumpings,
                           run_outs=excluded.run_outs, updated_at=excluded.updated_at""",
                    (match_id, sid, 1,
                     _safe_int(p.get("runs_scored")), _safe_int(p.get("balls_faced")),
                     _safe_int(p.get("fours")), _safe_int(p.get("sixes")),
                     how_out_val, batting_done_val,
                     _safe_float(p.get("overs_bowled")), _safe_int(p.get("runs_conceded")),
                     _safe_int(p.get("wickets_taken")),
                     _safe_int(p.get("wides_bowled")), _safe_int(p.get("no_balls_bowled")),
                     _safe_int(p.get("catches")), _safe_int(p.get("stumpings")),
                     _safe_int(p.get("run_outs")), _now_str(), _now_str()),
                )
                qca_saved += 1
            except Exception as e:
                logger.error("xxgs_ [MATCHES-SAVE] player sid=%d error: %s", sid, e)
        logger.info("xxgs_ [MATCHES-SAVE] QCA saved=%d", qca_saved)

        # ── Step 3: Opponent batting ─────────────────────────────────────────
        # DB opp_batting columns: match_id, player_name, runs_scored, how_out,
        #                         bowler_name, fielder_name, batting_done
        opp_bat_saved = 0
        if opp_batting:
            logger.info("xxgs_ [MATCHES-SAVE] step3 opp batting=%d", len(opp_batting))
            for i, b in enumerate(opp_batting):
                pname = _safe_str(b.get("player_name"))
                if not pname:
                    continue
                try:
                    conn.execute(
                        """INSERT OR REPLACE INTO opp_batting
                           (match_id, player_name, runs_scored, how_out,
                            bowler_name, fielder_name, batting_done)
                           VALUES (?,?,?,?,?,?,?)""",
                        (match_id, pname,
                         _safe_int(b.get("runs_scored")),
                         _safe_str(b.get("how_out"), "Not Out"),
                         _safe_str(b.get("bowler_name")),
                         _safe_str(b.get("fielder_name")),
                         _safe_int(b.get("batting_done"))),
                    )
                    opp_bat_saved += 1
                except Exception as e:
                    logger.error("xxgs_ [MATCHES-SAVE] opp_bat[%d] '%s' error: %s", i, pname, e)
        logger.info("xxgs_ [MATCHES-SAVE] opp batting saved=%d", opp_bat_saved)

        # ── Step 4: Opponent bowling ─────────────────────────────────────────
        # DB opp_bowling columns: match_id, player_name, overs_bowled, runs_conceded, wickets_taken
        opp_bowl_saved = 0
        if opp_bowling:
            logger.info("xxgs_ [MATCHES-SAVE] step4 opp bowling=%d", len(opp_bowling))
            for i, b in enumerate(opp_bowling):
                pname = _safe_str(b.get("player_name"))
                if not pname:
                    continue
                try:
                    conn.execute(
                        """INSERT OR REPLACE INTO opp_bowling
                           (match_id, player_name, overs_bowled, runs_conceded, wickets_taken)
                           VALUES (?,?,?,?,?)""",
                        (match_id, pname,
                         _safe_float(b.get("overs_bowled")),
                         _safe_int(b.get("runs_conceded")),
                         _safe_int(b.get("wickets_taken"))),
                    )
                    opp_bowl_saved += 1
                except Exception as e:
                    logger.error("xxgs_ [MATCHES-SAVE] opp_bowl[%d] '%s' error: %s", i, pname, e)
        logger.info("xxgs_ [MATCHES-SAVE] opp bowling saved=%d", opp_bowl_saved)

        # ── Step 5: Innings extras ───────────────────────────────────────────
        # batting_team must be 'QCA' or 'OPPONENT' (uppercase) to match web app
        extras_saved = 0
        if inns_extras:
            logger.info("xxgs_ [MATCHES-SAVE] step5 extras=%d", len(inns_extras))
            for ex in inns_extras:
                raw_team = _safe_str(ex.get("batting_team"), "QCA").strip().upper()
                db_team  = "QCA" if raw_team == "QCA" else "OPPONENT"
                try:
                    conn.execute(
                        """INSERT OR REPLACE INTO match_innings_extras
                           (match_id, innings_no, batting_team,
                            extras_wides, extras_noballs, extras_byes, extras_legbyes)
                           VALUES (?,?,?,?,?,?,?)""",
                        (match_id,
                         _safe_int(ex.get("innings_no"), 1),
                         db_team,
                         _safe_int(ex.get("extras_wides")),
                         _safe_int(ex.get("extras_noballs")),
                         _safe_int(ex.get("extras_byes")),
                         _safe_int(ex.get("extras_legbyes"))),
                    )
                    extras_saved += 1
                except Exception as e:
                    logger.error("xxgs_ [MATCHES-SAVE] extras error: %s", e)
        logger.info("xxgs_ [MATCHES-SAVE] extras saved=%d", extras_saved)

        conn.commit()
        logger.info(
            "xxgs_ [MATCHES-SAVE] COMMITTED match_id=%d qca=%d opp_bat=%d opp_bowl=%d extras=%d",
            match_id, qca_saved, opp_bat_saved, opp_bowl_saved, extras_saved
        )
        return JSONResponse(content={
            "status":         "success",
            "match_id":       match_id,
            "qca_saved":      qca_saved,
            "opp_bat_saved":  opp_bat_saved,
            "opp_bowl_saved": opp_bowl_saved,
            "extras_saved":   extras_saved,
        })

    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [MATCHES-SAVE] FATAL: %s", exc, exc_info=True)
        traceback.print_exc()
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()
        logger.info("xxgs_ [MATCHES-SAVE] connection closed match_id=%s", match_id)

# ── POST /api/data/matches/{match_id}/player ─────────────────────────────────
# Progressive single-player update for live scoring.
# Uses ON CONFLICT upsert — safe to call multiple times.
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/matches/{match_id}/player")
async def api_update_player_stats(
    request:   Request,
    match_id:  int,
    auth_user: str = Depends(verify_api_auth),
):
    role = require_write_role(auth_user)
    logger.info("xxgs_ [MATCHES-PLAYER] match_id=%d user='%s'", match_id, auth_user)
    try:
        body = await request.json()
    except Exception as e:
        logger.error("xxgs_ [MATCHES-PLAYER] JSON error: %s", e)
        return JSONResponse(content={"error": "Invalid JSON"}, status_code=400)

    student_id = _safe_int(body.get("student_id"))
    innings    = _safe_int(body.get("innings"), 1)
    if not student_id:
        return JSONResponse(content={"error": "student_id required"}, status_code=400)

    logger.info(
        "xxgs_ [MATCHES-PLAYER] student_id=%d innings=%d runs=%s overs=%s",
        student_id, innings,
        body.get("runs_scored"), body.get("overs_bowled")
    )

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        match = conn.execute(
            "SELECT match_id FROM cricket_matches WHERE match_id=?", (match_id,)
        ).fetchone()
        if not match:
            return JSONResponse(content={"error": "Match not found"}, status_code=404)

        existing = conn.execute(
            "SELECT stat_id FROM performance_stats WHERE match_id=? AND student_id=? AND innings=?",
            (match_id, student_id, innings)
        ).fetchone()
        action = "updated" if existing else "created"

        how_out_val = _safe_str(body.get("how_out"), "Not Out")
        batting_done_val = _safe_int(body.get("batting_done")) or (
            0 if how_out_val in ("Not Out","Did Not Bat","Retired Hurt") else 1
        )
        conn.execute(
            """INSERT INTO performance_stats
               (match_id, student_id, innings,
                runs_scored, balls_faced, fours, sixes, how_out, batting_done,
                overs_bowled, runs_conceded, wickets_taken,
                wides_bowled, no_balls_bowled,
                catches, stumpings, run_outs, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(match_id, student_id, innings) DO UPDATE SET
                   runs_scored=excluded.runs_scored, balls_faced=excluded.balls_faced,
                   fours=excluded.fours, sixes=excluded.sixes,
                   how_out=excluded.how_out, batting_done=excluded.batting_done,
                   overs_bowled=excluded.overs_bowled, runs_conceded=excluded.runs_conceded,
                   wickets_taken=excluded.wickets_taken,
                   wides_bowled=excluded.wides_bowled, no_balls_bowled=excluded.no_balls_bowled,
                   catches=excluded.catches, stumpings=excluded.stumpings,
                   run_outs=excluded.run_outs, updated_at=excluded.updated_at""",
            (match_id, student_id, innings,
             _safe_int(body.get("runs_scored")), _safe_int(body.get("balls_faced")),
             _safe_int(body.get("fours")), _safe_int(body.get("sixes")),
             how_out_val, batting_done_val,
             _safe_float(body.get("overs_bowled")), _safe_int(body.get("runs_conceded")),
             _safe_int(body.get("wickets_taken")),
             _safe_int(body.get("wides_bowled")), _safe_int(body.get("no_balls_bowled")),
             _safe_int(body.get("catches")), _safe_int(body.get("stumpings")),
             _safe_int(body.get("run_outs")), _now_str(), _now_str()),
        )

        # Recalculate team totals
        try:
            r = conn.execute(
                "SELECT COALESCE(SUM(runs_scored),0) AS r FROM performance_stats WHERE match_id=?",
                (match_id,)
            ).fetchone()["r"]
            conn.execute(
                "UPDATE cricket_matches SET qca_total_runs=? WHERE match_id=?",
                (r, match_id)
            )
        except Exception as e:
            logger.warning("xxgs_ [MATCHES-PLAYER] totals update skip: %s", e)

        conn.commit()
        logger.info(
            "xxgs_ [MATCHES-PLAYER] %s match_id=%d student_id=%d innings=%d",
            action, match_id, student_id, innings
        )
        return JSONResponse(content={
            "status": "success", "match_id": match_id,
            "student_id": student_id, "innings": innings, "action": action,
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [MATCHES-PLAYER] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── PATCH /api/data/matches/{match_id}/status ─────────────────────────────────
# Update match status, live totals, result.
# Body: { "match_status":"Live", "result_status":"QCA won by 25 runs",
#          "qca_total_runs":156, "qca_total_wickets":4,
#          "opp_total_runs":131, "opp_total_wickets":10 }
# ─────────────────────────────────────────────────────────────────────────────
@router.patch("/matches/{match_id}/status")
async def api_update_match_status(
    request:   Request,
    match_id:  int,
    auth_user: str = Depends(verify_api_auth),
):
    logger.info("xxgs_ [MATCHES-STATUS] match_id=%d user='%s'", match_id, auth_user)
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse(content={"error": "Invalid JSON"}, status_code=400)

    logger.info("xxgs_ [MATCHES-STATUS] body: %s", body)

    conn = get_db_connection()
    try:
        match = conn.execute(
            "SELECT match_id FROM cricket_matches WHERE match_id=?", (match_id,)
        ).fetchone()
        if not match:
            return JSONResponse(content={"error": "Match not found"}, status_code=404)

        allowed = {
            "match_status", "result_status", "batting_team", "current_innings",
            "qca_total_runs", "qca_total_wickets", "qca_total_overs",
            "opp_total_runs", "opp_total_wickets", "opp_total_overs",
        }
        fields, params = [], []
        for col in allowed:
            if col in body:
                fields.append(f"{col}=?")
                params.append(body[col])

        if not fields:
            return JSONResponse(content={"error": "No valid fields"}, status_code=400)

        fields.append("updated_at=?")
        params.append(_now_str())
        params.append(match_id)

        conn.execute(
            f"UPDATE cricket_matches SET {', '.join(fields)} WHERE match_id=?", params
        )
        conn.commit()
        logger.info("xxgs_ [MATCHES-STATUS] updated match_id=%d fields=%s", match_id, fields)
        return JSONResponse(content={"status": "success", "match_id": match_id})
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [MATCHES-STATUS] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# COACH REMARKS API
# ══════════════════════════════════════════════════════════════════════
# GET  /api/data/remarks              — list remarks (filter by student_id or recent)
# POST /api/data/remarks              — add a new remark
# PUT  /api/data/remarks/{remark_id}  — edit an existing remark
# DELETE /api/data/remarks/{remark_id}— delete a remark
# ──────────────────────────────────────────────────────────────────────

@router.get("/remarks")
async def api_get_remarks(
    request:    Request,
    student_id: int = Query(None, description="Filter by student ID"),
    limit:      int = Query(15,   ge=1, le=100),
    offset:     int = Query(0,    ge=0),
    search:     str = Query("",   description="Search in remark text or student name", max_length=200),
    auth_user:  str = Depends(verify_api_auth),
):
    require_permission(auth_user, "remarks:view")
    """
    Fetch coach remarks — paginated with offset, search, total count.
    Returns: { status, total, count, data }
    """
    logger.info("xxgs_ [REMARKS-GET] user='%s' student_id=%s limit=%d offset=%d search='%s'",
                auth_user, student_id, limit, offset, search)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Build WHERE clause dynamically
        where   = ["(r.is_private = 0 OR r.coach_name = ?)"]
        params  = [auth_user]

        if student_id:
            where.append("r.student_id = ?")
            params.append(student_id)

        if search.strip():
            where.append("(r.remark LIKE ? OR s.name LIKE ?)")
            like = f"%{search.strip()}%"
            params.extend([like, like])

        where_sql = "WHERE " + " AND ".join(where)

        base_sql = """
            FROM coach_remarks r
            JOIN students s ON s.id = r.student_id
            {where}
        """.format(where=where_sql)

        # Total count for pagination
        total = conn.execute(
            f"SELECT COUNT(*) as n {base_sql}", params
        ).fetchone()["n"]

        # Paginated rows
        rows = conn.execute(
            f"""SELECT r.id, r.student_id, s.name AS student_name,
                      r.coach_id, r.coach_name, r.remark, r.remark_type,
                      r.remark_date, r.rating, r.direction, r.is_private,
                      r.video_url
               {base_sql}
               ORDER BY r.remark_date DESC, r.id DESC
               LIMIT ? OFFSET ?""",
            params + [limit, offset]
        ).fetchall()

        data = [dict(r) for r in rows]
        logger.info("xxgs_ [REMARKS-GET] total=%d returning %d (offset=%d)", total, len(data), offset)
        return JSONResponse(content={
            "status": "success",
            "total":  total,
            "count":  len(data),
            "data":   data,
        })
    except Exception as exc:
        logger.error("xxgs_ [REMARKS-GET] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.post("/remarks")
async def api_add_remark(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """
    Add a new coach remark.
    Rules:
      1. Student must have been marked Present on remark_date
      2. remark_date must be within last 7 days (coaches; admins bypass)
    Schema columns used: student_id, coach_id, coach_name, remark, remark_type,
                         remark_date, rating, direction, is_private, video_url
    """
    role = require_write_role(auth_user)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON"}, status_code=400)

    student_id   = _safe_int(body.get("student_id"))
    remark       = _safe_str(body.get("remark")).strip()
    remark_type  = _safe_str(body.get("remark_type"),  "TECHNICAL")
    remark_date  = _safe_str(body.get("remark_date"),  datetime.now().strftime("%Y-%m-%d"))
    rating       = _safe_int(body.get("rating"),       0)
    direction    = _safe_str(body.get("direction"),    "COACH_TO_STUDENT")
    if direction not in ('COACH_TO_STUDENT', 'STUDENT_TO_COACH', 'PEER'):
        direction = 'COACH_TO_STUDENT'
    is_private   = 1 if body.get("is_private") else 0
    video_url    = _safe_str(body.get("video_url"),   "")
    coach_name   = _safe_str(body.get("coach_name"),  auth_user)
    coach_id     = _safe_int(body.get("coach_id"),    0)
    user_role    = _safe_str(body.get("_role"),       "Coach")

    if not student_id:
        return JSONResponse(content={"error": "student_id required"}, status_code=400)
    if not remark:
        return JSONResponse(content={"error": "remark text required"}, status_code=400)
    if len(remark) > 2000:
        return JSONResponse(content={"error": "Remark exceeds 2000 characters"}, status_code=400)
    if video_url and len(video_url) > 500:
        return JSONResponse(content={"error": "Video URL exceeds 500 characters"}, status_code=400)
    # Validate remark_type against allowed values
    VALID_REMARK_TYPES = ('TECHNICAL','TACTICAL','PHYSICAL','MENTAL',
                          'BATTING','BOWLING','FIELDING','MATCH_PERFORMANCE')
    if remark_type not in VALID_REMARK_TYPES:
        remark_type = 'TECHNICAL'

    if rating not in range(0, 6):
        rating = max(0, min(5, rating))

    # ── Validate date ─────────────────────────────────────────────────────────
    try:
        remark_dt = datetime.strptime(remark_date, "%Y-%m-%d").date()
    except ValueError:
        return JSONResponse(content={"error": "remark_date must be YYYY-MM-DD"}, status_code=400)

    today = datetime.now().date()

    # ── 7-day rolling window (coaches only) ───────────────────────────────────
    if user_role.lower() != "admin":
        days_ago = (today - remark_dt).days
        if days_ago < 0:
            return JSONResponse(content={"error": "Cannot add remarks for a future date"}, status_code=400)
        if days_ago > 7:
            return JSONResponse(
                content={"error": f"Remarks allowed within 7 days only. "
                                  f"{remark_date} is {days_ago} days ago (window closed)."},
                status_code=400,
            )

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Verify student
        student = conn.execute("SELECT id, name FROM students WHERE id=?", (student_id,)).fetchone()
        if not student:
            return JSONResponse(content={"error": "Student not found"}, status_code=404)

        # ── Attendance check ──────────────────────────────────────────────────
        was_present = False
        if conn.execute(
            "SELECT 1 FROM temp_attendance WHERE student_id=? AND date=? AND status='PRESENT' LIMIT 1",
            (student_id, remark_date)
        ).fetchone():
            was_present = True
        if not was_present and conn.execute(
            "SELECT 1 FROM attendance WHERE student_id=? AND date=? AND status='Present' LIMIT 1",
            (student_id, remark_date)
        ).fetchone():
            was_present = True

        if not was_present and user_role.lower() != "admin":
            return JSONResponse(
                content={"error": f"{student['name']} was not marked Present on {remark_date}. "
                                  f"Remarks can only be added for sessions the student attended."},
                status_code=400,
            )

        cur = conn.execute(
            """INSERT INTO coach_remarks
               (student_id, coach_id, coach_name, remark, remark_type,
                remark_date, rating, direction, is_private, video_url)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (student_id, coach_id, coach_name, remark, remark_type,
             remark_date, rating, direction, is_private, video_url),
        )
        conn.commit()
        remark_id = cur.lastrowid
        logger.info("xxgs_ [REMARKS-ADD] remark_id=%d student='%s' type=%s rating=%d",
                    remark_id, student["name"], remark_type, rating)
        return JSONResponse(content={
            "status":       "success",
            "remark_id":    remark_id,
            "student_id":   student_id,
            "student_name": student["name"],
            "coach_name":   coach_name,
            "remark":       remark,
            "remark_type":  remark_type,
            "remark_date":  remark_date,
            "rating":       rating,
            "direction":    direction,
            "is_private":   bool(is_private),
            "video_url":    video_url,
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [REMARKS-ADD] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.put("/remarks/{remark_id}")
async def api_edit_remark(
    request:   Request,
    remark_id: int,
    auth_user: str = Depends(verify_api_auth),
):
    """Edit an existing remark. Coaches can only edit their own; Admin can edit any."""
    role = require_write_role(auth_user)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        existing = conn.execute("SELECT * FROM coach_remarks WHERE id=?", (remark_id,)).fetchone()
        if not existing:
            return JSONResponse(content={"error": "Remark not found"}, status_code=404)

        user_role = _safe_str(body.get("_role"), "Coach")
        if user_role.lower() != "admin" and existing["coach_name"] != auth_user:
            return JSONResponse(content={"error": "You can only edit your own remarks"}, status_code=403)

        remark      = _safe_str(body.get("remark",      existing["remark"]))
        remark_type = _safe_str(body.get("remark_type", existing["remark_type"] or "TECHNICAL"))
        remark_date = _safe_str(body.get("remark_date", existing["remark_date"]))
        rating      = _safe_int(body.get("rating",      existing["rating"] or 0))
        is_private  = 1 if body.get("is_private", bool(existing["is_private"])) else 0
        video_url   = _safe_str(body.get("video_url",   existing["video_url"] or ""))

        conn.execute(
            """UPDATE coach_remarks
               SET remark=?, remark_type=?, remark_date=?, rating=?, is_private=?, video_url=?
               WHERE id=?""",
            (remark, remark_type, remark_date, rating, is_private, video_url, remark_id),
        )
        conn.commit()
        logger.info("xxgs_ [REMARKS-EDIT] remark_id=%d updated by '%s'", remark_id, auth_user)
        return JSONResponse(content={
            "status":      "success",
            "remark_id":   remark_id,
            "remark":      remark,
            "remark_type": remark_type,
            "remark_date": remark_date,
            "rating":      rating,
            "is_private":  bool(is_private),
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [REMARKS-EDIT] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.delete("/remarks/{remark_id}")
async def api_delete_remark(
    request:   Request,
    remark_id: int,
    auth_user: str = Depends(verify_api_auth),
):
    """Delete a remark. Coaches can only delete their own; Admin can delete any."""
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    role = require_write_role(auth_user)
    try:
        existing = conn.execute(
            "SELECT coach FROM coach_remarks WHERE id=?", (remark_id,)
        ).fetchone()
        if not existing:
            return JSONResponse(content={"error": "Remark not found"}, status_code=404)

        # Permission check — coaches only delete own
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass
        user_role = body.get("_role", "Coach")
        if user_role.lower() != "admin" and existing["coach_name"] != auth_user:
            return JSONResponse(
                content={"error": "You can only delete your own remarks"},
                status_code=403,
            )

        conn.execute("DELETE FROM coach_remarks WHERE id=?", (remark_id,))
        conn.commit()
        logger.info("xxgs_ [REMARKS-DEL] remark_id=%d deleted by '%s'", remark_id, auth_user)
        return JSONResponse(content={"status": "success", "deleted_id": remark_id})
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [REMARKS-DEL] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════
# STUDENT PROFILE UPDATE API
# ══════════════════════════════════════════════════════════════════════
#
# GET  /api/data/students/{student_id}/profile  — fetch editable profile
# PUT  /api/data/students/{student_id}/profile  — update profile fields
#
# PROTECTED FIELDS (never editable via API):
#   id, name, user_id, enrollment_date, status, exit_date, exit_reason
#
# ALLOWED FIELDS with validation:
#   Personal:   gender, date_of_birth, age(auto), blood_group, school_name,
#               current_grade, medical_conditions
#   Contact:    phone (ISD+number), parent_name, parent_phone, parent_email,
#               parent_isd, emergency_contact_name, emergency_contact_phone,
#               emergency_isd
#   Academy:    level, student_type, dominant_side, kit_size, coach_id,
#               referral_source, student_category, monthly_fee
# ══════════════════════════════════════════════════════════════════════

# ── Allowed values — exact match with edit_student.html dropdowns ─────────────
_VALID_GENDER         = ('Male', 'Female')
_VALID_BLOOD_GROUP    = ('A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-')
_VALID_LEVEL          = ('Beginner', 'Intermediate', 'Advanced', 'Elite')
_VALID_STUDENT_TYPE   = ('Academy', 'Camp')
_VALID_DOMINANT_SIDE  = (
    # Pace All-Rounders
    'RHB | Right Arm Fast', 'RHB | Left Arm Fast',
    'LHB | Right Arm Fast', 'LHB | Left Arm Fast',
    # Spin All-Rounders
    'RHB | Right Arm Off Spin', 'RHB | Right Arm Leg Spin',
    'RHB | Left Arm Orthodox', 'LHB | Right Arm Off Spin',
    'LHB | Left Arm Orthodox', 'RHB | Left Arm Chinaman',
    # Wicket Keepers
    'Wicket Keeper Bat (RHB)', 'Wicket Keeper Bat (LHB)',
    # Pure Specialists
    'Right Hand Bat Only', 'Left Hand Bat Only',
)
_VALID_KIT_SIZE       = ('22','24','26','28','30','32','34','36','38','40','S','M','L','XL','XXL')
_VALID_REFERRAL       = ('Instagram', 'Facebook', 'Google', 'Friend/Reference', 'Banner', 'Other')
_VALID_CATEGORY       = ('REGULAR', 'TEMPORARY', 'SCHOLARSHIP')
_VALID_STATUS         = ('Active', 'Club Member', 'Camp', 'Inactive')
_VALID_ISD            = ('+91', '+971', '+44', '+1')
_VALID_CURRENT_GRADE  = (
    'KG', '1', '2', '3', '4', '5', '6', '7', '8',
    '9', '10', '11', '12', 'Graduate', 'Other',
)

# Fields that must NEVER be updated via this API
_LOCKED_FIELDS = frozenset({
    'id', 'name', 'user_id',
    'exit_date', 'exit_reason', 'profile_image',
})

def _fmt_phone(isd: str, number: str) -> str:
    """Merge ISD code + number into E.164-ish format."""
    isd_clean = isd.strip().lstrip('+')
    num_clean  = number.strip().lstrip('0')
    return f"+{isd_clean}{num_clean}"

def _validate_phone_num(p: str) -> bool:
    import re
    return bool(re.match(r'^[+]\d{7,15}$', p))

def _validate_date(d: str) -> bool:
    try:
        datetime.strptime(d, '%Y-%m-%d')
        return True
    except (ValueError, TypeError):
        return False

def _calc_age(dob: str) -> int:
    """Calculate age from YYYY-MM-DD date string."""
    try:
        birth = datetime.strptime(dob, '%Y-%m-%d').date()
        today = datetime.now().date()
        age   = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
        return max(0, min(100, age))
    except Exception:
        return 0


@router.get("/students/{student_id}/profile")
async def api_get_student_profile(
    request:    Request,
    student_id: int,
    auth_user:  str = Depends(verify_api_auth),
):
    """Fetch full editable profile for a student."""
    logger.info("xxgs_ [PROFILE-GET] student_id=%d user='%s'", student_id, auth_user)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """SELECT id, name, gender, age, email, phone, level, status,
                      school_name, current_grade, date_of_birth,
                      parent_name, parent_phone, parent_email,
                      emergency_contact_name, emergency_contact_phone,
                      student_type, enrollment_date,
                      medical_conditions, blood_group,
                      dominant_side, kit_size, referral_source,
                      coach_id, student_category, monthly_fee,
                      profile_image
               FROM students WHERE id=?""",
            (student_id,),
        ).fetchone()
        if not row:
            return JSONResponse(content={"error": f"No student with id={student_id}"}, status_code=404)

        data = dict(row)
        # Add metadata for dropdowns
        data["_meta"] = {
            "valid_gender":        list(_VALID_GENDER),
            "valid_blood_group":   list(_VALID_BLOOD_GROUP),
            "valid_level":         list(_VALID_LEVEL),
            "valid_student_type":  list(_VALID_STUDENT_TYPE),
            "valid_dominant_side": list(_VALID_DOMINANT_SIDE),
            "valid_kit_size":      list(_VALID_KIT_SIZE),
            "valid_referral":      list(_VALID_REFERRAL),
            "valid_category":      list(_VALID_CATEGORY),
            "valid_status":        list(_VALID_STATUS),
            "valid_isd":           list(_VALID_ISD),
            "locked_fields":       list(_LOCKED_FIELDS),
        }
        return JSONResponse(content={"status": "success", "data": data})
    except Exception as exc:
        logger.error("xxgs_ [PROFILE-GET] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.put("/students/{student_id}/profile")
async def api_update_student_profile(
    request:    Request,
    student_id: int,
    auth_user:  str = Depends(verify_api_auth),
):
    # Permission check — use PBAC slug
    require_permission(auth_user, 'student:edit')
    """
    Update editable profile fields for a student.

    Body: JSON object with any subset of allowed fields.
    Phone fields accept either:
      - full E.164: {"phone": "+971501234567"}
      - split ISD:  {"phone_isd": "+971", "phone_number": "501234567"}
    Same pattern for parent_phone and emergency_contact_phone.
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON body"}, status_code=400)

    if not body:
        return JSONResponse(content={"error": "Empty request body"}, status_code=400)

    # ── Reject any attempt to update locked fields ────────────────────────────
    attempted_locked = _LOCKED_FIELDS & set(body.keys())
    if attempted_locked:
        return JSONResponse(
            content={"error": f"Fields are not editable: {', '.join(sorted(attempted_locked))}"},
            status_code=403,
        )

    errors = []
    updates = {}  # column → value to SET

    # ── Mandatory field check ─────────────────────────────────────────────────
    MANDATORY = {'student_type', 'student_category', 'status', 'enrollment_date'}
    for mf in MANDATORY:
        if mf in body and not _safe_str(body.get(mf)):
            errors.append(f"{mf} is required and cannot be empty")

    # ── Personal fields ───────────────────────────────────────────────────────
    if 'gender' in body:
        v = _safe_str(body['gender'])
        if v not in _VALID_GENDER:
            errors.append(f"gender must be one of: {_VALID_GENDER}")
        else:
            updates['gender'] = v

    if 'date_of_birth' in body:
        v = _safe_str(body['date_of_birth'])
        if not _validate_date(v):
            errors.append("date_of_birth must be YYYY-MM-DD")
        else:
            updates['date_of_birth'] = v
            updates['age']           = _calc_age(v)  # auto-recalc age

    if 'blood_group' in body:
        v = _safe_str(body['blood_group'])
        if v and v not in _VALID_BLOOD_GROUP:
            errors.append(f"blood_group must be one of: {_VALID_BLOOD_GROUP}")
        else:
            updates['blood_group'] = v or None

    if 'school_name' in body:
        updates['school_name'] = _safe_str(body['school_name'])[:100] or None

    if 'current_grade' in body:
        v = _safe_str(body['current_grade'])
        if v and v not in _VALID_CURRENT_GRADE:
            errors.append(f"current_grade must be one of: {_VALID_CURRENT_GRADE}")
        else:
            updates['current_grade'] = v or None

    if 'medical_conditions' in body:
        updates['medical_conditions'] = _safe_str(body['medical_conditions'])[:500] or None

    # ── Student's own email ──────────────────────────────────────────────────
    if 'email' in body:
        import re as _re2
        v = _safe_str(body['email'])
        if v and not _re2.match(r'^[^\s@]+@[^\s@]+[.][^\s@]+$', v):
            errors.append("email is not a valid email address")
        else:
            updates['email'] = v or None

    # ── Phone — primary (ISD split or full E.164) ─────────────────────────────
    if 'phone_isd' in body or 'phone_number' in body:
        isd = _safe_str(body.get('phone_isd', '+91'))
        num = _safe_str(body.get('phone_number', ''))
        if isd not in _VALID_ISD:
            errors.append(f"phone_isd must be one of: {_VALID_ISD}")
        elif not num:
            errors.append("phone_number is required when phone_isd is provided")
        else:
            full = _fmt_phone(isd, num)
            if not _validate_phone_num(full):
                errors.append(f"phone number invalid: {full}")
            else:
                updates['phone'] = full
    elif 'phone' in body:
        v = _safe_str(body['phone'])
        if v and not _validate_phone_num(v):
            errors.append(f"phone must be E.164 format e.g. +971501234567")
        elif v:
            updates['phone'] = v

    # ── Parent contact ────────────────────────────────────────────────────────
    if 'parent_name' in body:
        v = _safe_str(body['parent_name'])[:100]
        if v and len(v) < 3:
            errors.append("parent_name must be at least 3 characters")
        else:
            updates['parent_name'] = v or None

    if 'parent_phone_isd' in body or 'parent_phone_number' in body:
        isd = _safe_str(body.get('parent_phone_isd', '+91'))
        num = _safe_str(body.get('parent_phone_number', ''))
        if isd not in _VALID_ISD:
            errors.append(f"parent_phone_isd must be one of: {_VALID_ISD}")
        elif num:
            full = _fmt_phone(isd, num)
            if not _validate_phone_num(full):
                errors.append(f"parent_phone invalid: {full}")
            else:
                updates['parent_phone'] = full
    elif 'parent_phone' in body:
        v = _safe_str(body['parent_phone'])
        if v and not _validate_phone_num(v):
            errors.append("parent_phone must be E.164 format")
        elif v:
            updates['parent_phone'] = v

    if 'parent_email' in body:
        import re as _re
        v = _safe_str(body['parent_email']) if body['parent_email'] is not None else ''
        if v and not _re.match(r'^[^@]+@[^@]+\.[^@]+$', v):
            errors.append("parent_email is not valid")
        else:
            updates['parent_email'] = v or None

    # ── Emergency contact ─────────────────────────────────────────────────────
    if 'emergency_contact_name' in body:
        v = _safe_str(body['emergency_contact_name'])[:100]
        updates['emergency_contact_name'] = v or None

    if 'emergency_isd' in body or 'emergency_phone_number' in body:
        isd = _safe_str(body.get('emergency_isd', '+91'))
        num = _safe_str(body.get('emergency_phone_number', ''))
        if isd not in _VALID_ISD:
            errors.append(f"emergency_isd must be one of: {_VALID_ISD}")
        elif num:
            full = _fmt_phone(isd, num)
            if not _validate_phone_num(full):
                errors.append(f"emergency phone invalid: {full}")
            else:
                updates['emergency_contact_phone'] = full
    elif 'emergency_contact_phone' in body:
        v = _safe_str(body['emergency_contact_phone'])
        if v and not _validate_phone_num(v):
            errors.append("emergency_contact_phone must be E.164 format")
        elif v:
            updates['emergency_contact_phone'] = v

    # ── Academy fields ────────────────────────────────────────────────────────
    if 'enrollment_date' in body:
        v = _safe_str(body['enrollment_date'])
        if not v:
            errors.append("enrollment_date cannot be empty")
        elif not _validate_date(v):
            errors.append("enrollment_date must be YYYY-MM-DD")
        else:
            updates['enrollment_date'] = v

    if 'level' in body:
        v = _safe_str(body['level'])
        if v not in _VALID_LEVEL:
            errors.append(f"level must be one of: {_VALID_LEVEL}")
        else:
            updates['level'] = v

    if 'student_type' in body:
        v = _safe_str(body['student_type'])
        if v not in _VALID_STUDENT_TYPE:
            errors.append(f"student_type must be one of: {_VALID_STUDENT_TYPE}")
        else:
            updates['student_type'] = v

    if 'dominant_side' in body:
        v = _safe_str(body['dominant_side'])
        if v and v not in _VALID_DOMINANT_SIDE:
            errors.append(f"dominant_side must be one of: {list(_VALID_DOMINANT_SIDE)}")
        else:
            updates['dominant_side'] = v or None

    if 'kit_size' in body:
        v = _safe_str(body['kit_size'])
        if v and v not in _VALID_KIT_SIZE:
            errors.append(f"kit_size must be one of: {_VALID_KIT_SIZE}")
        else:
            updates['kit_size'] = v or None

    if 'coach_id' in body:
        cid = body['coach_id']
        updates['coach_id'] = _safe_int(cid) if cid else None

    if 'referral_source' in body:
        v = _safe_str(body['referral_source'])
        if v and v not in _VALID_REFERRAL:
            errors.append(f"referral_source must be one of: {_VALID_REFERRAL}")
        else:
            updates['referral_source'] = v or None

    if 'student_category' in body:
        v = _safe_str(body['student_category']).upper()
        if v and v not in _VALID_CATEGORY:
            errors.append(f"student_category must be one of: {_VALID_CATEGORY}")
        else:
            updates['student_category'] = v or None

    # monthly_fee is admin-only — not editable via mobile API
    # if 'monthly_fee' in body: (disabled)

    if 'status' in body:
        v = _safe_str(body['status'])
        if v not in _VALID_STATUS:
            errors.append(f"status must be one of: {_VALID_STATUS}")
        else:
            updates['status'] = v

    # ── Return validation errors before hitting DB ────────────────────────────
    if errors:
        return JSONResponse(
            content={"error": "Validation failed", "details": errors},
            status_code=422,
        )

    if not updates:
        return JSONResponse(
            content={"error": "No valid fields to update"},
            status_code=400,
        )

    # ── Apply updates ─────────────────────────────────────────────────────────
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Verify student exists
        exists = conn.execute(
            "SELECT id, name FROM students WHERE id=?",
            (student_id,),
        ).fetchone()
        if not exists:
            return JSONResponse(content={"error": f"No student with id={student_id}"}, status_code=404)

        fields_sql = ", ".join(f"{col}=?" for col in updates)
        values     = list(updates.values()) + [student_id]
        conn.execute(
            f"UPDATE students SET {fields_sql} WHERE id=?",
            values,
        )
        conn.commit()

        logger.info(
            "xxgs_ [PROFILE-PUT] student_id=%d name='%s' updated=%s user='%s'",
            student_id, exists["name"], list(updates.keys()), auth_user,
        )
        return JSONResponse(content={
            "status":     "success",
            "student_id": student_id,
            "name":       exists["name"],
            "updated":    list(updates.keys()),
            "values":     {k: v for k, v in updates.items()},
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [PROFILE-PUT] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()




# ══════════════════════════════════════════════════════════════════════
# GET /api/data/library — coaching library (public — all roles)
# ══════════════════════════════════════════════════════════════════════
@router.get("/library")
async def api_get_library(
    request:   Request,
    category:  str = Query("",  description="Filter by category"),
    search:    str = Query("",  description="Search title/description", max_length=200),
    limit:     int = Query(10,  ge=1, le=2000),
    offset:    int = Query(0,   ge=0),
    auth_user: str = Depends(verify_api_auth),
):
    """
    Returns coaching library — paginated (default 10 per page).
    Accessible by ALL roles.
    """
    logger.info("xxgs_ [LIBRARY] user='%s' cat='%s' search='%s' limit=%d offset=%d",
                auth_user, category, search, limit, offset)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        where, params = [], []
        if category.strip():
            where.append("category = ?")
            params.append(category.strip())
        if search.strip():
            where.append("(title LIKE ? OR description LIKE ?)")
            like = f"%{search.strip()}%"
            params.extend([like, like])
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        try:
            # Total count for pagination
            total = conn.execute(
                "SELECT COUNT(*) as n FROM coaching_library " + where_sql + "", params
            ).fetchone()["n"]

            rows = conn.execute(f"""
                SELECT video_id, title, description, category, url,
                       IFNULL(url_image, '') AS url_image,
                       IFNULL(views, 0)     AS views,
                       IFNULL(likes, 0)     AS likes,
                       created_at
                FROM coaching_library
                {where_sql}
                ORDER BY category ASC, created_at DESC
                LIMIT ? OFFSET ?
            """, params + [limit, offset]).fetchall()

            cats = conn.execute(
                "SELECT DISTINCT category FROM coaching_library "
                "WHERE category IS NOT NULL ORDER BY category"
            ).fetchall()
        except Exception as tbl_err:
            logger.warning("xxgs_ [LIBRARY] table missing: %s", tbl_err)
            return JSONResponse(content={
                "status": "success", "total": 0, "count": 0,
                "categories": [], "data": []
            })

        return JSONResponse(content={
            "status":     "success",
            "total":      total,
            "count":      len(rows),
            "categories": [r["category"] for r in cats],
            "data":       [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [LIBRARY] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()

# ══════════════════════════════════════════════════════════════════════
# GET /api/data/videos — Academy YouTube channel videos
# Accessible by ALL roles (public content)
# ══════════════════════════════════════════════════════════════════════
@router.get("/videos")
async def api_get_videos(
    request:   Request,
    sort:      str = Query("popular", description="popular | newest | featured"),
    search:    str = Query("",   description="Search title/description", max_length=200),
    limit:     int = Query(200,  ge=1, le=2000),
    offset:    int = Query(0,    ge=0),
    auth_user: str = Depends(verify_api_auth),
):
    """
    Returns academy YouTube channel videos — public for all roles.
    Synced separately by admin via youtube_sync route.
    """
    logger.info("xxgs_ [VIDEOS] user='%s' sort=%s search='%s' limit=%d offset=%d",
                auth_user, sort, search, limit, offset)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        where, params = [], []
        if search.strip():
            where.append("(title LIKE ? OR description LIKE ?)")
            like = f"%{search.strip()}%"
            params.extend([like, like])
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        # Sort
        if sort == "newest":
            order = "ORDER BY published_at DESC"
        elif sort == "featured":
            order = "ORDER BY is_popular DESC, display_order ASC"
        else:  # popular (default)
            order = "ORDER BY display_order ASC, view_count DESC"

        try:
            total = conn.execute(
                "SELECT COUNT(*) as n FROM youtube_videos " + where_sql + "", params
            ).fetchone()["n"]

            rows = conn.execute(f"""
                SELECT video_id, title, description,
                       IFNULL(thumbnail_url, '') AS thumbnail_url,
                       IFNULL(view_count,   0)  AS view_count,
                       IFNULL(is_popular,   0)  AS is_popular,
                       IFNULL(display_order, 9999) AS display_order,
                       published_at
                FROM youtube_videos
                {where_sql}
                {order}
                LIMIT ? OFFSET ?
            """, params + [limit, offset]).fetchall()

        except Exception as tbl_err:
            logger.warning("xxgs_ [VIDEOS] table error: %s", tbl_err)
            return JSONResponse(content={
                "status": "success", "total": 0, "count": 0, "data": []
            })

        return JSONResponse(content={
            "status": "success",
            "total":  total,
            "count":  len(rows),
            "sort":   sort,
            "data":   [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [VIDEOS] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()

# ══════════════════════════════════════════════════════════════════════
# GET  /api/data/contact/info   — academy contact details (all roles)
# POST /api/data/contact/submit — submit enquiry/message
# ══════════════════════════════════════════════════════════════════════

# Compile once — reused per request
import re as _re_contact
import html as _html
_XSS_PATTERN   = _re_contact.compile(
    r'(<\s*script|javascript\s*:|on\w+\s*=|<\s*iframe|<\s*img[^>]+onerror)',
    _re_contact.IGNORECASE
)
_EMAIL_PATTERN = _re_contact.compile(
    r'^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$'
)
_PHONE_PATTERN = _re_contact.compile(r'^[\d\s\+\-\(\)]{7,20}$')

# Per-user contact submission rate limit (in-process, reuses existing _rate_store)
_CONTACT_MAX     = 3     # max submissions
_CONTACT_WINDOW  = 3600  # per hour


def _send_contact_email(name: str, email: str, phone: str,
                        message: str, username: str, category: str = "") -> bool:
    """
    Send contact enquiry via Resend API — identical to web app send_contact_email().
    Env vars: RESEND_API_KEY, ADMIN_EMAIL, RESEND_FROM
    """
    resend_api_key = os.getenv("RESEND_API_KEY")
    admin_email    = os.getenv("ADMIN_EMAIL")
    from_email     = os.getenv("RESEND_FROM", "onboarding@resend.dev")

    if not resend_api_key or not admin_email:
        logger.error("xxgs_ [CONTACT] Resend credentials not configured"
                     " — set RESEND_API_KEY and ADMIN_EMAIL in .env")
        return False

    # Escape all user input before embedding in HTML (prevents stored XSS)
    safe_name     = _html.escape(name)
    safe_email    = _html.escape(email)
    safe_phone    = _html.escape(phone or "Not provided")
    safe_message  = _html.escape(message)
    safe_category = _html.escape(category or "General")
    safe_username = _html.escape(username)

    try:
        html_body = (
            "<html><body style='font-family:Arial,sans-serif;background:#f0f2f5;padding:20px;'>"
            "<div style='max-width:600px;margin:auto;background:white;"
            "border-radius:15px;overflow:hidden;'>"

            # Header
            "<div style='background:#001f3f;color:white;padding:25px;text-align:center;'>"
            "<h2 style='margin:0;color:#c5a059;'>&#127955; New App Enquiry</h2>"
            "<p style='margin:5px 0 0;opacity:0.8;'>Quickies Cricket Academy — Mobile App</p>"
            "</div>"

            # Body table
            "<div style='padding:30px;'>"
            "<table style='width:100%;border-collapse:collapse;'>"
            "<tr><td style='padding:12px;background:#f8f9fa;font-weight:bold;"
            "color:#001f3f;width:30%;'>App User</td>"
            "<td style='padding:12px;'>" + safe_username + "</td></tr>"
            "<tr><td style='padding:12px;font-weight:bold;color:#001f3f;'>Name</td>"
            "<td style='padding:12px;'>" + safe_name + "</td></tr>"
            "<tr><td style='padding:12px;background:#f8f9fa;font-weight:bold;"
            "color:#001f3f;'>Email</td>"
            "<td style='padding:12px;'>" + safe_email + "</td></tr>"
            "<tr><td style='padding:12px;font-weight:bold;color:#001f3f;'>Phone</td>"
            "<td style='padding:12px;'>" + safe_phone + "</td></tr>"
            "<tr><td style='padding:12px;background:#f8f9fa;font-weight:bold;"
            "color:#001f3f;'>Category</td>"
            "<td style='padding:12px;'>" + safe_category + "</td></tr>"
            "<tr><td style='padding:12px;font-weight:bold;color:#001f3f;"
            "vertical-align:top;'>Message</td>"
            "<td style='padding:12px;white-space:pre-wrap;'>" + safe_message + "</td></tr>"
            "</table></div>"

            # Footer
            "<div style='background:#f8f9fa;padding:15px;text-align:center;"
            "font-size:12px;color:#888;'>"
            "Sent from QCA Mobile App"
            "</div></div></body></html>"
        )

        import requests as _requests
        response = _requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": "Bearer " + resend_api_key,
                "Content-Type":  "application/json",
            },
            json={
                "from":     from_email,
                "to":       [admin_email],
                "subject":  "QCA App Enquiry: " + safe_name,
                "html":     html_body,
                "reply_to": safe_email if email else from_email,
            },
            timeout=10,
        )

        if response.status_code in (200, 201):
            logger.info("xxgs_ [CONTACT] Resend OK → %s from user='%s'",
                        admin_email, username)
            return True
        else:
            logger.error("xxgs_ [CONTACT] Resend error %d: %s",
                         response.status_code, response.text[:200])
            return False

    except Exception as exc:
        logger.error("xxgs_ [CONTACT] Resend exception: %s", exc, exc_info=True)
        return False


def _notify_contact(name: str, email: str, phone: str,
                    message: str, username: str, category: str = "") -> None:
    """Wrapper matching web app notify_contact() — called in background thread."""
    email_sent = _send_contact_email(name, email, phone, message, username, category)
    logger.info("xxgs_ [CONTACT] notifications → Resend:%s", email_sent)


def _check_contact_rate(username: str) -> bool:
    """Returns True if rate limit exceeded for contact submissions."""
    key = f"contact:{username.lower()}"
    now = time.monotonic()
    entry = _rate_entry(key)
    if entry.get("blocked_until") and now < entry["blocked_until"]:
        return True
    cutoff      = now - _CONTACT_WINDOW
    entry["ts"] = [t for t in entry["ts"] if t > cutoff]
    if len(entry["ts"]) >= _CONTACT_MAX:
        entry["blocked_until"] = now + _CONTACT_WINDOW
        return True
    entry["ts"].append(now)
    return False


def _ensure_contact_table(conn) -> None:
    """Create contact_messages table if it doesn't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contact_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT    NOT NULL,
            name        TEXT    NOT NULL,
            email       TEXT    NOT NULL,
            phone       TEXT,
            subject     TEXT,
            message     TEXT    NOT NULL,
            category    TEXT    DEFAULT 'General',
            is_read     INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now'))
        )
    """)
    conn.commit()


@router.get("/contact/info")
async def api_contact_info(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Returns academy contact details. Accessible by all roles."""
    require_permission(auth_user, "app:contact")
    return JSONResponse(content={
        "status": "success",
        "data": {
            "name":     os.getenv("ACADEMY_NAME",     "QCA Cricket Academy"),
            "email":    os.getenv("ACADEMY_EMAIL",    ""),
            "phone":    os.getenv("ACADEMY_PHONE",    ""),
            "location": os.getenv("ACADEMY_LOCATION", ""),
            "address":  os.getenv("ACADEMY_ADDRESS",  ""),
            "website":  os.getenv("ACADEMY_WEBSITE",  ""),
            "whatsapp": os.getenv("ACADEMY_WHATSAPP", ""),
            "handle":   os.getenv("ACADEMY_HANDLE",   "@quickiescricket"),
            "hours_morning": os.getenv("ACADEMY_HOURS_MORNING", "6:00 AM – 9:00 AM"),
            "hours_evening": os.getenv("ACADEMY_HOURS_EVENING", "4:00 PM – 7:00 PM"),
            "lat":      float(os.getenv("ACADEMY_LAT", "8.453111")),
            "lng":      float(os.getenv("ACADEMY_LNG", "76.992833")),
            "social": {
                # Strip @ prefix — env may be stored as @handle or handle
                "instagram": os.getenv("ACADEMY_INSTAGRAM", "").lstrip("@"),
                "youtube":   os.getenv("ACADEMY_YOUTUBE",   "").lstrip("@"),
                "facebook":  os.getenv("ACADEMY_FACEBOOK",  "").lstrip("@"),
            },
        },
    })


@router.post("/contact/submit")
async def api_contact_submit(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Submit an enquiry or message. Stored in DB + logs for admin review."""
    require_permission(auth_user, "app:contact")

    # ── Parse body ──────────────────────────────────────────────────
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    name     = str(body.get("name",     "")).strip()[:100]
    email    = str(body.get("email",    "")).strip()[:150]
    phone    = str(body.get("phone",    "")).strip()[:20]
    subject  = str(body.get("subject",  "")).strip()[:150]
    message  = str(body.get("message",  "")).strip()[:1000]
    category = str(body.get("category", "General")).strip()[:50]
    honeypot = str(body.get("website",  ""))  # bot trap

    # ── Bot detection ────────────────────────────────────────────────
    if honeypot:
        logger.warning("xxgs_ [CONTACT] bot detected from '%s'", auth_user)
        return JSONResponse({"success": True})   # silent discard

    # ── Rate limit ───────────────────────────────────────────────────
    if _check_contact_rate(auth_user):
        return JSONResponse(
            {"error": "Too many messages — please wait before sending again"},
            status_code=429
        )

    # ── Required fields ──────────────────────────────────────────────
    if not name:
        return JSONResponse({"error": "Name is required"}, status_code=400)
    if not message or len(message) < 10:
        return JSONResponse({"error": "Message must be at least 10 characters"}, status_code=400)

    # ── Email validation (optional field) ────────────────────────────
    if email and not _EMAIL_PATTERN.match(email):
        return JSONResponse({"error": "Invalid email address"}, status_code=400)

    # ── Phone validation (optional field) ────────────────────────────
    if phone and not _PHONE_PATTERN.match(phone):
        return JSONResponse({"error": "Invalid phone number"}, status_code=400)

    # ── XSS / injection check ────────────────────────────────────────
    for field_val in [name, email, subject, message]:
        if _XSS_PATTERN.search(field_val):
            logger.warning("xxgs_ [CONTACT] XSS attempt from '%s'", auth_user)
            return JSONResponse({"error": "Invalid characters in message"}, status_code=400)

    # ── Category whitelist ───────────────────────────────────────────
    allowed_cats = {"General", "Fees", "Schedule", "Registration",
                    "Feedback", "Complaint", "Technical", "Other"}
    if category not in allowed_cats:
        category = "General"

    # ── Save to DB ───────────────────────────────────────────────────
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_contact_table(conn)
        conn.execute(
            """INSERT INTO contact_messages
               (username, name, email, phone, subject, message, category)
               VALUES (?,?,?,?,?,?,?)""",
            (auth_user, name, email or "", phone or "",
             subject or "", message, category)
        )
        conn.commit()
        msg_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        logger.info(
            "xxgs_ [CONTACT] message #%d from '%s' cat='%s'",
            msg_id, auth_user, category
        )
        # Fire in background thread — same as web app background_tasks.add_task(notify_contact,...)
        import threading
        threading.Thread(
            target=_notify_contact,
            args=(name, email, phone, message, auth_user, category),
            daemon=True,
        ).start()

        return JSONResponse({
            "success": True,
            "message": "Your message has been received. We will get back to you soon.",
            "id":      msg_id,
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [CONTACT] DB error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()
# ══════════════════════════════════════════════════════════════════════
# QUICK STUDENT REGISTRATION — used by mobile auto-register flow
# POST /api/data/students/register
# Accepts minimal fields, returns student_id immediately
# ══════════════════════════════════════════════════════════════════════

# ── Email sending helpers ─────────────────────────────────────────────────────
import smtplib as _smtplib
import html    as _html
from email.mime.multipart import MIMEMultipart as _MIMEMultipart
from email.mime.text      import MIMEText      as _MIMEText

def _reminder_send_zoho(
    to_email: str, subject: str, html_body: str, reply_to: str = ""
) -> tuple:
    """Send email via Zoho SMTP if configured, else skip to Resend."""
    zoho_user = os.getenv("ZOHO_EMAIL",    "").strip()
    zoho_pass = "".join(os.getenv("ZOHO_PASSWORD", "").split())
    zoho_host = os.getenv("ZOHO_SMTP_HOST", "smtp.zoho.com")
    zoho_port = int(os.getenv("ZOHO_SMTP_PORT", "587"))

    # Skip if password not configured — fall through to Resend
    if not zoho_user or not zoho_pass:
        return False, "Zoho password not configured"
    if not to_email:
        return False, "No recipient email"
    try:
        msg = _MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = zoho_user
        msg["To"]      = to_email
        if reply_to:
            msg["Reply-To"] = reply_to
        msg.attach(_MIMEText(html_body, "html", "utf-8"))
        with _smtplib.SMTP(zoho_host, zoho_port, timeout=15) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.login(zoho_user, zoho_pass)
            smtp.sendmail(zoho_user, [to_email], msg.as_string())
        logger.info("xxgs_ [EMAIL-ZOHO] sent to %s subject='%s'", to_email, subject[:50])
        return True, ""
    except Exception as e:
        logger.warning("xxgs_ [EMAIL-ZOHO] failed: %s", e)
        return False, str(e)


def _reminder_send_resend(
    to_email: str, subject: str, html_body: str,
    from_email: str = "", api_key: str = "", reply_to: str = ""
) -> tuple:
    """Send email via Resend API (fallback channel)."""
    key  = api_key  or os.getenv("RESEND_API_KEY",  "").strip()
    frm  = from_email or os.getenv("RESEND_FROM", "onboarding@resend.dev")
    if not key:
        return False, "Resend API key not configured"
    try:
        import requests as _req
        resp = _req.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type":  "application/json"},
            json={"from": frm, "to": [to_email],
                  "subject": subject, "html": html_body},
            timeout=10,
        )
        if resp.status_code in (200, 201):
            logger.info("xxgs_ [EMAIL-RESEND] sent to %s", to_email)
            return True, ""
        return False, f"Resend {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        logger.warning("xxgs_ [EMAIL-RESEND] failed: %s", e)
        return False, str(e)


def _send_email(
    to_email: str, subject: str, html_body: str, reply_to: str = ""
) -> tuple:
    """Try Zoho first, fall back to Resend."""
    ok, err = _reminder_send_zoho(to_email, subject, html_body, reply_to)
    if ok:
        return True, "zoho"
    ok2, err2 = _reminder_send_resend(to_email, subject, html_body)
    if ok2:
        return True, "resend"
    return False, f"Zoho: {err} | Resend: {err2}"


# ══════════════════════════════════════════════════════════════════════════════
# ACADEMY PULSE
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_pulse_table(conn) -> None:
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
    for col, defn in [
        ("is_highlight",         "INTEGER DEFAULT 0"),
        ("cloudinary_public_id", "TEXT DEFAULT ''"),
        ("activity_date",        "TEXT DEFAULT (DATE('now'))"),
    ]:
        try:
            conn.execute(f"ALTER TABLE academy_pulse ADD COLUMN {col} {defn}")
        except Exception:
            pass
    conn.commit()


@router.post("/pulse/init")
async def api_pulse_init(request: Request, auth_user: str = Depends(verify_api_auth)):
    """Signed Cloudinary upload params for pulse. Folder: qca_pulse/{tag}/{YYYY-MM}"""
    require_permission(auth_user, "media:upload")
    if not _cld_ok():
        return JSONResponse({"error": "Cloudinary not configured"}, status_code=503)
    try:
        body          = await request.json()
        resource_type = body.get("resource_type", "image")
        tag_type      = (body.get("tag_type", "Other") or "Other").strip()
        activity_date = (body.get("activity_date", "") or "").strip()
    except Exception:
        resource_type = "image"; tag_type = "Other"; activity_date = ""

    if resource_type not in ("image", "video"):
        return JSONResponse({"error": "resource_type must be image or video"}, status_code=400)

    VALID_TAGS = {"Training", "Match", "Event", "Achievement", "Other"}
    tag_slug   = tag_type if tag_type in VALID_TAGS else "Other"

    try:
        from datetime import datetime as _dt
        ym = _dt.strptime(activity_date[:10], "%Y-%m-%d").strftime("%Y-%m") if activity_date else _dt.now().strftime("%Y-%m")
    except Exception:
        from datetime import datetime as _dt
        ym = _dt.now().strftime("%Y-%m")

    folder      = f"qca_pulse/{tag_slug}/{ym}"
    ts          = int(_time_mod.time())
    sign_params = {"folder": folder, "timestamp": ts}
    signature   = _cld_sign(sign_params)
    upload_url  = f"https://api.cloudinary.com/v1_1/{_CLD_CLOUD}/{resource_type}/upload"

    logger.info("xxgs_ [PULSE] init folder=%s user='%s'", folder, auth_user)
    return JSONResponse({
        "upload_url": upload_url, "api_key": _CLD_KEY,
        "timestamp": ts, "folder": folder,
        "signature": signature, "resource_type": resource_type,
    })


@router.post("/pulse/save")
async def api_pulse_save(request: Request, auth_user: str = Depends(verify_api_auth)):
    """Record a pulse item after Cloudinary upload."""
    require_permission(auth_user, "media:upload")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    public_id     = (body.get("cloudinary_public_id") or "").strip()
    secure_url    = (body.get("secure_url")           or "").strip()
    resource_type = (body.get("resource_type")        or "image").strip()
    caption       = (body.get("caption")              or "")[:200].strip()
    tag_type      = (body.get("tag_type")             or "Training")[:30].strip()
    activity_date = (body.get("activity_date")        or "").strip()
    is_highlight  = int(body.get("is_highlight", 0))

    if not public_id or not secure_url:
        return JSONResponse({"error": "cloudinary_public_id and secure_url required"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_pulse_table(conn)
        existing = conn.execute(
            "SELECT id FROM academy_pulse WHERE cloudinary_public_id=?", (public_id,)
        ).fetchone()
        if existing:
            return JSONResponse({"status": "success", "id": existing["id"], "duplicate": True})

        conn.execute(
            """INSERT INTO academy_pulse
               (secure_url, resource_type, caption, tag_type, activity_date,
                uploaded_by, cloudinary_public_id, is_highlight)
               VALUES (?,?,?,?,?,?,?,?)""",
            (secure_url, resource_type, caption, tag_type,
             activity_date or None, auth_user, public_id, is_highlight)
        )
        new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        logger.info("xxgs_ [PULSE] saved id=%d type=%s user='%s'", new_id, resource_type, auth_user)
        return JSONResponse({"status": "success", "id": new_id})
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [PULSE] save error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/pulse/list")
async def api_pulse_list(
    request:       Request,
    auth_user:     str = Depends(verify_api_auth),
    date_from:     str = Query("",  max_length=10),
    date_to:       str = Query("",  max_length=10),
    tag_type:      str = Query("",  max_length=30),
    resource_type: str = Query("",  max_length=10),
    search:        str = Query("",  max_length=100),
    is_highlight:  int = Query(-1,  ge=-1, le=1),
    limit:         int = Query(500, ge=1, le=500),
    offset:        int = Query(0,   ge=0),
):
    require_permission(auth_user, "media:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_pulse_table(conn)
        where, params = [], []
        if date_from:
            d_to = date_to or date_from
            where.append("DATE(p.activity_date) BETWEEN ? AND ?")
            params.extend([date_from, d_to])
        else:
            where.append("DATE(p.activity_date) >= DATE('now', '-6 days')")
        if tag_type:
            where.append("p.tag_type = ?"); params.append(tag_type)
        if resource_type in ("image", "video"):
            where.append("p.resource_type = ?"); params.append(resource_type)
        if search:
            where.append("(p.caption LIKE ? OR p.uploaded_by LIKE ?)")
            term = f"%{search}%"; params.extend([term, term])
        if is_highlight >= 0:
            where.append("p.is_highlight = ?"); params.append(is_highlight)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        total = conn.execute(f"SELECT COUNT(*) FROM academy_pulse p {where_sql}", params).fetchone()[0]
        rows  = conn.execute(
            f"""SELECT p.id, p.secure_url, p.resource_type, p.caption,
                       p.tag_type, p.activity_date, p.uploaded_by,
                       p.cloudinary_public_id, p.is_highlight, p.created_at
                FROM academy_pulse p {where_sql}
                ORDER BY p.id DESC LIMIT ? OFFSET ?""",
            params + [limit, offset]
        ).fetchall()
        tags = [r[0] for r in conn.execute(
            "SELECT DISTINCT tag_type FROM academy_pulse ORDER BY tag_type"
        ).fetchall() if r[0]]
        return JSONResponse({"status": "success", "total": total, "count": len(rows),
                             "tags": tags, "data": [dict(r) for r in rows]})
    except Exception as exc:
        logger.error("xxgs_ [PULSE] list error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.delete("/pulse/{pulse_id}")
async def api_pulse_delete(request: Request, pulse_id: int, auth_user: str = Depends(verify_api_auth)):
    require_permission(auth_user, "media:delete")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_pulse_table(conn)
        row = conn.execute(
            "SELECT secure_url, cloudinary_public_id, resource_type FROM academy_pulse WHERE id=?",
            (pulse_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Not found"}, status_code=404)

        cld_deleted = False
        pub_id = row["cloudinary_public_id"] or ""
        if _cld_ok() and pub_id:
            try:
                import urllib.request as _urlreq, urllib.parse as _urlp
                rtype = row["resource_type"] or "image"
                ts    = int(_time_mod.time())
                sp    = {"public_id": pub_id, "timestamp": ts}
                sig   = _cld_sign(sp)
                data  = _urlp.urlencode({"public_id": pub_id, "timestamp": ts,
                                          "api_key": _CLD_KEY, "signature": sig}).encode()
                url   = f"https://api.cloudinary.com/v1_1/{_CLD_CLOUD}/{rtype}/destroy"
                req   = _urlreq.Request(url, data=data, method="POST")
                resp  = _urlreq.urlopen(req, timeout=8)
                cld_deleted = _json.loads(resp.read()).get("result") == "ok"
            except Exception as e:
                logger.warning("xxgs_ [PULSE] Cloudinary delete failed: %s", e)

        conn.execute("DELETE FROM academy_pulse WHERE id=?", (pulse_id,))
        conn.commit()
        return JSONResponse({"status": "success", "cloudinary_deleted": cld_deleted})
    except Exception as exc:
        conn.rollback()
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.patch("/pulse/{pulse_id}/highlight")
async def api_pulse_highlight(request: Request, pulse_id: int, auth_user: str = Depends(verify_api_auth)):
    require_permission(auth_user, "media:upload")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_pulse_table(conn)
        row = conn.execute("SELECT is_highlight FROM academy_pulse WHERE id=?", (pulse_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "Not found"}, status_code=404)
        new_val = 0 if row["is_highlight"] else 1
        conn.execute("UPDATE academy_pulse SET is_highlight=? WHERE id=?", (new_val, pulse_id))
        conn.commit()
        return JSONResponse({"status": "success", "is_highlight": new_val})
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# PAYMENT REMINDER HUB
# ══════════════════════════════════════════════════════════════════════════════

def _get_reminder_config(conn) -> dict:
    try:
        rows = conn.execute("SELECT key, value FROM reminder_config").fetchall()
        return {r["key"]: r["value"] for r in rows}
    except Exception:
        return {}

def _save_reminder_config(conn, cfg: dict) -> None:
    for k, v in cfg.items():
        try:
            conn.execute(
                "INSERT OR REPLACE INTO reminder_config (key, value) VALUES (?,?)", (k, v)
            )
        except Exception:
            pass
    conn.commit()


@router.get("/reminders/query")
async def api_reminders_query(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Live query: students with unpaid tuition fees. Permission: payments:alerts"""
    require_permission(auth_user, "payments:alerts")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        from datetime import datetime as _dt, timedelta as _td
        today  = _dt.now()
        months = []
        for i in range(6):
            d = today.replace(day=1)
            for _ in range(i):
                d = (d - _td(days=1)).replace(day=1)
            months.append(d.strftime("%b-%y"))

        students = conn.execute("""
            SELECT id, name, phone, email, parent_name, parent_phone,
                   monthly_fee, enrollment_date, student_type, status
            FROM students
            WHERE student_type = 'Academy'
              AND status NOT IN ('Inactive', 'Left', 'Camp', 'Club Member')
              AND monthly_fee > 0
            ORDER BY name ASC
        """).fetchall()

        data = []
        total_balance = 0
        urgent = 0

        for stu in students:
            sid  = stu["id"]
            mfee = float(stu["monthly_fee"] or 0)
            if mfee <= 0:
                continue

            paid_rows = conn.execute(
                "SELECT billing_month FROM payments WHERE student_id=? AND fee_type_id IN (1,2,15,16) AND status='Paid'",
                (sid,)
            ).fetchall()
            paid_set = {r["billing_month"].strip() for r in paid_rows}

            written_off = set()
            try:
                wo_rows = conn.execute(
                    "SELECT billing_month FROM fee_write_offs WHERE student_id=? AND is_active=1", (sid,)
                ).fetchall()
                written_off = {r["billing_month"].strip() for r in wo_rows}
            except Exception:
                pass

            due_months = [m for m in months if m not in paid_set and m not in written_off]
            if not due_months:
                continue

            balance_due = len(due_months) * mfee

            # Attendance this month — try permanent table first
            current_attendance = 0
            month_start = today.replace(day=1).strftime("%Y-%m-%d")
            try:
                att = conn.execute(
                    "SELECT COUNT(*) as n FROM attendance WHERE student_id=? AND attendance_date >= ?",
                    (sid, month_start)
                ).fetchone()
                current_attendance = att["n"] if att else 0
            except Exception:
                try:
                    att = conn.execute(
                        "SELECT COUNT(*) as n FROM temp_attendance WHERE student_id=? AND date >= ? AND status='PRESENT'",
                        (sid, month_start)
                    ).fetchone()
                    current_attendance = att["n"] if att else 0
                except Exception:
                    current_attendance = 0

            sent_tiers = {}
            try:
                log_rows = conn.execute(
                    "SELECT billing_month, tier FROM reminder_logs WHERE student_id=?", (sid,)
                ).fetchall()
                for lr in log_rows:
                    sent_tiers[lr["billing_month"]] = lr["tier"]
            except Exception:
                pass

            total_balance += balance_due
            if len(due_months) >= 3:
                urgent += 1

            data.append({
                "student_id":         sid,
                "student_name":       stu["name"],
                "parent_name":        stu["parent_name"]  or "",
                "parent_email":       stu["email"]        or "",
                "parent_phone":       stu["phone"]        or "",
                "monthly_fee":        mfee,
                "balance_due":        balance_due,
                "total_unpaid":       len(due_months),
                "due_months":         ", ".join(due_months),
                "enrollment_date":    stu["enrollment_date"] or "",
                "current_attendance": current_attendance,
                "sent_tiers":         sent_tiers,
            })

        logger.info("xxgs_ [REMINDERS] query %d students with dues by '%s'", len(data), auth_user)
        return JSONResponse({
            "status":  "success",
            "count":   len(data),
            "data":    data,
            "summary": {
                "total_accounts":  len(data),
                "total_balance":   total_balance,
                "urgent_accounts": urgent,
            },
        })
    except Exception as exc:
        logger.error("xxgs_ [REMINDERS] query error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.post("/reminders/send_email")
async def api_reminders_send_email(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Send email fee reminder. Permission: payments:alerts"""
    require_permission(auth_user, "payments:alerts")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    student_id    = int(body.get("student_id",    0))
    billing_month = str(body.get("billing_month", "")).strip()
    tier          = int(body.get("tier",          1))
    parent_email  = str(body.get("parent_email",  "")).strip()
    parent_name   = str(body.get("parent_name",   "")).strip()
    student_name  = str(body.get("student_name",  "")).strip()
    balance_due   = float(body.get("balance_due", 0))
    monthly_fee   = float(body.get("monthly_fee", 0))

    if not parent_email:
        return JSONResponse({"error": "No email address on record"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        cfg          = _get_reminder_config(conn)
        academy_name = cfg.get("academy_name", os.getenv("ACADEMY_NAME", "Quickies Cricket Club"))
        upi_vpa      = cfg.get("upi_vpa",      os.getenv("UPI_VPA", ""))
        tier_labels  = ["", "1st Reminder", "2nd Reminder", "Final Notice"]
        tier_label   = tier_labels[min(tier, 3)]

        gpay_link = ""
        if upi_vpa:
            gpay_link = (
                f"https://pay.google.com/gp/p/ui/pay"
                f"?pa={upi_vpa}"
                f"&pn={academy_name.replace(' ', '%20')}"
                f"&am={int(monthly_fee)}&cu=INR"
            )

        subject   = f"Fee {tier_label} — {student_name} — {billing_month} | {academy_name}"
        pay_btn   = (
            f'<p><a href="{gpay_link}" style="background:#4285f4;color:#fff;'
            f'padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">'
            f'Pay via Google Pay</a></p>'
        ) if gpay_link else ""

        html_body = (
            "<html><body style='font-family:Arial,sans-serif;background:#f0f2f5;padding:20px;'>"
            "<div style='max-width:580px;margin:auto;background:#fff;border-radius:15px;overflow:hidden;'>"
            f"<div style='background:#001f3f;color:#fff;padding:24px;text-align:center;'>"
            f"<h2 style='margin:0;color:#c5a059;'>Fee {tier_label}</h2>"
            f"<p style='margin:5px 0 0;opacity:0.7;'>{academy_name}</p></div>"
            f"<div style='padding:28px;'>"
            f"<p>Dear <strong>{parent_name or 'Parent/Guardian'}</strong>,</p>"
            f"<p>This is a <strong>{tier_label.lower()}</strong> for the outstanding fee.</p>"
            "<table style='width:100%;border-collapse:collapse;margin:20px 0;'>"
            f"<tr><td style='padding:10px;background:#f8f9fa;font-weight:bold;color:#001f3f;width:40%;'>Student</td>"
            f"<td style='padding:10px;'>{student_name}</td></tr>"
            f"<tr><td style='padding:10px;font-weight:bold;color:#001f3f;'>Month</td>"
            f"<td style='padding:10px;'><strong>{billing_month}</strong></td></tr>"
            f"<tr><td style='padding:10px;background:#f8f9fa;font-weight:bold;color:#001f3f;'>Amount Due</td>"
            f"<td style='padding:10px;font-weight:bold;font-size:18px;color:#c0392b;'>AED {int(monthly_fee):,}</td></tr>"
            f"<tr><td style='padding:10px;font-weight:bold;color:#001f3f;'>Total Balance</td>"
            f"<td style='padding:10px;color:#c0392b;'>AED {int(balance_due):,}</td></tr>"
            f"</table>{pay_btn}"
            "<p style='color:#666;font-size:13px;'>Please arrange payment at your earliest convenience.</p>"
            f"</div><div style='background:#f8f9fa;padding:15px;text-align:center;font-size:12px;color:#888;'>"
            f"{academy_name} &mdash; Fee Management</div></div></body></html>"
        )

        # Send via Resend API — key from reminder_config first, then .env
        # Check if email is enabled via toggle
        if cfg.get("email_enabled", "1") == "0":
            return JSONResponse({"error": "Email notifications are disabled in settings"}, status_code=400)

        # Send via Zoho first (primary), fallback to Resend
        ok, channel = _send_email(parent_email, subject, html_body, reply_to=parent_email)
        err = "" if ok else channel

        try:
            conn.execute(
                "INSERT OR REPLACE INTO reminder_logs (student_id,billing_month,tier,email_ok,sent_at) VALUES (?,?,?,?,datetime('now'))",
                (student_id, billing_month, tier, 1 if ok else 0)
            )
            conn.commit()
        except Exception:
            pass

        logger.info("xxgs_ [REMINDERS] email ok=%s channel=%s student=%d month=%s tier=%d", ok, channel, student_id, billing_month, tier)
        if ok:
            return JSONResponse({"success": True, "message": f"Email sent to {parent_email}", "channel": channel})
        return JSONResponse({"error": err or "Email send failed", "hint": "Check ZOHO_EMAIL/ZOHO_PASSWORD in .env"}, status_code=502)
    except Exception as exc:
        logger.error("xxgs_ [REMINDERS] email error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.post("/reminders/send_wa")
async def api_reminders_send_wa(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Send WhatsApp fee reminder. Permission: payments:alerts"""
    require_permission(auth_user, "payments:alerts")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    student_id    = int(body.get("student_id",    0))
    billing_month = str(body.get("billing_month", "")).strip()
    tier          = int(body.get("tier",          1))
    parent_name   = str(body.get("parent_name",   "")).strip()
    student_name  = str(body.get("student_name",  "")).strip()
    balance_due   = float(body.get("balance_due", 0))

    wa_token    = os.getenv("META_WA_TOKEN",    "").strip()
    wa_phone_id = os.getenv("META_WA_PHONE_ID", "").strip()
    if not wa_token or not wa_phone_id:
        return JSONResponse({"error": "WhatsApp not configured"}, status_code=503)

    # Check toggle
    conn_chk = get_db_connection(); conn_chk.row_factory = sqlite3.Row
    try:
        _wa_cfg = _get_reminder_config(conn_chk)
        if _wa_cfg.get("wa_enabled", "1") == "0":
            conn_chk.close()
            return JSONResponse({"error": "WhatsApp notifications are disabled in settings"}, status_code=400)
    finally:
        conn_chk.close()

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        stu = conn.execute("SELECT phone FROM students WHERE id=?", (student_id,)).fetchone()
        if not stu or not stu["phone"]:
            return JSONResponse({"error": "No phone number on record"}, status_code=400)

        cfg          = _get_reminder_config(conn)
        academy_name = cfg.get("academy_name", os.getenv("ACADEMY_NAME", "Quickies Cricket Club"))
        tier_labels  = ["", "1st Reminder", "2nd Reminder", "Final Notice"]
        tier_icons   = ["", "\U0001f4e9", "\U0001f4e8", "\U0001f6a8"]
        tier_label   = tier_labels[min(tier, 3)]
        tier_icon    = tier_icons[min(tier, 3)]

        # Send WhatsApp via Meta Cloud API
        phone_clean = "".join(c for c in str(stu["phone"]) if c.isdigit())
        try:
            import urllib.request as _urlreq, json as _json
            _NL    = chr(10)
            wa_msg = _NL.join([
                f"{tier_icon} *Fee {tier_label}*",
                f"*{academy_name}*",
                "",
                f"Dear {parent_name or 'Parent/Guardian'},",
                "",
                f"Student    : *{student_name}*",
                f"Month      : *{billing_month}*",
                f"Amount Due : *AED {int(balance_due):,}*",
                "",
                "Please arrange payment at your earliest convenience.",
                f"_{academy_name}_",
            ])
            wa_payload = _json.dumps({
                "messaging_product": "whatsapp",
                "to":   phone_clean,
                "type": "text",
                "text": {"body": wa_msg},
            }).encode()
            wa_req  = _urlreq.Request(
                f"https://graph.facebook.com/v18.0/{wa_phone_id}/messages",
                data    = wa_payload,
                headers = {"Authorization": f"Bearer {wa_token}",
                           "Content-Type":  "application/json"},
                method  = "POST",
            )
            wa_resp = _urlreq.urlopen(wa_req, timeout=10)
            ok      = wa_resp.status in (200, 201)
            err     = "" if ok else f"Meta API HTTP {wa_resp.status}"
        except Exception as e_wa:
            ok, err = False, str(e_wa)

        try:
            conn.execute(
                "INSERT OR REPLACE INTO reminder_logs (student_id,billing_month,tier,whatsapp_ok,sent_at) VALUES (?,?,?,?,datetime('now'))",
                (student_id, billing_month, tier, 1 if ok else 0)
            )
            conn.commit()
        except Exception:
            pass

        logger.info("xxgs_ [REMINDERS] WA ok=%s student=%d month=%s tier=%d", ok, student_id, billing_month, tier)
        if ok:
            return JSONResponse({"success": True})
        if "131030" in str(err):
            err = "Number not in Meta whitelist"
        return JSONResponse({"error": err}, status_code=502)
    except Exception as exc:
        logger.error("xxgs_ [REMINDERS] WA error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/reminders/config")
async def api_reminders_config_get(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "payments:alerts")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        return JSONResponse({"status": "success", "config": _get_reminder_config(conn)})
    finally:
        conn.close()


@router.post("/reminders/config")
async def api_reminders_config_save(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    require_permission(auth_user, "payments:alerts")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Save all config keys — includes email_from, resend_key, email_enabled, wa_enabled
        _save_reminder_config(conn, {k: str(v) for k, v in body.items() if isinstance(v, (str, int, bool))})
        return JSONResponse({"success": True})
    except Exception as exc:
        logger.error("xxgs_ [REMINDERS] config save error: %s", exc)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


def _next_receipt_no(cursor) -> str:
    """
    Generate next receipt number — always safe, never duplicates.
    
    Algorithm:
      1. Get MAX receipt number from actual payments table (source of truth)
      2. Get sys_counters next_value
      3. Use whichever is GREATER (counter self-heals after restore/crash)
      4. Update counter to new_value + 1 (ready for next call)
    
    This means the counter can NEVER go backwards and duplicates are impossible
    even if the web app creates payments outside this API.
    """
    # Source of truth: max receipt from actual payments
    row = cursor.execute(
        "SELECT MAX(CAST(SUBSTR(receipt_no, 5) AS INTEGER)) AS m "
        "FROM payments WHERE receipt_no LIKE 'REC-%'"
    ).fetchone()
    payments_max = (row["m"] or 0) if row else 0

    # Counter value
    c = cursor.execute(
        "SELECT next_value FROM sys_counters WHERE counter_name='receipt_no'"
    ).fetchone()
    counter_val = (c["next_value"] or 0) if c else 0

    # Always use the greater of the two
    next_num = max(payments_max, counter_val) + 1

    # Reset counter to current reality + 1
    if c:
        cursor.execute(
            "UPDATE sys_counters SET next_value=? WHERE counter_name='receipt_no'",
            (next_num + 1,)
        )
    else:
        cursor.execute(
            "INSERT INTO sys_counters (counter_name, next_value) VALUES ('receipt_no', ?)",
            (next_num + 1,)
        )
    return f"REC-{next_num}"


# ══════════════════════════════════════════════════════════════════════════════
# FEE WRITE-OFFS & BULK PAYMENT
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_write_offs_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fee_write_offs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id       INTEGER NOT NULL,
            billing_month    TEXT    NOT NULL,
            amount           REAL    NOT NULL DEFAULT 0,
            reason           TEXT    NOT NULL DEFAULT 'Other',
            remarks          TEXT    DEFAULT '',
            approved_by      TEXT    NOT NULL,
            created_at       TEXT    DEFAULT (CURRENT_TIMESTAMP),
            reversed_at      TEXT    DEFAULT NULL,
            reversed_by      TEXT    DEFAULT NULL,
            reversal_reason  TEXT    DEFAULT NULL,
            is_active        INTEGER DEFAULT 1,
            FOREIGN KEY (student_id) REFERENCES students(id),
            UNIQUE(student_id, billing_month)
        )
    """)
    for col, defn in [
        ("reversed_at",     "TEXT DEFAULT NULL"),
        ("reversed_by",     "TEXT DEFAULT NULL"),
        ("reversal_reason", "TEXT DEFAULT NULL"),
        ("is_active",       "INTEGER DEFAULT 1"),
    ]:
        try:
            conn.execute(f"ALTER TABLE fee_write_offs ADD COLUMN {col} {defn}")
        except Exception:
            pass
    conn.commit()


@router.post("/payments/bulk-record")
async def api_bulk_record_payment(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Record multiple monthly tuition payments in one call. One receipt per month."""
    require_permission(auth_user, "payments:add")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    student_id       = int(body.get("student_id",        0))
    months           = body.get("months",                [])
    amount_per_month = float(body.get("amount_per_month", 0))
    mode             = str(body.get("mode",              "Cash")).strip()
    payment_date     = str(body.get("payment_date",      "")).strip()
    category_id      = int(body.get("category_id",       16))  # 16 = Monthly Tuition Fee

    if not student_id or not months or amount_per_month <= 0 or not payment_date:
        return JSONResponse({"error": "student_id, months, amount_per_month, payment_date required"}, status_code=400)
    if not isinstance(months, list) or len(months) == 0:
        return JSONResponse({"error": "months must be a non-empty list"}, status_code=400)
    if len(months) > 24:
        return JSONResponse({"error": "Maximum 24 months per bulk record"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    results = []
    try:
        stu = conn.execute(
            "SELECT name, phone, email, parent_name FROM students WHERE id=?", (student_id,)
        ).fetchone()
        if not stu:
            return JSONResponse({"error": "Student not found"}, status_code=404)

        cat = conn.execute("SELECT name FROM account_categories WHERE id=?", (category_id,)).fetchone()
        category_name = cat["name"] if cat else "Monthly Tuition Fee"
        acc = conn.execute("SELECT id FROM accounts WHERE student_id=? LIMIT 1", (student_id,)).fetchone()
        account_id = acc["id"] if acc else None

        for billing_month in months:
            billing_month = billing_month.strip()
            dup = conn.execute(
                "SELECT receipt_no FROM payments WHERE student_id=? AND fee_type_id=? AND billing_month=? LIMIT 1",
                (student_id, category_id, billing_month)
            ).fetchone()
            if dup:
                results.append({"month": billing_month, "status": "duplicate", "receipt_no": dup["receipt_no"]})
                continue

            receipt_no = _next_receipt_no(conn)

            try:
                from datetime import datetime as _dt
                full_month = _dt.strptime(billing_month, "%b-%y").strftime("%B %Y")
            except Exception:
                full_month = billing_month
            note = f"Monthly Tuition Fee for {full_month} (Amt: {int(amount_per_month)}) - Method: {mode}"

            conn.execute(
                """INSERT INTO payments
                   (student_id, fee_type_id, amount_paid, payment_date,
                    payment_mode, billing_month, account_id, txn_direction,
                    remarks, status, receipt_no)
                   VALUES (?,?,?,?,?,?,?,?,?,'Paid',?)""",
                (student_id, category_id, amount_per_month, payment_date,
                 mode, billing_month, account_id, "IN", note, receipt_no)
            )
            results.append({"month": billing_month, "status": "recorded", "receipt_no": receipt_no, "amount": amount_per_month})
            logger.info("xxgs_ [BULK-PAY] %s student=%d month=%s by='%s'", receipt_no, student_id, billing_month, auth_user)

        conn.commit()
        recorded = [r for r in results if r["status"] == "recorded"]

        # Email receipt — best effort, never blocks payment recording
        # Check reminder_config table first (set from mobile settings), then .env fallback
        _email_cfg = _get_reminder_config(conn)
        _email_enabled = _email_cfg.get("email_enabled", "1") == "1"  # respects toggle
        _resend_key    = _email_cfg.get("resend_key", "") or os.getenv("RESEND_API_KEY", "")
        _from_email    = _email_cfg.get("email_from", "") or os.getenv("RESEND_FROM", "onboarding@resend.dev")
        _acad_name     = _email_cfg.get("academy_name", "") or os.getenv("ACADEMY_NAME", "Quickies Cricket Club")
        if recorded and stu["email"] and _email_enabled:
            def _send():
                try:
                    import requests as _req
                    acad = _acad_name
                    months_str  = ", ".join(r["month"]      for r in recorded)
                    receipts    = ", ".join(r["receipt_no"] for r in recorded)
                    total_amt   = sum(r["amount"]           for r in recorded)
                    subject     = f"Fee Receipt — {stu['name']} — {months_str} | {acad}"
                    rows_html   = "".join(
                        f"<tr><td style='padding:8px;border:1px solid #e5e7eb;'>{r['month']}</td>"
                        f"<td style='padding:8px;border:1px solid #e5e7eb;'>{r['receipt_no']}</td>"
                        f"<td style='padding:8px;border:1px solid #e5e7eb;font-weight:bold;'>AED {int(r['amount']):,}</td></tr>"
                        for r in recorded
                    )
                    html = (
                        f"<html><body style='font-family:Arial,sans-serif;'>"
                        f"<div style='max-width:520px;margin:auto;padding:24px;'>"
                        f"<h2 style='color:#001f3f;'>Fee Receipt — {acad}</h2>"
                        f"<p>Dear {stu['parent_name'] or 'Parent/Guardian'},</p>"
                        f"<p>Payment received for <strong>{stu['name']}</strong>.</p>"
                        f"<table style='width:100%;border-collapse:collapse;margin:16px 0;'>"
                        f"<tr style='background:#001f3f;color:#fff;'>"
                        f"<th style='padding:10px;text-align:left;'>Month</th>"
                        f"<th style='padding:10px;text-align:left;'>Receipt</th>"
                        f"<th style='padding:10px;text-align:left;'>Amount</th></tr>"
                        f"{rows_html}</table>"
                        f"<p><strong>Total Paid: AED {int(total_amt):,}</strong>"
                        f" &nbsp;·&nbsp; Mode: {mode} &nbsp;·&nbsp; Date: {payment_date}</p>"
                        f"<p style='color:#666;font-size:12px;'>Thank you for your payment. "
                        f"Please keep this email as your receipt.</p>"
                        f"<p style='color:#888;font-size:11px;border-top:1px solid #e5e7eb;"
                        f"padding-top:12px;margin-top:16px;'>— {acad} Fee Management</p>"
                        f"</div></body></html>"
                    )
                    ok_e, ch_e = _send_email(stu["email"], subject, html)
                    logger.info("xxgs_ [BULK-PAY] email ok=%s channel=%s to=%s", ok_e, ch_e, stu["email"])
                except Exception as e_err:
                    logger.warning("xxgs_ [BULK-PAY] email failed (non-critical): %s", e_err)
            import threading
            threading.Thread(target=_send, daemon=True).start()

        return JSONResponse({
            "status": "success", "total": len(results),
            "recorded": len(recorded),
            "duplicates": len([r for r in results if r["status"] == "duplicate"]),
            "results": results,
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [BULK-PAY] error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.post("/write-offs/bulk-create")
async def api_bulk_write_off(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """Write off multiple billing months. Admin only. Soft-deletable audit trail."""
    require_permission(auth_user, "payments:add")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    student_id       = int(body.get("student_id",        0))
    months           = body.get("months",                [])
    amount_per_month = float(body.get("amount_per_month", 0))
    reason           = str(body.get("reason",            "Other")).strip()
    remarks          = str(body.get("remarks",           ""))[:500].strip()

    VALID_REASONS = ["Financial Hardship","Long Absence","Management Decision","Scholarship / Sponsored","Other"]
    if reason not in VALID_REASONS:
        reason = "Other"
    if reason == "Other" and not remarks:
        return JSONResponse({"error": "Remarks mandatory when reason is Other"}, status_code=400)
    if not student_id or not months or amount_per_month <= 0:
        return JSONResponse({"error": "student_id, months and amount_per_month required"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    results = []
    try:
        _ensure_write_offs_table(conn)
        u = conn.execute("SELECT role FROM users WHERE username=? AND is_active=1", (auth_user,)).fetchone()
        if not u or u["role"] != "Admin":
            return JSONResponse({"error": "Write-offs require Admin role"}, status_code=403)

        stu = conn.execute("SELECT name FROM students WHERE id=?", (student_id,)).fetchone()
        if not stu:
            return JSONResponse({"error": "Student not found"}, status_code=404)

        for billing_month in months:
            billing_month = billing_month.strip()
            existing = conn.execute(
                "SELECT id FROM fee_write_offs WHERE student_id=? AND billing_month=? AND is_active=1",
                (student_id, billing_month)
            ).fetchone()
            if existing:
                results.append({"month": billing_month, "status": "already_written_off", "id": existing["id"]})
                continue

            conn.execute(
                """INSERT INTO fee_write_offs
                   (student_id, billing_month, amount, reason, remarks, approved_by, is_active)
                   VALUES (?,?,?,?,?,?,1)
                   ON CONFLICT(student_id, billing_month)
                   DO UPDATE SET
                       amount      = excluded.amount,
                       reason      = excluded.reason,
                       remarks     = excluded.remarks,
                       approved_by = excluded.approved_by,
                       is_active   = 1,
                       reversed_at = NULL,
                       reversed_by = NULL,
                       reversal_reason = NULL""",
                (student_id, billing_month, amount_per_month, reason, remarks, auth_user)
            )
            wo_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            results.append({"month": billing_month, "status": "written_off", "id": wo_id})
            logger.info("xxgs_ [WRITE-OFF] WO-%d student=%d month=%s reason='%s' by='%s'",
                        wo_id, student_id, billing_month, reason, auth_user)

        conn.commit()
        return JSONResponse({
            "status": "success", "total": len(results),
            "written_off": len([r for r in results if r["status"] == "written_off"]),
            "skipped": len([r for r in results if r["status"] == "already_written_off"]),
            "results": results,
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [WRITE-OFF] create error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.patch("/write-offs/{wo_id}/reverse")
async def api_reverse_write_off(
    request:   Request,
    wo_id:     int,
    auth_user: str = Depends(verify_api_auth),
):
    """Soft-delete (reverse) a write-off. Month returns to Unpaid. Admin only."""
    require_permission(auth_user, "payments:add")
    try:
        body            = await request.json()
        reversal_reason = str(body.get("reversal_reason", "")).strip()
    except Exception:
        reversal_reason = ""
    if not reversal_reason:
        return JSONResponse({"error": "reversal_reason is required"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_write_offs_table(conn)
        row = conn.execute("SELECT * FROM fee_write_offs WHERE id=?", (wo_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "Write-off not found"}, status_code=404)
        if not row["is_active"]:
            return JSONResponse({"error": "Already reversed"}, status_code=409)
        u = conn.execute("SELECT role FROM users WHERE username=? AND is_active=1", (auth_user,)).fetchone()
        if not u or u["role"] != "Admin":
            return JSONResponse({"error": "Admin role required"}, status_code=403)

        from datetime import datetime as _dt
        conn.execute(
            "UPDATE fee_write_offs SET is_active=0, reversed_at=?, reversed_by=?, reversal_reason=? WHERE id=?",
            (_dt.now().isoformat(), auth_user, reversal_reason, wo_id)
        )
        conn.commit()
        logger.info("xxgs_ [WRITE-OFF] reversed WO-%d month=%s by='%s'",
                    wo_id, row["billing_month"], auth_user)
        return JSONResponse({
            "status": "success",
            "message": f"Write-off for {row['billing_month']} reversed — month is now Unpaid",
            "month": row["billing_month"], "wo_id": wo_id,
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [WRITE-OFF] reverse error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/write-offs/student/{student_id}")
async def api_get_student_write_offs(
    request:          Request,
    student_id:       int,
    auth_user:        str = Depends(verify_api_auth),
    include_reversed: int = 0,
):
    """All write-offs for a student with full audit trail."""
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_write_offs_table(conn)
        where = "WHERE student_id=?" + ("" if include_reversed else " AND is_active=1")
        rows = conn.execute(
            f"SELECT * FROM fee_write_offs {where} ORDER BY billing_month DESC", [student_id]
        ).fetchall()
        return JSONResponse({"status": "success", "count": len(rows), "data": [dict(r) for r in rows]})
    finally:
        conn.close()


@router.get("/write-offs/report")
async def api_write_offs_report(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    date_from: str = "",
    date_to:   str = "",
    is_active: int = 1,
    reason:    str = "",
):
    """Full write-offs report for admin."""
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_write_offs_table(conn)
        where, params = ["wo.is_active=?"], [is_active]
        if date_from: where.append("wo.created_at >= ?"); params.append(date_from)
        if date_to:   where.append("wo.created_at <= ?"); params.append(date_to + " 23:59:59")
        if reason:    where.append("wo.reason = ?");      params.append(reason)
        rows = conn.execute(f"""
            SELECT wo.*, s.name as student_name, s.monthly_fee
            FROM fee_write_offs wo JOIN students s ON s.id = wo.student_id
            WHERE {' AND '.join(where)} ORDER BY wo.created_at DESC
        """, params).fetchall()
        return JSONResponse({
            "status": "success", "count": len(rows),
            "total_amount": sum(r["amount"] for r in rows),
            "data": [dict(r) for r in rows],
        })
    finally:
        conn.close()


@router.get("/write-offs/months/{student_id}")
async def api_get_written_off_months(
    request:    Request,
    student_id: int,
    auth_user:  str = Depends(verify_api_auth),
):
    """Active written-off billing months for one student."""
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_write_offs_table(conn)
        rows = conn.execute(
            "SELECT id, billing_month, amount, reason, remarks, approved_by, created_at "
            "FROM fee_write_offs WHERE student_id=? AND is_active=1 ORDER BY billing_month DESC",
            (student_id,)
        ).fetchall()
        return JSONResponse({"status": "success", "months": [dict(r) for r in rows]})
    finally:
        conn.close()


@router.post("/write-offs/bulk-months")
async def api_get_bulk_written_off_months(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """
    Get active write-offs for multiple students in ONE call.
    Pass {"student_ids": [1034, 1127, ...]}
    Returns {"data": {student_id: [{id, billing_month, ...}]}}
    Avoids N separate requests from the AttendeePaymentSheet.
    """
    require_permission(auth_user, "payments:view")
    try:
        body        = await request.json()
        student_ids = [int(i) for i in body.get("student_ids", [])]
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    if not student_ids:
        return JSONResponse({"status": "success", "data": {}})
    if len(student_ids) > 500:
        return JSONResponse({"error": "Maximum 500 student IDs per request"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_write_offs_table(conn)
        placeholders = ",".join("?" * len(student_ids))
        rows = conn.execute(
            f"SELECT id, student_id, billing_month, amount, reason, remarks, approved_by, created_at "
            f"FROM fee_write_offs WHERE student_id IN ({placeholders}) AND is_active=1 "
            f"ORDER BY billing_month DESC",
            student_ids
        ).fetchall()

        # Group by student_id
        result: dict = {str(sid): [] for sid in student_ids}
        for r in rows:
            result[str(r["student_id"])].append(dict(r))

        return JSONResponse({"status": "success", "data": result})
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# BACKGROUND SYNC ENDPOINTS
# Source of Truth: Server DB
# Strategy:
#   students    → WHERE updated_at > since (handles updates + new)
#   payments    → WHERE id > since_id (append-only)
#   attendance  → WHERE id > since_id (append-only)
#   write_offs  → WHERE id > since_id OR updated_at > since (append + reversals)
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/sync/status")
async def api_sync_status(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """
    One call returns max IDs / latest timestamps for all syncable tables.
    App compares with local maxes to decide what needs pulling.
    """
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Students — use updated_at (mutable records)
        stu = conn.execute(
            "SELECT COUNT(*) as cnt, MAX(id) as max_id, "
            "MAX(COALESCE(updated_at, '')) as last_updated "
            "FROM students"
        ).fetchone()

        # Payments — append-only, use max id
        pay = conn.execute(
            "SELECT COUNT(*) as cnt, MAX(id) as max_id FROM payments"
        ).fetchone()

        # Attendance — detect column names
        att_cols = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col = "attendance_date" if "attendance_date" in att_cols else "date"
        att = conn.execute(
            f"SELECT COUNT(*) as cnt, MAX(id) as max_id, "
            f"MAX({date_col}) as latest_date FROM attendance"
        ).fetchone()

        # Write-offs — append + soft deletes
        wo_max = 0
        wo_cnt = 0
        wo_updated = ""
        try:
            wo = conn.execute(
                "SELECT COUNT(*) as cnt, MAX(id) as max_id, "
                "MAX(COALESCE(reversed_at, created_at, '')) as last_updated "
                "FROM fee_write_offs"
            ).fetchone()
            wo_max     = wo["max_id"]  or 0
            wo_cnt     = wo["cnt"]     or 0
            wo_updated = wo["last_updated"] or ""
        except Exception:
            pass

        return JSONResponse({
            "status": "success",
            "students": {
                "count":        stu["cnt"]          or 0,
                "max_id":       stu["max_id"]        or 0,
                "last_updated": stu["last_updated"]  or "",
            },
            "payments": {
                "count":  pay["cnt"]    or 0,
                "max_id": pay["max_id"] or 0,
            },
            "attendance": {
                "count":       att["cnt"]         or 0,
                "max_id":      att["max_id"]       or 0,
                "latest_date": att["latest_date"]  or "",
            },
            "write_offs": {
                "count":        wo_cnt,
                "max_id":       wo_max,
                "last_updated": wo_updated,
            },
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] status error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── GET /api/data/sync/attendance/recent ─────────────────────────────────────
@router.get("/sync/attendance/recent")
async def api_sync_attendance_recent(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    days:      int = Query(7, ge=1, le=30),
):
    """
    Returns session summaries + all student IDs for last N days.
    Used by mobile 7-day reconcile sync — handles both additions and deletions.
    One call returns everything needed to reconcile local attendance.
    """
    require_permission(auth_user, "attendance:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        ctx = get_user_context(auth_user)

        # Detect column names
        att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"

        # Build date restriction
        from datetime import datetime as _dt, timedelta as _td
        cutoff = (_dt.now() - _td(days=days)).strftime("%Y-%m-%d")

        where  = [f"{date_col} >= ?"]
        params = [cutoff]

        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse({"status":"success","sessions":[]})
            ph = ",".join("?" * len(linked))
            where.append(f"student_id IN ({ph})")
            params.extend(linked)

        where_sql = "WHERE " + " AND ".join(where)

        # Get all rows for last N days
        # Only present rows — no absent data stored or synced
        rows = conn.execute(
            f"""SELECT id, student_id, {date_col} AS date, {session_col} AS session
                FROM attendance {where_sql}
                  AND status IN ('Present','PRESENT','1')
                ORDER BY {date_col} DESC, {session_col}, student_id""",
            params
        ).fetchall()

        # Group by (date, session)
        from collections import defaultdict
        sessions: dict = defaultdict(lambda: {"ids": [], "student_ids": []})
        for r in rows:
            key = f"{r['date']}|{r['session']}"
            sessions[key]["date"]    = r["date"]
            sessions[key]["session"] = r["session"]
            sessions[key]["ids"].append(r["id"])
            sessions[key]["student_ids"].append(r["student_id"])

        result = [
            {
                "date":        v["date"],
                "session":     v["session"],
                "count":       len(v["ids"]),
                "ids":         v["ids"],
                "student_ids": v["student_ids"],
            }
            for v in sessions.values()
        ]

        logger.info("xxgs_ [SYNC] attendance/recent days=%d sessions=%d user='%s'",
                    days, len(result), auth_user)
        return JSONResponse({
            "status":   "success",
            "days":     days,
            "sessions": result,
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] attendance/recent error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── GET /api/data/sync/attendance/fetch ──────────────────────────────────────
@router.get("/sync/attendance/fetch")
async def api_sync_attendance_fetch(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    ids:       str = Query("", description="Comma-separated attendance IDs to fetch"),
):
    """
    Fetch full attendance rows for specific IDs.
    Used after reconcile identifies missing rows locally.
    """
    require_permission(auth_user, "attendance:view")
    if not ids.strip():
        return JSONResponse({"status":"success","count":0,"data":[]})

    id_list = [int(i.strip()) for i in ids.split(",") if i.strip().isdigit()]
    if not id_list:
        return JSONResponse({"status":"success","count":0,"data":[]})
    if len(id_list) > 1000:
        return JSONResponse({"error":"Maximum 1000 IDs per request"}, status_code=400)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"
        ph          = ",".join("?" * len(id_list))

        # Only return present rows — no absent data ever downloaded
        rows = conn.execute(
            f"""SELECT id, student_id,
                       {date_col}    AS attendance_date,
                       {session_col} AS session_type,
                       1             AS status,
                       uploaded_by
                FROM attendance
                WHERE id IN ({ph})
                  AND status IN ('Present','PRESENT','1')
                ORDER BY id""",
            id_list
        ).fetchall()

        return JSONResponse({
            "status": "success",
            "count":  len(rows),
            "data":   [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] attendance/fetch error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/sync/students")
async def api_sync_students(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    since:     str = Query("", description="ISO timestamp — return students updated after this"),
    since_id:  int = Query(0,  description="Return students with id > this (for new only)"),
    limit:     int = Query(500, ge=1, le=500),
):
    """
    Pull students changed since a timestamp OR with id > since_id.
    Returns both updated existing + new students in one query.
    Server is source of truth — local must upsert by id.
    """
    require_permission(auth_user, "student:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        ctx = get_user_context(auth_user)
        where, params = [], []

        if since:
            where.append(
                "(COALESCE(updated_at, '') > ? OR id > ?)"
            )
            params.extend([since, since_id])
        elif since_id > 0:
            where.append("id > ?")
            params.append(since_id)

        # Data isolation
        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse({"status":"success","count":0,"data":[]})
            ph = ",".join("?" * len(linked))
            where.append(f"id IN ({ph})")
            params.extend(linked)

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        rows = conn.execute(
            f"""SELECT id, name, level, status, phone, email, age,
                       parent_name, parent_phone, school_name, blood_group,
                       dominant_side, student_type, student_category,
                       monthly_fee, date_of_birth, profile_image,
                       enrollment_date, gender, current_grade,
                       COALESCE(updated_at, '') AS updated_at
                FROM students {where_sql}
                ORDER BY id ASC LIMIT ?""",
            params + [limit]
        ).fetchall()

        logger.info("xxgs_ [SYNC] students %d rows since='%s' user='%s'",
                    len(rows), since, auth_user)
        return JSONResponse({
            "status": "success",
            "count":  len(rows),
            "data":   [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] students error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/sync/payments")
async def api_sync_payments(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    since_id:  int = Query(0,   ge=0),
    limit:     int = Query(500, ge=1, le=500),
):
    """
    Pull payments with id > since_id (append-only table).
    Server is source of truth.
    """
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        ctx = get_user_context(auth_user)
        where  = ["id > ?"]
        params = [since_id]

        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse({"status":"success","count":0,"data":[]})
            ph = ",".join("?" * len(linked))
            where.append(f"student_id IN ({ph})")
            params.extend(linked)

        rows = conn.execute(
            f"""SELECT id, student_id, fee_type_id, amount_paid, payment_date,
                       payment_mode, billing_month, receipt_no, status,
                       remarks, account_id, txn_direction
                FROM payments
                WHERE {' AND '.join(where)}
                ORDER BY id ASC LIMIT ?""",
            params + [limit]
        ).fetchall()

        logger.info("xxgs_ [SYNC] payments %d rows since_id=%d user='%s'",
                    len(rows), since_id, auth_user)
        return JSONResponse({
            "status":   "success",
            "count":    len(rows),
            "has_more": len(rows) == limit,
            "data":     [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] payments error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/sync/attendance")
async def api_sync_attendance(
    request:        Request,
    auth_user:      str = Depends(verify_api_auth),
    since_id:       int = Query(0,   ge=0),
    limit:          int = Query(500, ge=1, le=500),
    present_only:   int = Query(0,   ge=0, le=1,
                        description="1 = return only Present rows (for student/parent sync)"),
):
    """Pull attendance rows with id > since_id from permanent table."""
    require_permission(auth_user, "attendance:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        ctx      = get_user_context(auth_user)
        att_cols = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"

        where  = ["id > ?"]
        params = [since_id]

        # Restricted users (student/parent): only their own linked students
        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse({"status":"success","count":0,"data":[]})
            ph = ",".join("?" * len(linked))
            where.append(f"student_id IN ({ph})")
            params.extend(linked)

        # present_only=1: skip absent rows (student/parent only need present)
        if present_only:
            where.append("status IN ('Present','PRESENT','1')")

        rows = conn.execute(
            f"""SELECT id, student_id,
                       {date_col}    AS attendance_date,
                       {session_col} AS session_type,
                       CASE WHEN status IN ('Present','PRESENT','1') THEN 1 ELSE 0 END AS status,
                       uploaded_by
                FROM attendance
                WHERE {' AND '.join(where)}
                ORDER BY id ASC LIMIT ?""",
            params + [limit]
        ).fetchall()

        logger.info("xxgs_ [SYNC] attendance %d rows since_id=%d user='%s'",
                    len(rows), since_id, auth_user)
        return JSONResponse({
            "status":   "success",
            "count":    len(rows),
            "has_more": len(rows) == limit,
            "data":     [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] attendance error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.get("/sync/write-offs")
async def api_sync_write_offs(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    since_id:  int = Query(0, ge=0),
    since:     str = Query("", description="Also return rows with reversed_at > this"),
    limit:     int = Query(500, ge=1, le=500),
):
    """
    Pull write-offs with id > since_id OR updated (reversed) since timestamp.
    Both new write-offs AND reversals are captured.
    """
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        _ensure_write_offs_table(conn)
        ctx    = get_user_context(auth_user)
        where  = []
        params = []

        if since:
            where.append("(id > ? OR (reversed_at IS NOT NULL AND reversed_at > ?))")
            params.extend([since_id, since])
        else:
            where.append("id > ?")
            params.append(since_id)

        if ctx["is_restricted"]:
            linked = ctx["linked_student_ids"]
            if not linked:
                return JSONResponse({"status":"success","count":0,"data":[]})
            ph = ",".join("?" * len(linked))
            where.append(f"student_id IN ({ph})")
            params.extend(linked)

        where_sql = "WHERE " + " AND ".join(where)
        rows = conn.execute(
            f"""SELECT id, student_id, billing_month, amount, reason, remarks,
                       approved_by, is_active, reversed_at, reversed_by,
                       reversal_reason, created_at
                FROM fee_write_offs {where_sql}
                ORDER BY id ASC LIMIT ?""",
            params + [limit]
        ).fetchall()

        logger.info("xxgs_ [SYNC] write_offs %d rows since_id=%d user='%s'",
                    len(rows), since_id, auth_user)
        return JSONResponse({
            "status":   "success",
            "count":    len(rows),
            "has_more": len(rows) == limit,
            "data":     [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [SYNC] write_offs error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# UTILITIES — Admin-only monitoring & reporting endpoints
# ══════════════════════════════════════════════════════════════════════════════

# ── GET /api/data/utils/students ──────────────────────────────────────────────
@router.get("/utils/students")
async def api_utils_students(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
    status:    str = Query("", description="Filter by status e.g. Active, Inactive, Club Member"),
    level:     str = Query("", description="Filter by level"),
    search:    str = Query("", description="Search by name"),
    limit:     int = Query(500, ge=1, le=500),
):
    """Full student roster for admin monitoring. Permission: student:view"""
    require_permission(auth_user, "student:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        where, params = ["1=1"], []
        if status:
            where.append("LOWER(status) = LOWER(?)")
            params.append(status)
        else:
            where.append("(status IS NULL OR (LOWER(status) NOT IN ('inactive','left','disabled')))")
        if level:
            where.append("LOWER(level) = LOWER(?)")
            params.append(level)
        if search:
            where.append("name LIKE ?")
            params.append(f"%{search}%")

        rows = conn.execute(
            f"""SELECT id, name, age, phone, email, level,
                       status, student_type, student_category,
                       monthly_fee, enrollment_date, school_name,
                       COALESCE(updated_at, '') as updated_at
                FROM students
                WHERE {' AND '.join(where)}
                ORDER BY name ASC LIMIT ?""",
            params + [limit]
        ).fetchall()

        # Summary counts
        all_rows = conn.execute(
            "SELECT status, COUNT(*) as cnt FROM students GROUP BY status"
        ).fetchall()
        status_summary = {r["status"] or "Active": r["cnt"] for r in all_rows}

        logger.info("xxgs_ [UTILS] students %d rows user='%s'", len(rows), auth_user)
        return JSONResponse({
            "status":  "success",
            "count":   len(rows),
            "summary": status_summary,
            "data":    [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [UTILS] students error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── GET /api/data/utils/attendance ────────────────────────────────────────────
@router.get("/utils/attendance")
async def api_utils_attendance(
    request:    Request,
    auth_user:  str = Depends(verify_api_auth),
    date_from:  str = Query("", description="Start date YYYY-MM-DD"),
    date_to:    str = Query("", description="End date YYYY-MM-DD"),
    session:    str = Query("", description="Morning or Evening"),
    student_id: int = Query(0,  description="Filter by student ID"),
    uploaded_by:str = Query("", description="Filter by coach username"),
):
    """
    Attendance report from permanent attendance table only.
    Admin monitoring — reads server state directly.
    Permission: attendance:view
    """
    require_permission(auth_user, "attendance:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Detect column names
        att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"

        # Default to today if no date given
        from datetime import datetime as _dt
        today    = _dt.now().strftime("%Y-%m-%d")
        d_from   = date_from.strip() or today
        d_to     = date_to.strip()   or d_from

        where, params = [f"{date_col} BETWEEN ? AND ?"], [d_from, d_to]
        if session:
            where.append(f"LOWER({session_col}) LIKE LOWER(?)")
            params.append(f"{session}%")
        if student_id > 0:
            where.append("student_id = ?")
            params.append(student_id)
        if uploaded_by:
            where.append("uploaded_by = ?")
            params.append(uploaded_by)

        rows = conn.execute(
            f"""SELECT a.student_id,
                       s.name            AS student_name,
                       a.{date_col}      AS date,
                       a.{session_col}   AS session,
                       a.uploaded_by,
                       a.id
                FROM attendance a
                LEFT JOIN students s ON s.id = a.student_id
                WHERE {' AND '.join(where)}
                ORDER BY a.{date_col} ASC, a.{session_col}, a.student_id""",
            params
        ).fetchall()

        # Session-level summary
        from collections import defaultdict
        sess_summary: dict = defaultdict(int)
        for r in rows:
            sess_summary[f"{r['date']} {r['session']}"] += 1

        # Distinct coaches who uploaded
        coaches = list({r["uploaded_by"] for r in rows if r["uploaded_by"]})

        logger.info("xxgs_ [UTILS] attendance %d rows %s→%s user='%s'",
                    len(rows), d_from, d_to, auth_user)
        return JSONResponse({
            "status":          "success",
            "count":           len(rows),
            "date_from":       d_from,
            "date_to":         d_to,
            "session_summary": dict(sess_summary),
            "coaches":         coaches,
            "data":            [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [UTILS] attendance error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── GET /api/data/utils/payments ──────────────────────────────────────────────
@router.get("/utils/payments")
async def api_utils_payments(
    request:    Request,
    auth_user:  str = Depends(verify_api_auth),
    date_from:  str = Query("", description="Start date YYYY-MM-DD"),
    date_to:    str = Query("", description="End date YYYY-MM-DD"),
    billing_month: str = Query("", description="e.g. Jun-26"),
    student_id: int = Query(0),
    mode:       str = Query("", description="Cash, UPI, etc."),
    limit:      int = Query(500, ge=1, le=500),
):
    """
    Payment report with student names, receipt numbers, billing months.
    Uses account_categories (not fee_lookup).
    Excludes Member Monthly Subscription fees.
    Permission: payments:view
    """
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        from datetime import datetime as _dt
        today  = _dt.now().strftime("%Y-%m-%d")
        d_from = date_from.strip() or today
        d_to   = date_to.strip()   or d_from

        where  = ["(strftime('%Y-%m-%d', p.payment_date) BETWEEN ? AND ?)"]
        params = [d_from, d_to]

        if billing_month:
            where.append("p.billing_month = ?")
            params.append(billing_month)
        if student_id > 0:
            where.append("p.student_id = ?")
            params.append(student_id)
        if mode:
            where.append("LOWER(p.payment_mode) = LOWER(?)")
            params.append(mode)

        # Exclude member subscriptions (same as generate_report.py)
        where.append("(ac.name IS NULL OR LOWER(ac.name) NOT LIKE 'member monthly subscription%')")

        rows = conn.execute(
            f"""SELECT p.id, p.student_id, s.name AS student_name,
                       p.payment_date,
                       ac.name                                          AS fee_type,
                       COALESCE(ac.txn_type, 'INCOME')                 AS txn_type,
                       p.amount_paid,
                       CASE WHEN COALESCE(ac.txn_type,'INCOME') = 'EXPENSE'
                            THEN -(p.amount_paid) ELSE p.amount_paid
                       END                                             AS signed_amount,
                       p.payment_mode, p.receipt_no,
                       p.billing_month, p.status
                FROM payments p
                LEFT JOIN account_categories ac ON p.fee_type_id = ac.id
                LEFT JOIN students s            ON p.student_id  = s.id
                WHERE {' AND '.join(where)}
                ORDER BY p.payment_date ASC, p.id ASC
                LIMIT ?""",
            params + [limit]
        ).fetchall()

        income  = sum(r["amount_paid"] or 0 for r in rows
                      if (r["txn_type"] or "INCOME") != "EXPENSE")
        expense = sum(r["amount_paid"] or 0 for r in rows
                      if (r["txn_type"] or "INCOME") == "EXPENSE")
        total_amount = income - expense

        logger.info("xxgs_ [UTILS] payments %d rows %s→%s income=%.0f expense=%.0f user='%s'",
                    len(rows), d_from, d_to, income, expense, auth_user)
        return JSONResponse({
            "status":       "success",
            "income":       income,
            "expense":      expense,
            "count":        len(rows),
            "total_amount": total_amount,
            "date_from":    d_from,
            "date_to":      d_to,
            "data":         [dict(r) for r in rows],
        })
    except Exception as exc:
        logger.error("xxgs_ [UTILS] payments error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ── GET /api/data/utils/monthly-report ───────────────────────────────────────
@router.get("/utils/monthly-report")
async def api_utils_monthly_report(
    request:              Request,
    auth_user:            str = Depends(verify_api_auth),
    month:                str = Query("", description="YYYY-MM format e.g. 2026-06"),
    hide_zero_attendance: int = Query(0,  description="1 = exclude students with 0 attendance"),
):
    """
    Monthly executive dashboard — attendance + payments combined.
    Same logic as generate_report.py but as API endpoint.
    Uses account_categories, excludes member subscriptions.
    Permission: payments:view
    """
    require_permission(auth_user, "payments:view")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        from datetime import datetime as _dt
        target_month = month.strip() or _dt.now().strftime("%Y-%m")

        # Validate format
        try:
            _dt.strptime(target_month, "%Y-%m")
        except ValueError:
            return JSONResponse({"error": "month must be YYYY-MM format"}, status_code=400)

        # Detect attendance column names
        att_cols    = {c[1] for c in conn.execute("PRAGMA table_info(attendance)").fetchall()}
        date_col    = "attendance_date" if "attendance_date" in att_cols else "date"
        session_col = "session_type"    if "session_type"    in att_cols else "session"

        # 1. Attendance summary per student for target month
        att_rows = conn.execute(
            f"""SELECT
                    student_id,
                    SUM(CASE WHEN LOWER({session_col}) LIKE 'morn%' THEN 1 ELSE 0 END) AS morning_count,
                    SUM(CASE WHEN LOWER({session_col}) LIKE 'even%' THEN 1 ELSE 0 END) AS evening_count,
                    COUNT(*) AS total_present
                FROM attendance
                WHERE strftime('%Y-%m', {date_col}) = ?
                GROUP BY student_id""",
            (target_month,)
        ).fetchall()
        att_map = {r["student_id"]: dict(r) for r in att_rows}

        # 2. Active students roster
        students = conn.execute(
            """SELECT id, name, phone, status, student_type, monthly_fee
               FROM students
               WHERE status IS NULL
                  OR (LOWER(status) NOT IN ('inactive','left','disabled'))
               ORDER BY name ASC"""
        ).fetchall()

        # 3. Build roster with attendance
        roster = []
        for s in students:
            sid  = s["id"]
            att  = att_map.get(sid, {"morning_count": 0, "evening_count": 0, "total_present": 0})
            if hide_zero_attendance and att["total_present"] == 0:
                continue
            roster.append({
                "id":             sid,
                "name":           s["name"],
                "status":         s["status"] or "Active",
                "student_type":   s["student_type"] or "Academy",
                "monthly_fee":    s["monthly_fee"] or 0,
                "morning_count":  att["morning_count"],
                "evening_count":  att["evening_count"],
                "total_present":  att["total_present"],
            })

        # 4. Payment ledger for target month
        pay_rows = conn.execute(
            """SELECT p.student_id, s.name AS student_name,
                      p.payment_date, ac.name AS fee_type,
                      p.amount_paid, p.payment_mode, p.billing_month, p.receipt_no
               FROM payments p
               LEFT JOIN account_categories ac ON p.fee_type_id = ac.id
               LEFT JOIN students s             ON p.student_id  = s.id
               WHERE (strftime('%Y-%m', p.payment_date) = ? OR p.billing_month = ?)
                 AND (ac.name IS NULL OR LOWER(ac.name) NOT LIKE 'member monthly subscription%')
               ORDER BY p.payment_date ASC, p.id ASC""",
            (target_month, target_month)
        ).fetchall()

        payments_list = [dict(r) for r in pay_rows]
        total_revenue = sum(r["amount_paid"] or 0 for r in pay_rows)

        # 5. Summary stats
        total_sessions = conn.execute(
            f"""SELECT COUNT(DISTINCT {date_col} || {session_col}) as n
                FROM attendance
                WHERE strftime('%Y-%m', {date_col}) = ?""",
            (target_month,)
        ).fetchone()["n"] or 0

        paid_student_ids = {r["student_id"] for r in pay_rows}
        unpaid_count = sum(
            1 for s in roster
            if s["student_type"] == "Academy"
            and s["status"] not in ("Club Member", "Inactive")
            and s["id"] not in paid_student_ids
        )

        logger.info("xxgs_ [UTILS] monthly-report month=%s roster=%d payments=%d user='%s'",
                    target_month, len(roster), len(payments_list), auth_user)
        return JSONResponse({
            "status":        "success",
            "month":         target_month,
            "summary": {
                "total_students":   len(roster),
                "total_sessions":   total_sessions,
                "total_payments":   len(payments_list),
                "total_revenue":    total_revenue,
                "unpaid_students":  unpaid_count,
            },
            "roster":        roster,
            "payments":      payments_list,
        })
    except Exception as exc:
        logger.error("xxgs_ [UTILS] monthly-report error: %s", exc, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.post("/students/register")
async def api_register_student(
    request:   Request,
    auth_user: str = Depends(verify_api_auth),
):
    """
    Register a new student with minimal mandatory fields.
    Used by mobile app to convert temp students to real server students.
    Returns: { student_id, name, status }
    """
    role = require_write_role(auth_user)
    logger.info("xxgs_ [STUDENT-REGISTER] user='%s'", auth_user)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON body"}, status_code=400)

    # Validate mandatory fields
    name = (body.get("name") or "").strip()
    dob  = (body.get("date_of_birth") or "").strip()
    if not name:
        return JSONResponse(content={"error": "name is required"}, status_code=400)
    if not dob:
        return JSONResponse(content={"error": "date_of_birth is required"}, status_code=400)

    # Optional fields with safe defaults
    status           = (body.get("status") or "Active").strip()
    student_category = (body.get("student_category") or "REGULAR").strip()
    enrollment_date  = (body.get("enrollment_date") or "").strip() or None
    student_type     = (body.get("student_type") or "Academy").strip()

    valid_statuses    = ["Active", "Club Member", "Camp", "Inactive", "Left"]
    valid_categories  = ["REGULAR", "TEMPORARY", "SCHOLARSHIP"]
    if status not in valid_statuses:
        status = "Active"
    if student_category not in valid_categories:
        student_category = "REGULAR"

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        # Check for duplicate name + dob to prevent double registration
        existing = conn.execute(
            "SELECT id, name FROM students WHERE name=? AND date_of_birth=?",
            (name, dob)
        ).fetchone()
        if existing:
            logger.info("xxgs_ [STUDENT-REGISTER] duplicate found id=%d name='%s'", existing["id"], existing["name"])
            return JSONResponse(content={
                "student_id": existing["id"],
                "name":       existing["name"],
                "status":     "existing",
                "message":    "Student already registered — returning existing ID",
            })

        conn.execute(
            """INSERT INTO students
               (name, date_of_birth, status, student_category, student_type, enrollment_date, user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, dob, status, student_category, student_type, enrollment_date, auth_user)
        )
        conn.commit()
        student_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()["id"]
        logger.info("xxgs_ [STUDENT-REGISTER] new student id=%d name='%s' by '%s'",
                    student_id, name, auth_user)
        return JSONResponse(content={
            "student_id": student_id,
            "name":       name,
            "status":     "created",
        })
    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [STUDENT-REGISTER] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()

# ══════════════════════════════════════════════════════════════════════
# PROFILE PHOTO UPLOAD / DELETE API
# ══════════════════════════════════════════════════════════════════════
# POST /api/data/students/{id}/photo   — upload new photo (multipart)
# DELETE /api/data/students/{id}/photo — remove photo + null DB field
# ══════════════════════════════════════════════════════════════════════

import os as _os
from fastapi import UploadFile, File
from starlette.formparsers import MultiPartParser

_STUDENT_IMG_FOLDER = _os.path.join("static", "images", "students")
_ALLOWED_PHOTO_MIME  = {"image/jpeg", "image/jpg", "image/png"}
_MAX_PHOTO_BYTES     = 1 * 1024 * 1024  # 1 MB


@router.post("/students/{student_id}/photo")
async def api_upload_photo(
    request:    Request,
    student_id: int,
    auth_user:  str = Depends(verify_api_auth),
):
    require_write_role(auth_user)
    """
    Upload/replace profile photo for a student.
    Accepts multipart/form-data with field 'file' (JPEG or PNG, max 1 MB).
    Returns: { status, filename, url }
    """
    logger.info("xxgs_ [PHOTO-UPLOAD] student_id=%d user='%s'", student_id, auth_user)

    # Read multipart form — one call only (stream can only be read once)
    try:
        form_data = await request.form()
        file_obj  = form_data.get("file")
    except Exception as exc:
        return JSONResponse(content={"error": "Internal server error"}, status_code=400)

    if not file_obj or not hasattr(file_obj, "read"):
        return JSONResponse(content={"error": "No file field in request"}, status_code=400)

    # MIME type check
    content_type = getattr(file_obj, "content_type", "") or ""
    if content_type not in _ALLOWED_PHOTO_MIME:
        return JSONResponse(
            content={"error": f"File type not allowed: {content_type}. Use JPEG or PNG."},
            status_code=400,
        )

    # Read bytes
    contents = await file_obj.read()
    if len(contents) == 0:
        return JSONResponse(content={"error": "Empty file"}, status_code=400)
    if len(contents) > _MAX_PHOTO_BYTES:
        return JSONResponse(
            content={"error": f"File too large ({len(contents)//1024} KB). Max 1 MB."},
            status_code=400,
        )

    # Magic-byte validation (blocks disguised executables)
    # JPEG: FF D8 FF   PNG: 89 50 4E 47
    if not (contents[:3] == b"\xff\xd8\xff" or contents[:4] == b"\x89PNG"):
        return JSONResponse(
            content={"error": "File does not look like a valid JPEG or PNG image."},
            status_code=400,
        )

    # Verify student exists
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        student = conn.execute(
            "SELECT id, name, profile_image FROM students WHERE id=?", (student_id,)
        ).fetchone()
        if not student:
            return JSONResponse(content={"error": f"Student id={student_id} not found"}, status_code=404)

        # Save to disk — always overwrite same filename
        _os.makedirs(_STUDENT_IMG_FOLDER, exist_ok=True)
        filename  = f"{student_id}.jpg"
        file_path = _os.path.join(_STUDENT_IMG_FOLDER, filename)

        with open(file_path, "wb") as buf:
            buf.write(contents)

        # Bust the old filename if it was different (e.g. previous upload with .png)
        old_img = student["profile_image"]
        if old_img and old_img != filename:
            old_path = _os.path.join(_STUDENT_IMG_FOLDER, old_img)
            if _os.path.exists(old_path):
                try: _os.remove(old_path)
                except Exception: pass

        # Update DB
        conn.execute(
            "UPDATE students SET profile_image=? WHERE id=?",
            (filename, student_id),
        )
        conn.commit()
        logger.info(
            "xxgs_ [PHOTO-UPLOAD] saved %s (%d bytes) for student '%s'",
            filename, len(contents), student["name"],
        )
        return JSONResponse(content={
            "status":   "success",
            "filename": filename,
            "url":      f"/static/images/students/{filename}",
            "size_kb":  round(len(contents) / 1024, 1),
        })

    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [PHOTO-UPLOAD] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


@router.delete("/students/{student_id}/photo")
async def api_delete_photo(
    request:    Request,
    student_id: int,
    auth_user:  str = Depends(verify_api_auth),
):
    """Remove profile photo — deletes file from disk and sets DB field to NULL."""
    role = require_write_role(auth_user)
    logger.info("xxgs_ [PHOTO-DELETE] student_id=%d user='%s'", student_id, auth_user)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        student = conn.execute(
            "SELECT id, name, profile_image FROM students WHERE id=?", (student_id,)
        ).fetchone()
        if not student:
            return JSONResponse(content={"error": f"Student id={student_id} not found"}, status_code=404)

        old_img = student["profile_image"]
        if not old_img:
            return JSONResponse(content={"status": "no_photo", "message": "No photo to delete"})

        # Delete file from disk
        file_path = _os.path.join(_STUDENT_IMG_FOLDER, old_img)
        if _os.path.exists(file_path):
            try:
                _os.remove(file_path)
                logger.info("xxgs_ [PHOTO-DELETE] deleted file: %s", file_path)
            except Exception as e:
                logger.warning("xxgs_ [PHOTO-DELETE] could not delete file %s: %s", file_path, e)

        # Null DB field
        conn.execute("UPDATE students SET profile_image=NULL WHERE id=?", (student_id,))
        conn.commit()
        logger.info("xxgs_ [PHOTO-DELETE] cleared profile_image for student '%s'", student["name"])
        return JSONResponse(content={"status": "success", "deleted": old_img})

    except Exception as exc:
        conn.rollback()
        logger.error("xxgs_ [PHOTO-DELETE] error: %s", exc, exc_info=True)
        return JSONResponse(content={"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()
