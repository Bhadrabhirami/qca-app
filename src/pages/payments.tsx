/**
 * Payments Dashboard — /payments
 * ─────────────────────────────────────────────────────────────────────
 * Priority 1: Fee alert list — who owes what
 *
 * Three sections:
 *   A) Overview stat strip  — total students, with dues, months overdue, collected
 *   B) Fee Alerts list      — students with months_due_count > 0, sorted worst first
 *   C) Recent payments      — last 20 fee payments across all students
 */

import { matchesStudentSearch, formatRegno, fmtRegNo } from './studentUtils';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { usePermissions, getLinkedStudentIds, isDataRestricted } from './usePermissions';
import {
  getStudentsWithDues,
  getPaymentOverview,
  getAllStudents,
  getPaymentSummary,
  getStudentPayments,
  getLastAttendanceMap,
  getAllPaymentSummaries,
  getRecentPayments,
  getPaymentsForMonth,
  applyWriteOffLocally,
  applyPaymentLocally,
  getFeeCategories,
  syncFeeCategories,
} from '../database/db';
import StudentPhoto from '../shared/StudentPhoto';
import ScreenHeader from '../shared/ScreenHeader';
import { NAV_CLEARANCE } from '../shared/BottomNav';
import { usePullToRefresh } from './usePullToRefresh';
import { syncPaymentsOnly, syncStudentsOnly, refreshDuesNow } from './useSyncService';

import { getPaymentsMaxId, deleteLocalPaymentByReceipt } from '../database/db';
import { useUnsavedChanges, confirmLeave } from '../shared/backNav';

/** Fee types offered when recording a student payment: Monthly Tuition Fee and Admission Fee */
const STUDENT_FEE_IDS = [1, 2];

const C = {
  green:  '#1a472a', gold:   '#d4af37', bg:     '#f4f7f6',
  border: '#e8e8e8', gray:   '#888',   red:    '#c0392b',
  orange: '#e67e22', white:  '#ffffff',
};

// ── Module-level helpers — available to ALL components in this file ──────────
function buildBase(ip: string): string {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
}
function hdrs(): Record<string, string> {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) {
      // Token expired - trigger auto logout
      window.dispatchEvent(new Event('jwt-expired'));
      return {};
    }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return {
    'Content-Type': 'application/json',
    'X-Username':   localStorage.getItem('auth_user') ?? '',
    'X-Password':   localStorage.getItem('auth_pass') ?? '',
  };
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Format any billing_month format to "Aug 2025".
 *  Accepts: "Aug-25", "Aug-2025", "August 2025", "2025-08", "2025-08-01"
 *  Falls back to the raw value if unrecognised. */
function fmtMonth(raw: string | null | undefined): string {
  if (!raw) return '—';
  const s = raw.trim();

  // Prefer server-provided display field if caller passes the row object
  // (handled below in render — this fn handles the string directly)

  // YYYY-MM or YYYY-MM-DD
  if (/^\d{4}-\d{2}/.test(s)) {
    const [y, m] = s.split('-');
    return `${MONTHS[parseInt(m)-1]} ${y}`;
  }
  // Mon-YY  e.g. Aug-25
  const monYY = s.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (monYY) {
    const yy = parseInt(monYY[2]);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    const monIdx = MONTHS.findIndex(mn => mn.toLowerCase() === monYY[1].toLowerCase());
    return monIdx >= 0 ? `${MONTHS[monIdx]} ${year}` : s;
  }
  // Mon-YYYY  e.g. Aug-2025
  const monYYYY = s.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (monYYYY) {
    const monIdx = MONTHS.findIndex(mn => mn.toLowerCase() === monYYYY[1].toLowerCase());
    return monIdx >= 0 ? `${MONTHS[monIdx]} ${monYYYY[2]}` : s;
  }
  // Already "Aug 2025" style
  if (/^[A-Za-z]+ \d{4}$/.test(s)) return s;

  return s; // fallback — show raw value
}

/** Get display string for a payment row — prefers server-computed display field */
function fmtPaymentMonth(row: any): string {
  if (row?.billing_month_display) return row.billing_month_display;
  return fmtMonth(row?.billing_month);
}

/** Normalise billing_month to YYYY-MM for sorting/comparison */
function normMonth(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.trim();
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0,7);
  const monYY = s.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (monYY) {
    const yy = parseInt(monYY[2]);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    const monIdx = MONTHS.findIndex(mn => mn.toLowerCase() === monYY[1].toLowerCase());
    return monIdx >= 0 ? `${year}-${String(monIdx+1).padStart(2,'0')}` : '';
  }
  const monYYYY = s.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (monYYYY) {
    const monIdx = MONTHS.findIndex(mn => mn.toLowerCase() === monYYYY[1].toLowerCase());
    return monIdx >= 0 ? `${monYYYY[2]}-${String(monIdx+1).padStart(2,'0')}` : '';
  }
  return '';
}
function fmtAmt(n: number) {
  return '₹' + (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function dueColor(n: number) {
  return n >= 3 ? C.red : n >= 1 ? C.orange : '#27ae60';
}

/** Whole days between a YYYY-MM-DD date and today (local time). */
function daysSince(dateStr: string): number {
  const then  = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then.getTime()) / 86400000);
}

/** "12 Jun 2026 · Evening (3d ago)" / "Never" — used in AlertRow. */
function fmtLastAttended(info?: { date: string; session: string } | null): string {
  if (!info) return 'Never';
  const days = daysSince(info.date);
  const d    = new Date(info.date + 'T00:00:00');
  const ds   = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const ago  = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
  return `${ds} · ${info.session} (${ago})`;
}

/** Days since last attendance, or Infinity if the student has never attended. */
function attendanceGap(info?: { date: string; session: string } | null): number {
  return info ? daysSince(info.date) : Infinity;
}

// One white card holding hairline-separated rows (alerts, recent payments)
const LIST_CARD: React.CSSProperties = {
  backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
};

// ─── Overview strip ───────────────────────────────────────────────────────────
type DrillKind = 'students' | 'withDues' | 'monthsDue' | 'collected';

