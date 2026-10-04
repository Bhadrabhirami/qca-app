/**
 * contact.tsx — QCA Contact & Enquiry
 * Mirrors the web app contact.html exactly:
 *  - Same fields: Name, Email, Phone, Message
 *  - Same validation: name pattern, email, phone pattern, length limits
 *  - Same honeypot: website field hidden
 *  - Same XSS check on client + server
 *  - Training hours, map link, address, social handle
 *  - Accessible by all roles (app:contact permission)
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

const C = {
  navy: '#0d1b2a', gold: '#c5a059', red: '#dc2626',
  green: '#1a472a', bg: '#f0f2f5', card: '#fff',
  border: '#e0e0e0', muted: '#6b7280',
};

function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
}

// ── Open social media — native app if installed, browser fallback ─────────────
// Capacitor WebView: window.open(url, '_system') hands the URL to Android's
// intent resolver → opens the native app if installed, browser otherwise.
function openSocialApp(type: 'instagram'|'youtube'|'facebook'|'whatsapp', handle: string) {
  if (!handle) return;
  const h     = handle.replace(/^@+/, '').trim();
  const phone = handle.replace(/[^0-9]/g, '');

  // Build the URL to open
  let url = '';
  if (type === 'instagram') url = `https://www.instagram.com/${h}/`;
  if (type === 'youtube')   url = `https://www.youtube.com/@${h}`;
  if (type === 'facebook')  url = `https://www.facebook.com/${h}`;
  if (type === 'whatsapp')  url = `https://wa.me/${phone}`;
  if (!url) return;

  // Create a hidden anchor and click it — this is the most reliable way
  // to open external URLs in Capacitor without trapping the user inside the app.
  // The anchor fires Android's intent chooser → opens YouTube/FB/etc as separate app.
  // User can press Android back button to return to QCA app normally.
  const a = document.createElement('a');
  a.href   = url;
  a.target = '_blank';
  a.rel    = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
function hdr() {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) {
      // Token expired - trigger auto logout
      window.dispatchEvent(new Event('jwt-expired'));
      return {};
    }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return {
    'Content-Type': 'application/json',
    'X-Username':   localStorage.getItem('auth_user') ?? '',
    'X-Password':   localStorage.getItem('auth_pass') ?? '',
  };
}
// Same patterns as web app
const NAME_RE  = /^[A-Za-z\s\.\-]+$/;
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^[\d\+\-\s]+$/;
const XSS_RE   = /<script|javascript:|on\w+=/i;

// ── Map Link component ────────────────────────────────────────────────────────
function MapCard({ lat = 8.453111, lng = 76.992833, location = '' }) {
  const mapsUrl = `https://maps.google.com/maps?q=${lat},${lng}`;
  return (
    <div style={{
      backgroundColor: C.card, borderRadius: 16, overflow: 'hidden',
      boxShadow: '0 8px 24px rgba(0,0,0,0.10)', marginBottom: 16,
      border: `1px solid ${C.border}`,
    }}>
      {/* Static map preview — opens Google Maps on tap */}
      <a href={mapsUrl} target="_blank" rel="noreferrer noopener" style={{ display: 'block' }}>
        <div style={{
          height: 160, backgroundColor: '#e8f0e8',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', position: 'relative',
          backgroundImage: `url(https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=14&size=600x300&markers=color:red|${lat},${lng}&key=)`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        }}>
          <div style={{
            backgroundColor: 'rgba(13,27,42,0.75)',
            borderRadius: 12, padding: '12px 20px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>📍</div>
            <div style={{ color: '#fff', fontWeight: 800, fontSize: 13 }}>
              Tap to Get Directions
            </div>
            {location && (
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 }}>
                {location}
              </div>
            )}
          </div>
        </div>
      </a>
      <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12, color: C.muted }}>
          📍 {location || 'Academy Ground'}
        </div>
        <a href={mapsUrl} target="_blank" rel="noreferrer"
          style={{
            padding: '6px 14px', borderRadius: 20, backgroundColor: C.navy,
            color: C.gold, fontSize: 11, fontWeight: 800, textDecoration: 'none',
          }}>
          GET DIRECTIONS ›
        </a>
      </div>
    </div>
  );
}

