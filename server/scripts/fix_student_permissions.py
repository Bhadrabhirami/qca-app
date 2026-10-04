#!/usr/bin/env python3
"""
Remove media:upload, media:delete, media:tag from Student and Parent roles.
Also removes attendance:take, attendance:upload from Student/Parent.
Students/Parents should see gallery only — no capture, no sync, no upload.
"""
import sqlite3, os

DB = os.getenv("DATABASE_PATH", "/opt/qca_app/qca.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Permissions to REMOVE from Student and Parent roles
remove_from_student_parent = [
    'media:upload',
    'media:delete',
    'media:tag',
    'attendance:take',
    'attendance:upload',
    'attendance:download',
    'attendance:delete',
    'attendance:share',
    'attendance:records',
    'attendance:dashboard',
    'student:add',
    'student:edit',
    'student:photo:upload',
    'student:photo:delete',
    'remarks:add',
    'remarks:edit:own',
    'remarks:edit:any',
    'remarks:delete:own',
    'remarks:delete:any',
    'sync:upload',
    'sync:download',
    'sync:students',
    'sync:payments',
    'sync:reupload',
    'sync:runall',
    'payments:add',
    'payments:alerts',
    'payments:summary',
    'matches:create',
    'matches:score',
    'matches:edit',
    'matches:delete',
]

roles_to_fix = ['Student', 'Parent']
total_removed = 0

for role_name in roles_to_fix:
    role = conn.execute(
        "SELECT id FROM roles WHERE name=?", (role_name,)
    ).fetchone()
    if not role:
        print(f"Role not found: {role_name}")
        continue

    for slug in remove_from_student_parent:
        perm = conn.execute(
            "SELECT id FROM permissions WHERE slug=?", (slug,)
        ).fetchone()
        if not perm:
            continue
        cur = conn.execute(
            "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
            (role["id"], perm["id"])
        )
        if cur.rowcount > 0:
            print(f"  Removed {slug} from {role_name}")
            total_removed += 1

conn.commit()
print(f"\n✅ Removed {total_removed} permissions from Student/Parent roles")

# Verify
print("\nRemaining permissions per role:")
for role_name in roles_to_fix:
    rows = conn.execute("""
        SELECT p.slug FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = ?
        ORDER BY p.slug
    """, (role_name,)).fetchall()
    print(f"\n  {role_name}:")
    for r in rows:
        print(f"    {r['slug']}")

conn.close()
