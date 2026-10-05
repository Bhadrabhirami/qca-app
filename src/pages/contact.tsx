/**
 * contact.tsx — QCA Contact & Enquiry ("Join the Squad")
 * Enquiry form mirrors the web app contact.html:
 *  - Same fields: Name, Email, Phone, Message
 *  - Same validation: name pattern, email, phone pattern, length limits
 *  - Same honeypot: website field always sent empty
 *  - Same XSS check on client + server
 * Details come from /api/data/contact/info (location, hours, phone, socials).
 */

import React, { useEffect, useState } from 'react';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

const C = {
  green: '#1a472a', gold: '#d4af37', red: '#dc2626', bg: '#f4f7f6',
  card: '#fff', border: '#e8e8e8', muted: '#6b7280', text: '#1f2937',
};
const CARD: React.CSSProperties = { backgroundColor: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' };

function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
}

// ── Open social media — native app if installed, browser fallback ─────────────
// Capacitor WebView: an anchor click hands the URL to Android's intent
// resolver → opens the native app if installed, browser otherwise.
function openExternal(url: string) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function socialUrl(type: 'instagram'|'youtube'|'facebook'|'whatsapp', handle: string) {
  const h = handle.replace(/^@+/, '').trim();
  if (type === 'instagram') return `https://www.instagram.com/${h}/`;
  if (type === 'youtube')   return `https://www.youtube.com/@${h}`;
  if (type === 'facebook')  return `https://www.facebook.com/${h}`;
  return `https://wa.me/${handle.replace(/[^0-9]/g, '')}`;
}

function hdr(): Record<string, string> {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) {
      // Token expired - trigger auto logout
      window.dispatchEvent(new Event('jwt-expired'));
      return { 'Content-Type': 'application/json' };
    }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return { 'Content-Type': 'application/json', 'X-Username': localStorage.getItem('auth_user') ?? '' };
}
// Same patterns as web app
const NAME_RE  = /^[A-Za-z\s\.\-]+$/;
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^[\d\+\-\s]+$/;
const XSS_RE   = /<script|javascript:|on\w+=/i;

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase' as const, margin:'6px 2px 0' }}>{children}</div>
);

/** One tappable row inside a card */
function Row({ icon, title, sub, onClick, first, chevron = true }: {
  icon: string; title: React.ReactNode; sub?: React.ReactNode; onClick?: () => void; first?: boolean; chevron?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={!onClick}
      style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'9px 12px', background:'none', border:'none',
        borderTop: first ? 'none' : `1px solid ${C.border}`, cursor: onClick ? 'pointer' : 'default', textAlign:'left' as const, color:C.text }}>
      <span style={{ fontSize:17, width:26, textAlign:'center' as const, flexShrink:0 }}>{icon}</span>
      <span style={{ flex:1, minWidth:0 }}>
        <span style={{ display:'block', fontSize:13.5, fontWeight:700 }}>{title}</span>
        {sub && <span style={{ display:'block', fontSize:11.5, color:C.muted, marginTop:1, overflowWrap:'anywhere' }}>{sub}</span>}
      </span>
      {onClick && chevron && <span style={{ color:C.muted, fontSize:15 }}>›</span>}
    </button>
  );
}

