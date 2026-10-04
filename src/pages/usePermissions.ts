/**
 * usePermissions — Permission-based access control for QCA Mobile App.
 *
 * The mobile app is DUMB. It stores a flat list of permission slugs
 * from the server and uses them to show/hide features. No role logic here.
 *
 * Flow:
 *   Server ping → returns permissions[] → savePermissions() → localStorage
 *   Components  → can('attendance:take') → true/false
 *
 * Slugs defined in PERMISSIONS_DESIGN.md
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── Types ─────────────────────────────────────────────────────────────────
export type PermSlug =
  // attendance
  | 'attendance:view' | 'attendance:take' | 'attendance:upload'
  | 'attendance:download' | 'attendance:delete' | 'attendance:share'
  | 'attendance:history' | 'attendance:records' | 'attendance:dashboard'
  // student
  | 'student:view' | 'student:add' | 'student:edit'
  | 'student:photo:upload' | 'student:photo:delete'
  // remarks
  | 'remarks:view' | 'remarks:add'
  | 'remarks:edit:own' | 'remarks:edit:any'
  | 'remarks:delete:own' | 'remarks:delete:any'
  // sync
  | 'sync:upload' | 'sync:download' | 'sync:students'
  // payments
  | 'payments:view' | 'payments:add' | 'payments:writeoff' | 'payments:writeoff:reverse'
  // media
  | 'media:view' | 'media:upload' | 'media:delete' | 'media:tag'
  // matches
  | 'matches:view' | 'matches:create' | 'matches:score'
  | 'matches:edit' | 'matches:delete'
  // app
  | 'app:settings' | 'app:biometric';

// ─── Storage ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'user_permissions';
const ROLE_KEY    = 'user_role';
const NAME_KEY    = 'user_display_name';

/** Save permissions after server ping */
export function savePermissions(slugs: string[], role?: string, name?: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slugs));
  if (role) localStorage.setItem(ROLE_KEY, role);
  if (name) localStorage.setItem(NAME_KEY, name);
  // Notify all usePermissions() hooks to re-render
  window.dispatchEvent(new Event('permissions-changed'));
}

// ─── User context storage ──────────────────────────────────────────────────
const USER_TYPE_KEY  = 'user_type';
const LINKED_KEY     = 'linked_student_ids';
const RESTRICTED_KEY = 'is_restricted';
const USER_ID_KEY    = 'user_id';

/** Save full user context after ping */
export function saveUserContext(ctx: {
  permissions:       string[];
  role?:             string;
  user_type?:        string;
  user_id?:          number;
  linked_student_ids?: number[];
  is_restricted?:    boolean;
  authenticated_as?: string;
}): void {
  localStorage.setItem(STORAGE_KEY,    JSON.stringify(ctx.permissions || []));
  if (ctx.role)             localStorage.setItem(ROLE_KEY,        ctx.role);
  if (ctx.authenticated_as) localStorage.setItem(NAME_KEY,        ctx.authenticated_as);
  if (ctx.user_type)        localStorage.setItem(USER_TYPE_KEY,   ctx.user_type);
  if (ctx.user_id != null)  localStorage.setItem(USER_ID_KEY,     String(ctx.user_id));
  localStorage.setItem(LINKED_KEY,     JSON.stringify(ctx.linked_student_ids || []));
  localStorage.setItem(RESTRICTED_KEY, ctx.is_restricted ? '1' : '0');
  window.dispatchEvent(new Event('permissions-changed'));
}

/** Get linked student IDs (for parent/student accounts) */
export function getLinkedStudentIds(): number[] {
  try { return JSON.parse(localStorage.getItem(LINKED_KEY) || '[]'); }
  catch { return []; }
}

/** Is this user restricted to specific students? */
export function isDataRestricted(): boolean {
  return localStorage.getItem(RESTRICTED_KEY) === '1';
}

/** Get user type: 'staff' | 'student' | 'parent' */
export function getUserType(): 'staff' | 'student' | 'parent' {
  return (localStorage.getItem(USER_TYPE_KEY) || 'staff') as any;
}