// ── Info pill ────────────────────────────────────────────────────────────────
function InfoPill({ icon, title, lines, href, onClick }: {
  icon: string; title: string; lines: string[]; href?: string; onClick?: () => void;
}) {
  const inner = (
    <div style={{
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderRadius: 16, padding: '16px 18px', marginBottom: 10,
      boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
      display: 'flex', alignItems: 'flex-start', gap: 14,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, backgroundColor: '#f0f4f1',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 4 }}>{title}</div>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>{l}</div>
        ))}
      </div>
      {href && <div style={{ color: C.gold, fontSize: 20, alignSelf: 'center' }}>›</div>}
    </div>
  );
  if (onClick) return <div onClick={onClick} style={{ cursor: 'pointer' }}>{inner}</div>;
  if (href)    return <a href={href} style={{ textDecoration: 'none' }}>{inner}</a>;
  return inner;
}

// ── Ticker bar ───────────────────────────────────────────────────────────────
function TickerBar({ info }: { info: any }) {
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
      setDate(now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    };
    tick(); const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const items = [
    { icon: '📅', text: date },
    { icon: '🕐', text: time },
    { icon: '📍', text: info?.location || 'Academy Ground' },
    { icon: '📞', text: info?.phone || '' },
    { icon: '🕐', text: 'MORNING 6–9 AM · EVENING 4–7 PM' },
    { icon: '🏆', text: info?.handle || '@quickiescricket' },
  ].filter(i => i.text);

  return (
    <div style={{
      backgroundColor: C.navy, borderRadius: 10, height: 38,
      overflow: 'hidden', display: 'flex', alignItems: 'center',
      marginBottom: 16, boxShadow: '0 3px 10px rgba(0,0,0,0.1)',
    }}>
      <div style={{
        display: 'flex', gap: 0, whiteSpace: 'nowrap' as const,
        animation: 'ticker 30s linear infinite',
        paddingLeft: '100%',
      }}>
        {[...items, ...items].map((item, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            marginRight: 40, fontSize: 12, fontWeight: 600, color: '#fff',
          }}>
            <span style={{ color: C.gold }}>{item.icon}</span>
            {item.text}
          </span>
        ))}
      </div>
      <style>{`@keyframes ticker { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }`}</style>
    </div>
  );
}

