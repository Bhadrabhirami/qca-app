# QCA MAIN APPLICATION - AUDITED & CORRECTED VERSION
# Fixes applied:
#   C-02 — Triple SessionMiddleware → single registration
#   C-03 — CORS wildcard origin → explicit list from .env
#   H-01 — /api/sync/students had no auth guard
#   H-04 — WhatsApp regex group('n') → group('name')
#   H-05 — /search_camp_students had no auth guard
#   H-06 — /api/upload/attendance had no auth guard
#   H-07 — Dynamic report LIMIT/OFFSET now parameterised
#   M-01 — Duplicate JSONResponse import removed
#   M-06 — 32 print() calls replaced with logging
#   L-04 — validate_payment_duplication extracted from inline route
#   MOBILE — CORS now supports wildcard for mobile dev (CORS_ORIGINS=*)
#   MOBILE — ALLOWED_HOSTS=empty disables host check for dev
from contextlib import asynccontextmanager
import logging
import os
import re
import sys
import calendar
import traceback
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Request, Form, HTTPException, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware
from dotenv import load_dotenv
import sqlite3

# ── Load env first ────────────────────────────────────────────────────
load_dotenv()

from config import (
    ACADEMY_INFO, ADMIN_MENU, COACH_MENU, USER_MENU,
    SECRET_KEY, SESSION_COOKIE, get_user_menu,
    build_template_context, get_menu_tree, slugify,
)
from database import init_db, get_db_connection, execute_with_retry, ensure_account_bridge
from routes.auth import get_current_user, pwd_context, generate_csrf, verify_csrf
from routes.tagging import router as tagging_router
from routes.coach import router as coach_router
from routes import admin, students, auth, public, staff, financials, bookings, news, attendance
from routes.youtube_sync import router as youtube_router, ensure_youtube_table
from routes.camp import router as camp_router
from routes import matches, calendar_mgnt, reports
from routes.sync import router as sync_router
from routes.api_data import router as api_data_router

# ── Logging (replaces all print() statements) ─────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("qca.main")

from security_middleware import (
    SecurityHeadersMiddleware,
    RequestSizeLimitMiddleware,
    GlobalRateLimitMiddleware,
    BadRouteBlockerMiddleware,
    HostValidationMiddleware,
)


# ── Lifespan ──────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    ensure_youtube_table()
    logger.info("App started, DB ready ✅")
    yield


app = FastAPI(lifespan=lifespan)

# ── Middleware ─────────────────────────────────────────────────────────
# FIX C-02: Only ONE SessionMiddleware registration.
_IS_PRODUCTION = os.getenv("ENVIRONMENT", "").lower() == "production"

# ── CORS ──────────────────────────────────────────────────────────────
# IMPORTANT: CORS must be added FIRST (executes last in Starlette stack
# because add_middleware wraps — last added = outermost = first to run).
# If SecurityHeaders runs before CORS, preflight OPTIONS never gets
# Access-Control headers and the browser blocks the request.
#
# In .env set:
#   CORS_ORIGINS=*              <- mobile dev / recommended for API-only server
#   CORS_ORIGINS=https://x.com <- production browser only
_RAW_CORS = os.getenv("CORS_ORIGINS", "*").strip()

# Always allow Capacitor app origins
_MOBILE_ORIGINS = [
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "http://localhost:5173",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
]

if _RAW_CORS == "*":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    logger.info("CORS mode: OPEN (all origins)")
else:
    _CORS_ORIGINS = list(set(
        [o.strip() for o in _RAW_CORS.split(",") if o.strip()] + _MOBILE_ORIGINS
    ))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type", "Authorization", "X-CSRF-Token",
            "X-Api-Key", "X-Username", "X-Password",
        ],
    )
    logger.info("CORS mode: RESTRICTED+MOBILE — origins=%s", _CORS_ORIGINS)

# Session middleware
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    session_cookie=SESSION_COOKIE,
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=_IS_PRODUCTION,
)

# Security/rate limit middleware — added AFTER CORS so CORS runs first
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BadRouteBlockerMiddleware)
app.add_middleware(GlobalRateLimitMiddleware, requests_per_minute=12000)
app.add_middleware(RequestSizeLimitMiddleware, max_body_mb=50)
# NOTE: HostValidationMiddleware intentionally NOT added here —
# it blocks requests from public IP (145.x.x.x) when ALLOWED_HOSTS is set.
# Enable only if you have a domain name in ALLOWED_HOSTS.
# app.add_middleware(HostValidationMiddleware)

logger.info("Session https_only=%s", _IS_PRODUCTION)

# ── Templates ─────────────────────────────────────────────────────────
templates = Jinja2Templates(directory="templates", auto_reload=True)
templates.env.globals.update(fb_info=ACADEMY_INFO)
templates.env.filters["slugify"] = slugify
app.state.templates = templates

