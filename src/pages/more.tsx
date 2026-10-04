import React from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader from '../shared/ScreenHeader';
import TileGrid from '../shared/TileGrid';
import EmptyAreaLogo from '../shared/EmptyAreaLogo';
import {
  IconHistory, IconChartBar, IconChartPie, IconEdit,
  IconTrophy, IconBook, IconBrandYoutube, IconNews, IconPhoto, IconCamera,
  IconRefresh, IconTool, IconSettings, IconMail, IconInfoCircle, IconCalendar,
  IconTrash, IconLogout,
} from '@tabler/icons-react';

const C = { green: '#1a472a', gold: '#d4af37' };

// Paths visible to a genuinely anonymous (never signed in) visitor —
// public/marketing content plus Settings (the sign-in entry point).
const PUBLIC_PATHS = new Set(['news', 'matches', 'pulse', 'videos', 'library', 'contact', 'about', 'settings']);

type Item = {
  Icon: any; label: string; sub: string; path: string; slug: string; adminOnly?: boolean;
};
type Group = { title: string; color: string; items: Item[] };

const GROUPS: Group[] = [
  {
    title: 'Attendance tools',
    color: '#16a085',
    items: [
      { Icon: IconHistory,  label: 'History',         sub: 'Calendar attendance view',          path: 'history',  slug: 'attendance:history' },
      { Icon: IconChartBar, label: 'Records',         sub: 'Attendance & payment reports',      path: 'records',  slug: 'attendance:records' },
      { Icon: IconChartPie, label: 'Dashboard',       sub: 'Student attendance analytics',      path: 'dashboard', slug: 'attendance:dashboard' },
      { Icon: IconEdit,     label: 'Att. Correction', sub: 'Delete wrong attendance records',   path: 'attendance-correction', slug: 'attendance:delete' },
    ],
  },
  {
    title: 'Cricket & content',
    color: '#8e44ad',
    items: [
      { Icon: IconTrophy,       label: 'Matches',      sub: 'Live scoring & results',             path: 'matches', slug: 'matches:view' },
      { Icon: IconBook,         label: 'Library',      sub: 'Coaching videos & resources',        path: 'library', slug: 'app:library' },
      { Icon: IconBrandYoutube, label: 'QCA Channel',  sub: 'Academy YouTube channel',            path: 'videos',  slug: 'app:videos' },
      { Icon: IconNews,         label: 'Cricket Hub',  sub: 'AI news & coaching insights',        path: 'news',    slug: 'app:news' },
      { Icon: IconPhoto,        label: 'Academy Pulse', sub: 'Daily photos, videos & moments',    path: 'pulse',   slug: 'media:view' },
      { Icon: IconCamera,       label: 'Media Centre', sub: 'Capture, tag & upload session media', path: 'media',  slug: 'media:view' },
      { Icon: IconCalendar,     label: 'Coach Roster', sub: 'Monthly morning & evening schedule',   path: 'coach-roster', slug: 'app:contact' },
    ],
  },
  {
    title: 'Admin & support',
    color: '#7f8c8d',
    items: [
      { Icon: IconRefresh,  label: 'Sync',       sub: 'Pull & push server data',     path: 'syncscreen', slug: 'sync:any' },
      { Icon: IconTool,     label: 'Utilities',  sub: 'Admin monitoring & reports',  path: 'utilities',  slug: 'student:view', adminOnly: true },
      { Icon: IconTrash,    label: 'Void Payments', sub: 'Cancel a recent unposted receipt', path: 'void-payments', slug: 'payments:writeoff' },
      { Icon: IconSettings, label: 'Settings',   sub: 'Server & app configuration',  path: 'settings',   slug: 'app:settings' },
      { Icon: IconMail,     label: 'Contact Us', sub: 'Enquiries, phone, WhatsApp, social', path: 'contact', slug: 'app:contact' },
      { Icon: IconInfoCircle, label: 'About Us', sub: 'Patrons, office bearers & members', path: 'about', slug: 'app:contact' },
    ],
  },
];



export default function MoreScreen() {
  const navigate = useNavigate();

  const handleLogout = () => {
    if (!window.confirm('Sign out of QCA?')) return;
    // Clear all auth data
    const keys = [
      'jwt_token','jwt_expiry','jwt_user_cache',
      'CapacitorStorage.jwt_access_token',
      'CapacitorStorage.jwt_expiry',
      'CapacitorStorage.jwt_user',
      'auth_user','auth_pass','secret_key',
      'user_permissions','user_role','user_display_name',
      'user_type','linked_student_ids','is_restricted',
    ];
    keys.forEach(k => localStorage.removeItem(k));
    window.location.reload();
  };
  const { can: canPerm, canAny, isLoaded: permsLoaded, isAnonymous: anon } = usePermissions();
  const role    = (localStorage.getItem('user_role') || 'viewer').toLowerCase();
  const isAdmin = role === 'admin';

  const hasSyncAccess = canAny('sync:upload','sync:download','sync:students','sync:payments','sync:reupload','sync:runall');
  const ALWAYS_SHOW = new Set(['app:settings','app:library','app:videos','app:news','app:contact','media:view','media:upload']);
  const checkPerm = (slug: string) =>
    slug === 'sync:any'   ? hasSyncAccess :
    ALWAYS_SHOW.has(slug) ? true          :
    canPerm(slug);

  const visibleGroups = GROUPS
    .map(g => ({
      ...g,
      items: anon
        ? g.items.filter(i => PUBLIC_PATHS.has(i.path))
        : permsLoaded ? g.items.filter(i => checkPerm(i.slug) && (!i.adminOnly || isAdmin)) : g.items,
    }))
    .filter(g => g.items.length > 0);

  return (
    <div style={{ backgroundColor: '#f4f7f6', minHeight: '100%', fontFamily: 'sans-serif', paddingBottom: 24, display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader title="More"
        subtitle={anon ? 'Cricket news, matches & academy info' : 'Cricket, content & admin'} />

      <div style={{ padding: '12px 12px 0' }}>
        {visibleGroups.map(group => (
          <TileGrid key={group.title} title={group.title} color={group.color}
            items={group.items} onSelect={item => navigate(`/${item.path}`)} />
        ))}

        {permsLoaded && visibleGroups.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#9ca3af' }}>
            <div style={{ fontSize: 13 }}>Nothing here for your role yet</div>
          </div>
        )}

        {!anon && (
          <button onClick={handleLogout} style={{
            width: '100%', height: 44, marginTop: 4, borderRadius: 12,
            border: '1px solid #fecaca', backgroundColor: '#fff', color: '#dc2626',
            fontWeight: 700, fontSize: 14, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <IconLogout size={18} stroke={2} /> Sign Out
          </button>
        )}
      </div>

      <EmptyAreaLogo />
      <p style={{ textAlign: 'center', color: '#aaa', fontSize: 11, padding: '12px 0 4px' }}>
        Trivandrum · Kerala
      </p>
    </div>
  );
}