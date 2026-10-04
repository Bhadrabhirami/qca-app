/**
 * AppLock — PIN lock for QCA Mobile App
 *
 * Biometric via @aparajita plugin removed — caused Android WebView hang.
 * PIN only: 4-digit code stored in localStorage.
 * Non-blocking: if no PIN set, renders children immediately.
 * Lock behaviour: every app open + background > 60s requires PIN.
 */

import React, { useEffect, useRef, useState } from 'react';

const C          = { green: '#1a472a', gold: '#d4af37', red: '#c0392b' };
const PIN_KEY    = 'qca_app_pin';
const PIN_LEN    = 4;
const BG_LOCK_MS = 60_000;

// ─── PIN Pad ──────────────────────────────────────────────────────────────────
function PinPad({ mode, onSuccess, onCancel }: {
  mode:      'verify' | 'set';
  onSuccess: (pin: string) => void;
  onCancel?: () => void;
}) {
  const [entry,   setEntry]   = useState('');
  const [confirm, setConfirm] = useState('');
  const [phase,   setPhase]   = useState<'enter'|'confirm'>('enter');
  const [err,     setErr]     = useState('');
  const [shake,   setShake]   = useState(false);

  const shakeErr = (msg: string) => {
    setErr(msg); setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const press = (d: string) => {
    setErr('');
    const cur  = phase === 'confirm' ? confirm : entry;
    if (cur.length >= PIN_LEN) return;
    const next = cur + d;

    if (phase === 'confirm') {
      setConfirm(next);
      if (next.length === PIN_LEN) {
        if (next === entry) { onSuccess(next); }
        else { shakeErr("PINs don't match — try again"); setConfirm(''); }
      }
    } else {
      setEntry(next);
      if (next.length === PIN_LEN) {
        if (mode === 'verify') {
          const stored = localStorage.getItem(PIN_KEY) ?? '';
          if (next === stored) { onSuccess(next); }
          else { shakeErr('Wrong PIN'); setEntry(''); }
        } else {
          setPhase('confirm');
        }
      }
    }
  };

  const del = () => {
    if (phase === 'confirm') setConfirm(p => p.slice(0, -1));
    else setEntry(p => p.slice(0, -1));
  };

  const cur   = phase === 'confirm' ? confirm : entry;
  const label = mode === 'verify'
    ? 'Enter your PIN'
    : phase === 'enter' ? 'Create a 4-digit PIN' : 'Confirm PIN';

  const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20 }}>
      <div style={{ fontSize:14, color:'rgba(255,255,255,0.65)', textAlign:'center' }}>{label}</div>

      {err
        ? <div style={{ fontSize:12, color:C.red, fontWeight:700 }}>{err}</div>
        : <div style={{ height:17 }} />
      }

      {/* Dots */}
      <div style={{ display:'flex', gap:16,
        transform: shake ? 'translateX(10px)' : 'none',
        transition: 'transform 0.1s' }}>
        {Array.from({ length: PIN_LEN }).map((_, i) => (
          <div key={i} style={{
            width:16, height:16, borderRadius:'50%',
            border: `2px solid ${C.gold}`,
            backgroundColor: i < cur.length ? C.gold : 'transparent',
            transition: 'background 0.12s',
          }} />
        ))}
      </div>

      {/* Keypad */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,76px)', gap:12 }}>
        {KEYS.map((k, i) =>
          k === '' ? <div key={i} /> :
          k === '⌫' ? (
            <button key={i} onClick={del} style={{
              height:60, borderRadius:16, border:'none',
              backgroundColor:'rgba(255,255,255,0.08)',
              color:'rgba(255,255,255,0.6)', fontSize:22, cursor:'pointer',
            }}>⌫</button>
          ) : (
            <button key={i} onClick={() => press(k)} style={{
              height:60, borderRadius:16,
              border:'1px solid rgba(255,255,255,0.12)',
              backgroundColor:'rgba(255,255,255,0.07)',
              color:'#fff', fontSize:22, fontWeight:700, cursor:'pointer',
            }}>{k}</button>
          )
        )}
      </div>

      {onCancel && (
        <button onClick={onCancel} style={{
          marginTop:4, padding:'10px 32px', borderRadius:10,
          border:'1px solid rgba(255,255,255,0.15)',
          backgroundColor:'transparent',
          color:'rgba(255,255,255,0.5)', fontSize:13, cursor:'pointer',
        }}>Cancel</button>
      )}
    </div>
  );
}

