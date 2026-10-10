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
 *
 * Gestures: tap left / right third or swipe to change slide, press and hold to pause;
 * pinch or double-tap to zoom into a poster (up to 4×) and drag to move around — while
 * zoomed the slides stop advancing and taps / swipes don't change slide.
 */
import React, { useEffect, useRef, useState } from 'react';

const C = { navy:'#001f3f', green:'#1a472a', gold:'#d4af37', muted:'#6b7280', red:'#c0392b' };
const SLIDE_MS   = 6000;
const LIST_KEY   = 'login_slides_cache';
const CACHE_NAME = 'qca-login-slides';
const PER_VISIT  = 5;
const OFFSET_KEY = 'login_slides_offset';          // where the rotation continues next visit
const MAX_ZOOM = 4, DOUBLE_TAP_ZOOM = 2.5, DOUBLE_TAP_MS = 280;
const HINT_KEY = 'login_slides_zoom_hint';

const iconBtn: React.CSSProperties = { width:50, height:50, flexShrink:0, borderRadius:14, cursor:'pointer',
  border:'1px solid rgba(255,255,255,0.18)', backgroundColor:'rgba(255,255,255,0.08)', display:'flex', alignItems:'center', justifyContent:'center' };

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

  // ── Zoom: pinch / double-tap; pan while zoomed ──
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const zoomed = zoom.s > 1.01;
  const boxRef   = useRef<HTMLDivElement>(null);
  const ptrs     = useRef(new Map<number, { x:number; y:number }>());
  const pinch    = useRef<{ dist:number; s:number; mid:{ x:number; y:number }; x:number; y:number } | null>(null);
  const pan      = useRef<{ px:number; py:number; x:number; y:number } | null>(null);
  const multi    = useRef(false);                  // this touch involved two fingers
  const lastTap  = useRef({ t: 0, x: 0, y: 0 });
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hint, setHint] = useState(false);
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0 }); }, [idx]);
  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);
  // One-time "pinch to zoom" hint
  useEffect(() => {
    let seen = '1'; try { seen = localStorage.getItem(HINT_KEY) || ''; } catch {}
    if (seen || !slides.length) return;
    setHint(true);
    const t = setTimeout(() => { setHint(false); try { localStorage.setItem(HINT_KEY, '1'); } catch {} }, 3500);
    return () => clearTimeout(t);
  }, [slides.length]);

  /** Point relative to the slide area's centre */
  const rel = (cx:number, cy:number) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
  };
  /** Keep the poster from being dragged off screen */
  const clampPan = (sc:number, x:number, y:number) => {
    const el = boxRef.current;
    if (!el || sc <= 1) return { x: 0, y: 0 };
    const mx = (el.clientWidth * (sc - 1)) / 2, my = (el.clientHeight * (sc - 1)) / 2;
    return { x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  const resetZoom = () => { setZoom({ s: 1, x: 0, y: 0 }); setTick(t => t + 1); };

  // Auto-advance (not while held or zoomed)
  useEffect(() => {
    if (paused || zoomed || n < 2) return;
    const t = setTimeout(() => go(1), SLIDE_MS);
    return () => clearTimeout(t);
  }, [idx, paused, zoomed, n, tick]); // eslint-disable-line
  useEffect(() => { if (idx >= n) setIdx(0); }, [n, idx]);

  const onDown = (e:React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setPaused(true);
    if (ptrs.current.size === 2) {                   // second finger: start a pinch
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: zoom.s,
        mid: rel((a.x + b.x) / 2, (a.y + b.y) / 2), x: zoom.x, y: zoom.y };
      multi.current = true; pan.current = null; touch.current = null;
    } else if (ptrs.current.size === 1) {
      multi.current = false;
      touch.current = { x: e.clientX, t: Date.now() };
      pan.current = { px: e.clientX, py: e.clientY, x: zoom.x, y: zoom.y };
    }
  };
  const onMove = (e:React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = pinch.current;
    if (g && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const sc = Math.max(1, Math.min(MAX_ZOOM, g.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist)));
      const k = sc / g.s;                            // zoom around the point between the fingers
      setZoom({ s: sc, ...clampPan(sc, g.mid.x - (g.mid.x - g.x) * k, g.mid.y - (g.mid.y - g.y) * k) });
    } else if (pan.current && zoomed) {
      const d = pan.current;
      setZoom(v => ({ ...v, ...clampPan(v.s, d.x + (e.clientX - d.px), d.y + (e.clientY - d.py)) }));
    }
  };
  const onUp = (e:React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    if (multi.current) {                             // end of a pinch
      if (ptrs.current.size < 2) pinch.current = null;
      if (ptrs.current.size === 0) {
        multi.current = false;
        if (zoom.s < 1.05) resetZoom();
        setPaused(false);
      }
      return;
    }
    const st = touch.current; touch.current = null; pan.current = null;
    setPaused(false);
    if (!st) return;
    const dx = e.clientX - st.x;
    const isTap = Math.abs(dx) < 12 && Date.now() - st.t < 350;
    // Double-tap: zoom into that spot, or back out
    const now = Date.now();
    if (isTap && now - lastTap.current.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 40) {
      if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
      lastTap.current = { t: 0, x: 0, y: 0 };
      if (zoomed) resetZoom();
      else { const p = rel(e.clientX, e.clientY);
        setZoom({ s: DOUBLE_TAP_ZOOM, ...clampPan(DOUBLE_TAP_ZOOM, -p.x * (DOUBLE_TAP_ZOOM - 1), -p.y * (DOUBLE_TAP_ZOOM - 1)) }); }
      return;
    }
    if (isTap) lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    if (zoomed || n < 2) return;                     // zoomed: taps and swipes don't change slide
    if (Math.abs(dx) > 40) { go(dx < 0 ? 1 : -1); return; }
    if (Date.now() - st.t > 350) { setTick(t => t + 1); return; }   // was a hold: resume this slide
    const w = (e.currentTarget as HTMLElement).clientWidth;
    const x = e.clientX;
    // Wait briefly so a double-tap doesn't also change slide
    if (x < w / 3 || x > w * 2 / 3) {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(() => { tapTimer.current = null; go(x < w / 3 ? -1 : 1); }, DOUBLE_TAP_MS);
    }
  };
  const onCancel = (e:React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size === 0) { pinch.current = null; pan.current = null; touch.current = null; multi.current = false; setPaused(false); }
  };

  const contact = info?.contact || {};
  const wa  = String(contact.whatsapp || '').replace(/\D/g, '');
  const tel = String(contact.phone || '').replace(/[^\d+]/g, '');
  const contactUrl = wa ? `https://wa.me/${wa.length === 10 ? `91${wa}` : wa}` : tel ? `tel:${tel}` : '';
  const mapUrl = contact.lat && contact.lng ? `https://www.google.com/maps/search/?api=1&query=${contact.lat},${contact.lng}` : '';

  return (
    <div data-back-root data-back-exit style={{ position:'fixed', inset:0, backgroundColor:C.navy, display:'flex', flexDirection:'column', fontFamily:'sans-serif', userSelect:'none' }}>
      <style>{`@keyframes qcaFill { from { width:0 } to { width:100% } }`}</style>

      {/* Slides */}
      <div ref={boxRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
        style={{ position:'relative', flex:1, minHeight:0, overflow:'hidden', touchAction:'none' }}>
        {slides.length ? slides.map((src, i) => (
          <img key={src} src={src} alt="" draggable={false}
            style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'contain', objectPosition:'center',
              opacity: i === idx ? 1 : 0, transition:'opacity 450ms ease',
              transform: i === idx && zoomed ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` : undefined,
              willChange: i === idx ? 'transform' : undefined }}/>
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
                  animationPlayState: paused || zoomed ? 'paused' : 'running' }}/>
              </div>
            ))}
          </div>
        )}

        {zoomed && (
          <button onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onClick={resetZoom}
            style={{ position:'absolute', right:12, bottom:14, padding:'7px 12px', borderRadius:18, border:'1px solid rgba(255,255,255,0.4)',
              backgroundColor:'rgba(0,0,0,0.55)', color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer' }}>✕ Reset zoom</button>
        )}
        {hint && !zoomed && (
          <div style={{ position:'absolute', left:'50%', bottom:16, transform:'translateX(-50%)', padding:'6px 12px', borderRadius:16,
            backgroundColor:'rgba(0,0,0,0.6)', color:'#fff', fontSize:12, fontWeight:700, pointerEvents:'none', whiteSpace:'nowrap' }}>
            🤏 Pinch or double-tap to zoom</div>
        )}
      </div>

      {/* Sign in + quick links: one compact dark row so the posters keep the height */}
      <div style={{ flexShrink:0, backgroundColor:C.navy, borderTop:'1px solid rgba(255,255,255,0.08)',
        padding:'10px 14px calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
        {error && <div style={{ backgroundColor:'rgba(220,38,38,0.15)', color:'#fecaca', fontSize:12.5, fontWeight:600, borderRadius:9,
          padding:'7px 10px', marginBottom:8, border:'1px solid rgba(248,113,113,0.35)' }}>{error}</div>}
        <div style={{ display:'flex', gap:8, alignItems:'stretch' }}>
          <button onClick={fingerprint ? onFingerprint : onSignIn} disabled={busy}
            style={{ flex:1, minWidth:0, height:50, borderRadius:14, border:'none', background:`linear-gradient(135deg, ${C.green}, #2d6a4f)`,
              color: fingerprint ? C.gold : '#fff', fontWeight:900, fontSize:15.5, cursor:'pointer', opacity: busy ? 0.7 : 1,
              boxShadow:'0 4px 14px rgba(0,0,0,0.35)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', padding:'0 10px' }}>
            {busy ? 'Signing in…' : fingerprint ? fingerprintLabel : 'Sign in'}
          </button>
          {contactUrl && (
            <button onClick={() => openExternal(contactUrl)} aria-label="Contact us" title="Contact us" style={iconBtn}>
              <span style={{ fontSize:20 }}>{wa ? '💬' : '📞'}</span>
            </button>
          )}
          {mapUrl && (
            <button onClick={() => openExternal(mapUrl)} aria-label="Find the academy" title="Find the academy" style={iconBtn}>
              <span style={{ fontSize:20 }}>📍</span>
            </button>
          )}
        </div>
        {fingerprint && (
          <button onClick={onSignIn} style={{ display:'block', margin:'8px auto 0', background:'none', border:'none', padding:'2px 8px',
            color:'rgba(255,255,255,0.75)', fontWeight:700, fontSize:13, cursor:'pointer' }}>
            {passwordLabel}
          </button>
        )}
      </div>
    </div>
  );
}
