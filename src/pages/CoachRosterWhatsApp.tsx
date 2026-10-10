/**
 * CoachRosterWhatsApp.tsx — send each club member their coach-roster dates on WhatsApp
 * (same as the web's Admin → Coach Roster → WhatsApp Roster). Admin only.
 *
 * Works on a 10-day slab (1–10, 11–20, 21–month end): "Next slab" (default, like the
 * web) or "This slab". Each person: their shifts, the message, Send on WhatsApp / Copy.
 * Who has been sent is remembered on this phone per slab, so it's easy to work down the list.
 *
 * Data: GET /api/data/coach-roster/whatsapp?band=next|current
 */
import React, { useEffect, useMemo, useState } from 'react';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';
import { apiAuthHeaders } from './apiHeaders';

const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', muted:'#6b7280', text:'#1f2937',
  morn:'#d97706', mornBg:'#fffbeb', eve:'#4f46e5', eveBg:'#eef2ff', good:'#16a34a', bad:'#dc2626' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const SENT_KEY = 'roster_wa_sent';

const base = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
const isAdmin = () => (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
const fmtDay = (iso:string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
const fmtShort = (iso:string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short' });

function loadSent(band:string): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}')[band] || {}; } catch { return {}; }
}
function saveSent(band:string, sent:Record<string, number>) {
  try {
    const all = JSON.parse(localStorage.getItem(SENT_KEY) || '{}');
    // keep only the last few slabs
    const keys = Object.keys(all).filter(k => k !== band).sort().slice(-4);
    const next: any = {}; keys.forEach(k => { next[k] = all[k]; }); next[band] = sent;
    localStorage.setItem(SENT_KEY, JSON.stringify(next));
  } catch {}
}
function openUrl(url:string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
async function copyText(text:string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); document.body.removeChild(t); return ok;
  } catch { return false; }
}