// ─── Full-screen lock ─────────────────────────────────────────────────────────
function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div style={{
      position:'fixed', inset:0, zIndex:9999,
      backgroundColor:'#060e09',
      display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', padding:28,
    }}>
      {/* Logo */}
      <div style={{ marginBottom:40, textAlign:'center' }}>
        <div style={{
          width:84, height:84, borderRadius:'50%',
          backgroundColor:'rgba(212,175,55,0.12)',
          border:`2px solid ${C.gold}55`,
          display:'flex', alignItems:'center', justifyContent:'center',
          margin:'0 auto 14px',
        }}>
          <span style={{ fontSize:44 }}>🏏</span>
        </div>
        <div style={{ color:'#fff', fontWeight:800, fontSize:22 }}>QCA</div>
        <div style={{ color:C.gold, fontSize:11, letterSpacing:'2px', marginTop:4 }}>
          QUICKIES CRICKET ACADEMY
        </div>
      </div>

      <PinPad mode="verify" onSuccess={onUnlock} />
    </div>
  );
}

// ─── PinSettings — used in Settings page ─────────────────────────────────────
export function PinSettings() {
  const [pinSet, setPinSet] = useState(() => {
    const p = localStorage.getItem(PIN_KEY);
    return !!(p && p.length === PIN_LEN);
  });
  const [view, setView] = useState<'idle'|'setting'>('idle');
  const [msg,  setMsg]  = useState('');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const removePin = () => {
    localStorage.removeItem(PIN_KEY);
    setPinSet(false);
    setView('idle');
    flash('PIN removed. App lock disabled.');
  };

  return (
    <div style={{
      backgroundColor:'#fff', borderRadius:14, padding:16,
      marginBottom:14, boxShadow:'0 1px 4px rgba(0,0,0,0.08)',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
        <span style={{ fontSize:20 }}>🔒</span>
        <div>
          <div style={{ fontWeight:800, fontSize:15, color:'#222' }}>App Lock (PIN)</div>
          <div style={{ fontSize:12, color:'#888' }}>4-digit PIN required to open app</div>
        </div>
        <div style={{
          marginLeft:'auto', fontSize:11, fontWeight:700,
          padding:'3px 10px', borderRadius:10,
          backgroundColor: pinSet ? '#e8f5e9' : '#f5f5f5',
          color: pinSet ? '#27ae60' : '#aaa',
        }}>
          {pinSet ? '● Active' : '○ Off'}
        </div>
      </div>

      {msg && (
        <div style={{
          padding:'8px 12px', borderRadius:8, marginBottom:10,
          fontSize:12, fontWeight:600,
          backgroundColor: msg.includes('removed') ? '#fdecea' : '#e8f5e9',
          color: msg.includes('removed') ? C.red : '#27ae60',
        }}>{msg}</div>
      )}

      {view === 'idle' && (
        <div style={{ display:'flex', gap:8, marginTop:10 }}>
          {!pinSet ? (
            <button onClick={() => setView('setting')} style={{
              flex:1, padding:'11px 0', borderRadius:10, border:'none',
              backgroundColor:C.green, color:'#fff', fontWeight:700,
              fontSize:13, cursor:'pointer',
            }}>Set PIN</button>
          ) : (
            <>
              <button onClick={() => setView('setting')} style={{
                flex:1, padding:'11px 0', borderRadius:10,
                border:`1px solid ${C.green}`, backgroundColor:'#fff',
                color:C.green, fontWeight:700, fontSize:13, cursor:'pointer',
              }}>Change PIN</button>
              <button onClick={removePin} style={{
                flex:1, padding:'11px 0', borderRadius:10,
                border:`1px solid ${C.red}`, backgroundColor:'#fff',
                color:C.red, fontWeight:700, fontSize:13, cursor:'pointer',
              }}>Remove PIN</button>
            </>
          )}
        </div>
      )}

      {view === 'setting' && (
        <div style={{
          backgroundColor:'#0a1a0f', borderRadius:12,
          padding:'20px 16px', marginTop:10,
        }}>
          <PinPad
            mode="set"
            onSuccess={pin => {
              localStorage.setItem(PIN_KEY, pin);
              setPinSet(true);
              setView('idle');
              flash('✔ PIN set. App will lock on next open.');
            }}
            onCancel={() => setView('idle')}
          />
        </div>
      )}
    </div>
  );
}

// ─── AppLock wrapper ──────────────────────────────────────────────────────────
export default function AppLock({ children }: { children: React.ReactNode }) {
  const pinSet = !!(localStorage.getItem(PIN_KEY)?.length === PIN_LEN);
  // Skip PIN lock if biometric just unlocked this session (within last 10s)
  const bioJustUnlocked = () => {
    const t = parseInt(sessionStorage.getItem('qca_bio_unlocked') || '0');
    return t > 0 && Date.now() - t < 10000;
  };
  const [locked, setLocked] = useState(() => pinSet && !bioJustUnlocked());
  const hiddenAt = useRef(0);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
      } else {
        if (hiddenAt.current && Date.now() - hiddenAt.current > BG_LOCK_MS) {
          const p = localStorage.getItem(PIN_KEY);
          if (p && p.length === PIN_LEN) {
            sessionStorage.removeItem('qca_bio_unlocked');
            setLocked(true);
          }
        }
        hiddenAt.current = 0;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // No PIN set — render children immediately, no lock
  if (!pinSet) return <>{children}</>;

  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />;

  return <>{children}</>;
}
