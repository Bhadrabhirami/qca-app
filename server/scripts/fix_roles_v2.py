#!/usr/bin/env python3
"""
QCA Role Permission Update v2
- Adds Member role (read-only all students/attendance/payments)
- Fixes Coach permissions (removes unwanted permissions)  
- Removes reminders page access from Student/Parent
- Ensures correct permission sets for all roles
"""
import sqlite3, os, sys

DB = os.getenv("DATABASE_PATH", "/opt/qca_app/qca.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# ── Ensure Member role exists ─────────────────────────────────────────────────
conn.execute("INSERT OR IGNORE INTO roles (name, description) VALUES ('Members', 'Read-only access to all student data')")

# ── Ensure new permissions exist ──────────────────────────────────────────────
new_perms = [
    ('app:reminders',  'Payment Reminders Hub', 'app'),
    ('app:correction', 'Attendance Correction', 'app'),
]
for slug, label, module in new_perms:
    conn.execute("INSERT OR IGNORE INTO permissions (slug, label, module) VALUES (?,?,?)", (slug, label, module))

conn.commit()

# ── Role definitions ──────────────────────────────────────────────────────────
ROLE_PERMS = {

    'Admin': [
        'attendance:view','attendance:take','attendance:upload','attendance:download',
        'attendance:delete','attendance:share','attendance:history','attendance:records',
        'attendance:dashboard',
        'student:view','student:add','student:edit',
        'student:photo:upload','student:photo:delete',
        'remarks:view','remarks:add','remarks:edit:own','remarks:edit:any',
        'remarks:delete:own','remarks:delete:any',
        'sync:upload','sync:download','sync:students','sync:payments',
        'sync:reupload','sync:runall',
        'payments:view','payments:add','payments:alerts','payments:summary',
        'media:view','media:upload','media:delete','media:tag',
        'matches:view','matches:create','matches:score','matches:edit','matches:delete',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
        'app:news','app:pulse','app:reminders','app:correction',
    ],

    'Coach': [
        'attendance:view','attendance:take','attendance:upload','attendance:download',
        'attendance:share','attendance:history','attendance:records','attendance:dashboard',
        'student:view',
        'remarks:view','remarks:add','remarks:edit:own','remarks:delete:own',
        'sync:upload','sync:download',
        'payments:view','payments:add',
        'media:view','media:upload','media:tag',
        'matches:view','matches:score',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
        'app:news','app:pulse',
    ],

    'Members': [
        'student:view',
        'attendance:view','attendance:history',
        'payments:view',
        'matches:view',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
        'app:news',
    ],

    'Scorer': [
        'matches:view','matches:score',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
    ],

    'Parent': [
        'student:view',
        'attendance:view','attendance:history',
        'payments:view',
        'matches:view','media:view',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
        'app:news','app:pulse',
    ],

    'Student': [
        'student:view',
        'attendance:view',
        'payments:view',
        'matches:view','media:view',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
        'app:news','app:pulse',
    ],

    'Viewer': [
        'matches:view',
        'app:settings','app:biometric','app:library','app:videos','app:contact',
    ],
}

# ── Apply: clear old + set new for each role ──────────────────────────────────
total_set = 0
for role_name, slugs in ROLE_PERMS.items():
    role = conn.execute("SELECT id FROM roles WHERE name=?", (role_name,)).fetchone()
    if not role:
        print(f"  ⚠ Role not found: {role_name} — skipping")
        continue

    # Remove ALL existing permissions for this role
    conn.execute("DELETE FROM role_permissions WHERE role_id=?", (role['id'],))

    # Set exactly the permissions we want
    granted = 0
    for slug in slugs:
        perm = conn.execute("SELECT id FROM permissions WHERE slug=?", (slug,)).fetchone()
        if not perm:
            print(f"  ⚠ Permission not found: {slug}")
            continue
        conn.execute(
            "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)",
            (role['id'], perm['id'])
        )
        granted += 1
    total_set += granted
    print(f"  ✓ {role_name:<12} → {granted} permissions set")

conn.commit()

# ── Verify ────────────────────────────────────────────────────────────────────
print(f"\n✅ Total permissions set: {total_set}")
print("\nVerification:")
rows = conn.execute("""
    SELECT r.name, COUNT(rp.id) as cnt
    FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
    GROUP BY r.name ORDER BY r.id
""").fetchall()
for r in rows:
    print(f"  {r['name']:<14} {r['cnt']} permissions")

conn.close()
