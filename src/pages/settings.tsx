import React, { useEffect, useState } from 'react';
import { PinSettings } from './AppLock';
import { fullRefreshFromServer } from './useSyncService';
import type { RefreshProgress } from './useSyncService';
import { useNavigate } from 'react-router-dom';
import { saveUserContext, getRoleLabel } from './usePermissions';
import BiometricSection from './BiometricSection';
import ScreenHeader from '../shared/ScreenHeader';
import { APP_VERSION, BUILD_NUMBER } from '../shared/version';

const C = { green: '#1a472a', gold: '#d4af37', border: '#e0e0e0', gray: '#888', red: '#c0392b', navy: '#001f3f', muted: '#6b7280' };

export function buildServerUrl(): string {
  const proto = localStorage.getItem('server_proto') || 'http';
  const host  = localStorage.getItem('server_host')  || '';
  const portRaw = localStorage.getItem('server_port');
  const port    = portRaw === null ? '3125' : portRaw;
  if (!host) return '';
  const portStr = !port || (proto === 'https' && port === '443') || (proto === 'http' && port === '80') ? '' : `:${port}`;
  return `${proto}://${host}${portStr}`;
}

export default function SettingsScreen() {
  const navigate = useNavigate();
  const [proto,  setProto]  = useState('http');
  const [host,   setHost]   = useState('');
  const [port,   setPort]   = useState('3125');
  const [user,   setUser]   = useState('');
  const [pass,   setPass]   = useState(() => {
    const p = localStorage.getItem('auth_pass') || '';
    if (p && !p.includes(' ') && !p.includes('@') && p.length > 8) {
      try {
        const decoded = decodeURIComponent(escape(atob(p)));
        if (/^[ -~]+$/.test(decoded)) { localStorage.setItem('auth_pass', decoded); return decoded; }
      } catch {}
    }
    return p;
  });
  const [secret, setSecret] = useState('');
  const [msg,    setMsg]    = useState('');
  const [testing,     setTesting]     = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  const [refreshProg, setRefreshProg] = useState<RefreshProgress|null>(null);
  const [refreshDone, setRefreshDone] = useState('');
  const [refreshConf, setRefreshConf] = useState(false);
  const [showPass,    setShowPass]    = useState(false);
  const [showSecret,  setShowSecret]  = useState(false);
  const [newPass,     setNewPass]     = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [showNewPass, setShowNewPass] = useState(false);
  const [pwdSaving,   setPwdSaving]   = useState(false);
  const [pwdMsg,      setPwdMsg]      = useState('');
  const [roleDisplay, setRoleDisplay] = useState(() => {
    const stored = localStorage.getItem('user_permissions');
    if (!stored || stored === '[]') return '';
    return getRoleLabel();
  });
  const [emailConfig, setEmailConfig] = useState<{channel:string;enabled:boolean}>(() => {
    try { return JSON.parse(localStorage.getItem('notif_email_config') || 'null') || { channel:'none', enabled:false }; }
    catch { return { channel:'none', enabled:false }; }
  });
  const [waConfig, setWaConfig] = useState<{enabled:boolean}>(() => {
    try { return JSON.parse(localStorage.getItem('notif_wa_config') || 'null') || { enabled:false }; }
    catch { return { enabled:false }; }
  });
  const [notifToggles, setNotifToggles] = useState<Record<string,string>>(() => ({
    email_enabled: localStorage.getItem('notif_email_enabled') ?? '1',
    wa_enabled:    localStorage.getItem('notif_wa_enabled')    ?? '1',
  }));
  const [academyName, setAcademyName] = useState(localStorage.getItem('academy_name') || 'Quickies Cricket Club');
  const hasJwt = !!localStorage.getItem('jwt_token');
  // What is stored now — the server card shows "unsaved" when the fields differ
  const [saved, setSaved] = useState(() => ({
    proto: localStorage.getItem('server_proto') || 'http',
    host:  localStorage.getItem('server_host')  || '',
    port:  localStorage.getItem('server_port')  || 'none',
  }));
  const norm = (p: string) => (!p || p === 'none' ? '' : p.trim());
  const dirty = proto !== saved.proto || host.trim() !== saved.host || norm(port) !== norm(saved.port);

  useEffect(() => {
    setProto(localStorage.getItem('server_proto') || 'http');
    setHost( localStorage.getItem('server_host')  || '');
    setPort( localStorage.getItem('server_port')  || 'none');
    setUser( localStorage.getItem('auth_user')    || '');
    setPass( localStorage.getItem('auth_pass')    || '');
    setSecret(localStorage.getItem('secret_key')  || '');
  }, []);

  const previewUrl = () => {
    if (!host.trim()) return '—';
    const skipPort = !port || port === 'none' || (proto === 'https' && port === '443') || (proto === 'http' && port === '80');
    const p = skipPort ? '' : `:${port}`;
    return `${proto}://${host.trim()}${p}`;
  };

  const getHdr = () => {
    const jwt = localStorage.getItem('jwt_token');
    const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
    if (jwt && Date.now() < exp - 60000) {
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt, 'X-Username': localStorage.getItem('auth_user') || '' };
    }
    return { 'Content-Type': 'application/json', 'X-Username': localStorage.getItem('auth_user') || '', 'X-Password': localStorage.getItem('auth_pass') || '' };
  };

  const save = () => {
    if (!host.trim()) { setMsg('⚠ Enter server host'); return; }
    localStorage.setItem('server_proto', proto);
    localStorage.setItem('server_host',  host.trim());
    localStorage.setItem('server_port',  port === 'none' ? '' : (port.trim() || ''));
    localStorage.setItem('auth_user',    user.trim());
    if (!hasJwt) {
      localStorage.setItem('auth_pass',  pass);
      localStorage.setItem('secret_key', secret);
    }
    localStorage.setItem('server_ip', previewUrl());
    setSaved({ proto, host: host.trim(), port });
    setMsg('✔ Settings saved');
    setTimeout(() => setMsg(''), 3000);
  };

  const changePassword = async () => {
    setPwdMsg('');
    if (!newPass) { setPwdMsg('⚠ Please enter a new password'); return; }
    if (newPass.length < 8) { setPwdMsg('⚠ Password must be at least 8 characters'); return; }
    if (!/[A-Z]/.test(newPass)) { setPwdMsg('⚠ Must contain uppercase letter'); return; }
    if (!/[a-z]/.test(newPass)) { setPwdMsg('⚠ Must contain lowercase letter'); return; }
    if (!/[0-9]/.test(newPass)) { setPwdMsg('⚠ Must contain a number'); return; }
    if (!/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(newPass)) { setPwdMsg('⚠ Must contain a special character'); return; }
    if (newPass !== confirmPass) { setPwdMsg('⚠ Passwords do not match'); return; }
    const base = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
    if (!base) { setPwdMsg('⚠ Server not configured'); return; }
    const token = localStorage.getItem('jwt_token') || '';
    if (!token) { setPwdMsg('⚠ Not logged in — please logout and login again'); return; }
    setPwdSaving(true);
    try {
      const res = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token, old_password: '', new_password: newPass }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setPwdMsg('⚠ ' + (j.error || 'Password change failed')); return; }
      // The password is never stored on the device — the JWT stays valid
      setNewPass(''); setConfirmPass('');
      setPwdMsg('✅ Password changed successfully');
      setTimeout(() => setPwdMsg(''), 4000);
    } catch (e: any) { setPwdMsg('⚠ ' + (e.message || 'Network error')); }
    finally { setPwdSaving(false); }
  };

  const testConn = async () => {
    setTesting(true); setMsg('Testing connection…');
    const base = previewUrl();
    if (!base || base === '—') { setMsg('⚠ Enter server host first'); setTesting(false); return; }
    try {
      const res = await Promise.race([
        fetch(`${base}/api/data/ping`, { method: 'GET', mode: 'cors', headers: getHdr() }),
        new Promise<never>((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 10000)),
      ]) as Response;
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const rawRole = j.role || 'viewer';
        const slugs = j.permissions || [];
        saveUserContext({ permissions: slugs, role: rawRole, user_type: j.user_type || 'staff',
          user_id: j.user_id || 0, linked_student_ids: j.linked_student_ids || [],
          is_restricted: j.is_restricted || false, authenticated_as: j.authenticated_as });
        if (j.email_config) { setEmailConfig(j.email_config); localStorage.setItem('notif_email_config', JSON.stringify(j.email_config)); }
        if (j.wa_config)    { setWaConfig(j.wa_config);       localStorage.setItem('notif_wa_config',    JSON.stringify(j.wa_config)); }
        fetch(`${base}/api/data/reminders/config`, { headers: getHdr() })
          .then(r => r.ok ? r.json() : null).then(cfg => {
            if (!cfg) return;
            const t = { email_enabled: cfg.config?.email_enabled ?? localStorage.getItem('notif_email_enabled') ?? '1',
                        wa_enabled:    cfg.config?.wa_enabled    ?? localStorage.getItem('notif_wa_enabled')    ?? '1' };
            setNotifToggles(t);
            localStorage.setItem('notif_email_enabled', t.email_enabled);
            localStorage.setItem('notif_wa_enabled',    t.wa_enabled);
          }).catch(() => {});
        const roleLabel = rawRole.charAt(0).toUpperCase() + rawRole.slice(1);
        setMsg(`✔ Connected as ${j.authenticated_as || 'user'} · Role: ${roleLabel} · ${slugs.length} permissions`);
        setRoleDisplay(roleLabel);
      } else if (res.status === 401 || res.status === 403) {
        setMsg(`⚠ Wrong credentials (${res.status})`);
      } else { setMsg(`⚠ Server error ${res.status}`); }
    } catch (e: any) {
      const m = e?.message || String(e);
      if (m === 'TIMEOUT') setMsg('✖ Timeout — server not reachable');
      else if (m.toLowerCase().includes('failed to fetch')) setMsg('✖ Cannot reach server');
      else setMsg(`✖ ${m}`);
    }
    setTesting(false);
  };

  const base = (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');
  const isAdmin = (localStorage.getItem('user_role') || '').toLowerCase() === 'admin';

  // ── Shared look (same tokens as Sync / Payments) ──
  const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:'1px solid #e8e8e8', overflow:'hidden' };
  const F: React.CSSProperties = { width:'100%', borderRadius:8, border:`1px solid ${C.border}`, padding:'8px 10px', fontSize:14, boxSizing:'border-box' as const, backgroundColor:'#fff', outline:'none' };
  const L: React.CSSProperties = { fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:4, display:'block' };
  const Section = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase' as const, margin:'6px 2px 0' }}>{children}</div>
  );
  const Hair = () => <div style={{ height:1, backgroundColor:'#e8e8e8', marginLeft:48 }} />;
  const seg = (active: boolean): React.CSSProperties => ({
    flex:1, height:28, borderRadius:6, border:'none', cursor:'pointer', fontWeight:700, fontSize:12,
    backgroundColor: active ? '#fff' : 'transparent', color: active ? C.green : C.muted,
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
  });
  const Toggle = ({ on, disabled, onClick, label }: { on:boolean; disabled?:boolean; onClick:()=>void; label:string }) => (
    <button onClick={onClick} disabled={disabled} role="switch" aria-checked={on} aria-label={label}
      style={{ position:'relative', width:44, height:24, borderRadius:12, border:'none', flexShrink:0,
        cursor: disabled ? 'not-allowed' : 'pointer', backgroundColor: on && !disabled ? C.green : '#d1d5db', transition:'background-color 0.2s' }}>
      <span style={{ position:'absolute', top:3, left: on ? 23 : 3, width:18, height:18, borderRadius:'50%',
        backgroundColor:'#fff', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }}/>
    </button>
  );
  const pwInput = (value: string, set: (v:string)=>void, show: boolean, toggle: (()=>void) | null, ph: string, auto?: string) => (
    <div style={{ position:'relative', display:'flex', alignItems:'center' }}>
      <input type={show?'text':'password'} value={value} onChange={e => set(e.target.value)} placeholder={ph}
        autoComplete={auto} style={{ ...F, paddingRight: toggle ? 40 : 10 }} />
      {toggle && (
        <button onClick={toggle} aria-label={show ? 'Hide' : 'Show'} style={{ position:'absolute', right:10, background:'none',
          border:'none', cursor:'pointer', fontSize:16, color:'#888', padding:0 }}>{show?'🙈':'👁'}</button>
      )}
    </div>
  );

  const roleIcon  = roleDisplay==='Admin' ? '👑' : roleDisplay==='Coach' ? '🏏' : roleDisplay ? '👁️' : '⚠';
  const roleSub   = roleDisplay==='Admin' ? 'Full access to all features'
                  : roleDisplay==='Coach' ? 'Attendance, remarks and sync'
                  : roleDisplay ? 'Read-only — ask an Admin to change your role'
                  : 'Role not loaded — tap Test to fetch it';
  const msgOk     = msg.startsWith('✔');
  const msgBusy   = msg.startsWith('Testing');

  return (
    <div style={{ backgroundColor:'#f4f7f6', minHeight:'100%', fontFamily:'sans-serif', color:'#1f2937' }}>
      <ScreenHeader title="Settings" subtitle={base || 'No server set'} />
    <div style={{ padding:'10px 10px 24px', display:'flex', flexDirection:'column', gap:8 }}>

      {/* ── Account: who you are + last connection result ── */}
      <div style={{ ...CARD, display:'flex', alignItems:'center', gap:10, padding:'9px 12px',
        boxShadow:`inset 3px 0 0 ${roleDisplay ? C.gold : '#f59e0b'}` }}>
        <span style={{ fontSize:20, width:26, textAlign:'center' }}>{roleIcon}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:800, fontSize:14 }}>
            {localStorage.getItem('auth_user') || 'Not signed in'}
            {roleDisplay && <span style={{ fontWeight:700, fontSize:12, color:C.muted }}> · {roleDisplay}</span>}
          </div>
          <div style={{ fontSize:11.5, marginTop:1, fontWeight: msg ? 700 : 400,
            color: !msg ? (roleDisplay ? C.muted : '#92400e') : msgOk ? '#166534' : msgBusy ? C.muted : C.red }}>
            {msg || roleSub}
          </div>
        </div>
      </div>

      {/* ── Server ── */}
      <Section>Server</Section>
      <div style={{ ...CARD, padding:'10px 12px' }}>
        <div style={{ display:'flex', gap:8 }}>
          <div style={{ width:118, flexShrink:0 }}>
            <label style={L}>Protocol</label>
            <div style={{ display:'flex', gap:3, padding:3, borderRadius:8, backgroundColor:'#f3f4f6' }}>
              {['http','https'].map(p => (
                <button key={p} aria-pressed={proto===p} style={seg(proto===p)}
                  onClick={() => { setProto(p); if(p==='https'&&port==='3125')setPort('443'); if(p==='http'&&port==='443')setPort('3125'); }}>
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <label style={L}>Host / IP</label>
            <input value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.97 or myserver.com"
              inputMode="url" autoCapitalize="none" style={{ ...F, height:34 }} />
          </div>
        </div>

        <label style={{ ...L, marginTop:8 }}>Port</label>
        <div style={{ display:'flex', gap:4, flexWrap:'wrap', alignItems:'center' }}>
          {[['none','Default'],['80','80'],['443','443'],['3125','3125'],['8080','8080'],['8000','8000']].map(([v,l]) => (
            <button key={v} onClick={() => setPort(v)} style={{ padding:'5px 9px', borderRadius:14, cursor:'pointer', fontWeight:700, fontSize:11.5,
              border:`1px solid ${port===v ? C.green : C.border}`, backgroundColor:port===v?C.green:'#fff', color:port===v?'#fff':'#374151' }}>{l}</button>
          ))}
          <input value={port==='none'?'':port} onChange={e => setPort(e.target.value||'none')} placeholder="custom" inputMode="numeric"
            aria-label="Custom port" style={{ ...F, width:74, padding:'5px 8px', fontSize:13 }} />
        </div>

        <div style={{ marginTop:8, padding:'6px 10px', borderRadius:8, backgroundColor:'#f5f5f5',
          fontSize:12.5, fontWeight:700, color:C.green, fontFamily:'monospace', overflowWrap:'anywhere' }}>
          {previewUrl()}
          {dirty && <span style={{ fontFamily:'sans-serif', fontSize:10.5, color:'#b45309', marginLeft:6 }}>● unsaved</span>}
        </div>

        <div style={{ display:'flex', gap:8, marginTop:8 }}>
          <button onClick={testConn} disabled={testing||!host.trim()} style={{ flex:1, padding:'9px 0', borderRadius:9,
            border:`1px solid ${C.green}`, backgroundColor:'#fff', color:C.green, fontWeight:700, fontSize:13, cursor:'pointer' }}>
            {testing ? '⏳ Testing…' : '🔌 Test'}
          </button>
          <button onClick={save} disabled={!dirty && hasJwt} style={{ flex:1, padding:'9px 0', borderRadius:9, border:'none',
            backgroundColor: !dirty && hasJwt ? '#e5e7eb' : C.green, color: !dirty && hasJwt ? C.muted : '#fff',
            fontWeight:800, fontSize:13, cursor: !dirty && hasJwt ? 'default' : 'pointer' }}>
            {!dirty && hasJwt ? '✔ Saved' : '💾 Save'}
          </button>
        </div>

        {/* Legacy username/password auth — only before the first JWT login */}
        {!hasJwt && (
          <div style={{ marginTop:10, paddingTop:10, borderTop:'1px solid #e8e8e8', display:'flex', flexDirection:'column', gap:8 }}>
            <div>
              <label style={L}>Username</label>
              <input value={user} onChange={e => setUser(e.target.value)} placeholder="Username" autoCapitalize="none" style={F} />
            </div>
            <div>
              <label style={L}>Password</label>
              {pwInput(pass, setPass, showPass, () => setShowPass(v => !v), 'Password')}
            </div>
            <div>
              <label style={L}>API secret key</label>
              {pwInput(secret, setSecret, showSecret, () => setShowSecret(v => !v), 'API secret key')}
            </div>
          </div>
        )}
      </div>

      {/* ── Security ── */}
      <Section>Security</Section>
      <div style={CARD}>
        <BiometricSection />
        <Hair />
        <PinSettings />
        <Hair />
        <details>
          <summary style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px', cursor:'pointer', listStyle:'none' }}>
            <span style={{ fontSize:18, width:26, textAlign:'center' }}>🔒</span>
            <span style={{ flex:1, minWidth:0 }}>
              <span style={{ display:'block', fontWeight:800, fontSize:13.5 }}>Change password</span>
              <span style={{ display:'block', fontSize:11.5, color:C.muted }}>For your login on all devices</span>
            </span>
            <span style={{ color:C.muted, fontSize:16 }}>›</span>
          </summary>
          <div style={{ padding:'0 12px 12px 48px', display:'flex', flexDirection:'column', gap:8 }}>
            {pwInput(newPass, setNewPass, showNewPass, () => setShowNewPass(v => !v), 'New password', 'new-password')}
            {pwInput(confirmPass, setConfirmPass, showNewPass, null, 'Re-enter new password', 'new-password')}
            <div style={{ fontSize:11, color:C.muted }}>8+ characters with upper and lower case, a number and a symbol</div>
            {pwdMsg && (
              <div style={{ fontSize:12, color: pwdMsg.startsWith('✅') ? C.green : C.red, fontWeight:700 }}>{pwdMsg}</div>
            )}
            <button onClick={changePassword} disabled={pwdSaving}
              style={{ padding:'9px 0', borderRadius:9, border:'none', backgroundColor: pwdSaving ? '#9ca3af' : C.green,
                color:'#fff', fontWeight:800, fontSize:13, cursor: pwdSaving ? 'not-allowed' : 'pointer' }}>
              {pwdSaving ? '⏳ Updating…' : 'Change password'}
            </button>
          </div>
        </details>
      </div>

      {/* ── Academy & notifications ── */}
      <Section>Academy &amp; notifications</Section>
      <div style={CARD}>
        <div style={{ padding:'9px 12px' }}>
          <label style={L}>Academy name</label>
          <input value={academyName} placeholder="Quickies Cricket Club"
            onChange={e => { setAcademyName(e.target.value); localStorage.setItem('academy_name', e.target.value.trim() || 'Quickies Cricket Club'); }}
            style={F} />
        </div>
        {isAdmin && [
          { key:'email_enabled', icon:'📧', label:'Email receipts', sub: emailConfig.enabled ? `via ${emailConfig.channel === 'zoho' ? 'Zoho Mail' : 'Resend'}` : 'Not set up on the server', available: emailConfig.enabled },
          { key:'wa_enabled',    icon:'💬', label:'WhatsApp',       sub: waConfig.enabled ? 'via Meta API' : 'Not set up on the server', available: waConfig.enabled },
        ].map(item => {
          const isOn = notifToggles[item.key] === '1';
          return (
            <React.Fragment key={item.key}>
              <Hair />
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px' }}>
                <span style={{ fontSize:18, width:26, textAlign:'center' }}>{item.icon}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13.5, fontWeight:800 }}>{item.label}</div>
                  <div style={{ fontSize:11.5, color: item.available ? C.muted : '#b45309' }}>{item.sub}</div>
                </div>
                <Toggle on={isOn && item.available} disabled={!item.available} label={item.label}
                  onClick={() => {
                    if (!item.available) return;
                    const updated = { ...notifToggles, [item.key]: isOn ? '0' : '1' };
                    setNotifToggles(updated);
                    localStorage.setItem('notif_email_enabled', updated.email_enabled);
                    localStorage.setItem('notif_wa_enabled',    updated.wa_enabled);
                    fetch(`${base}/api/data/reminders/config`, { method:'POST', headers:{...getHdr(),'Content-Type':'application/json'}, body: JSON.stringify(updated) }).catch(() => {});
                  }} />
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Data ── */}
      <Section>Data on this device</Section>
      <div style={{ ...CARD, padding:'9px 12px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:18, width:26, textAlign:'center' }}>♻️</span>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:800, fontSize:13.5, color: roleDisplay ? '#1f2937' : '#9ca3af' }}>Full refresh</div>
            <div style={{ fontSize:11.5, color:C.muted }}>
              {roleDisplay ? `Clear this device and re-download everything for ${roleDisplay}` : 'Tap Test first to load your role'}
            </div>
          </div>
          {!refreshing && !refreshConf && (
            <button disabled={!roleDisplay} onClick={() => { setRefreshConf(true); setRefreshDone(''); }}
              style={{ flexShrink:0, padding:'7px 12px', borderRadius:9, border:'none', fontWeight:800, fontSize:12.5,
                backgroundColor: roleDisplay ? C.green : '#e5e7eb', color: roleDisplay ? '#fff' : '#9ca3af',
                cursor: roleDisplay ? 'pointer' : 'not-allowed' }}>
              Refresh
            </button>
          )}
        </div>

        {refreshConf && !refreshing && (
          <div style={{ marginTop:8, marginLeft:36 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'#92400e', backgroundColor:'#fffbeb', border:'1px solid #fcd34d',
              padding:'7px 10px', borderRadius:8, marginBottom:8 }}>
              ⚠ Everything stored on this device is deleted and downloaded again. Unsynced attendance is lost — upload it first.
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => setRefreshConf(false)} style={{ flex:1, padding:'9px', borderRadius:9, border:`1px solid ${C.border}`,
                backgroundColor:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>Cancel</button>
              <button onClick={async () => {
                setRefreshConf(false); setRefreshing(true); setRefreshDone('');
                setRefreshProg({ stage:'Starting…', current:0, total:0, done:false });
                const result = await fullRefreshFromServer(p => setRefreshProg(p));
                setRefreshing(false); setRefreshProg(null);
                setRefreshDone(result.ok ? '✅ Complete — local data now matches server' : `⚠ ${result.error || 'Failed'}`);
              }} style={{ flex:2, padding:'9px', borderRadius:9, border:'none', backgroundColor:C.red, color:'#fff',
                fontSize:13, fontWeight:800, cursor:'pointer' }}>Yes, clear and refresh</button>
            </div>
          </div>
        )}

        {refreshing && refreshProg && (
          <div style={{ marginTop:8, marginLeft:36 }}>
            <div style={{ fontSize:12.5, fontWeight:700, color:'#166534', marginBottom:5 }}>{refreshProg.done ? '✅ Complete!' : `⏳ ${refreshProg.stage}`}</div>
            <div style={{ backgroundColor:'#dcfce7', borderRadius:6, height:6, overflow:'hidden' }}>
              <div style={{ height:'100%', backgroundColor:C.green, borderRadius:6, transition:'width 0.4s ease',
                width: refreshProg.total > 0 ? `${Math.min(100, Math.round(refreshProg.current/refreshProg.total*100))}%` : '60%' }} />
            </div>
          </div>
        )}

        {refreshDone && !refreshing && (
          <div style={{ marginTop:8, marginLeft:36, borderRadius:8, padding:'7px 10px', fontSize:12.5, fontWeight:700,
            backgroundColor: refreshDone.startsWith('✅') ? '#dcfce7' : '#fee2e2', color: refreshDone.startsWith('✅') ? '#166534' : '#dc2626' }}>
            {refreshDone}
          </div>
        )}
      </div>

      <div style={{ textAlign:'center', fontSize:11, color:'#9ca3af', marginTop:6 }}>
        QCA v{APP_VERSION} · build {BUILD_NUMBER}
      </div>
    </div>
    </div>
  );
}
