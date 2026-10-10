import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  IconHome, IconChecklist, IconCurrencyRupee, IconDots,
} from '@tabler/icons-react';
import { usePermissions } from '../pages/usePermissions';
import { getPaymentOverview, getPendingUploadCount } from '../database/db';
import { confirmLeave } from './backNav';

const C = { green: '#1a472a', red: '#c0392b', muted: '#9ca3af' };

// Rendered height of BottomNav (≈8px top pad + 22px icon + 2px gap + ~14px
// label + 6px bottom pad + 1px border ≈ 53px), plus the device's safe-area
// inset. Page-level `position:fixed` elements anchored to the bottom
// (FABs, toasts, snackbars) should add this to their `bottom` offset so
// they sit above the nav instead of behind it.
export const NAV_CLEARANCE = 'calc(56px + env(safe-area-inset-bottom, 0px))';

// Paths considered part of the "Attendance" tab for active-state purposes.
const ATTENDANCE_PATHS = ['/attendance'];
// Paths considered part of the "Payments" tab.
const PAYMENTS_PATHS = ['/payments'];
// Everything else falls under "More" (including "/" only matches Home exactly).

export default function BottomNav() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { can, canAny } = usePermissions();

  const showAttendance = can('attendance:view');
  const showPayments   = canAny('payments:view', 'payments:alerts', 'payments:summary', 'payments:add');

  const [duesCount,    setDuesCount]    = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [ov, pc] = await Promise.all([
        getPaymentOverview(),
        getPendingUploadCount(),
      ]);
      setDuesCount(ov?.studentsWithDues ?? 0);
      setPendingCount(pc ?? 0);
    } catch { /* offline / not synced yet — leave badges as-is */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    window.addEventListener('permissions-changed', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('permissions-changed', refresh);
    };
  }, [refresh]);

  const path = location.pathname;
  const isHome       = path === '/' || path === '';
  const isAttendance = showAttendance && ATTENDANCE_PATHS.some(p => path.startsWith(p));
  const isPayments   = showPayments   && PAYMENTS_PATHS.some(p => path.startsWith(p));
  const isMore       = !isHome && !isAttendance && !isPayments;

  const tabs: {
    key: string; label: string; path: string; Icon: any;
    active: boolean; badge?: number;
  }[] = [
    { key: 'home', label: 'Home', path: '/', Icon: IconHome, active: isHome },
  ];
  if (showAttendance) {
    tabs.push({
      key: 'attendance', label: 'Attendance', path: '/attendance',
      Icon: IconChecklist, active: isAttendance,
      badge: pendingCount > 0 ? pendingCount : undefined,
    });
  }
  if (showPayments) {
    tabs.push({
      key: 'payments', label: 'Payments', path: '/payments',
      Icon: IconCurrencyRupee, active: isPayments,
      badge: duesCount > 0 ? duesCount : undefined,
    });
  }
  tabs.push({ key: 'more', label: 'More', path: '/more', Icon: IconDots, active: isMore });

  return (
    <nav style={{
      display: 'flex', borderTop: '1px solid #eee', backgroundColor: '#fff',
      paddingBottom: 'env(safe-area-inset-bottom)', flexShrink: 0,
    }}>
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={async () => { if (await confirmLeave()) navigate(t.path); }}
          aria-label={t.label}
          aria-current={t.active ? 'page' : undefined}
          style={{
            flex: 1, border: 'none', background: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 2, padding: '8px 0 6px', position: 'relative',
            color: t.active ? C.green : C.muted,
          }}
        >
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <t.Icon size={22} stroke={t.active ? 2.2 : 1.8} />
            {!!t.badge && (
              <span style={{
                position: 'absolute', top: -4, right: -8,
                backgroundColor: C.red, color: '#fff', borderRadius: 8,
                fontSize: 9, fontWeight: 800, padding: '1px 4px',
                minWidth: 14, textAlign: 'center', lineHeight: '12px',
              }}>{t.badge > 99 ? '99+' : t.badge}</span>
            )}
          </span>
          <span style={{ fontSize: 11, fontWeight: t.active ? 700 : 500 }}>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}