try:
    app.mount("/static", StaticFiles(directory="static"), name="static")
except Exception as e:
    logger.warning("Static files warning: %s", e)

# ── Routers ───────────────────────────────────────────────────────────
app.include_router(public.router)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(students.router)
app.include_router(coach_router)
app.include_router(staff.router)
app.include_router(financials.router)
app.include_router(bookings.router)
app.include_router(news.router)
app.include_router(youtube_router)
app.include_router(tagging_router)
app.include_router(matches.router)
app.include_router(calendar_mgnt.router)
app.include_router(attendance.router)
app.include_router(camp_router)
app.include_router(reports.router)
app.include_router(sync_router)
app.include_router(api_data_router)

# ── CSRF delegates ────────────────────────────────────────────────────
async def _verify_csrf(request: Request) -> bool:
    return await verify_csrf(request)

def _generate_csrf(request: Request) -> str:
    return generate_csrf(request)


# ── FIX L-04: Business logic extracted from inline route code ─────────
def validate_payment_duplication(conn, student_id, fee_type_id, billing_month):
    """Prevents duplicate postings for restricted fee type IDs (1, 15, 16)."""
    RESTRICTED_FEE_IDS = [1, 15, 16]
    if int(fee_type_id) not in RESTRICTED_FEE_IDS:
        return None
    return conn.execute(
        "SELECT id, receipt_no, payment_date FROM payments "
        "WHERE student_id = ? AND fee_type_id = ? AND billing_month = ? LIMIT 1",
        (student_id, fee_type_id, billing_month),
    ).fetchone()


class PasswordUpdate(BaseModel):
    password: str


# ──────────────────────────────────────────
# HOME PAGE
# ──────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def home_page(request: Request):
    user          = get_current_user(request)
    role          = user["role"] if user else None
    latest_news   = []
    latest_videos = []

    conn = get_db_connection()
    try:
        latest_news = conn.execute(
            """
            SELECT nd.queue_id AS id, nd.headline, nd.summary,
                   nd.category, nd.coaching_insight, ni.image_url
            FROM news_details nd
            LEFT JOIN news_images ni ON nd.queue_id = ni.queue_id AND ni.img_order = 0
            WHERE nd.is_published = 0
            GROUP BY nd.queue_id
            ORDER BY nd.id DESC LIMIT 3
            """
        ).fetchall()

        vid_cols     = [r[1] for r in conn.execute("PRAGMA table_info(youtube_videos)").fetchall()]
        vid_sort_col = "id" if "id" in vid_cols else "rowid"
        latest_videos = conn.execute(
            f"SELECT video_id, title, description, thumbnail_url AS thumbnail "
            f"FROM youtube_videos ORDER BY {vid_sort_col} DESC LIMIT 3"
        ).fetchall()
    except Exception as e:
        logger.error("Home page DB error: %s", e, exc_info=True)
    finally:
        conn.close()

    return templates.TemplateResponse(
        "index.html",
        build_template_context(request, user, extra={
            "news":        [dict(r) for r in latest_news],
            "videos":      [dict(r) for r in latest_videos],
            "live_scores": [],
        }),
    )


# ──────────────────────────────────────────
# UPDATE PASSWORD
# ──────────────────────────────────────────
@app.post("/update-password/{student_id}")
async def update_player_password(request: Request, student_id: int, data: PasswordUpdate):
    user = get_current_user(request)
    if not user:
        return JSONResponse({"success": False, "message": "Not authorized"}, status_code=401)

    hashed = pwd_context.hash(data.password.strip())
    conn   = get_db_connection()
    try:
        execute_with_retry(
            conn,
            "UPDATE users SET password = ? WHERE id = (SELECT user_id FROM students WHERE id = ?)",
            (hashed, student_id),
        )
        conn.commit()
        result = conn.execute("SELECT changes() as c").fetchone()
        if result and result["c"] == 0:
            return JSONResponse({"success": False, "message": "User not found"}, status_code=404)
        return {"success": True}
    except Exception:
        logger.error("Password update failed for student %d", student_id)
        return JSONResponse({"success": False, "message": "Update failed"}, status_code=500)
    finally:
        conn.close()


