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

  const small = (color: string, filled = false): React.CSSProperties => ({
    flexShrink:0, padding:'6px 11px', borderRadius:8, cursor:'pointer', fontWeight:700, fontSize:12,
    border:`1px solid ${color}`, backgroundColor: filled ? color : '#fff', color: filled ? '#fff' : color,
  });
  // Rendered as a row inside the Settings "Security" card
  return (
    <div style={{ padding:'9px 12px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:18, width:26, textAlign:'center', flexShrink:0 }}>🔢</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:800, fontSize:13.5, color:'#1f2937' }}>App PIN</div>
          <div style={{ fontSize:11.5, color: pinSet ? '#166534' : '#6b7280' }}>
            {pinSet ? '● On — asked when the app opens' : '4-digit PIN to open the app'}
          </div>
        </div>
        {view === 'idle' && (!pinSet
          ? <button onClick={() => setView('setting')} style={small(C.green, true)}>Set</button>
          : <>
              <button onClick={() => setView('setting')} style={small(C.green)}>Change</button>
              <button onClick={removePin} style={small(C.red)}>Remove</button>
            </>)}
      </div>

      {msg && (
        <div style={{ marginTop:7, marginLeft:36, padding:'6px 10px', borderRadius:8, fontSize:12, fontWeight:600,
          backgroundColor: msg.includes('removed') ? '#fdecea' : '#e8f5e9',
          color: msg.includes('removed') ? C.red : '#166534' }}>{msg}</div>
      )}

      {view === 'setting' && (
        <div style={{ backgroundColor:'#001f3f', borderRadius:12, padding:'18px 14px', marginTop:8 }}>
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