/** Get user ID */
export function getUserId(): number {
  return parseInt(localStorage.getItem(USER_ID_KEY) || '0');
}

/**
 * True if this device has never been signed in — i.e. the user has not
 * entered server/credentials in Settings yet. Mirrors the exact guard
 * App.jsx uses before it bothers pinging the server at all, so it stays
 * in sync with "will a permissions ping ever happen for this device".
 *
 * This is the signal used to distinguish a genuinely anonymous visitor
 * from a signed-in user whose permissions ping simply hasn't returned
 * yet (perms.size === 0 in both cases, but only one of them is "public").
 */
export function isAnonymous(): boolean {
  const hasServer  = !!localStorage.getItem('server_ip');
  const hasUser    = !!localStorage.getItem('auth_user');
  const hasJwt     = !!localStorage.getItem('jwt_user_cache');
  const hasLegacy  = !!localStorage.getItem('auth_pass') && !!localStorage.getItem('secret_key');
  return !(hasServer && hasUser && (hasJwt || hasLegacy));
}

/** Read permission set synchronously (for non-hook usage) */
export function getPermissions(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '[]';
    const perms = new Set<string>(JSON.parse(raw));
    console.log('[QCA PERMS] count:', perms.size, 'has payments:add:', perms.has('payments:add'), 'all:', Array.from(perms).join(', '));
    return perms;
  } catch {
    return new Set();
  }
}

/** Synchronous single-permission check (use outside React) */
export function can(slug: PermSlug | string): boolean {
  return getPermissions().has(slug);
}

/** Get display name */
export function getDisplayName(): string {
  return localStorage.getItem(NAME_KEY) || localStorage.getItem('auth_user') || 'User';
}

/** Get role label for display */
export function getRoleLabel(): string {
  const r = (localStorage.getItem(ROLE_KEY) || 'viewer');
  return r.charAt(0).toUpperCase() + r.slice(1);
}

/** Get role badge colour */
export function getRoleColor(): string {
  const r = (localStorage.getItem(ROLE_KEY) || '').toLowerCase();
  if (r === 'admin')  return '#c5a059';  // gold
  if (r === 'coach')  return '#1a472a';  // green
  if (r === 'scorer') return '#2980b9';  // blue
  return '#6b7280';                       // gray = viewer / unknown
}

// ─── React Hook ────────────────────────────────────────────────────────────
export interface PermissionHook {
  /** Check a single permission slug */
  can:         (slug: PermSlug | string) => boolean;
  /** Check multiple — returns true if user has ANY of the given slugs */
  canAny:      (...slugs: string[]) => boolean;
  /** Check multiple — returns true only if user has ALL of the given slugs */
  canAll:      (...slugs: string[]) => boolean;
  /** Raw Set for advanced checks */
  perms:       Set<string>;
  /** Role label e.g. "Coach" */
  roleLabel:   string;
  /** Role badge colour */
  roleColor:   string;
  /** Display name */
  displayName: string;
  /** True if permissions have been loaded (false on very first launch) */
  isLoaded:         boolean;
  /** True if user can only see linked students (parent/student accounts) */
  isDataRestricted: boolean;
  /** True if this device has never been signed in (no server/credentials saved) */
  isAnonymous:      boolean;
  /** Student IDs this user can access (empty = all) */
  linkedStudentIds: number[];
  /** User type: staff | student | parent */
  userType:         'staff' | 'student' | 'parent';
}

