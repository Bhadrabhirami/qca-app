/**
 * records.tsx — Attendance Records
 *
 * Design decisions:
 *  - Default: last 7 days (matches re-upload window) — NO row limit
 *  - ALL present records shown for the date range — no artificial cap
 *  - Filters: date range, student name search, session filter
 *  - Each row: student photo + name + date + session + synced badge
 *  - Summary stats: total sessions, unique students, present count
 *  - Absent inference: for a given date+session, any student NOT in
 *    attendance table is absent — shown in a separate "Absent" toggle
 *  - Aligned with QCA dark-green + gold design system
 */

import { matchesStudentSearch, formatRegno, fmtRegNo } from './studentUtils';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getDb,
  getAttendanceDates,
  getAllStudents,
  getAttendanceByDateSession,
  getSessionsForDate,
  getStudentPayments,
  getAttendanceCountForRange,
  getWriteOffsForStudents,
} from '../database/db';
import StudentPhoto from '../shared/StudentPhoto';
import ScreenHeader from '../shared/ScreenHeader';
import { usePermissions } from './usePermissions';
import { usePullToRefresh } from './usePullToRefresh';
import { syncAttendanceOnly, syncPaymentsOnly } from './useSyncService';

// ── Helpers ───────────────────────────────────────────────────────────────────
function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
}
function hdr() {
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
// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  green: '#1a472a', gold: '#d4af37', navy: '#0d1b2a',
  red: '#c0392b', orange: '#e67e22', bg: '#f0f4f1',
  card: '#fff', border: '#e5e7eb', muted: '#6b7280',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDateStr(d: Date) {
  return d.toISOString().split('T')[0];
}
function sevenDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return toDateStr(d);
}
function today() { return toDateStr(new Date()); }

function fmt(ds: string) {
  const [y, m, d] = ds.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}

function getDatesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dates.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── Stat pill ─────────────────────────────────────────────────────────────────
function StatPill({ icon, label, value, color }: {
  icon: string; label: string; value: number | string; color: string;
}) {
  return (
    <div title={`${icon} ${label}`} style={{ flex: 1, minWidth: 0, backgroundColor: C.card, borderRadius: 10,
      padding: '7px 4px 6px', textAlign: 'center' as const, boxShadow: `inset 0 -3px 0 ${color}` }}>
      <div style={{ fontWeight: 900, fontSize: 16, color, lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: 9, color: C.muted, fontWeight: 700, marginTop: 2, whiteSpace: 'nowrap' as const,
        overflow: 'hidden', textOverflow: 'ellipsis', textTransform: 'uppercase' as const, letterSpacing: '0.3px' }}>
        {label}
      </div>
    </div>
  );
}

// ── Student row ───────────────────────────────────────────────────────────────
function AttendanceRow({ student, date, session, synced, present, first }: {
  student: any; date: string; session: string; synced: number; present: boolean; first?: boolean;
}) {
  const ids = [student.regno ? fmtRegNo(student.regno) : '',
               student.qca_id ? `Q${String(student.qca_id).padStart(3,'0')}` : ''].filter(Boolean).join(' · ');
  return (
    <div title={`${fmt(date)} · ${session}`} style={{
      display: 'flex', alignItems: 'center', gap: 10, minHeight: 50,
      padding: '6px 12px',
      borderTop: first ? 'none' : '1px solid #f1f3f5',
      backgroundColor: present ? C.card : '#fafafa',
      opacity: present ? 1 : 0.75,
    }}>
      <StudentPhoto student={student} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {student.name}
        </div>
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {ids && <span style={{ color: C.green, fontWeight: 700 }}>{ids} · </span>}{session}
        </div>
      </div>
      <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: present ? C.green : C.red }}>
          {present ? '✔ Present' : '✗ Absent'}
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, marginTop: 2, color: synced ? '#166534' : '#b45309' }}>
          {synced ? '☁ synced' : '📱 local'}
        </div>
      </div>
    </div>
  );
}

// ── WhatsApp message helpers ─────────────────────────────────────────────────

function fmtDateLong(ds: string): string {
  if (!ds) return '';
  const [y, m, d] = ds.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}

function cleanPhone(raw: string): string {
  // Strip all non-digits, ensure starts with country code
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // If starts with 0, replace with 91 (India) or 971 (UAE)
  if (digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

function buildIndividualMessage(
  row: any, billingLabel: string, from: string, to: string,
  academyName: string
): string {
  const name   = row.student.name;
  const months = row.unpaidMonths?.join(', ') || billingLabel;
  const amt    = ((row.student.monthly_fee || 0) * (row.unpaidMonths?.length || 1)).toLocaleString();
  const period = `${fmtDateLong(from)} – ${fmtDateLong(to)}`;
  const attend = `${row.attendCount} session${row.attendCount !== 1 ? 's' : ''}`;

  if (row.exempt) {
    return `Dear Parent/Guardian of *${name}*,\n\n📋 *Attendance Update*\n_${academyName}_\n\n🏏 Attendance : *${attend}*\n📅 Period     : ${period}\n✅ Status     : *Club Member (No fee)*\n\nThank you for being part of our academy! 🏏\n_${academyName} Fee Management_`;
  }

  if (row.paid) {
    const rcpt = row.receiptNo ? `\n🧾 Receipt    : *${row.receiptNo}*` : '';
    const pd   = row.payDate   ? `\n📅 Paid On    : ${fmtDateLong(row.payDate)}` : '';
    return `Dear Parent/Guardian of *${name}*,\n\n📋 *Fee Receipt Confirmation*\n_${academyName}_\n\n🏏 Attendance : *${attend}*\n📅 Period     : ${period}\n✅ Fee Status : *PAID*${rcpt}${pd}\n💰 Month      : ${billingLabel}\n\nThank you for the timely payment! 🙏\n_${academyName} Fee Management_`;
  }

  return `Dear Parent/Guardian of *${name}*,\n\n📋 *Fee Payment Reminder*\n_${academyName}_\n\n🏏 Attendance : *${attend}*\n📅 Period     : ${period}\n🔴 Fee Status : *UNPAID*\n📅 Due Month  : *${months}*\n💵 Amount Due : *Rs.${amt}*\n\nKindly arrange payment at your earliest convenience.\nReply to this message for any queries.\n\n_${academyName} Fee Management_`;
}

function buildSummaryMessage(
  rows: any[], from: string, to: string,
  billingLabel: string, academyName: string
): string {
  const now = new Date().toLocaleDateString('en-GB', {
    day:'numeric', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });

  const paid   = rows.filter(r => r.paid && !r.exempt);
  const unpaid = rows.filter(r => !r.paid && !r.exempt);
  const exempt = rows.filter(r => r.exempt);
  const totalDue = unpaid.reduce((s, r) =>
    s + (r.student.monthly_fee || 0) * (r.unpaidMonths?.length || 1), 0);

  const lines: string[] = [
    `📊 *ATTENDANCE & FEE REPORT*`,
    `_${academyName}_`,
    `_${fmtDateLong(from)} – ${fmtDateLong(to)}_`,
    `_Generated: ${now}_`,
    '',
    `👥 *${rows.length} Students Attended*`,
    `💰 Billing: ${billingLabel}`,
    '',
  ];

  if (unpaid.length > 0) {
    lines.push(`🔴 *UNPAID (${unpaid.length})*`);
    unpaid.forEach(r => {
      const months = r.unpaidMonths?.join(', ') || billingLabel;
      const amt    = ((r.student.monthly_fee || 0) * (r.unpaidMonths?.length || 1)).toLocaleString();
      const ph     = cleanPhone(r.student.parent_phone || r.student.phone || '');
      lines.push(
        `• *${r.student.name}*` +
        ` — ${months}` +
        ` — Rs.${amt}` +
        ` — 🏏${r.attendCount}` +
        (ph ? ` — 📞+${ph}` : '')
      );
    });
    lines.push('');
  }

  if (paid.length > 0) {
    lines.push(`✅ *PAID (${paid.length})*`);
    paid.forEach(r => {
      lines.push(
        `• ${r.student.name}` +
        (r.receiptNo ? ` — ${r.receiptNo}` : '') +
        (r.payDate   ? ` — ${fmtDateLong(r.payDate)}` : '') +
        ` — 🏏${r.attendCount}`
      );
    });
    lines.push('');
  }

  if (exempt.length > 0) {
    lines.push(`⚪ *EXEMPT / CLUB MEMBERS (${exempt.length})*`);
    exempt.forEach(r => {
      lines.push(`• [${String(parseInt(r.student.regno||'0')||0).padStart(3,'0')}] ${r.student.name} — 🏏${r.attendCount} sessions`);
    });
    lines.push('');
  }

  if (totalDue > 0) {
    lines.push(`💰 *Total Outstanding: Rs.${totalDue.toLocaleString()}*`);
    lines.push('');
  }

  lines.push(`_${academyName} Fee Management System_`);
  return lines.join('\n');
}

function buildCompleteListMessage(
  allStudents: any[],
  attendedIds: Set<number>,
  billingLabel: string,
  from: string, to: string,
  academyName: string,
  paymentMap: Record<number, { paid: boolean; receiptNo: string; payDate: string; unpaidMonths: string[] }>
): string {
  const now    = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  const period = `${fmtDateLong(from)} – ${fmtDateLong(to)}`;

  const academy  = allStudents.filter(s =>
    s.student_type === 'Academy' && s.status === 'Active');
  const clubMbrs = allStudents.filter(s =>
    s.student_type === 'Academy' && s.status === 'Club Member');

  const paid   = academy.filter(s => paymentMap[s.id]?.paid);
  const unpaid = academy.filter(s => !paymentMap[s.id]?.paid);

  const totalDue = unpaid.reduce((sum, s) => {
    const months = paymentMap[s.id]?.unpaidMonths?.length || 1;
    return sum + (s.monthly_fee || 0) * months;
  }, 0);

  const lines: string[] = [
    `📊 *COMPLETE FEE STATUS REPORT*`,
    `_${academyName}_`,
    `_Period: ${period}_`,
    `_Generated: ${now}_`,
    `_Billing: ${billingLabel}_`,
    ``,
    `📈 *SUMMARY*`,
    `• Total Academy Students : ${academy.length}`,
    `• Attended this period   : ${attendedIds.size}`,
    `• ✅ Paid                : ${paid.length}`,
    `• 🔴 Unpaid              : ${unpaid.length}`,
    `• ⚪ Club Members        : ${clubMbrs.length}`,
    `• 💰 Total Outstanding   : Rs.${totalDue.toLocaleString()}`,
    ``,
  ];

  if (unpaid.length > 0) {
    lines.push(`🔴 *UNPAID (${unpaid.length})*`);
    unpaid.forEach((s, i) => {
      const pm     = paymentMap[s.id];
      const months = pm?.unpaidMonths?.join(', ') || billingLabel;
      const amt    = ((s.monthly_fee || 0) * (pm?.unpaidMonths?.length || 1)).toLocaleString();
      const att    = attendedIds.has(s.id) ? '✓ attended' : '✗ absent';
      lines.push(`${i+1}. [${String(parseInt(s.regno||'0')||0).padStart(3,'0')}] *${s.name}* — ${months} — Rs.${amt} — ${att}`);
    });
    lines.push('');
  }

  if (paid.length > 0) {
    lines.push(`✅ *PAID (${paid.length})*`);
    paid.forEach((s, i) => {
      const pm  = paymentMap[s.id];
      const att = attendedIds.has(s.id) ? '✓' : '✗';
      lines.push(
        `${i+1}. ${s.name}` +
        (pm?.receiptNo ? ` — ${pm.receiptNo}` : '') +
        (pm?.payDate   ? ` — ${fmtDateLong(pm.payDate)}` : '') +
        ` ${att}`
      );
    });
    lines.push('');
  }

  if (clubMbrs.length > 0) {
    lines.push(`⚪ *CLUB MEMBERS (${clubMbrs.length})*`);
    clubMbrs.forEach((s, i) => {
      const att = attendedIds.has(s.id) ? '✓ attended' : '✗ absent';
      lines.push(`${i+1}. [${String(parseInt(s.regno||'0')||0).padStart(3,'0')}] ${s.name} — ${att}`);
    });
    lines.push('');
  }

  lines.push(`_${academyName} Fee Management System_`);
  return lines.join('\n');
}

function openWA(phone: string, message: string) {
  const url = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function copyText(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  });
}


// ── Generate last N billing months list ──────────────────────────────────────
function genMonthsList(n = 24): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', '-');
  });
}

