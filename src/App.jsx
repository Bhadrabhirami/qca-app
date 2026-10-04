import React, { useEffect } from 'react';
import { HashRouter, Route, Routes, Outlet } from 'react-router-dom';
import { useSyncService, fullRefreshFromServer } from './pages/useSyncService';
import UtilitiesScreen           from './pages/utilities';
import AttendanceCorrectionScreen from './pages/attendance_correction';
import LibraryScreen     from './pages/library';
import VideosScreen      from './pages/videos';
import ContactScreen     from './pages/contact';
import AboutScreen       from './pages/about';
import NewsScreen       from './pages/news';
import PulseScreen      from './pages/pulse';
import RemindersScreen   from './pages/reminders';
import { saveUserContext, PermRoute, isDataRestricted, getLinkedStudentIds } from './pages/usePermissions';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import AppLock   from './pages/AppLock';
import LoginPage from './pages/Login';
import BottomNav from './shared/BottomNav';
import MoreScreen from './pages/more';
import * as db from './database/db';
// SimpleLayout — persistent scroll area + bottom tab bar.
// Page-level `position: fixed` elements (FABs, toasts, full-screen
// drawers/modals with inset:0) stay relative to the viewport as normal —
// drawers correctly cover the whole visible screen regardless of scroll
// position, and modals render on top of BottomNav (expected — nav
// shouldn't be usable while a modal is open). The only thing pages need
// to account for is BottomNav's own height for bottom-anchored FABs/toasts
// so they don't sit behind it — see NAV_CLEARANCE in shared/BottomNav.tsx.
const SimpleLayout = () => (
  <div className="app-shell">
    <div className="app-scroll">
      <Outlet />
    </div>
    <BottomNav />
  </div>
);
import AttendanceScreen from './pages/attendance';
import DashboardScreen  from './pages/dashboard';
import HistoryScreen    from './pages/history';
import MainMenu         from './pages/index';
import PaymentsScreen   from './pages/payments';
import RecordsScreen    from './pages/records';
import SettingsScreen   from './pages/settings';
import StudentsScreen   from './pages/students';
import SyncScreen       from './pages/sync';
import NewSyncScreen    from './pages/Syncscreen';
import MediaScreen      from './pages/media';
import MatchesScreen    from './pages/matches';
import RemarksScreen    from './pages/remarks';
import AddStudentScreen from './pages/addstudent';
import EditProfileScreen from './pages/editprofile';
import FinanceScreen    from './pages/finance';
import VoidPaymentsScreen from './pages/VoidPayments';
import CoachRosterScreen  from './pages/CoachRoster';
import NetsHubScreen    from './pages/nets_hub';
import NetsStaffScreen   from './pages/nets_staff';
import NetsAdminScreen   from './pages/nets_admin';
import NetsCalendarScreen from './pages/nets_calendar';

// ─── Student/Parent auto-sync — pulls own data silently on login ──────────────
async function studentAutoSync(base, headers, linkedIds) {
  try {
    // 1. Pull own student profile(s)
    for (const sid of linkedIds) {
      try {
        const r = await fetch(`${base}/api/data/students/${sid}/profile`, { headers });
        if (r.ok) {
          const j = await r.json();
          if (j.data) await db.syncAllStudents([j.data]);
        }
      } catch {}
    }

    // 2. Pull own attendance history
    for (const sid of linkedIds) {
      try {
        const r = await fetch(`${base}/api/data/hager?student_id=${sid}`, { headers });
        if (r.ok) {
          const j = await r.json();
          if (j.data?.length) {
            await db.upsertHistAttendance(j.data);
            await db.syncHistToAttendance();
          }
        }
      } catch {}
    }

    // 3. Pull matches
    try {
      const r = await fetch(`${base}/api/data/matches`, { headers });
      if (r.ok) {
        const j = await r.json();
        if (j.data?.length) {
          localStorage.setItem('cached_matches', JSON.stringify(j.data));
          localStorage.setItem('cached_matches_time', Date.now().toString());
        }
      }
    } catch {}

    // 4. Pull own remarks → localStorage cache
    for (const sid of linkedIds) {
      try {
        const r = await fetch(`${base}/api/data/remarks?student_id=${sid}&limit=50`, { headers });
        if (r.ok) {
          const j = await r.json();
          if (j.data?.length) localStorage.setItem(`cached_remarks_${sid}`, JSON.stringify(j.data));
        }
      } catch {}
    }

    // 5. Pull own payments → SQLite
    try {
      const allPayRows = [];
      for (const sid of linkedIds) {
        try {
          const r = await fetch(`${base}/api/data/payments?student_id=${sid}&limit=500`, { headers });
          if (r.ok) {
            const j = await r.json();
            if (j.data?.length) allPayRows.push(...j.data);
          }
        } catch {}
      }
      if (allPayRows.length) await db.upsertPayments(allPayRows);
    } catch (e) { console.warn('Payment sync failed:', e); }

  } catch (e) {
    console.warn('Student auto-sync failed (offline?):', e);
  }
}

