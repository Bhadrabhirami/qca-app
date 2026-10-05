/**
 * about.tsx — About Us / Our People
 * Same look as the rest of the app: green header, light page, white cards
 * with hairline rows. Members from /api/data/about, contact from /contact/info.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APP_VERSION, BUILD_NUMBER } from '../shared/version';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';

const C = {
  green: '#1a472a', gold: '#d4af37', bg: '#f4f7f6', card: '#fff',
  border: '#e8e8e8', muted: '#6b7280', text: '#1f2937',
};
const CARD: React.CSSProperties = { backgroundColor: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' };

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
  return { 'Content-Type':'application/json', 'X-Username':localStorage.getItem('auth_user')??'' };
}

type Member = {
  name: string; category: string; position?: string;
  image_url?: string; status: string;
  coach_bio?: string; is_coach?: boolean;
};

// ── Avatar with authenticated blob fetch ──────────────────────────────────────
function Avatar({ name, src, size }: { name:string; src?:string; size:number }) {
  const [objUrl, setObjUrl] = useState<string|null>(null);
  const initials = name.trim().split(/\s+/).slice(0,2).map(w=>w[0]?.toUpperCase()??'').join('');
  const hue = (name.charCodeAt(0)||65)*37%360;

  useEffect(() => {
    if (!src) return;
    let cancelled = false; let created:string|null = null;
    const url = src.startsWith('http') ? src : `${bld()}${src}`;
    fetch(url, { headers: hdr() }).then(r=>r.ok?r.blob():null).then(blob=>{
      if (blob && !cancelled) { created=URL.createObjectURL(blob); setObjUrl(created); }
    }).catch(()=>{});
    return () => { cancelled=true; if(created) URL.revokeObjectURL(created); };
  }, [src]);

  const ring = `2px solid ${C.gold}55`;
  if (objUrl) return <img src={objUrl} alt={name} style={{ width:size, height:size, borderRadius:'50%', objectFit:'cover', border:ring, flexShrink:0 }} />;
  return (
    <div style={{ width:size, height:size, borderRadius:'50%', flexShrink:0, border:ring,
      backgroundColor:`hsl(${hue},35%,90%)`, color:`hsl(${hue},45%,30%)`,
      display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:size*0.36 }}>
      {initials}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────
const SectionLabel = ({ children, count }: { children: React.ReactNode; count?: number }) => (
  <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase' as const, margin:'6px 2px 0' }}>
    {children}{count ? <span style={{ fontWeight:600 }}> · {count}</span> : null}
  </div>
);

function PersonRow({ m, first, badge }: { m:Member; first:boolean; badge?:string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop: first ? 'none' : `1px solid ${C.border}` }}>
      <Avatar name={m.name} src={m.image_url} size={38} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:800, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</div>
        {m.position && (
          <div style={{ fontSize:11, fontWeight:700, color:C.green, marginTop:1, textTransform:'uppercase' as const, letterSpacing:0.4,
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.position}</div>
        )}
      </div>
      {badge && <span style={{ fontSize:14, flexShrink:0 }}>{badge}</span>}
    </div>
  );
}

function CoachRow({ m, first }: { m:Member; first:boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding:'9px 12px', borderTop: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <Avatar name={m.name} src={m.image_url} size={44} />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:800, fontSize:14 }}>{m.name}</div>
          <div style={{ fontSize:11, fontWeight:700, color:C.green, marginTop:1, textTransform:'uppercase' as const, letterSpacing:0.4 }}>
            🏏 {m.position || 'Coach'}
          </div>
        </div>
      </div>
      {m.coach_bio && (
        <button onClick={() => setOpen(v => !v)} aria-expanded={open}
          style={{ display:'block', width:'100%', textAlign:'left' as const, background:'none', border:'none', padding:'6px 0 0 54px',
            fontSize:12.5, color:'#374151', lineHeight:1.5, cursor:'pointer',
            ...(open ? {} : { display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' as const, overflow:'hidden' }) }}>
          {m.coach_bio}
        </button>
      )}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function AboutScreen() {
  const navigate = useNavigate();
  const [members, setMembers] = useState<Member[]>([]);
  const [contact, setContact] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = () => {
    setLoading(true); setError('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    fetch(`${bld()}/api/data/about`, { headers: hdr(), signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { const arr = j.data?.members || j.members || j.data || (Array.isArray(j) ? j : []); setMembers(arr); setLoading(false); })
      .catch(e => { setError(e.name === 'AbortError' ? 'Server did not respond' : (e.message || 'Failed to load')); setLoading(false); })
      .finally(() => clearTimeout(timer));
    fetch(`${bld()}/api/data/contact/info`, { headers: hdr() })
      .then(r => r.ok ? r.json() : null).then(j => j?.data && setContact(j.data)).catch(() => {});
  };

  useEffect(load, []);

  const published = members.filter(m => m.status === 'Published');
  const coaches   = published.filter(m => m.is_coach);
  const patrons   = published.filter(m => m.category === 'Patron' && !m.is_coach);
  const bearers   = published.filter(m => (m.category === 'Office Bearer' || m.category === 'Executive') && !m.is_coach);
  const general   = published.filter(m => m.category === 'General' && !m.is_coach);

  const social   = contact?.social || {};
  const waDigits = String(contact?.whatsapp || '').replace(/\D/g, '');
  const contactRows = contact ? [
    contact.phone    && { icon:'📞', label:contact.phone,                 href:`tel:${String(contact.phone).replace(/\s/g,'')}` },
    waDigits         && { icon:'💬', label:'WhatsApp',                    href:`https://wa.me/${waDigits}` },
    contact.email    && { icon:'✉️', label:contact.email,                 href:`mailto:${contact.email}` },
    social.instagram && { icon:'📸', label:`@${social.instagram}`,        href:`https://instagram.com/${social.instagram}` },
    social.facebook  && { icon:'📘', label:social.facebook,               href:`https://facebook.com/${social.facebook}` },
    social.youtube   && { icon:'▶️', label:social.youtube,                href:`https://youtube.com/@${social.youtube}` },
  ].filter(Boolean) as { icon:string; label:string; href:string }[] : [];

  const stat = (value: string|number, label: string, first?: boolean) => (
    <div style={{ flex:1, padding:'7px 4px', textAlign:'center' as const, borderLeft: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize:16, fontWeight:900, color:C.green }}>{value}</div>
      <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.4px' }}>{label}</div>
    </div>
  );

  return (
    <div style={{ backgroundColor:C.bg, minHeight:'100%', paddingBottom:24, fontFamily:'sans-serif', color:C.text }}>
      <ScreenHeader title="About QCA" subtitle="Our academy and people"
        actions={<HeaderIconButton label="Reload" onClick={load}>↻</HeaderIconButton>} />

      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>

        {/* ── Academy ── */}
        <div style={CARD}>
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px' }}>
            <img src="/logo.png" alt="QCA" style={{ width:56, height:56, borderRadius:14, objectFit:'contain', flexShrink:0,
              backgroundColor:'#f0f4f0', border:`1px solid ${C.border}` }} />
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:900, fontSize:16, color:C.green, lineHeight:1.2 }}>Quickies Cricket Academy</div>
              <div style={{ fontSize:11, fontWeight:700, color:C.muted, marginTop:2 }}>Trivandrum · Kerala</div>
              <div style={{ fontSize:12, fontStyle:'italic', fontWeight:700, color:'#a8862a', marginTop:3 }}>
                Build Character before Champions
              </div>
            </div>
          </div>
          <div style={{ padding:'0 12px 10px', fontSize:12.5, color:'#4b5563', lineHeight:1.55 }}>
            Nurturing the next generation of cricket talent with world-class coaching, discipline, and a deep passion for the game.
          </div>
          <div style={{ display:'flex', borderTop:`1px solid ${C.border}`, backgroundColor:'#fafafa' }}>
            {stat(loading ? '…' : published.length || '—', 'Members', true)}
            {stat(loading ? '…' : coaches.length || '—', 'Coaches')}
            {stat('1983', 'Founded')}
          </div>
        </div>

        {loading && <div style={{ textAlign:'center' as const, color:C.muted, padding:24, fontSize:13 }}>Loading members…</div>}

        {!loading && error && (
          <div style={{ ...CARD, padding:'18px 16px', textAlign:'center' as const }}>
            <div style={{ fontWeight:800, fontSize:13, color:'#b91c1c', marginBottom:4 }}>⚠ Couldn't load members</div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>{error}</div>
            <button onClick={load} style={{ padding:'8px 18px', borderRadius:9, border:'none', backgroundColor:C.green,
              color:'#fff', fontWeight:800, fontSize:13, cursor:'pointer' }}>Retry</button>
          </div>
        )}

        {!loading && !error && (<>
          {coaches.length > 0 && (<>
            <SectionLabel count={coaches.length}>Coaching staff</SectionLabel>
            <div style={CARD}>{coaches.map((m,i) => <CoachRow key={m.name+i} m={m} first={i===0} />)}</div>
          </>)}

          {patrons.length > 0 && (<>
            <SectionLabel count={patrons.length}>Patrons</SectionLabel>
            <div style={CARD}>{patrons.map((m,i) => <PersonRow key={m.name+i} m={m} first={i===0} badge="⭐" />)}</div>
          </>)}

          {bearers.length > 0 && (<>
            <SectionLabel count={bearers.length}>Office bearers</SectionLabel>
            <div style={CARD}>{bearers.map((m,i) => <PersonRow key={m.name+i} m={m} first={i===0} />)}</div>
          </>)}

          {general.length > 0 && (<>
            <SectionLabel count={general.length}>Permanent members</SectionLabel>
            <div style={{ ...CARD, padding:10, display:'flex', flexWrap:'wrap' as const, gap:6 }}>
              {general.map((m,i) => (
                <div key={m.name+i} style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 10px 3px 3px',
                  borderRadius:20, border:`1px solid ${C.border}`, backgroundColor:'#fafafa', fontSize:12, fontWeight:700 }}>
                  <Avatar name={m.name} src={m.image_url} size={24} />
                  {m.name}
                </div>
              ))}
            </div>
          </>)}

          {published.length === 0 && (
            <div style={{ ...CARD, padding:'18px 16px', textAlign:'center' as const, color:C.muted, fontSize:13 }}>No members listed yet.</div>
          )}
        </>)}

        {/* ── Contact ── */}
        <SectionLabel>Get in touch</SectionLabel>
        <div style={CARD}>
          {contactRows.map((r, i) => (
            <a key={r.href} href={r.href} target={r.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer"
              style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px', textDecoration:'none', color:C.text,
                borderTop: i ? `1px solid ${C.border}` : 'none' }}>
              <span style={{ fontSize:16, width:26, textAlign:'center' as const }}>{r.icon}</span>
              <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.label}</span>
              <span style={{ color:C.muted, fontSize:14 }}>›</span>
            </a>
          ))}
          <button onClick={() => navigate('/contact')}
            style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'9px 12px', background:'none', border:'none',
              borderTop: contactRows.length ? `1px solid ${C.border}` : 'none', cursor:'pointer', textAlign:'left' as const }}>
            <span style={{ fontSize:16, width:26, textAlign:'center' as const }}>📍</span>
            <span style={{ flex:1, minWidth:0 }}>
              <span style={{ display:'block', fontSize:13, fontWeight:700, color:C.text }}>Location, timings & map</span>
              {contact?.location && <span style={{ display:'block', fontSize:11, color:C.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{contact.location}</span>}
            </span>
            <span style={{ color:C.muted, fontSize:14 }}>›</span>
          </button>
        </div>

        {/* ── Footer ── */}
        <div style={{ textAlign:'center' as const, fontSize:11, color:C.muted, lineHeight:1.8, marginTop:6 }}>
          QCA App · v{APP_VERSION} (build {BUILD_NUMBER})<br />
          <span style={{ fontSize:10 }}>Reg. No: TVM/TC/129/2025</span>
        </div>
      </div>
    </div>
  );
}
