/**
 * LoginLanding.tsx — first screen when signed out (like a banking app's sign-in page):
 * full-screen slides with story-style progress bars, a fixed sign-in button and quick links.
 *
 * Slides come from the server's static/slides folder via GET /api/data/login-slides
 * (public), so they can be changed without an app update. Images are kept in the Cache
 * Storage, and the last list in localStorage, so the screen also works offline; with no
 * slides at all a branded logo slide is shown. Posters are shown whole (contain), never
 * cropped, because they carry their own text.
 *
 * Each visit shows PER_VISIT slides: every "pinned" slide (file name pin-…) first, then the
 * next ones in rotation — 01–05, then 06–10 … wrapping round — so all posters get shown.
 * Only the slides being shown are downloaded.
 */
import React, { useEffect, useRef, useState } from 'react';

const C = { navy:'#001f3f', green:'#1a472a', gold:'#d4af37', muted:'#6b7280', red:'#c0392b' };
const SLIDE_MS   = 6000;
const LIST_KEY   = 'login_slides_cache';
const CACHE_NAME = 'qca-login-slides';
const PER_VISIT  = 5;
const OFFSET_KEY = 'login_slides_offset';          // where the rotation continues next visit

const base = () => (localStorage.getItem('server_ip') || '').replace(/\/+$/, '');

/** Image from the Cache Storage if we have it, else the network (then cached) */
async function slideBlobUrl(url:string): Promise<string | null> {
  const full = url.startsWith('http') ? url : `${base()}${url}`;
  try {
    const cache = 'caches' in window ? await caches.open(CACHE_NAME) : null;
    const hit = cache ? await cache.match(full) : undefined;
    if (hit) return URL.createObjectURL(await hit.blob());
    const r = await fetch(full);
    if (!r.ok) return null;
    if (cache) await cache.put(full, r.clone());
    return URL.createObjectURL(await r.blob());
  } catch { return null; }
}

function openExternal(url:string) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

