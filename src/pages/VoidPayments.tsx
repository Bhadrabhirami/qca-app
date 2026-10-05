import React, { useEffect, useState } from 'react';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';
import StudentPhoto from '../shared/StudentPhoto';
import { deleteLocalPaymentByReceipt, getPaymentDetailsById } from '../database/db';
import { refreshDuesNow } from './useSyncService';
import { apiAuthHeaders } from './apiHeaders';
import { fmtRegNo } from './studentUtils';

const C = {
  green:'#1a472a', gold:'#d4af37', red:'#c0392b', bg:'#f4f7f6',
  border:'#e8e8e8', muted:'#6b7280', text:'#1f2937', ok:'#166534',
};
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };

const getBase = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
const fmtAmt  = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fmtDate = (d: string) => {
  const x = new Date(String(d || '').slice(0, 10) + 'T00:00:00');
  return isNaN(x.getTime()) ? (d || '—') : x.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
};

export default function VoidPaymentsScreen() {
  const [receipts, setReceipts] = useState<any[]>([]);
  const [details,  setDetails]  = useState<Record<number, any>>({});   // local fallback (older servers)
  const [loading,  setLoading]  = useState(true);
  const [loadErr,  setLoadErr]  = useState('');
  const [confirm,  setConfirm]  = useState<string | null>(null);   // receipt awaiting confirmation
  const [voiding,  setVoiding]  = useState<string | null>(null);
  const [msg,      setMsg]      = useState('');

  const load = async () => {
    setLoading(true); setLoadErr('');
    try {
      const res = await fetch(`${getBase()}/api/data/payments/last-receipt`, { headers: apiAuthHeaders(false) });
      if (!res.ok) throw new Error(res.status === 403 ? 'Your role cannot void payments' : `Server error ${res.status}`);
      const rows: any[] = (await res.json())?.data || [];
      setReceipts(rows);
      setDetails(await getPaymentDetailsById(rows.map(r => r.id).filter(Boolean)).catch(() => ({})));
    } catch (e: any) {
      setReceipts([]);
      setLoadErr(/failed to fetch|network/i.test(e?.message || '') ? 'Cannot reach the server — check Wi-Fi' : (e?.message || 'Could not load receipts'));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const doVoid = async (rec: any) => {
    setConfirm(null); setVoiding(rec.receipt_no); setMsg('');
    try {
      const res = await fetch(`${getBase()}/api/data/payments/${encodeURIComponent(rec.receipt_no)}/void`, {
        method: 'DELETE', headers: apiAuthHeaders(),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        // Server hard-deletes; mirror locally (sync is append-only) + refresh dues
        await deleteLocalPaymentByReceipt(rec.receipt_no);
        refreshDuesNow();
        setMsg(`✅ ${rec.receipt_no} voided — ${rec.student_name || 'payment'} ${fmtAmt(rec.amount_paid)}`);
        load();
      } else {
        setMsg(`⚠ ${j.error || 'Failed to void'}`);
      }
    } catch (e: any) { setMsg(`⚠ ${e.message}`); }
    setVoiding(null);
  };

  const unposted = receipts.filter(r => !r.is_posted);
  const isOut    = (r: any) => r.txn_direction === 'OUT';
  const totalIn  = unposted.filter(r => !isOut(r)).reduce((a, r) => a + Number(r.amount_paid || 0), 0);
  const totalOut = unposted.filter(isOut).reduce((a, r) => a + Number(r.amount_paid || 0), 0);

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', fontFamily:'sans-serif', color:C.text, paddingBottom:24 }}>
      <ScreenHeader title="Void Payments"
        subtitle={loading ? 'Loading…'
          : `${unposted.length} unposted · ${fmtAmt(totalIn)} in${totalOut ? ` · ${fmtAmt(totalOut)} out` : ''}`}
        actions={<HeaderIconButton label="Reload" onClick={load}>↻</HeaderIconButton>} />

      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        <div style={{ fontSize:11.5, color:C.muted, lineHeight:1.4, padding:'0 2px' }}>
          Only the last receipts <b>not yet posted</b> to the ledger can be voided. Voiding deletes the receipt on the server and the dues update.
        </div>

        {msg && (
          <div style={{ padding:'8px 12px', borderRadius:10, fontSize:12.5, fontWeight:700,
            backgroundColor: msg.startsWith('✅') ? '#e8f5e9' : '#fef2f2',
            color: msg.startsWith('✅') ? C.ok : C.red }}>{msg}</div>
        )}

        {loading ? (
          <div style={{ textAlign:'center', color:C.muted, padding:40, fontSize:13 }}>Loading…</div>
        ) : loadErr ? (
          <div style={{ ...CARD, padding:'20px 16px', textAlign:'center' }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.red, marginBottom:10 }}>⚠ {loadErr}</div>
            <button onClick={load} style={{ padding:'8px 18px', borderRadius:9, border:'none', backgroundColor:C.green,
              color:'#fff', fontWeight:800, fontSize:13, cursor:'pointer' }}>Retry</button>
          </div>
        ) : unposted.length === 0 ? (
          <div style={{ ...CARD, padding:'28px 16px', textAlign:'center', color:C.muted }}>
            <div style={{ fontSize:30, marginBottom:6 }}>✅</div>
            <div style={{ fontWeight:700, fontSize:13 }}>Nothing to void — all recent receipts are posted</div>
          </div>
        ) : (
          <div style={CARD}>
            {unposted.map((rec: any, i: number) => {
              // Server fields first (newer servers send them); local row by id as fallback
              const loc      = details[rec.id] || {};
              const regno    = rec.regno         ?? loc.regno;
              const qcaId    = rec.qca_id        ?? loc.qca_id;
              const photo    = rec.profile_image ?? loc.profile_image ?? null;
              const category = rec.category_name ?? loc.fee_type_name;
              const month    = rec.billing_month_display ?? loc.month;
              const student  = !!rec.student_name;
              const out      = isOut(rec);
              const title    = rec.student_name || rec.account_name || category || 'Unknown entry';
              const ids = student
                ? [fmtRegNo(regno), qcaId ? `Q${String(qcaId).padStart(3,'0')}` : ''].filter(Boolean).join(' · ')
                : '';
              const line3 = [student ? category : (rec.account_name ? category : ''), month].filter(Boolean).join(' · ');
              const busy = voiding === rec.receipt_no;
              const asking = confirm === rec.receipt_no;
              return (
                <div key={rec.receipt_no} style={{ borderTop: i ? `1px solid ${C.border}` : 'none',
                  backgroundColor: asking ? '#fef2f2' : '#fff' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px' }}>
                    {student
                      ? <StudentPhoto student={{ name: rec.student_name, profile_image: photo }} size={36} />
                      : <div aria-hidden style={{ width:36, height:36, borderRadius:'50%', flexShrink:0, display:'flex',
                          alignItems:'center', justifyContent:'center', fontSize:17,
                          backgroundColor: out ? '#fee2e2' : '#e8f5e9' }}>{out ? '💸' : '💰'}</div>}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ fontWeight:800, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {title}
                        </span>
                        {!student && (
                          <span style={{ flexShrink:0, fontSize:9.5, fontWeight:800, padding:'1px 6px', borderRadius:6,
                            backgroundColor: out ? '#fee2e2' : '#e8f5e9', color: out ? C.red : C.ok }}>
                            {out ? 'EXPENSE' : 'OTHER INCOME'}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize:11, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {ids && <span style={{ color:C.green, fontWeight:700 }}>{ids} · </span>}
                        {rec.receipt_no} · {fmtDate(rec.payment_date)} · {rec.payment_mode || '—'}
                      </div>
                      {line3 && (
                        <div style={{ fontSize:11, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {line3}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0 }}>
                      <div style={{ fontWeight:900, fontSize:15, color: out ? C.red : C.green }}>{out ? '−' : ''}{fmtAmt(rec.amount_paid)}</div>
                      {!asking && (
                        <button onClick={() => setConfirm(rec.receipt_no)} disabled={!!voiding}
                          style={{ marginTop:3, padding:'4px 10px', borderRadius:7, border:`1px solid ${C.red}`,
                            backgroundColor:'#fff', color: busy ? C.muted : C.red, fontWeight:700, fontSize:11.5,
                            cursor: voiding ? 'not-allowed' : 'pointer' }}>
                          {busy ? 'Voiding…' : 'Void'}
                        </button>
                      )}
                    </div>
                  </div>
                  {asking && (
                    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'0 12px 9px 58px' }}>
                      <span style={{ flex:1, fontSize:12, fontWeight:700, color:C.red }}>Delete this receipt? Can't be undone.</span>
                      <button onClick={() => setConfirm(null)} style={{ padding:'6px 12px', borderRadius:8, border:`1px solid ${C.border}`,
                        backgroundColor:'#fff', fontWeight:700, fontSize:12, cursor:'pointer' }}>Cancel</button>
                      <button onClick={() => doVoid(rec)} style={{ padding:'6px 12px', borderRadius:8, border:'none',
                        backgroundColor:C.red, color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer' }}>Void</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
