/**
 * useRole — single source of truth for user role on mobile.
 * Role is fetched from server ping and stored in localStorage.
 * Roles: admin | coach | viewer
 */

export type Role = 'admin' | 'coach' | 'viewer';

export interface RoleInfo {
  role:            Role;
  isAdmin:         boolean;
  isCoach:         boolean;
  isViewer:        boolean;
  canWrite:        boolean;   // admin | coach
  canSync:         boolean;   // admin | coach
  canPayments:     boolean;   // admin only
  canEditProfile:  boolean;   // admin only
  canDeleteAny:    boolean;
  canAdmin:        boolean;   // alias for isAdmin   // admin only
  label:           string;
  badgeColor:      string;
}

const LABELS: Record<Role,string> = { admin:'Admin', coach:'Coach', viewer:'Viewer' };
const COLORS: Record<Role,string> = { admin:'#c5a059', coach:'#1a472a', viewer:'#6b7280' };

export function getRole(): RoleInfo {
  const raw  = (localStorage.getItem('user_role') || 'viewer').toLowerCase().trim();
  const role = (['admin','coach','viewer'].includes(raw) ? raw : 'viewer') as Role;
  return {
    role,
    isAdmin:        role === 'admin',
    isCoach:        role === 'coach',
    isViewer:       role === 'viewer',
    canWrite:       role === 'admin' || role === 'coach',
    canSync:        role === 'admin' || role === 'coach',
    canPayments:    role === 'admin',
    canEditProfile: role === 'admin',
    canDeleteAny:   role === 'admin',
    canAdmin:       role === 'admin',          // alias used by index.tsx
    label:          LABELS[role] ?? 'Viewer',
    badgeColor:     COLORS[role] ?? '#6b7280',
  }
export function useRole(): RoleInfo { return getRole(); }

export function saveRole(role: string): void {
  localStorage.setItem('user_role', (role || 'viewer').toLowerCase().trim());
}
}
