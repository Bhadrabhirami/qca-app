# QCA Cricket Academy — Mobile App Project Documentation

**Version:** Build 122+  
**Last Updated:** July 2026  
**Stack:** Capacitor v6 · React · TypeScript · FastAPI · SQLite

---

## 1. Project Overview

The **QCA Cricket Academy App** is a mobile application for Quickies Cricket Academy, Trivandrum. It manages students, attendance, payments, utilities, and club members through an Android app connected to a FastAPI/SQLite backend.

### Architecture

| Layer | Technology | Location |
|---|---|---|
| Mobile App | Capacitor v6 + React + TypeScript | `C:\Users\User\qca_app` |
| Backend Server | FastAPI + SQLite | `opc@qca.duckdns.org:/opt/qca_app` |
| Local DB | SQLite via sql.js | `src/database/db.ts` |
| Service | `xxgs_qca` systemd | Production server |

### Key Files

| File | Purpose |
|---|---|
| `src/database/db.ts` | Local SQLite schema, migrations, INSERT, getAllStudents, getActiveStudents |
| `src/pages/useSyncService.ts` | Sync service — upsertStudentsLocal, attendance sync |
| `src/pages/studentUtils.ts` | Shared: matchesStudentSearch(), formatRegno(), sortByRegno() |
| `src/shared/StudentPhoto.tsx` | Student photo component with blob URL caching |
| `/opt/qca_app/routes/api_data.py` | All server endpoints |
| `/opt/qca_app/qca.db` | Production SQLite database |
| `/opt/qca_app/static/images/students/` | Student profile photos |
| `/opt/qca_app/static/club_assets/` | Club member photos |

---

## 2. Database Schema

### Students Table
```sql
CREATE TABLE students (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT,
  age                     INTEGER,
  phone                   TEXT,
  email                   TEXT,
  level                   TEXT,
  user_id                 INTEGER,           -- NULL (not set on create)
  status                  TEXT,              -- Active, Camp, Club Member, Inactive
  school_name             TEXT,
  date_of_birth           TEXT,
  parent_name             TEXT,
  student_type            TEXT,              -- Academy, Club Member, Camp
  blood_group             TEXT,
  dominant_side           TEXT,
  profile_image           TEXT,              -- filename e.g. "1000.jpg"
  monthly_fee             REAL,
  student_category        TEXT,
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
  regno                   TEXT,              -- Registration number e.g. "74"
  address                 TEXT,
  qca_id                  INTEGER            -- QCA assigned ID (manually set)
);
```

### Club Members Table (server only)
```sql
-- id, name, category, position, dob, address, phone_with_isd,
-- image_url, sort_order, status, session_id, created_at, portal_access
```

### Key Supporting Tables
- `payments` — fee_type_id IN (1,2,3,4,15,16) for actual fees
- `attendance` — attendance_date, session_type, student_id, status
- `permissions` — PBAC permission slugs
- `roles` — Admin, Coach, Members, Student, Parent
- `role_permissions` — role-to-permission mapping
- `temp_students` — offline-created students pending server sync
- `reminder_config` — key-value config (academy_name etc.)

---

## 3. Student Fields & Rules

### Critical: Two INSERT Paths, Two SELECT Paths

Every time a student field is added, **all four** must be updated:

1. `db.ts` — `INSERT OR REPLACE INTO students` (local add)
2. `useSyncService.ts` — `upsertStudentsLocal` (sync upsert)
3. `db.ts` — `getAllStudents()` SELECT
4. `db.ts` — `getActiveStudents()` SELECT

### Migrations
`_addCol()` runs on every app open — silently skips if column exists:
```typescript
_addCol('regno',    'TEXT');
_addCol('address',  'TEXT');
_addCol('qca_id',   'INTEGER');
```

### Admin-Only Fields
- `regno` — Registration number (e.g. "74" → displays as "074")
- `qca_id` — QCA ID number (e.g. 93 → displays as "Q093")
- `address` — Student address

---

## 4. Student Search — studentUtils.ts

Shared across all pages. **One place to change, all pages benefit.**

```typescript
// Name + regno search (default)
matchesStudentSearch(student, "sravan")   // matches name
matchesStudentSearch(student, "74")       // matches regno
matchesStudentSearch(student, "q93")      // matches qca_id = 93 (q prefix)

// Display
formatRegno("74")  // → "074"

// Sort (DB handles this via ORDER BY)
sortByRegno(students)
```

