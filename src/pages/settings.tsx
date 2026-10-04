import React, { useEffect, useState } from 'react';
import { PinSettings } from './AppLock';
import { fullRefreshFromServer } from './useSyncService';
import type { RefreshProgress } from './useSyncService';
import { useNavigate } from 'react-router-dom';
import { saveUserContext, getRoleLabel } from './usePermissions';
import BiometricSection from './BiometricSection';
import ScreenHeader from '../shared/ScreenHeader';

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
      localStorage.setItem('auth_pass', newPass);
      setPass(newPass); setNewPass(''); setConfirmPass('');
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

  const F: React.CSSProperties = { width:'100%', borderRadius:8, border:`1px solid ${C.border}`, padding:'10px 12px', fontSize:15, boxSizing:'border-box' as const, backgroundColor:'#fff' };
  const L: React.CSSProperties = { fontSize:11, fontWeight:800, color:C.green, textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:6, display:'block' };
  const base = (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');

  return (
    <div style={{ backgroundColor:'#f4f7f6', minHeight:'100vh', fontFamily:'sans-serif' }}>
      <ScreenHeader title="⚙ Settings" />
    <div style={{ padding:'16px 16px 60px' }}>

      {msg && (
        <div style={{ padding:'10px 14px', borderRadius:10, marginBottom:8, fontSize:13, fontWeight:600,
          backgroundColor: msg.startsWith('✔') ? '#e8f5e9' : '#fdecea',
          color: msg.startsWith('✔') ? '#27ae60' : C.red, borderLeft:`4px solid ${msg.startsWith('✔') ? '#27ae60' : C.red}` }}>
          {msg}
        </div>
      )}

      {roleDisplay && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:10, marginBottom:16,
          backgroundColor: roleDisplay==='Admin'?'#fef3c7':roleDisplay==='Coach'?'#dcfce7':'#f3f4f6',
          border:'1px solid ' + (roleDisplay==='Admin'?'#fcd34d':roleDisplay==='Coach'?'#86efac':'#d1d5db') }}>
          <span style={{ fontSize:22 }}>{roleDisplay==='Admin'?'👑':roleDisplay==='Coach'?'🏏':'👁️'}</span>
          <div>
            <div style={{ fontWeight:800, fontSize:13, color:roleDisplay==='Admin'?'#92400e':roleDisplay==='Coach'?'#166534':'#374151' }}>
              Your Role: {roleDisplay}
            </div>
            <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>
              {roleDisplay==='Admin'?'Full access to all features':roleDisplay==='Coach'?'Can mark attendance, add remarks, sync data':'Read-only — contact Admin to update your role'}
            </div>
          </div>
        </div>
      )}

      {!roleDisplay && (
        <div style={{ padding:'8px 12px', borderRadius:8, marginBottom:12, backgroundColor:'#fef3c7', fontSize:12, color:'#92400e', fontWeight:600 }}>
          ⚠ Role not loaded — tap Test Connection to fetch your role from server
        </div>
      )}

      {/* Server Connection */}
      <div style={{ backgroundColor:'#fff', borderRadius:14, padding:'16px', marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ fontWeight:800, fontSize:14, color:C.green, marginBottom:14 }}>🌐 Server Connection</div>
        <div style={{ marginBottom:12 }}>
          <label style={L}>Protocol</label>
          <div style={{ display:'flex', gap:8 }}>
            {['http','https'].map(p => (
              <button key={p} onClick={() => { setProto(p); if(p==='https'&&port==='3125')setPort('443'); if(p==='http'&&port==='443')setPort('3125'); }}
                style={{ flex:1, padding:'10px 0', borderRadius:10, border:'none', cursor:'pointer', fontWeight:700, fontSize:14, backgroundColor:proto===p?C.green:'#f0f0f0', color:proto===p?'#fff':'#555' }}>
                {p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={L}>Server Host / IP</label>
          <input value={host} onChange={e => setHost(e.target.value)} placeholder="e.g. 192.168.1.97  or  myserver.com" style={F} />
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={L}>Port</label>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {[['none','Default'],['80','80'],['443','443'],['3125','3125'],['8080','8080'],['8000','8000']].map(([v,l]) => (
              <button key={v} onClick={() => setPort(v)} style={{ padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:12, backgroundColor:port===v?C.green:'#f0f0f0', color:port===v?'#fff':'#555' }}>{l}</button>
            ))}
          </div>
          <input value={port==='none'?'':port} onChange={e => setPort(e.target.value||'none')} placeholder="Or type custom port…"
            style={{ marginTop:6, width:'100%', borderRadius:8, border:`1px solid ${C.border}`, padding:'8px 10px', fontSize:14, boxSizing:'border-box' as const }} />
        </div>
        <div style={{ backgroundColor:'#f5f5f5', borderRadius:8, padding:'8px 12px', marginBottom:12 }}>
          <div style={{ fontSize:10, color:C.gray, fontWeight:700, marginBottom:2 }}>FULL URL PREVIEW</div>
          <div style={{ fontSize:13, fontWeight:700, color:C.green, fontFamily:'monospace' }}>{previewUrl()}</div>
        </div>
        <button onClick={testConn} disabled={testing||!host.trim()} style={{ width:'100%', padding:'11px 0', borderRadius:10, border:`1px solid ${C.green}`, backgroundColor:'#fff', color:C.green, fontWeight:700, fontSize:13, cursor:'pointer' }}>
          {testing ? '⏳ Testing…' : '🔌 Test Connection'}
        </button>
      </div>

      {/* Authentication — hidden when JWT active */}
      {!hasJwt && (
        <div style={{ backgroundColor:'#fff', borderRadius:14, padding:'16px', marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight:800, fontSize:14, color:C.green, marginBottom:14 }}>🔑 Authentication</div>
          <div style={{ marginBottom:12 }}>
            <label style={L}>Username</label>
            <input value={user} onChange={e => setUser(e.target.value)} placeholder="Admin username" style={F} />
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={L}>Password</label>
            <div style={{ position:'relative', display:'flex', alignItems:'center' }}>
              <input type={showPass?'text':'password'} value={pass} onChange={e => setPass(e.target.value)} placeholder="Password" style={{...F, paddingRight:44, width:'100%', boxSizing:'border-box' as const}} />
              <button onClick={() => setShowPass(v => !v)} style={{ position:'absolute', right:12, background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#888', padding:0 }}>
                {showPass?'🙈':'👁'}
              </button>
            </div>
          </div>
          <div>
            <label style={L}>API Secret Key</label>
            <div style={{ position:'relative', display:'flex', alignItems:'center' }}>
              <input type={showSecret?'text':'password'} value={secret} onChange={e => setSecret(e.target.value)} placeholder="API Secret Key" style={{...F, paddingRight:44, width:'100%', boxSizing:'border-box' as const}} />
              <button onClick={() => setShowSecret(v => !v)} style={{ position:'absolute', right:12, background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#888', padding:0 }}>
                {showSecret?'🙈':'👁'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Biometric Login */}
      <div style={{ marginBottom:16, padding:16, backgroundColor:'#fff', borderRadius:12, boxShadow:'0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ fontWeight:800, fontSize:14, marginBottom:12 }}>🔐 Biometric Login</div>
        <BiometricSection />
      </div>

      {/* Change Password */}
      <div style={{ backgroundColor:'#fff', borderRadius:14, padding:'16px', marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ fontWeight:800, fontSize:14, color:C.green, marginBottom:14 }}>🔒 Change Password</div>
        <div style={{ marginBottom:12 }}>
          <label style={L}>New Password</label>
          <div style={{ position:'relative', display:'flex', alignItems:'center' }}>
            <input type={showNewPass?'text':'password'} value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="New password" autoComplete="new-password" style={{...F, paddingRight:44, width:'100%', boxSizing:'border-box' as const}} />
            <button onClick={() => setShowNewPass(v => !v)} style={{ position:'absolute', right:12, background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#888', padding:0 }}>
              {showNewPass?'🙈':'👁'}
            </button>
          </div>
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={L}>Confirm New Password</label>
          <input type={showNewPass?'text':'password'} value={confirmPass} onChange={e => setConfirmPass(e.target.value)} placeholder="Re-enter new password" autoComplete="new-password" style={F} />
        </div>
        {pwdMsg && (
          <div style={{ fontSize:12, marginBottom:10, color: pwdMsg.startsWith('✅') ? C.green : C.red, fontWeight:700 }}>
            {pwdMsg}
          </div>
        )}
        <button onClick={changePassword} disabled={pwdSaving}
          style={{ width:'100%', padding:'11px 0', borderRadius:10, border:'none', backgroundColor: pwdSaving ? '#9ca3af' : C.green, color:'#fff', fontWeight:700, fontSize:13, cursor: pwdSaving ? 'not-allowed' : 'pointer' }}>
          {pwdSaving ? '⏳ Updating…' : '🔒 Change Password'}
        </button>
      </div>

      <button onClick={save} style={{ width:'100%', backgroundColor:C.green, color:'#fff', border:'none', padding:'16px', borderRadius:12, fontWeight:800, fontSize:16, cursor:'pointer', marginBottom:16 }}>
        💾 Save Settings
      </button>

      {/* Notification Settings */}
      <div style={{ backgroundColor:'#fff', borderRadius:14, padding:'16px', marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ fontWeight:800, fontSize:14, color:'#0d1b2a', marginBottom:14 }}>
          🔔 Notification Settings
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:4 }}>Academy Name</label>
          <input value={academyName} onChange={e => setAcademyName(e.target.value)} placeholder="Quickies Cricket Club"
            style={{ width:'100%', padding:'11px 14px', borderRadius:10, border:'1.5px solid #e5e7eb', fontSize:14, outline:'none', boxSizing:'border-box' as const }} />
        </div>
        {(localStorage.getItem('user_role')||'').toLowerCase() === 'admin' && (
          <div style={{ backgroundColor:'#f8f9fa', borderRadius:14, padding:'14px 16px', marginBottom:16, border:'1px solid #e5e7eb' }}>
            <div style={{ fontWeight:800, fontSize:13, color:C.navy, marginBottom:12 }}>Notifications</div>
            {[
              { key:'email_enabled', label:'📧 Email Receipts', sub: emailConfig.enabled ? `via ${emailConfig.channel === 'zoho' ? 'Zoho Mail' : 'Resend'}` : 'Not configured on server', available: emailConfig.enabled },
              { key:'wa_enabled',    label:'💬 WhatsApp',       sub: waConfig.enabled ? 'via Meta API' : 'Not configured on server', available: waConfig.enabled },
            ].map(item => {
              const isOn = notifToggles[item.key] === '1';
              return (
                <div key={item.key} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:700 }}>{item.label}</div>
                    <div style={{ fontSize:11, color: item.available ? C.muted : '#ef4444', marginTop:1 }}>{item.sub}</div>
                  </div>
                  <button disabled={!item.available}
                    onClick={() => {
                      if (!item.available) return;
                      const newVal = isOn ? '0' : '1';
                      const updated = { ...notifToggles, [item.key]: newVal };
                      setNotifToggles(updated);
                      localStorage.setItem('notif_email_enabled', updated.email_enabled);
                      localStorage.setItem('notif_wa_enabled',    updated.wa_enabled);
                      fetch(`${base}/api/data/reminders/config`, { method:'POST', headers:{...getHdr(),'Content-Type':'application/json'}, body: JSON.stringify(updated) }).catch(() => {});
                    }}
                    style={{ position:'relative', width:48, height:26, borderRadius:13, border:'none', cursor: item.available ? 'pointer' : 'not-allowed',
                      backgroundColor: isOn && item.available ? C.green : '#d1d5db', transition:'background-color 0.2s', flexShrink:0 }}>
                    <div style={{ position:'absolute', top:3, left: isOn ? 24 : 3, width:20, height:20, borderRadius:'50%', backgroundColor:'#fff', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }}/>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Full Refresh */}
      <div style={{ padding:'0 16px 16px' }}>
        <div style={{ backgroundColor: roleDisplay ? '#f0fdf4' : '#f9fafb', borderRadius:14, padding:'16px', border:`1px solid ${roleDisplay ? '#86efac' : '#e5e7eb'}` }}>
          <div style={{ fontWeight:800, fontSize:14, color: roleDisplay ? '#166534' : '#9ca3af', marginBottom:4 }}>🔄 Full Refresh from Server</div>
          <div style={{ fontSize:12, color:'#6b7280', marginBottom:12, lineHeight:1.5 }}>
            {roleDisplay ? `Clears all local data and re-downloads everything for your role (${roleDisplay}) from the server.` : 'Connect to server first (Test Connection) to enable this.'}
          </div>
          {refreshing && refreshProg && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#166534', marginBottom:6 }}>{refreshProg.done ? '✅ Complete!' : `⏳ ${refreshProg.stage}`}</div>
              <div style={{ backgroundColor:'#dcfce7', borderRadius:8, height:10, overflow:'hidden' }}>
                <div style={{ height:'100%', backgroundColor:'#16a34a', borderRadius:8, width: refreshProg.total > 0 ? `${Math.min(100, Math.round(refreshProg.current/refreshProg.total*100))}%` : '60%', transition:'width 0.4s ease' }} />
              </div>
            </div>
          )}
          {refreshDone && !refreshing && (
            <div style={{ backgroundColor: refreshDone.startsWith('✅') ? '#dcfce7' : '#fee2e2', color: refreshDone.startsWith('✅') ? '#166534' : '#dc2626', borderRadius:8, padding:'10px 12px', marginBottom:12, fontSize:13, fontWeight:700 }}>
              {refreshDone}
            </div>
          )}
          {!refreshing && roleDisplay && (
            refreshConf ? (
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:'#dc2626', backgroundColor:'#fee2e2', padding:'10px', borderRadius:8, marginBottom:10 }}>
                  ⚠ All local data will be deleted and re-downloaded from server. Proceed?
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={() => setRefreshConf(false)} style={{ flex:1, padding:'12px', borderRadius:8, border:'1px solid #e5e7eb', backgroundColor:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>Cancel</button>
                  <button onClick={async () => {
                    setRefreshConf(false); setRefreshing(true); setRefreshDone('');
                    setRefreshProg({ stage:'Starting…', current:0, total:0, done:false });
                    const result = await fullRefreshFromServer(p => setRefreshProg(p));
                    setRefreshing(false); setRefreshProg(null);
                    setRefreshDone(result.ok ? '✅ Complete — local data now matches server' : `⚠ ${result.error || 'Failed'}`);
                  }} style={{ flex:2, padding:'12px', borderRadius:8, border:'none', backgroundColor:'#166534', color:'#fff', fontSize:13, fontWeight:800, cursor:'pointer' }}>✅ Yes, Full Refresh</button>
                </div>
              </div>
            ) : (
              <button onClick={() => { setRefreshConf(true); setRefreshDone(''); }}
                style={{ width:'100%', padding:'13px', borderRadius:10, border:'none', backgroundColor:'#166534', color:'#fff', fontWeight:800, fontSize:14, cursor:'pointer' }}>
                🔄 Full Refresh from Server
              </button>
            )
          )}
          {!roleDisplay && !refreshing && (
            <button disabled style={{ width:'100%', padding:'13px', borderRadius:10, border:'1px solid #e5e7eb', backgroundColor:'#f3f4f6', color:'#9ca3af', fontWeight:800, fontSize:14, cursor:'not-allowed' }}>
              🔄 Full Refresh (connect first)
            </button>
          )}
        </div>
      </div>

      <PinSettings />
    </div>
    </div>
  );
}