// ─── Error Boundary — catches crashes and shows them instead of white screen ──
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('App crash:', e, info); }
  render() {
    if (this.state.error) {
      return React.createElement('div', {
        style: {
          padding: '40px 24px', fontFamily: 'sans-serif',
          backgroundColor: '#fff', minHeight: '100vh',
        }
      },
        React.createElement('div', { style: { fontSize: 40, marginBottom: 16 } }, '⚠️'),
        React.createElement('div', { style: { fontWeight: 800, fontSize: 18, color: '#dc2626', marginBottom: 12 } },
          'App Error'),
        React.createElement('pre', {
          style: {
            fontSize: 11, backgroundColor: '#f9fafb', padding: 16,
            borderRadius: 8, overflowX: 'auto', color: '#374151',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }
        }, String(this.state.error?.message || this.state.error)),
        React.createElement('button', {
          onClick: () => { this.setState({ error: null }); window.location.reload(); },
          style: {
            marginTop: 20, padding: '12px 24px', borderRadius: 10,
            backgroundColor: '#1a472a', color: '#fff', border: 'none',
            fontWeight: 700, fontSize: 14, cursor: 'pointer',
          }
        }, 'Reload App')
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [bioLocked, setBioLocked] = React.useState(() => {
    // Show biometric prompt if enabled and we have a valid session
    const enabled = localStorage.getItem('biometric_enabled') === 'true';
    const token   = localStorage.getItem('jwt_token');
    const expiry  = parseInt(localStorage.getItem('jwt_expiry') || '0');
    const hasSession = token && Date.now() < expiry - 60000;
    return enabled && !!hasSession;
  });

  const [jwtUser, setJwtUser] = React.useState(() => {
    try {
      // Check plain localStorage (set by Login.tsx)
      const u = localStorage.getItem('jwt_user_cache');
      if (u) { const p = JSON.parse(u); if (p?.username) return p; }
      // Check Capacitor Preferences format
      const cu = localStorage.getItem('CapacitorStorage.jwt_user');
      if (cu) { const p = JSON.parse(cu); if (p?.username) return p; }
    } catch {}
    return null;
  });

  // On startup: refresh permissions from server using JWT token
  React.useEffect(() => {
    // Older builds stored the plain-text password here — wipe it on upgrade
    localStorage.removeItem('auth_pass');
    const token = localStorage.getItem('jwt_token');
    const ip    = localStorage.getItem('server_ip');
    if (!token || !ip) return;
    const base = ip.trim().replace(/\/+$/, '');
    const url  = (base.startsWith('http') ? base : 'http://' + base) + '/api/auth/verify';
    fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ access_token: token }),
    })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (j && j.valid && j.permissions && j.permissions.length > 0) {
        saveUserContext({
          permissions:      j.permissions,
          role:             j.role || '',
          authenticated_as: j.username || '',
        });
        setTimeout(() => window.dispatchEvent(new Event('permissions-changed')), 50);
      }
    })
    .catch(() => {
      // Offline - use cached permissions
      try {
        const cache = localStorage.getItem('jwt_user_cache');
        if (!cache) return;
        const user = JSON.parse(cache);
        if (user.permissions && user.permissions.length > 0) {
          saveUserContext({
            permissions:      user.permissions,
            role:             user.role || '',
            authenticated_as: user.username || '',
          });
          setTimeout(() => window.dispatchEvent(new Event('permissions-changed')), 50);
        }
      } catch {}
    });
  }, []);

  // Global fetch interceptor + JWT expiry handler
  React.useEffect(() => {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await _fetch(...args);
      if (res.status === 401) {
        const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
        if (exp && Date.now() > exp) {
          const bioEnabled = localStorage.getItem('biometric_enabled') === 'true';
          if (bioEnabled) {
            // Show biometric lock instead of full logout
            window.dispatchEvent(new Event('bio-lock'));
          } else {
            window.dispatchEvent(new Event('jwt-expired'));
          }
        }
      }
      return res;
    };
    return () => { window.fetch = _fetch; };
  }, []);

  React.useEffect(() => {
    const onExpired = () => {
      ['jwt_token','jwt_expiry','jwt_user_cache','auth_user','auth_pass',
       'user_permissions','user_role','user_type','linked_student_ids','is_restricted']
        .forEach(k => localStorage.removeItem(k));
      setJwtUser(null);
    };
    const onBioLock = () => setBioLocked(true);
    window.addEventListener('jwt-expired', onExpired);
    window.addEventListener('bio-lock', onBioLock);
    return () => {
      window.removeEventListener('jwt-expired', onExpired);
      window.removeEventListener('bio-lock', onBioLock);
    };
  }, []);

  const handleJwtSuccess = (user, token) => {
    // Save token for API calls
    localStorage.setItem('jwt_token',      token);
    localStorage.setItem('jwt_user_cache', JSON.stringify(user));
    // expiry set from server's expires_in in Login.tsx
    localStorage.setItem('auth_user',      user.username);
    localStorage.removeItem('auth_pass');
    // Offer biometric setup after first password login
    if (localStorage.getItem('biometric_pending_setup') === 'true') {
      localStorage.removeItem('biometric_pending_setup');
      setTimeout(() => {
        if (window.confirm('Enable biometric login for faster access next time?')) {
          localStorage.setItem('biometric_enabled', 'true');
        }
      }, 1500);
    }
    // Save permissions from JWT response immediately
    saveUserContext({
      permissions:      user.permissions || [],
      role:             user.role        || '',
      authenticated_as: user.username    || '',
    });
    setJwtUser(user);
    // Ping server with JWT to refresh permissions after render
    const ip = localStorage.getItem('server_ip') || '';
    if (ip && token) {
      const base = ip.trim().replace(/\/+$/, '');
      const url = (base.startsWith('http') ? base : 'http://' + base) + '/api/data/ping';
      fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (j && j.permissions) {
            saveUserContext({
              permissions:      j.permissions,
              role:             j.role || user.role || '',
              authenticated_as: user.username,
            });
            setTimeout(() => window.dispatchEvent(new Event('permissions-changed')), 50);
          }
        })
        .catch(() => {
          // Fallback: use permissions from JWT
          setTimeout(() => window.dispatchEvent(new Event('permissions-changed')), 50);
        });
    } else {
      setTimeout(() => window.dispatchEvent(new Event('permissions-changed')), 50);
    }
  };

  // Background sync — runs silently, keeps local DB fresh from server
  useSyncService({
    intervalMs: 5 * 60 * 1000,
    onSyncComplete: (r) => {
      const total = r.students + r.payments + r.attendance + r.writeoffs;
      if (total > 0) {
        window.dispatchEvent(new CustomEvent('sync-complete', { detail: r }));
      }
    },
  });


  // Re-ping server on every app launch to refresh role from server
  useEffect(() => {
    const ip      = localStorage.getItem('server_ip')  || '';
    const user    = localStorage.getItem('auth_user')  || '';
    const jwtCache = localStorage.getItem('jwt_user_cache');

    if (!ip || !user) return; // not configured yet

    // Build headers - JWT or legacy
    const jwt   = localStorage.getItem('jwt_token') || '';
    const jexp  = parseInt(localStorage.getItem('jwt_expiry') || '0');
    const hasJwt = jwt && Date.now() < jexp - 60000;
    let pingHeaders;
    if (hasJwt) {
      pingHeaders = { 'Authorization': 'Bearer ' + jwt, 'X-Username': user };
    } else {
      const pass = localStorage.getItem('auth_pass')  || '';
      const key  = localStorage.getItem('secret_key') || '';
      if (!pass || !key) return;
      pingHeaders = { 'X-Api-Key': key, 'X-Username': user, 'X-Password': pass };
    }

    const base = ip.trim().replace(/\/+$/, '');
    const url  = (base.startsWith('http') ? base : 'http://' + base) + '/api/data/ping';
    fetch(url, {
      headers: {
        ...pingHeaders,
      },
      signal: AbortSignal.timeout(5000),
    })
      .then(r => {
        if (r.status === 401) {
          // Token invalid/expired - clear and force re-login
          localStorage.removeItem('jwt_token');
          localStorage.removeItem('jwt_expiry');
          localStorage.removeItem('jwt_user_cache');
          localStorage.removeItem('auth_user');
          localStorage.removeItem('user_permissions');
          window.location.reload();
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(async j => {
        if (!j) return;
        // Save notification config immediately
        if (j.email_config) localStorage.setItem('notif_email_config', JSON.stringify(j.email_config));
        if (j.wa_config)    localStorage.setItem('notif_wa_config',    JSON.stringify(j.wa_config));
        const FALLBACK = {
          // Admin — full access
          admin:  ['attendance:view','attendance:take','attendance:upload','attendance:download',
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
                   'app:news','app:pulse'],
          // Coach — attendance + students + payments, no delete/edit of others
          coach:  ['attendance:view','attendance:take','attendance:upload','attendance:download',
                   'attendance:share','attendance:history','attendance:records','attendance:dashboard',
                   'student:view',
                   'remarks:view','remarks:add','remarks:edit:own','remarks:delete:own',
                   'sync:upload','sync:download',
                   'payments:view','payments:add',
                   'media:view','media:upload','media:tag',
                   'matches:view','matches:score',
                   'app:settings','app:biometric','app:library','app:videos','app:contact',
                   'app:news','app:pulse'],
          // Member — read-only view of all students, attendance, payments
          members:['student:view','attendance:view','attendance:history',
                   'payments:view',
                   'matches:view',
                   'app:settings','app:biometric','app:library','app:videos','app:contact',
                   'app:news'],
          // Scorer — match scoring only
          scorer: ['matches:view','matches:score',
                   'app:settings','app:biometric','app:library','app:videos','app:contact'],
          // Parent — own child only (restricted), gallery, no reminders
          parent: ['student:view','attendance:view','attendance:history',
                   'payments:view','matches:view','media:view',
                   'app:settings','app:biometric','app:library','app:videos','app:contact',
                   'app:news','app:pulse'],
          // Student — own data only (restricted), gallery, no reminders
          student:['student:view','attendance:view','payments:view',
                   'matches:view','media:view',
                   'app:settings','app:biometric','app:library','app:videos','app:contact',
                   'app:news','app:pulse'],
          // Viewer — public match data only
          viewer: ['matches:view',
                   'app:settings','app:biometric','app:library','app:videos','app:contact'],
        };
        const role = (j.role || 'viewer').toLowerCase();
        const slugs = j.permissions || FALLBACK[role] || FALLBACK.viewer;
        saveUserContext({
          permissions:        slugs,
          role:               j.role,
          user_type:          j.user_type          || 'staff',
          user_id:            j.user_id            || 0,
          linked_student_ids: j.linked_student_ids || [],
          is_restricted:      j.is_restricted      || false,
          authenticated_as:   j.authenticated_as,
        });
        // Store restriction flags for useSyncService
        localStorage.setItem('qca_is_restricted', j.is_restricted ? '1' : '0');
        localStorage.setItem('qca_linked_ids', JSON.stringify(j.linked_student_ids || []));

        // ── Role-change detection ─────────────────────────────────────────
        // If a different user or different role logs in on same device,
        // local DB must be wiped — previous user's data must not leak.
        const prevUser = localStorage.getItem('_last_auth_user') || '';
        const prevRole = localStorage.getItem('_last_auth_role') || '';
        const currUser = user;
        const currRole = role;
        const userChanged = prevUser !== currUser;
        const roleChanged = prevRole !== currRole;

        if (userChanged || roleChanged) {
          console.log(`[AUTH] Role/user changed (${prevRole}→${currRole}, ${prevUser}→${currUser}) — clearing local DB`);
          // Clear local data — will be re-populated by Full Refresh
          try {
            const { getDb } = await import('./database/db');
            const db = await getDb();
            for (const t of ['students','payments','attendance','hist_attendance','fee_write_offs']) {
              try { db.run('DELETE FROM ' + t); } catch {}
            }
            localStorage.removeItem('qca_sync_meta');
          } catch {}
          // Mark change so UI can prompt user to refresh
          localStorage.setItem('_needs_refresh', '1');
        }

        // Always update last auth markers
        localStorage.setItem('_last_auth_user', currUser);
        localStorage.setItem('_last_auth_role', currRole);

        // Trigger incremental sync immediately after auth is confirmed --
        // useSyncService listens for this event and fires runBackgroundSync
        // right away instead of waiting for its own 3-second startup timer.
        window.dispatchEvent(new CustomEvent('qca-trigger-sync'));
      })
      .catch(() => { /* offline — keep existing role */ });
  }, []);

  // If permissions empty but JWT user exists, apply role-based defaults immediately
  React.useEffect(() => {
    const perms = JSON.parse(localStorage.getItem('user_permissions') || '[]');
    if (perms.length > 0) return; // already have permissions
    try {
      const cache = localStorage.getItem('jwt_user_cache');
      if (!cache) return;
      const user = JSON.parse(cache);
      const role = (user.role || '').toLowerCase();
      // Apply role-based defaults from jwt_user_cache permissions or role defaults
      if (user.permissions && user.permissions.length > 0) {
        saveUserContext({ permissions: user.permissions, role: user.role || '', authenticated_as: user.username || '' });
        setTimeout(() => window.dispatchEvent(new Event('permissions-changed')), 50);
      }
    } catch {}
  }, []);

  // Biometric verified → leave the lock screen. The session flag tells
  // AppLock to skip its PIN pad right after a biometric unlock.
  const onBioUnlock = () => {
    sessionStorage.setItem('qca_bio_unlocked', String(Date.now()));
    setBioLocked(false);
  };

  // Show biometric lock screen if enabled
  if (bioLocked) {
    return (
      <div style={{position:'fixed',inset:0,backgroundColor:'#001f3f',display:'flex',flexDirection:'column',
        alignItems:'center',justifyContent:'center',fontFamily:'sans-serif',padding:32}}>
        <div style={{fontSize:72,marginBottom:24}}>🔐</div>
        <div style={{fontWeight:900,fontSize:22,color:'#fff',marginBottom:8}}>
          QCA Academy
        </div>
        <div style={{fontSize:14,color:'rgba(255,255,255,0.6)',marginBottom:40}}>
          Verify your identity to continue
        </div>
        <button onClick={async () => {
          try {
            await BiometricAuth.authenticate({
              reason: 'Verify your identity to access QCA',
              cancelTitle: 'Use Password',
              androidTitle: 'QCA Academy',
              androidSubtitle: 'Touch fingerprint sensor to continue',
              androidConfirmationRequired: false,
            });
            onBioUnlock();
          } catch(e) {
            // On cancel/fail - show password login (do NOT set bio_unlocked flag)
            sessionStorage.removeItem('qca_bio_unlocked');
            setBioLocked(false);
            setJwtUser(null);
          }
        }}
          style={{width:'100%',maxWidth:300,padding:18,borderRadius:16,border:'none',
            backgroundColor:'#d4af37',color:'#001f3f',fontWeight:900,fontSize:16,cursor:'pointer',marginBottom:16}}>
          👆 Use Biometric
        </button>
        <button onClick={() => { sessionStorage.removeItem('qca_bio_unlocked'); setBioLocked(false); setJwtUser(null); }}
          style={{background:'none',border:'none',color:'rgba(255,255,255,0.5)',fontSize:14,cursor:'pointer',padding:8}}>
          Use Password Instead
        </button>
      </div>
    );
  }

  // Show login page if not authenticated (after ALL hooks)
  if (!jwtUser) {
    return <LoginPage onSuccess={handleJwtSuccess} />;
  }

  return (
    <ErrorBoundary>
    <AppLock>
    <HashRouter>
      <Routes>
        <Route element={<SimpleLayout />}>
          <Route path="/"           element={<MainMenu />} />
          <Route path="/attendance" element={<PermRoute slug="attendance:view"><AttendanceScreen /></PermRoute>} />
          <Route path="/history"     element={<PermRoute slug="attendance:history"><HistoryScreen /></PermRoute>} />
          <Route path="/students"   element={<PermRoute slug="student:view"><StudentsScreen /></PermRoute>} />
          <Route path="/payments"   element={<PermRoute slug="payments:view"><PaymentsScreen /></PermRoute>} />
          <Route path="/records"    element={<PermRoute slug="attendance:records"><RecordsScreen /></PermRoute>} />
          <Route path="/sync"       element={<PermRoute slug="sync:students"><SyncScreen /></PermRoute>} />
          <Route path="/settings"   element={<SettingsScreen />} />
          <Route path="/utilities"  element={<PermRoute slug="student:view"><UtilitiesScreen /></PermRoute>} />
          <Route path="/attendance-correction" element={<PermRoute slug="attendance:delete"><AttendanceCorrectionScreen /></PermRoute>} />
          <Route path="/library"    element={<PermRoute slug="app:library"><LibraryScreen /></PermRoute>} />
          <Route path="/videos"     element={<PermRoute slug="app:videos"><VideosScreen /></PermRoute>} />
          <Route path="/reminders"  element={<PermRoute slug="payments:alerts"><RemindersScreen /></PermRoute>} />
          <Route path="/pulse"      element={<PermRoute slug="media:view"><PulseScreen /></PermRoute>} />
          <Route path="/news"       element={<NewsScreen />} />
          <Route path="/contact"    element={<PermRoute slug="app:contact"><ContactScreen /></PermRoute>} />
          <Route path="/about"      element={<PermRoute slug="app:contact"><AboutScreen /></PermRoute>} />
          <Route path="/syncscreen" element={<PermRoute slug="sync:students"><NewSyncScreen /></PermRoute>} />
          <Route path="/dashboard"  element={<PermRoute slug="attendance:dashboard"><DashboardScreen /></PermRoute>} />
          <Route path="/media"      element={<PermRoute slug="media:view"><MediaScreen /></PermRoute>} />
          <Route path="/matches"    element={<PermRoute slug="matches:view"><MatchesScreen /></PermRoute>} />
          <Route path="/remarks"    element={<PermRoute slug="remarks:view"><RemarksScreen /></PermRoute>} />
          <Route path="/addstudent" element={<PermRoute slug="student:add"><AddStudentScreen /></PermRoute>} />
          <Route path="/student/:studentId/edit" element={<PermRoute slug="student:view"><EditProfileScreen /></PermRoute>} />
          <Route path="/more"       element={<MoreScreen />} />
          <Route path="/finance"    element={<PermRoute slug="payments:record"><FinanceScreen /></PermRoute>} />
                <Route path="/void-payments" element={<PermRoute slug="payments:void"><VoidPaymentsScreen /></PermRoute>} />
                <Route path="/coach-roster" element={<CoachRosterScreen />} />
          <Route path="/nets-hub"   element={<PermRoute slug="nets:view"><NetsHubScreen /></PermRoute>} />
          <Route path="/nets"       element={<PermRoute slug="nets:view"><NetsStaffScreen /></PermRoute>} />
          <Route path="/nets-admin"    element={<PermRoute slug="nets:admin"><NetsAdminScreen /></PermRoute>} />
          <Route path="/nets-calendar" element={<PermRoute slug="nets:view"><NetsCalendarScreen /></PermRoute>} />
        </Route>
      </Routes>
    </HashRouter>
    </AppLock>
    </ErrorBoundary>
  );
}
