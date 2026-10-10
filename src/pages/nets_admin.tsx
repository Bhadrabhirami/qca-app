/**
 * nets_admin.tsx — Net Booking Admin Panel (mobile)
 * Permission: nets:admin
 *
 * Tabs:
 *   Members       — list, suspend, restore net members
 *   Blocks        — add/remove maintenance blocks
 *   Announcements — net-specific announcements
 *   Settings      — pricing overview, operating hours
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

const C = {
  navy:   '#0d1b2a',
  green:  '#1a472a',
  gold:   '#c5a059',
  bg:     '#f0f2f5',
  card:   '#fff',
  border: '#e0e0e0',
  muted:  '#6b7280',
  red:    '#dc2626',
};

function bld() {
  const ip = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
  return ip.startsWith('http') ? ip : `http://${ip}`;
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
// ── Members Tab ───────────────────────────────────────────────────────
function MembersTab() {
  const base = bld();
  const [members,  setMembers]  = React.useState<any[]>([]);
  const [loading,  setLoading]  = React.useState(true);
  const [search,   setSearch]   = React.useState('');
  const [msg,      setMsg]      = React.useState('');
  const [selected, setSelected] = React.useState<any>(null);
  const [editForm, setEditForm] = React.useState<any>(null);
  const [newPin,   setNewPin]   = React.useState('');
  const [saving,   setSaving]   = React.useState(false);
  const [adding,   setAdding]   = React.useState(false);
  const [addForm,  setAddForm]  = React.useState({ name:'', mobile:'', email:'', address:'', pin:'' });
  const [addMsg,   setAddMsg]   = React.useState('');

  const addMember = async () => {
    setAddMsg('');
    if (addForm.name.trim().length < 2) { setAddMsg("Enter the member's name"); return; }
    if (addForm.mobile.replace(/\D/g,'').length < 10) { setAddMsg('Mobile needs 10 digits'); return; }
    if (addForm.pin && !/^\d{4}$/.test(addForm.pin)) { setAddMsg('PIN must be 4 digits (or leave it empty)'); return; }
    setSaving(true);
    try {
      const r = await fetch(`${base}/api/data/nets/members`, { method:'POST', headers: hdr(), body: JSON.stringify(addForm) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setAddMsg(`✓ ${j.data?.name} added as ${j.data?.member_code}${j.pin ? ` — PIN ${j.pin} (tell the member now, it isn't shown again)` : ''}`);
        setAddForm({ name:'', mobile:'', email:'', address:'', pin:'' });
        load(search);
      } else setAddMsg(j.error || 'Could not add the member');
    } catch { setAddMsg('Network error'); }
    finally { setSaving(false); }
  };

  const load = React.useCallback(async (q = '') => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/nets/members${q ? '?q='+encodeURIComponent(q) : ''}`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setMembers(j.data);
    } catch {} finally { setLoading(false); }
  }, [base]);

  React.useEffect(() => { load(); }, []);

  const openMember = async (m: any) => {
    setSelected(m);
    setEditForm({ name: m.name, mobile: m.mobile||'', email: m.email||'', address: m.address||'' });
    setNewPin(''); setMsg('');
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/members/${selected.id}/edit`, {
        method: 'POST', headers: hdr(), body: JSON.stringify(editForm)
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setMsg('✓ Details saved'); load(search); setSelected({...selected,...editForm}); }
      else setMsg(j.error || 'Could not save');
    } catch { setMsg('Network error'); }
    finally { setSaving(false); }
  };

  const resetPin = async () => {
    if (!newPin || newPin.length !== 4) { setMsg('Enter 4-digit PIN'); return; }
    if (!confirm(`Set PIN to ${newPin} for ${selected?.name}?`)) return;
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/members/${selected.id}/reset-pin`, {
        method: 'POST', headers: hdr(), body: JSON.stringify({ pin: newPin })
      });
      const j = await r.json();
      if (r.ok) { setMsg('✓ PIN updated successfully'); setNewPin(''); }
      else setMsg(j.error || 'Error');
    } catch { setMsg('Network error'); }
    finally { setSaving(false); }
  };

  const toggleActive = async () => {
    if (!selected) return;
    const ep = selected.is_active ? 'suspend' : 'restore';
    if (!confirm(`${selected.is_active ? 'Suspend' : 'Restore'} ${selected.name}?`)) return;
    setSaving(true);
    try {
      const r = await fetch(`${base}/api/data/nets/members/${selected.id}/${ep}`, { method: 'POST', headers: hdr() });
      if (r.ok) {
        const updated = {...selected, is_active: !selected.is_active};
        setSelected(updated);
        setMsg(`✓ ${updated.is_active ? 'Restored — they can book again' : 'Suspended — they can no longer book'}`);
        load(search);
      } else { const j = await r.json().catch(() => ({})); setMsg(j.error || 'Could not change the status'); }
    } catch { setMsg('Network error'); } finally { setSaving(false); }
  };

  // Member detail sheet
  if (selected) return (
    <div style={{padding:'12px 0'}}>
      <button onClick={()=>setSelected(null)}
        style={{background:'none',border:'none',color:C.navy,fontWeight:700,
          fontSize:14,cursor:'pointer',marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
        ← Back to Members
      </button>

      {msg &&<div style={{fontSize:12,color:msg.startsWith('✓')?'#16a34a':C.red,
        fontWeight:600,marginBottom:8}}>{msg}</div>}

      {/* Edit Details */}
      <div style={{backgroundColor:C.card,borderRadius:12,padding:14,
        marginBottom:12,border:`1px solid ${C.border}`}}>
        <div style={{fontWeight:800,fontSize:12,color:C.navy,marginBottom:10,
          textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>✏️ Edit Details</div>
        {[
          {key:'name',label:'Name'},
          {key:'mobile',label:'Mobile'},
          {key:'email',label:'Email'},
          {key:'address',label:'Address'},
        ].map(f => (
          <div key={f.key} style={{marginBottom:8}}>
            <div style={{fontSize:10,fontWeight:600,color:C.muted,marginBottom:3}}>{f.label}</div>
            <input value={editForm?.[f.key]||''} onChange={e=>setEditForm((p:any)=>({...p,[f.key]:e.target.value}))}
              style={{width:'100%',padding:'8px 10px',borderRadius:8,
                border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const}}/>
          </div>
        ))}
        <button onClick={saveEdit} disabled={saving}
          style={{width:'100%',padding:10,borderRadius:8,border:'none',
            backgroundColor:C.navy,color:'#fff',fontWeight:700,fontSize:13,cursor:'pointer'}}>
          {saving?'Saving...':'Save Details'}
        </button>
      </div>

      {/* Reset PIN */}
      <div style={{backgroundColor:C.card,borderRadius:12,padding:14,
        border:`1px solid ${C.border}`}}>
        <div style={{fontWeight:800,fontSize:12,color:C.navy,marginBottom:6,
          textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>🔑 Set New PIN</div>
        <div style={{fontSize:11,color:C.muted,marginBottom:10}}>
          Enter a new 4-digit PIN to set for this member
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center',marginBottom:10}}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{width:44,height:56,borderRadius:10,
              border:`2px solid ${newPin.length>i?C.navy:C.border}`,
              backgroundColor:newPin.length>i?'#f0f4ff':'#fafafa',
              display:'flex',alignItems:'center',justifyContent:'center',
              fontSize:28,fontWeight:900,color:C.navy}}>
              {newPin.length>i ? '●' : ''}
            </div>
          ))}
        </div>
        <input value={newPin} onChange={e=>setNewPin(e.target.value.replace(/[^0-9]/g,'').slice(0,4))}
          type="tel" inputMode="numeric" maxLength={4}
          placeholder="Enter 4 digits"
          style={{width:'100%',padding:'10px',borderRadius:8,marginBottom:10,
            border:`1px solid ${C.border}`,fontSize:16,outline:'none',
            textAlign:'center' as const,letterSpacing:'8px',fontWeight:700,
            boxSizing:'border-box' as const, opacity:0.01, height:1}}/>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:10}}>
          {['1','2','3','4','5','6','7','8','9','','0','⌫'].map(k => (
            <button key={k} onClick={()=>{
              if(k==='⌫') setNewPin(p=>p.slice(0,-1));
              else if(k&&newPin.length<4) setNewPin(p=>p+k);
            }} style={{padding:'14px 0',borderRadius:10,border:'none',
              backgroundColor:k===''?'transparent':k==='⌫'?'#fef2f2':'#f0f2f5',
              color:k==='⌫'?'#dc2626':'#111',fontWeight:700,fontSize:18,
              cursor:k===''?'default':'pointer'}}>
              {k}
            </button>
          ))}
        </div>
        <button onClick={resetPin} disabled={saving||newPin.length!==4}
          style={{width:'100%',padding:12,borderRadius:10,border:'none',
            backgroundColor:newPin.length===4?C.navy:'#e5e7eb',
            color:newPin.length===4?'#fff':C.muted,
            fontWeight:800,fontSize:14,cursor:newPin.length===4?'pointer':'not-allowed'}}>
          {saving?'Setting PIN...':'Set PIN'}
        </button>
      </div>

      {/* Suspend / restore */}
      <div style={{backgroundColor:C.card,borderRadius:12,padding:14,marginTop:12,border:`1px solid ${C.border}`}}>
        <div style={{fontWeight:800,fontSize:12,color:C.navy,marginBottom:6,textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>
          {selected.is_active ? '⛔ Suspend member' : '✅ Restore member'}</div>
        <div style={{fontSize:11,color:C.muted,marginBottom:10}}>
          {selected.is_active ? 'A suspended member cannot log in or be booked for. Existing bookings stay.' : 'This member is suspended. Restore to let them book again.'}
        </div>
        <button onClick={toggleActive} disabled={saving}
          style={{width:'100%',padding:11,borderRadius:10,cursor:'pointer',fontWeight:800,fontSize:14,
            border:`1px solid ${selected.is_active?C.red:'#16a34a'}`,backgroundColor:'#fff',color:selected.is_active?C.red:'#16a34a'}}>
          {selected.is_active ? 'Suspend' : 'Restore'}
        </button>
      </div>
    </div>
  );

  // Members list
  const inp: React.CSSProperties = {width:'100%',padding:'8px 10px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:13,outline:'none',boxSizing:'border-box' as const,marginBottom:6};
  return (
    <div style={{padding:'12px 0'}}>
      <div style={{backgroundColor:C.card,borderRadius:12,padding:adding?14:0,marginBottom:12,border:adding?`1px solid ${C.border}`:'none'}}>
        {!adding ? (
          <button onClick={()=>{setAdding(true);setAddMsg('');}}
            style={{width:'100%',padding:11,borderRadius:10,border:`1px dashed ${C.navy}`,backgroundColor:'#fff',
              color:C.navy,fontWeight:800,fontSize:13,cursor:'pointer'}}>➕ Add net member</button>
        ) : (<>
          <div style={{fontWeight:800,fontSize:12,color:C.navy,marginBottom:8,textTransform:'uppercase' as const}}>➕ New net member</div>
          <input value={addForm.name} onChange={e=>setAddForm(f=>({...f,name:e.target.value}))} placeholder="Name *" aria-label="Name" style={inp}/>
          <input value={addForm.mobile} onChange={e=>setAddForm(f=>({...f,mobile:e.target.value}))} type="tel" inputMode="tel" placeholder="Mobile * (their login)" aria-label="Mobile" style={inp}/>
          <input value={addForm.email} onChange={e=>setAddForm(f=>({...f,email:e.target.value}))} type="email" placeholder="Email (optional)" aria-label="Email" style={inp}/>
          <input value={addForm.address} onChange={e=>setAddForm(f=>({...f,address:e.target.value}))} placeholder="Address (optional)" aria-label="Address" style={inp}/>
          <input value={addForm.pin} onChange={e=>setAddForm(f=>({...f,pin:e.target.value.replace(/\D/g,'').slice(0,4)}))} inputMode="numeric"
            placeholder="4-digit PIN (leave empty to generate one)" aria-label="PIN" style={inp}/>
          {addMsg && <div style={{fontSize:12,fontWeight:700,color:addMsg.startsWith('✓')?'#16a34a':C.red,margin:'4px 0 8px'}}>{addMsg}</div>}
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>{setAdding(false);setAddMsg('');}} style={{flex:1,padding:10,borderRadius:8,border:`1px solid ${C.border}`,
              backgroundColor:'#fff',color:C.muted,fontWeight:700,fontSize:13,cursor:'pointer'}}>Close</button>
            <button onClick={addMember} disabled={saving} style={{flex:2,padding:10,borderRadius:8,border:'none',
              backgroundColor:C.navy,color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer'}}>{saving?'Adding…':'Add member'}</button>
          </div>
        </>)}
      </div>
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        <input value={search} onChange={e=>setSearch(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&load(search)}
          placeholder="Search members..."
          style={{flex:1,padding:'9px 12px',borderRadius:10,
            border:`1px solid ${C.border}`,fontSize:13,outline:'none'}}/>
        <button onClick={()=>load(search)}
          style={{padding:'9px 16px',borderRadius:10,border:'none',
            backgroundColor:C.navy,color:'#fff',fontWeight:700,fontSize:13,cursor:'pointer'}}>
          🔍
        </button>
      </div>
      {loading && <div style={{textAlign:'center',padding:24,color:C.muted}}>Loading...</div>}
      {!loading && members.length===0 && (
        <div style={{textAlign:'center',padding:24,color:C.muted}}>No members found</div>
      )}
      {members.map(m => (
        <button key={m.id} onClick={()=>openMember(m)}
          style={{width:'100%',backgroundColor:C.card,borderRadius:12,
            padding:'12px 14px',marginBottom:8,border:`1px solid ${C.border}`,
            display:'flex',alignItems:'center',gap:12,cursor:'pointer',textAlign:'left' as const}}>
          <div style={{width:42,height:42,borderRadius:'50%',flexShrink:0,
            backgroundColor:m.is_active?C.green:C.muted,
            display:'flex',alignItems:'center',justifyContent:'center',
            fontWeight:900,fontSize:16,color:'#fff'}}>
            {(m.name||'?')[0].toUpperCase()}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:14,color:'#111'}}>{m.name}</div>
            <div style={{fontSize:11,color:C.muted,marginTop:2}}>
              {m.member_code} · 📞 {m.mobile||'—'}
            </div>
            <div style={{fontSize:10,color:m.is_active?'#16a34a':C.red,fontWeight:700,marginTop:2}}>
              {m.is_active?'● Active':'● Suspended'}
            </div>
          </div>
          <span style={{color:C.muted,fontSize:18}}>›</span>
        </button>
      ))}
    </div>
  );
}


// ── Blocks Tab ────────────────────────────────────────────────────────
function BlocksTab() {
  const base = bld();
  const [blocks,  setBlocks]  = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [date,    setDate]    = useState('');
  const [reason,  setReason]  = useState('');
  const [netId,   setNetId]   = useState('');
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/nets/settings`, { headers: hdr() });
      const j = await r.json();
      if (j.data?.maint_blocks) setBlocks(j.data.maint_blocks);
    } catch {} finally { setLoading(false); }
  }, [base]);

  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!date) return;
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/block`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ net_id: netId ? parseInt(netId) : null, block_date: date, reason })
      });
      const j = await r.json();
      if (r.ok) { setMsg('✓ Block added'); setDate(''); setReason(''); setNetId(''); load(); }
      else setMsg(j.error || 'Error');
    } catch { setMsg('Network error'); }
    finally { setSaving(false); }
  };

  const remove = async (id: number) => {
    if (!confirm('Remove this block?')) return;
    try {
      const r = await fetch(`${base}/api/data/nets/block/${id}/remove`, { method: 'POST', headers: hdr() });
      if (r.ok) { setMsg('✓ Removed'); load(); }
    } catch {}
  };

  return (
    <div style={{ padding: '12px 0' }}>
      {/* Add block form */}
      <div style={{ backgroundColor: C.card, borderRadius: 12, padding: 14,
        marginBottom: 14, border: `1px solid ${C.border}` }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: C.navy, marginBottom: 10,
          textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
          🔒 Add Maintenance Block
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ width: '100%', padding: '9px 12px', borderRadius: 8, marginBottom: 8,
            border: `1px solid ${C.border}`, fontSize: 13, outline: 'none',
            boxSizing: 'border-box' as const }}/>
        <input value={netId} onChange={e => setNetId(e.target.value)}
          placeholder="Net ID (leave blank for all nets)"
          style={{ width: '100%', padding: '9px 12px', borderRadius: 8, marginBottom: 8,
            border: `1px solid ${C.border}`, fontSize: 13, outline: 'none',
            boxSizing: 'border-box' as const }}/>
        <input value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Reason (optional)"
          style={{ width: '100%', padding: '9px 12px', borderRadius: 8, marginBottom: 10,
            border: `1px solid ${C.border}`, fontSize: 13, outline: 'none',
            boxSizing: 'border-box' as const }}/>
        {msg && <div style={{ fontSize: 12, color: msg.startsWith('✓') ? '#16a34a' : C.red,
          marginBottom: 8 }}>{msg}</div>}
        <button onClick={add} disabled={!date || saving}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none',
            backgroundColor: date ? C.navy : '#e5e7eb',
            color: date ? '#fff' : C.muted, fontWeight: 700,
            fontSize: 13, cursor: date ? 'pointer' : 'not-allowed' }}>
          {saving ? 'Adding…' : 'Add Block'}
        </button>
      </div>

      {/* Existing blocks */}
      <div style={{ fontWeight: 700, fontSize: 12, color: C.muted,
        textTransform: 'uppercase' as const, letterSpacing: '1px', marginBottom: 8 }}>
        Existing Blocks
      </div>
      {loading && <div style={{ textAlign: 'center', padding: 20, color: C.muted }}>Loading…</div>}
      {!loading && blocks.length === 0 && (
        <div style={{ textAlign: 'center', padding: 20, color: C.muted, fontSize: 13 }}>
          No maintenance blocks
        </div>
      )}
      {blocks.map((b: any) => (
        <div key={b.id} style={{ backgroundColor: C.card, borderRadius: 10,
          padding: '10px 14px', marginBottom: 6, border: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#111' }}>
              {b.block_date} {b.net_id ? `· Net ${b.net_id}` : '· All Nets'}
            </div>
            {b.reason && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{b.reason}</div>}
          </div>
          <button onClick={() => remove(b.id)}
            style={{ background: 'none', border: 'none', color: C.red,
              fontSize: 18, cursor: 'pointer', padding: '0 4px' }}>🗑</button>
        </div>
      ))}
    </div>
  );
}

