/**
 * pulse.tsx — Academy Pulse Gallery
 *
 * Daily academy life — photos & videos uploaded by coaches.
 * No student tagging required (academy-wide content).
 *
 * Architecture:
 *  - Capture tab: same OPFS capture + compress flow as media.tsx
 *  - Gallery tab: server-side list with date range, tag, type, search filters
 *    - Default: last 7 days
 *    - Quick chips: 7d / 15d / 30d / 90d
 *    - Type filter: All / Photos / Videos
 *    - Tag filter: Training / Match / Event / Achievement / Other
 *    - Search: caption text
 *    - Highlight star toggle ⭐
 *    - Delete with Cloudinary cleanup
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePermissions } from './usePermissions';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';
import ZoomableImage, { ZoomableVideo } from '../shared/ZoomableImage';

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  gold: '#d4af37', green: '#1a472a', red: '#c0392b', blue: '#2563eb',
  bg: '#f4f7f6', card: '#fff', border: '#e8e8e8', muted: '#6b7280', text: '#1f2937',
};
const CARD: React.CSSProperties = { backgroundColor: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' };

const TAG_TYPES   = ['Training', 'Match', 'Event', 'Achievement', 'Other'];
const TAG_COLORS: Record<string, string> = {
  Training:    C.green,  Match:       C.red,
  Event:       C.blue,   Achievement: '#f59e0b',
  Other:       C.muted,
};
const MAX_BYTES    = 80 * 1024 * 1024;  // 80 MB
const PHOTO_MAX_PX = 2560;  // higher res for academy gallery
const PHOTO_Q      = 0.88;  // higher quality

// ── Helpers ───────────────────────────────────────────────────────────────────
function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
}
function hdr(): Record<string, string> {
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
  return { 'Content-Type': 'application/json', 'X-Username': localStorage.getItem('auth_user') ?? '' };
}

/** Small Cloudinary rendition for grids — a still frame for videos (≈20 KB instead of the full file) */
function thumbUrl(url: string, rtype: string, px = 360) {
  if (!url || !url.includes('/upload/')) return url;
  const t = `c_fill,w_${px},h_${px},q_auto${rtype === 'video' ? ',so_1' : ''}`;
  const u = url.replace('/upload/', `/upload/${t}/`);
  return rtype === 'video' ? u.replace(/\.[a-z0-9]+$/i, '.jpg') : u;
}
function fmtSz(b: number) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB`
       : `${(b / 1024).toFixed(0)} KB`;
}
function toDateStr(d: Date) { return d.toISOString().split('T')[0]; }
function today()  { return toDateStr(new Date()); }
function ago(n: number) { return toDateStr(new Date(Date.now() - (n - 1) * 86400000)); }
function fmt(s: string) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}

// ── OPFS ─────────────────────────────────────────────────────────────────────
function pulseFileName(id: string, mime: string) {
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'jpg';
  return `qca_pulse_${id}.${ext}`;
}
async function opfsSave(name: string, blob: Blob) {
  try {
    const root = await (navigator.storage as any).getDirectory();
    const fh   = await root.getFileHandle(name, { create: true });
    const w    = await fh.createWritable();
    await w.write(blob); await w.close();
  } catch (e) { console.warn('OPFS save failed', e); }
}
async function opfsLoad(name: string): Promise<Blob | null> {
  try {
    const root = await (navigator.storage as any).getDirectory();
    return await (await root.getFileHandle(name)).getFile();
  } catch { return null; }
}
async function opfsDel(name: string) {
  try {
    const root = await (navigator.storage as any).getDirectory();
    await root.removeEntry(name);
  } catch {}
}

function compressPhoto(file: Blob): Promise<Blob> {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (Math.max(w, h) > PHOTO_MAX_PX) {
        if (w >= h) { h = Math.round(h * PHOTO_MAX_PX / w); w = PHOTO_MAX_PX; }
        else { w = Math.round(w * PHOTO_MAX_PX / h); h = PHOTO_MAX_PX; }
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
      cv.toBlob(b => b ? res(b) : rej(new Error('Canvas failed')), 'image/jpeg', PHOTO_Q);
    };
    img.onerror = () => rej(new Error('Load failed'));
    img.src = url;
  });
}

// ── Capture Tab ───────────────────────────────────────────────────────────────
function CaptureTab({ base, onUploaded }: { base: string; onUploaded: () => void }) {
  const { can } = usePermissions();
  const [mode,    setMode]    = useState<'idle'|'photo_live'|'video_live'|'photo_pre'|'video_pre'>('idle');
  const [blob,    setBlob]    = useState<Blob|null>(null);
  const [preview, setPreview] = useState<string|null>(null);
  const [vMime,   setVMime]   = useState('video/webm');
  const [info,    setInfo]    = useState('');
  const [caption, setCaption] = useState('');
  const [tagType, setTagType] = useState('Training');
  const [actDate, setActDate] = useState(today());
  const [highlight, setHighlight] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg,     setMsg]     = useState('');
  const [recSecs, setRecSecs] = useState(0);
  const [recBytes,setRecBytes]= useState(0);

  const phRef  = useRef<HTMLVideoElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  const sRef   = useRef<MediaStream|null>(null);
  const recRef = useRef<MediaRecorder|null>(null);
  const chnkRef= useRef<Blob[]>([]);
  const tmrRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const galRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => stopStream(), []);
  useEffect(() => {
    if (!sRef.current) return;
    const el = mode === 'photo_live' ? phRef.current : vidRef.current;
    if (el) { el.srcObject = sRef.current; el.play().catch(() => {}); }
  }, [sRef.current, mode]);

  const stopStream = () => {
    sRef.current?.getTracks().forEach(t => { t.stop(); t.enabled = false; });
    sRef.current = null;
    if (phRef.current)  phRef.current.srcObject  = null;
    if (vidRef.current) vidRef.current.srcObject = null;
    if (tmrRef.current) { clearInterval(tmrRef.current); tmrRef.current = null; }
  };

  const retake = () => {
    stopStream();
    if (preview) URL.revokeObjectURL(preview);
    setBlob(null); setPreview(null); setInfo('');
    setMode('idle'); setMsg(''); setRecSecs(0); setRecBytes(0);
  };

  const camStream = async (audio: boolean) => {
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
    });
  };

  const startPhoto = async () => {
    setMsg('');
    try {
      const s = await camStream(false);
      sRef.current = s; setMode('photo_live');
    } catch (e: any) {
      setMsg(e?.name === 'NotAllowedError' ? '⚠ Camera permission blocked' : `⚠ ${e?.name}`);
    }
  };

  const snapPhoto = () => {
    if (!phRef.current) return;
    const v = phRef.current;
    const cv = document.createElement('canvas');
    let w = v.videoWidth || 1280, h = v.videoHeight || 720;
    if (Math.max(w, h) > PHOTO_MAX_PX) {
      if (w >= h) { h = Math.round(h * PHOTO_MAX_PX / w); w = PHOTO_MAX_PX; }
      else { w = Math.round(w * PHOTO_MAX_PX / h); h = PHOTO_MAX_PX; }
    }
    cv.width = w; cv.height = h;
    cv.getContext('2d')!.drawImage(v, 0, 0, w, h);
    stopStream();
    cv.toBlob(b => {
      if (!b) { setMsg('⚠ Snap failed'); setMode('idle'); return; }
      setBlob(b); setPreview(URL.createObjectURL(b));
      setInfo(`${fmtSz(b.size)} · ${w}×${h}`); setMode('photo_pre');
    }, 'image/jpeg', PHOTO_Q);
  };

  const startVideo = async () => {
    setMsg('Starting…');
    try {
      const s = await camStream(true);
      sRef.current = s; setMode('video_live'); setMsg('');
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') setMsg('⚠ Camera permission blocked');
      else {
        try {
          const s = await camStream(false);
          sRef.current = s; setMode('video_live');
          setMsg('⚠ Audio unavailable — recording video only');
        } catch (e2: any) { setMsg(`⚠ ${(e2 as any)?.name}`); }
      }
    }
  };

  const startRec = () => {
    if (!sRef.current) return;
    chnkRef.current = []; let total = 0;
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(sRef.current, mime ? { mimeType: mime } : {});
    recRef.current = rec;
    rec.ondataavailable = e => {
      if (!e.data.size) return;
      chnkRef.current.push(e.data); total += e.data.size; setRecBytes(total);
      if (total >= MAX_BYTES) rec.stop();  // stop at 80MB
    };
    rec.onstop = () => {
      stopStream();
      const am = mime || 'video/webm';
      const b  = new Blob(chnkRef.current, { type: am });
      setBlob(b); setPreview(URL.createObjectURL(b));
      setVMime(am); setInfo(`${fmtSz(b.size)} · ${am.split(';')[0]}`);
      setMode('video_pre');
      if (tmrRef.current) { clearInterval(tmrRef.current); tmrRef.current = null; }
    };
    rec.start(200);
    tmrRef.current = setInterval(() => setRecSecs(s => s + 1), 1000);
  };

  const stopRec = () => recRef.current?.state === 'recording' && recRef.current.stop();

  const onGallery = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (f.size > MAX_BYTES) { setMsg(`⚠ Too large (${fmtSz(f.size)}). Max 80MB.`); return; }
    setMsg('Processing…');
    try {
      if (f.type.startsWith('image/')) {
        const c = await compressPhoto(f);
        setBlob(c); setPreview(URL.createObjectURL(c));
        setInfo(`${fmtSz(c.size)}`); setMode('photo_pre');
      } else {
        setBlob(f); setPreview(URL.createObjectURL(f));
        setVMime(f.type || 'video/webm'); setInfo(fmtSz(f.size)); setMode('video_pre');
      }
      setMsg('');
    } catch (err: any) { setMsg('⚠ ' + err.message); }
  };

  const doUpload = async () => {
    if (!blob) { setMsg('Nothing captured'); return; }
    if (!can('media:upload')) { setMsg('🔒 Permission denied: media:upload'); return; }
    setUploading(true); setMsg('Getting upload credentials…');
    try {
      const isVid = mode === 'video_pre';
      const mime  = isVid ? vMime : 'image/jpeg';
      const rtype = isVid ? 'video' : 'image';
      const tmpId = `${Date.now()}`;
      const fname = pulseFileName(tmpId, mime);

      // Step 1: Get signed upload params
      const initRes = await fetch(`${base}/api/data/pulse/init`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({
          resource_type: rtype,
          tag_type:      tagType,      // → folder: qca_pulse/{tagType}/{YYYY-MM}
          activity_date: actDate,      // → month subfolder
        }),
      });
      if (!initRes.ok) throw new Error(`Init failed: ${initRes.status}`);
      const init = await initRes.json();

      // Step 2: Save to OPFS temporarily
      await opfsSave(fname, blob);
      setMsg('Uploading to Cloudinary…');

      // Step 3: Upload directly to Cloudinary with XHR for progress on large files
      const uploadName = `pulse_${tmpId}.${fname.split('.').pop()}`;
      const fd = new FormData();
      fd.append('file', new File([blob], uploadName, { type: mime }), uploadName);
      fd.append('api_key',   init.api_key);
      fd.append('timestamp', String(init.timestamp));
      fd.append('folder',    init.folder);
      fd.append('signature', init.signature);

      const cld = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', init.upload_url);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round(e.loaded / e.total * 100);
            setMsg(`⬆ Uploading… ${pct}% (${fmtSz(e.loaded)} / ${fmtSz(e.total)})`);
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new Error('Invalid Cloudinary response')); }
          } else {
            reject(new Error(`Cloudinary ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
          }
        };
        xhr.onerror   = () => reject(new Error('Upload failed — check connection'));
        xhr.ontimeout = () => reject(new Error('Upload timed out — try smaller file or better connection'));
        xhr.timeout   = 5 * 60 * 1000;  // 5 minute timeout for 50MB videos
        xhr.send(fd);
      });
      setMsg('Saving to academy…');

      // Step 4: Save to server DB
      const saveRes = await fetch(`${base}/api/data/pulse/save`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({
          cloudinary_public_id: cld.public_id,
          secure_url:           cld.secure_url,
          resource_type:        rtype,
          caption,
          tag_type:             tagType,
          activity_date:        actDate,
          is_highlight:         highlight ? 1 : 0,
        }),
      });
      if (!saveRes.ok) throw new Error(`Save failed: ${saveRes.status}`);

      await opfsDel(fname);
      setMsg('✅ Published to Academy Pulse!');
      setTimeout(() => { retake(); onUploaded(); }, 1200);
    } catch (e: any) {
      setMsg('⚠ ' + (e?.message ?? String(e)));
    } finally {
      setUploading(false);
    }
  };

  const isPre = mode === 'photo_pre' || mode === 'video_pre';

  const F: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: 14,
    border: `1.5px solid ${C.border}`, outline: 'none', fontFamily: 'inherit',
    boxSizing: 'border-box' as const, backgroundColor: '#fff',
  };

  return (
    <div style={{ padding: '10px 10px 24px' }}>

      {/* Camera controls */}
      {mode === 'idle' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 10 }}>
          {[{ icon: '📷', label: 'Photo', on: startPhoto }, { icon: '🎥', label: 'Video', on: startVideo }].map(b => (
            <button key={b.label} onClick={b.on} style={{ ...CARD, padding: '12px 4px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 22 }}>{b.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: C.green }}>{b.label}</span>
            </button>
          ))}
          <label style={{ ...CARD, padding: '12px 4px', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 22 }}>🖼</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: C.green }}>From phone</span>
            <input type="file" accept="image/*,video/*" onChange={onGallery} style={{ display: 'none' }} />
          </label>
        </div>
      )}

      {/* Live photo preview */}
      {mode === 'photo_live' && (
        <div style={{ marginBottom: 10 }}>
          <video ref={phRef} muted playsInline autoPlay
            style={{ width: '100%', borderRadius: 14, maxHeight: 340,
              objectFit: 'cover', backgroundColor: '#000' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={snapPhoto}
              style={{ flex: 2, padding: 11, borderRadius: 11, border: 'none',
                backgroundColor: C.green, color: '#fff', fontWeight: 800,
                fontSize: 15, cursor: 'pointer' }}>
              📸 Snap
            </button>
            <button onClick={retake}
              style={{ flex: 1, padding: 11, borderRadius: 11,
                border: `1px solid ${C.border}`, backgroundColor: '#fff',
                color: C.muted, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Live video recording */}
      {mode === 'video_live' && (
        <div style={{ marginBottom: 14, position: 'relative' }}>
          <video ref={vidRef} muted playsInline autoPlay
            style={{ width: '100%', borderRadius: 14, maxHeight: 280,
              objectFit: 'cover', backgroundColor: '#000' }} />
          {recRef.current?.state === 'recording' && (
            <>
              <div style={{ position: 'absolute', top: 10, left: 12,
                display: 'flex', alignItems: 'center', gap: 6,
                backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 8, padding: '4px 10px' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: C.red }} />
                <span style={{ color: '#fff', fontSize: 12, fontWeight: 800 }}>
                  {String(Math.floor(recSecs / 60)).padStart(2, '0')}:
                  {String(recSecs % 60).padStart(2, '0')}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>
                  {fmtSz(recBytes)}/{fmtSz(MAX_BYTES)}
                </span>
              </div>
              <div style={{ position: 'absolute', bottom: 54, left: 0, right: 0, height: 4,
                backgroundColor: 'rgba(0,0,0,0.3)' }}>
                <div style={{ width: `${Math.min(100, recBytes / MAX_BYTES * 100)}%`,
                  height: '100%',
                  backgroundColor: recBytes > MAX_BYTES * 0.8 ? C.red : C.gold }} />
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {recRef.current?.state !== 'recording'
              ? <button onClick={startRec}
                  style={{ flex: 2, padding: 11, borderRadius: 11, border: 'none',
                    backgroundColor: C.red, color: '#fff', fontWeight: 800,
                    fontSize: 14, cursor: 'pointer' }}>⏺ Record</button>
              : <button onClick={stopRec}
                  style={{ flex: 2, padding: 11, borderRadius: 11, border: 'none',
                    backgroundColor: C.red, color: '#fff', fontWeight: 800,
                    fontSize: 14, cursor: 'pointer' }}>⏹ Stop</button>
            }
            <button onClick={retake}
              style={{ flex: 1, padding: 11, borderRadius: 11,
                border: `1px solid ${C.border}`, backgroundColor: '#fff',
                color: C.muted, fontWeight: 700, cursor: 'pointer' }}>✕</button>
          </div>
        </div>
      )}

      {/* Preview */}
      {isPre && preview && (
        <div style={{ marginBottom: 14, position: 'relative' }}>
          {mode === 'video_pre'
            ? <video controls playsInline style={{ width: '100%', borderRadius: 14,
                maxHeight: 280, backgroundColor: '#000' }}>
                <source src={preview} type={vMime} />
              </video>
            : <img src={preview} alt=""
                style={{ width: '100%', borderRadius: 14, maxHeight: 300,
                  objectFit: 'cover', display: 'block' }} />
          }
          <div style={{ position: 'absolute', top: 8, right: 8 }}>
            <button onClick={retake}
              style={{ backgroundColor: 'rgba(0,0,0,0.6)', color: '#fff',
                border: 'none', borderRadius: 8, padding: '4px 12px',
                cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
              ✕ Retake
            </button>
          </div>
          <div style={{ position: 'absolute', top: 8, left: 8,
            backgroundColor: 'rgba(0,0,0,0.6)', color: '#fff',
            borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>
            {info}
          </div>
        </div>
      )}

      {/* Message */}
      {msg && (() => {
        const ok = msg.startsWith('✅'), busy = !ok && !msg.startsWith('⚠') && !msg.startsWith('🔒');
        return (
          <div style={{ padding: '8px 12px', borderRadius: 10, marginBottom: 10, fontSize: 12.5, fontWeight: 700,
            backgroundColor: ok ? '#dcfce7' : busy ? '#f0f4f0' : '#fee2e2',
            color: ok ? '#166534' : busy ? C.green : C.red,
            border: `1px solid ${ok ? '#86efac' : busy ? '#cfe3d5' : '#fca5a5'}` }}>
            {msg}
          </div>
        );
      })()}

      {/* Upload form — shown after capture/gallery selection */}
      {isPre && (
        <div style={{ ...CARD, padding: 12 }}>

          {/* Caption */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted,
            textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 4 }}>
            Caption
          </div>
          <input value={caption} onChange={e => setCaption(e.target.value)}
            placeholder="Describe this moment…" maxLength={200}
            style={{ ...F, marginBottom: 10 }} />

          {/* Tag type */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted,
            textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 8 }}>
            Category
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginBottom: 12 }}>
            {TAG_TYPES.map(t => (
              <button key={t} onClick={() => setTagType(t)} aria-pressed={tagType === t}
                style={{ padding: '5px 11px', borderRadius: 16, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: `1px solid ${tagType === t ? TAG_COLORS[t] : C.border}`,
                  backgroundColor: tagType === t ? TAG_COLORS[t] : '#fff',
                  color: tagType === t ? '#fff' : '#374151' }}>
                {t}
              </button>
            ))}
          </div>

          {/* Activity date + highlight */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.muted,
                textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 4 }}>
                Activity Date
              </div>
              <input type="date" value={actDate} max={today()}
                onChange={e => setActDate(e.target.value)}
                style={{ ...F }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const,
              alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.muted,
                textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
                Highlight
              </div>
              <button onClick={() => setHighlight(h => !h)} aria-pressed={highlight} aria-label="Mark as highlight"
                style={{ fontSize: 24, background: 'none', border: 'none',
                  cursor: 'pointer', padding: '2px 4px' }}>
                {highlight ? '⭐' : '☆'}
              </button>
            </div>
          </div>

          {/* Upload button */}
          <button onClick={doUpload} disabled={uploading}
            style={{ width: '100%', padding: 11, borderRadius: 11, border: 'none',
              backgroundColor: uploading ? '#9ca3af' : C.green, color: uploading ? '#fff' : C.gold,
              fontWeight: 900, fontSize: 14, cursor: uploading ? 'not-allowed' : 'pointer' }}>
            {uploading ? '⏳ Uploading…' : '🌟 Publish to Academy Pulse'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Gallery Tab ───────────────────────────────────────────────────────────────
// Quick range presets
type RangePreset = 'today' | '7d' | '15d' | '30d' | '90d' | 'custom';
const PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '15d', label: '15 days' },
  { key: '30d', label: '30 days' }, { key: '90d', label: '90 days' }, { key: 'custom', label: 'Custom' },
];
function presetRange(p: RangePreset): [string, string] | null {
  const td = today();
  if (p === 'today') return [td, td];
  if (p === '7d')    return [ago(7), td];
  if (p === '15d')   return [ago(15), td];
  if (p === '30d')   return [ago(30), td];
  if (p === '90d')   return [ago(90), td];
  return null;   // custom — keep current dates
}

function Chip({ on, color = C.green, onClick, children }: { on: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 16, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
        border: `1px solid ${on ? color : C.border}`, backgroundColor: on ? color : '#fff', color: on ? '#fff' : '#374151' }}>
      {children}
    </button>
  );
}

function GridTile({ item, onOpen }: { item: any; onOpen: () => void }) {
  const [err, setErr] = useState(false);
  const isVid = item.resource_type === 'video';
  return (
    <button onClick={onOpen} aria-label={item.caption || (isVid ? 'Video' : 'Photo')}
      style={{ position: 'relative', width: '100%', padding: '100% 0 0 0', border: 'none', borderRadius: 8,
        overflow: 'hidden', backgroundColor: '#1f2937', cursor: 'pointer' }}>
      {!err && <img src={thumbUrl(item.secure_url, item.resource_type)} alt="" loading="lazy" onError={() => setErr(true)}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      {isVid && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 11,
            display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 2 }}>▶</span>
        </span>
      )}
      {item.is_highlight ? <span style={{ position: 'absolute', top: 4, right: 4, fontSize: 13 }}>⭐</span> : null}
      {item.tag_type && (
        <span style={{ position: 'absolute', left: 4, bottom: 4, padding: '1px 6px', borderRadius: 6, fontSize: 9, fontWeight: 800,
          color: '#fff', backgroundColor: (TAG_COLORS[item.tag_type] || C.muted) + 'e6' }}>{item.tag_type}</span>
      )}
    </button>
  );
}

function GalleryTab({ base, reloadKey }: { base: string; reloadKey: number }) {
  const { can } = usePermissions();

  const [items,      setItems]      = useState<any[]>([]);
  const [total,      setTotal]      = useState(0);
  const [allTags,    setAllTags]    = useState<string[]>([]);
  const [preset,     setPreset]     = useState<RangePreset>('7d');
  const [from,       setFrom]       = useState(ago(7));
  const [to,         setTo]         = useState(today());
  const [tagFilter,  setTagFilter]  = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search,     setSearch]     = useState('');
  const [hlOnly,     setHlOnly]     = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [fetched,    setFetched]    = useState(false);
  const [msg,        setMsg]        = useState('');
  const [lightbox,   setLightbox]   = useState<any|null>(null);

  const load = useCallback(async (
    f = from, t = to, tag = tagFilter,
    typ = typeFilter, q = search, hl = hlOnly
  ) => {
    const ip = localStorage.getItem('server_ip') || '';
    if (!ip) { setMsg('⚠ Server not configured — go to Settings'); return; }
    setLoading(true); setMsg('');
    try {
      const p = new URLSearchParams({ limit: '500', date_from: f, date_to: t });
      if (tag) p.set('tag_type',      tag);
      if (typ) p.set('resource_type', typ);
      if (q)   p.set('search',        q);
      if (hl)  p.set('is_highlight',  '1');
      const r = await fetch(`${bld(ip)}/api/data/pulse/list?${p}`, { headers: hdr() });
      const j = await r.json();
      if (r.ok) {
        setItems(j.data || []); setTotal(j.total || 0);
        setAllTags(j.tags || []); setFetched(true);
      } else {
        setMsg(`⚠ ${j.error || `Server error ${r.status}`}`);
      }
    } catch { setMsg('⚠ Cannot reach server'); }
    finally { setLoading(false); }
  }, [from, to, tagFilter, typeFilter, search, hlOnly]);

  // Load on open, and again after a new upload
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [reloadKey]);

  const handlePreset = (p: RangePreset) => {
    setPreset(p);
    const r = presetRange(p);
    if (!r) return;                       // custom → pick dates, then Apply
    setFrom(r[0]); setTo(r[1]);
    load(r[0], r[1], tagFilter, typeFilter, search, hlOnly);
  };
  const handleTag  = (tag: string) => { setTagFilter(tag);  load(from, to, tag, typeFilter, search, hlOnly); };
  const handleType = (typ: string) => { setTypeFilter(typ); load(from, to, tagFilter, typ, search, hlOnly); };
  const handleHl   = (val: boolean) => { setHlOnly(val);    load(from, to, tagFilter, typeFilter, search, val); };
  const resetAll   = () => {
    setPreset('7d'); setFrom(ago(7)); setTo(today());
    setTagFilter(''); setTypeFilter(''); setSearch(''); setHlOnly(false);
    load(ago(7), today(), '', '', '', false);
  };
  const filtered = preset !== '7d' || !!tagFilter || !!typeFilter || !!search || hlOnly;

  const toggleHighlight = async (item: any) => {
    try {
      const r = await fetch(`${base}/api/data/pulse/${item.id}/highlight`, {
        method: 'PATCH', headers: hdr(),
      });
      const j = await r.json();
      if (j.status === 'success') {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_highlight: j.is_highlight } : i));
        setLightbox((lb: any) => lb?.id === item.id ? { ...lb, is_highlight: j.is_highlight } : lb);
      }
    } catch {}
  };

  const del = async (item: any) => {
    if (!confirm(`Delete this ${item.resource_type === 'video' ? 'video' : 'photo'}? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${base}/api/data/pulse/${item.id}`, {
        method: 'DELETE', headers: hdr(),
      });
      const j = await r.json();
      if (r.ok) {
        setItems(prev => prev.filter(i => i.id !== item.id));
        setTotal(t => Math.max(0, t - 1));
        setLightbox(null);
        setMsg('✅ Deleted');
        setTimeout(() => setMsg(''), 3000);
      } else {
        setMsg('⚠ ' + (j.error || 'Delete failed'));
      }
    } catch { setMsg('⚠ Network error'); }
  };

  // Stats
  const photos     = items.filter(i => i.resource_type === 'image').length;
  const videos     = items.filter(i => i.resource_type === 'video').length;
  const highlights = items.filter(i => i.is_highlight).length;
  const cell = (n: number, label: string, first?: boolean) => (
    <div style={{ flex: 1, padding: '6px 4px', textAlign: 'center', borderLeft: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.green }}>{n}</div>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
    </div>
  );
  const lbIdx = lightbox ? items.findIndex(i => i.id === lightbox.id) : -1;

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── Filters ── */}
      <div style={{ ...CARD, padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', gap: 5, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {PRESETS.map(p => <Chip key={p.key} on={preset === p.key} onClick={() => handlePreset(p.key)}>{p.label}</Chip>)}
        </div>

        {preset === 'custom' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="date" value={from} max={to} aria-label="From date" onChange={e => setFrom(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13 }} />
            <span style={{ color: C.muted, fontSize: 12 }}>→</span>
            <input type="date" value={to} min={from} max={today()} aria-label="To date" onChange={e => setTo(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13 }} />
            <button onClick={() => load()} disabled={loading} style={{ flexShrink: 0, padding: '7px 12px', borderRadius: 8, border: 'none',
              backgroundColor: C.green, color: '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>Apply</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 8, backgroundColor: '#f3f4f6', flex: 1 }}>
            {([['', 'All'], ['image', '📷 Photos'], ['video', '🎥 Videos']] as [string, string][]).map(([k, l]) => (
              <button key={k} onClick={() => handleType(k)} aria-pressed={typeFilter === k}
                style={{ flex: 1, height: 26, borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
                  backgroundColor: typeFilter === k ? '#fff' : 'transparent', color: typeFilter === k ? C.green : C.muted,
                  boxShadow: typeFilter === k ? '0 1px 2px rgba(0,0,0,0.12)' : 'none' }}>{l}</button>
            ))}
          </div>
          <Chip on={hlOnly} color="#d97706" onClick={() => handleHl(!hlOnly)}>⭐ Best</Chip>
        </div>

        <div style={{ display: 'flex', gap: 5, overflowX: 'auto', scrollbarWidth: 'none' }}>
          <Chip on={!tagFilter} onClick={() => handleTag('')}>All tags</Chip>
          {(allTags.length > 0 ? allTags : TAG_TYPES).map(t => (
            <Chip key={t} on={tagFilter === t} color={TAG_COLORS[t] || C.muted} onClick={() => handleTag(t)}>{t}</Chip>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13 }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="Search captions…" aria-label="Search captions" enterKeyHint="search"
              style={{ width: '100%', padding: '7px 30px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13,
                outline: 'none', boxSizing: 'border-box', backgroundColor: '#fff' }} />
            {search && (
              <button onClick={() => { setSearch(''); load(from, to, tagFilter, typeFilter, '', hlOnly); }} aria-label="Clear search"
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none',
                  cursor: 'pointer', fontSize: 14, color: C.muted }}>✕</button>
            )}
          </div>
          <button onClick={() => load()} disabled={loading} aria-label="Search"
            style={{ flexShrink: 0, padding: '0 12px', borderRadius: 8, border: 'none', backgroundColor: loading ? '#9ca3af' : C.green,
              color: '#fff', fontWeight: 800, fontSize: 12.5, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? '⏳' : 'Go'}
          </button>
        </div>
      </div>

      {msg && (
        <div style={{ padding: '8px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 700,
          backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
          border: `1px solid ${msg.startsWith('✅') ? '#86efac' : '#fca5a5'}`,
          color: msg.startsWith('✅') ? '#166534' : C.red }}>{msg}</div>
      )}

      {/* ── Summary ── */}
      {fetched && items.length > 0 && (
        <div style={CARD}>
          <div style={{ display: 'flex' }}>
            {cell(total, 'Items', true)}{cell(photos, 'Photos')}{cell(videos, 'Videos')}{cell(highlights, 'Best')}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 10px', borderTop: `1px solid ${C.border}`,
            fontSize: 11, color: C.muted, backgroundColor: '#fafafa' }}>
            <span>{fmt(from)} – {fmt(to)}{items.length < total ? ` · showing ${items.length}` : ''}</span>
            {filtered && <button onClick={resetAll} style={{ background: 'none', border: 'none', padding: 0, color: C.green,
              fontWeight: 800, fontSize: 11, cursor: 'pointer' }}>Reset filters</button>}
          </div>
        </div>
      )}

      {/* ── Empty / loading ── */}
      {loading && !fetched && <div style={{ textAlign: 'center', padding: '32px 0', color: C.muted, fontSize: 13 }}>Loading…</div>}
      {fetched && items.length === 0 && (
        <div style={{ ...CARD, padding: '26px 16px', textAlign: 'center', color: C.muted }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>📭</div>
          <div style={{ fontWeight: 800, fontSize: 13.5, color: C.text }}>Nothing in this period</div>
          <div style={{ fontSize: 12, marginTop: 3 }}>Try a wider date range or clear the filters</div>
          {filtered && (
            <button onClick={resetAll} style={{ marginTop: 10, padding: '7px 16px', borderRadius: 9, border: 'none',
              backgroundColor: C.green, color: '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>Reset filters</button>
          )}
        </div>
      )}

      {/* ── Grid ── */}
      {items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, opacity: loading ? 0.5 : 1 }}>
          {items.map(item => <GridTile key={item.id} item={item} onOpen={() => setLightbox(item)} />)}
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} role="dialog" aria-label="Media viewer"
          style={{ position: 'fixed', inset: 0, zIndex: 5000, backgroundColor: 'rgba(0,0,0,0.94)', display: 'flex', flexDirection: 'column',
            paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
            <button onClick={() => setLightbox(null)} aria-label="Close"
              style={{ background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', fontSize: 16, borderRadius: 8, padding: '6px 11px', cursor: 'pointer' }}>✕</button>
            <span style={{ flex: 1, color: 'rgba(255,255,255,0.6)', fontSize: 12, textAlign: 'center' }}>{lbIdx + 1} / {items.length}</span>
            {can('media:upload') && (
              <button onClick={() => toggleHighlight(lightbox)} aria-pressed={!!lightbox.is_highlight}
                style={{ background: lightbox.is_highlight ? C.gold : 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 8, padding: '6px 10px',
                  color: lightbox.is_highlight ? C.green : '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                {lightbox.is_highlight ? '⭐ Best' : '☆ Mark best'}
              </button>
            )}
            {can('media:delete') && (
              <button onClick={() => del(lightbox)} aria-label="Delete"
                style={{ background: 'rgba(220,38,38,0.85)', border: 'none', borderRadius: 8, padding: '6px 10px', color: '#fff',
                  fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>🗑</button>
            )}
          </div>
          <div onClick={e => e.stopPropagation()} style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 8px' }}>
            {lightbox.resource_type === 'video'
              ? <ZoomableVideo key={lightbox.id} src={lightbox.secure_url}
                  poster={thumbUrl(lightbox.secure_url, 'video', 720)} style={{ borderRadius: 10 }} />
              : <ZoomableImage src={lightbox.secure_url} alt={lightbox.caption || ''} style={{ borderRadius: 10 }} />}
          </div>
          <div onClick={e => e.stopPropagation()} style={{ padding: '10px 14px 14px', color: '#fff' }}>
            {lightbox.caption && <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>{lightbox.caption}</div>}
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
              {[fmt(lightbox.activity_date), lightbox.tag_type, lightbox.uploaded_by && `by ${lightbox.uploaded_by}`].filter(Boolean).join(' · ')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button disabled={lbIdx <= 0} onClick={() => setLightbox(items[lbIdx - 1])}
                style={{ flex: 1, padding: '9px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)',
                  color: lbIdx <= 0 ? 'rgba(255,255,255,0.3)' : '#fff', fontWeight: 700, fontSize: 13, cursor: lbIdx <= 0 ? 'default' : 'pointer' }}>‹ Previous</button>
              <button disabled={lbIdx >= items.length - 1} onClick={() => setLightbox(items[lbIdx + 1])}
                style={{ flex: 1, padding: '9px', borderRadius: 9, border: 'none',
                  background: lbIdx >= items.length - 1 ? 'rgba(255,255,255,0.08)' : C.gold,
                  color: lbIdx >= items.length - 1 ? 'rgba(255,255,255,0.3)' : C.green, fontWeight: 800, fontSize: 13,
                  cursor: lbIdx >= items.length - 1 ? 'default' : 'pointer' }}>Next ›</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
type PulseTab = 'capture' | 'gallery';

export default function PulseScreen() {
  const { can }  = usePermissions();
  const base     = bld(localStorage.getItem('server_ip') ?? '');
  const [tab,       setTab]       = useState<PulseTab>(can('media:upload') ? 'capture' : 'gallery');
  const [uploaded,  setUploaded]  = useState(0);   // items published in this visit — also reloads the gallery

  const onUploaded = () => { setUploaded(n => n + 1); setTab('gallery'); };

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100%', fontFamily: 'sans-serif', color: C.text, paddingBottom: 24 }}>
      <ScreenHeader title="Academy Pulse"
        subtitle={uploaded > 0 ? `✔ ${uploaded} published this visit` : 'Training, matches & achievements'}>
        <HeaderTabs value={tab} onChange={setTab}
          tabs={([
            ...(can('media:upload') ? [['capture', '📷 Capture']] : []),
            ['gallery', '📂 Gallery'],
          ] as [PulseTab, string][]).map(([id, label]) => ({ id, label }))} />
      </ScreenHeader>

      {tab === 'capture' && can('media:upload') && (
        <CaptureTab base={base} onUploaded={onUploaded} />
      )}
      {tab === 'gallery' && <GalleryTab base={base} reloadKey={uploaded} />}
    </div>
  );
}