// ── Main Screen ──────────────────────────────────────────────────────────────
export default function ContactScreen() {
  const navigate = useNavigate();
  const base     = bld(localStorage.getItem('server_ip') ?? '');

  const [info,       setInfo]       = useState<any | null>(null);
  const [tab,        setTab]        = useState<'info' | 'enquiry'>('info');

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
    width: '100%', padding: '12px 16px', borderRadius: 12,
    border: `2px solid ${C.border}`, fontSize: 14, outline: 'none',
    fontFamily: 'inherit', boxSizing: 'border-box' as const,
    backgroundColor: '#fff', transition: 'border-color 0.2s',
  };
  const fErr = (key: string): React.CSSProperties =>
    fieldErrs[key] ? { ...F, borderColor: C.red } : F;

  const lat = info?.lat || 8.453111;
  const lng = info?.lng || 76.992833;

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 40 }}>

      {/* ── Header ── */}
      <ScreenHeader background="linear-gradient(135deg, #0d1b2a 60%, #000 100%)"
        title={<>JOIN THE <span style={{ color: C.gold }}>SQUAD.</span></>}
        subtitle="Get in touch — we're only a message away">
        <HeaderTabs color="#0d1b2a" value={tab} onChange={setTab}
          tabs={[{ id: 'info' as const, label: '📋 Details' }, { id: 'enquiry' as const, label: '✉️ Enquiry' }]} />
      </ScreenHeader>

      <div style={{ padding: '16px 16px 0' }}>

        {/* ── TICKER ── */}
        {info && <TickerBar info={info} />}

        {/* ══ INFO TAB ══ */}
        {tab === 'info' && (
          <>
            {/* Map */}
            <MapCard lat={lat} lng={lng} location={info?.location || ''} />

            {/* Info pills — matching web app */}
            <InfoPill
              icon="📍"
              title="Academy Ground"
              lines={[info?.location || 'Sports Complex', '']}
              href={`https://maps.google.com/maps?q=${lat},${lng}`}
            />
            <InfoPill
              icon="📧"
              title="Email & Phone"
              lines={[
                info?.email   || '',
                info?.phone   || '',
              ].filter(Boolean)}
              href={info?.phone ? `tel:${info.phone}` : undefined}
            />
            <InfoPill
              icon="🕐"
              title="Training Hours"
              lines={[
                'Morning: 6:00 AM – 9:00 AM',
                'Evening: 4:00 PM – 7:00 PM',
              ]}
            />
            {info?.whatsapp && (
              <InfoPill
                icon="💬"
                title="WhatsApp"
                lines={[info.whatsapp]}
                onClick={() => openSocialApp('whatsapp', info.whatsapp)}
              />
            )}

            {/* Social + quick actions */}
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginTop: 6 }}>
              {info?.phone && (
                <a href={`tel:${info.phone}`} style={{ textDecoration: 'none' }}>
                  <div style={{ backgroundColor: C.navy, borderRadius: 14, padding: '14px 18px',
                    display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ fontSize: 26 }}>📞</span>
                    <div>
                      <div style={{ color: '#fff', fontWeight: 800, fontSize: 15 }}>Call Now</div>
                      <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{info.phone}</div>
                    </div>
                    <span style={{ marginLeft: 'auto', color: C.gold, fontSize: 22 }}>›</span>
                  </div>
                </a>
              )}
              {info?.whatsapp && (
                <button onClick={() => openSocialApp('whatsapp', info.whatsapp)}
                  style={{ width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' as const }}>
                  <div style={{ backgroundColor: '#25d366', borderRadius: 14, padding: '14px 18px',
                    display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ fontSize: 26 }}>💬</span>
                    <div>
                      <div style={{ color: '#fff', fontWeight: 800, fontSize: 15 }}>WhatsApp</div>
                      <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>Chat with us</div>
                    </div>
                    <span style={{ marginLeft: 'auto', color: '#fff', fontSize: 22 }}>›</span>
                  </div>
                </button>
              )}
            </div>

            {/* Social handles */}
            {(info?.social?.instagram || info?.social?.youtube || info?.social?.facebook) && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: C.muted,
                  textTransform: 'uppercase' as const, letterSpacing: '1.5px', marginBottom: 8 }}>
                  Follow Us
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {info.social.instagram && (
                    <button onClick={() => openSocialApp('instagram', info.social.instagram)}
                      style={{
                        flex: 1, padding: '10px 0', borderRadius: 12, border: 'none',
                        backgroundColor: '#e1306c', color: '#fff',
                        fontWeight: 700, fontSize: 12, cursor: 'pointer',
                      }}>📸 Insta</button>
                  )}
                  {info.social.youtube && (
                    <button onClick={() => openSocialApp('youtube', info.social.youtube)}
                      style={{
                        flex: 1, padding: '10px 0', borderRadius: 12, border: 'none',
                        backgroundColor: '#ff0000', color: '#fff',
                        fontWeight: 700, fontSize: 12, cursor: 'pointer',
                      }}>▶ YouTube</button>
                  )}
                  {info.social.facebook && (
                    <button onClick={() => openSocialApp('facebook', info.social.facebook)}
                      style={{
                        flex: 1, padding: '10px 0', borderRadius: 12, border: 'none',
                        backgroundColor: '#1877f2', color: '#fff',
                        fontWeight: 700, fontSize: 12, cursor: 'pointer',
                      }}>📘 FB</button>
                  )}
                </div>
              </div>
            )}

            <button onClick={() => setTab('enquiry')} style={{
              width: '100%', marginTop: 14, padding: '14px', borderRadius: 50,
              border: 'none', backgroundColor: C.navy, color: C.gold,
              fontWeight: 800, fontSize: 15, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(13,27,42,0.3)',
            }}>SEND MESSAGE ✉️</button>
          </>
        )}

        {/* ══ ENQUIRY TAB ══ */}
        {tab === 'enquiry' && (
          <div style={{ backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 20,
            padding: '20px 16px', boxShadow: '0 5px 20px rgba(0,0,0,0.06)' }}>

            <div style={{ fontSize: 10, fontWeight: 800, color: C.red,
              textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: 6 }}>
              Quick Enquiry
            </div>
            <div style={{ fontWeight: 800, fontSize: 17, color: C.navy, marginBottom: 16 }}>
              Send us a message
            </div>

            {/* ── Status alerts — matching web app ── */}
            {status === 'sent' && (
              <div style={{ padding: '14px 16px', borderRadius: 12, marginBottom: 16,
                backgroundColor: '#dcfce7', border: '1px solid #86efac',
                display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 20, flexShrink: 0 }}>✅</span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: '#166534' }}>
                    Message Sent!
                  </div>
                  <div style={{ fontSize: 12, color: '#166534', marginTop: 3 }}>
                    We'll get back to you shortly. Our team will also reach out via WhatsApp.
                  </div>
                </div>
              </div>
            )}
            {status === 'error' && (
              <div style={{ padding: '14px 16px', borderRadius: 12, marginBottom: 16,
                backgroundColor: '#fee2e2', border: '1px solid #fca5a5',
                display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 20, flexShrink: 0 }}>⚠️</span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: C.red }}>
                    Something went wrong.
                  </div>
                  <div style={{ fontSize: 12, color: C.red, marginTop: 3 }}>
                    {errMsg || 'Please try again or contact us directly.'}
                  </div>
                </div>
              </div>
            )}

            {/* ── Form fields — same as web app ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              {/* Name */}
              <div>
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your Name"
                  maxLength={100} autoComplete="name"
                  style={fErr('name')} />
                {fieldErrs.name && (
                  <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{fieldErrs.name}</div>
                )}
              </div>
              {/* Email */}
              <div>
                <input value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email Address"
                  maxLength={150} type="email" inputMode="email" autoComplete="email"
                  style={fErr('email')} />
                {fieldErrs.email && (
                  <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{fieldErrs.email}</div>
                )}
              </div>
            </div>

            {/* Phone */}
            <div style={{ marginBottom: 12 }}>
              <input value={phone} onChange={e => setPhone(e.target.value)}
                placeholder="Phone Number (optional)"
                maxLength={15} type="tel" inputMode="tel" autoComplete="tel"
                style={fErr('phone')} />
              {fieldErrs.phone && (
                <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{fieldErrs.phone}</div>
              )}
            </div>

            {/* Message */}
            <div style={{ marginBottom: 6 }}>
              <textarea value={message} onChange={e => setMessage(e.target.value)}
                placeholder="How can we help your cricket journey?"
                maxLength={1000} rows={5}
                style={{ ...fErr('message'), resize: 'none' as const }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 3 }}>
                <span style={{ fontSize: 11, color: C.muted }}>{message.length} / 1000</span>
              </div>
              {fieldErrs.message && (
                <div style={{ fontSize: 11, color: C.red, marginTop: 2 }}>{fieldErrs.message}</div>
              )}
            </div>

            {/* Honeypot — hidden from user, same as web app */}
            <input type="text" tabIndex={-1} autoComplete="off"
              style={{ display: 'none' }} readOnly />

            {/* Submit */}
            <button onClick={handleSubmit} disabled={submitting} style={{
              width: '100%', padding: '14px', borderRadius: 50,
              border: 'none', marginTop: 10,
              backgroundColor: submitting ? '#9ca3af' : C.navy,
              color: submitting ? '#fff' : C.gold,
              fontWeight: 800, fontSize: 15,
              cursor: submitting ? 'not-allowed' : 'pointer',
              boxShadow: submitting ? 'none' : '0 4px 16px rgba(13,27,42,0.3)',
            }}>
              {submitting ? '⏳ SENDING...' : 'SEND MESSAGE ✉️'}
            </button>

            <div style={{ textAlign: 'center' as const, marginTop: 12,
              fontSize: 11, color: C.muted }}>
              🔒 Your information is secure and will never be shared.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