// ── Announcements Tab ─────────────────────────────────────────────────
function AnnouncementsTab() {
  const base = bld();
  const [list,    setList]    = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg,     setMsg]     = useState('');
  const [posting, setPosting] = useState(false);
  const [text,    setText]    = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/nets/settings`, { headers: hdr() });
      const j = await r.json();
      if (j.data?.announcements) setList(j.data.announcements);
    } catch {} finally { setLoading(false); }
  }, [base]);

  useEffect(() => { load(); }, []);

  const post = async () => {
    if (!text.trim()) return;
    setPosting(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/announce`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ message: text.trim() })
      });
      if (r.ok) { setMsg('✓ Posted'); setText(''); load(); }
      else setMsg('Error posting');
    } catch { setMsg('Network error'); }
    finally { setPosting(false); }
  };

  const remove = async (id: number) => {
    if (!confirm('Remove this announcement?')) return;
    try {
      const r = await fetch(`${base}/api/data/nets/announce/${id}/remove`, { method: 'POST', headers: hdr() });
      if (r.ok) { setMsg('✓ Removed'); load(); }
    } catch {}
  };

  return (
    <div style={{ padding: '12px 0' }}>
      {/* Post form */}
      <div style={{ backgroundColor: C.card, borderRadius: 12, padding: 14,
        marginBottom: 14, border: `1px solid ${C.border}` }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: C.navy, marginBottom: 10,
          textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
          📢 New Announcement
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)}
          placeholder="Announcement for net booking users…" rows={3} maxLength={400}
          style={{ width: '100%', padding: '9px 12px', borderRadius: 8, marginBottom: 8,
            border: `1px solid ${C.border}`, fontSize: 13, outline: 'none',
            resize: 'none' as const, boxSizing: 'border-box' as const }}/>
        {msg && <div style={{ fontSize: 12, color: msg.startsWith('✓') ? '#16a34a' : C.red,
          marginBottom: 8 }}>{msg}</div>}
        <button onClick={post} disabled={!text.trim() || posting}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none',
            backgroundColor: text.trim() ? C.navy : '#e5e7eb',
            color: text.trim() ? '#fff' : C.muted,
            fontWeight: 700, fontSize: 13, cursor: text.trim() ? 'pointer' : 'not-allowed' }}>
          {posting ? 'Posting…' : 'Post Announcement'}
        </button>
      </div>

      {/* List */}
      {loading && <div style={{ textAlign: 'center', padding: 20, color: C.muted }}>Loading…</div>}
      {!loading && list.length === 0 && (
        <div style={{ textAlign: 'center', padding: 20, color: C.muted, fontSize: 13 }}>
          No announcements
        </div>
      )}
      {list.map((a: any) => (
        <div key={a.id} style={{ backgroundColor: C.card, borderRadius: 10,
          padding: '12px 14px', marginBottom: 8,
          borderLeft: `4px solid ${C.gold}`, border: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: '#111', lineHeight: 1.4 }}>{a.message}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
              By {a.created_by} · {new Date(a.created_at).toLocaleDateString()}
            </div>
          </div>
          <button onClick={() => remove(a.id)}
            style={{ background: 'none', border: 'none', color: C.red,
              fontSize: 18, cursor: 'pointer', padding: '0 4px', flexShrink: 0 }}>🗑</button>
        </div>
      ))}
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────