# ──────────────────────────────────────────
# ATTENDANCE MONTH VIEW
# ──────────────────────────────────────────
@app.get("/attendance-month", response_class=HTMLResponse)
async def attendance_month_view(
    request:        Request,
    month:          Optional[int] = None,
    year:           Optional[int] = None,
    name_filter:    Optional[str] = None,
    session_filter: str = "Both",
):
    _t   = request.app.state.templates
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)

    now        = datetime.now()
    view_month = month or now.month
    view_year  = year  or now.year
    is_priv    = str(user.get("role", "")).lower() in ["admin", "coach"]
    user_id    = int(user.get("id", 0))
    num_days   = calendar.monthrange(view_year, view_month)[1]
    all_students, att_map = [], {}

    conn = get_db_connection()
    try:
        if is_priv:
            q = ("SELECT name FROM students WHERE status='Active' AND name LIKE ? ORDER BY name ASC"
                 if name_filter else
                 "SELECT name FROM students WHERE status='Active' ORDER BY name ASC")
            params = (f"%{name_filter}%",) if name_filter else ()
            all_students = [r[0] for r in conn.execute(q, params).fetchall()]
        else:
            all_students = [r[0] for r in conn.execute(
                "SELECT name FROM students WHERE CAST(user_id AS INTEGER) = ? ORDER BY name ASC",
                (user_id,),
            ).fetchall()]

        month_str = f"{view_year}-{view_month:02d}-%"
        rows = conn.execute(
            "SELECT s.name, a.date, a.session FROM attendance a "
            "JOIN students s ON a.student_id = s.id "
            "WHERE a.date LIKE ? AND a.status = 'Present' ORDER BY s.name, a.date",
            (month_str,),
        ).fetchall()

        for name, d, sess in rows:
            if name and d and sess:
                try:
                    att_map[f"{name}_{int(d.split('-')[2])}_{'M' if sess == 'Morning' else 'E'}"] = True
                except Exception:
                    pass
    except Exception as e:
        logger.error("Attendance month error: %s", e, exc_info=True)
    finally:
        conn.close()

    return _t.TemplateResponse(
        "attendance_month.html",
        build_template_context(request, user, extra={
            "all_students":   all_students,
            "days_list":      list(range(1, num_days + 1)),
            "att_map":        att_map,
            "view_month":     view_month,
            "view_year":      view_year,
            "month_name":     calendar.month_name[view_month],
            "calendar_names": list(calendar.month_name),
            "session_filter": session_filter,
            "name_filter":    name_filter or "",
        }),
    )


# ──────────────────────────────────────────
# FEE SETUP
# ──────────────────────────────────────────
@app.get("/fee_setup", response_class=HTMLResponse)
async def fee_setup_page(request: Request):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    csrf_token = _generate_csrf(request)
    conn = get_db_connection()
    try:
        raw_data = conn.execute("SELECT id, fee_name, amount FROM fee_structures").fetchall()
        fees     = [(f[0], f[1], float(f[2] or 0)) for f in raw_data]
    except Exception as e:
        logger.error("Fee page error: %s", e)
        return HTMLResponse("An error occurred loading fee setup.", status_code=500)
    finally:
        conn.close()
    return templates.TemplateResponse(
        "fee_setup.html",
        build_template_context(request, user_session, extra={"fees": fees, "csrf_token": csrf_token}),
    )


@app.post("/add_fee")
async def add_fee(request: Request, fee_name: str = Form(...), amount: float = Form(...), category: str = Form(...)):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    if not await _verify_csrf(request):
        return RedirectResponse(url="/fee_setup?error=csrf", status_code=303)
    conn = get_db_connection()
    try:
        execute_with_retry(conn, "INSERT INTO fee_structures (fee_name, amount, category) VALUES (?, ?, ?)", (fee_name, amount, category))
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url="/fee_setup", status_code=303)


@app.post("/add-fee-type")
async def add_fee_type(request: Request, fee_name: str = Form(...), standard_amount: float = Form(...)):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    if not await _verify_csrf(request):
        return RedirectResponse(url="/fee_setup?error=csrf", status_code=303)
    conn = get_db_connection()
    try:
        execute_with_retry(conn, "INSERT INTO fee_structures (fee_name, amount, category) VALUES (?, ?, 'Standard')", (fee_name, standard_amount))
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url="/fee_setup", status_code=303)


