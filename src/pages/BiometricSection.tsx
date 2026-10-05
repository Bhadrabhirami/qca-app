import React, { useState, useEffect } from 'react';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';

const C = { green:'#1a472a', red:'#c0392b', muted:'#6b7280', border:'#e5e7eb' };

export default function BiometricSection() {
  const [status, setStatus]   = useState<any>(null);
  const [enabled, setEnabled] = useState(localStorage.getItem('biometric_enabled') === 'true');
  const [testing, setTesting] = useState(false);
  const [msg,     setMsg]     = useState('');

  useEffect(() => {
    BiometricAuth.checkBiometry().then(r => {
      setStatus(r);
      console.log('[BIO SETTINGS] checkBiometry:', JSON.stringify(r));
    }).catch(e => {
      console.log('[BIO SETTINGS] error:', e);
      setStatus({ isAvailable: false, reason: String(e) });
    });
  }, []);

  const testBiometric = async () => {
    setTesting(true); setMsg('');
    try {
      await BiometricAuth.authenticate({
        reason: 'Test biometric authentication',
        cancelTitle: 'Cancel',
        androidTitle: 'QCA Biometric Test',
      });
      setMsg('✅ Biometric authentication successful!');
    } catch(e: any) {
      setMsg('⚠ ' + (e?.message || String(e)));
    }
    setTesting(false);
  };

  const toggleBiometric = () => {
    const newVal = !enabled;
    setEnabled(newVal);
    localStorage.setItem('biometric_enabled', String(newVal));
    setMsg(newVal ? '✅ Biometric login enabled' : 'Biometric login disabled');
  };

  const available = !!status?.isAvailable;
  const sub = !status ? 'Checking this phone…'
    : !available ? (status.reason || 'Not available on this phone')
    : status.deviceIsSecure === false ? 'Set a phone screen lock first'
    : enabled ? '● On — asked when the app opens' : 'Unlock the app with your fingerprint';

  // Rendered as a row inside the Settings "Security" card
  return (
    <div style={{ padding:'9px 12px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:18, width:26, textAlign:'center', flexShrink:0 }}>👆</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:800, fontSize:13.5, color:'#1f2937' }}>Fingerprint unlock</div>
          <div style={{ fontSize:11.5, color: !status ? C.muted : !available ? C.red : enabled ? '#166534' : C.muted,
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{sub}</div>
        </div>
        {available && (
          <button onClick={testBiometric} disabled={testing}
            style={{ flexShrink:0, padding:'6px 11px', borderRadius:8, border:`1px solid ${C.green}`,
              backgroundColor:'#fff', color:C.green, fontWeight:700, fontSize:12, cursor:'pointer' }}>
            {testing ? '…' : 'Test'}
          </button>
        )}
        <button onClick={toggleBiometric} disabled={!available} role="switch" aria-checked={enabled && available}
          aria-label="Fingerprint unlock"
          style={{ position:'relative', width:44, height:24, borderRadius:12, border:'none', flexShrink:0,
            cursor: available ? 'pointer' : 'not-allowed',
            backgroundColor: enabled && available ? C.green : '#d1d5db', transition:'background-color 0.2s' }}>
          <span style={{ position:'absolute', top:3, left: enabled && available ? 23 : 3, width:18, height:18,
            borderRadius:'50%', backgroundColor:'#fff', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }}/>
        </button>
      </div>
      {msg && (
        <div style={{ marginTop:7, marginLeft:36, fontSize:12, padding:'6px 10px', borderRadius:8, fontWeight:600,
          backgroundColor: msg.startsWith('✅') ? '#e8f5e9' : '#fef2f2',
          color: msg.startsWith('✅') ? C.green : C.red }}>
          {msg}
        </div>
      )}
    </div>
  );
}
