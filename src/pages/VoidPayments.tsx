import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ScreenHeader from '../shared/ScreenHeader';
import { deleteLocalPaymentByReceipt } from '../database/db';
import { refreshDuesNow } from './useSyncService';

const C = { green:'#1a472a', red:'#dc3545', border:'#e5e7eb', muted:'#6b7280', gold:'#d4af37' };

function getHdrs() {
  const jwt = localStorage.getItem('jwt_token');
  return jwt
    ? { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}
function getBase() {
  return (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
}

export default function VoidPaymentsScreen() {
  const navigate = useNavigate();
  const [receipts, setReceipts] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [voiding,  setVoiding]  = useState<string | null>(null);
  const [msg,      setMsg]      = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${getBase()}/api/data/payments/last-receipt`, { headers: getHdrs() });
      const j   = await res.json();
      setReceipts(j?.data || []);
    } catch { setReceipts([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const doVoid = async (rec: any) => {
    if (!window.confirm(`Void ${rec.receipt_no}?\n${rec.student_name || 'Unknown'} · Rs.${rec.amount_paid}\n\nThis cannot be undone.`)) return;
    setVoiding(rec.receipt_no);
    setMsg('');
    try {
      const res = await fetch(`${getBase()}/api/data/payments/${rec.receipt_no}/void`, {
        method: 'DELETE', headers: getHdrs(),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        // Server hard-deletes; mirror locally (sync is append-only) + refresh dues
        await deleteLocalPaymentByReceipt(rec.receipt_no);
        refreshDuesNow();
        setMsg(`✅ ${rec.receipt_no} voided successfully`);
        load();
      } else {
        setMsg(`⚠ ${j.error || 'Failed to void'}`);
      }
    } catch (e: any) { setMsg(`⚠ ${e.message}`); }
    setVoiding(null);
  };

  const unposted = receipts.filter(r => !r.is_posted);

  return (
    <div style={{ backgroundColor: '#f4f7f6', minHeight: '100vh', fontFamily: 'sans-serif', paddingBottom: 80 }}>
      <ScreenHeader title="🗑 Void Payments" subtitle="Last 10 unposted receipts" />

      <div style={{ padding: 16 }}>
        {/* Message */}
        {msg && (
          <div style={{
            padding: '12px 16px', borderRadius: 12, marginBottom: 16,
            backgroundColor: msg.startsWith('✅') ? '#e8f5e9' : '#fef2f2',
            color: msg.startsWith('✅') ? C.green : C.red, fontWeight: 700, fontSize: 14,
          }}>{msg}</div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: C.muted, padding: 40 }}>Loading…</div>
        ) : unposted.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.muted, padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <div style={{ fontWeight: 700 }}>No unposted payments to void</div>
          </div>
        ) : (
          unposted.map((rec: any) => (
            <div key={rec.receipt_no} style={{
              backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 12,
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
              border: rec.is_posted ? '1px solid #e5e7eb' : '1px solid #ffc107',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15, color: C.green }}>{rec.receipt_no}</div>
                  <div style={{ fontSize: 13, color: '#333', marginTop: 4 }}>
                    {rec.student_name || '—'} · {rec.payment_mode || '—'}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{rec.payment_date}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 900, fontSize: 18, color: C.green }}>Rs.{rec.amount_paid}</div>
                  <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 8, fontWeight: 700,
                    backgroundColor: '#fff3cd', color: '#856404',
                  }}>Not Posted</span>
                </div>
              </div>
              <button onClick={() => doVoid(rec)} disabled={!!voiding}
                style={{
                  width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 8,
                  border: 'none', backgroundColor: voiding === rec.receipt_no ? '#999' : C.red,
                  color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}>
                {voiding === rec.receipt_no ? 'Voiding…' : '🗑 Void This Receipt'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