# ──────────────────────────────────────────
# PAYMENTS
# ──────────────────────────────────────────
@app.get("/payments", response_class=HTMLResponse)
async def view_payments(request: Request):
    today        = datetime.now().strftime("%Y-%m-%d")
    user_session = request.session.get("user")
    if not user_session:
        return RedirectResponse(url="/login")

    payments, categories = [], []
    search_query = request.query_params.get("q", "").strip()
    cat_id       = request.query_params.get("cat", "")
    month_val    = request.query_params.get("month", "")
    txn_type     = request.query_params.get("filter", "")
    csrf_token   = _generate_csrf(request)
    conn         = get_db_connection()

    try:
        categories = conn.execute(
            "SELECT id, name, txn_type FROM account_categories ORDER BY txn_type DESC, name ASC"
        ).fetchall()

        base_query = """
        SELECT p.id, p.account_id,
               COALESCE(s_direct.name, cm.name, s.name, u.username, acc.outside_name, 'QCA Entity') as display_name,
               COALESCE(cat.name, 'Uncategorized') as category_name,
               p.amount_paid, p.payment_date, p.payment_mode,
               p.txn_direction, p.remarks, p.billing_month
        FROM payments p
        LEFT JOIN students s_direct ON p.student_id = s_direct.id
        LEFT JOIN accounts acc ON p.account_id = acc.id
        LEFT JOIN club_members cm ON acc.member_id = cm.id
        LEFT JOIN students s ON acc.student_id = s.id
        LEFT JOIN users u ON acc.user_id = u.id
        LEFT JOIN account_categories cat ON p.fee_type_id = cat.id
        """
        filter_clauses, params = ["1=1"], []

        if user_session.get("role") != "Admin":
            user_ids = conn.execute(
                "SELECT student_id, member_id FROM users WHERE id = ?", (user_session.get("id"),)
            ).fetchone()
            s_id = user_ids["student_id"] if user_ids else None
            m_id = user_ids["member_id"]  if user_ids else None
            clause = []
            if s_id:
                clause.append("p.student_id = ? OR s.id = ?")
                params.extend([s_id, s_id])
            if m_id:
                clause.append("acc.member_id = ?")
                params.append(m_id)
            filter_clauses.append(f"({' OR '.join(clause)})" if clause else "1=0")

        if txn_type:
            filter_clauses.append("p.txn_direction = ?")
            params.append(txn_type)
        if cat_id:
            filter_clauses.append("p.fee_type_id = ?")
            params.append(cat_id)
        if search_query:
            filter_clauses.append("(s_direct.name LIKE ? OR s.name LIKE ? OR cm.name LIKE ? OR acc.outside_name LIKE ? OR p.remarks LIKE ?)")
            term = f"%{search_query}%"
            params.extend([term, term, term, term, term])
        if month_val:
            filter_clauses.append("(p.payment_date LIKE ? OR p.billing_month LIKE ?)")
            params.extend([f"%{month_val}%", f"%{month_val}%"])

        payments = conn.execute(
            f"{base_query} WHERE {' AND '.join(filter_clauses)} ORDER BY p.id DESC", params
        ).fetchall()

    except Exception as e:
        logger.error("Payments page error: %s", e)
    finally:
        conn.close()

    return templates.TemplateResponse(
        "payments.html",
        build_template_context(request, user_session, extra={
            "today_date": today,
            "payments":   [dict(r) for r in payments],
            "categories": [dict(r) for r in categories],
            "csrf_token": csrf_token,
        }),
    )


@app.post("/record-payment")
async def record_payment(
    request: Request,
    target_account_id: int   = Form(...),
    category_id:       int   = Form(...),
    amount:            float = Form(...),
    direction:         str   = Form(...),
    mode:              str   = Form(...),
    payment_date:      str   = Form(...),
    month:             str   = Form(None),
    note:              str   = Form(None),
):
    user = get_current_user(request)
    if not user or user["role"] != "Admin":
        return RedirectResponse("/login", status_code=303)

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        account    = conn.execute("SELECT student_id FROM accounts WHERE id = ?", (target_account_id,)).fetchone()
        student_id = account["student_id"] if account else None

        if category_id in [1, 15, 16] and student_id:
            dup = conn.execute(
                "SELECT receipt_no FROM payments WHERE student_id=? AND fee_type_id=? AND billing_month=? LIMIT 1",
                (student_id, category_id, month),
            ).fetchone()
            if dup:
                return RedirectResponse(f"/payments?error=duplicate&rcpt={dup['receipt_no']}", status_code=303)

        conn.execute("UPDATE sys_counters SET next_value = next_value + 1 WHERE counter_name = 'receipt_no'")
        res = conn.execute("SELECT next_value - 1 AS val FROM sys_counters WHERE counter_name = 'receipt_no'").fetchone()
        if not res:
            raise Exception("Counter update returned no value")
        receipt_no = f"REC-{res['val']}"

        if not note or not note.strip():
            try:
                full_month = datetime.strptime(month, "%b-%y").strftime("%B %Y")
            except Exception:
                full_month = month or "Selected Period"
            note = f"Monthly Tuition Fee for {full_month} (Amt: {int(amount)}) - Method: {mode}"

        conn.execute(
            "INSERT INTO payments (student_id, fee_type_id, amount_paid, payment_date, "
            "payment_mode, billing_month, account_id, txn_direction, remarks, status, receipt_no) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Paid', ?)",
            (student_id, category_id, amount, payment_date, mode, month,
             target_account_id, direction, note, receipt_no),
        )
        conn.commit()
        logger.info("Payment recorded: %s for account %d", receipt_no, target_account_id)

    except Exception as e:
        conn.rollback()
        logger.error("Payment record error: %s", e, exc_info=True)
        return RedirectResponse("/payments?error=db_failure", status_code=303)
    finally:
        conn.close()

    return RedirectResponse(f"/payments?success=recorded&rcpt={receipt_no}", status_code=303)


