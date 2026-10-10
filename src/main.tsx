import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initDatabase } from './database/db';
import AppLock from './pages/AppLock';
import { installBackButton, LeaveDialogHost } from './shared/backNav';

// ── Splash screen shown while DB initialises ──────────────────────────────────
// This replaces the blue Android splash screen immediately so the user sees
// branded content instead of a blank WebView. Android splash auto-hides on
// first frame draw — this IS the first frame.
function BootSplash({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState('Starting…');
  const [dots,   setDots]   = useState('');
  const [slow,   setSlow]   = useState(false);   // show hint after 5s

  useEffect(() => {
    // Animated dots
    const dotTimer = setInterval(() =>
      setDots(d => d.length >= 3 ? '' : d + '.'), 500);

    // Show "taking longer than usual" hint after 5 seconds
    const slowTimer = setTimeout(() => setSlow(true), 5000);

    // Initialise DB — WASM load + OPFS read + table migrations
    const t0 = Date.now();
    setStatus('Loading database…');

    // Hard timeout — if DB init hangs for any reason (WASM crash, OPFS lock)
    // we still proceed after 12 seconds so the user isn't permanently stuck
    const hardTimeout = setTimeout(() => {
      console.warn('QCA: DB init timeout — proceeding without local DB');
      clearInterval(dotTimer);
      clearTimeout(slowTimer);
      onReady();
    }, 12000);

    initDatabase()
      .then(() => {
        const ms = Date.now() - t0;
        console.log(`QCA: DB ready in ${ms}ms`);
        clearInterval(dotTimer);
        clearTimeout(slowTimer);
        clearTimeout(hardTimeout);
        onReady();
      })
      .catch(err => {
        console.error('QCA: DB init failed →', err);
        clearInterval(dotTimer);
        clearTimeout(slowTimer);
        clearTimeout(hardTimeout);
        // Render app anyway — online features still work
        onReady();
      });

    return () => {
      clearInterval(dotTimer);
      clearTimeout(slowTimer);
      clearTimeout(hardTimeout);
    };
  }, [onReady]);

  return (
    <div data-back-root data-back-exit style={{
      position:        'fixed',
      inset:           0,
      backgroundColor: '#001f3f',
      display:         'flex',
      flexDirection:   'column',
      alignItems:      'center',
      justifyContent:  'center',
      fontFamily:      'sans-serif',
      userSelect:      'none',
    }}>
      {/* Logo / emblem */}
      <img
        src="/logo_256.jpg"
        alt="QCA"
        onError={e => (e.currentTarget.style.display = 'none')}
        style={{
          width:        120,
          height:       120,
          objectFit:    'contain',
          marginBottom: 32,
          opacity:      0.95,
        }}
      />

      {/* Academy name */}
      <div style={{
        color:          '#c5a059',
        fontWeight:     900,
        fontSize:       22,
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        marginBottom:   6,
      }}>
        Quickies Cricket
      </div>
      <div style={{
        color:         'rgba(255,255,255,0.45)',
        fontSize:      11,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        marginBottom:  48,
      }}>
        Academy
      </div>

      {/* Loading indicator */}
      <div style={{
        display:       'flex',
        flexDirection: 'column',
        alignItems:    'center',
        gap:           12,
      }}>
        {/* Spinner ring */}
        <div style={{
          width:        32,
          height:       32,
          borderRadius: '50%',
          border:       '3px solid rgba(197,160,89,0.2)',
          borderTop:    '3px solid #c5a059',
          animation:    'qca-spin 0.8s linear infinite',
        }} />

        <div style={{
          color:    'rgba(255,255,255,0.5)',
          fontSize: 12,
          minWidth: 120,
          textAlign:'center',
        }}>
          {status}{dots}
        </div>

        {slow && (
          <div style={{
            color:      'rgba(255,255,255,0.3)',
            fontSize:   10,
            textAlign:  'center',
            maxWidth:   220,
            lineHeight: 1.5,
            marginTop:  4,
          }}>
            First launch takes longer.{'\n'}
            Setting up offline database…
          </div>
        )}
      </div>

      {/* CSS animation injected inline */}
      <style>{`
        @keyframes qca-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ── Root component — controls boot sequence ───────────────────────────────────
function Root() {
  const [ready, setReady] = useState(false);

  // index.html paints the body navy so there's no white flash before this mounts;
  // hand back to the normal light background once the app is ready
  useEffect(() => { if (ready) document.body.style.backgroundColor = ''; }, [ready]);
  // Android back button: popups, unsaved-changes prompt, screens, exit (shared/backNav)
  useEffect(() => installBackButton(), []);

  if (!ready) {
    return <BootSplash onReady={() => setReady(true)} />;
  }

  return (<>
    <AppLock>
      <App />
    </AppLock>
    <LeaveDialogHost />
  </>);
}

// ── Mount immediately — first frame renders BootSplash (hides Android splash) ─
const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}
