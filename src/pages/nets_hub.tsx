import React from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader from '../shared/ScreenHeader';

export default function NetsHubScreen() {
  const navigate = useNavigate();
  const { can }  = usePermissions();

  const tiles = [
    { icon:'🏏', label:'Net Dashboard',  sub:'Today, bookings & verify',       path:'/nets',          slug:'nets:view'  },
    { icon:'📅', label:'Net Calendar',   sub:'Monthly calendar & slot grid',   path:'/nets-calendar', slug:'nets:view'  },
    { icon:'⚙️', label:'Nets Admin',     sub:'Members, pricing, hours & more', path:'/nets-admin',    slug:'nets:admin' },
  ].filter(t => can(t.slug as any));

  return (
    <div style={{backgroundColor:'#f0f2f5',minHeight:'100vh',paddingBottom:80}}>
      <ScreenHeader title="🏟 Net Booking" background="#0d1b2a" />
      <div style={{padding:16}}>
        {tiles.map(t => (
          <button key={t.path} onClick={()=>navigate(t.path)}
            style={{width:'100%',backgroundColor:'#fff',borderRadius:14,
              padding:'16px 18px',marginBottom:10,border:'1px solid #e0e0e0',
              display:'flex',alignItems:'center',gap:14,cursor:'pointer',
              textAlign:'left' as const,boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}>
            <span style={{fontSize:28,flexShrink:0}}>{t.icon}</span>
            <div>
              <div style={{fontWeight:800,fontSize:15,color:'#0d1b2a'}}>{t.label}</div>
              <div style={{fontSize:12,color:'#6b7280',marginTop:2}}>{t.sub}</div>
            </div>
            <span style={{marginLeft:'auto',color:'#6b7280',fontSize:18}}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