### Placeholder across all pages
`Name, Reg No or q+QCA ID…`

### Pages using studentUtils
students, attendance, payments, records, history, matches, media, utilities, reminders, dashboard

---

## 5. Student Sort Order

All queries sort by regno numerically, nulls last:
```sql
ORDER BY
  CASE WHEN regno IS NULL OR regno = '' THEN 1 ELSE 0 END ASC,
  CAST(regno AS INTEGER) ASC,
  id ASC
```

Applied in:
- `getAllStudents()` — db.ts
- `getActiveStudents()` — db.ts
- `/sync/students` — server
- `/utils/students` — server
- `/utils/monthly-report` — server
- `/utils/age-groups` — server

---

## 6. URL Construction Rule

**Critical:** Always use `buildBase(localStorage.getItem('server_ip'))` — the single source of truth computed by Settings on Save. Never reconstruct from `server_proto`/`server_host`/`server_port` separately.

**Port handling:** Never hardcode `:3125`. Empty port string means reverse-proxied on 80/443.

---

## 7. Pages & Features

### 🏠 Home (index.tsx)
- Navigation grid to all features
- **Birthday Banner** — shows gold banner if any student/club member has birthday today
  - Calls `/api/data/utils/birthdays?month=0` once per day on first open
  - Dismissed with ✕ → stored in `localStorage('bday_dismissed')` keyed to today's date
  - Shows only once per day, reappears next day

### 📊 Dashboard (dashboard.tsx)
- Attendance summary for today
- Student dues overview
- Birthday banner (same as home)
- Pull-to-refresh

### 👥 Students (students.tsx)
- Student list sorted by regno
- Card shows: `074 · Q093 · Beginner`
- Search: name, regno, or `q93` for QCA ID
- Detail modal with all profile fields
- Photo tap → full screen zoom
- Admin can edit profile via Edit button

### ✏️ Edit Profile (editprofile.tsx)
- Sections: Personal, Education, Contact, Academy
- Admin-only fields: QCA ID, Reg No, Address
- Name is read-only (shown in header)
- Photo upload/delete

### 📅 Attendance (attendance.tsx)
- Uses `getActiveStudents()` — Active + Club Member students
- Sorted by regno
- Morning/Evening sessions
- Mark present/absent with tap
- Share attendance via WhatsApp
- Load/generate report

### 💰 Payments (payments.tsx)
- Record Payment — student picker sorted by regno
- Loads from server (`/api/data/students`)
- Fee types 1,2,3,4,15,16 = actual fees

### 📋 Records (records.tsx)
- Attendance records and payment history
- Sorted by regno within date groups
- Generate report with regno prefix in lines
- WhatsApp share

### 📜 History (history.tsx)
- Student attendance history
- Search by name or regno

### 🏏 Matches (matches.tsx)
- Match management and scoring
- Student picker with regno search

### 🖼️ Media (media.tsx)
- Academy Pulse photo gallery
- Student search with regno

### 📰 News (news.tsx)
- Cricket Hub news/insights feed

### 📚 Library (library.tsx)
- Coaching library resources

### 🔔 Reminders (reminders.tsx)
- Fee reminder hub
- WhatsApp/email integration

### ℹ️ About (about.tsx)
- Club members with photos
- Uses `getCachedMemberImageUrl` for blob URL caching

### ⚙️ Settings (settings.tsx)
- Server URL configuration (Full URL Preview)
- Change password
- Notification toggles

---

## 8. Utilities Page (utilities.tsx)

Permission-gated tabs:

### 📋 Students Tab (`utils:students`)
- Full roster from server `/utils/students`
- Student photo thumbnails (`MemberAvatar`)
- Search by name/regno
- Sorted by regno
- Contact details (Admin: `utils:students:contact`)

### 📅 Attendance Tab (`utils:attendance`)
- Attendance records from server
- Student photos

### 💰 Payments Tab (`utils:payments`)
- Payment records from server
- Student photos

### 📊 Monthly Report Tab (`utils:report`)
- Roster with attendance counts
- Fee paid/unpaid status
- Student photos
- **Export PDF** — generates roster PDF via `/utils/monthly-report/roster-pdf`