// ── Hours Tab ─────────────────────────────────────────────────────────
function HoursTab() {
  const base = bld();
  const [overrides, setOverrides] = React.useState<any[]>([]);
  const [loading,   setLoading]   = React.useState(true);
  const [saving,    setSaving]    = React.useState(false);
  const [msg,       setMsg]       = React.useState('');
  const [form, setForm] = React.useState({
    session_type:'day', start_date:'', end_date:'',
    start_hour:'8', end_hour:'17', note:''
  });

  const HOURS = Array.from({length:24},(_,i)=>i);
  const fmt12 = (h:number) => {
    const ap=h<12?'AM':'PM'; const h12=h===0?12:h>12?h-12:h;
    return `${h12}:00 ${ap}`;
  };

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/data/nets/hours`, { headers: hdr() });
      const j = await r.json();
      if (j.data) setOverrides(j.data);
    } catch {} finally { setLoading(false); }
  }, [base]);

  React.useEffect(() => { load(); }, []);

  const add = async () => {
    if (!form.start_date||!form.end_date) { setMsg('Start and end dates required'); return; }
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/hours`, {
        method:'POST', headers: hdr(),
        body: JSON.stringify({
          session_type:form.session_type, start_date:form.start_date,
          end_date:form.end_date, start_hour:parseInt(form.start_hour),
          end_hour:parseInt(form.end_hour), note:form.note,
        })
      });
      const j = await r.json();
      if (r.ok) { setMsg('Override scheduled'); load(); setForm(f=>({...f,start_date:'',end_date:'',note:''})); }
      else setMsg(j.error||'Error');
    } catch { setMsg('Error'); }
    finally { setSaving(false); }
  };

  const deactivate = async (id:number) => {
    if (!confirm('Deactivate this override?')) return;
    try {
      await fetch(`${base}/api/data/nets/hours/${id}/deactivate`, {method:'POST',headers:hdr()});
      load();
    } catch {}
  };

  return (
    <div style={{padding:'12px 0'}}>
      <div style={{backgroundColor:'#eff6ff',borderRadius:10,padding:10,marginBottom:12,border:'1px solid #bfdbfe'}}>
        <div style={{fontSize:11,color:'#1d4ed8',lineHeight:1.5}}>
          Default: Daylight 8:30AM-3:30PM (Mon 6:30AM-5:30PM) · Flood-lit 6:30PM-10:30PM. Override replaces hours for date range only.
        </div>
      </div>

      <div style={{backgroundColor:C.card,borderRadius:12,padding:14,marginBottom:12,border:`1px solid ${C.border}`}}>
        <div style={{fontWeight:800,fontSize:12,color:C.navy,marginBottom:10,textTransform:'uppercase' as const}}>Schedule Override</div>

        <select value={form.session_type} onChange={e=>setForm(f=>({...f,session_type:e.target.value}))}
          style={{width:'100%',padding:'9px',borderRadius:8,marginBottom:8,border:`1px solid ${C.border}`,fontSize:13,outline:'none',boxSizing:'border-box' as const}}>
          <option value="day">☀️ Daylight</option>
          <option value="night">🌙 Flood-lit</option>
        </select>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:3}}>START DATE</div>
            <input type="date" value={form.start_date} onChange={e=>setForm(f=>({...f,start_date:e.target.value}))}
              style={{width:'100%',padding:'7px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:12,outline:'none',boxSizing:'border-box' as const}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:3}}>END DATE</div>
            <input type="date" value={form.end_date} onChange={e=>setForm(f=>({...f,end_date:e.target.value}))}
              style={{width:'100%',padding:'7px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:12,outline:'none',boxSizing:'border-box' as const}}/>
          </div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:3}}>FROM</div>
            <select value={form.start_hour} onChange={e=>setForm(f=>({...f,start_hour:e.target.value}))}
              style={{width:'100%',padding:'7px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:12,outline:'none',boxSizing:'border-box' as const}}>
              {HOURS.map(h=><option key={h} value={h}>{fmt12(h)}</option>)}
            </select>
          </div>
          <div>
            <div style={{fontSize:10,color:C.muted,marginBottom:3}}>TO (last slot)</div>
            <select value={form.end_hour} onChange={e=>setForm(f=>({...f,end_hour:e.target.value}))}
              style={{width:'100%',padding:'7px',borderRadius:8,border:`1px solid ${C.border}`,fontSize:12,outline:'none',boxSizing:'border-box' as const}}>
              {HOURS.map(h=><option key={h} value={h}>{fmt12(h)}</option>)}
            </select>
          </div>
        </div>

        <input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}
          placeholder="Note (optional)" style={{width:'100%',padding:'8px',borderRadius:8,marginBottom:10,
            border:`1px solid ${C.border}`,fontSize:12,outline:'none',boxSizing:'border-box' as const}}/>

        {msg && <div style={{fontSize:12,color:msg.includes('scheduled')?'#16a34a':C.red,marginBottom:8}}>{msg}</div>}
        <button onClick={add} disabled={saving}
          style={{width:'100%',padding:11,borderRadius:10,border:'none',backgroundColor:C.navy,
            color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer'}}>
          {saving?'Scheduling...':'Schedule Override'}
        </button>
      </div>

      <div style={{fontWeight:700,fontSize:11,color:C.muted,textTransform:'uppercase' as const,letterSpacing:'1px',marginBottom:8}}>Scheduled Overrides</div>
      {loading && <div style={{textAlign:'center',padding:20,color:C.muted}}>Loading...</div>}
      {!loading && overrides.length===0 && (
        <div style={{textAlign:'center',padding:20,color:C.muted,fontSize:13}}>No overrides — default hours apply</div>
      )}
      {overrides.map((o:any) => (
        <div key={o.id} style={{backgroundColor:C.card,borderRadius:10,padding:'12px 14px',marginBottom:8,
          border:`1px solid ${C.border}`,opacity:o.is_active?1:0.5}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>
                <span>{o.session_type==='day'?'☀️':'🌙'}</span>
                <span style={{fontWeight:700,fontSize:13}}>{o.session_type==='day'?'Daylight':'Flood-lit'}</span>
                <span style={{fontSize:10,padding:'1px 6px',borderRadius:10,
                  backgroundColor:o.is_active?'#dcfce7':'#f3f4f6',
                  color:o.is_active?'#16a34a':C.muted,fontWeight:700}}>
                  {o.is_active?'Active':'Inactive'}
                </span>
              </div>
              <div style={{fontSize:11,color:C.muted}}>📅 {o.start_date} → {o.end_date}</div>
              <div style={{fontSize:11,color:C.muted}}>⏰ {fmt12(o.start_hour)} – {fmt12(o.end_hour)}</div>
              {o.note && <div style={{fontSize:11,color:C.muted}}>{o.note}</div>}
            </div>
            {o.is_active && (
              <button onClick={()=>deactivate(o.id)}
                style={{padding:'5px 10px',borderRadius:8,border:`1px solid ${C.red}`,
                  backgroundColor:'#fef2f2',color:C.red,fontWeight:700,fontSize:11,cursor:'pointer'}}>
                Deactivate
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsTab() {
  const base = bld();
  const [pricing,   setPricing]  = React.useState<any[]>([]);
  const [settings,  setSettings] = React.useState<Record<string,string>>({});
  const [loading,   setLoading]  = React.useState(true);
  const [editingId, setEditingId]= React.useState<number|null>(null);
  const [editAmt,   setEditAmt]  = React.useState('');
  const [editKey,   setEditKey]  = React.useState<string|null>(null);
  const [editVal,   setEditVal]  = React.useState('');
  const [saving,    setSaving]   = React.useState(false);
  const [msg,       setMsg]      = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [rp, rs] = await Promise.all([
        fetch(`${base}/api/data/nets/pricing`, { headers: hdr() }),
        fetch(`${base}/api/data/nets/settings`, { headers: hdr() }),
      ]);
      const jp = await rp.json();
      const js = await rs.json();
      const day   = jp?.data?.day_prices   || [];
      const night = jp?.data?.night_prices || [];
      setPricing([...day, ...night]);
      setSettings(js?.data?.settings || {});
    } catch {} finally { setLoading(false); }
  }, [base]);

  React.useEffect(() => { load(); }, []);

  const startEdit = (p: any) => { setEditingId(p.id); setEditAmt(String(p.amount)); setMsg(''); };

  const savePrice = async (id: number) => {
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/pricing`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ price_id: id, amount: parseInt(editAmt)||0 })
      });
      if (r.ok) { setMsg('✓ Saved'); setEditingId(null); load(); }
      else setMsg('Error');
    } catch { setMsg('Error'); } finally { setSaving(false); }
  };

  const saveSetting = async (key: string) => {
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`${base}/api/data/nets/settings`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ [key]: editVal })
      });
      if (r.ok) { setMsg('✓ Saved'); setEditKey(null); load(); }
      else setMsg('Error');
    } catch { setMsg('Error'); } finally { setSaving(false); }
  };

  if (loading) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',padding:60}}>
      <div style={{textAlign:'center',color:C.muted}}>
        <div style={{fontSize:32,marginBottom:8}}>⚙️</div>
        <div style={{fontWeight:600}}>Loading settings...</div>
      </div>
    </div>
  );

  const day   = pricing.filter(p => p.session_type === 'day');
  const night = pricing.filter(p => p.session_type === 'night');

  const SETTING_LABELS: Record<string,{label:string,icon:string}> = {
    net_access_code:         { label:'Access Code',           icon:'🔐' },
    net_booking_days_ahead:  { label:'Days Ahead Allowed',    icon:'📅' },
    net_max_active_bookings: { label:'Max Active Bookings',   icon:'📋' },
    net_cancel_hours:        { label:'Cancel Before (hours)', icon:'⏱' },
  };

  const PriceRow = ({ p }: { p: any }) => {
    const editing = editingId === p.id;
    return (
      <div style={{display:'flex',alignItems:'center',gap:10,
        padding:'10px 0',borderBottom:`1px solid ${C.border}`}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,color:'#111',fontWeight:500,
            overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
            {p.label}
          </div>
        </div>
        {editing ? (
          <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
            <span style={{fontSize:11,color:C.muted}}>Rs.</span>
            <input autoFocus type="number" value={editAmt}
              onChange={e=>setEditAmt(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') savePrice(p.id); if(e.key==='Escape') setEditingId(null); }}
              style={{width:80,padding:'5px 8px',borderRadius:6,
                border:`2px solid ${C.navy}`,fontSize:13,fontWeight:700,
                outline:'none',textAlign:'right' as const}}/>
            <button onClick={()=>savePrice(p.id)} disabled={saving}
              style={{padding:'5px 12px',borderRadius:6,border:'none',
                backgroundColor:C.navy,color:'#fff',fontWeight:700,
                fontSize:12,cursor:'pointer'}}>
              {saving?'...':'✓'}
            </button>
            <button onClick={()=>setEditingId(null)}
              style={{padding:'5px 8px',borderRadius:6,
                border:`1px solid ${C.border}`,backgroundColor:'#fff',
                color:C.muted,fontWeight:700,fontSize:12,cursor:'pointer'}}>
              ✕
            </button>
          </div>
        ) : (
          <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
            <span style={{fontWeight:800,fontSize:14,color:C.navy}}>
              Rs.{p.amount.toLocaleString()}
            </span>
            <button onClick={()=>startEdit(p)}
              style={{padding:'4px 10px',borderRadius:6,
                border:`1px solid ${C.border}`,backgroundColor:'#f8fafc',
                color:C.muted,fontSize:11,fontWeight:600,cursor:'pointer'}}>
              Edit
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{padding:'12px 0'}}>
      {msg && (
        <div style={{backgroundColor:msg.startsWith('✓')?'#f0fdf4':'#fef2f2',
          borderRadius:10,padding:'8px 14px',marginBottom:12,
          color:msg.startsWith('✓')?'#16a34a':C.red,fontSize:13,fontWeight:600}}>
          {msg}
        </div>
      )}

      {/* General Settings */}
      <div style={{backgroundColor:C.card,borderRadius:14,marginBottom:14,
        border:`1px solid ${C.border}`,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',backgroundColor:'#f8fafc',
          borderBottom:`1px solid ${C.border}`,
          display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:16}}>⚙️</span>
          <span style={{fontWeight:800,fontSize:13,color:C.navy,
            textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>
            General Settings
          </span>
        </div>
        <div style={{padding:'0 16px'}}>
          {Object.entries(settings).map(([key, val]) => {
            const meta = SETTING_LABELS[key] || { label: key, icon: '•' };
            const editing = editKey === key;
            return (
              <div key={key} style={{display:'flex',alignItems:'center',gap:10,
                padding:'12px 0',borderBottom:`1px solid ${C.border}`}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:C.muted,fontWeight:600,
                    textTransform:'uppercase' as const,letterSpacing:'0.5px',marginBottom:2}}>
                    {meta.icon} {meta.label}
                  </div>
                  {editing ? (
                    <input autoFocus value={editVal} onChange={e=>setEditVal(e.target.value)}
                      style={{width:'100%',padding:'6px 8px',borderRadius:6,
                        border:`2px solid ${C.navy}`,fontSize:14,fontWeight:700,
                        outline:'none',boxSizing:'border-box' as const}}/>
                  ) : (
                    <div style={{fontSize:14,fontWeight:700,color:'#111'}}>{val}</div>
                  )}
                </div>
                {editing ? (
                  <div style={{display:'flex',gap:6,flexShrink:0}}>
                    <button onClick={()=>saveSetting(key)} disabled={saving}
                      style={{padding:'6px 12px',borderRadius:6,border:'none',
                        backgroundColor:C.navy,color:'#fff',fontWeight:700,
                        fontSize:12,cursor:'pointer'}}>
                      {saving?'...':'Save'}
                    </button>
                    <button onClick={()=>setEditKey(null)}
                      style={{padding:'6px 10px',borderRadius:6,
                        border:`1px solid ${C.border}`,backgroundColor:'#fff',
                        color:C.muted,fontWeight:700,fontSize:12,cursor:'pointer'}}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <button onClick={()=>{ setEditKey(key); setEditVal(val); setMsg(''); }}
                    style={{padding:'5px 12px',borderRadius:6,
                      border:`1px solid ${C.border}`,backgroundColor:'#f8fafc',
                      color:C.muted,fontSize:11,fontWeight:600,
                      cursor:'pointer',flexShrink:0}}>
                    Edit
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Day Pricing */}
      <div style={{backgroundColor:C.card,borderRadius:14,marginBottom:14,
        border:`1px solid ${C.border}`,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',
          background:'linear-gradient(135deg,#f59e0b,#d97706)',
          display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:16}}>☀️</span>
          <span style={{fontWeight:800,fontSize:13,color:'#fff',
            textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>
            Day Session Pricing
          </span>
        </div>
        <div style={{padding:'0 16px'}}>
          {day.map(p => <PriceRow key={p.id} p={p}/>)}
        </div>
      </div>

      {/* Night Pricing */}
      <div style={{backgroundColor:C.card,borderRadius:14,
        border:`1px solid ${C.border}`,overflow:'hidden'}}>
        <div style={{padding:'12px 16px',
          background:'linear-gradient(135deg,#1e3a5f,#0d1b2a)',
          display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:16}}>🌙</span>
          <span style={{fontWeight:800,fontSize:13,color:'#fff',
            textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>
            Night Session Pricing
          </span>
        </div>
        <div style={{padding:'0 16px'}}>
          {night.map(p => <PriceRow key={p.id} p={p}/>)}
        </div>
      </div>
    </div>
  );
}



// ── Main Screen ───────────────────────────────────────────────────────
type Tab = 'members' | 'blocks' | 'announce' | 'hours' | 'settings';

export default function NetsAdminScreen() {
  const navigate  = useNavigate();
  const { can }   = usePermissions();
  const canAdmin  = can('nets:admin' as any);
  const [tab, setTab] = useState<Tab>('members');

  if (!canAdmin) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: C.muted }}>
        Admin access required.
      </div>
    );
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'members',  label: '👥 Members'  },
    { id: 'blocks',   label: '🔒 Blocks'   },
    { id: 'announce', label: '📢 Notices'  },
    { id: 'hours',    label: '⏰ Hours'    },
    { id: 'settings', label: '⚙️ Settings' },
  ];

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 48 }}>
      <ScreenHeader background={`linear-gradient(150deg, ${C.navy}, #1a2f4a)`}
        title={<>⚙️ Nets <span style={{ color: C.gold }}>Admin</span></>}
        subtitle={<span style={{ color: C.gold, fontWeight: 700, letterSpacing: '1px', fontSize: 10 }}>NET BOOKING</span>}>
        <HeaderTabs color={C.navy} value={tab} onChange={setTab} tabs={TABS} />
      </ScreenHeader>

      <div style={{ padding: '0 16px' }}>
        {tab === 'members'  && <MembersTab/>}
        {tab === 'blocks'   && <BlocksTab/>}
        {tab === 'announce' && <AnnouncementsTab/>}
        {tab === 'hours'    && <HoursTab/>}
        {tab === 'settings' && <SettingsTab/>}
      </div>
    </div>
  );
}
