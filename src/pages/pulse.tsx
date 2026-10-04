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
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  navy: '#001f3f', gold: '#c5a059', green: '#1a472a',
  red: '#c0392b', blue: '#2563eb', purple: '#7c3aed',
  bg: '#f0f2f5', card: '#fff', border: '#e5e7eb', muted: '#6b7280',
};

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
    <div style={{ padding: '16px 16px 120px' }}>

      {/* Camera controls */}
      {mode === 'idle' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={startPhoto}
            style={{ flex: 1, padding: '14px 8px', borderRadius: 12,
              border: `1.5px solid ${C.green}44`, cursor: 'pointer',
              backgroundColor: C.green + '14', color: C.green,
              fontWeight: 800, fontSize: 13 }}>
            📷 Photo
          </button>
          <button onClick={startVideo}
            style={{ flex: 1, padding: '14px 8px', borderRadius: 12,
              border: `1.5px solid ${C.blue}44`, cursor: 'pointer',
              backgroundColor: C.blue + '14', color: C.blue,
              fontWeight: 800, fontSize: 13 }}>
            🎥 Video
          </button>
          <label style={{ flex: 1, padding: '14px 8px', borderRadius: 12,
            border: `1.5px solid ${C.purple}44`, cursor: 'pointer',
            backgroundColor: C.purple + '14', color: C.purple,
            fontWeight: 800, fontSize: 13, textAlign: 'center' as const,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            🖼 Gallery
            <input type="file" accept="image/*,video/*"
              onChange={onGallery} style={{ display: 'none' }} />
          </label>
        </div>
      )}

      {/* Live photo preview */}
      {mode === 'photo_live' && (
        <div style={{ marginBottom: 14 }}>
          <video ref={phRef} muted playsInline autoPlay
            style={{ width: '100%', borderRadius: 14, maxHeight: 340,
              objectFit: 'cover', backgroundColor: '#000' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={snapPhoto}
              style={{ flex: 2, padding: 14, borderRadius: 12, border: 'none',
                backgroundColor: C.green, color: '#fff', fontWeight: 800,
                fontSize: 15, cursor: 'pointer' }}>
              📸 Snap
            </button>
            <button onClick={retake}
              style={{ flex: 1, padding: 14, borderRadius: 12,
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
                  style={{ flex: 2, padding: 14, borderRadius: 12, border: 'none',
                    backgroundColor: C.red, color: '#fff', fontWeight: 800,
                    fontSize: 14, cursor: 'pointer' }}>⏺ Record</button>
              : <button onClick={stopRec}
                  style={{ flex: 2, padding: 14, borderRadius: 12, border: 'none',
                    backgroundColor: C.red, color: '#fff', fontWeight: 800,
                    fontSize: 14, cursor: 'pointer' }}>⏹ Stop</button>
            }
            <button onClick={retake}
              style={{ flex: 1, padding: 14, borderRadius: 12,
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
      {msg && (
        <div style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 12,
          fontSize: 13, fontWeight: 700,
          backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
          color: msg.startsWith('✅') ? '#166534' : C.red,
          border: `1px solid ${msg.startsWith('✅') ? '#86efac' : '#fca5a5'}` }}>
          {msg}
        </div>
      )}

      {/* Upload form — shown after capture/gallery selection */}
      {isPre && (
        <div style={{ backgroundColor: C.card, borderRadius: 16, padding: '16px',
          border: `1px solid ${C.border}`, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>

          {/* Caption */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted,
            textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 4 }}>
            Caption
          </div>
          <input value={caption} onChange={e => setCaption(e.target.value)}
            placeholder="Describe this moment…" maxLength={200}
            style={{ ...F, marginBottom: 12 }} />

          {/* Tag type */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted,
            textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 8 }}>
            Category
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginBottom: 12 }}>
            {TAG_TYPES.map(t => (
              <button key={t} onClick={() => setTagType(t)}
                style={{ padding: '6px 14px', borderRadius: 20, border: 'none',
                  cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  backgroundColor: tagType === t ? TAG_COLORS[t] : '#f3f4f6',
                  color: tagType === t ? '#fff' : C.muted,
                  boxShadow: tagType === t ? '0 2px 6px rgba(0,0,0,0.2)' : 'none' }}>
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
              <button onClick={() => setHighlight(h => !h)}
                style={{ fontSize: 28, background: 'none', border: 'none',
                  cursor: 'pointer', padding: '4px' }}>
                {highlight ? '⭐' : '☆'}
              </button>
            </div>
          </div>

          {/* Upload button */}
          <button onClick={doUpload} disabled={uploading}
            style={{ width: '100%', padding: 16, borderRadius: 13, border: 'none',
              backgroundColor: uploading ? '#9ca3af' : C.navy, color: C.gold,
              fontWeight: 900, fontSize: 15, cursor: uploading ? 'not-allowed' : 'pointer',
              boxShadow: uploading ? 'none' : `0 4px 14px ${C.navy}44` }}>
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

function GalleryTab({ base }: { base: string }) {
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

  // Apply a preset — sets from/to and marks preset active
  const applyPreset = useCallback((p: RangePreset) => {
    setPreset(p);
    const td = today();
    if (p === 'today') { setFrom(td);      setTo(td);       }
    else if (p === '7d')  { setFrom(ago(7));  setTo(td);    }
    else if (p === '15d') { setFrom(ago(15)); setTo(td);    }
    else if (p === '30d') { setFrom(ago(30)); setTo(td);    }
    else if (p === '90d') { setFrom(ago(90)); setTo(td);    }
    // 'custom' — leave from/to as-is, just mark preset
  }, []);

  const load = useCallback(async (
    f = from, t = to, tag = tagFilter,
    typ = typeFilter, q = search, hl = hlOnly
  ) => {
    const ip = localStorage.getItem('server_ip') || '';
    if (!ip) { setMsg('⚠ Server not configured — go to Settings'); return; }
    setLoading(true); setFetched(false); setMsg('');
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

  // Auto-load on mount
  useEffect(() => { load(); }, []);

  // Chips that auto-trigger load immediately
  const handlePreset = (p: RangePreset) => {
    const td = today();
    let f = from, t = to;
    if (p === 'today') { f = td;      t = td;    }
    else if (p === '7d')  { f = ago(7);  t = td; }
    else if (p === '15d') { f = ago(15); t = td; }
    else if (p === '30d') { f = ago(30); t = td; }
    else if (p === '90d') { f = ago(90); t = td; }
    setFrom(f); setTo(t); setPreset(p);
    load(f, t, tagFilter, typeFilter, search, hlOnly);
  };

  const handleTag = (tag: string) => {
    setTagFilter(tag);
    load(from, to, tag, typeFilter, search, hlOnly);
  };

  const handleType = (typ: string) => {
    setTypeFilter(typ);
    load(from, to, tagFilter, typ, search, hlOnly);
  };

  const handleHl = (val: boolean) => {
    setHlOnly(val);
    load(from, to, tagFilter, typeFilter, search, val);
  };

  const handleDateChange = (newFrom: string, newTo: string) => {
    setFrom(newFrom); setTo(newTo); setPreset('custom');
    // Don't auto-load on date change — wait for Search button
  };

  const toggleHighlight = async (item: any) => {
    try {
      const r = await fetch(`${base}/api/data/pulse/${item.id}/highlight`, {
        method: 'PATCH', headers: hdr(),
      });
      const j = await r.json();
      if (j.status === 'success') {
        setItems(prev => prev.map(i =>
          i.id === item.id ? { ...i, is_highlight: j.is_highlight } : i
        ));
      }
    } catch {}
  };

  const del = async (item: any) => {
    if (!confirm(`Delete this ${item.resource_type === 'video' ? 'video' : 'photo'}?`)) return;
    try {
      const r = await fetch(`${base}/api/data/pulse/${item.id}`, {
        method: 'DELETE', headers: hdr(),
      });
      const j = await r.json();
      if (r.ok) {
        setItems(prev => prev.filter(i => i.id !== item.id));
        setMsg('✅ Deleted');
        setTimeout(() => setMsg(''), 3000);
      } else {
        setMsg('⚠ ' + (j.error || 'Delete failed'));
      }
    } catch { setMsg('⚠ Network error'); }
  };

  // Stats
  const photos = items.filter(i => i.resource_type === 'image').length;
  const videos = items.filter(i => i.resource_type === 'video').length;
  const highlights = items.filter(i => i.is_highlight).length;

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100%', paddingBottom: 80 }}>

      {/* ── Filter panel ── */}
      <div style={{ backgroundColor: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '12px 16px' }}>

        {/* ── Row 1: Quick preset chips incl. Today ── */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10,
          overflowX: 'auto' as const, scrollbarWidth: 'none' as any }}>
          {([
            { key: 'today', label: '📅 Today' },
            { key: '7d',    label: '7d'        },
            { key: '15d',   label: '15d'       },
            { key: '30d',   label: '30d'       },
            { key: '90d',   label: '90d'       },
          ] as {key: RangePreset; label: string}[]).map(({ key, label }) => (
            <button key={key} onClick={() => handlePreset(key)}
              style={{ padding: '6px 14px', borderRadius: 20, border: 'none',
                cursor: 'pointer', fontSize: 11, fontWeight: 800,
                whiteSpace: 'nowrap' as const, flexShrink: 0,
                backgroundColor: preset === key ? C.navy : '#f3f4f6',
                color: preset === key ? C.gold : C.muted,
                boxShadow: preset === key ? '0 2px 6px rgba(0,31,63,0.3)' : 'none' }}>
              {label}
            </button>
          ))}
          {/* Custom badge */}
          {preset === 'custom' && (
            <span style={{ padding: '6px 10px', borderRadius: 20,
              backgroundColor: '#e0e7ff', color: '#3730a3',
              fontSize: 10, fontWeight: 700, flexShrink: 0 }}>Custom</span>
          )}
          {/* Highlight toggle — pushed to end */}
          <button onClick={() => handleHl(!hlOnly)}
            style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 20,
              border: `1.5px solid ${hlOnly ? '#f59e0b' : C.border}`,
              cursor: 'pointer', fontSize: 11, fontWeight: 800, flexShrink: 0,
              backgroundColor: hlOnly ? '#fffbeb' : C.card,
              color: hlOnly ? '#92400e' : C.muted }}>
            ⭐ Highlights
          </button>
        </div>

        {/* ── Row 2: Custom date pickers (only shown for custom) ── */}
        {preset === 'custom' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            {(['From', 'To'] as const).map((label, i) => (
              <div key={label}>
                <div style={{ fontSize: 10, fontWeight: 800, color: C.muted,
                  textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 4 }}>
                  {label}
                </div>
                <input type="date"
                  value={i === 0 ? from : to}
                  max={i === 0 ? to : today()}
                  min={i === 1 ? from : undefined}
                  onChange={e => handleDateChange(
                    i === 0 ? e.target.value : from,
                    i === 1 ? e.target.value : to
                  )}
                  style={{ width: '100%', padding: '9px 10px', borderRadius: 10,
                    border: `1.5px solid ${C.border}`, fontSize: 13, outline: 'none',
                    boxSizing: 'border-box' as const }} />
              </div>
            ))}
          </div>
        )}

        {/* ── Row 3: Type filter ── */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {([
            { key: '',      label: 'All Types' },
            { key: 'image', label: '📷 Photos' },
            { key: 'video', label: '🎥 Videos' },
          ] as {key:string;label:string}[]).map(t => (
            <button key={t.key} onClick={() => handleType(t.key)}
              style={{ padding: '5px 14px', borderRadius: 20, border: 'none',
                cursor: 'pointer', fontSize: 11, fontWeight: 800,
                backgroundColor: typeFilter === t.key ? C.green : '#f3f4f6',
                color: typeFilter === t.key ? '#fff' : C.muted }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Row 4: Tag chips from server ── */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto' as const,
          scrollbarWidth: 'none' as any, marginBottom: 10 }}>
          <button onClick={() => handleTag('')}
            style={{ padding: '5px 14px', borderRadius: 20, border: 'none',
              cursor: 'pointer', fontSize: 11, fontWeight: 800,
              whiteSpace: 'nowrap' as const, flexShrink: 0,
              backgroundColor: tagFilter === '' ? C.navy : '#f3f4f6',
              color: tagFilter === '' ? '#fff' : C.muted }}>
            All Tags
          </button>
          {(allTags.length > 0 ? allTags : TAG_TYPES).map(t => {
            const col = TAG_COLORS[t] || C.muted;
            return (
              <button key={t} onClick={() => handleTag(t)}
                style={{ padding: '5px 14px', borderRadius: 20, border: 'none',
                  cursor: 'pointer', fontSize: 11, fontWeight: 800,
                  whiteSpace: 'nowrap' as const, flexShrink: 0,
                  backgroundColor: tagFilter === t ? col : '#f3f4f6',
                  color: tagFilter === t ? '#fff' : C.muted }}>
                {t}
              </button>
            );
          })}
        </div>

        {/* ── Row 5: Search ── */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 11, top: '50%',
              transform: 'translateY(-50%)', fontSize: 14, color: C.muted }}>🔍</span>
            <input value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="Search caption…"
              style={{ width: '100%', padding: '9px 34px 9px 32px', borderRadius: 10,
                border: `1.5px solid ${C.border}`, fontSize: 13, outline: 'none',
                boxSizing: 'border-box' as const, backgroundColor: '#f9fafb' }} />
            {search && (
              <button onClick={() => { setSearch(''); load(from, to, tagFilter, typeFilter, '', hlOnly); }}
                style={{ position: 'absolute', right: 10, top: '50%',
                  transform: 'translateY(-50%)', background: 'none',
                  border: 'none', cursor: 'pointer', fontSize: 15, color: C.muted }}>
                ✕
              </button>
            )}
          </div>
          <button onClick={() => load()} disabled={loading}
            style={{ padding: '9px 16px', borderRadius: 10, border: 'none',
              backgroundColor: loading ? '#9ca3af' : C.navy,
              color: loading ? '#fff' : C.gold,
              fontWeight: 800, fontSize: 12, cursor: loading ? 'not-allowed' : 'pointer',
              flexShrink: 0 }}>
            {loading ? '⏳' : '↻'}
          </button>
        </div>
      </div>

      {/* ── Action bar ── */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 16px 0' }}>
        <button onClick={() => load()} disabled={loading}
          style={{ flex: 2, padding: '11px', borderRadius: 11, border: 'none',
            backgroundColor: loading ? '#9ca3af' : C.green,
            color: '#fff', fontWeight: 800, fontSize: 13,
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: loading ? 'none' : '0 2px 8px rgba(26,71,42,0.3)' }}>
          {loading ? '⏳ Loading…' : `🔍 Search${preset === 'today' ? ' Today' : ''}`}
        </button>
        <button onClick={() => {
            setPreset('7d'); setFrom(ago(7)); setTo(today());
            setTagFilter(''); setTypeFilter('');
            setSearch(''); setHlOnly(false);
            load(ago(7), today(), '', '', '', false);
          }}
          style={{ flex: 1, padding: '11px', borderRadius: 11,
            border: `1px solid ${C.border}`, backgroundColor: C.card,
            color: C.muted, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
          Reset
        </button>
      </div>

      {/* ── Status message ── */}
      {msg && (
        <div style={{ margin: '10px 16px 0', padding: '10px 14px', borderRadius: 11,
          fontSize: 13, fontWeight: 700,
          backgroundColor: msg.startsWith('✅') ? '#dcfce7' : '#fee2e2',
          border: `1px solid ${msg.startsWith('✅') ? '#86efac' : '#fca5a5'}`,
          color: msg.startsWith('✅') ? '#166534' : C.red }}>
          {msg}
        </div>
      )}

      {/* ── Summary stats ── */}
      {fetched && items.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px 4px' }}>
          {[
            { icon: '📊', label: 'Total',      value: total,      color: C.green  },
            { icon: '📷', label: 'Photos',     value: photos,     color: C.blue   },
            { icon: '🎥', label: 'Videos',     value: videos,     color: C.purple },
            { icon: '⭐', label: 'Highlights', value: highlights, color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{ flex: 1, backgroundColor: C.card, borderRadius: 12,
              padding: '9px 6px', textAlign: 'center' as const,
              border: `1px solid ${C.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
              <div style={{ fontWeight: 900, fontSize: 17, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: C.muted, fontWeight: 700,
                textTransform: 'uppercase' as const, letterSpacing: '0.4px', marginTop: 1 }}>
                {s.icon} {s.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Results count */}
      {fetched && (
        <div style={{ padding: '6px 16px 8px', fontSize: 12, color: C.muted }}>
          {items.length} of {total} item{total !== 1 ? 's' : ''}
          {search && ` · "${search}"`}
          {tagFilter && ` · ${tagFilter}`}
          {typeFilter && ` · ${typeFilter === 'image' ? 'Photos' : 'Videos'} only`}
          {hlOnly && ' · Highlights only'}
        </div>
      )}

      {/* ── Empty states ── */}
      {!fetched && !loading && (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: C.muted }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🌟</div>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111', marginBottom: 6 }}>
            Academy Pulse Gallery
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            Daily moments from the academy — training, matches &amp; achievements.<br />
            Default shows last 7 days. Tap Search to load.
          </div>
        </div>
      )}
      {fetched && items.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: C.muted }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111', marginBottom: 6 }}>
            No media found
          </div>
          <div style={{ fontSize: 13 }}>Try a wider date range or clear filters</div>
          <button onClick={() => { setTagFilter(''); setTypeFilter(''); setSearch(''); setHlOnly(false); }}
            style={{ marginTop: 12, padding: '8px 20px', borderRadius: 20, border: 'none',
              backgroundColor: C.navy, color: C.gold, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            Clear Filters
          </button>
        </div>
      )}

      {/* ── Media cards ── */}
      <div style={{ padding: '4px 16px 0' }}>
        {items.map(item => (
          <div key={item.id} style={{ backgroundColor: C.card, borderRadius: 16,
            marginBottom: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.07)',
            overflow: 'hidden', border: `1px solid ${C.border}` }}>

            {/* Media */}
            <div style={{ position: 'relative', cursor: 'pointer' }}
              onClick={() => setLightbox(item)}>
              {item.resource_type === 'video' ? (
                <video src={item.secure_url} controls playsInline
                  style={{ width: '100%', maxHeight: 240, objectFit: 'cover',
                    display: 'block', backgroundColor: '#000' }}
                  onClick={e => e.stopPropagation()} />
              ) : (
                <img src={item.secure_url} alt={item.caption || ''}
                  style={{ width: '100%', height: 220, objectFit: 'cover', display: 'block' }} />
              )}

              {/* Overlay badges */}
              <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6 }}>
                <span style={{ backgroundColor: 'rgba(0,0,0,0.55)', color: '#fff',
                  borderRadius: 8, padding: '3px 9px', fontSize: 10, fontWeight: 800 }}>
                  {item.resource_type === 'video' ? '🎥 Video' : '📷 Photo'}
                </span>
                {item.tag_type && (
                  <span style={{ backgroundColor: (TAG_COLORS[item.tag_type] || C.muted) + 'dd',
                    color: '#fff', borderRadius: 8, padding: '3px 9px',
                    fontSize: 10, fontWeight: 800 }}>
                    {item.tag_type}
                  </span>
                )}
              </div>

              {/* Highlight star */}
              {can('media:upload') && (
                <button onClick={e => { e.stopPropagation(); toggleHighlight(item); }}
                  style={{ position: 'absolute', top: 8, right: 8,
                    width: 32, height: 32, borderRadius: '50%',
                    backgroundColor: 'rgba(0,0,0,0.45)',
                    border: 'none', cursor: 'pointer', fontSize: 16,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {item.is_highlight ? '⭐' : '☆'}
                </button>
              )}
            </div>

            {/* Info section */}
            <div style={{ padding: '12px 14px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'flex-start', marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {item.caption && (
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#111',
                      marginBottom: 4, lineHeight: 1.35 }}>
                      {item.caption}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: C.muted }}>
                    📅 {fmt(item.activity_date)}
                    {item.uploaded_by && ` · 👤 ${item.uploaded_by}`}
                  </div>
                </div>
              </div>

              {/* Actions */}
              {can('media:delete') && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setLightbox(item)}
                    style={{ flex: 1, padding: '8px', borderRadius: 10,
                      border: `1px solid ${C.border}`, backgroundColor: '#f9fafb',
                      color: C.muted, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                    🔍 View Full
                  </button>
                  <button onClick={() => del(item)}
                    style={{ flex: 1, padding: '8px', borderRadius: 10,
                      border: '1px solid #fca5a5', backgroundColor: '#fee2e2',
                      color: '#dc2626', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                    🗑 Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Lightbox ── */}
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 5000,
            backgroundColor: 'rgba(0,0,0,0.92)',
            display: 'flex', flexDirection: 'column' as const,
            alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 500, padding: '0 12px' }}>
            {lightbox.resource_type === 'video' ? (
              <video src={lightbox.secure_url} controls playsInline autoPlay
                style={{ width: '100%', borderRadius: 14, maxHeight: '70vh' }} />
            ) : (
              <img src={lightbox.secure_url} alt={lightbox.caption || ''}
                style={{ width: '100%', borderRadius: 14, maxHeight: '70vh',
                  objectFit: 'contain' }} />
            )}
            <div style={{ color: '#fff', textAlign: 'center' as const, marginTop: 12 }}>
              {lightbox.caption && (
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                  {lightbox.caption}
                </div>
              )}
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                {fmt(lightbox.activity_date)} · {lightbox.tag_type}
              </div>
            </div>
            <button onClick={() => setLightbox(null)}
              style={{ display: 'block', margin: '16px auto 0',
                backgroundColor: 'rgba(255,255,255,0.15)', border: 'none',
                color: '#fff', padding: '10px 28px', borderRadius: 20,
                cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
type PulseTab = 'capture' | 'gallery';


export default function PulseScreen() {
  const navigate = useNavigate();
  const { can }  = usePermissions();
  const base     = bld(localStorage.getItem('server_ip') ?? '');
  const [tab,   setTab]   = useState<PulseTab>(can('media:upload') ? 'capture' : 'gallery');
  const [badge, setBadge] = useState(0); // count of items uploaded this session

  const onUploaded = () => { setBadge(b => b + 1); setTab('gallery'); };

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh',
      fontFamily: 'sans-serif', paddingBottom: 40 }}>

      <ScreenHeader background={`linear-gradient(135deg,${C.navy} 0%,#0d2b4a 100%)`}
        title={<span style={{ color: C.gold }}>🌟 Academy Pulse</span>}
        subtitle="Daily academy life — training, matches & achievements"
        actions={badge > 0 ? (
          <div style={{ backgroundColor: C.green, color: '#fff', borderRadius: 20,
            padding: '4px 10px', fontSize: 12, fontWeight: 800, marginRight: 8 }}>
            +{badge} today
          </div>
        ) : undefined}>
        <HeaderTabs color={C.navy} value={tab} onChange={setTab}
          tabs={([
            ...(can('media:upload') ? [['capture', '📷 Capture']] : []),
            ['gallery', '📂 Gallery'],
          ] as [PulseTab, string][]).map(([id, label]) => ({ id, label }))} />
      </ScreenHeader>

      {/* Content */}
      {tab === 'capture' && can('media:upload') && (
        <CaptureTab base={base} onUploaded={onUploaded} />
      )}
      {tab === 'gallery' && <GalleryTab base={base} />}
    </div>
  );
}