export function usePermissions(): PermissionHook {
  const [perms, setPerms] = useState<Set<string>>(() => getPermissions());

  useEffect(() => {
    const refresh = () => setPerms(getPermissions());
    // Re-read when permissions are saved (ping completes)
    window.addEventListener('permissions-changed', refresh);
    // Re-read when app comes back to foreground
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    return () => {
      window.removeEventListener('permissions-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return {
    can:              (slug) => perms.has(slug),
    canAny:           (...slugs) => slugs.some(s => perms.has(s)),
    canAll:           (...slugs) => slugs.every(s => perms.has(s)),
    perms,
    roleLabel:        getRoleLabel(),
    roleColor:        getRoleColor(),
    displayName:      getDisplayName(),
    isLoaded:         perms.size > 0,
    isDataRestricted: isDataRestricted(),
    isAnonymous:      isAnonymous(),
    linkedStudentIds: getLinkedStudentIds(),
    userType:         getUserType(),
  };
}

// ─── Route Guard HOC (used in App.jsx) ─────────────────────────────────────
/**
 * Use in App.jsx to protect entire routes:
 *
 * <PermRoute slug="attendance:view">
 *   <AttendanceScreen />
 * </PermRoute>
 */

export function PermRoute({
  slug, children, fallback,
}: {
  slug: PermSlug | string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}): React.ReactElement {
  const { can: canDo, roleLabel, isLoaded, isAnonymous: anon } = usePermissions();
  const navigate = useNavigate();

  const screen = (body: React.ReactNode) => React.createElement(
    'div',
    { style: {
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: '#f0f4f0', padding: 24, fontFamily: 'sans-serif',
      position: 'relative',
    }},
    React.createElement('button', {
      onClick: () => window.history.back(),
      style: {
        position: 'absolute', top: 16, left: 16,
        background: 'none', border: 'none',
        fontSize: 24, cursor: 'pointer', color: '#6b7280', padding: 8,
      }
    }, '←'),
    body,
  );

  if (!isLoaded) {
    if (anon) {
      // Device has never been signed in — this route will never gain
      // permissions from a ping that's never triggered. Block immediately
      // instead of rendering optimistically (that's how the menu structure
      // used to leak to anonymous visitors).
      return screen(fallback || React.createElement(
        React.Fragment, null,
        React.createElement('div', { style: { fontSize: 48, marginBottom: 16 } }, '🔒'),
        React.createElement('div', { style: { fontWeight: 800, fontSize: 18, color: '#1f2937', marginBottom: 8 } },
          'Sign in required'),
        React.createElement('div', { style: { fontSize: 13, color: '#6b7280', textAlign: 'center', maxWidth: 260 } },
          'Sign in from Settings to access this feature.'),
        React.createElement('button', {
          onClick: () => navigate('/settings'),
          style: {
            marginTop: 24, padding: '12px 28px', borderRadius: 12,
            border: 'none', backgroundColor: '#1a472a', color: '#fff',
            fontWeight: 700, fontSize: 14, cursor: 'pointer',
          }
        }, 'Go to Settings'),
      ));
    }
    // Signed in, permissions ping just hasn't returned yet — show
    // children optimistically. Server will reject unauthorized API
    // calls anyway (belt + suspenders).
    return React.createElement(React.Fragment, null, children);
  }

  if (!canDo(slug)) {
    return screen(fallback || React.createElement(
      React.Fragment, null,
      React.createElement('div', { style: { fontSize: 48, marginBottom: 16 } }, '🔒'),
      React.createElement('div', { style: { fontWeight: 800, fontSize: 18, color: '#1f2937', marginBottom: 8 } },
        'Access Restricted'),
      React.createElement('div', { style: { fontSize: 13, color: '#6b7280', textAlign: 'center', maxWidth: 260 } },
        `Your role (${roleLabel}) does not have permission to access this feature.`),
      React.createElement('div', { style: { marginTop: 8, fontSize: 11, color: '#9ca3af' } },
        `Required: ${slug}`),
      React.createElement('button', {
        onClick: () => window.history.back(),
        style: {
          marginTop: 24, padding: '12px 28px', borderRadius: 12,
          border: 'none', backgroundColor: '#1a472a', color: '#fff',
          fontWeight: 700, fontSize: 14, cursor: 'pointer',
        }
      }, '← Go Back'),
    ));
  }

  return React.createElement(React.Fragment, null, children);
}