export default function CoachRosterWhatsApp() {
  const [band, setBand] = useState<'next'|'current'>('next');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [toast, setToast] = useState('');

  const bandKey = data ? `${data.band_start}_${data.band_end}` : '';
  useEffect(() => {
    setData(null); setErr(''); setOpen(null);
    fetch(`${base()}/api/data/coach-roster/whatsapp?band=${band}`, { headers: apiAuthHeaders(false) })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(
        r.status === 403 ? 'WhatsApp roster is for admins' : r.status === 404 || r.status === 405
          ? 'This server does not have the WhatsApp roster for the app yet — update the server' : (j.detail || j.error || `Server error ${r.status}`)); return j; })
      .then(j => { setData(j); setSent(loadSent(`${j.band_start}_${j.band_end}`)); })
      .catch(e => setErr(/failed to fetch/i.test(e.message) ? 'Cannot reach the server' : e.message));
  }, [band]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2200); return () => clearTimeout(t); }, [toast]);

  const markSent = (id:number, on = true) => {
    const next = { ...sent }; if (on) next[id] = Date.now(); else delete next[id];
    setSent(next); saveSent(bandKey, next);
  };
  const people: any[] = data?.people || [];
  const doneN = useMemo(() => people.filter(p => sent[p.member_id]).length, [people, sent]);

  if (!isAdmin()) return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%' }}><ScreenHeader title="WhatsApp Roster"/>
      <div style={{ padding:10 }}><div style={{ ...CARD, padding:16, textAlign:'center', color:C.muted, fontSize:13 }}>🔒 WhatsApp roster is for admins.</div></div></div>
  );

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title="WhatsApp Roster"
        subtitle={data ? `${fmtShort(data.band_start)} – ${fmtShort(data.band_end)} · ${doneN} of ${people.length} sent` : 'Coach roster messages'}>
        <HeaderTabs value={band} onChange={setBand} tabs={[{ id:'next', label:'Next slab' }, { id:'current', label:'This slab' }]}/>
      </ScreenHeader>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {err && <div style={{ ...CARD, padding:14, textAlign:'center', color:C.bad, fontWeight:700, fontSize:13 }}>⚠ {err}</div>}
        {!data && !err && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading…</div>}
        {data && people.length === 0 && (
          <div style={{ ...CARD, padding:16, textAlign:'center', color:C.muted, fontSize:13 }}>
            Nobody is on the roster for {fmtShort(data.band_start)} – {fmtShort(data.band_end)}.
          </div>
        )}
        {data && people.length > 0 && (
          <div style={{ fontSize:11.5, color:C.muted, padding:'0 2px' }}>
            Tap <b>Send</b> to open WhatsApp with the message ready, then come back. Sent ones are ticked on this phone.
          </div>
        )}
        {people.map(p => {
          const isSent = !!sent[p.member_id];
          const expanded = open === p.member_id;
          return (
            <div key={p.member_id} style={{ ...CARD, borderColor: isSent ? '#bbf7d0' : C.border }}>
              <div style={{ padding:'10px 12px', display:'flex', alignItems:'flex-start', gap:10 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ fontWeight:900, fontSize:14 }}>{p.name}</span>
                    {isSent && <span style={{ fontSize:9.5, fontWeight:900, padding:'1px 7px', borderRadius:6, color:C.good, backgroundColor:'#dcfce7' }}>✓ SENT</span>}
                  </div>
                  <div style={{ fontSize:11.5, color: p.phone ? C.muted : C.bad }}>{p.phone || 'No phone number — use Copy'}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:6 }}>
                    {p.slots.map((s:any, i:number) => (
                      <span key={i} style={{ fontSize:11, fontWeight:700, padding:'2px 7px', borderRadius:7,
                        color: s.shift === 'Morning' ? C.morn : C.eve, backgroundColor: s.shift === 'Morning' ? C.mornBg : C.eveBg }}>
                        {fmtDay(s.roster_date)} · {s.shift === 'Morning' ? '🌅' : '🌆'}</span>
                    ))}
                  </div>
                </div>
              </div>
              {expanded && (
                <pre style={{ margin:'0 12px 10px', padding:'9px 10px', borderRadius:9, backgroundColor:'#f8faf8', border:`1px solid ${C.border}`,
                  fontSize:12, lineHeight:1.45, whiteSpace:'pre-wrap', fontFamily:'inherit', color:C.text }}>{p.message}</pre>
              )}
              <div style={{ display:'flex', borderTop:`1px solid ${C.border}` }}>
                <button onClick={() => setOpen(expanded ? null : p.member_id)} style={actionBtn(C.muted)}>{expanded ? 'Hide message' : 'View message'}</button>
                <button onClick={async () => { const ok = await copyText(p.message); setToast(ok ? `Copied message for ${p.name}` : 'Could not copy'); }}
                  style={{ ...actionBtn(C.green), borderLeft:`1px solid ${C.border}` }}>📋 Copy</button>
                <button onClick={() => { openUrl(p.wa_url); markSent(p.member_id); }}
                  style={{ ...actionBtn('#fff'), backgroundColor:'#25d366', fontWeight:900 }}>💬 {isSent ? 'Send again' : 'Send'}</button>
              </div>
              {isSent && (
                <button onClick={() => markSent(p.member_id, false)} style={{ width:'100%', padding:'5px', background:'none', border:'none',
                  borderTop:`1px solid ${C.border}`, color:C.muted, fontSize:11, cursor:'pointer' }}>Unmark as sent</button>
              )}
            </div>
          );
        })}
      </div>
      {toast && (
        <div role="status" style={{ position:'fixed', left:16, right:16, bottom:'calc(70px + env(safe-area-inset-bottom, 0px))', zIndex:50, padding:'10px 14px',
          borderRadius:10, backgroundColor:C.green, color:'#fff', fontWeight:700, fontSize:13, textAlign:'center' }}>{toast}</div>
      )}
    </div>
  );
}

const actionBtn = (color:string): React.CSSProperties => ({ flex:1, padding:'10px 4px', background:'none', border:'none', color,
  fontWeight:800, fontSize:12.5, cursor:'pointer' });