### 🚫 Inactive Review Tab (`utils:inactive`)
- Auto write-off + mark inactive for non-attending students
- Undo/restore capability

### 🏏 Age Groups Tab (`utils:agegroups`)
- BCCI tournament eligibility groups
- Cutoff: **August 1** of current year
- **Cumulative**: U17 shows ALL students ≤ 16 (includes U8, U12, U14 kids)
- Groups: U8, U12, U14, U17, U19, Seniors
- Only `student_type = 'Academy'` AND `status != 'Inactive'`
- Custom Age Range: stepper +/- for min/max age, shows filtered students
- Student photos with tap-to-zoom

### 🎂 Birthdays Tab (`utils:agegroups`)
- Loads from server `/utils/birthdays`
- Includes **both** students AND club members
- 🎉 Today's birthdays (highlighted gold)
- 📅 Upcoming 30 days
- 📆 Month browser (tap any month)
- Shows current age (not "turns X")
- Student/member photos with tap-to-zoom

---

## 9. Server Endpoints

### Sync Endpoints
| Endpoint | Purpose |
|---|---|
| `GET /sync/students` | Full student sync to device |
| `GET /sync/attendance` | Attendance sync |
| `GET /sync/payments` | Payments sync |

### Utils Endpoints
| Endpoint | Purpose |
|---|---|
| `GET /utils/students` | Admin roster with photos |
| `GET /utils/attendance` | Attendance records with photos |
| `GET /utils/payments` | Payment records with photos |
| `GET /utils/monthly-report` | Monthly report with roster + payments |
| `GET /utils/monthly-report/roster-pdf` | PDF export with photo thumbnails |
| `GET /utils/birthdays?month=N` | Birthdays — students + club members |
| `GET /utils/age-groups?month=YYYY-MM` | Age groups + birthdays |

### Student Endpoints
| Endpoint | Purpose |
|---|---|
| `GET /students/{id}/profile` | Get profile (Admin: includes admin fields) |
| `PUT /students/{id}/profile` | Update profile |
| `POST /students/register` | Register new student (`user_id=NULL`) |
| `POST /students/{id}/photo` | Upload photo → saved to `/static/images/students/` |

### Auth
All endpoints: `X-Api-Key`, `X-Username`, `X-Password` headers

---

## 10. PDF Roster Export

Endpoint: `GET /utils/monthly-report/roster-pdf?month=YYYY-MM&hide_zero_attendance=0/1`

**Columns:** `# | Photo | QCA | Reg | Student Name | Type | Mrn | Eve | Tot | Fee | Status`

**Rules:**
- Sorted by regno numerically
- Club Members: Fee and Status columns empty
- Fee shows actual paid amount from payments table (fee_type_id IN 1,2,3,4,15,16)
- Currency: `Rs.`
- Photo: small thumbnail (6×6mm) from `/static/images/students/`
- Row colors: green = paid, red = unpaid, grey = Club Member

---

## 11. Photo System

### Student Photos
- Stored: `/opt/qca_app/static/images/students/{id}.jpg`
- DB field: `profile_image` (filename only, e.g. `"1000.jpg"`)
- Client: `getCachedImageUrl(profileImage)` → blob URL
- Component: `<StudentPhoto student={s} size={48}/>`

### Club Member Photos
- Stored: `/opt/qca_app/static/club_assets/member_{n}.jpg`
- DB field: `image_url` (relative path, e.g. `"/static/club_assets/member_1.jpg"`)
- Client: `getCachedMemberImageUrl(imageUrl)` → blob URL

### MemberAvatar Component (utilities.tsx)
Handles both types with initials fallback:
```typescript
<MemberAvatar item={s} size={36}/>
// Uses profile_image → getCachedImageUrl
// Uses image_url → getCachedMemberImageUrl
// Fallback: initials in green circle
```

---

## 12. Permission System (PBAC)

