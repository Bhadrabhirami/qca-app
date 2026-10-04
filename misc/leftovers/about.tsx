/**
 * about.tsx — About Us / Our People
 *
 * Shows QCA's club members from the `club_members` table via
 * GET /api/data/about — three sections matching the web about.html:
 *   - Distinguished Patrons   (category = 'Patron')
 *   - Office Bearers          (category = 'Office Bearer' | 'Executive')
 *   - Permanent Members       (category = 'General', shown as name pills)
 *
 * Only Published members are shown (same filter as the web page).
 * Photos load from image_url; initials avatar shown if missing/broken.
 * App version shown at the bottom.
 *
 * Server endpoint required: GET /api/data/about
 * (see about_endpoint.py — add to routes/api_data.py)
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APP_VERSION, BUILD_NUMBER } from '../shared/version';
import { getCachedMemberImageUrl } from '../database/db';

const C = {
  navy: '#0d1b2a', gold: '#c5a059', green: '#1a472a',
  bg: '#f0f2f5', card: '#fff', border: '#e0e0e0', muted: '#6b7280',
};

// Use the exact same source of truth as the rest of the app: the
// already-built "Full URL Preview" value Settings computes and saves
// to server_ip on Save. Don't reconstruct from server_proto/host/port
// separately — that's a second, independent implementation of the
// same logic, and is exactly how this kept drifting out of sync.
function bld(): string {
  const ip = (localStorage.getItem('server_ip') || '').trim().replace(/\/+$/, '');
  if (!ip) return '';
  return ip.startsWith('http') ? ip : `http://${ip}`;
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

type Member = {
  name: string; category: string; position?: string;
  image_url?: string; status: string;
  coach_bio?: string; is_coach?: boolean;
};

// ── Photo with initials fallback ──────────────────────────────────────────────
// Same approach as StudentPhoto: fetch the image via JS (mode: 'cors'),
// cache it, and hand the <img> tag a local blob: URL — not a raw remote
// https:// URL. A blob: URL is locally-generated and same-origin from
// the WebView's point of view, so it isn't subject to whatever CSP /
// mixed-content / allowNavigation restrictions apply to a plain <img
// src="https://..."> pointed directly at an external domain.
function Avatar({ name, src, size, border }: {
  name: string; src?: string; size: number; border: string;
}) {
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [ready,  setReady]  = useState(false);
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    (async () => {
      const url = await getCachedMemberImageUrl(src ?? null);
      if (cancelled) return;
      if (url) { createdUrl = url; setObjUrl(url); }
      setReady(true);
    })();

    return () => {
      cancelled = true;
      if (createdUrl) setTimeout(() => URL.revokeObjectURL(createdUrl!), 10_000);
    };
  }, [src]);

  if (!ready || !objUrl) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        backgroundColor: C.navy, color: C.gold,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 900, fontSize: size * 0.33,
        border: `3px solid ${border}`, flexShrink: 0,
      }}>{initials || '?'}</div>
    );
  }
  return (
    <img src={objUrl} onError={() => setObjUrl(null)} alt={name}
      style={{
        width: size, height: size, borderRadius: '50%', objectFit: 'cover',
        border: `3px solid ${border}`, flexShrink: 0,
      }} />
  );
}

// ── Coach card ───────────────────────────────────────────────────────────────
function CoachCard({ m }: { m: Member }) {
  return (
    <div style={{
      backgroundColor: C.card, borderRadius: 18, padding: '20px 16px 16px',
      textAlign: 'center' as const, boxShadow: '0 4px 16px rgba(0,0,0,0.07)',
      borderTop: `4px solid #dc2626`, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <Avatar name={m.name} src={m.image_url} size={120} border="#dc2626" />
      </div>
      <div style={{ fontWeight: 900, fontSize: 16, color: C.navy }}>{m.name}</div>
      {m.position && (
        <div style={{ fontSize: 11, fontWeight: 700, color: C.gold,
          textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginTop: 4 }}>
          {m.position}
        </div>
      )}
      {m.coach_bio && (
        <div style={{ fontSize: 12, color: C.muted, marginTop: 8,
          textAlign: 'left' as const, lineHeight: 1.5, whiteSpace: 'pre-line' as const }}>
          {m.coach_bio}
        </div>
      )}
    </div>
  );
}

// ── Patron card — large, centred ──────────────────────────────────────────────
function PatronCard({ m }: { m: Member }) {
  return (
    <div style={{
      backgroundColor: C.card, borderRadius: 18, padding: '20px 16px 16px',
      textAlign: 'center' as const, boxShadow: '0 4px 16px rgba(0,0,0,0.07)',
      borderTop: `4px solid ${C.gold}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <Avatar name={m.name} src={m.image_url} size={96} border={C.gold} />
      </div>
      <div style={{ fontWeight: 900, fontSize: 15, color: C.navy, lineHeight: 1.3 }}>{m.name}</div>
      {m.position && (
        <div style={{
          fontSize: 11, fontWeight: 700, color: C.gold,
          textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginTop: 4,
        }}>{m.position}</div>
      )}
    </div>
  );
}

// ── Office Bearer row — horizontal, compact ───────────────────────────────────
function BearerRow({ m }: { m: Member }) {
  return (
    <div style={{
      backgroundColor: C.card, borderRadius: 14,
      padding: '12px 16px', marginBottom: 8,
      boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
      display: 'flex', alignItems: 'center', gap: 14,
      borderLeft: `4px solid ${C.navy}`,
    }}>
      <Avatar name={m.name} src={m.image_url} size={52} border={C.navy} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 800, fontSize: 14, color: C.navy,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
        }}>{m.name}</div>
        {m.position && (
          <div style={{
            fontSize: 11, fontWeight: 700, color: C.green,
            textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginTop: 2,
          }}>{m.position}</div>
        )}
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────
function Section({ label, title, children }: {
  label: string; title: string; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: C.muted,
        textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: 2,
      }}>{label}</div>
      <div style={{
        fontWeight: 900, fontSize: 18, color: C.navy, marginBottom: 14,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ textAlign: 'center' as const, color: C.muted, padding: '16px 0', fontSize: 13 }}>
      {text}
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function AboutScreen() {
  const navigate = useNavigate();
  const base     = bld();

  const [members,  setMembers]  = useState<Member[] | null>(null);
  const [coaches,  setCoaches]  = useState<Member[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string>('');

  const load = React.useCallback(() => {
    setLoading(true);
    setError('');

    if (!base) {
      setMembers([]);
      setError('No server configured — set this up in Settings first.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    fetch(`${base}/api/data/about`, { headers: hdr(), signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`Server returned HTTP ${r.status}`);
        return r.json();
      })
      .then(j => {
        if (!j?.data) throw new Error('Unexpected response from server');
        setMembers(j.data.members ?? []);
        setCoaches(j.data.coaches ?? []);
      })
      .catch((e: any) => {
        const msg = e?.name === 'AbortError'
          ? 'Request timed out — check your connection and try again.'
          : (e?.message || 'Could not reach the server.');
        setError(msg);
        setMembers([]);
      })
      .finally(() => { clearTimeout(timer); setLoading(false); });

    return () => { clearTimeout(timer); controller.abort(); };
  }, [base]);

  useEffect(() => { const cleanup = load(); return cleanup; }, [load]);

  const published = (members || []).filter(m => m.status === 'Published');
  const patrons   = published.filter(m => m.category === 'Patron' && !m.is_coach);
  const bearers   = published.filter(m => (m.category === 'Office Bearer' || m.category === 'Executive') && !m.is_coach);
  const general   = published.filter(m => m.category === 'General' && !m.is_coach);

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 48 }}>

      {/* ── Header ── */}
      <div style={{
        background: `linear-gradient(150deg, ${C.navy} 0%, #1a2f4a 100%)`,
        paddingTop: 52, paddingBottom: 24, paddingLeft: 16, paddingRight: 16,
      }}>
        <button onClick={() => navigate(-1)} style={{
          background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
          fontSize: 22, cursor: 'pointer', padding: 0, marginBottom: 16,
          display: 'block',
        }}>←</button>

        <div style={{
          display: 'inline-block', backgroundColor: 'rgba(197,160,89,0.2)',
          color: C.gold, padding: '3px 12px', borderRadius: 20,
          fontSize: 10, fontWeight: 800,
          textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: 8,
        }}>Our People</div>
        <div style={{ color: '#fff', fontWeight: 900, fontSize: 26, lineHeight: 1.1 }}>
          About <span style={{ color: C.gold }}>QCA</span>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginTop: 6 }}>
          The visionaries and members driving cricket excellence in Trivandrum.
        </div>
      </div>

      <div style={{ padding: '20px 16px 0' }}>

        {loading && (
          <div style={{ textAlign: 'center' as const, color: C.muted, padding: 40, fontSize: 14 }}>
            Loading members…
          </div>
        )}

        {!loading && error && (
          <div style={{
            textAlign: 'center' as const, padding: '32px 16px',
            backgroundColor: '#fef2f2', borderRadius: 14, marginBottom: 16,
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#991b1b', marginBottom: 4 }}>
              Couldn't load members
            </div>
            <div style={{ fontSize: 12, color: '#7f1d1d', marginBottom: 14 }}>{error}</div>
            <button onClick={load} style={{
              padding: '8px 20px', borderRadius: 20, border: 'none',
              backgroundColor: C.navy, color: '#fff', fontWeight: 700,
              fontSize: 12, cursor: 'pointer',
            }}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ── Coaches ── */}
            {coaches.length > 0 && (
              <Section label="Our Expertise" title="Coaching Staff">
                {coaches.map((m, i) => <CoachCard key={i} m={m} />)}
              </Section>
            )}

            {/* ── Patrons ── */}
            <Section label="The Pillars" title="Distinguished Patrons">
              {patrons.length === 0 ? <Empty text="No patrons listed yet." /> : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }}>
                  {patrons.map((m, i) => <PatronCard key={i} m={m} />)}
                </div>
              )}
            </Section>

            {/* ── Office Bearers ── */}
            <Section label="Leadership" title="Academy Office Bearers">
              {bearers.length === 0 ? <Empty text="No office bearers listed yet." /> : (
                <div>
                  {bearers.map((m, i) => <BearerRow key={i} m={m} />)}
                </div>
              )}
            </Section>

            {/* ── General Members ── */}
            <Section label="Our Community" title="Permanent Members">
              {general.length === 0 ? <Empty text="No members listed yet." /> : (
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
                  {general.map((m, i) => (
                    <div key={i} style={{
                      backgroundColor: C.navy, color: C.gold,
                      borderRadius: 50, padding: '4px 16px 4px 4px',
                      fontSize: 12, fontWeight: 700,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <Avatar name={m.name} src={m.image_url} size={26} border={C.gold} />
                      {m.name}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}

        {/* ── Version footer ── */}
        <div style={{
          textAlign: 'center' as const, paddingTop: 20,
          borderTop: `1px solid ${C.border}`, marginTop: 8,
        }}>
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 2 }}>
            <span style={{ fontWeight: 800, color: C.navy }}>Quickies Cricket Academy</span><br />
            QCA App · Version {APP_VERSION} (build {BUILD_NUMBER})
          </div>
        </div>

      </div>
    </div>
  );
}
