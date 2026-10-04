/**
 * about.tsx — About Us / Our People
 * Redesigned with hero header, mission statement, stats bar, and polished cards.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APP_VERSION, BUILD_NUMBER } from '../shared/version';
import ScreenHeader from '../shared/ScreenHeader';

const C = {
  navy: '#0d1b2a', gold: '#c5a059', green: '#1a472a',
  bg: '#f0f2f5', card: '#fff', border: '#e5e7eb', muted: '#6b7280',
};

function bld(): string {
  const ip = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
  if (!ip) return '';
  return ip.startsWith('http') ? ip : `http://${ip}`;
}
function hdr(): Record<string,string> {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) { window.dispatchEvent(new Event('jwt-expired')); return {}; }
    return { 'Content-Type':'application/json', 'Authorization':'Bearer '+jwt, 'X-Username':localStorage.getItem('auth_user')||'' };
  }
  return { 'Content-Type':'application/json', 'X-Username':localStorage.getItem('auth_user')??'', 'X-Password':localStorage.getItem('auth_pass')??'' };
}

type Member = {
  name: string; category: string; position?: string;
  image_url?: string; status: string;
  coach_bio?: string; is_coach?: boolean;
};

// ── Avatar with blob fetch ────────────────────────────────────────────────────
function Avatar({ name, src, size, border = C.gold }: { name:string; src?:string; size:number; border?:string }) {
  const [objUrl, setObjUrl] = useState<string|null>(null);
  const initials = name.trim().split(/\s+/).slice(0,2).map(w=>w[0]?.toUpperCase()??'').join('');
  const hue = (name.charCodeAt(0)||65)*37%360;

  useEffect(() => {
    if (!src) return;
    let cancelled = false; let created:string|null = null;
    const base = bld();
    const url = src.startsWith('http') ? src : `${base}${src}`;
    fetch(url, { headers: hdr() }).then(r=>r.ok?r.blob():null).then(blob=>{
      if (blob && !cancelled) { created=URL.createObjectURL(blob); setObjUrl(created); }
    }).catch(()=>{});
    return () => { cancelled=true; if(created) URL.revokeObjectURL(created); };
  }, [src]);

  if (objUrl) return <img src={objUrl} alt={name} style={{ width:size, height:size, borderRadius:'50%', objectFit:'cover', border:`2px solid ${border}`, flexShrink:0 }} />;
  return (
    <div style={{ width:size, height:size, borderRadius:'50%', flexShrink:0,
      backgroundColor:`hsl(${hue},40%,28%)`, display:'flex', alignItems:'center', justifyContent:'center',
      color:`hsl(${hue},60%,82%)`, fontWeight:900, fontSize:size*0.35, border:`2px solid ${border}` }}>
      {initials}
    </div>
  );
}

// ── Coach card ────────────────────────────────────────────────────────────────
function CoachCard({ m }: { m:Member }) {
  return (
    <div style={{ backgroundColor:C.card, borderRadius:16, overflow:'hidden', boxShadow:'0 2px 12px rgba(13,27,42,0.12)', marginBottom:12 }}>
      <div style={{ background:`linear-gradient(135deg, ${C.navy} 0%, #1e3a5f 100%)`, padding:'20px 16px', display:'flex', alignItems:'center', gap:16 }}>
        <Avatar name={m.name} src={m.image_url} size={64} border={C.gold} />
        <div>
          <div style={{ color:'#fff', fontWeight:900, fontSize:16 }}>{m.name}</div>
          {m.position && <div style={{ color:C.gold, fontSize:11, fontWeight:700, textTransform:'uppercase' as const, letterSpacing:1, marginTop:3 }}>{m.position}</div>}
          <div style={{ display:'inline-block', backgroundColor:'rgba(197,160,89,0.2)', color:C.gold, padding:'2px 10px', borderRadius:20, fontSize:10, fontWeight:700, marginTop:6 }}>🏏 Coach</div>
        </div>
      </div>
      {m.coach_bio && (
        <div style={{ padding:'14px 16px', fontSize:13, color:'#374151', lineHeight:1.65, borderTop:`1px solid ${C.border}` }}>{m.coach_bio}</div>
      )}
    </div>
  );
}

// ── Patron card ───────────────────────────────────────────────────────────────
function PatronCard({ m }: { m:Member }) {
  return (
    <div style={{ backgroundColor:C.card, borderRadius:16, padding:'20px 12px', textAlign:'center' as const,
      boxShadow:'0 2px 8px rgba(0,0,0,0.06)', border:`1px solid ${C.border}` }}>
      <div style={{ display:'flex', justifyContent:'center', marginBottom:12 }}>
        <div style={{ position:'relative' as const }}>
          <Avatar name={m.name} src={m.image_url} size={72} border={C.gold} />
          <div style={{ position:'absolute' as const, bottom:-4, right:-4, width:22, height:22,
            backgroundColor:C.gold, borderRadius:'50%', display:'flex', alignItems:'center',
            justifyContent:'center', fontSize:11, border:'2px solid #fff' }}>⭐</div>
        </div>
      </div>
      <div style={{ fontWeight:800, fontSize:13, color:C.navy, marginBottom:4 }}>{m.name}</div>
      {m.position && <div style={{ fontSize:11, color:C.muted, fontWeight:600 }}>{m.position}</div>}
    </div>
  );
}

// ── Office Bearer row ─────────────────────────────────────────────────────────
function BearerRow({ m }: { m:Member }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 16px',
      backgroundColor:C.card, borderRadius:12, marginBottom:8,
      boxShadow:'0 1px 4px rgba(0,0,0,0.06)', border:`1px solid ${C.border}` }}>
      <Avatar name={m.name} src={m.image_url} size={46} border={C.gold} />
      <div style={{ flex:1 }}>
        <div style={{ fontWeight:800, fontSize:14, color:C.navy }}>{m.name}</div>
        {m.position && <div style={{ fontSize:11, fontWeight:700, color:C.green, marginTop:2, textTransform:'uppercase' as const, letterSpacing:0.5 }}>{m.position}</div>}
      </div>
      <div style={{ width:8, height:8, borderRadius:'50%', backgroundColor:C.gold }} />
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
function Section({ label, title, children }: { label:string; title:string; children:React.ReactNode }) {
  return (
    <div style={{ marginBottom:28 }}>
      <div style={{ fontSize:10, fontWeight:800, color:C.gold, textTransform:'uppercase' as const, letterSpacing:'2px', marginBottom:4 }}>{label}</div>
      <div style={{ fontWeight:900, fontSize:20, color:C.navy, marginBottom:14 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }: { text:string }) {
  return <div style={{ color:C.muted, fontSize:13, padding:'8px 0' }}>{text}</div>;
}

function Stat({ value, label }: { value:string; label:string }) {
  return (
    <div style={{ textAlign:'center' as const }}>
      <div style={{ fontSize:26, fontWeight:900, color:C.gold }}>{value}</div>
      <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.55)', textTransform:'uppercase' as const, letterSpacing:1, marginTop:2 }}>{label}</div>
    </div>
  );
}


// ── Academy emblem ────────────────────────────────────────────────────────────
function EmblemImg() {
  const [err, setErr] = React.useState(false);
  const src = `${bld()}/static/images/emblem.png`;
  if (!err) {
    return (
      <img src={src} alt="QCA" onError={() => setErr(true)}
        style={{ width:64, height:64, borderRadius:16, objectFit:'contain',
          border:`2px solid ${C.gold}`, flexShrink:0, backgroundColor:'rgba(197,160,89,0.08)' }} />
    );
  }
  return (
    <div style={{ width:64, height:64, borderRadius:16, backgroundColor:'rgba(197,160,89,0.12)',
      border:`2px solid ${C.gold}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28, flexShrink:0 }}>
      🏏
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function AboutScreen() {
  const navigate = useNavigate();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = () => {
    setLoading(true); setError('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    fetch(`${bld()}/api/data/about`, { headers: hdr(), signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { const arr = j.data?.members || j.members || j.data || (Array.isArray(j) ? j : []); setMembers(arr); setLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message || 'Failed to load'); setLoading(false); } });
    return () => { clearTimeout(timer); controller.abort(); };
  };

  useEffect(load, []);

  const published = members.filter(m => m.status === 'Published');
  const coaches   = published.filter(m => m.is_coach);
  const patrons   = published.filter(m => m.category === 'Patron' && !m.is_coach);
  const bearers   = published.filter(m => (m.category === 'Office Bearer' || m.category === 'Executive') && !m.is_coach);
  const general   = published.filter(m => m.category === 'General' && !m.is_coach);

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100vh', paddingBottom:48, fontFamily:'sans-serif' }}>

      <ScreenHeader title="About QCA" background={C.navy} />

      {/* ── Hero ── */}
      <div style={{ background:`linear-gradient(155deg, ${C.navy} 0%, #0f2640 60%, #162a16 100%)`, paddingTop:16, paddingBottom:0 }}>
        <div style={{ padding:'0 16px' }}>
          {/* Emblem + name */}
          <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:16 }}>
            <div style={{ width:64, height:64, borderRadius:16, backgroundColor:'rgba(197,160,89,0.12)',
              border:`2px solid ${C.gold}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28, flexShrink:0 }}>
              🏏
            </div>
            <div>
              <div style={{ color:'rgba(197,160,89,0.7)', fontSize:10, fontWeight:800, textTransform:'uppercase' as const, letterSpacing:2, marginBottom:4 }}>Trivandrum · Kerala</div>
              <div style={{ color:'#fff', fontWeight:900, fontSize:20, lineHeight:1.15 }}>
                Quickies Cricket<br /><span style={{ color:C.gold }}>Academy</span>
              </div>
            </div>
          </div>

          {/* Mission */}
          <div style={{ borderLeft:`3px solid ${C.gold}`, paddingLeft:12, marginBottom:24 }}>
            <div style={{ color:'rgba(255,255,255,0.65)', fontSize:13, lineHeight:1.7 }}>
              Nurturing the next generation of cricket talent with world-class coaching, discipline, and a deep passion for the game.
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div style={{ background:'rgba(0,0,0,0.25)', padding:'16px 0', display:'grid', gridTemplateColumns:'repeat(3,1fr)', borderTop:'1px solid rgba(255,255,255,0.08)' }}>
          <Stat value={String(published.length||'—')} label="Members" />
          <Stat value="7" label="Coaches" />
          <Stat value="1983" label="Founded" />
        </div>
      </div>

      <div style={{ padding:'24px 16px 0' }}>

        {loading && (
          <div style={{ textAlign:'center' as const, color:C.muted, padding:48 }}>
            <div style={{ fontSize:32, marginBottom:12 }}>⏳</div>
            <div style={{ fontSize:14 }}>Loading members…</div>
          </div>
        )}

        {!loading && error && (
          <div style={{ textAlign:'center' as const, padding:'32px 16px', backgroundColor:'#fef2f2', borderRadius:16, marginBottom:16 }}>
            <div style={{ fontSize:28, marginBottom:8 }}>⚠️</div>
            <div style={{ fontWeight:800, fontSize:14, color:'#991b1b', marginBottom:4 }}>Couldn't load members</div>
            <div style={{ fontSize:12, color:'#7f1d1d', marginBottom:14 }}>{error}</div>
            <button onClick={load} style={{ padding:'8px 24px', borderRadius:20, border:'none', backgroundColor:C.navy, color:'#fff', fontWeight:700, fontSize:12, cursor:'pointer' }}>Retry</button>
          </div>
        )}

        {!loading && !error && (
          <>
            {coaches.length > 0 && (
              <Section label="Our Expertise" title="Coaching Staff">
                {coaches.map((m,i) => <CoachCard key={i} m={m} />)}
              </Section>
            )}

            <Section label="The Pillars" title="Distinguished Patrons">
              {patrons.length===0 ? <Empty text="No patrons listed yet." /> : (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:12 }}>
                  {patrons.map((m,i) => <PatronCard key={i} m={m} />)}
                </div>
              )}
            </Section>

            <Section label="Leadership" title="Office Bearers">
              {bearers.length===0 ? <Empty text="No office bearers listed yet." /> : (
                <div>{bearers.map((m,i) => <BearerRow key={i} m={m} />)}</div>
              )}
            </Section>

            <Section label="Our Community" title="Permanent Members">
              {general.length===0 ? <Empty text="No members listed yet." /> : (
                <div style={{ display:'flex', flexWrap:'wrap' as const, gap:8 }}>
                  {general.map((m,i) => (
                    <div key={i} style={{ backgroundColor:C.navy, color:C.gold, borderRadius:50,
                      padding:'5px 14px 5px 5px', fontSize:12, fontWeight:700,
                      display:'flex', alignItems:'center', gap:8, boxShadow:'0 1px 4px rgba(0,0,0,0.12)' }}>
                      <Avatar name={m.name} src={m.image_url} size={26} border={C.gold} />
                      {m.name}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* ── Contact block ── */}
            <div style={{ backgroundColor:C.navy, borderRadius:20, padding:'20px 16px', marginBottom:20 }}>
              <div style={{ color:C.gold, fontSize:10, fontWeight:800, textTransform:'uppercase' as const, letterSpacing:2, marginBottom:8 }}>Get In Touch</div>
              <div style={{ color:'#fff', fontWeight:800, fontSize:16, marginBottom:14 }}>Quickies Cricket Academy</div>
              <div style={{ display:'flex', flexDirection:'column' as const, gap:10 }}>
                {[
                  { icon:'📍', text:'Trivandrum, Kerala, India' },
                  { icon:'📞', text:'+91 94958 14568' },
                  { icon:'📸', text:'@quickiesclub' },
                  { icon:'📘', text:'quickiesclub' },
                ].map((item,i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontSize:14 }}>{item.icon}</span>
                    <span style={{ color:'rgba(255,255,255,0.65)', fontSize:13 }}>{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Version footer ── */}
        <div style={{ textAlign:'center' as const, paddingTop:16, borderTop:`1px solid ${C.border}` }}>
          <div style={{ fontSize:11, color:C.muted, lineHeight:2.2 }}>
            <span style={{ fontWeight:800, color:C.navy }}>Quickies Cricket Academy</span><br />
            QCA App · v{APP_VERSION} (build {BUILD_NUMBER})<br />
            <span style={{ fontSize:10 }}>Reg. No: TVM/TC/129/2025</span>
          </div>
        </div>
      </div>
    </div>
  );
}