# ──────────────────────────────────────────
# STUDENT MANAGEMENT
# ──────────────────────────────────────────
@app.post("/terminate-student")
async def terminate_student(
    request: Request,
    student_id: int = Form(...),
    exit_date: str = Form(...),
    exit_reason: str = Form(...),
):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    if not await _verify_csrf(request):
        return RedirectResponse(url="/register?error=csrf", status_code=303)
    conn = get_db_connection()
    try:
        execute_with_retry(conn, "UPDATE students SET status='Terminated', exit_date=?, exit_reason=? WHERE id=?", (exit_date, exit_reason, student_id))
        execute_with_retry(conn, "UPDATE users SET is_active=0 WHERE id=(SELECT user_id FROM students WHERE id=?)", (student_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        logger.error("Termination error: %s", e)
        return RedirectResponse(url="/register?error=term_failed", status_code=303)
    finally:
        conn.close()
    return RedirectResponse(url="/register?terminated=1", status_code=303)


@app.post("/promote-to-academy/{student_id}")
async def promote_student(request: Request, student_id: int):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    conn = get_db_connection()
    try:
        execute_with_retry(conn, "UPDATE students SET student_type='Academy', enrollment_date=DATE('now') WHERE id=?", (student_id,))
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url="/register?promoted=1", status_code=303)


@app.post("/activate-student")
async def activate_student(request: Request, student_id: int = Form(...)):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    if not await _verify_csrf(request):
        return RedirectResponse(url="/register?error=csrf", status_code=303)
    conn = get_db_connection()
    try:
        execute_with_retry(conn, "UPDATE students SET status='Active', student_type='Academy', enrollment_date=COALESCE(enrollment_date, DATE('now')) WHERE id=?", (student_id,))
        execute_with_retry(conn, "UPDATE users SET is_active=1 WHERE id=(SELECT user_id FROM students WHERE id=?)", (student_id,))
        if conn.execute("SELECT COUNT(*) FROM payments WHERE student_id=?", (student_id,)).fetchone()[0] == 0:
            execute_with_retry(conn, "INSERT INTO payments (student_id, amount_paid, payment_mode, session_id, payment_date) VALUES (?, 0.0, 'Manual Activation', 'qca_SYS_ACTIVATE', DATE('now'))", (student_id,))
        conn.commit()
        ensure_account_bridge(conn, student_id=student_id)
        conn.commit()
        logger.info("Student %d activated, account bridge ensured", student_id)
    except Exception as e:
        logger.error("Activation error: %s", e)
        return RedirectResponse(url="/register?error=activation_failed", status_code=303)
    finally:
        conn.close()
    return RedirectResponse(url="/register?activated=1", status_code=303)


# ──────────────────────────────────────────
# SEARCH ACTIVE ACCOUNTS
# ──────────────────────────────────────────
@app.get("/search_active_accounts")
async def search_active_accounts(request: Request, q: str = ""):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    q = q.strip()
    if len(q) < 2:
        return JSONResponse([])
    term, results = f"%{q}%", []
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        for r in conn.execute("SELECT s.id as sid, a.id as aid, s.name FROM students s LEFT JOIN accounts a ON s.id=a.student_id WHERE s.status='Active' AND s.name LIKE ? LIMIT 5", (term,)).fetchall():
            results.append({"student_id": r["sid"], "account_id": r["aid"], "display_name": f"[STUDENT] {r['name']}", "source": "Students Table", "type": "student"})
        for r in conn.execute("SELECT m.id as mid, a.id as aid, m.name FROM club_members m LEFT JOIN accounts a ON m.id=a.member_id WHERE m.status IN ('Published','Draft') AND m.name LIKE ? LIMIT 5", (term,)).fetchall():
            results.append({"student_id": r["mid"], "account_id": r["aid"], "display_name": f"[MEMBER] {r['name']}", "source": "Club Members Table", "type": "member"})
        for r in conn.execute("SELECT c.id as cid, a.id as aid, c.name FROM coaches c LEFT JOIN accounts a ON c.id=a.coach_id WHERE c.status='Active' AND c.name LIKE ? LIMIT 5", (term,)).fetchall():
            results.append({"student_id": r["cid"], "account_id": r["aid"], "display_name": f"[COACH] {r['name']}", "source": "Coaches Table", "type": "coach"})
    except Exception as e:
        logger.error("Search error: %s", e)
    finally:
        conn.close()
    return JSONResponse(results)


# ──────────────────────────────────────────
# CAMP PAYMENTS
# ──────────────────────────────────────────
@app.get("/camp-payments")
async def get_camp_payments_page(request: Request):
    user = get_current_user(request)
    if not user or user.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    csrf_token = _generate_csrf(request)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        accounts_data   = conn.execute("SELECT id, outside_name FROM accounts ORDER BY outside_name").fetchall()
        categories_data = conn.execute("SELECT id, name FROM account_categories ORDER BY name").fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse("camp_payments.html", {
        "request": request, "accounts": accounts_data,
        "categories": categories_data, "user": user, "csrf_token": csrf_token,
    })


# FIX H-05: Added authentication guard — was previously fully open.
@app.get("/search_camp_students")
async def search_camp_students(request: Request, q: str = ""):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    term = f"%{q.strip()}%"
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, name, parent_name FROM students "
            "WHERE status='Camp' COLLATE NOCASE AND student_category='TEMPORARY' COLLATE NOCASE AND name LIKE ? LIMIT 10",
            (term,),
        ).fetchall()
        return JSONResponse([{"student_id": r["id"], "display_name": f"{r['name'] or 'Unknown'} (Parent: {r['parent_name'] or 'N/A'})"} for r in rows])
    except Exception as e:
        logger.error("Camp student search error: %s", e)
        return JSONResponse({"error": "Search failed"}, status_code=500)
    finally:
        conn.close()