// ── Main Screen ──────────────────────────────────────────────────────────────
export default function ContactScreen() {
  const base = bld(localStorage.getItem('server_ip') ?? '');

  const [info, setInfo] = useState<any | null>(null);
  const [tab,  setTab]  = useState<'info' | 'enquiry'>('info');

  // Form state — same fields as web app
  const [name,       setName]       = useState('');
  const [email,      setEmail]      = useState('');
  const [phone,      setPhone]      = useState('');
  const [message,    setMessage]    = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status,     setStatus]     = useState<'idle'|'sent'|'error'|'bot'>('idle');
  const [errMsg,     setErrMsg]     = useState('');
  const [fieldErrs,  setFieldErrs]  = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`${base}/api/data/contact/info`, { headers: hdr() })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.data) setInfo(j.data); })
      .catch(() => {});
  }, [base]);

  // ── Validation — same rules as web app ──────────────────────────────────────
  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    const n = name.trim(), e = email.trim(), p = phone.trim(), m = message.trim();
    if (!n)              errs.name    = 'Please enter a valid name.';
    else if (!NAME_RE.test(n)) errs.name = 'Name should only contain letters, spaces, dots and hyphens.';
    else if (n.length > 100)   errs.name = 'Name too long (max 100).';
    if (!e)              errs.email   = 'Please enter a valid email.';
    else if (!EMAIL_RE.test(e)) errs.email = 'Please enter a valid email.';
    if (p && !PHONE_RE.test(p)) errs.phone = 'Please enter a valid phone number.';
    if (!m)              errs.message = 'Please enter your message.';
    else if (m.length < 10)   errs.message = 'Message too short.';
    setFieldErrs(errs);
    return Object.keys(errs).length === 0;
  };

  // ── Client XSS check — same as web app JS ───────────────────────────────────
  const hasXSS = (): boolean =>
    [name, email, phone, message].some(v => XSS_RE.test(v));

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (hasXSS()) { setStatus('error'); setErrMsg('Invalid characters detected.'); return; }
    if (!validate()) return;
    setSubmitting(true); setStatus('idle'); setErrMsg('');
    try {
      const r = await fetch(`${base}/api/data/contact/submit`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({
          name: name.trim(), email: email.trim(),
          phone: phone.trim(), message: message.trim(),
          website: '',  // honeypot always empty from app
        }),
      });
      const j = await r.json();
      if (j.success) {
        setStatus('sent');
        setName(''); setEmail(''); setPhone(''); setMessage('');
        setFieldErrs({});
      } else {
        setStatus('error');
        setErrMsg(j.error || 'Something went wrong. Please try again or contact us directly.');
      }
    } catch {
      setStatus('error');
      setErrMsg('Could not reach server. Please check your connection.');
    } finally {
      setSubmitting(false);
    }
  };

  const F: React.CSSProperties = {
    width: '100%', padding: '9px 11px', borderRadius: 9,
    border: `1px solid ${C.border}`, fontSize: 14, outline: 'none',
    fontFamily: 'inherit', boxSizing: 'border-box' as const, backgroundColor: '#fff',
  };
  const fErr = (key: string): React.CSSProperties => fieldErrs[key] ? { ...F, borderColor: C.red } : F;
  const L: React.CSSProperties = { display:'block', fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase' as const, letterSpacing:'0.5px', marginBottom:4 };
  const FieldErr = ({ k }: { k: string }) => fieldErrs[k] ? <div style={{ fontSize:11, color:C.red, marginTop:3 }}>{fieldErrs[k]}</div> : null;

  const lat     = info?.lat || 8.453111;
  const lng     = info?.lng || 76.992833;
  const mapsUrl = `https://maps.google.com/maps?q=${lat},${lng}`;
  const telUrl  = info?.phone ? `tel:${String(info.phone).replace(/\s/g, '')}` : '';
  const social  = info?.social || {};

  const quick = [
    telUrl         && { icon:'📞', label:'Call',       go: () => { window.location.href = telUrl; } },
    info?.whatsapp && { icon:'💬', label:'WhatsApp',   go: () => openExternal(socialUrl('whatsapp', info.whatsapp)) },
                      { icon:'🧭', label:'Directions', go: () => openExternal(mapsUrl) },
  ].filter(Boolean) as { icon:string; label:string; go:()=>void }[];

  const follows = [
    social.instagram && { icon:'📸', title:'Instagram', sub:`@${social.instagram}`, url: socialUrl('instagram', social.instagram) },
    social.youtube   && { icon:'▶️', title:'YouTube',   sub:social.youtube,         url: socialUrl('youtube',   social.youtube) },
    social.facebook  && { icon:'📘', title:'Facebook',  sub:social.facebook,        url: socialUrl('facebook',  social.facebook) },
  ].filter(Boolean) as { icon:string; title:string; sub:string; url:string }[];

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100%', paddingBottom: 24, fontFamily: 'sans-serif', color: C.text }}>

      <ScreenHeader
        title={<>Join the <span style={{ color: C.gold }}>Squad</span></>}
        subtitle="Get in touch — we're only a message away">
        <HeaderTabs value={tab} onChange={setTab}
          tabs={[{ id: 'info' as const, label: '📋 Details' }, { id: 'enquiry' as const, label: '✉️ Enquiry' }]} />
      </ScreenHeader>

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* ══ DETAILS ══ */}
        {tab === 'info' && (<>
          {/* Quick actions */}
          <div style={{ display:'grid', gridTemplateColumns:`repeat(${quick.length},1fr)`, gap:8 }}>
            {quick.map(q => (
              <button key={q.label} onClick={q.go} style={{ ...CARD, padding:'10px 4px', cursor:'pointer',
                display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                <span style={{ fontSize:20 }}>{q.icon}</span>
                <span style={{ fontSize:12, fontWeight:800, color:C.green }}>{q.label}</span>
              </button>
            ))}
          </div>

          <SectionLabel>Academy ground</SectionLabel>
          <div style={CARD}>
            <Row first icon="📍" title="Location" sub={info?.location || 'Academy Ground'} onClick={() => openExternal(mapsUrl)} />
            <Row icon="🕐" title="Training hours" chevron={false}
              sub={<>Morning {info?.hours_morning || '6:00 AM – 9:00 AM'}<br />Evening {info?.hours_evening || '4:00 PM – 7:00 PM'}</>} />
          </div>

          {(info?.phone || info?.email || info?.whatsapp) && (<>
            <SectionLabel>Contact</SectionLabel>
            <div style={CARD}>
              {info?.phone    && <Row first icon="📞" title={info.phone} sub="Call the academy" onClick={() => { window.location.href = telUrl; }} />}
              {info?.whatsapp && <Row first={!info?.phone} icon="💬" title="WhatsApp" sub={info.whatsapp}
                onClick={() => openExternal(socialUrl('whatsapp', info.whatsapp))} />}
              {info?.email    && <Row first={!info?.phone && !info?.whatsapp} icon="✉️" title={info.email} sub="Send an email"
                onClick={() => { window.location.href = `mailto:${info.email}`; }} />}
            </div>
          </>)}

          {follows.length > 0 && (<>
            <SectionLabel>Follow us</SectionLabel>
            <div style={CARD}>
              {follows.map((f, i) => <Row key={f.title} first={i===0} icon={f.icon} title={f.title} sub={f.sub} onClick={() => openExternal(f.url)} />)}
            </div>
          </>)}

          <button onClick={() => setTab('enquiry')} style={{
            width:'100%', marginTop:4, padding:'11px', borderRadius:11, border:'none',
            backgroundColor:C.green, color:C.gold, fontWeight:900, fontSize:14, cursor:'pointer',
          }}>✉️ Send us a message</button>
        </>)}

        {/* ══ ENQUIRY ══ */}
        {tab === 'enquiry' && (<>
          {status === 'sent' && (
            <div style={{ padding:'9px 12px', borderRadius:10, backgroundColor:'#dcfce7', border:'1px solid #86efac' }}>
              <div style={{ fontWeight:800, fontSize:13, color:'#166534' }}>✅ Message sent!</div>
              <div style={{ fontSize:12, color:'#166534', marginTop:2 }}>
                We'll get back to you shortly. Our team will also reach out via WhatsApp.
              </div>
            </div>
          )}
          {status === 'error' && (
            <div style={{ padding:'9px 12px', borderRadius:10, backgroundColor:'#fee2e2', border:'1px solid #fca5a5' }}>
              <div style={{ fontWeight:800, fontSize:13, color:C.red }}>⚠ Something went wrong.</div>
              <div style={{ fontSize:12, color:C.red, marginTop:2 }}>{errMsg || 'Please try again or contact us directly.'}</div>
            </div>
          )}

          <div style={{ ...CARD, padding:12, display:'flex', flexDirection:'column', gap:10 }}>
            <div>
              <label style={L} htmlFor="c-name">Your name</label>
              <input id="c-name" value={name} onChange={e => setName(e.target.value)}
                maxLength={100} autoComplete="name" style={fErr('name')} />
              <FieldErr k="name" />
            </div>
            <div>
              <label style={L} htmlFor="c-email">Email</label>
              <input id="c-email" value={email} onChange={e => setEmail(e.target.value)}
                maxLength={150} type="email" inputMode="email" autoComplete="email" style={fErr('email')} />
              <FieldErr k="email" />
            </div>
            <div>
              <label style={L} htmlFor="c-phone">Phone <span style={{ fontWeight:600, textTransform:'none' as const }}>(optional)</span></label>
              <input id="c-phone" value={phone} onChange={e => setPhone(e.target.value)}
                maxLength={15} type="tel" inputMode="tel" autoComplete="tel" style={fErr('phone')} />
              <FieldErr k="phone" />
            </div>
            <div>
              <label style={L} htmlFor="c-msg">Message</label>
              <textarea id="c-msg" value={message} onChange={e => setMessage(e.target.value)}
                placeholder="How can we help your cricket journey?"
                maxLength={1000} rows={5} style={{ ...fErr('message'), resize:'none' as const }} />
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:2 }}>
                <FieldErr k="message" />
                <span style={{ fontSize:11, color:C.muted, marginLeft:'auto' }}>{message.length} / 1000</span>
              </div>
            </div>

            <button onClick={handleSubmit} disabled={submitting} style={{
              width:'100%', padding:'11px', borderRadius:11, border:'none',
              backgroundColor: submitting ? '#9ca3af' : C.green, color: submitting ? '#fff' : C.gold,
              fontWeight:900, fontSize:14, cursor: submitting ? 'not-allowed' : 'pointer',
            }}>
              {submitting ? '⏳ Sending…' : '✉️ Send message'}
            </button>
            <div style={{ textAlign:'center' as const, fontSize:11, color:C.muted }}>
              🔒 Your information is secure and will never be shared.
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}
