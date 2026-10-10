/**
 * accounts.tsx — ledger accounts (admin), same as the web app's Manage Accounts:
 * link a new student / club member to an account, create an outside account
 * (vendor, freelance coach, investor, other), list all accounts and enable / disable.
 * Outside accounts also keep contact details — contact person, phone, address, email,
 * GSTIN, notes — editable by tapping the account, with Call / WhatsApp buttons.
 *
 * Data: /api/data/accounts (routes/api_accounts.py).
 */
import React, { useEffect, useMemo, useState } from 'react';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';
import { apiAuthHeaders } from './apiHeaders';
import { fmtRegNo } from './studentUtils';

const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', muted:'#6b7280', text:'#1f2937', good:'#16a34a', bad:'#dc2626' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const KIND: Record<string, { label:string; color:string; bg:string }> = {
  student: { label:'Student',     color:'#1d4ed8', bg:'#dbeafe' },
  member:  { label:'Club member', color:'#7c3aed', bg:'#ede9fe' },
  coach:   { label:'Coach',       color:'#0f766e', bg:'#ccfbf1' },
  outside: { label:'Outside',     color:'#a16207', bg:'#fef3c7' },
};

const base = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
const isAdmin = () => (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';
async function api(path:string, body?:any) {
  const r = await fetch(`${base()}/api/data/accounts${path}`, body === undefined
    ? { headers: apiAuthHeaders(false) }
    : { method:'POST', headers: { ...apiAuthHeaders(false), 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 403 ? 'Accounts are for admins only'
    : r.status === 404 && !j.detail ? 'This server does not have accounts for the app yet — update the server'
    : (j.detail || j.error || `Server error ${r.status}`));
  return j;
}
const netMsg = (e:any) => /failed to fetch/i.test(e?.message || '') ? 'Cannot reach the server' : e?.message || 'Something went wrong';

const realRegNo = (r:any) => r && !/^(none|null|undefined)$/i.test(String(r).trim()) ? fmtRegNo(r) : '';
/** Second line under an account: reg no for students, position for members, category for outside */
function detail(a:any, types:any[]): string {
  if (a.kind === 'student') return realRegNo(a.regno) ? `Reg ${realRegNo(a.regno)}` : '';
  if (a.kind === 'member') return [a.member_position, a.member_category].filter(Boolean).join(' · ');
  if (a.kind === 'coach') return 'Coach login';
  return types.find((t:any) => t.value === a.account_type)?.label || a.account_type || '';
}

type Details = { contact_name:string; phone:string; email:string; gstin:string; address:string; notes:string };
const EMPTY: Details = { contact_name:'', phone:'', email:'', gstin:'', address:'', notes:'' };
const pick = (a:any): Details => ({ contact_name:a.contact_name || '', phone:a.phone || '', email:a.email || '',
  gstin:a.gstin || '', address:a.address || '', notes:a.notes || '' });
const INPUT: React.CSSProperties = { width:'100%', boxSizing:'border-box', padding:'9px 11px', borderRadius:9, border:`1px solid ${C.border}`,
  fontSize:13.5, outline:'none', fontFamily:'inherit', backgroundColor:'#fff' };
const LBL: React.CSSProperties = { fontSize:10, fontWeight:800, color:C.muted, textTransform:'uppercase', letterSpacing:'0.4px', marginBottom:3 };

/** Contact person, phone, email, GSTIN, address, notes — used by create and edit */
function DetailFields({ d, set }: { d:Details; set:(d:Details)=>void }) {
  const f = (k:keyof Details) => (e:any) => set({ ...d, [k]: k === 'gstin' ? e.target.value.toUpperCase() : e.target.value });
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
      <div style={{ display:'flex', gap:7 }}>
        <div style={{ flex:1, minWidth:0 }}><div style={LBL}>Contact person</div>
          <input value={d.contact_name} onChange={f('contact_name')} placeholder="e.g. Ramesh" style={INPUT}/></div>
        <div style={{ flex:1, minWidth:0 }}><div style={LBL}>Phone</div>
          <input value={d.phone} onChange={f('phone')} type="tel" inputMode="tel" placeholder="98470 12345" style={INPUT}/></div>
      </div>
      <div><div style={LBL}>Email</div>
        <input value={d.email} onChange={f('email')} type="email" inputMode="email" autoCapitalize="none" placeholder="name@business.com" style={INPUT}/></div>
      <div><div style={LBL}>GSTIN</div>
        <input value={d.gstin} onChange={f('gstin')} maxLength={15} autoCapitalize="characters" placeholder="15 characters, e.g. 32ABCDE1234F1Z5"
          style={{ ...INPUT, letterSpacing: d.gstin ? '0.06em' : undefined }}/></div>
      <div><div style={LBL}>Address</div>
        <textarea value={d.address} onChange={f('address')} rows={2} placeholder="Street, area, town" style={{ ...INPUT, resize:'vertical' }}/></div>
      <div><div style={LBL}>Notes</div>
        <textarea value={d.notes} onChange={f('notes')} rows={2} placeholder="e.g. Net installer, warranty till Mar 2027" style={{ ...INPUT, resize:'vertical' }}/></div>
    </div>
  );
}

function telLinks(phone:string) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const intl = digits.length === 10 ? `91${digits}` : digits;
  return { tel:`tel:+${intl}`, wa:`https://wa.me/${intl}` };
}
function openUrl(url:string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

/** Bottom sheet to view / edit an outside account */
function AccountSheet({ acc, types, ready, onClose, onSaved }: { acc:any; types:any[]; ready:boolean; onClose:()=>void; onSaved:(msg:string)=>void }) {
  const [name, setName] = useState(acc.outside_name || acc.display_name || '');
  const [type, setType] = useState(types.some(t => t.value === acc.account_type) ? acc.account_type : 'Vendor');
  const [d, setD] = useState<Details>(pick(acc));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const links = telLinks(d.phone);
  const save = () => {
    setMsg('');
    if (name.trim().length < 2) { setMsg('Enter the name or business'); return; }
    setBusy(true);
    api(`/${acc.id}/update`, { name: name.trim(), account_type: type, ...d })
      .then(r => onSaved(r.warning ? `✓ Saved — ${r.warning}` : `✓ ${name.trim()} saved`))
      .catch(e => setMsg(netMsg(e))).finally(() => setBusy(false));
  };
  return (
    <div role="dialog" aria-label={`Edit ${acc.display_name}`} onClick={onClose}
      style={{ position:'fixed', inset:0, zIndex:60, backgroundColor:'rgba(0,0,0,0.45)', display:'flex', alignItems:'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxHeight:'92vh', overflowY:'auto', backgroundColor:'#fff', borderRadius:'18px 18px 0 0',
        padding:'14px 14px calc(env(safe-area-inset-bottom, 0px) + 14px)', display:'flex', flexDirection:'column', gap:9 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ flex:1, fontWeight:900, fontSize:16 }}>{acc.display_name}</div>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', fontSize:20, color:C.muted, cursor:'pointer' }}>✕</button>
        </div>
        {links && (
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => openUrl(links.tel)} style={{ flex:1, padding:'9px', borderRadius:10, border:'none', backgroundColor:'#f0f4f0', color:C.green, fontWeight:800, fontSize:13, cursor:'pointer' }}>📞 Call</button>
            <button onClick={() => openUrl(links.wa)} style={{ flex:1, padding:'9px', borderRadius:10, border:'none', backgroundColor:'#25d366', color:'#fff', fontWeight:800, fontSize:13, cursor:'pointer' }}>💬 WhatsApp</button>
          </div>
        )}
        <div><div style={LBL}>Name / business</div><input value={name} onChange={e => setName(e.target.value)} style={INPUT}/></div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {types.map((t:any) => (
            <button key={t.value} onClick={() => setType(t.value)} aria-pressed={type === t.value}
              style={{ padding:'6px 11px', borderRadius:16, cursor:'pointer', fontSize:12, fontWeight:700,
                border:`1px solid ${type === t.value ? C.green : C.border}`, backgroundColor: type === t.value ? C.green : '#fff', color: type === t.value ? '#fff' : '#374151' }}>{t.label}</button>
          ))}
        </div>
        {ready ? <DetailFields d={d} set={setD}/>
          : <div style={{ fontSize:12, color:C.muted, backgroundColor:'#fef9c3', borderRadius:8, padding:'8px 10px' }}>Contact details need a one-time database update on the server.</div>}
        {msg && <div style={{ color:C.bad, fontSize:12.5, fontWeight:700 }}>⚠ {msg}</div>}
        <button disabled={busy || !ready} onClick={save} style={{ padding:'11px', borderRadius:11, border:'none', backgroundColor:C.green, color:'#fff',
          fontWeight:900, fontSize:14, cursor:'pointer', opacity: busy || !ready ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

const SectionLabel = ({ children }: { children:React.ReactNode }) =>
  <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase', margin:'6px 2px 0' }}>{children}</div>;
const Empty = ({ text }: { text:string }) => <div style={{ ...CARD, padding:'16px 14px', textAlign:'center', color:C.muted, fontSize:12.5 }}>{text}</div>;

export default function AccountsScreen() {
  const [data, setData] = useState<any>(null);
  const [err, setErr]   = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');                     // which action is running
  const [q, setQ]       = useState('');
  const [filter, setFilter] = useState<'all'|'student'|'member'|'coach'|'outside'|'inactive'>('all');
  const [name, setName] = useState('');
  const [type, setType] = useState('Vendor');
  const [formErr, setFormErr] = useState('');
  const [details, setDetails] = useState<Details>(EMPTY);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const load = () => { setErr(''); api('').then(setData).catch(e => setErr(netMsg(e))); };
  useEffect(load, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2600); return () => clearTimeout(t); }, [toast]);

  const rows = useMemo(() => (data?.accounts || []).filter((a:any) =>
    (filter === 'all' || (filter === 'inactive' ? !a.is_active : a.kind === filter)) &&
    (!q.trim() || [a.display_name, a.contact_name, a.phone, a.gstin].some((v:any) => String(v || '').toLowerCase().includes(q.trim().toLowerCase())))),
    [data, filter, q]);
  if (!isAdmin()) return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%' }}><ScreenHeader title="Accounts"/>
      <div style={{ padding:10 }}><Empty text="🔒 Accounts are for admins only."/></div></div>
  );

  const unlinked = data?.unlinked || { students:[], members:[] };
  const unlinkedN = unlinked.students.length + unlinked.members.length;
  const counts = (k:string) => (data?.accounts || []).filter((a:any) => k === 'inactive' ? !a.is_active : k === 'all' || a.kind === k).length;

  const link = (kind:string, p:any) => {
    setBusy(`link-${kind}-${p.id}`);
    api('/link', { kind, id: p.id }).then(() => { setToast(`✓ ${p.name} linked to an account`); load(); })
      .catch(e => setToast(`⚠ ${netMsg(e)}`)).finally(() => setBusy(''));
  };
  const create = () => {
    setFormErr('');
    if (name.trim().length < 2) { setFormErr('Enter the name or business'); return; }
    setBusy('create');
    api('/outside', { name: name.trim(), account_type: type, ...(data?.details_ready ? details : {}) })
      .then(r => { setToast(r.warning ? `✓ Created — ${r.warning}` : `✓ Account created for ${name.trim()}`);
        setName(''); setDetails(EMPTY); setMoreOpen(false); load(); })
      .catch(e => setFormErr(netMsg(e))).finally(() => setBusy(''));
  };
  const toggle = (a:any) => {
    if (!window.confirm(`${a.is_active ? 'Disable' : 'Enable'} the account for ${a.display_name}?` +
      (a.is_active ? '\n\nIt will no longer appear when recording payments.' : ''))) return;
    setBusy(`toggle-${a.id}`);
    api(`/${a.id}/toggle`, {}).then(r => { setToast(`✓ ${a.display_name} ${r.is_active ? 'enabled' : 'disabled'}`); load(); })
      .catch(e => setToast(`⚠ ${netMsg(e)}`)).finally(() => setBusy(''));
  };

  const chip = (k:typeof filter, label:string) => (
    <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} style={{ flexShrink:0, padding:'5px 10px', borderRadius:16, cursor:'pointer',
      fontSize:11.5, fontWeight:700, whiteSpace:'nowrap', border:`1px solid ${filter === k ? C.green : C.border}`,
      backgroundColor: filter === k ? C.green : '#fff', color: filter === k ? '#fff' : '#374151' }}>{label} · {counts(k)}</button>
  );
  const PersonRow = ({ p, kind, first }: { p:any; kind:string; first:boolean }) => (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:800, fontSize:13.5, color:C.text }}>{p.name}</div>
        <div style={{ fontSize:11, color:C.muted }}>
          {kind === 'student' ? [realRegNo(p.regno) && `Reg ${realRegNo(p.regno)}`, p.enrollment_date ? `joined ${new Date(p.enrollment_date + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}` : ''].filter(Boolean).join(' · ')
            : [p.position, p.category].filter(Boolean).join(' · ')}
        </div>
      </div>
      <button disabled={!!busy} onClick={() => link(kind, p)} style={{ flexShrink:0, padding:'6px 12px', borderRadius:8, border:'none',
        backgroundColor:C.green, color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy === `link-${kind}-${p.id}` ? 'Linking…' : 'Link'}</button>
    </div>
  );

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title="Accounts" subtitle={data ? `${data.accounts.length} accounts${unlinkedN ? ` · ${unlinkedN} not linked yet` : ''}` : 'Ledger accounts'}
        actions={<HeaderIconButton label="Refresh" onClick={load}>↻</HeaderIconButton>}/>
      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {err && (
          <div style={{ ...CARD, padding:14, textAlign:'center' }}>
            <div style={{ color:C.bad, fontWeight:800, fontSize:13, marginBottom:8 }}>⚠ {err}</div>
            <button onClick={load} style={{ padding:'7px 16px', borderRadius:9, border:'none', backgroundColor:C.green, color:'#fff', fontWeight:800, cursor:'pointer' }}>Retry</button>
          </div>
        )}
        {!data && !err && <div style={{ textAlign:'center', color:C.muted, padding:30, fontSize:13 }}>Loading…</div>}
        {data && (<>
          {/* Link people who have no account yet */}
          <SectionLabel>Link a person {unlinkedN ? `· ${unlinkedN}` : ''}</SectionLabel>
          {unlinkedN === 0 ? <Empty text="✓ Every active student and club member has an account"/> : (<>
            {unlinked.students.length > 0 && (
              <div style={CARD}>
                <div style={{ fontSize:10.5, fontWeight:800, color:KIND.student.color, backgroundColor:KIND.student.bg, padding:'5px 12px' }}>STUDENTS</div>
                {unlinked.students.map((p:any, i:number) => <PersonRow key={p.id} p={p} kind="student" first={i === 0}/>)}
              </div>
            )}
            {unlinked.members.length > 0 && (
              <div style={CARD}>
                <div style={{ fontSize:10.5, fontWeight:800, color:KIND.member.color, backgroundColor:KIND.member.bg, padding:'5px 12px' }}>CLUB MEMBERS</div>
                {unlinked.members.map((p:any, i:number) => <PersonRow key={p.id} p={p} kind="member" first={i === 0}/>)}
              </div>
            )}
          </>)}

          {/* Outside account */}
          <SectionLabel>Outside account</SectionLabel>
          <div style={{ ...CARD, padding:12, display:'flex', flexDirection:'column', gap:8 }}>
            <input value={name} onChange={e => { setName(e.target.value); setFormErr(''); }} placeholder="Name / business — e.g. Decathlon Store"
              aria-label="Name or business" style={{ padding:'9px 11px', borderRadius:9, border:`1px solid ${C.border}`, fontSize:13.5, outline:'none' }}/>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {data.outside_types.map((t:any) => (
                <button key={t.value} onClick={() => setType(t.value)} aria-pressed={type === t.value}
                  style={{ padding:'6px 11px', borderRadius:16, cursor:'pointer', fontSize:12, fontWeight:700,
                    border:`1px solid ${type === t.value ? C.green : C.border}`, backgroundColor: type === t.value ? C.green : '#fff', color: type === t.value ? '#fff' : '#374151' }}>
                  {t.label}</button>
              ))}
            </div>
            {data.details_ready && (<>
              <button onClick={() => setMoreOpen(o => !o)} style={{ alignSelf:'flex-start', background:'none', border:'none', padding:0,
                color:C.green, fontWeight:800, fontSize:12.5, cursor:'pointer' }}>
                {moreOpen ? '▾ Hide details' : '▸ More details — contact, phone, address, GSTIN'}</button>
              {moreOpen && <DetailFields d={details} set={setDetails}/>}
            </>)}
            {formErr && <div style={{ color:C.bad, fontSize:12, fontWeight:700 }}>⚠ {formErr}</div>}
            <button disabled={busy === 'create'} onClick={create} style={{ padding:'10px', borderRadius:10, border:'none', backgroundColor:C.green,
              color:'#fff', fontWeight:900, fontSize:13.5, cursor:'pointer', opacity: busy === 'create' ? 0.6 : 1 }}>
              {busy === 'create' ? 'Creating…' : 'Create account'}</button>
          </div>

          {/* All accounts */}
          <SectionLabel>All accounts</SectionLabel>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Find an account" aria-label="Find an account"
            style={{ padding:'8px 11px', borderRadius:10, border:`1px solid ${C.border}`, fontSize:13.5, outline:'none', backgroundColor:'#fff' }}/>
          <div style={{ display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none' }}>
            {chip('all', 'All')}{chip('student', 'Students')}{chip('member', 'Members')}
            {counts('coach') > 0 && chip('coach', 'Coaches')}{chip('outside', 'Outside')}{chip('inactive', 'Inactive')}
          </div>
          {rows.length === 0 ? <Empty text="No accounts match"/> : (
            <div style={CARD}>
              {rows.map((a:any, i:number) => (
                <div key={a.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop: i ? `1px solid ${C.border}` : 'none',
                  opacity: a.is_active ? 1 : 0.6 }}>
                  <div role={a.kind === 'outside' ? 'button' : undefined} tabIndex={a.kind === 'outside' ? 0 : undefined}
                    onClick={a.kind === 'outside' ? () => setEditing(a) : undefined}
                    style={{ flex:1, minWidth:0, cursor: a.kind === 'outside' ? 'pointer' : 'default' }}>
                    <div style={{ fontWeight:800, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.display_name}</div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                      <span style={{ fontSize:9.5, fontWeight:900, padding:'1px 6px', borderRadius:6, color:KIND[a.kind].color, backgroundColor:KIND[a.kind].bg }}>{KIND[a.kind].label.toUpperCase()}</span>
                      <span style={{ fontSize:11, color:C.muted }}>{detail(a, data.outside_types)}</span>
                      {!a.is_active && <span style={{ fontSize:9.5, fontWeight:900, color:C.bad }}>INACTIVE</span>}
                    </div>
                    {a.kind === 'outside' && (a.contact_name || a.phone || a.gstin) && (
                      <div style={{ fontSize:11, color:C.muted, marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {[a.contact_name, a.phone, a.gstin && `GST ${a.gstin}`].filter(Boolean).join(' · ')}</div>
                    )}
                    {a.kind === 'outside' && !(a.contact_name || a.phone || a.gstin) && data.details_ready && (
                      <div style={{ fontSize:11, color:C.green, fontWeight:700, marginTop:2 }}>+ Add contact details</div>
                    )}
                  </div>
                  <button disabled={!!busy} onClick={() => toggle(a)} style={{ flexShrink:0, padding:'5px 10px', borderRadius:8, cursor:'pointer', fontSize:11.5, fontWeight:800,
                    border:`1px solid ${a.is_active ? C.border : C.green}`, backgroundColor:'#fff', color: a.is_active ? C.muted : C.green }}>
                    {busy === `toggle-${a.id}` ? '…' : a.is_active ? 'Disable' : 'Enable'}</button>
                </div>
              ))}
            </div>
          )}
        </>)}
      </div>
      {editing && <AccountSheet acc={editing} types={data.outside_types} ready={!!data.details_ready}
        onClose={() => setEditing(null)} onSaved={m => { setEditing(null); setToast(m); load(); }}/>}
      {toast && (
        <div role="status" style={{ position:'fixed', left:16, right:16, bottom:'calc(70px + env(safe-area-inset-bottom, 0px))', zIndex:50, padding:'10px 14px', borderRadius:10,
          backgroundColor: toast.startsWith('⚠') ? C.bad : C.green, color:'#fff', fontWeight:700, fontSize:13, textAlign:'center', boxShadow:'0 6px 18px rgba(0,0,0,0.2)' }}>{toast}</div>
      )}
    </div>
  );
}