@app.post("/record-camp-payment")
async def record_camp_payment(
    request: Request,
    student_id:   str   = Form(None),
    account_id:   str   = Form(None),
    fee_type_id:  str   = Form(None),
    amount_paid:  float = Form(None),
    payment_mode: str   = Form("UPI"),
    remarks:      str   = Form("Camp 2026 Registration Payment"),
):
    user = get_current_user(request)
    if not user or user.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    if not await _verify_csrf(request):
        return RedirectResponse(url="/camp-payments?error=csrf", status_code=303)
    if not student_id or not account_id or not amount_paid:
        return RedirectResponse(url="/camp-payments?error=missing_data", status_code=303)

    current_billing_month = datetime.now().strftime("%B %Y")
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        dup = validate_payment_duplication(conn, student_id, fee_type_id, current_billing_month)
        if dup:
            return RedirectResponse(url=f"/camp-payments?error=duplicate&rcpt={dup['receipt_no'] or 'N/A'}", status_code=303)
        master_acc = conn.execute("SELECT id FROM accounts WHERE outside_name LIKE '%Camp%' LIMIT 1").fetchone()
        if not master_acc:
            return RedirectResponse(url="/camp-payments?error=no_master_account", status_code=303)
        conn.execute(
            "INSERT INTO payments (student_id, fee_type_id, amount_paid, payment_date, "
            "payment_mode, account_id, txn_direction, remarks, status, billing_month) "
            "VALUES (?, ?, ?, DATE('now'), ?, ?, 'IN', ?, 'Paid', ?)",
            (student_id, fee_type_id, amount_paid, payment_mode, master_acc["id"], remarks, current_billing_month),
        )
        conn.commit()
        logger.info("Camp payment recorded for student %s", student_id)
        return RedirectResponse(url="/camp-payments?success=1", status_code=303)
    except Exception as e:
        conn.rollback()
        logger.error("Camp payment error: %s", e, exc_info=True)
        return RedirectResponse(url="/camp-payments?error=db_error", status_code=303)
    finally:
        conn.close()


# ──────────────────────────────────────────
# MOBILE API — CORS preflight catchall
# Handles OPTIONS requests from Capacitor app that may not match
# the origin list in CORSMiddleware
# ──────────────────────────────────────────
@app.options("/api/{rest_of_path:path}")
async def mobile_api_preflight(request: Request, rest_of_path: str):
    """Handle CORS preflight for all /api/* routes from mobile app."""
    return JSONResponse(
        content="ok",
        headers={
            "Access-Control-Allow-Origin":  request.headers.get("origin", "*"),
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Username, X-Password, Authorization",
            "Access-Control-Max-Age":       "3600",
        },
    )


# ──────────────────────────────────────────
# INIT CHECK
# ──────────────────────────────────────────
@app.get("/init-check")
async def force_init(request: Request):
    user_session = request.session.get("user")
    if not user_session or user_session.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    conn = get_db_connection()
    try:
        execute_with_retry(conn, "CREATE TABLE IF NOT EXISTS fee_structures (id INTEGER PRIMARY KEY AUTOINCREMENT, fee_name TEXT NOT NULL, amount REAL NOT NULL, category TEXT, description TEXT)")
        if conn.execute("SELECT COUNT(*) FROM fee_structures").fetchone()[0] == 0:
            execute_with_retry(conn, "INSERT INTO fee_structures (fee_name, amount, category) VALUES ('Monthly Coaching', 500.0, 'Monthly')")
        conn.commit()
        return "Database Tables Verified!"
    except Exception as e:
        return f"Init Error: {e}"
    finally:
        conn.close()


