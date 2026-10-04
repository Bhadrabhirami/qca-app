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

  if (!status) return <div style={{color:C.muted,fontSize:13}}>Checking...</div>;

  return (
    <div>
      <div style={{fontSize:13,marginBottom:12}}>
        <span style={{
          padding:'3px 10px', borderRadius:10, fontWeight:700, fontSize:12,
          backgroundColor: status.isAvailable ? '#e8f5e9' : '#fef2f2',
          color: status.isAvailable ? C.green : C.red,
        }}>
          {status.isAvailable ? '✅ Available' : '❌ Not Available'}
        </span>
        {status.biometryType !== undefined && (
          <span style={{marginLeft:8,fontSize:12,color:C.muted}}>
            Type: {status.biometryType}
          </span>
        )}
      </div>

      {status.reason && !status.isAvailable && (
        <div style={{fontSize:12,color:C.red,marginBottom:12}}>{status.reason}</div>
      )}

      {status.deviceIsSecure !== undefined && (
        <div style={{fontSize:12,color:C.muted,marginBottom:12}}>
          Device secure: {status.deviceIsSecure ? 'Yes' : 'No'}
        </div>
      )}

      {msg && (
        <div style={{fontSize:13,padding:'8px 12px',borderRadius:8,marginBottom:12,
          backgroundColor: msg.startsWith('✅') ? '#e8f5e9' : '#fef2f2',
          color: msg.startsWith('✅') ? C.green : C.red}}>
          {msg}
        </div>
      )}

      <div style={{display:'flex',gap:8}}>
        <button onClick={testBiometric} disabled={testing || !status.isAvailable}
          style={{flex:1,padding:'10px 0',borderRadius:10,border:'none',cursor:'pointer',
            fontWeight:700,fontSize:13,
            backgroundColor: status.isAvailable ? C.green : '#e5e7eb',
            color: status.isAvailable ? '#fff' : C.muted}}>
          {testing ? 'Testing…' : '🔐 Test Biometric'}
        </button>

        {status.isAvailable && (
          <button onClick={toggleBiometric}
            style={{flex:1,padding:'10px 0',borderRadius:10,
              border:`1px solid ${enabled ? C.red : C.green}`,cursor:'pointer',
              fontWeight:700,fontSize:13,
              backgroundColor:'#fff',
              color: enabled ? C.red : C.green}}>
            {enabled ? '🔴 Disable' : '🟢 Enable'}
          </button>
        )}
      </div>
    </div>
  );
}