function OverviewStrip({ ov, collectedRevealed, onReveal, onOpen }: {
  ov: any;
  collectedRevealed: boolean;
  onReveal: () => void;
  onOpen: (kind: DrillKind) => void;
}) {
  const stats: { label: string; value: React.ReactNode; color: string; kind: DrillKind; hint?: string }[] = [
    { label: 'Students',   value: ov.totalStudents,    color: C.green, kind: 'students' },
    { label: 'With Dues',  value: ov.studentsWithDues, color: dueColor(ov.studentsWithDues > 0 ? 3 : 0), kind: 'withDues' },
    { label: 'Months Due', value: ov.totalMonthsDue,   color: C.red,   kind: 'monthsDue' },
    {
      label: 'Collected',
      value: collectedRevealed ? fmtAmt(ov.totalCollected) : '••••••',
      color: '#27ae60',
      kind: 'collected',
      hint: collectedRevealed ? undefined : 'Tap to reveal',
    },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, padding: '6px 12px 0' }}>
      {stats.map((s, i) => (
        <button key={i}
          onClick={() => s.kind === 'collected' && !collectedRevealed ? onReveal() : onOpen(s.kind)}
          title={s.hint}
          style={{
            backgroundColor: '#fff', borderRadius: 10, padding: '8px 4px 7px',
            border: 'none', cursor: 'pointer', textAlign: 'center',
            boxShadow: `inset 0 -3px 0 ${s.color}`, minWidth: 0,
          }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: s.color, lineHeight: 1.15,
            letterSpacing: s.hint ? '1px' : 'normal', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.value}
          </div>
          <div style={{ fontSize: 9, color: C.gray, fontWeight: 700, marginTop: 3, textTransform: 'uppercase',
            letterSpacing: '0.3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.hint ? 'Tap to see' : s.label}
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Student detail drawer (fee history) ─────────────────────────────────────
// ─── Pay Sheet ─────────────────────────────────────────────────────────────────
function PaySheet({ student, summary, onClose, onDone }: {
  student: any; summary: any;
  onClose: () => void;
  onDone: (result: { receipts: string[]; months: string[]; amountPerMonth: number; paymentDate: string }) => void;
}) {
  const base      = buildBase(localStorage.getItem('server_ip') || '');
  const today     = new Date().toISOString().slice(0, 10);
  const dueMonths: string[] = summary?.due_months ?? [];
  const monthlyFee = summary?.monthly_fee ?? 0;

  const [selected,  setSelected]  = useState<Set<string>>(new Set(dueMonths));
  const [amount,    setAmount]    = useState(String(monthlyFee || ''));
  const [mode,      setMode]      = useState('Cash');
  const [date,      setDate]      = useState(today);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  const toggle = (ym: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(ym) ? next.delete(ym) : next.add(ym);
    return next;
  });

  const totalAmt = selected.size * (Number(amount) || 0);

  const submit = async () => {
    if (!selected.size)          { setError('Select at least one month'); return; }
    if (!(Number(amount) > 0))   { setError('Enter a valid amount per month'); return; }
    if (!date)                   { setError('Payment date is required'); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch(`${base}/api/data/payments/bulk-record`, {
        method: 'POST',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_id:       student.student_id ?? student.id,
          months:           Array.from(selected).sort(),
          amount_per_month: Number(amount),
          mode,
          payment_date:     date,
          category_id:      16,   // Monthly Tuition Fee
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const recordedResults = (j.results || []).filter((x: any) => x.status === 'recorded');
      const receipts = recordedResults.map((x: any) => x.receipt_no);
      const recordedMonths = recordedResults.map((x: any) => x.month);
      onDone({ receipts, months: recordedMonths, amountPerMonth: Number(amount), paymentDate: date });
    } catch (e: any) {
      setError(e.message || 'Network error');
    } finally { setSaving(false); }
  };

  const I = { // input style
    width: '100%', padding: '11px 14px', borderRadius: 10, fontSize: 14,
    border: '1.5px solid #e5e7eb', outline: 'none',
    boxSizing: 'border-box' as const, fontFamily: 'inherit',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3100, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor: '#fff', width: '100%', borderRadius: '20px 20px 0 0', maxHeight: '88vh', overflowY: 'auto', paddingBottom: 32 }}>
        {/* Header */}
        <div style={{ backgroundColor: '#1a472a', borderRadius: '20px 20px 0 0', padding: '16px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>💰 Record Payment</div>
              <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 }}>{student.student_name}</div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 22, cursor: 'pointer' }}>✕</button>
          </div>
        </div>

        <div style={{ padding: '16px 16px 0' }}>
          {/* Month selector */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
            Select Months — {selected.size} selected
          </div>
          {dueMonths.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#27ae60', padding: '12px 0', fontSize: 13, fontWeight: 700 }}>
              ✅ No overdue months — student is up to date
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {dueMonths.map(ym => {
                const on = selected.has(ym);
                return (
                  <button key={ym} onClick={() => toggle(ym)} style={{
                    padding: '7px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                    border: `2px solid ${on ? '#1a472a' : '#e5e7eb'}`,
                    backgroundColor: on ? '#1a472a' : '#f9fafb',
                    color: on ? '#fff' : C.gray, cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}>{fmtMonth(ym)}</button>
                );
              })}
              <button onClick={() => setSelected(new Set(dueMonths))}
                style={{ padding: '7px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700, border: '1.5px dashed #d1d5db', background: 'none', color: C.gray, cursor: 'pointer' }}>
                All
              </button>
              <button onClick={() => setSelected(new Set())}
                style={{ padding: '7px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700, border: '1.5px dashed #d1d5db', background: 'none', color: C.gray, cursor: 'pointer' }}>
                None
              </button>
            </div>
          )}

          {/* Amount */}
          <div style={{ fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Amount per Month ₹
          </div>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 1500" style={I} />

          {selected.size > 0 && Number(amount) > 0 && (
            <div style={{ textAlign: 'right', fontSize: 12, color: '#27ae60', fontWeight: 700, marginTop: 4 }}>
              Total: {fmtAmt(totalAmt)} for {selected.size} month{selected.size > 1 ? 's' : ''}
            </div>
          )}

          {/* Mode */}
          <div style={{ fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, marginTop: 14 }}>
            Payment Mode
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['Cash', 'UPI', 'Bank Transfer', 'Cheque'].map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '8px 16px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                border: `2px solid ${mode === m ? '#c5a059' : '#e5e7eb'}`,
                backgroundColor: mode === m ? '#c5a059' : '#f9fafb',
                color: mode === m ? '#fff' : C.gray, cursor: 'pointer',
              }}>{m}</button>
            ))}
          </div>

          {/* Date */}
          <div style={{ fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, marginTop: 14 }}>
            Payment Date
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={I} />

          {error && (
            <div style={{ color: C.red, fontSize: 12, fontWeight: 700, marginTop: 10 }}>⚠ {error}</div>
          )}

          <button onClick={submit} disabled={saving || !selected.size} style={{
            width: '100%', marginTop: 18, padding: '14px 0', borderRadius: 12,
            border: 'none', fontWeight: 800, fontSize: 15, cursor: saving || !selected.size ? 'not-allowed' : 'pointer',
            backgroundColor: saving || !selected.size ? '#9ca3af' : '#1a472a', color: '#fff',
          }}>
            {saving ? '⏳ Recording…' : `✅ Record Payment${selected.size > 1 ? ` (${selected.size} months)` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Write-Off Sheet ──────────────────────────────────────────────────────────
function WriteOffSheet({ student, summary, onClose, onDone }: {
  student: any; summary: any;
  onClose: () => void;
  onDone: (result: { count: number; months: string[] }) => void;
}) {
  const base      = buildBase(localStorage.getItem('server_ip') || '');
  const dueMonths: string[] = summary?.due_months ?? [];
  const monthlyFee = summary?.monthly_fee ?? 0;

  const REASONS = ['Financial Hardship', 'Long Absence', 'Management Decision', 'Scholarship / Sponsored', 'Other'];

  const [selected, setSelected] = useState<Set<string>>(new Set(dueMonths));
  const [reason,   setReason]   = useState(REASONS[0]);
  const [remarks,  setRemarks]  = useState('');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  const toggle = (ym: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(ym) ? next.delete(ym) : next.add(ym);
    return next;
  });

  const submit = async () => {
    if (!selected.size)                       { setError('Select at least one month'); return; }
    if (reason === 'Other' && !remarks.trim()) { setError('Remarks are required when reason is Other'); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch(`${base}/api/data/write-offs/bulk-create`, {
        method: 'POST',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_id:       student.student_id ?? student.id,
          months:           Array.from(selected).sort(),
          amount_per_month: monthlyFee || 0,
          reason,
          remarks:          remarks.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // Treat both "written_off" (new) and "already_written_off" (was already
      // active) as "no longer due" locally — either way the month shouldn't
      // show as outstanding any more.
      const offMonths = (j.results || [])
        .filter((x: any) => x.status === 'written_off' || x.status === 'already_written_off')
        .map((x: any) => x.month);
      onDone({ count: j.written_off ?? selected.size, months: offMonths.length ? offMonths : Array.from(selected) });
    } catch (e: any) {
      setError(e.message || 'Network error');
    } finally { setSaving(false); }
  };

  const I = {
    width: '100%', padding: '11px 14px', borderRadius: 10, fontSize: 14,
    border: '1.5px solid #e5e7eb', outline: 'none',
    boxSizing: 'border-box' as const, fontFamily: 'inherit',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3100, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor: '#fff', width: '100%', borderRadius: '20px 20px 0 0', maxHeight: '88vh', overflowY: 'auto', paddingBottom: 32 }}>
        {/* Header */}
        <div style={{ backgroundColor: '#7c3aed', borderRadius: '20px 20px 0 0', padding: '16px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>✏ Write Off Dues</div>
              <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 }}>{student.student_name}</div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 22, cursor: 'pointer' }}>✕</button>
          </div>
        </div>

        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ backgroundColor: '#fef3c7', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#92400e' }}>
            ⚠ Write-offs remove months from the dues list without recording a payment. This is reversible from the web admin panel.
          </div>

          {/* Month selector */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
            Select Months — {selected.size} selected
          </div>
          {dueMonths.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#27ae60', padding: '12px 0', fontSize: 13, fontWeight: 700 }}>
              ✅ No overdue months to write off
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {dueMonths.map(ym => {
                const on = selected.has(ym);
                return (
                  <button key={ym} onClick={() => toggle(ym)} style={{
                    padding: '7px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                    border: `2px solid ${on ? '#7c3aed' : '#e5e7eb'}`,
                    backgroundColor: on ? '#7c3aed' : '#f9fafb',
                    color: on ? '#fff' : C.gray, cursor: 'pointer',
                  }}>{fmtMonth(ym)}</button>
                );
              })}
              <button onClick={() => setSelected(new Set(dueMonths))}
                style={{ padding: '7px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700, border: '1.5px dashed #d1d5db', background: 'none', color: C.gray, cursor: 'pointer' }}>
                All
              </button>
              <button onClick={() => setSelected(new Set())}
                style={{ padding: '7px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700, border: '1.5px dashed #d1d5db', background: 'none', color: C.gray, cursor: 'pointer' }}>
                None
              </button>
            </div>
          )}

          {/* Reason */}
          <div style={{ fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Reason
          </div>
          <select value={reason} onChange={e => setReason(e.target.value)} style={{ ...I, appearance: 'auto' }}>
            {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>

          {/* Remarks */}
          <div style={{ fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, marginTop: 14 }}>
            Remarks {reason === 'Other' && <span style={{ color: C.red }}>*</span>}
          </div>
          <textarea value={remarks} onChange={e => setRemarks(e.target.value)}
            placeholder={reason === 'Other' ? 'Required — describe the reason' : 'Optional notes'}
            rows={3}
            style={{ ...I, resize: 'none' as const }} />

          {error && (
            <div style={{ color: C.red, fontSize: 12, fontWeight: 700, marginTop: 10 }}>⚠ {error}</div>
          )}

          <button onClick={submit} disabled={saving || !selected.size} style={{
            width: '100%', marginTop: 18, padding: '14px 0', borderRadius: 12,
            border: 'none', fontWeight: 800, fontSize: 15, cursor: saving || !selected.size ? 'not-allowed' : 'pointer',
            backgroundColor: saving || !selected.size ? '#9ca3af' : '#7c3aed', color: '#fff',
          }}>
            {saving ? '⏳ Writing off…' : `✏ Write Off ${selected.size} Month${selected.size > 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Student Fee Drawer ───────────────────────────────────────────────────────

async function voidPayment(base: string, receiptNo: string, onDone: () => void) {
  if (!window.confirm(`Void ${receiptNo}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${base}/api/data/payments/${receiptNo}/void`, {
      method: 'DELETE', headers: hdrs(),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      // Server hard-deletes the receipt; mirror that locally (sync is
      // append-only) and refresh dues, then let the caller reload its view
      await deleteLocalPaymentByReceipt(receiptNo);
      alert('✅ ' + (j.message || 'Voided'));
      onDone();
      refreshDuesNow();
    }
    else alert('⚠ ' + (j.error || 'Failed to void'));
  } catch(e: any) { alert('⚠ ' + e.message); }
}

function StudentFeeDrawer({ student, onClose, onChanged }: { student: any; onClose: () => void; onChanged?: () => void }) {
  const [payments,  setPayments]  = useState<any[]>([]);
  const [summary,   setSummary]   = useState<any|null>(null);
  const [loaded,    setLoaded]    = useState(false);
  const [sheet,     setSheet]     = useState<'pay'|'writeoff'|null>(null);
  const [toast,     setToast]     = useState('');
  const { can } = usePermissions();
  const canWriteOff = can('payments:writeoff' as any);

  const load = () => {
    const sid = student.student_id ?? student.id;
    Promise.all([
      getStudentPayments(sid),
      getPaymentSummary(sid),
    ]).then(([p, s]) => {
      setPayments(p.filter((r: any) => [1,2,15].includes(r.fee_type_id)));
      setSummary(s);
      setLoaded(true);
    });
  };

  useEffect(() => { load(); }, [student]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  return (
    <>
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor: '#fff', width: '100%', maxHeight: '88vh',
        borderRadius: '20px 20px 0 0', overflowY: 'auto', paddingBottom: 30,
      }}>
        {/* Header */}
        <div style={{
          backgroundColor: C.green, padding: '18px 18px 14px',
          borderRadius: '20px 20px 0 0',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <StudentPhoto student={{ name: student.student_name, profile_image: student.profile_image }} size={52} style={{ border: '2px solid rgba(255,255,255,0.4)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 800, fontSize: 17 }}>{student.student_name}</div>
            <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 }}>
              {formatRegno(student.regno)}{student.qca_id ? ` · Q${String(student.qca_id).padStart(3,'0')}` : ''} · Enrolled {student.enrollment_date || '—'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ padding: '16px 16px 0' }}>
          {!loaded ? (
            <div style={{ textAlign: 'center', color: C.gray, padding: 30 }}>Loading…</div>
          ) : (
            <>
              {/* Summary row */}
              {summary && (
                <div style={{
                  display: 'flex', gap: 0, backgroundColor: '#f8f9fa',
                  borderRadius: 12, overflow: 'hidden', marginBottom: 14,
                  border: `1px solid ${C.border}`,
                }}>
                  {[
                    { label: 'Fee Paid',   value: fmtAmt(summary.total_paid),         color: '#27ae60' },
                    { label: 'Months Due', value: summary.months_due_count,            color: dueColor(summary.months_due_count) },
                    { label: 'Last Paid',  value: summary.last_payment_date?.slice(0,7)
                        ? fmtMonth(summary.last_payment_date.slice(0,7)) : 'Never',    color: C.gray },
                  ].map((s, i) => (
                    <div key={i} style={{
                      flex: 1, padding: '12px 8px', textAlign: 'center',
                      borderRight: i < 2 ? `1px solid ${C.border}` : 'none',
                    }}>
                      <div style={{ fontSize: 16, fontWeight: 900, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 10, color: C.gray, fontWeight: 700, marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Due months + action buttons */}
              {summary && summary.due_months.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.red, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                    Overdue — {summary.months_due_count} month(s)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {summary.due_months.map((ym: string) => (
                      <span key={ym} style={{
                        padding: '5px 12px', borderRadius: 20,
                        backgroundColor: '#fdecea', color: C.red,
                        fontSize: 12, fontWeight: 700, border: `1px solid ${C.red}33`,
                      }}>{fmtMonth(ym)}</span>
                    ))}
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 10 }}>
                    {can('payments:record' as any) && (
                    <button onClick={() => setSheet('pay')} style={{
                      flex: 1, padding: '12px 0', borderRadius: 12,
                      border: 'none', backgroundColor: '#1a472a', color: '#fff',
                      fontWeight: 800, fontSize: 14, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}>
                      💰 Pay
                    </button>
                    )}
                    {canWriteOff && (
                      <button onClick={() => setSheet('writeoff')} style={{
                        flex: 1, padding: '12px 0', borderRadius: 12,
                        border: '2px solid #7c3aed', backgroundColor: '#fff', color: '#7c3aed',
                        fontWeight: 800, fontSize: 14, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}>
                        ✏ Write Off
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Payment history */}
              <div style={{ fontSize: 11, fontWeight: 800, color: C.gray, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
                Payment History
              </div>
              {payments.length === 0 ? (
                <div style={{ textAlign: 'center', color: C.gray, padding: '20px 0', fontSize: 13 }}>No fee payments recorded</div>
              ) : payments.map((p, i) => (
                <div key={p.id ?? i} style={{
                  display: 'flex', alignItems: 'center', gap:10,
                  padding: '11px 0',
                  borderBottom: i < payments.length-1 ? `1px solid ${C.border}` : 'none',
                }}>
                  <StudentPhoto student={{name:p.student_name||'?',profile_image:p.profile_image||null}} size={36} style={{borderRadius:8,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontWeight:800,fontSize:11,color:'#1a472a',minWidth:28}}>{p.regno ? fmtRegNo(p.regno) : '000'}</span>
                      <div style={{fontWeight:700,fontSize:13,color:'#222'}}>{p.student_name||'—'}</div>
                      {p.qca_id && <span style={{fontSize:10,color:'#6b7280'}}>Q{String(p.qca_id).padStart(3,'0')}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>
                      {p.billing_month ? fmtPaymentMonth(p) : p.payment_date || '—'} · {p.fee_type_name || '—'} · {p.payment_mode || '—'}
                      {p.receipt_no ? ` · ${p.receipt_no}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, color: '#27ae60' }}>{fmtAmt(p.amount_paid || 0)}</div>
                    {p.payment_date && <div style={{ fontSize: 10, color: C.gray }}>{p.payment_date}</div>}
                    {p.receipt_no && !p.is_posted && (() => {
                      // Show void only on the latest receipt
                      const maxRec = payments
                        .filter((x:any) => x.receipt_no?.startsWith('REC-'))
                        .reduce((mx:string, x:any) => {
                          const n = parseInt((x.receipt_no||'').slice(4)||'0');
                          const m = parseInt((mx||'').slice(4)||'0');
                          return n > m ? x.receipt_no : mx;
                        }, '');
                      return p.receipt_no === maxRec;
                    })() && (
                      <button onClick={e => { e.stopPropagation(); voidPayment((localStorage.getItem('server_ip')||'').replace(/\/+$/,''), p.receipt_no, ()=>{ load(); onChanged?.(); }); }}
                        style={{ fontSize:10, padding:'2px 8px', borderRadius:6, border:'none',
                          backgroundColor:'#fee2e2', color:'#dc2626', fontWeight:700, cursor:'pointer', marginTop:2 }}>
                        🗑 Void
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>

    {/* Toast */}
    {toast && (
      <div style={{
        position: 'fixed', bottom: `calc(24px + ${NAV_CLEARANCE})`,
        left: '50%', transform: 'translateX(-50%)',
        backgroundColor: '#1a472a', color: '#fff',
        padding: '12px 22px', borderRadius: 30,
        fontSize: 13, fontWeight: 700, zIndex: 4000,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        whiteSpace: 'nowrap' as const,
      }}>{toast}</div>
    )}

    {/* Pay sheet */}
    {sheet === 'pay' && summary && (
      <PaySheet
        student={student} summary={summary}
        onClose={() => setSheet(null)}
        onDone={async ({ receipts, months, amountPerMonth, paymentDate }) => {
          setSheet(null);
          const sid = student.student_id ?? student.id;
          // Update the local cache immediately — don't wait for the next
          // full payments sync to reflect this.
          if (months.length) {
            await applyPaymentLocally(sid, months, amountPerMonth, paymentDate);
          }
          showToast(receipts.length
            ? `✅ ${receipts.length} payment${receipts.length > 1 ? 's' : ''} recorded · ${receipts[0]}${receipts.length > 1 ? '…' : ''}`
            : '✅ Payments recorded');
          load();           // refresh this drawer from the now-updated cache
          onChanged?.();    // refresh the main screen's overview / dues list too
        }}
      />
    )}

    {/* Write-off sheet */}
    {sheet === 'writeoff' && summary && (
      <WriteOffSheet
        student={student} summary={summary}
        onClose={() => setSheet(null)}
        onDone={async ({ count, months }) => {
          setSheet(null);
          const sid = student.student_id ?? student.id;
          // Update the local cache immediately — don't wait for the next
          // full payments sync to reflect this.
          if (months.length) {
            await applyWriteOffLocally(sid, months);
          }
          showToast(`✏ ${count} month${count > 1 ? 's' : ''} written off`);
          load();           // refresh this drawer from the now-updated cache
          onChanged?.();    // refresh the main screen's overview / dues list too
        }}
      />
    )}
    </>
  );
}

// ─── Overview drill-down drawer ────────────────────────────────────────────────
function OverviewDrillDrawer({ kind, dueStudents, onClose, onSelectStudent }: {
  kind: DrillKind;
  dueStudents: any[];
  onClose: () => void;
  onSelectStudent: (s: any) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all'|'paidUp'|'withDues'>('all');
  const [severityFilter, setSeverityFilter] = useState<'all'|'low'|'mid'|'high'>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [modeFilter, setModeFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'mostDue'|'name'>('mostDue');

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      let result: any[] = [];
      if (kind === 'students') {
        result = await getAllPaymentSummaries();
      } else if (kind === 'collected') {
        result = await getRecentPayments(200);
      } else if (kind === 'withDues') {
        result = dueStudents;
      } else {
        // monthsDue — flatten each due student's overdue months into one row each
        const flat: any[] = [];
        dueStudents.forEach(s => {
          (JSON.parse(s.due_months_json || '[]') as string[]).forEach(ym => {
            flat.push({ ...s, month: ym });
          });
        });
        flat.sort((a, b) => (a.month || '').localeCompare(b.month || ''));
        result = flat;
      }
      if (active) {
        setRows(result);
        setLoading(false);
        // Reset filters when switching drill-downs
        setSearch(''); setStatusFilter('all'); setSeverityFilter('all');
        setMonthFilter('all'); setModeFilter('all'); setSortBy('mostDue');
      }
    })();
    return () => { active = false; };
  }, [kind, dueStudents]);

  // Distinct months present in the monthsDue rows — for the month filter chips
  const availableMonths = React.useMemo(() => {
    if (kind !== 'monthsDue') return [];
    return Array.from(new Set(rows.map(r => r.month))).sort();
  }, [kind, rows]);

  // Distinct payment modes present in the collected rows — for the mode filter chips
  const availableModes = React.useMemo(() => {
    if (kind !== 'collected') return [];
    return Array.from(new Set(rows.map(r => r.payment_mode).filter(Boolean)));
  }, [kind, rows]);

  const filteredRows = React.useMemo(() => {
    let out = rows;
    const q = search.trim().toLowerCase();

    if (q) {
      out = out.filter(r =>
        matchesStudentSearch({name: r.student_name, regno: r.regno, qca_id: r.qca_id}, q) ||
        (r.receipt_no || '').toLowerCase().includes(q)
      );
    }

    if (kind === 'students' && statusFilter !== 'all') {
      out = out.filter(r => statusFilter === 'paidUp'
        ? !(r.months_due_count > 0)
        : r.months_due_count > 0);
    }

    if (kind === 'withDues' && severityFilter !== 'all') {
      out = out.filter(r => {
        const n = r.months_due_count || 0;
        if (severityFilter === 'low')  return n >= 1 && n <= 2;
        if (severityFilter === 'mid')  return n >= 3 && n <= 5;
        return n >= 6; // high
      });
    }

    if (kind === 'monthsDue' && monthFilter !== 'all') {
      out = out.filter(r => r.month === monthFilter);
    }

    if (kind === 'collected' && modeFilter !== 'all') {
      out = out.filter(r => r.payment_mode === modeFilter);
    }

    if ((kind === 'students' || kind === 'withDues') && sortBy === 'name') {
      out = [...out].sort((a, b) => (a.student_name || '').localeCompare(b.student_name || ''));
    } else if (kind === 'students' || kind === 'withDues') {
      out = [...out].sort((a, b) => (b.months_due_count || 0) - (a.months_due_count || 0));
    }

    return out;
  }, [rows, search, statusFilter, severityFilter, monthFilter, modeFilter, sortBy, kind]);

  const TITLES: Record<DrillKind, string> = {
    students:  'All Students',
    withDues:  'Students With Dues',
    monthsDue: 'Overdue Months',
    collected: 'Collected — Transactions',
  };
  const SUBTITLES: Record<DrillKind, string> = {
    students:  `${filteredRows.length} of ${rows.length} fee-tracked student${rows.length !== 1 ? 's' : ''}`,
    withDues:  `${filteredRows.length} of ${rows.length} student${rows.length !== 1 ? 's' : ''} with overdue fees`,
    monthsDue: `${filteredRows.length} of ${rows.length} overdue month${rows.length !== 1 ? 's' : ''}`,
    collected: `${filteredRows.length} of ${rows.length} transaction${rows.length !== 1 ? 's' : ''}`,
  };

  // ── Chip styles ──
  const chip = (active: boolean, color: string = '#1a472a'): React.CSSProperties => ({
    padding: '6px 13px', borderRadius: 20, fontSize: 11.5, fontWeight: 700,
    border: `1.5px solid ${active ? color : '#e5e7eb'}`,
    backgroundColor: active ? color : '#f9fafb',
    color: active ? '#fff' : C.gray, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  });

  const rows_ = filteredRows;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1900,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor: '#fff', width: '100%', maxHeight: '88vh',
        borderRadius: '20px 20px 0 0', overflowY: 'auto', paddingBottom: 30,
      }}>
        <div style={{
          backgroundColor: C.green, padding: '18px 18px 14px',
          borderRadius: '20px 20px 0 0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>{TITLES[kind]}</div>
            <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 }}>{SUBTITLES[kind]}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {/* ── Filters ── */}
        <div style={{ padding: '12px 16px 0' }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Name, QCA ID, r+Reg No or receipt…"
            style={{
              width: '100%', padding: '9px 14px', borderRadius: 10, fontSize: 13,
              border: '1.5px solid #e5e7eb', outline: 'none',
              boxSizing: 'border-box' as const, fontFamily: 'inherit', marginBottom: 10,
            }}
          />

          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, marginBottom: 8 }}>
            {kind === 'students' && (
              <>
                <button onClick={() => setStatusFilter('all')}     style={chip(statusFilter === 'all')}>All</button>
                <button onClick={() => setStatusFilter('paidUp')}  style={chip(statusFilter === 'paidUp', '#27ae60')}>✅ Paid Up</button>
                <button onClick={() => setStatusFilter('withDues')} style={chip(statusFilter === 'withDues', C.red)}>⚠ With Dues</button>
                <div style={{ width: 1, backgroundColor: C.border, margin: '2px 4px' }} />
                <button onClick={() => setSortBy('mostDue')} style={chip(sortBy === 'mostDue')}>Most Overdue</button>
                <button onClick={() => setSortBy('name')}    style={chip(sortBy === 'name')}>A–Z</button>
              </>
            )}

            {kind === 'withDues' && (
              <>
                <button onClick={() => setSeverityFilter('all')} style={chip(severityFilter === 'all')}>All</button>
                <button onClick={() => setSeverityFilter('low')} style={chip(severityFilter === 'low', '#e67e22')}>1–2 mo</button>
                <button onClick={() => setSeverityFilter('mid')} style={chip(severityFilter === 'mid', '#e67e22')}>3–5 mo</button>
                <button onClick={() => setSeverityFilter('high')} style={chip(severityFilter === 'high', C.red)}>🔴 6+ mo</button>
                <div style={{ width: 1, backgroundColor: C.border, margin: '2px 4px' }} />
                <button onClick={() => setSortBy('mostDue')} style={chip(sortBy === 'mostDue')}>Most Overdue</button>
                <button onClick={() => setSortBy('name')}    style={chip(sortBy === 'name')}>A–Z</button>
              </>
            )}

            {kind === 'monthsDue' && (
              <>
                <button onClick={() => setMonthFilter('all')} style={chip(monthFilter === 'all')}>All Months</button>
                {availableMonths.map(m => (
                  <button key={m} onClick={() => setMonthFilter(m)} style={chip(monthFilter === m)}>{fmtMonth(m)}</button>
                ))}
              </>
            )}

            {kind === 'collected' && (
              <>
                <button onClick={() => setModeFilter('all')} style={chip(modeFilter === 'all')}>All Modes</button>
                {availableModes.map(m => (
                  <button key={m} onClick={() => setModeFilter(m)} style={chip(modeFilter === m, '#c5a059')}>{m}</button>
                ))}
              </>
            )}
          </div>
        </div>

        <div style={{ padding: '0 16px 0' }}>
          {loading ? (
            <div style={{ textAlign: 'center', color: C.gray, padding: 30 }}>Loading…</div>
          ) : rows_.length === 0 ? (
            <div style={{ textAlign: 'center', color: C.gray, padding: '30px 0', fontSize: 13 }}>
              {rows.length === 0 ? 'Nothing to show' : 'No results match your filters'}
            </div>
          ) : kind === 'collected' ? (
            rows_.map((p, i) => (
              <button key={p.id ?? i} onClick={() => onSelectStudent({
                student_id: p.student_id, student_name: p.student_name, profile_image: p.profile_image,
              })} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
                padding: '11px 0', borderBottom: i < rows_.length-1 ? `1px solid ${C.border}` : 'none',
              }}>
                <StudentPhoto student={{name:p.student_name||'?',profile_image:p.profile_image||null}} size={38} style={{borderRadius:8,flexShrink:0}}/>
                <div style={{ minWidth: 0, flex:1 }}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    {p.regno && <span style={{fontWeight:800,fontSize:11,color:'#1a472a',flexShrink:0}}>{fmtRegNo(p.regno)}</span>}
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.student_name || '—'}
                    </div>
                    {p.qca_id && <span style={{fontSize:10,color:'#6b7280',flexShrink:0}}>Q{String(p.qca_id).padStart(3,'0')}</span>}
                    {p.qca_id && <span style={{fontSize:10,color:'#6b7280',flexShrink:0}}>Q{String(p.qca_id).padStart(3,'0')}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>
                    {p.fee_type_name || '—'} · {p.payment_mode || '—'}
                    {p.receipt_no ? ` · ${p.receipt_no}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, paddingLeft: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 15, color: '#27ae60' }}>{fmtAmt(p.amount_paid || 0)}</div>
                  {p.payment_date && <div style={{ fontSize: 10, color: C.gray, marginTop: 2 }}>{p.payment_date}</div>}
                </div>
              </button>
            ))
          ) : kind === 'monthsDue' ? (
            rows_.map((s, i) => (
              <button key={`${s.student_id}-${s.month}-${i}`} onClick={() => onSelectStudent(s)} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
                padding: '10px 0', borderBottom: i < rows_.length-1 ? `1px solid ${C.border}` : 'none',
              }}>
                <StudentPhoto student={{ name: s.student_name, profile_image: s.profile_image }} size={38} style={{borderRadius:8,flexShrink:0}}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    {s.regno && <span style={{fontWeight:800,fontSize:11,color:'#1a472a',flexShrink:0}}>{fmtRegNo(s.regno)}</span>}
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.student_name}
                    </div>
                    {s.qca_id && <span style={{fontSize:10,color:'#6b7280',flexShrink:0}}>Q{String(s.qca_id).padStart(3,'0')}</span>}
                  </div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  backgroundColor: '#fdecea', color: C.red, border: `1px solid ${C.red}33`, flexShrink: 0,
                }}>{fmtMonth(s.month)}</span>
              </button>
            ))
          ) : (
            // students / withDues — both lists of student fee summaries
            rows_.map((s, i) => (
              <button key={s.student_id ?? i} onClick={() => onSelectStudent(s)} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
                padding: '10px 0', borderBottom: i < rows_.length-1 ? `1px solid ${C.border}` : 'none',
              }}>
                <StudentPhoto student={{ name: s.student_name, profile_image: s.profile_image }} size={38} style={{borderRadius:8,flexShrink:0}}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    {s.regno && <span style={{fontWeight:800,fontSize:11,color:'#1a472a',flexShrink:0}}>{fmtRegNo(s.regno)}</span>}
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.student_name}
                    </div>
                    {s.qca_id && <span style={{fontSize:10,color:'#6b7280',flexShrink:0}}>Q{String(s.qca_id).padStart(3,'0')}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>
                    Paid {fmtAmt(s.total_paid || 0)} · Last: {s.last_payment_date
                      ? fmtMonth(s.last_payment_date.slice(0,7)) : 'Never'}
                  </div>
                </div>
                {s.months_due_count > 0 && (
                  <span style={{
                    fontSize: 12, fontWeight: 900, padding: '3px 10px', borderRadius: 20,
                    backgroundColor: dueColor(s.months_due_count) + '18', color: dueColor(s.months_due_count),
                    border: `1px solid ${dueColor(s.months_due_count)}33`, flexShrink: 0,
                  }}>{s.months_due_count} due</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Alert row card ───────────────────────────────────────────────────────────
function AlertRow({ student, lastAttended, inactiveDays, onTap, first }: {
  student: any;
  lastAttended?: { date: string; session: string } | null;
  inactiveDays: number;
  onTap: () => void;
  first?: boolean;
}) {
  const n      = student.months_due_count as number;
  const color  = dueColor(n);
  const gap    = attendanceGap(lastAttended);
  const attColor = gap >= inactiveDays ? C.red : gap >= Math.ceil(inactiveDays / 2) ? C.orange : '#27ae60';
  const seen   = !lastAttended ? 'never seen' : gap <= 0 ? 'seen today' : gap === 1 ? 'seen 1d ago' : `seen ${gap}d ago`;
  const ids    = [student.regno ? fmtRegNo(student.regno) : '',
                  student.qca_id ? `Q${String(student.qca_id).padStart(3,'0')}` : ''].filter(Boolean).join(' · ');
  const paid   = student.last_payment_date ? `Paid ${fmtMonth(student.last_payment_date.slice(0,7))}` : 'Never paid';
  return (
    <button onClick={onTap}
      title={`Last attended: ${fmtLastAttended(lastAttended)}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 56,
        padding: '8px 12px', background: '#fff', border: 'none', cursor: 'pointer', textAlign: 'left',
        borderTop: first ? 'none' : '1px solid #eef0f2', boxShadow: `inset 3px 0 0 ${color}`,
      }}>
      <StudentPhoto student={{ name: student.student_name, profile_image: student.profile_image }} size={38} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {student.student_name}
        </div>
        <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ids && <span style={{ color: '#1a472a', fontWeight: 700 }}>{ids} · </span>}{paid}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 900, color, lineHeight: 1.1 }}>
          {n}<span style={{ fontSize: 10, fontWeight: 800 }}> mo due</span>
        </div>
        <div style={{ fontSize: 10.5, color: attColor, marginTop: 3, fontWeight: gap >= inactiveDays ? 800 : 600 }}>
          {gap >= inactiveDays ? '⚠ ' : ''}{seen}
        </div>
      </div>
    </button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
// ── Add Payment Modal ────────────────────────────────────────────────────────
function AddPaymentModal({ onClose, onSuccess }: {
  onClose: () => void;
  onSuccess: (receipt: string, payment: any) => void;
}) {
  const base = buildBase(localStorage.getItem('server_ip') ?? '');

  const [students,   setStudents]   = useState<any[]>([]);
  const [categories,   setCategories]   = useState<any[]>([]);
  const [catSearch,    setCatSearch]    = useState('');
  const [showCatList,  setShowCatList]  = useState(false);
  const [selectedCat,  setSelectedCat]  = useState<any|null>(null);
  const [stuSearch,  setStuSearch]  = useState('');
  const [showStuList,setShowStuList]= useState(false);
  const [selected,   setSelected]   = useState<any|null>(null);

  const [form, setForm] = useState({
    category_id:  '',
    amount:       '',
    direction:    'IN',
    mode:         'Cash',
    payment_date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
    billing_month:'',
    note:         '',
  });
  const [touched,    setTouched]    = useState<Record<string,boolean>>({});
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [success,    setSuccess]    = useState('');
  const [lastPayment,setLastPayment]= useState<any|null>(null);
  const [waSending,  setWASending]  = useState(false);
  const [waResult,   setWAResult]   = useState('');
  // A half-entered payment asks Discard / Keep editing before the popup closes (back, ✕ or tap outside)
  const paymentDirty = !lastPayment && !saving && (!!selected || !!selectedCat || !!form.amount || !!form.note.trim());
  useUnsavedChanges(paymentDirty, { message: 'This payment has not been recorded yet.' });
  const guardedClose = async () => { if (await confirmLeave()) onClose(); };

  // Generate last 12 months
  const monthOpts = Array.from({length:12},(_,i)=>{
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth()-i);
    const mon = MONTHS[d.getMonth()]; // Use fixed 3-letter abbreviations
    const yr  = String(d.getFullYear()).slice(2);
    return `${mon}-${yr}`;
  });

  useEffect(()=>{
    fetch(`${base}/api/data/students?limit=5000`,{headers:hdrs()})
      .then(r=>r.ok?r.json():{data:[]})
      .then(j=>setStudents(j.data||[]))
      .catch(()=>{});
    // Real income categories (ids must match the server's account_categories).
    // Synced local copy first so the picker works offline, then refresh.
    // Student payments are tuition or admission only (other income goes through Finance)
    const income = (rows:any[]) => rows.filter((c:any)=>c.txn_type==='INCOME' && STUDENT_FEE_IDS.includes(Number(c.id)));
    getFeeCategories().then(rows=>{ if (rows.length) setCategories(income(rows)); }).catch(()=>{});
    fetch(`${base}/api/data/fee-categories`,{headers:hdrs()})
      .then(r=>r.ok?r.json():{data:[]})
      .then(async j=>{
        if (j.data?.length) { setCategories(income(j.data)); await syncFeeCategories(j.data); }
      })
      .catch(()=>{});
  },[]);

  const filteredStudents = stuSearch
    ? students.filter(s=>
        matchesStudentSearch(s, stuSearch))
    : students.slice(0,30);

  const selectStudent = (s: any) => {
    setSelected(s);
    setStuSearch(s.name);
    setShowStuList(false);
    setForm(f=>({
      ...f,
      amount: s.monthly_fee ? String(s.monthly_fee) : f.amount,
    }));
    setTouched(t=>({...t, student:true}));
  };

  const selectCategory = (c: any) => {
    setSelectedCat(c);
    setCatSearch(c.name);
    setShowCatList(false);
    setForm(f=>({...f, category_id: String(c.id)}));
    setTouched(t=>({...t, category_id:true}));
  };

  const filteredCats = catSearch
    ? categories.filter(c =>
        c.name.toLowerCase().includes(catSearch.toLowerCase()))
    : categories;

  const shareReceipt = async (receiptNo: string) => {
    if (!receiptNo) return;
    try {
      const base = (localStorage.getItem('server_ip')||'').trim().replace(/\/+$/,'');
      const serverBase = base.startsWith('http') ? base : `http://${base}`;
      const r = await fetch(`${serverBase}/api/data/payments/${receiptNo}/receipt-pdf`, {
        headers: (()=>{const _j=localStorage.getItem('jwt_token'),_e=parseInt(localStorage.getItem('jwt_expiry')||'0');if(_j&&Date.now()<_e-60000)return{'Content-Type':'application/json','Authorization':'Bearer '+_j,'X-Username':localStorage.getItem('auth_user')||''};return{'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};})()
      });
      if (!r.ok) { alert('Failed to generate receipt'); return; }
      const blob = await r.blob();
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const fname = `receipt_${receiptNo}.pdf`;
        await Filesystem.writeFile({ path: fname, data: base64, directory: Directory.Cache });
        const uri = await Filesystem.getUri({ path: fname, directory: Directory.Cache });
        await Share.share({ title: `Receipt ${receiptNo}`, url: uri.uri, dialogTitle: 'Share Receipt' });
      };
      reader.readAsDataURL(blob);
    } catch(e) { alert('Error: ' + String(e)); }
  };

  const handleSendWA = async () => {
    if (!lastPayment) return;
    setWASending(true); setWAResult('');
    try {
      const r = await fetch(`${base}/api/data/payments/send_receipt_wa`, {
        method:'POST',
        headers:{...hdrs(),'Content-Type':'application/json'},
        body:JSON.stringify({student_id:lastPayment.student_id,...lastPayment}),
      });
      const j = await r.json();
      setWAResult(j.success ? '✅ WhatsApp sent!' : '❌ '+(j.error||'Failed'));
    } catch { setWAResult('❌ Network error'); }
    finally { setWASending(false); }
  };

  const validate = () => {
    const errs: string[] = [];
    if (!selected)         errs.push('Student is required');
    if (!form.category_id) errs.push('Fee category is required');
    if (!form.amount || Number(form.amount)<=0) errs.push('Amount must be greater than 0');
    if (!form.payment_date) errs.push('Payment date is required');
    if (!form.billing_month) errs.push('Billing month is required');
    return errs;
  };

  const handleSubmit = async () => {
    setTouched({student:true,category_id:true,amount:true,payment_date:true,billing_month:true});
    const errs = validate();
    if (errs.length>0) { setError(errs[0]); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch(`${base}/api/data/payments/record`,{
        method:'POST',
        headers:{...hdrs(),'Content-Type':'application/json'},
        body:JSON.stringify({
          student_id:    selected!.id,
          category_id:  Number(form.category_id),
          amount:        Number(form.amount),
          direction:     form.direction,
          mode:          form.mode,
          payment_date:  form.payment_date,
          billing_month: form.billing_month,
          note:          form.note,
        }),
      });
      const j = await r.json();
      if (j.success) {
        setSuccess(`✅ ${j.receipt_no}`);
        setLastPayment({
          student_id:    selected!.id,
          receipt_no:    j.receipt_no,
          student_name:  j.student,
          amount:        j.amount,
          billing_month: form.billing_month,
          mode:          form.mode,
        });
      } else if (r.status===409) {
        setError(`⚠ Already paid: ${j.message} (${j.receipt_no})`);
      } else {
        setError(j.error||'Failed to record payment');
      }
    } catch { setError('Network error — check connection'); }
    finally { setSaving(false); }
  };

  // Field border style — red if touched & empty, gold if has value, default otherwise
  const fStyle = (key: string, val: string): React.CSSProperties => ({
    width:'100%', padding:'12px 14px', borderRadius:10, fontSize:14,
    outline:'none', boxSizing:'border-box' as const,
    fontFamily:'inherit', backgroundColor:'#fff',
    border: touched[key] && !val
      ? '2px solid #dc2626'
      : val ? '2px solid #d4af37' : '1.5px solid #e5e7eb',
    transition: 'border-color 0.2s',
  });

  const Label = ({t,required}:{t:string;required?:boolean})=>(
    <div style={{fontSize:11,fontWeight:800,color:'#374151',
      textTransform:'uppercase' as const,letterSpacing:'0.6px',
      marginBottom:5,marginTop:14,display:'flex',alignItems:'center',gap:4}}>
      {t}
      {required&&<span style={{color:'#dc2626',fontSize:13,fontWeight:900}}>*</span>}
    </div>
  );

  return (
    <div style={{position:'fixed',inset:0,zIndex:3000,
      backgroundColor:'rgba(0,0,0,0.55)',display:'flex',alignItems:'flex-end'}}
      onClick={e=>{if(e.target===e.currentTarget)guardedClose();}}>
      <div style={{backgroundColor:'#f0f4f1',width:'100%',
        borderRadius:'22px 22px 0 0',maxHeight:'92vh',
        overflowY:'auto',paddingBottom:40}}>

        {/* Handle bar */}
        <div style={{display:'flex',justifyContent:'center',padding:'10px 0 0'}}>
          <div style={{width:40,height:4,borderRadius:2,backgroundColor:'#d1d5db'}}/>
        </div>

        {/* Header */}
        <div style={{display:'flex',justifyContent:'space-between',
          alignItems:'center',padding:'14px 20px 8px'}}>
          <div>
            <div style={{fontWeight:900,fontSize:18,color:'#0d1b2a'}}>
              💰 Record Payment
            </div>
            <div style={{fontSize:11,color:'#6b7280',marginTop:2}}>
              Fields marked <span style={{color:'#dc2626',fontWeight:800}}>*</span> are required
            </div>
          </div>
          <button onClick={guardedClose} aria-label="Close" style={{background:'rgba(0,0,0,0.06)',
            border:'none',width:32,height:32,borderRadius:'50%',
            fontSize:16,cursor:'pointer',color:'#6b7280',
            display:'flex',alignItems:'center',justifyContent:'center'}}>✕</button>
        </div>

        <div style={{padding:'0 16px'}}>

          {/* Success card */}
          {success&&(
            <div style={{padding:'16px',borderRadius:16,marginBottom:16,marginTop:8,
              backgroundColor:'#dcfce7',border:'1px solid #86efac'}}>
              <div style={{fontWeight:900,fontSize:15,color:'#166534',marginBottom:4}}>
                {success} — Payment Recorded
              </div>
              <div style={{fontSize:12,color:'#166534',marginBottom:12}}>
                ✉️ Email receipt sent automatically
              </div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>shareReceipt(lastPayment?.receipt_no||'')}
                  style={{flex:1,padding:'11px',borderRadius:12,border:'none',
                    backgroundColor:'#7c3aed',color:'#fff',fontWeight:800,
                    fontSize:13,cursor:'pointer',display:'flex',
                    alignItems:'center',justifyContent:'center',gap:6}}>
                  📄 Receipt PDF
                </button>
                <button onClick={handleSendWA} disabled={waSending||!!waResult}
                style={{width:'100%',padding:'11px',borderRadius:12,border:'none',
                  backgroundColor:waResult
                    ?(waResult.startsWith('✅')?'#25d366':'#dc2626')
                    :'#25d366',
                  color:'#fff',fontWeight:800,fontSize:14,
                  cursor:waSending||!!waResult?'default':'pointer'}}>
                {waSending?'⏳ Sending…':waResult||'💬 Send WhatsApp Receipt'}
              </button>
              </div>
              <button onClick={()=>onSuccess(lastPayment?.receipt_no||'',lastPayment)}
                style={{width:'100%',marginTop:8,padding:'10px',borderRadius:12,
                  border:'1px solid #86efac',backgroundColor:'transparent',
                  color:'#166534',fontWeight:800,fontSize:13,cursor:'pointer'}}>
                Done ✓ Close
              </button>
            </div>
          )}

          {/* Error */}
          {error&&!success&&(
            <div style={{padding:'10px 14px',borderRadius:10,marginBottom:8,marginTop:8,
              backgroundColor:'#fee2e2',border:'1px solid #fca5a5',
              fontWeight:700,fontSize:13,color:'#dc2626'}}>
              ⚠ {error}
            </div>
          )}

          {!success&&(<>

          {/* ── Student picker ── */}
          <Label t="Student" required/>
          <div style={{position:'relative'}}>
            <input
              value={stuSearch}
              onChange={e=>{setStuSearch(e.target.value);setShowStuList(true);setSelected(null);}}
              onFocus={()=>setShowStuList(true)}
              placeholder="Name, QCA ID or r+Reg No…"
              style={fStyle('student', selected?'ok':'')}
            />
            {/* Selected indicator */}
            {selected&&(
              <div style={{position:'absolute',right:10,top:'50%',
                transform:'translateY(-50%)',pointerEvents:'none'}}>
                <StudentPhoto student={selected} size={26}
                  style={{border:'2px solid #d4af37'}}/>
              </div>
            )}
            {/* Dropdown */}
            {showStuList&&filteredStudents.length>0&&(
              <div style={{position:'absolute',top:'100%',left:0,right:0,
                backgroundColor:'#fff',borderRadius:10,zIndex:100,
                maxHeight:240,overflowY:'auto',
                boxShadow:'0 8px 24px rgba(0,0,0,0.12)',
                border:'1px solid #e5e7eb',marginTop:4}}>
                {filteredStudents.map(s=>(
                  <div key={s.id} onClick={()=>selectStudent(s)}
                    style={{display:'flex',alignItems:'center',gap:10,
                      padding:'10px 14px',cursor:'pointer',
                      borderBottom:'1px solid #f3f4f6',
                      backgroundColor:'#fff'}}
                    onMouseEnter={e=>(e.currentTarget.style.backgroundColor='#f0f4f1')}
                    onMouseLeave={e=>(e.currentTarget.style.backgroundColor='#fff')}>
                    <StudentPhoto student={s} size={36} />
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:14,color:'#111',
                        overflow:'hidden',textOverflow:'ellipsis',
                        whiteSpace:'nowrap' as const}}>{s.name}</div>
                      <div style={{fontSize:11,color:'#6b7280'}}>
                        {formatRegno(s.regno)}{s.qca_id ? ` · Q${String(s.qca_id).padStart(3,'0')}` : ''} · {s.level||'—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selected student summary */}
          {selected&&(
            <div style={{display:'flex',alignItems:'center',gap:12,
              backgroundColor:'#1a472a',borderRadius:12,padding:'10px 14px',marginTop:6}}>
              <StudentPhoto student={selected} size={44}
                style={{border:'2px solid #d4af37'}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{color:'#fff',fontWeight:800,fontSize:14}}>{selected.name}</div>
                <div style={{color:'rgba(255,255,255,0.7)',fontSize:11,marginTop:2}}>
                  {formatRegno(selected.regno)} · {selected.level||'—'}
                  {selected.monthly_fee?` · Rs.${selected.monthly_fee}/mo`:''}
                </div>
              </div>
              <button onClick={()=>{setSelected(null);setStuSearch('');}}
                style={{background:'rgba(255,255,255,0.15)',border:'none',
                  color:'#fff',borderRadius:8,padding:'4px 8px',
                  cursor:'pointer',fontSize:12}}>✕</button>
            </div>
          )}

          {/* ── Billing month ── */}
          <Label t="Billing Month" required/>
          <select value={form.billing_month}
            onBlur={()=>setTouched(t=>({...t,billing_month:true}))}
            onChange={e=>{setForm(f=>({...f,billing_month:e.target.value}));
              setTouched(t=>({...t,billing_month:true}));}}
            style={fStyle('billing_month',form.billing_month)}>
            <option value="">-- Select Month --</option>
            {monthOpts.map(m=><option key={m} value={m}>{m}</option>)}
          </select>

          {/* ── Fee Category (searchable) ── */}
          <Label t="Fee Category" required/>
          <div style={{position:'relative'}}>
            <input
              value={catSearch}
              onChange={e=>{setCatSearch(e.target.value);setShowCatList(true);setSelectedCat(null);setForm(f=>({...f,category_id:''}));}}
              onFocus={()=>setShowCatList(true)}
              onBlur={()=>setTimeout(()=>setShowCatList(false),200)}
              placeholder="Search category…"
              style={fStyle('category_id', selectedCat?'ok':'')}
            />
            {/* Dropdown */}
            {showCatList&&(
              <div style={{position:'absolute',top:'100%',left:0,right:0,
                backgroundColor:'#fff',borderRadius:10,zIndex:200,
                maxHeight:200,overflowY:'auto',
                boxShadow:'0 8px 24px rgba(0,0,0,0.12)',
                border:'1px solid #e5e7eb',marginTop:4}}>
                {(filteredCats.length>0 || catSearch ? filteredCats : [
                  // Offline and never synced: the two student fee types
                  {id:1,name:'Monthly Tuition Fee'},{id:2,name:'Admission Fee'},
                ]).map(c=>(
                  <div key={c.id}
                    onMouseDown={()=>selectCategory(c)}
                    style={{padding:'11px 14px',cursor:'pointer',
                      fontSize:14,fontWeight:600,color:'#111',
                      borderBottom:'1px solid #f3f4f6',
                      backgroundColor:'#fff'}}
                    onMouseEnter={e=>(e.currentTarget.style.backgroundColor='#f0f4f1')}
                    onMouseLeave={e=>(e.currentTarget.style.backgroundColor='#fff')}>
                    {c.name}
                  </div>
                ))}
                {filteredCats.length===0&&catSearch&&(
                  <div style={{padding:'12px 14px',fontSize:12,
                    color:'#6b7280',fontStyle:'italic'}}>
                    No match for "{catSearch}"
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Selected category badge */}
          {selectedCat&&(
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',
              backgroundColor:'#f0fdf4',border:'1px solid #86efac',
              borderRadius:10,padding:'7px 12px',marginTop:4}}>
              <span style={{fontSize:13,fontWeight:700,color:'#166534'}}>
                ✓ {selectedCat.name}
              </span>
              <button onMouseDown={()=>{setSelectedCat(null);setCatSearch('');setForm(f=>({...f,category_id:''}));}}
                style={{background:'none',border:'none',cursor:'pointer',
                  fontSize:15,color:'#6b7280',padding:0}}>✕</button>
            </div>
          )}

          {/* ── Amount ── */}
          <Label t="Amount (₹)" required/>
          <div style={{position:'relative'}}>
            <span style={{position:'absolute',left:14,top:'50%',
              transform:'translateY(-50%)',fontWeight:800,
              color:'#6b7280',fontSize:14}}>₹</span>
            <input type="number"
              value={form.amount}
              onBlur={()=>setTouched(t=>({...t,amount:true}))}
              onChange={e=>{setForm(f=>({...f,amount:e.target.value}));
                setTouched(t=>({...t,amount:true}));}}
              placeholder="0"
              min="1"
              style={{...fStyle('amount',form.amount),paddingLeft:52}}/>
          </div>

          {/* ── Two columns: Date + Mode ── */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <div>
              <Label t="Payment Date" required/>
              <input type="date"
                value={form.payment_date}
                onBlur={()=>setTouched(t=>({...t,payment_date:true}))}
                onChange={e=>{setForm(f=>({...f,payment_date:e.target.value}));
                  setTouched(t=>({...t,payment_date:true}));}}
                style={fStyle('payment_date',form.payment_date)}/>
            </div>
            <div>
              <Label t="Mode"/>
              <select value={form.mode}
                onChange={e=>setForm(f=>({...f,mode:e.target.value}))}
                style={{...fStyle('mode','ok'),color:'#111'}}>
                {['Cash','UPI','Bank Transfer','Cheque','Card','Online'].map(m=>
                  <option key={m} value={m}>{m}</option>
                )}
              </select>
            </div>
          </div>

          {/* ── Note ── */}
          <Label t="Note (optional)"/>
          <input value={form.note}
            onChange={e=>setForm(f=>({...f,note:e.target.value}))}
            placeholder="Auto-generated if blank"
            maxLength={200}
            style={fStyle('note','ok')}/>

          {/* Mandatory hint */}
          <div style={{display:'flex',alignItems:'center',gap:6,
            marginTop:10,padding:'8px 12px',borderRadius:10,
            backgroundColor:'#fff7ed',border:'1px solid #fed7aa'}}>
            <span style={{color:'#dc2626',fontWeight:900,fontSize:13}}>*</span>
            <span style={{fontSize:11,color:'#92400e',fontWeight:600}}>
              Required fields are highlighted with a gold border when filled
            </span>
          </div>

          {/* Submit */}
          <button onClick={handleSubmit} disabled={saving}
            style={{width:'100%',marginTop:16,padding:'16px',
              borderRadius:14,border:'none',
              backgroundColor:saving?'#9ca3af':'#1a472a',
              color:'#fff',fontWeight:900,fontSize:16,
              cursor:saving?'not-allowed':'pointer',
              boxShadow:saving?'none':'0 4px 16px rgba(26,71,42,0.4)',
              letterSpacing:'0.5px'}}>
            {saving?'⏳ Recording…':'✅ Record Payment'}
          </button>

          </>)}
        </div>
      </div>
    </div>
  );
}



// ── Main Screen ───────────────────────────────────────────────────────────────
// ─── Void Last Payment ───────────────────────────────────────────────────────
function VoidLastPaymentButton({ base, onDone }: { base: string; onDone: () => void }) {
  const [loading,   setLoading]   = useState(false);
  const [lastReceipt, setLastReceipt] = useState<any>(null);

  useEffect(() => {
    // Fetch the latest receipt
    fetch(`${base}/api/data/payments?limit=1&sort=desc`, { headers: hdrs() })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const latest = j?.data?.[0];
        if (latest?.receipt_no && !latest.is_posted) setLastReceipt(latest);
        else setLastReceipt(null);
      }).catch(() => {});
  }, [base]);

  if (!lastReceipt) return null;

  const handleVoid = async () => {
    if (!window.confirm(`Void ${lastReceipt.receipt_no} (${lastReceipt.student_name} · Rs.${lastReceipt.amount_paid})?

This cannot be undone.`)) return;
    setLoading(true);
    try {
      const res = await fetch(`${base}/api/data/payments/${lastReceipt.receipt_no}/void`, {
        method: 'DELETE', headers: hdrs(),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { alert('✅ ' + (j.message || 'Voided successfully')); onDone(); setLastReceipt(null); }
      else alert('⚠ ' + (j.error || 'Failed to void'));
    } catch(e: any) { alert('⚠ ' + e.message); }
    setLoading(false);
  };

  return (
    <div style={{margin:'0 16px 12px',padding:'12px 16px',backgroundColor:'#fff3cd',
      borderRadius:12,border:'1px solid #ffc107',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <div>
        <div style={{fontWeight:700,fontSize:13,color:'#856404'}}>Last Receipt: {lastReceipt.receipt_no}</div>
        <div style={{fontSize:12,color:'#856404',marginTop:2}}>
          {lastReceipt.student_name} · Rs.{lastReceipt.amount_paid} · {lastReceipt.payment_date}
        </div>
      </div>
      <button onClick={handleVoid} disabled={loading}
        style={{padding:'8px 14px',borderRadius:8,border:'none',backgroundColor:'#dc3545',
          color:'#fff',fontWeight:700,fontSize:12,cursor:'pointer',flexShrink:0}}>
        {loading ? '…' : '🗑 Void'}
      </button>
    </div>
  );
}

export default function PaymentsScreen() {
  const { can, canAny }   = usePermissions();
  const navigate           = useNavigate();
  const restricted        = isDataRestricted();
  const linkedIds         = getLinkedStudentIds();
  const isAdminRole       = (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
  const [showAdd,     setShowAdd]     = useState(false);
  const [lastReceipt, setLastReceipt] = useState('');

  const [overview,    setOverview]    = useState<any|null>(null);
  const [dueStudents, setDueStudents] = useState<any[]>([]);
  const [recentPmts,  setRecentPmts]  = useState<any[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [drawer,      setDrawer]      = useState<any|null>(null);
  const [drillKind,   setDrillKind]   = useState<DrillKind|null>(null);
  const [collectedRevealed, setCollectedRevealed] = useState(false);
  const [lastAttendance, setLastAttendance] = useState<Record<number, {date:string; session:string}>>({});
  const [attFilter,   setAttFilter]   = useState<'all'|'active'|'inactive'>('all');
  const [inactiveDays, setInactiveDays] = useState(14);
  const canAlerts = can('payments:alerts');
  const [tab, setTab] = useState<'alerts'|'recent'>(canAlerts ? 'alerts' : 'recent');
  // "Paid" list shows one month at a time — this month by default
  const thisMonth = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
  const [payMonth, setPayMonth] = useState(thisMonth);
  const payMonthRef = React.useRef(thisMonth);
  const shiftMonth = (delta: number) => {
    const [y, m] = payMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (ym > thisMonth) return;                 // no future months
    payMonthRef.current = ym; setPayMonth(ym);
    getPaymentsForMonth(ym).then(setRecentPmts).catch(() => setRecentPmts([]));
  };
  const goThisMonth = () => {
    payMonthRef.current = thisMonth; setPayMonth(thisMonth);
    getPaymentsForMonth(thisMonth).then(setRecentPmts).catch(() => setRecentPmts([]));
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const freshRestricted = isDataRestricted();
      const freshLinkedIds  = getLinkedStudentIds();

      if (freshRestricted) {
        if (freshLinkedIds.length === 0) { setLoading(false); return; }
        const allPmts: any[] = [];
        for (const sid of freshLinkedIds) {
          try {
            const pmts = await getStudentPayments(sid);
            const studs = await getAllStudents();
            const stu = studs.find((s: any) => s.id === sid);
            pmts.forEach((p: any) => {
              allPmts.push({ ...p, student_name: stu?.name ?? 'You',
                profile_image: stu?.profile_image ?? null,
                regno: stu?.regno ?? null,
                qca_id: stu?.qca_id ?? null });
            });
          } catch {}
        }
        allPmts.sort((a, b) => {
          const da = b.payment_date || normMonth(b.billing_month) || '';
          const db2 = a.payment_date || normMonth(a.billing_month) || '';
          return da.localeCompare(db2);
        });
        setRecentPmts(allPmts);
        setDueStudents([]);
        setOverview(null);
      } else {
        const [ov, dues, lastAtt, monthPmts] = await Promise.all([
          getPaymentOverview(),
          getStudentsWithDues(),
          getLastAttendanceMap(),
          // Every student payment received in the selected month (one query, all students)
          getPaymentsForMonth(payMonthRef.current),
        ]);
        setOverview(ov);
        setDueStudents(dues);
        setLastAttendance(lastAtt);
        setRecentPmts(monthPmts);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load().then(async () => {
      // Auto-sync payments from server if local is empty
      const localMax = await getPaymentsMaxId();
      if (localMax === 0) {
        await syncPaymentsOnly();
        await syncStudentsOnly();
        await load();
      }
    });
  }, []); // eslint-disable-line

  // Pull-to-refresh: payments + student fee changes
  const { pullProps, PullIndicator } = usePullToRefresh(async () => {
    await Promise.all([syncPaymentsOnly(), syncStudentsOnly()]);
    await load();
  });

  useEffect(() => {
    const reload = () => load();
    window.addEventListener('permissions-changed', reload);
    // Background sync finished refreshing dues (payment_summary)
    window.addEventListener('qca-dues-updated', reload);
    return () => {
      window.removeEventListener('permissions-changed', reload);
      window.removeEventListener('qca-dues-updated', reload);
    };
  }, [load]);

  // Fee-alert list narrowed by attendance recency — "Inactive" = no Present
  // attendance in the last `inactiveDays` days (or never attended).
  const filteredDueStudents = useMemo(() => {
    if (attFilter === 'all') return dueStudents;
    return dueStudents.filter(s => {
      const gap = attendanceGap(lastAttendance[s.student_id]);
      return attFilter === 'inactive' ? gap >= inactiveDays : gap < inactiveDays;
    });
  }, [dueStudents, lastAttendance, attFilter, inactiveDays]);

  const inactiveCount = useMemo(() =>
    dueStudents.filter(s => attendanceGap(lastAttendance[s.student_id]) >= inactiveDays).length,
    [dueStudents, lastAttendance, inactiveDays]
  );

  const C2 = { bg: '#f0f4f1', green: '#1a472a', gold: '#d4af37',
    red: '#c0392b', border: '#e5e7eb', muted: '#6b7280', card: '#fff' };

  return (
    <>
    <div style={{ backgroundColor: C2.bg, minHeight: '100vh', fontFamily: 'sans-serif', paddingBottom: 80 }} {...pullProps}>
      <PullIndicator />

      <ScreenHeader title="Payments" subtitle="Fee tracking & payment records" />

      {/* Overview + tabs — scroll away under the pinned header */}
      <div style={{ backgroundColor: C2.green, paddingTop: 2 }}>
        {/* Overview strip — admins always see this, even if the server's
            granted permission set hasn't caught up to include payments:summary */}
        {overview && (can('payments:summary') || isAdminRole) && (
          <OverviewStrip
            ov={overview}
            collectedRevealed={collectedRevealed}
            onReveal={() => setCollectedRevealed(true)}
            onOpen={kind => setDrillKind(kind)}
          />
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', margin: '10px 12px 0',
          backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 12, padding: 3 }}>
          {can('payments:alerts') && (
            <button onClick={() => setTab('alerts')} style={{
              flex: 1, padding: '9px 0', borderRadius: 9, border: 'none',
              cursor: 'pointer', fontWeight: 700, fontSize: 13,
              backgroundColor: tab === 'alerts' ? '#fff' : 'transparent',
              color: tab === 'alerts' ? C2.green : 'rgba(255,255,255,0.8)',
            }}>🚨 Fee Alerts ({dueStudents.length})</button>
          )}
          {can('payments:view') && (
            <button onClick={() => setTab('recent')} style={{
              flex: 1, padding: '9px 0', borderRadius: 9, border: 'none',
              cursor: 'pointer', fontWeight: 700, fontSize: 13,
              backgroundColor: tab === 'recent' ? '#fff' : 'transparent',
              color: tab === 'recent' ? C2.green : 'rgba(255,255,255,0.8)',
            }}>✅ Paid</button>
          )}
        </div>
        <div style={{ height: 12 }} />
      </div>

      <div style={{ padding: '10px 10px 0' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: C2.muted }}>
            <div style={{ fontSize: 32 }}>⏳</div>
          </div>
        )}

        {/* Alerts tab */}
        {!loading && tab === 'alerts' && can('payments:alerts') && (
          <div>
            {restricted && linkedIds.length === 0 && (
              <div style={{ padding: '12px 14px', borderRadius: 12,
                backgroundColor: '#fef3c7', border: '1px solid #fcd34d' }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: '#92400e' }}>
                  ⚠ Account not linked — contact admin
                </div>
              </div>
            )}
            {dueStudents.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 0', color: C2.muted }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#111' }}>All Clear!</div>
                <div style={{ fontSize: 13, marginTop: 6 }}>No outstanding fee dues</div>
              </div>
            )}

            {/* Attendance-recency filter */}
            {dueStudents.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {([
                  { key: 'all',      label: `All (${dueStudents.length})` },
                  { key: 'active',   label: '🟢 Attending' },
                  { key: 'inactive', label: `⚠ Inactive (${inactiveCount})` },
                ] as const).map(f => (
                  <button key={f.key} onClick={() => setAttFilter(f.key)} style={{
                    padding: '5px 11px', borderRadius: 16, cursor: 'pointer',
                    border: `1px solid ${attFilter === f.key ? C2.green : C2.border}`,
                    backgroundColor: attFilter === f.key ? C2.green : '#fff',
                    color: attFilter === f.key ? '#fff' : C2.muted,
                    fontWeight: 700, fontSize: 12,
                  }}>{f.label}</button>
                ))}
                {attFilter !== 'all' && (
                  <select
                    value={inactiveDays}
                    onChange={e => setInactiveDays(Number(e.target.value))}
                    style={{
                      marginLeft: 'auto', padding: '6px 8px', borderRadius: 8,
                      border: `1px solid ${C2.border}`, fontSize: 12, fontWeight: 700,
                      backgroundColor: '#fff', color: C2.muted,
                    }}
                  >
                    {[7, 14, 30, 60].map(d => <option key={d} value={d}>{d}+ days</option>)}
                  </select>
                )}
              </div>
            )}

            {dueStudents.length > 0 && filteredDueStudents.length === 0 && (
              <div style={{ textAlign: 'center', padding: '30px 0', color: C2.muted }}>
                <div style={{ fontSize: 13 }}>No students match this filter</div>
              </div>
            )}

            {filteredDueStudents.length > 0 && (
              <div style={LIST_CARD}>
                {filteredDueStudents.map((s: any, i: number) => (
                  <AlertRow
                    key={s.student_id}
                    first={i === 0}
                    student={s}
                    lastAttended={lastAttendance[s.student_id]}
                    inactiveDays={inactiveDays}
                    onTap={() => setDrawer(s)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Recent tab */}
        {!loading && tab === 'recent' && can('payments:view') && (
          <div>
            {restricted && linkedIds.length > 0 && (
              <div style={{ backgroundColor: C2.green, borderRadius: 14,
                padding: '14px 16px', marginBottom: 12,
                display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 28 }}>💰</span>
                <div>
                  <div style={{ color: '#fff', fontWeight: 800, fontSize: 15 }}>My Payments</div>
                  <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 }}>
                    {recentPmts.length} record{recentPmts.length !== 1 ? 's' : ''} found
                  </div>
                </div>
              </div>
            )}
            {restricted && linkedIds.length === 0 && (
              <div style={{ padding: '12px 14px', borderRadius: 12,
                backgroundColor: '#fef3c7', border: '1px solid #fcd34d' }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: '#92400e' }}>
                  ⚠ Account not linked — contact admin
                </div>
              </div>
            )}
            {/* Month picker + summary (staff view — the restricted view lists all of the user's own payments) */}
            {!restricted && (() => {
              const [y, m] = payMonth.split('-').map(Number);
              const label = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
              const total = recentPmts.reduce((a: number, p: any) => a + (Number(p.amount_paid) || 0), 0);
              const people = new Set(recentPmts.map((p: any) => p.student_id)).size;
              const atNow = payMonth >= thisMonth;
              const arrow = (on: boolean): React.CSSProperties => ({ width: 34, height: 30, borderRadius: 8, border: 'none', fontSize: 18, fontWeight: 800,
                backgroundColor: on ? '#f0f4f0' : 'transparent', color: on ? C2.green : '#d1d5db', cursor: on ? 'pointer' : 'default' });
              return (
                <div style={{ ...LIST_CARD, marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px' }}>
                    <button onClick={() => shiftMonth(-1)} aria-label="Previous month" style={arrow(true)}>‹</button>
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontWeight: 800, fontSize: 14, color: '#1f2937' }}>{label}</div>
                      {!atNow && <button onClick={goThisMonth}
                        style={{ background: 'none', border: 'none', padding: 0, color: C2.green, fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Back to this month</button>}
                    </div>
                    <button onClick={() => shiftMonth(1)} disabled={atNow} aria-label="Next month" style={arrow(!atNow)}>›</button>
                  </div>
                  <div style={{ display: 'flex', borderTop: '1px solid #eef0f2', backgroundColor: '#fafafa' }}>
                    {[[String(recentPmts.length), 'Payments'], [fmtAmt(total), 'Collected'], [String(people), 'Students']].map(([v, l], i) => (
                      <div key={l} style={{ flex: 1, padding: '6px 4px', textAlign: 'center', borderLeft: i ? '1px solid #eef0f2' : 'none' }}>
                        <div style={{ fontSize: 15, fontWeight: 900, color: C2.green }}>{v}</div>
                        <div style={{ fontSize: 9.5, fontWeight: 700, color: C2.muted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{l}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {recentPmts.length === 0 && !loading && (
              <div style={{ ...LIST_CARD, textAlign: 'center', padding: '28px 16px', color: C2.muted }}>
                <div style={{ fontSize: 30, marginBottom: 6 }}>📭</div>
                <div style={{ fontWeight: 700 }}>{restricted ? 'No payment records found' : 'No payments received this month yet'}</div>
              </div>
            )}
            {recentPmts.length > 0 && (
              <div style={LIST_CARD}>
                {recentPmts.map((p: any, i: number) => (
                  <div key={p.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 54,
                    padding: '8px 12px', borderTop: i ? '1px solid #eef0f2' : 'none' }}>
                    <StudentPhoto student={{name:p.student_name||'?',profile_image:p.profile_image||null}} size={36} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937',
                        overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }}>
                        {p.student_name}
                      </div>
                      <div style={{ fontSize: 11.5, color: C2.muted, marginTop: 2,
                        overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }}>
                        <span style={{ color:'#1a472a', fontWeight:700 }}>
                          {p.regno ? fmtRegNo(p.regno) : '---'}
                          {p.qca_id ? ` · Q${String(p.qca_id).padStart(3,'0')}` : ''}
                        </span>
                        {` · ${fmtPaymentMonth(p)} · ${p.payment_mode || 'Cash'}`}
                      </div>
                      {p.fee_type_name && !/^\d+$/.test(String(p.fee_type_name)) && (
                        <div style={{ fontSize: 11, color: C2.muted, marginTop: 1, overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const }}>
                          {p.fee_type_name}{p.receipt_no ? ` · 🧾 ${p.receipt_no}` : ''}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 14, color: C2.green }}>{fmtAmt(p.amount_paid || 0)}</div>
                      <div style={{ fontSize: 10, color: C2.muted, marginTop: 2 }}>{(() => {
                        const d = new Date(String(p.payment_date || '').slice(0, 10) + 'T00:00:00');
                        return isNaN(d.getTime()) ? (p.payment_date || '') : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                      })()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {/* FAB */}
    {can('payments:add') && (
      <button onClick={() => setShowAdd(true)} style={{
        position: 'fixed', bottom: `calc(24px + ${NAV_CLEARANCE})`, right: 20, zIndex: 200,
        width: 56, height: 56, borderRadius: '50%', border: 'none',
        backgroundColor: '#1a472a', color: '#fff', fontSize: 28,
        cursor: 'pointer', boxShadow: '0 4px 16px rgba(26,71,42,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>＋</button>
    )}

    {/* Add Payment Modal */}
    {showAdd && can('payments:add') && (
      <AddPaymentModal
        onClose={() => setShowAdd(false)}
        onSuccess={(receipt) => {
          setLastReceipt(receipt);
          setShowAdd(false);
          load();
        }}
      />
    )}

    {/* Receipt toast */}
    {lastReceipt && (
      <div onClick={() => setLastReceipt('')} style={{
        position: 'fixed', bottom: `calc(90px + ${NAV_CLEARANCE})`, left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: '#1a472a', color: '#fff',
        padding: '10px 20px', borderRadius: 20,
        fontSize: 13, fontWeight: 700, zIndex: 300,
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)', cursor: 'pointer',
        whiteSpace: 'nowrap' as const,
      }}>
        ✅ {lastReceipt} recorded
      </div>
    )}

    {/* Overview drill-down drawer */}
    {drillKind && (
      <OverviewDrillDrawer
        kind={drillKind}
        dueStudents={dueStudents}
        onClose={() => setDrillKind(null)}
        onSelectStudent={s => { setDrillKind(null); setDrawer(s); }}
      />
    )}

    {/* Fee drawer */}
    {drawer && (
      <StudentFeeDrawer student={drawer} onClose={() => setDrawer(null)} onChanged={load} />
    )}
    </>
  );
}