### Permission Slugs
```
student:view, student:edit, student:add
student:view:detail, student:view:fees
student:edit:any, student:edit:own
student:photo:upload, student:photo:delete
student:manage:inactive

attendance:view, attendance:take, attendance:mark
attendance:upload, attendance:download
attendance:share, attendance:history
attendance:records, attendance:dashboard
attendance:delete, attendance:correction

payments:view, payments:record, payments:add
payments:summary, payments:alerts
payments:export, payments:writeoff
payments:writeoff:reverse

utils:students, utils:students:contact
utils:attendance, utils:payments
utils:report, utils:inactive
utils:export, utils:agegroups

sync:upload, sync:download, sync:students
sync:payments, sync:reupload, sync:runall

app:settings, app:biometric, app:contact
app:library, app:news, app:pulse
app:reminders, app:videos, app:correction

matches:view, matches:create, matches:edit
matches:score, matches:delete

media:view, media:upload, media:delete, media:tag
remarks:view, remarks:add
remarks:edit:own, remarks:edit:any
remarks:delete:own, remarks:delete:any
```

### Roles
- **Admin** — all permissions
- **Coach** — attendance, students (own), payments view, utils, matches
- **Members** — basic view permissions
- **Student/Parent** — own data only

---

## 13. Age Group Logic (BCCI)

Cutoff date: **August 1** of current year.

A student's age is calculated ON August 1. Each tournament group includes ALL students eligible (cumulative):

| Group | Eligible (age on Aug 1) |
|---|---|
| U8 | age ≤ 7 |
| U12 | age ≤ 11 (includes U8) |
| U14 | age ≤ 13 (includes U8, U12) |
| U17 | age ≤ 16 (includes U8, U12, U14) |
| U19 | age ≤ 18 (includes all above) |
| Seniors | age ≥ 19 |

Filter: `student_type = 'Academy'` AND `status != 'Inactive'`

---

## 14. Local Dev Setup

### Requirements
- PC IP: `192.168.1.189` (check with `ipconfig`)
- Local server port: `3125`
- Android network security config: `android/app/src/main/res/xml/network_security_config.xml`
  ```xml
  <network-security-config>
    <base-config cleartextTrafficPermitted="true"/>
  </network-security-config>
  ```
- `capacitor.config.ts` — `allowNavigation` includes `192.168.1.189`

### Build & Deploy
```powershell
npm run build          # bumps build number, builds to dist/
npx cap sync android   # copies to Android project
# Then run/install via Android Studio or USB
```

### Server (Local)
```powershell
cd C:\qca_application
python main.py         # starts on port 3125
```

### Server (Production)
```bash
ssh opc@qca.duckdns.org
sudo systemctl restart xxgs_qca
sudo journalctl -u xxgs_qca -n 50 --no-pager
```

---

## 15. Critical Lessons Learned

1. **Two INSERT paths**: `db.ts` (local add) + `useSyncService.ts` (sync) — BOTH must be updated for every new student field
2. **Two SELECT paths**: `getAllStudents` + `getActiveStudents` — both must include new fields
3. **Shared functions over per-page fixes**: `studentUtils.ts`, `MemberAvatar` — single source of truth
4. **URL construction**: Always `buildBase(localStorage.getItem('server_ip'))`, never reconstruct from parts
5. **Port handling**: Never hardcode `:3125`, empty port = reverse proxy
6. **Photo caching**: `getCachedImageUrl` for students (filename), `getCachedMemberImageUrl` for members (relative path)
7. **Migrations**: `_addCol()` runs on every app open, silently skips existing columns — safe for upgrades
8. **Server sort**: Utilities tabs load from server — sort must be in SQL ORDER BY, not JS
9. **Birthday banner**: Once per day via `localStorage('bday_dismissed')` keyed to date
10. **Club Members fee**: Fee and Status columns empty in PDF for Club Member status students

---

## 16. Recent Changes (July 2026)

- Added `regno`, `address`, `qca_id` fields to students (full stack)
- Student search: name+regno by default, `q93` prefix for QCA ID
- `studentUtils.ts` — shared search/format/sort (all pages)
- Age Groups tab — BCCI cumulative eligibility, U8/U12/U14/U17/U19/Seniors
- Birthdays tab — students + club members, today/upcoming/month browser, photo zoom
- Birthday banner on home and dashboard (once per day)
- PDF roster — photo thumbnails per row, QCA ID column, `Rs.` currency
- Club Member rows — empty fee/status in PDF
- `MemberAvatar` component — unified photo display for students and members
- All utilities tabs — student/member photos via `MemberAvatar`
- Student detail modal — photo tap to zoom