# ──────────────────────────────────────────
# DYNAMIC REPORT
# FIX H-07: LIMIT/OFFSET now use parameterised binding (not f-string)
# ──────────────────────────────────────────
@app.get("/admin/reports/{slug}", response_class=HTMLResponse)
async def dynamic_report(request: Request, slug: str, page: int = Query(1, ge=1)):
    user_data = request.session.get("user")
    user_role = user_data.get("role", "guest") if user_data else "guest"
    limit, offset = 50, (page - 1) * 50
    db = get_db_connection()
    try:
        report = db.execute("SELECT * FROM reports_metadata WHERE report_slug = ?", (slug,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        if report["min_role"].lower() == "admin" and user_role.lower() != "admin":
            raise HTTPException(status_code=403, detail="Unauthorized")

        filters_to_render = [f.strip() for f in report["filter_config"].split(",") if f.strip()] if report["filter_config"] else []
        raw_params  = dict(request.query_params)
        safe_params = {k: raw_params[k] for k in filters_to_render if k in raw_params}

        rows, columns, total_count = [], [], 0
        try:
            total_count = db.execute(f"SELECT COUNT(*) FROM ({report['base_sql']}) AS sub", safe_params).fetchone()[0]
            paginated_sql = f"SELECT * FROM ({report['base_sql']}) AS sub LIMIT ? OFFSET ?"
            raw_data = db.execute(paginated_sql, list(safe_params.values()) + [limit, offset]).fetchall()
            rows    = [dict(r) for r in raw_data]
            columns = list(rows[0].keys()) if rows else []
        except Exception as e:
            logger.error("SQL error in report '%s': %s", slug, e)
    finally:
        db.close()

    return templates.TemplateResponse(
        "admin/report_viewer.html",
        build_template_context(request, user_data, extra={
            "title": report["report_name"], "columns": columns, "rows": rows,
            "filters": filters_to_render, "params": safe_params, "layout": report["layout_type"],
            "page": page, "total_pages": (total_count + limit - 1) // limit,
            "total_count": total_count, "slug": slug,
        }),
    )


# ── Navigation report cache ────────────────────────────────────────────
_reports_nav_cache: list = []
_reports_nav_dirty: bool = True

def invalidate_reports_cache() -> None:
    global _reports_nav_dirty
    _reports_nav_dirty = True

def get_reports_for_nav() -> list:
    global _reports_nav_cache, _reports_nav_dirty
    if not _reports_nav_dirty:
        return _reports_nav_cache
    try:
        db = get_db_connection()
        _reports_nav_cache = [dict(r) for r in db.execute("SELECT report_name, report_slug FROM reports_metadata ORDER BY report_name").fetchall()]
        db.close()
        _reports_nav_dirty = False
    except Exception as e:
        logger.error("Reports nav cache error: %s", e)
    return _reports_nav_cache

templates.env.globals["get_reports"] = get_reports_for_nav


# ──────────────────────────────────────────
# MAPPING MAINTENANCE
# ──────────────────────────────────────────
@app.get("/mapping-maintenance")
async def mapping_page(request: Request):
    user = get_current_user(request)
    if not user or user.get("role") != "Admin":
        return RedirectResponse(url="/login", status_code=303)
    conn = get_db_connection()
    try:
        mappings = conn.execute("SELECT m.whatsapp_name, m.student_id, s.name as student_name FROM xxgs_name_mapping m JOIN students s ON m.student_id = s.id ORDER BY m.whatsapp_name ASC").fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse("mapping.html", build_template_context(request, user, extra={"mappings": [dict(r) for r in mappings]}))


@app.post("/save-mapping")
async def save_mapping(request: Request, whatsapp_name: str = Form(...), student_id: int = Form(...)):
    user = get_current_user(request)
    if not user or user.get("role") != "Admin":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    conn = get_db_connection()
    try:
        conn.execute("INSERT OR REPLACE INTO xxgs_name_mapping (whatsapp_name, student_id) VALUES (?, ?)", (whatsapp_name.strip(), student_id))
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse("/mapping-maintenance", status_code=303)


# ──────────────────────────────────────────
# WHATSAPP ATTENDANCE IMPORT
# ──────────────────────────────────────────
@app.get("/attendance/import-whatsapp")
async def show_whatsapp_import_page(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("whatsapp_import.html", build_template_context(request, user))


@app.post("/attendance/import-whatsapp")
async def import_whatsapp_attendance(request: Request, whatsapp_data: str = Form(...)):
    user = get_current_user(request)
    if not user or user.get("role") not in ("Admin", "Coach"):
        return RedirectResponse(url="/login", status_code=303)
    conn = get_db_connection()
    try:
        attendance_date, student_entries = parse_whatsapp_attendance(whatsapp_data, conn)
        if not attendance_date:
            return JSONResponse({"error": "Could not find a valid date (DD/MM/YY)."}, status_code=400)
        if not student_entries:
            return JSONResponse({"error": "No matching students with checkmarks found."}, status_code=400)
        for entry in student_entries:
            conn.execute("DELETE FROM attendance WHERE student_id=? AND date=?", (entry["student_id"], attendance_date))
            for session in entry["sessions"]:
                conn.execute("INSERT INTO attendance (student_id, date, status, session) VALUES (?, ?, 'Present', ?)", (entry["student_id"], attendance_date, session))
        conn.commit()
        return RedirectResponse(url=f"/attendance?date={attendance_date}", status_code=303)
    except Exception as e:
        conn.rollback()
        return JSONResponse({"error": f"Import failed: {str(e)}"}, status_code=500)
    finally:
        conn.close()


def parse_whatsapp_attendance(raw_text: str, conn) -> tuple:
    date_match = re.search(r"(\d{2}/\d{2}/\d{2})", raw_text)
    if not date_match:
        return None, []
    db_date    = datetime.strptime(date_match.group(1), "%d/%m/%y").strftime("%Y-%m-%d")
    final_data = []
    for line in raw_text.split("\n"):
        line  = line.replace("\u200b", "")
        match = re.search(r"(?P<num>\d+[\.\s]*)?(?P<name>[A-Za-z][A-Za-z\s\.]+?)(?P<data>\t.*|✅.*|$)", line)
        if not match:
            continue
        # FIX H-04: group is named 'name' — was incorrectly match.group('n')
        whatsapp_name = match.group("name").strip()
        data_area     = match.group("data")
        if not whatsapp_name or whatsapp_name.lower() in ["m", "e", "am", "pm"]:
            continue
        check_count = data_area.count("✅")
        if check_count >= 2:
            sessions = ["Morning", "Evening"]
        elif check_count == 1:
            sessions = ["Evening"] if data_area.split("✅")[0].count("\t") >= 2 else ["Morning"]
        else:
            sessions = []
        mapping = conn.execute(
            "SELECT student_id FROM xxgs_name_mapping WHERE LOWER(TRIM(whatsapp_name)) = ?",
            (whatsapp_name.lower(),),
        ).fetchone()
        if mapping and sessions and not any(d["student_id"] == mapping["student_id"] for d in final_data):
            final_data.append({"student_id": mapping["student_id"], "sessions": sessions})
        elif not mapping and check_count > 0:
            logger.warning("WhatsApp import: unmapped name '%s'", whatsapp_name)
    logger.info("WhatsApp import: %d students processed for %s", len(final_data), db_date)
    return db_date, final_data


# ──────────────────────────────────────────
# MOBILE SYNC
# FIX H-01: Auth guard added — Admin or Coach required.
# FIX M-09: Default limit 500, ceiling 5000.
# ──────────────────────────────────────────
@app.get("/api/sync/students")
async def sync_students(request: Request, limit: int = Query(500, ge=1, le=5000)):
    user = get_current_user(request)
    if not user or user.get("role") not in ("Admin", "Coach"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM students ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        logger.info("[SYNC-API] Pushing %d records to mobile device", len(rows))
        return JSONResponse({
            "status": "success", "count": len(rows),
            "data": [dict(r) for r in rows],
            "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })
    except Exception as e:
        logger.error("[SYNC-API] Sync failed: %s", e, exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        conn.close()


# ──────────────────────────────────────────
# MOBILE UPLOAD — ATTENDANCE
# FIX H-06: Auth guard added — Coach or Admin required.
# ──────────────────────────────────────────
@app.post("/api/upload/attendance")
async def upload_attendance(request: Request):
    user = get_current_user(request)
    if not user or user.get("role") not in ("Admin", "Coach"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    conn = get_db_connection()
    try:
        data               = await request.json()
        attendance_records = data.get("temp_attendance", [])
        if not attendance_records:
            return JSONResponse({"message": "No records found"}, status_code=400)
        cursor = conn.cursor()
        for record in attendance_records:
            cursor.execute("DELETE FROM temp_attendance WHERE student_id=? AND date=?", (record["student_id"], record["date"]))
            cursor.execute("INSERT INTO temp_attendance (student_id, date, status, session) VALUES (?, ?, ?, ?)", (record["student_id"], record["date"], record["status"], record["session"]))
        conn.commit()
        logger.info("[UPLOAD] %d attendance records synced by %s", len(attendance_records), user.get("username"))
        return JSONResponse({"status": "success", "count": len(attendance_records)})
    except Exception as e:
        conn.rollback()
        logger.error("[UPLOAD] Attendance upload failed: %s", e)
        return JSONResponse({"error": "Sync failed", "detail": str(e)}, status_code=500)
    finally:
        conn.close()