// ── Quick Pay Prompt ─────────────────────────────────────────────────────────
function QuickPayPrompt({ row, base, billingMonths, onClose, onSuccess }: {
  row:           any;
  base:          string;
  billingMonths: string[];   // all unpaid months for this student
  onClose:       () => void;
  onSuccess:     (results: any[]) => void;
}) {
  const allMonths  = genMonthsList(24);
  // Intersect unpaid months with our known list to get ordered set
  const unpaidOrdered = allMonths.filter(m => billingMonths.includes(m));

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(unpaidOrdered.slice(0, 1))  // default: current month only
  );
  const [mode,    setMode]    = useState('Cash');
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState('');
  const [results, setResults] = useState<any[]>([]);

  const monthlyFee = row.student.monthly_fee || 0;
  const total      = selected.size * monthlyFee;

  const toggle = (m: string) => {
    setSelected(prev => {
      const s = new Set(prev);
      if (s.has(m)) s.delete(m); else s.add(m);
      return s;
    });
  };

  const handlePay = async () => {
    if (selected.size === 0) { setMsg('Select at least one month'); return; }
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/payments/bulk-record`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({
          student_id:       row.student.id,
          months:           [...selected],
          amount_per_month: monthlyFee,
          mode,
          payment_date:     new Date().toISOString().split('T')[0],
          category_id:      16,  // 16 = Monthly Tuition Fee
        }),
      });
      const j = await r.json();
      if (j.status === 'success') {
        setResults(j.results || []);
        setMsg(`✅ ${j.recorded} receipt${j.recorded > 1 ? 's' : ''} created`);
        // Don't auto-close — let user read receipts then close manually
      } else {
        setMsg('⚠ ' + (j.error || 'Failed'));
      }
    } catch { setMsg('⚠ Network error'); }
    finally { setSaving(false); }
  };

  const MODES = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Online'];

  return (
    <div style={{ position:'fixed', inset:0, zIndex:5000,
      backgroundColor:'rgba(0,0,0,0.65)', display:'flex', alignItems:'flex-end' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'#f0f4f1', width:'100%',
        borderRadius:'22px 22px 0 0', maxHeight:'90vh',
        display:'flex', flexDirection:'column' as const }}>

        {/* Handle */}
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 0' }}>
          <div style={{ width:40, height:4, borderRadius:2, backgroundColor:'#d1d5db' }}/>
        </div>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between',
          alignItems:'center', padding:'12px 18px 8px', flexShrink:0 }}>
          <div>
            <div style={{ fontWeight:900, fontSize:17, color:'#0d1b2a' }}>
              ⚡ Quick Pay
            </div>
            <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>
              {row.student.name} · ₹{monthlyFee.toLocaleString('en-IN')}/mo
            </div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(0,0,0,0.07)',
            border:'none', width:30, height:30, borderRadius:'50%',
            fontSize:15, cursor:'pointer', color:'#6b7280' }}>✕</button>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'0 16px 32px' }}>

          {/* Message */}
          {msg && (
            <div style={{ padding:'10px 14px', borderRadius:10, marginBottom:10,
              backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
              color: msg.startsWith('✅') ? '#166534' : '#dc2626',
              fontWeight:700, fontSize:13 }}>
              {msg}
            </div>
          )}

          {/* Select All / Current Only quick actions */}
          <div style={{ display:'flex', gap:8, marginBottom:10 }}>
            <button onClick={() => setSelected(new Set(unpaidOrdered))}
              style={{ flex:1, padding:'7px', borderRadius:10,
                border:'1px solid #1a472a', backgroundColor:'#f0fdf4',
                color:'#1a472a', fontWeight:700, fontSize:11, cursor:'pointer' }}>
              ☑ Select All ({unpaidOrdered.length})
            </button>
            <button onClick={() => setSelected(new Set([unpaidOrdered[0]]))}
              style={{ flex:1, padding:'7px', borderRadius:10,
                border:'1px solid #e5e7eb', backgroundColor:'#fff',
                color:'#6b7280', fontWeight:700, fontSize:11, cursor:'pointer' }}>
              Current Only
            </button>
            <button onClick={() => setSelected(new Set())}
              style={{ padding:'7px 10px', borderRadius:10,
                border:'1px solid #e5e7eb', backgroundColor:'#fff',
                color:'#6b7280', fontWeight:700, fontSize:11, cursor:'pointer' }}>
              Clear
            </button>
          </div>

          {/* Month checkboxes */}
          <div style={{ backgroundColor:'#fff', borderRadius:14,
            border:'1px solid #e5e7eb', marginBottom:14, overflow:'hidden' }}>
            {unpaidOrdered.length === 0 ? (
              <div style={{ padding:'16px', textAlign:'center' as const,
                color:'#6b7280', fontSize:13 }}>No unpaid months</div>
            ) : unpaidOrdered.map((m, i) => (
              <div key={m} onClick={() => toggle(m)}
                style={{ display:'flex', alignItems:'center', gap:12,
                  padding:'11px 14px', cursor:'pointer',
                  borderBottom: i < unpaidOrdered.length - 1 ? '1px solid #f3f4f6' : 'none',
                  backgroundColor: selected.has(m) ? '#f0fdf4' : '#fff' }}>
                <div style={{ width:20, height:20, borderRadius:6,
                  border: `2px solid ${selected.has(m) ? '#1a472a' : '#d1d5db'}`,
                  backgroundColor: selected.has(m) ? '#1a472a' : '#fff',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  flexShrink:0 }}>
                  {selected.has(m) && <span style={{ color:'#fff', fontSize:12, fontWeight:900 }}>✓</span>}
                </div>
                <span style={{ flex:1, fontWeight:600, fontSize:14,
                  color: selected.has(m) ? '#1a472a' : '#111' }}>{m}</span>
                <span style={{ fontSize:13, color:'#6b7280', fontWeight:500 }}>
                  ₹{monthlyFee.toLocaleString('en-IN')}
                </span>
                {i === 0 && (
                  <span style={{ fontSize:10, backgroundColor:'#dbeafe',
                    color:'#1d4ed8', padding:'2px 8px', borderRadius:10,
                    fontWeight:700 }}>Current</span>
                )}
              </div>
            ))}
          </div>

          {/* Running total */}
          <div style={{ display:'flex', justifyContent:'space-between',
            alignItems:'center', padding:'10px 14px',
            backgroundColor:'#0d1b2a', borderRadius:12, marginBottom:14 }}>
            <span style={{ color:'rgba(255,255,255,0.7)', fontSize:13 }}>
              {selected.size} month{selected.size !== 1 ? 's' : ''} selected
            </span>
            <span style={{ color:'#c5a059', fontWeight:900, fontSize:18 }}>
              ₹{total.toLocaleString('en-IN')}
            </span>
          </div>

          {/* Payment mode */}
          <div style={{ fontSize:11, fontWeight:800, color:'#374151',
            textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:8 }}>
            Payment Mode
          </div>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' as const, marginBottom:14 }}>
            {MODES.map(m => (
              <button key={m} onClick={() => setMode(m)}
                style={{ padding:'7px 14px', borderRadius:20, border:'none',
                  cursor:'pointer', fontSize:12, fontWeight:700,
                  backgroundColor: mode === m ? '#1a472a' : '#f3f4f6',
                  color: mode === m ? '#fff' : '#6b7280',
                  boxShadow: mode === m ? '0 2px 6px rgba(26,71,42,0.3)' : 'none' }}>
                {m}
              </button>
            ))}
          </div>

          {/* Date */}
          <div style={{ fontSize:12, color:'#6b7280', marginBottom:14,
            padding:'8px 12px', backgroundColor:'#f9fafb',
            borderRadius:10, border:'1px solid #e5e7eb' }}>
            📅 Payment Date: <strong>{new Date().toLocaleDateString('en-GB', {
              day:'numeric', month:'short', year:'numeric'
            })}</strong> (today)
          </div>

          {/* Confirm button */}
          {/* Receipt list after success */}
          {results.length > 0 && (
            <div style={{ backgroundColor:'#f0fdf4', borderRadius:12,
              border:'1px solid #86efac', padding:'12px 14px', marginBottom:14 }}>
              <div style={{ fontWeight:800, fontSize:13, color:'#166534', marginBottom:8 }}>
                🧾 Receipts Created
              </div>
              {results.filter(r => r.status === 'recorded').map((r: any) => (
                <div key={r.month} style={{ display:'flex', justifyContent:'space-between',
                  fontSize:12, marginBottom:4 }}>
                  <span style={{ color:'#166534', fontWeight:600 }}>{r.month}</span>
                  <span style={{ color:'#1a472a', fontWeight:800 }}>{r.receipt_no}</span>
                </div>
              ))}
              {results.filter(r => r.status === 'duplicate').map((r: any) => (
                <div key={r.month} style={{ display:'flex', justifyContent:'space-between',
                  fontSize:11, color:'#6b7280', marginBottom:4 }}>
                  <span>{r.month}</span>
                  <span>Already paid · {r.receipt_no}</span>
                </div>
              ))}
              <button onClick={() => onSuccess(results)}
                style={{ width:'100%', marginTop:10, padding:'10px',
                  borderRadius:10, border:'none', backgroundColor:'#166534',
                  color:'#fff', fontWeight:800, fontSize:13, cursor:'pointer' }}>
                ✓ Done
              </button>
            </div>
          )}

          {results.length === 0 && (
            <button onClick={handlePay} disabled={saving || selected.size === 0}
              style={{ width:'100%', padding:'16px', borderRadius:14, border:'none',
                backgroundColor: saving || selected.size === 0 ? '#9ca3af' : '#1a472a',
                color:'#fff', fontWeight:900, fontSize:15,
                cursor: saving || selected.size === 0 ? 'not-allowed' : 'pointer',
                boxShadow: selected.size > 0 && !saving ? '0 4px 14px rgba(26,71,42,0.4)' : 'none' }}>
              {saving ? '⏳ Recording…'
                : selected.size === 0 ? 'Select months to pay'
                : `✅ Pay Rs.${total.toLocaleString()} (${selected.size} month${selected.size !== 1 ? 's' : ''})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Write-off Prompt ─────────────────────────────────────────────────────────
function WriteOffPrompt({ row, base, billingMonths, writtenOffMonths, onClose, onSuccess }: {
  row:              any;
  base:             string;
  billingMonths:    string[];   // unpaid months
  writtenOffMonths: string[];   // already written off
  onClose:          () => void;
  onSuccess:        () => void;
}) {
  const allMonths     = genMonthsList(24);
  const unpaidOrdered = allMonths.filter(m => billingMonths.includes(m));
  const waivedSet     = new Set(writtenOffMonths);

  const [selected,  setSelected]  = useState<Set<string>>(new Set());  // none pre-ticked
  const [reason,    setReason]    = useState('Financial Hardship');
  const [remarks,   setRemarks]   = useState('');
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState('');
  const [woResults, setWoResults] = useState<any[]>([]);

  const monthlyFee = row.student.monthly_fee || 0;
  const total      = selected.size * monthlyFee;

  const toggle = (m: string) => {
    setSelected(prev => {
      const s = new Set(prev);
      if (s.has(m)) s.delete(m); else s.add(m);
      return s;
    });
  };

  const REASONS = [
    'Financial Hardship',
    'Long Absence',
    'Management Decision',
    'Scholarship / Sponsored',
    'Other',
  ];

  const handleWriteOff = async () => {
    if (selected.size === 0) { setMsg('Select at least one month'); return; }
    if (reason === 'Other' && !remarks.trim()) {
      setMsg('Remarks are required when reason is Other'); return;
    }
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/write-offs/bulk-create`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({
          student_id:       row.student.id,
          months:           [...selected],
          amount_per_month: monthlyFee,
          reason,
          remarks,
        }),
      });
      const j = await r.json();
      if (j.status === 'success') {
        setWoResults(j.results || []);
        setMsg(`✅ ${j.written_off} month${j.written_off !== 1 ? 's' : ''} written off`);
        // Stay open so user can see confirmation
      } else {
        setMsg('⚠ ' + (j.error || 'Failed'));
      }
    } catch { setMsg('⚠ Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:5000,
      backgroundColor:'rgba(0,0,0,0.65)', display:'flex', alignItems:'flex-end' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'#f0f4f1', width:'100%',
        borderRadius:'22px 22px 0 0', maxHeight:'90vh',
        display:'flex', flexDirection:'column' as const }}>

        {/* Handle */}
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 0' }}>
          <div style={{ width:40, height:4, borderRadius:2, backgroundColor:'#d1d5db' }}/>
        </div>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between',
          alignItems:'center', padding:'12px 18px 8px', flexShrink:0 }}>
          <div>
            <div style={{ fontWeight:900, fontSize:17, color:'#0d1b2a' }}>
              ✏️ Write-off Fees
            </div>
            <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>
              {row.student.name} · Admin only
            </div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(0,0,0,0.07)',
            border:'none', width:30, height:30, borderRadius:'50%',
            fontSize:15, cursor:'pointer', color:'#6b7280' }}>✕</button>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'0 16px 32px' }}>

          {msg && (
            <div style={{ padding:'10px 14px', borderRadius:10, marginBottom:10,
              backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
              color: msg.startsWith('✅') ? '#166534' : '#dc2626',
              fontWeight:700, fontSize:13 }}>
              {msg}
            </div>
          )}

          {/* Warning */}
          <div style={{ padding:'10px 14px', borderRadius:10, marginBottom:14,
            backgroundColor:'#fffbeb', border:'1px solid #fcd34d',
            fontSize:12, color:'#92400e', fontWeight:600 }}>
            ⚠ Write-offs are reversible but require admin approval.
            No payment receipt is created — month is marked as waived.
          </div>

          {/* Select All */}
          <div style={{ display:'flex', gap:8, marginBottom:10 }}>
            <button onClick={() => setSelected(new Set(unpaidOrdered))}
              style={{ flex:1, padding:'7px', borderRadius:10,
                border:'1px solid #dc2626', backgroundColor:'#fee2e2',
                color:'#dc2626', fontWeight:700, fontSize:11, cursor:'pointer' }}>
              ☑ Select All Remaining ({unpaidOrdered.length})
            </button>
            <button onClick={() => setSelected(new Set())}
              style={{ padding:'7px 10px', borderRadius:10,
                border:'1px solid #e5e7eb', backgroundColor:'#fff',
                color:'#6b7280', fontWeight:700, fontSize:11, cursor:'pointer' }}>
              Clear
            </button>
          </div>

          {/* Month checkboxes */}
          <div style={{ backgroundColor:'#fff', borderRadius:14,
            border:'1px solid #e5e7eb', marginBottom:14, overflow:'hidden' }}>
            {unpaidOrdered.length === 0 ? (
              <div style={{ padding:'16px', textAlign:'center' as const,
                color:'#6b7280', fontSize:13 }}>No unpaid months to write off</div>
            ) : unpaidOrdered.map((m, i) => {
              const alreadyWaived = waivedSet.has(m);
              return (
                <div key={m}
                  onClick={() => !alreadyWaived && toggle(m)}
                  style={{ display:'flex', alignItems:'center', gap:12,
                    padding:'11px 14px', cursor: alreadyWaived ? 'default' : 'pointer',
                    borderBottom: i < unpaidOrdered.length - 1 ? '1px solid #f3f4f6' : 'none',
                    backgroundColor: alreadyWaived ? '#f9fafb' : selected.has(m) ? '#fee2e2' : '#fff',
                    opacity: alreadyWaived ? 0.6 : 1 }}>
                  <div style={{ width:20, height:20, borderRadius:6,
                    border: `2px solid ${alreadyWaived ? '#d1d5db' : selected.has(m) ? '#dc2626' : '#d1d5db'}`,
                    backgroundColor: alreadyWaived ? '#f3f4f6' : selected.has(m) ? '#dc2626' : '#fff',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    flexShrink:0 }}>
                    {selected.has(m) && !alreadyWaived && (
                      <span style={{ color:'#fff', fontSize:12, fontWeight:900 }}>✓</span>
                    )}
                    {alreadyWaived && <span style={{ fontSize:10 }}>⚫</span>}
                  </div>
                  <span style={{ flex:1, fontWeight:600, fontSize:14,
                    color: alreadyWaived ? '#6b7280' : selected.has(m) ? '#dc2626' : '#111' }}>
                    {m}
                  </span>
                  <span style={{ fontSize:13, color:'#6b7280' }}>
                    ₹{monthlyFee.toLocaleString('en-IN')}
                  </span>
                  {alreadyWaived && (
                    <span style={{ fontSize:10, backgroundColor:'#f3f4f6',
                      color:'#6b7280', padding:'2px 8px', borderRadius:10,
                      fontWeight:700 }}>Waived</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Total */}
          {selected.size > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between',
              alignItems:'center', padding:'10px 14px',
              backgroundColor:'#dc2626', borderRadius:12, marginBottom:14 }}>
              <span style={{ color:'rgba(255,255,255,0.8)', fontSize:13 }}>
                Writing off {selected.size} month{selected.size !== 1 ? 's' : ''}
              </span>
              <span style={{ color:'#fff', fontWeight:900, fontSize:18 }}>
                ₹{total.toLocaleString('en-IN')}
              </span>
            </div>
          )}

          {/* Reason */}
          <div style={{ fontSize:11, fontWeight:800, color:'#374151',
            textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:8 }}>
            Reason *
          </div>
          <div style={{ display:'flex', flexDirection:'column' as const,
            gap:6, marginBottom:14 }}>
            {REASONS.map(r => (
              <button key={r} onClick={() => setReason(r)}
                style={{ padding:'10px 14px', borderRadius:10,
                  cursor:'pointer', fontSize:13, fontWeight:600,
                  textAlign:'left' as const,
                  backgroundColor: reason === r ? '#0d1b2a' : '#fff',
                  color: reason === r ? '#c5a059' : '#374151',
                  border: `1.5px solid ${reason === r ? '#0d1b2a' : '#e5e7eb'}` as any }}>
                {reason === r ? '● ' : '○ '}{r}
              </button>
            ))}
          </div>

          {/* Remarks */}
          <div style={{ fontSize:11, fontWeight:800, color:'#374151',
            textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:6 }}>
            Remarks {reason === 'Other' ? '* (required)' : '(optional)'}
          </div>
          <textarea value={remarks} onChange={e => setRemarks(e.target.value)}
            placeholder="Add notes about this write-off decision…"
            maxLength={500}
            rows={3}
            style={{ width:'100%', padding:'10px 12px', borderRadius:10,
              border:`1.5px solid ${reason === 'Other' && !remarks ? '#dc2626' : '#e5e7eb'}`,
              fontSize:13, outline:'none', fontFamily:'inherit',
              boxSizing:'border-box' as const, resize:'none' as const,
              marginBottom:14 }}/>

          {/* Confirm or Done */}
          {woResults.length > 0 ? (
            <div style={{ backgroundColor:'#f3f4f6', borderRadius:12,
              border:'1px solid #d1d5db', padding:'12px 14px' }}>
              <div style={{ fontWeight:800, fontSize:13, color:'#374151', marginBottom:8 }}>
                ⚫ Written Off
              </div>
              {woResults.filter((r:any) => r.status === 'written_off').map((r:any) => (
                <div key={r.month} style={{ fontSize:12, color:'#374151',
                  fontWeight:600, marginBottom:4 }}>⚫ {r.month} — WO-{r.id}</div>
              ))}
              {woResults.filter((r:any) => r.status === 'already_written_off').map((r:any) => (
                <div key={r.month} style={{ fontSize:11, color:'#6b7280', marginBottom:4 }}>
                  {r.month} — already written off</div>
              ))}
              <button onClick={() => onSuccess()}
                style={{ width:'100%', marginTop:10, padding:'10px', borderRadius:10,
                  border:'none', backgroundColor:'#374151', color:'#fff',
                  fontWeight:800, fontSize:13, cursor:'pointer' }}>
                ✓ Done
              </button>
            </div>
          ) : (
            <button onClick={handleWriteOff}
              disabled={saving || selected.size === 0}
              style={{ width:'100%', padding:'16px', borderRadius:14, border:'none',
                backgroundColor: saving || selected.size === 0 ? '#9ca3af' : '#dc2626',
                color:'#fff', fontWeight:900, fontSize:15,
                cursor: saving || selected.size === 0 ? 'not-allowed' : 'pointer',
                boxShadow: selected.size > 0 && !saving ? '0 4px 14px rgba(220,38,38,0.4)' : 'none' }}>
              {saving ? '⏳ Processing…'
                : selected.size === 0 ? 'Select months to write off'
                : `✏️ Write-off Rs.${total.toLocaleString()} (${selected.size} month${selected.size !== 1 ? 's' : ''})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Reverse Write-off Prompt ─────────────────────────────────────────────────
function ReverseWriteOffPrompt({ woId, month, studentName, base, onClose, onSuccess }: {
  woId:        number;
  month:       string;
  studentName: string;
  base:        string;
  onClose:     () => void;
  onSuccess:   () => void;
}) {
  const [reason,   setReason]   = useState('');
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState('');
  const [reversed, setReversed] = useState(false);

  const handleReverse = async () => {
    if (!reason.trim()) { setMsg('Reason is required'); return; }
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/write-offs/${woId}/reverse`, {
        method: 'PATCH', headers: hdr(),
        body: JSON.stringify({ reversal_reason: reason }),
      });
      const j = await r.json();
      if (j.status === 'success') {
        setMsg(`✅ ${j.message}`);
        setReversed(true);
        // Don't auto-close — let user read confirmation
      } else {
        setMsg('⚠ ' + (j.error || 'Failed'));
      }
    } catch { setMsg('⚠ Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:6000,
      backgroundColor:'rgba(0,0,0,0.7)', display:'flex',
      alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'#fff', borderRadius:20, padding:'24px',
        width:'100%', maxWidth:380 }}>
        <div style={{ fontWeight:900, fontSize:16, color:'#0d1b2a', marginBottom:6 }}>
          ↩ Reverse Write-off
        </div>
        <div style={{ fontSize:13, color:'#6b7280', marginBottom:16 }}>
          {studentName} · {month}
        </div>
        <div style={{ padding:'10px 14px', borderRadius:10, marginBottom:16,
          backgroundColor:'#fef3c7', border:'1px solid #fcd34d',
          fontSize:12, color:'#92400e' }}>
          This will mark <strong>{month}</strong> as Unpaid again.
          Full audit trail is preserved.
        </div>
        {msg && (
          <div style={{ padding:'10px', borderRadius:10, marginBottom:12,
            backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
            color: msg.startsWith('✅') ? '#166534' : '#dc2626',
            fontWeight:700, fontSize:13 }}>{msg}</div>
        )}
        <div style={{ fontSize:11, fontWeight:800, color:'#374151',
          textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:6 }}>
          Reason for reversal *
        </div>
        <input value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Student paid back / Entered by mistake"
          maxLength={200}
          style={{ width:'100%', padding:'10px 12px', borderRadius:10,
            border:`1.5px solid ${!reason ? '#fca5a5' : '#e5e7eb'}`,
            fontSize:13, outline:'none', boxSizing:'border-box' as const,
            marginBottom:16 }}/>
        {reversed ? (
          <button onClick={onSuccess}
            style={{ width:'100%', padding:'12px', borderRadius:10, border:'none',
              backgroundColor:'#0d1b2a', color:'#c5a059',
              fontWeight:800, cursor:'pointer' }}>
            ✓ Done
          </button>
        ) : (
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={onClose}
              style={{ flex:1, padding:'12px', borderRadius:10,
                border:'1px solid #e5e7eb', backgroundColor:'#fff',
                color:'#6b7280', fontWeight:700, cursor:'pointer' }}>
              Cancel
            </button>
            <button onClick={handleReverse} disabled={saving || !reason.trim()}
              style={{ flex:2, padding:'12px', borderRadius:10, border:'none',
                backgroundColor: saving || !reason.trim() ? '#9ca3af' : '#0d1b2a',
                color: saving || !reason.trim() ? '#fff' : '#c5a059',
                fontWeight:800, cursor: saving || !reason.trim() ? 'not-allowed' : 'pointer' }}>
              {saving ? '⏳…' : '↩ Confirm Reversal'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Attendee Payment Status Sheet ────────────────────────────────────────────
function AttendeePaymentSheet({
  studentIds, studentMap, allStudents, from, to, onClose,
}: {
  studentIds:  number[];
  studentMap:  Record<number, any>;
  allStudents: any[];
  from: string; to: string;
  onClose: () => void;
}) {
  const base = bld(localStorage.getItem('server_ip') || '');

  type PayRow = {
    student:      any;
    paid:         boolean;
    exempt:       boolean;
    unpaidMonths: string[];
    waivedMonths: string[];  // months with active write-offs
    waivedIds:    Record<string,number>; // billing_month → write-off id
    lastPaid:     string;
    receiptNo:    string;
    payDate:      string;
    attendCount:  number;
  };

  const [rows,      setRows]      = useState<PayRow[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState<'all'|'paid'|'unpaid'|'exempt'|'waived'>('all');
  const [search,    setSearch]    = useState('');
  const [copied,       setCopied]       = useState(false);
  const [shareRow,     setShareRow]     = useState<PayRow|null>(null);
  const [quickPayRow,  setQuickPayRow]  = useState<PayRow|null>(null);
  const [writeOffRow,  setWriteOffRow]  = useState<PayRow|null>(null);
  const [reverseWO,    setReverseWO]    = useState<{id:number;month:string}|null>(null);
  const academyName = localStorage.getItem('academy_name') || 'Quickies Cricket Club';
  const { can } = usePermissions();
  const canWriteOff        = can('payments:writeoff' as any);
  const canReverseWriteOff = can('payments:writeoff:reverse' as any);

  // Build all billing months covered by the selected date range
  // e.g. from=2026-05-15 to=2026-06-06 → ['May-26', 'Jun-26']
  const billingMonths: string[] = useMemo(() => {
    const months: string[] = [];
    const start = new Date(from + 'T00:00:00');
    const end   = new Date(to   + 'T00:00:00');
    const cur   = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      months.push(
        cur.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', '-')
      );
      cur.setMonth(cur.getMonth() + 1);
    }
    return months;
  }, [from, to]);

  const billingLabel = billingMonths.length === 1
    ? billingMonths[0]
    : `${billingMonths[0]} – ${billingMonths[billingMonths.length - 1]}`;

  // Parallel (year, month) tuples for billingMonths -- same order/length,
  // built from the same loop -- so per-student enrollment filtering can
  // compare months numerically instead of re-parsing the "Jan-26" style
  // labels back into dates.
  const billingMonthsYM: { year: number; month: number }[] = useMemo(() => {
    const out: { year: number; month: number }[] = [];
    const start = new Date(from + 'T00:00:00');
    const end   = new Date(to   + 'T00:00:00');
    const cur   = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      out.push({ year: cur.getFullYear(), month: cur.getMonth() + 1 });
      cur.setMonth(cur.getMonth() + 1);
    }
    return out;
  }, [from, to]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const result: PayRow[] = [];

      // Read write-offs from LOCAL DB (synced down by useSyncService)
      // Server is source of truth — local is read-only mirror
      let writeOffMap: Record<string, any[]> = {};
      try {
        const woRows = await getWriteOffsForStudents(studentIds);
        if (woRows.length > 0) {
          woRows.forEach(w => {
            const sid = String(w.student_id);
            if (!writeOffMap[sid]) writeOffMap[sid] = [];
            writeOffMap[sid].push(w);
          });
        } else {
          // Local empty — pull from server once (until next background sync)
          const woRes = await fetch(`${base}/api/data/write-offs/bulk-months`, {
            method: 'POST', headers: hdr(),
            body: JSON.stringify({ student_ids: studentIds }),
          });
          if (woRes.ok) {
            const woJ = await woRes.json();
            writeOffMap = woJ.data || {};
          }
        }
      } catch {
        // Silent — write-offs won't show until sync runs
      }

      for (const sid of studentIds) {
        const stu = studentMap[sid];
        if (!stu) continue;

        // Restrict the billing-month window to months this student was
        // actually enrolled for (enrollment + 2 months = first billable
        // month -- enrollment month and the following month are
        // free/grace, same rule used everywhere else in the app).
        // Without this, a student who joined partway through the
        // selected date range incorrectly shows as "unpaid" for months
        // before they had even enrolled.
        let eligibleMonths = billingMonths;
        if (stu.enrollment_date) {
          try {
            const ed = new Date(stu.enrollment_date + 'T00:00:00');
            let fbY = ed.getFullYear();
            let fbM = ed.getMonth() + 1 + 2; // +1 for 0-indexed month, +2 for grace
            if (fbM > 12) { fbM -= 12; fbY += 1; }
            eligibleMonths = billingMonths.filter((_, i) => {
              const ym = billingMonthsYM[i];
              return ym && (ym.year > fbY || (ym.year === fbY && ym.month >= fbM));
            });
          } catch {}
        }

        try {
          const pmts = await getStudentPayments(sid);
          // Exempt: Academy student with Club Member status — attends but no fee charged
          const isExempt = (stu.student_type || '').trim() === 'Academy' &&
                           (stu.status        || '').trim() === 'Club Member';

          // Attendance count for this range (both exempt and regular)
          const attendCount = await getAttendanceCountForRange(sid, from, to);

          // Write-offs loaded in bulk before loop — use pre-fetched map
          const waivedData = writeOffMap[String(sid)] || [];
          const waivedMonths: string[] = waivedData.map((w: any) => w.billing_month);
          const waivedIds: Record<string,number> = {};
          waivedData.forEach((w: any) => { waivedIds[w.billing_month] = w.id; });

          if (isExempt) {
            result.push({ student: stu, paid: false, exempt: true,
                          unpaidMonths: [], waivedMonths: [], waivedIds: {},
                          lastPaid: '', receiptNo: '', payDate: '', attendCount });
            continue;
          }

          // Check if ALL months in range are paid (strict) or ANY (lenient)
          // We use: paid = every billing month in range has a payment
          const paidMonths = new Set(
            pmts
              .filter((p: any) => [1, 2, 15, 16].includes(Number(p.fee_type_id)))
              .map((p: any) => (p.billing_month || '').trim())
          );
          const thisMonthPaid = eligibleMonths.every(
            m => paidMonths.has(m)
          );
          // Which months are unpaid
          const unpaidMonths = eligibleMonths.filter(m => !paidMonths.has(m));
          const lastPmt = pmts
            .filter((p: any) => [1, 2, 15, 16].includes(Number(p.fee_type_id)))
            .sort((a: any, b: any) =>
              (b.payment_date || b.billing_month || '').localeCompare(
               a.payment_date || a.billing_month || '')
            )[0];
          // Get the most recent payment for billing months in range
          const rangePmt = pmts
            .filter((p: any) =>
              [1, 2, 15, 16].includes(Number(p.fee_type_id)) &&
              eligibleMonths.includes((p.billing_month || '').trim())
            )
            .sort((a: any, b: any) =>
              (b.payment_date || '').localeCompare(a.payment_date || '')
            )[0];

          // Exclude waived months from unpaid list
          const trueUnpaid = unpaidMonths.filter(m => !waivedIds[m]);

          result.push({
            student:      stu,
            paid:         thisMonthPaid,
            exempt:       false,
            unpaidMonths: trueUnpaid,
            waivedMonths,
            waivedIds,
            lastPaid:     lastPmt?.billing_month || lastPmt?.payment_date || '',
            receiptNo:    rangePmt?.receipt_no   || '',
            payDate:      rangePmt?.payment_date || '',
            attendCount,
          });
        } catch {
          const attendCount2 = await getAttendanceCountForRange(sid, from, to).catch(() => 0);
          result.push({ student: stu, paid: false, exempt: false,
            unpaidMonths: eligibleMonths, waivedMonths: [], waivedIds: {},
            lastPaid: '', receiptNo: '', payDate: '', attendCount: attendCount2 });
        }
      }
      result.sort((a, b) => {
        // Order: Unpaid → Paid → Exempt
        const rank = (r: PayRow) => r.exempt ? 2 : r.paid ? 1 : 0;
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        const an = a.student.regno ? parseInt(a.student.regno) : null;
        const bn = b.student.regno ? parseInt(b.student.regno) : null;
        if (an === null && bn === null) return a.student.id - b.student.id;
        if (an === null) return 1;
        if (bn === null) return -1;
        return an - bn;
      });
      setRows(result);
      setLoading(false);
    })();
  }, [studentIds.join(','), billingMonths.join(',')]);

  const paidCount   = rows.filter(r =>  r.paid && !r.exempt).length;
  const unpaidCount = rows.filter(r => !r.paid && !r.exempt && r.unpaidMonths.length > 0).length;
  const waivedCount = rows.filter(r => !r.exempt && r.waivedMonths.length > 0).length;
  const exemptCount = rows.filter(r =>  r.exempt).length;

  const visible = rows.filter(r => {
    if (filter === 'paid'   && (!r.paid || r.exempt))                        return false;
    if (filter === 'unpaid' && (r.paid  || r.exempt || !r.unpaidMonths.length)) return false;
    if (filter === 'exempt' && !r.exempt)                                    return false;
    if (filter === 'waived' && (!r.waivedMonths.length || r.exempt))         return false;
    if (search && !matchesStudentSearch(r.student, search)) return false;
    return true;
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000,
      backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex',
      alignItems: 'flex-end' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>

      <div style={{ backgroundColor: '#f0f4f1', width: '100%',
        borderRadius: '22px 22px 0 0', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column' as const }}>

        {/* Handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 0' }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: '#d1d5db' }} />
        </div>

        {/* Header */}
        <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 17, color: '#0d1b2a' }}>
                👥 Attendance → Payments
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                {from} → {to}<br/>
                <span>Checking: <strong style={{ color: '#0d1b2a' }}>{billingLabel}</strong></span>
              </div>
            </div>
            <button onClick={onClose}
              style={{ background: 'rgba(0,0,0,0.07)', border: 'none',
                width: 30, height: 30, borderRadius: '50%',
                fontSize: 15, cursor: 'pointer', color: '#6b7280' }}>✕</button>
          </div>

          {/* Filter pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {([
              { key: 'all',    label: `All ${rows.length}`,           bg: '#0d1b2a', fg: '#c5a059' },
              { key: 'unpaid', label: `🔴 Unpaid ${unpaidCount}`,     bg: '#fee2e2', fg: '#dc2626' },
              { key: 'paid',   label: `✅ Paid ${paidCount}`,         bg: '#dcfce7', fg: '#166534' },
              { key: 'waived', label: `⚫ Waived ${waivedCount}`,     bg: '#f3f4f6', fg: '#374151' },
              { key: 'exempt', label: `⚪ Exempt ${exemptCount}`,     bg: '#f3f4f6', fg: '#6b7280' },
            ] as const).map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                style={{ flex: 1, padding: '8px 4px', borderRadius: 10, border: 'none',
                  cursor: 'pointer', fontWeight: 800, fontSize: 11,
                  backgroundColor: filter === f.key ? f.bg : '#fff',
                  color:           filter === f.key ? f.fg : '#6b7280',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                {f.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%',
              transform: 'translateY(-50%)', fontSize: 13, color: '#6b7280' }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search student…"
              style={{ width: '100%', padding: '8px 12px 8px 30px', borderRadius: 10,
                border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none',
                boxSizing: 'border-box' as const, backgroundColor: '#fff' }} />
            {search && (
              <button onClick={() => setSearch('')}
                style={{ position: 'absolute', right: 10, top: '50%',
                  transform: 'translateY(-50%)', background: 'none',
                  border: 'none', cursor: 'pointer', fontSize: 15, color: '#6b7280' }}>✕</button>
            )}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between',
            alignItems:'center', marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>
              Showing {visible.length} of {rows.length} students
            </div>
            <div style={{ display:'flex', gap:6 }}>
              {/* Share attended summary — attendance:share permission required */}
              {can('attendance:share' as any) && (
              <button onClick={() => {
                  const msg = buildSummaryMessage(rows, from, to, billingLabel, academyName);
                  openWA('', msg);
                }}
                title="Share attended students summary to WhatsApp"
                style={{ padding:'5px 10px', borderRadius:20, border:'none',
                  backgroundColor:'#25d366', color:'#fff',
                  fontWeight:700, fontSize:10, cursor:'pointer' }}>
                📤 Attended
              </button>
              )}
              {/* Share COMPLETE list — attendance:share permission required */}
              {can('attendance:share' as any) && (
              <button onClick={() => {
                  // Build payment map from rows (attended students)
                  const payMap: Record<number, any> = {};
                  rows.forEach(r => {
                    payMap[r.student.id] = {
                      paid: r.paid, receiptNo: r.receiptNo,
                      payDate: r.payDate, unpaidMonths: r.unpaidMonths,
                    };
                  });
                  const attendedSet = new Set(rows.map(r => r.student.id));
                  const msg = buildCompleteListMessage(
                    allStudents, attendedSet, billingLabel, from, to,
                    academyName, payMap
                  );
                  openWA('', msg);
                }}
                title="Share complete student list (all active students) to WhatsApp"
                style={{ padding:'5px 10px', borderRadius:20, border:'none',
                  backgroundColor:'#0d1b2a', color:'#c5a059',
                  fontWeight:700, fontSize:10, cursor:'pointer' }}>
                📋 All Students
              </button>
              )}
              {/* Copy complete list */}
              <button onClick={() => {
                  const payMap: Record<number, any> = {};
                  rows.forEach(r => {
                    payMap[r.student.id] = {
                      paid: r.paid, receiptNo: r.receiptNo,
                      payDate: r.payDate, unpaidMonths: r.unpaidMonths,
                    };
                  });
                  const attendedSet = new Set(rows.map(r => r.student.id));
                  const msg = buildCompleteListMessage(
                    allStudents, attendedSet, billingLabel, from, to,
                    academyName, payMap
                  );
                  copyText(msg);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                style={{ padding:'5px 10px', borderRadius:20, border:'none',
                  backgroundColor: copied ? '#166534' : '#f3f4f6',
                  color: copied ? '#fff' : '#6b7280',
                  fontWeight:700, fontSize:10, cursor:'pointer' }}>
                {copied ? '✅ Copied!' : '📋 Copy'}
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 16px 32px' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: '#6b7280' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
              <div style={{ fontSize: 13 }}>Checking payment records…</div>
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div style={{ textAlign: 'center', padding: '24px 0', color: '#6b7280' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🎉</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {filter === 'unpaid' ? '🎉 All students paid!' :
                 filter === 'exempt' ? 'No exempt students in this range' :
                 filter === 'waived' ? 'No written-off months in this range' :
                 'No students match'}
              </div>
            </div>
          )}
          {!loading && visible.map(row => (
            <div key={row.student.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12,
                backgroundColor: '#fff', borderRadius: 14, padding: '11px 14px',
                marginBottom: 8,
                border: `1.5px solid ${row.paid ? '#86efac' : '#fca5a5'}`,
                boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
              <StudentPhoto student={row.student} size={42} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#111',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const }}>
                  {row.student.name}
                </div>
                {/* Attendance count badge */}
                <div style={{ fontSize: 10, color: '#0369a1', fontWeight: 700,
                  backgroundColor: '#eff6ff', padding: '2px 8px', borderRadius: 10,
                  display: 'inline-block', marginTop: 3 }}>
                  🏏 {row.attendCount} session{row.attendCount !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                  {row.exempt
                    ? 'Club Member · No fee applicable'
                    : row.paid
                      ? <>
                          <span style={{ color: '#166534', fontWeight: 700 }}>
                            ✓ Paid {row.payDate}
                          </span>
                          {row.receiptNo && (
                            <span style={{ color: '#6b7280' }}> · {row.receiptNo}</span>
                          )}
                        </>
                      : <>
                          {row.unpaidMonths.length > 0 && (
                            <span style={{ color: '#dc2626' }}>
                              🔴 {row.unpaidMonths.join(', ')} · ₹{((row.student.monthly_fee||0)*row.unpaidMonths.length).toLocaleString('en-IN')}
                            </span>
                          )}
                          {row.waivedMonths.length > 0 && (
                            <span style={{ color: '#6b7280' }}>
                              {row.unpaidMonths.length > 0 ? ' · ' : ''}⚫ Waived: {row.waivedMonths.join(', ')}
                            </span>
                          )}
                        </>
                  }
                </div>
              </div>
              <div style={{ display:'flex', flexDirection:'column' as const,
                alignItems:'flex-end', gap:5, flexShrink:0 }}>
                {/* Status badge */}
                <div style={{ padding: '4px 10px', borderRadius: 20,
                  fontWeight: 800, fontSize: 10,
                  backgroundColor: row.exempt ? '#f3f4f6' : row.paid ? '#dcfce7' :
                    row.waivedMonths.length > 0 ? '#f3f4f6' : '#fee2e2',
                  color: row.exempt ? '#6b7280' : row.paid ? '#166534' :
                    row.waivedMonths.length > 0 ? '#374151' : '#dc2626' }}>
                  {row.exempt ? '⚪ Exempt'
                    : row.paid ? '✅ Paid'
                    : row.waivedMonths.length > 0 && !row.unpaidMonths.length ? '⚫ Waived'
                    : row.waivedMonths.length > 0 ? '⚫+🔴 Part'
                    : '🔴 Unpaid'}
                </div>
                {/* Action buttons — only for unpaid non-exempt, only if permitted */}
                {!row.exempt && !row.paid && row.unpaidMonths.length > 0 && can('payments:record' as any) && (
                  <button onClick={() => setQuickPayRow(row)}
                    style={{ padding:'4px 10px', borderRadius:20, border:'none',
                      backgroundColor:'#1a472a', color:'#fff',
                      fontWeight:700, fontSize:9, cursor:'pointer' }}>
                    ⚡ Pay
                  </button>
                )}
                {!row.exempt && !row.paid && row.unpaidMonths.length > 0 && canWriteOff && (
                  <button onClick={() => setWriteOffRow(row)}
                    style={{ padding:'4px 10px', borderRadius:20, border:'none',
                      backgroundColor:'#374151', color:'#fff',
                      fontWeight:700, fontSize:9, cursor:'pointer' }}>
                    ✏️ W/Off
                  </button>
                )}
                {/* Reverse write-off */}
                {!row.exempt && row.waivedMonths.length > 0 && canReverseWriteOff && (
                  <button onClick={() => setReverseWO({
                      id: row.waivedIds[row.waivedMonths[0]],
                      month: row.waivedMonths.join(', ')
                    })}
                    style={{ padding:'4px 8px', borderRadius:20, border:'none',
                      backgroundColor:'#92400e', color:'#fff',
                      fontWeight:700, fontSize:9, cursor:'pointer' }}>
                    ↩ Reverse
                  </button>
                )}
                {/* WA button — attendance:share permission required */}
                {can('attendance:share' as any) && (
                <button onClick={() => {
                    const phone = cleanPhone(row.student.parent_phone || row.student.phone || '');
                    const msg   = buildIndividualMessage(row, billingLabel, from, to, academyName);
                    openWA(phone, msg);
                  }}
                  style={{ padding:'4px 8px', borderRadius:20, border:'none',
                    backgroundColor:'#25d366', color:'#fff',
                    fontWeight:700, fontSize:9, cursor:'pointer' }}>
                  💬 WA
                </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Pay Prompt */}
      {quickPayRow && (
        <QuickPayPrompt
          row={quickPayRow}
          base={base}
          billingMonths={quickPayRow.unpaidMonths}
          onClose={() => setQuickPayRow(null)}
          onSuccess={(_results) => {
            setQuickPayRow(null);
            // Reload sheet to reflect new payment status
            setRows([]);
            setLoading(true);
          }}
        />
      )}

      {/* Write-off Prompt */}
      {writeOffRow && (
        <WriteOffPrompt
          row={writeOffRow}
          base={base}
          billingMonths={writeOffRow.unpaidMonths}
          writtenOffMonths={writeOffRow.waivedMonths}
          onClose={() => setWriteOffRow(null)}
          onSuccess={() => {
            setWriteOffRow(null);
            setRows([]);
            setLoading(true);
          }}
        />
      )}

      {/* Reverse Write-off Prompt */}
      {reverseWO && (
        <ReverseWriteOffPrompt
          woId={reverseWO.id}
          month={reverseWO.month}
          studentName={rows.find(r => r.waivedIds[reverseWO.month.split(',')[0].trim()] === reverseWO.id)?.student.name || ''}
          base={base}
          onClose={() => setReverseWO(null)}
          onSuccess={() => {
            setReverseWO(null);
            setRows([]);
            setLoading(true);
          }}
        />
      )}
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function RecordsScreen() {
  const navigate = useNavigate();
  const [from,        setFrom]        = useState(() => {
    // Default: first day of current month -> today
    // This ensures billing month = current month only, not a range
    // bleeding into next month which would show paid students as unpaid
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
  });
  const [to,          setTo]          = useState(today());
  const [showDates,   setShowDates]   = useState(false);   // Custom date range open
  const [search,      setSearch]      = useState('');
  const [sessionFilt, setSessionFilt] = useState('');
  const [showAbsent,  setShowAbsent]  = useState(false);
  const [loading,     setLoading]     = useState(true);
  const [showPaySheet,setShowPaySheet] = useState(false);
  const [allStudents, setAllStudents] = useState<any[]>([]);

  // All records: { date, session, studentId, synced }[]
  const [records,     setRecords]     = useState<any[]>([]);
  // All sessions available in range
  const [sessions,    setSessions]    = useState<string[]>([]);

  // Build student map for quick lookup
  const studentMap = useMemo(() => {
    const m: Record<number, any> = {};
    allStudents.forEach(s => { m[s.id] = s; });
    return m;
  }, [allStudents]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const students = await getAllStudents();
      setAllStudents(students);

      const dates = getDatesInRange(from, to);
      const allRecs: any[] = [];
      const allSessions = new Set<string>();

      for (const date of dates) {
        const sesList = await getSessionsForDate(date);
        sesList.forEach(s => allSessions.add(s));
        for (const sess of sesList) {
          const rows = await getAttendanceByDateSession(date, sess);
          rows.forEach(r => {
            allRecs.push({
              date,
              session: sess,
              studentId: r.student_id,
              synced: r.synced ?? 0,
              status: r.status ?? 0,
            });
          });
        }

      }
      setRecords(allRecs);
      setSessions(Array.from(allSessions).sort());
    } catch (e) {
      console.error('Records load error:', e);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  // Re-load whenever the date range changes (load rebuilds when from/to change)
  useEffect(() => { load(); }, [load]);

  // One-time: auto-sync if local DB is empty (fresh device / after reset)
  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        const rows = db.exec('SELECT COUNT(*) as n FROM attendance');
        const n = (rows[0]?.values?.[0]?.[0] as number) ?? 0;
        if (n === 0) {
          await syncAttendanceOnly();
          await syncPaymentsOnly();
          await load();
        }
      } catch {}
    })();
  }, []); // eslint-disable-line

  // Pull-to-refresh: sync attendance (7-day reconcile) + payments/write-offs
  const { pullProps, PullIndicator } = usePullToRefresh(async () => {
    await Promise.all([syncAttendanceOnly(), syncPaymentsOnly()]);
    await load();
  });

  // ── Derived data ──────────────────────────────────────────────────────────

  // Present records from the attendance table (status=1)
  const presentRecs = useMemo(() =>
    records.filter(r => r.status === 1), [records]);

  // Build date+session groups to infer absent students
  const dateSessionGroups = useMemo(() => {
    const groups: Record<string, Set<number>> = {};
    records.forEach(r => {
      const key = `${r.date}|${r.session}`;
      if (!groups[key]) groups[key] = new Set();
      groups[key].add(r.studentId);
    });
    return groups;
  }, [records]);

  // Active students (not Inactive/Club Member)
  const activeStudents = useMemo(() =>
    allStudents.filter(s => !['Inactive','Club Member'].includes(s.status || '')),
    [allStudents]
  );

  // All rows (present + absent) for display
  const allDisplayRows = useMemo(() => {
    const rows: { student: any; date: string; session: string; synced: number; present: boolean; }[] = [];

    // Present rows
    presentRecs.forEach(r => {
      const stu = studentMap[r.studentId];
      if (!stu) return;
      if (sessionFilt && r.session !== sessionFilt) return;
      rows.push({ student: stu, date: r.date, session: r.session, synced: r.synced, present: true });
    });

    // Absent rows (inferred)
    if (showAbsent) {
      Object.entries(dateSessionGroups).forEach(([key, presentIds]) => {
        const [date, session] = key.split('|');
        if (sessionFilt && session !== sessionFilt) return;
        activeStudents.forEach(stu => {
          if (!presentIds.has(stu.id)) {
            rows.push({ student: stu, date, session, synced: 0, present: false });
          }
        });
      });
    }

    // Sort: date desc, session, student id
    rows.sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      if (a.session !== b.session) return a.session.localeCompare(b.session);
      const an = a.student.regno ? parseInt(a.student.regno) : null;
        const bn = b.student.regno ? parseInt(b.student.regno) : null;
        if (an === null && bn === null) return a.student.id - b.student.id;
        if (an === null) return 1;
        if (bn === null) return -1;
        return an - bn;
    });

    return rows;
  }, [presentRecs, showAbsent, dateSessionGroups, activeStudents, studentMap, sessionFilt]);

  // Apply student name search
  const filtered = useMemo(() => {
    if (!search) return allDisplayRows;
    const q = search.toLowerCase();
    return allDisplayRows.filter(r => matchesStudentSearch(r.student, q));
  }, [allDisplayRows, search]);

  // Stats
  const stats = useMemo(() => {
    const uniqueStudentIds = [...new Set(presentRecs.map(r => r.studentId))];
    const uniqueStudents   = uniqueStudentIds.length;
    const uniqueSessions   = new Set(presentRecs.map(r => `${r.date}|${r.session}`)).size;
    const synced           = presentRecs.filter(r => r.synced).length;
    return { total: presentRecs.length, uniqueStudents, uniqueStudentIds, uniqueSessions, synced };
  }, [presentRecs]);

  // Group filtered rows by date for section headers
  const grouped = useMemo(() => {
    const g: Record<string, typeof filtered> = {};
    filtered.forEach(r => {
      if (!g[r.date]) g[r.date] = [];
      g[r.date].push(r);
    });
    return g;
  }, [filtered]);

  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  const F: React.CSSProperties = {
    padding: '10px 12px', borderRadius: 10, fontSize: 13, outline: 'none',
    border: `1.5px solid ${C.border}`, backgroundColor: C.card,
    fontFamily: 'inherit', boxSizing: 'border-box' as const,
  };

  return (
    <>
    <div style={{ backgroundColor: C.bg, minHeight: '100vh',
      fontFamily: 'sans-serif', paddingBottom: 40 }} {...pullProps}>
      <PullIndicator />

      {/* ── Header ── */}
      <ScreenHeader title="📋 Attendance Records" background={`linear-gradient(135deg,${C.green},#0d3320)`}
        subtitle={loading ? 'Loading…' : `${stats.total} present records in range`}
        actions={
          <button onClick={async () => {
            await Promise.all([syncAttendanceOnly(), syncPaymentsOnly()]);
            await load();
          }} style={{
            background: 'rgba(255,255,255,0.15)', border: 'none',
            color: '#fff', height: 32, padding: '0 12px', marginRight: 6, borderRadius: 16,
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
          }}>🔄 Sync</button>
        } />

      {/* Stats — scroll away under the pinned header */}
      <div style={{ background: `linear-gradient(135deg,${C.green},#0d3320)` }}>
        {!loading && stats.total > 0 && (
          <div style={{ display: 'flex', gap: 6, padding: '4px 12px 10px' }}>
            <StatPill icon="✅" label="Present" value={stats.total} color={C.green} />
            <div onClick={() => stats.uniqueStudents > 0 && setShowPaySheet(true)}
              style={{ flex: 1, minWidth: 0, display: 'flex', cursor: stats.uniqueStudents > 0 ? 'pointer' : 'default' }}>
              <StatPill icon="👥" label="Tap→Fees" value={stats.uniqueStudents} color={C.navy} />
            </div>
            <StatPill icon="📅" label="Sessions" value={stats.uniqueSessions} color={C.orange} />
            <StatPill icon="☁" label="Synced" value={stats.synced} color="#0369a1" />
          </div>
        )}
      </div>

      {/* ── Filters (compact) ── */}
      <div style={{ backgroundColor: C.card, borderBottom: `1px solid ${C.border}`, padding: '10px 12px 8px' }}>
        {(() => {
          const now   = new Date();
          const y     = now.getFullYear();
          const m     = now.getMonth();   // 0-indexed
          const pad   = (n: number) => String(n).padStart(2,'0');
          const lastDay = (yr: number, mo: number) => toDateStr(new Date(yr, mo + 1, 0));
          // Month-aligned so billing months match exactly
          const ranges = [
            { label: 'This Month', from: `${y}-${pad(m+1)}-01`,             to: today() },
            { label: 'Last Month', from: toDateStr(new Date(y, m - 1, 1)), to: lastDay(y, m - 1) },
            { label: '2 Months',   from: toDateStr(new Date(y, m - 1, 1)), to: today() },
            { label: '3 Months',   from: toDateStr(new Date(y, m - 2, 1)), to: today() },
          ];
          const presetActive = ranges.some(r => from === r.from && to === r.to);
          const datesOpen = showDates || !presetActive;
          const chip = (on: boolean): React.CSSProperties => ({
            flexShrink: 0, height: 30, padding: '0 12px', borderRadius: 15, border: 'none',
            cursor: 'pointer', fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' as const,
            backgroundColor: on ? C.green : '#f3f4f6', color: on ? '#fff' : C.muted,
          });
          return (<>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto' as const, scrollbarWidth: 'none' as any }}>
              {ranges.map(r => (
                <button key={r.label} style={chip(from === r.from && to === r.to)}
                  onClick={() => { setFrom(r.from); setTo(r.to); setShowDates(false); }}>{r.label}</button>
              ))}
              <button style={chip(!presetActive)} onClick={() => setShowDates(v => !v)}>📅 Custom</button>
            </div>
            {datesOpen && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <input type="date" value={from} max={to} aria-label="From date"
                  onChange={e => setFrom(e.target.value)} style={{ ...F, flex: 1, padding: '7px 8px' }} />
                <span style={{ color: C.muted, fontSize: 12 }}>to</span>
                <input type="date" value={to} min={from} max={today()} aria-label="To date"
                  onChange={e => setTo(e.target.value)} style={{ ...F, flex: 1, padding: '7px 8px' }} />
              </div>
            )}
          </>);
        })()}

        {/* Search */}
        <div style={{ position: 'relative', marginTop: 8 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%',
            transform: 'translateY(-50%)', fontSize: 13, color: C.muted }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search student name…"
            style={{ ...F, width: '100%', padding: '8px 32px 8px 30px' }} />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search" style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: C.muted, padding: 6,
            }}>✕</button>
          )}
        </div>

        {/* Session filter + absent toggle — one row */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8,
          overflowX: 'auto' as const, scrollbarWidth: 'none' as any }}>
          <button onClick={() => setSessionFilt('')}
            style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 16, border: 'none',
              cursor: 'pointer', fontSize: 11, fontWeight: 700,
              backgroundColor: sessionFilt === '' ? C.navy : '#f3f4f6',
              color: sessionFilt === '' ? '#fff' : C.muted }}>
            All
          </button>
          {sessions.map(s => (
            <button key={s} onClick={() => setSessionFilt(s)}
              style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 16, border: 'none',
                cursor: 'pointer', fontSize: 11, fontWeight: 700,
                backgroundColor: sessionFilt === s ? C.green : '#f3f4f6',
                color: sessionFilt === s ? '#fff' : C.muted }}>
              {s}
            </button>
          ))}
          <button onClick={() => setShowAbsent(v => !v)}
            style={{ flexShrink: 0, marginLeft: 'auto', padding: '5px 11px', borderRadius: 16,
              border: `1.5px solid ${showAbsent ? C.red : C.border}`,
              cursor: 'pointer', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' as const,
              backgroundColor: showAbsent ? '#fee2e2' : C.card,
              color: showAbsent ? C.red : C.muted }}>
            {showAbsent ? '✗ Hide absent' : '+ Absent'}
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ padding: '10px 0 0' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: C.muted }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
            <div style={{ fontWeight: 700 }}>Loading attendance records…</div>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: C.muted }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
            <div style={{ fontWeight: 800, fontSize: 16, color: C.navy, marginBottom: 6 }}>
              {search ? `No results for "${search}"` : 'No records in this date range'}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              {search
                ? 'Try a different name'
                : 'Attendance is stored locally. Make sure you have synced data or taken attendance in this range.'}
            </div>
            {search && (
              <button onClick={() => setSearch('')} style={{
                marginTop: 14, padding: '8px 20px', borderRadius: 20, border: 'none',
                backgroundColor: C.green, color: '#fff', fontWeight: 700,
                fontSize: 13, cursor: 'pointer',
              }}>Clear Search</button>
            )}
          </div>
        )}

        {!loading && sortedDates.map(date => {
          const rows = grouped[date];
          const presentCount = rows.filter(r => r.present).length;
          const absentCount  = rows.filter(r => !r.present).length;

          return (
            <div key={date} style={{ margin: '0 10px 10px', borderRadius: 14, overflow: 'hidden',
              backgroundColor: C.card, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {/* Date section header */}
              <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 12px',
                backgroundColor: '#e8f0e9',
              }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: C.green }}>
                  📅 {fmt(date)}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {presentCount > 0 && (
                    <span style={{ backgroundColor: '#dcfce7', color: '#166534',
                      fontWeight: 700, fontSize: 11, padding: '2px 10px',
                      borderRadius: 20 }}>
                      ✔ {presentCount}
                    </span>
                  )}
                  {absentCount > 0 && (
                    <span style={{ backgroundColor: '#fee2e2', color: C.red,
                      fontWeight: 700, fontSize: 11, padding: '2px 10px',
                      borderRadius: 20 }}>
                      ✗ {absentCount}
                    </span>
                  )}
                </div>
              </div>

              {/* Rows */}
              <div>
                {rows.map((r, i) => (
                  <AttendanceRow
                    key={`${r.date}-${r.session}-${r.student.id}-${i}`}
                    first={i === 0}
                    student={r.student}
                    date={r.date}
                    session={r.session}
                    synced={r.synced}
                    present={r.present}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* Result count footer */}
        {!loading && filtered.length > 0 && (
          <div style={{ textAlign: 'center', padding: '16px', color: C.muted, fontSize: 12 }}>
            {filtered.length} record{filtered.length !== 1 ? 's' : ''} shown
            {search && ` · filtered by "${search}"`}
            {sessionFilt && ` · ${sessionFilt} only`}
          </div>
        )}
      </div>
    </div>

      {showPaySheet && (
        <AttendeePaymentSheet
          studentIds={stats.uniqueStudentIds}
          studentMap={studentMap}
          allStudents={allStudents}
          from={from}
          to={to}
          onClose={() => setShowPaySheet(false)}
        />
      )}
    </>
  );
}