export default function LoginLanding({ onSignIn, fingerprint, onFingerprint, busy, error,
  fingerprintLabel = '👆 Sign in with fingerprint', passwordLabel = 'Sign in with password' }: {
  onSignIn: () => void;
  fingerprint: boolean;          // this phone has a saved login and a fingerprint sensor
  onFingerprint: () => void;
  busy: boolean;
  error: string;
  fingerprintLabel?: string;     // e.g. "Unlock with fingerprint" on the lock screen
  passwordLabel?: string;
}) {
  const cached = (() => { try { return JSON.parse(localStorage.getItem(LIST_KEY) || 'null'); } catch { return null; } })();
  const [info, setInfo]   = useState<any>(cached);
  const [srcs, setSrcs]   = useState<(string | null)[]>([]);
  const [idx, setIdx]     = useState(0);
  const [paused, setPaused] = useState(false);
  const [tick, setTick]   = useState(0);           // restarts the progress animation
  const touch = useRef<{ x:number; t:number } | null>(null);

  // Slide list: show the cached one at once, refresh from the server
  useEffect(() => {
    if (!base()) return;
    fetch(`${base()}/api/data/login-slides`).then(r => r.ok ? r.json() : null).then(async j => {
      if (!j) return;
      setInfo(j);
      try { localStorage.setItem(LIST_KEY, JSON.stringify(j)); } catch {}
      // Forget saved pictures the server no longer has (removed or replaced files)
      try {
        if (!('caches' in window)) return;
        const keep = new Set((j.slides || []).map((x:any) => `${base()}${x.url}`));
        const cache = await caches.open(CACHE_NAME);
        for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
      } catch {}
    }).catch(() => {});
  }, []);

  // This visit's slides: pinned first, then the next ones in the rotation
  const start = useRef<number>(parseInt(localStorage.getItem(OFFSET_KEY) || '0', 10) || 0);
  const all: any[] = info?.slides || [];
  const pinned = all.filter(x => x.pinned).slice(0, PER_VISIT);
  const rest = all.filter(x => !x.pinned);
  const take = Math.min(PER_VISIT - pinned.length, rest.length);
  const from = rest.length ? start.current % rest.length : 0;
  const chosen = [...pinned, ...Array.from({ length: take }, (_, i) => rest[(from + i) % rest.length])];
  useEffect(() => {                                  // next visit continues after what's shown now
    if (!rest.length) return;                        // (start is fixed per visit, so this is safe to repeat)
    try { localStorage.setItem(OFFSET_KEY, String((from + take) % rest.length)); } catch {}
  }, [rest.length, take]); // eslint-disable-line

  // Images as blob URLs (a plain <img> from the server is blocked cross-origin)
  const urls: string[] = chosen.map((x:any) => x.url);
  const key = urls.join('|');
  useEffect(() => {
    let alive = true; const made:string[] = [];
    Promise.all(urls.map(u => slideBlobUrl(u))).then(list => {
      list.forEach(u => u && made.push(u));
      if (alive) setSrcs(list); else made.forEach(u => URL.revokeObjectURL(u));
    });
    return () => { alive = false; made.forEach(u => URL.revokeObjectURL(u)); };
  }, [key]); // eslint-disable-line

  const slides = srcs.filter(Boolean) as string[];
  const n = Math.max(1, slides.length);
  const go = (d:number) => { setIdx(i => (i + d + n) % n); setTick(t => t + 1); };

  // Auto-advance
  useEffect(() => {
    if (paused || n < 2) return;
    const t = setTimeout(() => go(1), SLIDE_MS);
    return () => clearTimeout(t);
  }, [idx, paused, n, tick]); // eslint-disable-line
  useEffect(() => { if (idx >= n) setIdx(0); }, [n, idx]);

  // Tap left / right third, swipe, or press-and-hold to pause
  const onDown = (e:React.PointerEvent) => { touch.current = { x:e.clientX, t:Date.now() }; setPaused(true); };
  const onUp = (e:React.PointerEvent) => {
    setPaused(false);
    const s = touch.current; touch.current = null;
    if (!s || n < 2) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 40) { go(dx < 0 ? 1 : -1); return; }
    if (Date.now() - s.t > 350) { setTick(t => t + 1); return; }   // was a hold: resume this slide
    const w = (e.currentTarget as HTMLElement).clientWidth;
    if (e.clientX < w / 3) go(-1); else if (e.clientX > w * 2 / 3) go(1);
  };

  const contact = info?.contact || {};
  const wa  = String(contact.whatsapp || '').replace(/\D/g, '');
  const tel = String(contact.phone || '').replace(/[^\d+]/g, '');
  const contactUrl = wa ? `https://wa.me/${wa.length === 10 ? `91${wa}` : wa}` : tel ? `tel:${tel}` : '';
  const mapUrl = contact.lat && contact.lng ? `https://www.google.com/maps/search/?api=1&query=${contact.lat},${contact.lng}` : '';

  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:C.navy, display:'flex', flexDirection:'column', fontFamily:'sans-serif', userSelect:'none' }}>
      <style>{`@keyframes qcaFill { from { width:0 } to { width:100% } }`}</style>

      {/* Slides */}
      <div onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { setPaused(false); touch.current = null; }}
        style={{ position:'relative', flex:1, minHeight:0, overflow:'hidden', touchAction:'pan-y' }}>
        {slides.length ? slides.map((src, i) => (
          <img key={src} src={src} alt="" draggable={false}
            style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'contain', objectPosition:'top center',
              opacity: i === idx ? 1 : 0, transition:'opacity 450ms ease' }}/>
        )) : (
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:24, textAlign:'center' }}>
            <img src="/logo_256.jpg" alt="" style={{ width:150, height:150, borderRadius:'50%', boxShadow:'0 10px 30px rgba(0,0,0,0.45)' }}/>
            <div style={{ color:'#fff', fontWeight:900, fontSize:24, marginTop:22 }}>Quickies Cricket Academy</div>
            <div style={{ color:C.gold, fontWeight:700, fontSize:13, marginTop:8, letterSpacing:'0.06em' }}>Train Hard · Think Smart · Play Fearless</div>
          </div>
        )}

        {/* Story progress bars */}
        {slides.length > 1 && (
          <div style={{ position:'absolute', top:'calc(env(safe-area-inset-top, 0px) + 10px)', left:14, right:14, display:'flex', gap:6, pointerEvents:'none' }}>
            {slides.map((_, i) => (
              <div key={i} style={{ flex:1, height:3, borderRadius:2, backgroundColor:'rgba(255,255,255,0.35)', overflow:'hidden' }}>
                <div key={`${i}-${idx}-${tick}`} style={{ height:'100%', backgroundColor:'#fff', borderRadius:2,
                  width: i < idx ? '100%' : i > idx ? 0 : undefined,
                  animation: i === idx ? `qcaFill ${SLIDE_MS}ms linear forwards` : undefined,
                  animationPlayState: paused ? 'paused' : 'running' }}/>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sign in + quick links */}
      <div style={{ flexShrink:0, backgroundColor:'#fff', borderRadius:'18px 18px 0 0', marginTop:-14, position:'relative',
        padding:'14px 16px calc(env(safe-area-inset-bottom, 0px) + 10px)', boxShadow:'0 -6px 20px rgba(0,0,0,0.25)' }}>
        {error && <div style={{ backgroundColor:'#fef2f2', color:C.red, fontSize:12.5, fontWeight:600, borderRadius:9, padding:'7px 10px', marginBottom:8 }}>{error}</div>}
        {fingerprint ? (<>
          <button onClick={onFingerprint} disabled={busy}
            style={{ width:'100%', padding:13, borderRadius:12, border:'none', background:`linear-gradient(135deg, ${C.green}, #2d6a4f)`,
              color:C.gold, fontWeight:900, fontSize:15.5, cursor:'pointer', opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Signing in…' : fingerprintLabel}
          </button>
          <button onClick={onSignIn} style={{ width:'100%', padding:'9px 0 2px', background:'none', border:'none', color:C.green, fontWeight:800, fontSize:13, cursor:'pointer' }}>
            {passwordLabel}
          </button>
        </>) : (
          <button onClick={onSignIn}
            style={{ width:'100%', padding:13, borderRadius:12, border:'none', background:`linear-gradient(135deg, ${C.green}, #2d6a4f)`,
              color:'#fff', fontWeight:900, fontSize:15.5, cursor:'pointer' }}>
            Sign in
          </button>
        )}
        {(contactUrl || mapUrl) && (
          <div style={{ display:'flex', marginTop:10, borderTop:'1px solid #eef0f2', paddingTop:8 }}>
            {contactUrl && (
              <button onClick={() => openExternal(contactUrl)} style={{ flex:1, background:'none', border:'none', cursor:'pointer', padding:'4px 0',
                display:'flex', flexDirection:'column', alignItems:'center', gap:3, color:'#1f2937', fontSize:12, fontWeight:700 }}>
                <span style={{ fontSize:20 }}>{wa ? '💬' : '📞'}</span>Contact us
              </button>
            )}
            {mapUrl && (
              <button onClick={() => openExternal(mapUrl)} style={{ flex:1, background:'none', border:'none', cursor:'pointer', padding:'4px 0',
                display:'flex', flexDirection:'column', alignItems:'center', gap:3, color:'#1f2937', fontSize:12, fontWeight:700 }}>
                <span style={{ fontSize:20 }}>📍</span>Find the academy
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
