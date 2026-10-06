/**
 * Login.tsx — QCA Mobile App Login
 * Collects server URL + credentials on first use
 * JWT auth — no API key needed
 */
import React, { useState, useEffect, useRef } from 'react';
import { jwtLogin, checkPasswordStrength } from './jwtAuth';
import { BiometricAuth, BiometryError } from '@aparajita/capacitor-biometric-auth';
import { saveUserContext } from './usePermissions';
import { getLastUsername, setLastUsername, canRememberPassword, savePassword, loadSavedLogin, hasSavedLogin, forgetPassword } from './savedLogin';

const C = {
  navy:'#0d1b2a', navyL:'#1a2f4a', green:'#1a472a',
  gold:'#c5a059', red:'#dc2626', muted:'#6b7280', white:'#ffffff',
};

type Screen = 'login' | 'forgot' | 'otp' | 'reset' | 'success';

function buildServerIp(proto:string, host:string, port:string): string {
  if (!host.trim()) return '';
  const skipPort = !port || port==='none'
    || (proto==='https' && port==='443')
    || (proto==='http'  && port==='80');
  const p = skipPort ? '' : `:${port}`;
  return `${proto}://${host.trim()}${p}`;
}

function getBase(): string {
  const ip = (localStorage.getItem('server_ip')||'').trim().replace(/\/+$/,'');
  return ip.startsWith('http') ? ip : `http://${ip}`;
}

function StrengthBar({ password }: { password: string }) {
  const [info, setInfo] = useState<any>(null);
  const t = useRef<any>(null);

  useEffect(() => {
    if (!password) { setInfo(null); return; }
    clearTimeout(t.current);
    t.current = setTimeout(async () => {
      try {
        const r = await fetch(`${getBase()}/api/auth/check-password-strength`,{
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({password})
        });
        setInfo(await r.json());
      } catch {}
    }, 400);
    return () => clearTimeout(t.current);
  }, [password]);
  if (!info || !password) return null;
  const colors = ['#dc2626','#f97316','#eab308','#22c55e','#16a34a','#15803d'];
  const color = colors[Math.min(info.score,5)];
  return (
    <div style={{marginTop:4}}>
      <div style={{display:'flex',gap:3,marginBottom:3}}>
        {[0,1,2,3,4].map(i=>(
          <div key={i} style={{flex:1,height:3,borderRadius:2,
            backgroundColor:i<info.score?color:'#e5e7eb',transition:'background-color 0.3s'}}/>
        ))}
      </div>
      <div style={{fontSize:11,color,fontWeight:600}}>{info.strength}</div>
      {info.requirements?.map((r:string,i:number)=>(
        <div key={i} style={{fontSize:10,color:C.red}}>✗ {r}</div>
      ))}
    </div>
  );
}

export default function LoginPage({ onSuccess }: { onSuccess:(user:any,token:string)=>void }) {
  // Server config
  const [proto,    setProto]    = useState(() => localStorage.getItem('server_proto') || 'http');
  const [host,     setHost]     = useState(() => localStorage.getItem('server_host')  || '');
  const [port,     setPort]     = useState(() => localStorage.getItem('server_port')  || '');
  const [showSetup, setShowSetup] = useState(() => !localStorage.getItem('server_ip'));

  // Auth
  const [username, setUsername] = useState(getLastUsername);   // remembered across session expiry
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled,   setBiometricEnabled]   = useState(
    localStorage.getItem('biometric_enabled') === 'true'
  );
  const [bioError, setBioError] = useState('');
  const [error,    setError]    = useState('');
  const [locked,   setLocked]   = useState(false);
  // Saved password (Keystore, native only) -> "Sign in with fingerprint"
  const [savedAvail, setSavedAvail] = useState(false);
  const [remember,   setRemember]   = useState(true);
  useEffect(() => { hasSavedLogin().then(setSavedAvail); }, []);

  // Is fingerprint/face available? Drives the "enable biometric?" offer
  // after a password login (the unlock itself is App.jsx's lock screen).
  useEffect(() => {
    BiometricAuth.checkBiometry()
      .then(r => setBiometricAvailable(!!r.isAvailable))
      .catch(() => setBiometricAvailable(false));
  }, []);

  // Forgot password
  const [screen,   setScreen]   = useState<Screen>('login');
  const [fpEmail,  setFpEmail]  = useState('');
  const [otp,      setOtp]      = useState('');
  const [fpToken,  setFpToken]  = useState('');
  const [newPass,  setNewPass]  = useState('');
  const [confPass, setConfPass] = useState('');

  const previewUrl = buildServerIp(proto, host, port);
  const err = (msg:string) => { setError(msg); setLoading(false); };

  const saveServer = () => {
    if (!host.trim()) { setError('Server host is required'); return; }
    const url = buildServerIp(proto, host, port);
    localStorage.setItem('server_proto', proto);
    localStorage.setItem('server_host',  host.trim());
    localStorage.setItem('server_port',  port==='none'?'':(port.trim()||''));
    localStorage.setItem('server_ip',    url);
    setShowSetup(false);
    setError('');
  };

  const triggerBiometric = async () => {
    setBioError('');
    setLoading(true);
    try {
      await BiometricAuth.authenticate({
        reason: 'Verify your identity to access QCA',
        cancelTitle: 'Use Password',
        allowDeviceCredential: true,
        iosFallbackTitle: 'Use Password',
        androidTitle: 'QCA Academy',
        androidSubtitle: 'Verify your identity',
        androidConfirmationRequired: false,
      });
      // Biometric success — restore session
      const token = localStorage.getItem('jwt_token');
      const expiry = parseInt(localStorage.getItem('jwt_expiry') || '0');
      const userCache = localStorage.getItem('jwt_user_cache');
      if (token && Date.now() < expiry - 60000 && userCache) {
        const user = JSON.parse(userCache);
        onSuccess(user, token);
      } else {
        // Token expired — need fresh login
        setBioError('Session expired. Please login with password.');
        setScreen('login');
        localStorage.removeItem('biometric_enabled');
      }
    } catch (e: any) {
      const code = e?.code || '';
      if (code === 'userCancel' || code === 'systemCancel') {
        setScreen('login');
      } else if (code === 'biometryNotEnrolled' || code === 'biometryNotAvailable') {
        setBiometricAvailable(false);
        setScreen('login');
      } else {
        setBioError('Biometric failed. Use password instead.');
        setScreen('login');
      }
    }
    setLoading(false);
  };

  /** After the server accepted a login — shared by password and fingerprint sign-in */
  const finishLogin = (res: any) => {
      localStorage.setItem('auth_user', res.user.username);
      setLastUsername(res.user.username);
      // Never persist the password — every request authenticates with the JWT
      localStorage.removeItem('auth_pass');
      // Set secret_key if not already set (needed for legacy API calls)
      if (!localStorage.getItem('secret_key')) {
        localStorage.setItem('secret_key', 'jwt-auth');
      }
      saveUserContext({
        permissions:      res.user.permissions || [],
        role:             res.user.role,
        authenticated_as: res.user.username,
      });
      // Offer biometric setup after first password login
      if (biometricAvailable && !biometricEnabled) {
        localStorage.setItem('biometric_pending_setup', 'true');
      }
      onSuccess(res.user, res.token);
  };

  const handleLogin = async () => {
    if (!username.trim()) return err('Username is required');
    if (!password)        return err('Password is required');
    if (!localStorage.getItem('server_ip')) return err('Configure server first');
    setLoading(true); setError('');
    const res = await jwtLogin(username.trim(), password);
    if (res.success && res.token && res.user) {
      // Remember for fingerprint sign-in (encrypted, this phone only), or forget if unticked
      if (remember && biometricAvailable && canRememberPassword()) await savePassword(res.user.username, password);
      else await forgetPassword();
      finishLogin(res);
    } else {
      if (res.locked) { setLocked(true); }
      err(res.error || 'Login failed');
    }
  };

  /** Fingerprint -> read the saved password -> sign in. One attempt; a rejected password is forgotten. */
  const fingerprintLogin = async () => {
    if (!localStorage.getItem('server_ip')) return err('Configure server first');
    setError('');
    try {
      await BiometricAuth.authenticate({
        reason: 'Sign in to QCA',
        cancelTitle: 'Cancel',
        allowDeviceCredential: true,
        androidTitle: 'QCA Academy',
        androidSubtitle: 'Sign in with your fingerprint',
        androidConfirmationRequired: false,
      });
    } catch (e: any) {
      const code = e?.code || '';
      if (code !== 'userCancel' && code !== 'systemCancel') setError('Fingerprint not recognised. Try again or type your password.');
      return;
    }
    setLoading(true);
    const saved = await loadSavedLogin();
    if (!saved) { setSavedAvail(false); return err('No saved password on this phone. Please type it once.'); }
    const res = await jwtLogin(saved.u, saved.p);
    if (res.success && res.token && res.user) { finishLogin(res); return; }
    if (res.error === 'Cannot reach server') return err('Cannot reach server. Check Wi-Fi and try again.');
    // Password changed or account locked: never retry a rejected password
    await forgetPassword();
    setSavedAvail(false);
    setUsername(saved.u);
    if (res.locked) setLocked(true);
    err(res.locked ? (res.error || 'Account locked') : 'Your saved password no longer works. Please type your current password.');
  };

  const [maskedEmail, setMaskedEmail] = useState('');

  const sendOtp = async () => {
    if (!fpEmail.trim()) return err('Username is required');
    setLoading(true); setError('');
    try {
      const r = await fetch(`${getBase()}/api/auth/forgot-password`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username: fpEmail.trim()})
      });
      const j = await r.json();
      if (r.ok) {
        setMaskedEmail(j.masked_email || 'your registered email');
        setScreen('otp');
        setError('');
      }
      else err(j.error||'Failed to send OTP');
    } catch { err('Network error'); }
    setLoading(false);
  };

  const verifyOtp = async () => {
    if (otp.length!==6) return err('Enter 6-digit OTP');
    setLoading(true); setError('');
    try {
      const r = await fetch(`${getBase()}/api/auth/verify-otp`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email:fpEmail.trim(), otp})
      });
      const j = await r.json();
      if (r.ok && j.reset_token) { setFpToken(j.reset_token); setScreen('reset'); setError(''); }
      else err(j.error||'Invalid OTP');
    } catch { err('Network error'); }
    setLoading(false);
  };

  const resetPassword = async () => {
    if (!newPass)             return err('Enter new password');
    if (newPass!==confPass)   return err('Passwords do not match');
    setLoading(true); setError('');
    try {
      const r = await fetch(`${getBase()}/api/auth/reset-password`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({reset_token:fpToken, new_password:newPass})
      });
      const j = await r.json();
      if (r.ok) { setScreen('success'); setError(''); }
      else err(j.error||'Reset failed');
    } catch { err('Network error'); }
    setLoading(false);
  };

  const backToLogin = () => {
    setScreen('login'); setError('');
    setFpEmail(''); setOtp(''); setFpToken(''); setNewPass(''); setConfPass('');
  };

  const inputStyle = (extra={}) => ({
    width:'100%', padding:'11px 13px', borderRadius:10,
    border:'1px solid #e0e0e0', fontSize:14, outline:'none',
    boxSizing:'border-box' as const, backgroundColor:'#fff', ...extra
  });

  return (
    <div style={{minHeight:'100vh',backgroundColor:C.navy,display:'flex',
      flexDirection:'column' as const,alignItems:'center',justifyContent:'center',padding:20}}>

      {/* Logo */}
      <div style={{textAlign:'center' as const,marginBottom:24}}>
        <div style={{width:72,height:72,borderRadius:'50%',
          backgroundColor:'rgba(197,160,89,0.15)',border:`2px solid ${C.gold}`,
          display:'flex',alignItems:'center',justifyContent:'center',
          margin:'0 auto 12px',fontSize:32}}>🏏</div>
        <div style={{color:'#fff',fontWeight:900,fontSize:22}}>Quickies Cricket Academy</div>
        <div style={{color:'rgba(255,255,255,0.4)',fontSize:12,marginTop:3}}>Management System</div>
      </div>

      {/* Card */}
      <div style={{backgroundColor:'#fff',borderRadius:20,padding:24,
        width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>

        {/* ── SERVER SETUP ── */}
        {showSetup && screen==='login' && (
          <div style={{marginBottom:20,padding:16,backgroundColor:'#f8fafc',
            borderRadius:12,border:'1px solid #e2e8f0'}}>
            <div style={{fontWeight:800,fontSize:14,color:C.navy,marginBottom:12}}>
              ⚙️ Server Configuration
            </div>

            <div style={{display:'grid',gridTemplateColumns:'90px 1fr',gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Protocol</div>
                <select value={proto} onChange={e=>setProto(e.target.value)}
                  style={inputStyle({padding:'10px 8px',fontSize:13})}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Host / IP</div>
                <input value={host} onChange={e=>setHost(e.target.value)}
                  placeholder="192.168.1.1 or domain.com"
                  style={inputStyle({fontSize:13})}/>
              </div>
            </div>

            <div style={{marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Port (leave empty for 80/443)</div>
              <input value={port} onChange={e=>setPort(e.target.value)}
                placeholder="e.g. 8000 or 3125 (empty = default)"
                style={inputStyle({fontSize:13})}/>
            </div>

            {host && (
              <div style={{fontSize:11,color:C.muted,marginBottom:10,
                backgroundColor:'#f0f9ff',padding:'6px 10px',borderRadius:6}}>
                📡 {previewUrl}
              </div>
            )}

            {error && (
              <div style={{backgroundColor:'#fef2f2',borderRadius:8,padding:'8px 10px',
                marginBottom:8,color:C.red,fontSize:12}}>{error}</div>
            )}

            <button onClick={saveServer}
              style={{width:'100%',padding:11,borderRadius:10,border:'none',
                backgroundColor:C.navy,color:'#fff',fontWeight:700,
                fontSize:13,cursor:'pointer'}}>
              Save & Continue
            </button>
          </div>
        )}

        {/* Server indicator (when configured) */}
        {!showSetup && screen==='login' && (
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',
            marginBottom:16,padding:'6px 10px',backgroundColor:'#f0fdf4',
            borderRadius:8,border:'1px solid #bbf7d0'}}>
            <div style={{fontSize:11,color:'#15803d',fontWeight:600}}>
              📡 {localStorage.getItem('server_ip')}
            </div>
            <button onClick={()=>{setShowSetup(true);setError('');}}
              style={{background:'none',border:'none',fontSize:10,
                color:C.muted,cursor:'pointer',textDecoration:'underline'}}>
              Change
            </button>
          </div>
        )}

        {/* ── LOGIN ── */}
        {screen==='login' && !showSetup && (
          <>
            <div style={{fontWeight:900,fontSize:19,color:C.navy,marginBottom:2}}>
              Welcome Back{username ? `, ${username}` : ''}
            </div>
            <div style={{fontSize:12,color:C.muted,marginBottom:savedAvail ? 12 : 18}}>
              {savedAvail ? 'Your session ended. Sign in again to continue.' : 'Sign in to continue'}
            </div>

            {savedAvail && biometricAvailable && (
              <>
                <button onClick={fingerprintLogin} disabled={loading||locked}
                  style={{width:'100%',padding:13,borderRadius:12,border:'none',marginBottom:8,
                    background:loading||locked?'#e5e7eb':`linear-gradient(135deg,${C.green},#2d6a4f)`,
                    color:loading||locked?C.muted:C.gold,fontWeight:900,fontSize:15,cursor:loading||locked?'not-allowed':'pointer'}}>
                  {loading ? 'Signing in…' : '👆 Sign in with fingerprint'}
                </button>
                <div style={{display:'flex',alignItems:'center',gap:8,margin:'10px 0 12px',color:C.muted,fontSize:11}}>
                  <div style={{flex:1,height:1,backgroundColor:'#e5e7eb'}}/>or type your password<div style={{flex:1,height:1,backgroundColor:'#e5e7eb'}}/>
                </div>
              </>
            )}

            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Username</div>
              <input value={username} onChange={e=>setUsername(e.target.value)}
                placeholder="Enter username" autoFocus={!username} autoCapitalize="none" autoComplete="username"
                style={inputStyle()}/>
            </div>

            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Password</div>
              <div style={{position:'relative' as const}}>
                <input type={showPass?'text':'password'} value={password}
                  onChange={e=>setPassword(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&handleLogin()}
                  placeholder="Enter password" autoFocus={!!username && !savedAvail} autoComplete="current-password"
                  style={inputStyle({paddingRight:44})}/>
                <button onClick={()=>setShowPass(v=>!v)}
                  style={{position:'absolute' as const,right:12,top:'50%',
                    transform:'translateY(-50%)',background:'none',border:'none',
                    cursor:'pointer',color:C.muted,fontSize:16}}>
                  {showPass?'🙈':'👁'}
                </button>
              </div>
            </div>

            {biometricAvailable && canRememberPassword() && (
              <label style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,fontSize:12,color:C.muted,cursor:'pointer'}}>
                <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}
                  style={{width:16,height:16,accentColor:C.green}}/>
                Remember on this phone for fingerprint sign-in
              </label>
            )}

            {error && (
              <div style={{backgroundColor:locked?'#fef9c3':'#fef2f2',borderRadius:10,
                padding:'9px 12px',marginBottom:10,
                color:locked?'#854d0e':C.red,fontSize:13,fontWeight:600}}>
                {locked?'🔒 ':''}{error}
              </div>
            )}

            <button onClick={handleLogin} disabled={loading||locked}
              style={{width:'100%',padding:13,borderRadius:12,border:'none',
                background:loading||locked?'#e5e7eb':`linear-gradient(135deg,${C.green},#2d6a4f)`,
                color:loading||locked?C.muted:'#fff',
                fontWeight:800,fontSize:15,cursor:loading||locked?'not-allowed':'pointer'}}>
              {loading?'Signing in…':'Sign In'}
            </button>

            <button onClick={()=>{setScreen('forgot');setError('');}}
              style={{width:'100%',padding:9,marginTop:8,background:'none',
                border:'none',color:C.muted,fontSize:12,cursor:'pointer'}}>
              Forgot password?
            </button>
          </>
        )}

        {/* ── BIOMETRIC SCREEN ── */}
        {screen==='biometric' && (
          <>
            <div style={{textAlign:'center' as const,padding:'20px 0'}}>
              <div style={{fontSize:64,marginBottom:16}}>🔐</div>
              <div style={{fontWeight:900,fontSize:20,color:C.navy,marginBottom:8}}>
                Welcome back, {localStorage.getItem('auth_user')||''}
              </div>
              <div style={{fontSize:13,color:C.muted,marginBottom:24}}>
                Use biometric to continue
              </div>
              {bioError && (
                <div style={{backgroundColor:'#fef2f2',borderRadius:8,padding:'10px 14px',marginBottom:16,color:C.red,fontSize:13}}>
                  {bioError}
                </div>
              )}
              <button onClick={triggerBiometric} disabled={loading}
                style={{width:'100%',padding:16,borderRadius:14,border:'none',
                  background:`linear-gradient(135deg,${C.navy},${C.navyL})`,
                  color:'#fff',fontWeight:800,fontSize:15,cursor:'pointer',marginBottom:12}}>
                {loading?'Verifying…':'👆 Authenticate'}
              </button>
              <button onClick={()=>setScreen('login')}
                style={{width:'100%',padding:12,borderRadius:12,border:`1px solid ${C.border}`,
                  backgroundColor:'transparent',color:C.muted,fontWeight:600,fontSize:13,cursor:'pointer'}}>
                Use Password Instead
              </button>
            </div>
          </>
        )}

        {/* ── FORGOT PASSWORD ── */}
        {screen==='forgot' && (
          <>
            <button onClick={backToLogin}
              style={{background:'none',border:'none',color:C.muted,
                cursor:'pointer',fontSize:12,marginBottom:14,padding:0}}>← Back</button>
            <div style={{fontWeight:900,fontSize:18,color:C.navy,marginBottom:4}}>Forgot Password</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:18}}>
              Enter your username. An OTP will be sent to your registered email.
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Username</div>
              <input type="text" value={fpEmail} onChange={e=>setFpEmail(e.target.value)}
                placeholder="Enter your username" autoFocus style={inputStyle()}/>
            </div>
            {error&&<div style={{backgroundColor:'#fef2f2',borderRadius:8,padding:'8px 10px',marginBottom:10,color:C.red,fontSize:12}}>{error}</div>}
            <button onClick={sendOtp} disabled={loading||!fpEmail.trim()}
              style={{width:'100%',padding:13,borderRadius:12,border:'none',
                background:fpEmail.trim()?`linear-gradient(135deg,${C.navy},${C.navyL})`:'#e5e7eb',
                color:fpEmail.trim()?'#fff':C.muted,fontWeight:800,fontSize:14,
                cursor:fpEmail.trim()?'pointer':'not-allowed'}}>
              {loading?'Sending…':'Send OTP'}
            </button>
          </>
        )}

        {/* ── OTP ── */}
        {screen==='otp' && (
          <>
            <button onClick={()=>{setScreen('forgot');setError('');}}
              style={{background:'none',border:'none',color:C.muted,cursor:'pointer',fontSize:12,marginBottom:14,padding:0}}>← Back</button>
            <div style={{fontWeight:900,fontSize:18,color:C.navy,marginBottom:4}}>Enter OTP</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:18}}>
              OTP sent to <b>{maskedEmail}</b>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>6-Digit OTP</div>
              <input type="tel" value={otp}
                onChange={e=>setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
                placeholder="• • • • • •" autoFocus
                style={inputStyle({letterSpacing:8,fontSize:20,textAlign:'center' as const})}/>
            </div>
            {error&&<div style={{backgroundColor:'#fef2f2',borderRadius:8,padding:'8px 10px',marginBottom:10,color:C.red,fontSize:12}}>{error}</div>}
            <button onClick={verifyOtp} disabled={loading||otp.length!==6}
              style={{width:'100%',padding:13,borderRadius:12,border:'none',
                background:otp.length===6?`linear-gradient(135deg,${C.green},#2d6a4f)`:'#e5e7eb',
                color:otp.length===6?'#fff':C.muted,
                fontWeight:800,fontSize:14,cursor:otp.length===6?'pointer':'not-allowed'}}>
              {loading?'Verifying…':'Verify OTP'}
            </button>
            <button onClick={sendOtp} disabled={loading}
              style={{width:'100%',padding:8,marginTop:6,background:'none',
                border:'none',color:C.muted,fontSize:11,cursor:'pointer'}}>Resend OTP</button>
          </>
        )}

        {/* ── RESET PASSWORD ── */}
        {screen==='reset' && (
          <>
            <div style={{fontWeight:900,fontSize:18,color:C.navy,marginBottom:4}}>New Password</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:18}}>Choose a strong password</div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>New Password</div>
              <input type="password" value={newPass} onChange={e=>setNewPass(e.target.value)}
                placeholder="Enter new password" autoFocus style={inputStyle()}/>
              <StrengthBar password={newPass}/>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Confirm Password</div>
              <input type="password" value={confPass} onChange={e=>setConfPass(e.target.value)}
                placeholder="Confirm new password" style={inputStyle()}/>
            </div>
            {error&&<div style={{backgroundColor:'#fef2f2',borderRadius:8,padding:'8px 10px',marginBottom:10,color:C.red,fontSize:12}}>{error}</div>}
            <button onClick={resetPassword} disabled={loading||!newPass||newPass!==confPass}
              style={{width:'100%',padding:13,borderRadius:12,border:'none',
                background:newPass&&newPass===confPass?`linear-gradient(135deg,${C.green},#2d6a4f)`:'#e5e7eb',
                color:newPass&&newPass===confPass?'#fff':C.muted,
                fontWeight:800,fontSize:14,cursor:'pointer'}}>
              {loading?'Resetting…':'Reset Password'}
            </button>
          </>
        )}

        {/* ── SUCCESS ── */}
        {screen==='success' && (
          <div style={{textAlign:'center' as const}}>
            <div style={{fontSize:44,marginBottom:10}}>✅</div>
            <div style={{fontWeight:900,fontSize:18,color:C.navy,marginBottom:6}}>Password Reset!</div>
            <div style={{fontSize:13,color:C.muted,marginBottom:18}}>You can now sign in with your new password.</div>
            <button onClick={backToLogin}
              style={{width:'100%',padding:13,borderRadius:12,border:'none',
                background:`linear-gradient(135deg,${C.green},#2d6a4f)`,
                color:'#fff',fontWeight:800,fontSize:14,cursor:'pointer'}}>Back to Login</button>
          </div>
        )}
      </div>

      <div style={{color:'rgba(255,255,255,0.25)',fontSize:10,marginTop:20,textAlign:'center' as const}}>
        QCA · Trivandrum · Kerala
      </div>
    </div>
  );
}
