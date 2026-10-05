/**
 * Media Centre — /media
 * Capture-first: save blob immediately, tag & upload later.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { usePermissions, isDataRestricted, getLinkedStudentIds } from './usePermissions';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';
import ZoomableImage, { ZoomableVideo } from '../shared/ZoomableImage';
import {
  getActiveStudents,
  insertPendingMedia,
  getPendingMedia,
  getMediaSyncCounts,
  markMediaCldUploaded,
  markMediaSaved,
  markMediaError,
  deletePendingMedia,
  updatePendingMediaTags,
} from '../database/db';

// ─── Constants ────────────────────────────────────────────────────────────────
const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', gray:'#6b7280', red:'#c0392b', blue:'#2563eb', text:'#1f2937' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const TAG_COLORS: Record<string,string> = { Training:'#1a472a', Match:'#c0392b', Event:'#2563eb', Achievement:'#d97706', Other:'#6b7280' };
const TAG_TYPES    = ['Training','Match','Event','Achievement','Other'];
const MAX_BYTES    = 80 * 1024 * 1024;
const PHOTO_MAX_PX = 1280;
const PHOTO_Q      = 0.75;

// ─── OPFS helpers ─────────────────────────────────────────────────────────────
function blobFileName(id: number, mime: string) {
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'jpg';
  return `qca_media_${id}.${ext}`;
}
async function opfsSave(name: string, blob: Blob) {
  try {
    const root = await (navigator.storage as any).getDirectory();
    const fh   = await root.getFileHandle(name, { create: true });
    const w    = await fh.createWritable();
    await w.write(blob); await w.close();
  } catch(e) { console.warn('OPFS save failed', e); }
}
async function opfsLoad(name: string): Promise<Blob|null> {
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
async function opfsList(): Promise<{name:string; size:number}[]> {
  try {
    const root = await (navigator.storage as any).getDirectory();
    const files: {name:string; size:number}[] = [];
    for await (const [name, handle] of (root as any).entries()) {
      if (!name.startsWith('qca_media_')) continue;
      try {
        const file = await handle.getFile();
        files.push({ name, size: file.size });
      } catch {
        files.push({ name, size: 0 });
      }
    }
    return files.sort((a,b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildBase(ip: string) {
  const c = (ip||'').trim().replace(/\/+$/,'');
  return c.startsWith('http') ? c : `http://${c}`;
}
function hdrs(): Record<string,string> {
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
/** Small Cloudinary rendition for grids — a still frame for videos */
function thumbUrl(url: string, isVideo: boolean, px = 360) {
  if (!url || !url.includes('/upload/')) return url;
  const u = url.replace('/upload/', `/upload/c_fill,w_${px},h_${px},q_auto${isVideo ? ',so_1' : ''}/`);
  return isVideo ? u.replace(/\.[a-z0-9]+$/i, '.jpg') : u;
}
function Chip({ on, color = C.green, onClick, children }: { on:boolean; color?:string; onClick:()=>void; children:React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      style={{ flexShrink:0, padding:'5px 11px', borderRadius:16, cursor:'pointer', fontSize:11.5, fontWeight:700, whiteSpace:'nowrap',
        border:`1px solid ${on ? color : C.border}`, backgroundColor:on ? color : '#fff', color:on ? '#fff' : '#374151' }}>
      {children}
    </button>
  );
}
function sName(students: any[], id: any) {
  const n = Number(id);
  return students.find(s => Number(s.id)===n)?.name ?? `QCA-${n}`;
}
function fmtSz(b: number) { return b > 1024*1024 ? `${(b/1024/1024).toFixed(1)} MB` : `${(b/1024).toFixed(0)} KB`; }
function fmtDate(s: string) {
  if (!s) return '—';
  const d = new Date(String(s).slice(0,10) + 'T00:00:00');
  return isNaN(d.getTime()) ? String(s).slice(0,10) : d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function compressPhoto(file: Blob): Promise<Blob> {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w=img.width, h=img.height;
      if (Math.max(w,h)>PHOTO_MAX_PX) { if(w>=h){h=Math.round(h*PHOTO_MAX_PX/w);w=PHOTO_MAX_PX;}else{w=Math.round(w*PHOTO_MAX_PX/h);h=PHOTO_MAX_PX;} }
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d')!.drawImage(img,0,0,w,h);
      cv.toBlob(b=>b?res(b):rej(new Error('Canvas failed')),'image/jpeg',PHOTO_Q);
    };
    img.onerror=()=>rej(new Error('Load failed')); img.src=url;
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function SBadge({ s }: { s: string }) {
  const m: Record<string,[string,string]> = { pending:['#b45309','⏳ Waiting'], cld_uploaded:[C.blue,'☁ Half-done'], saved:['#166534','✔ Saved'], error:[C.red,'✖ Error'] };
  const [col,lbl] = m[s]||[C.gray,s];
  return <span style={{ fontSize:10.5,fontWeight:800,padding:'2px 7px',borderRadius:8,backgroundColor:col+'18',color:col,whiteSpace:'nowrap' }}>{lbl}</span>;
}

// ─── Tag edit modal ───────────────────────────────────────────────────────────
function TagModal({ item, students, onSave, onClose }: { item:any; students:any[]; onSave:(ids:number[],tag:string,note:string)=>void; onClose:()=>void }) {
  const init = (item.student_ids||[]).map(Number).filter((n:number)=>!isNaN(n)&&n>0);
  const [sel, setSel]   = useState<number[]>(init);
  const [tag, setTag]   = useState(item.tag_type||'Training');
  const [note,setNote]  = useState(item.coach_note||'');
  const [q,   setQ]     = useState('');
  const toggle = (id: any) => { const n=Number(id); setSel(p=>p.includes(n)?p.filter(x=>x!==n):[...p,n]); };
  const ql = q.toLowerCase();
  const filt = students.filter(s=>s.name.toLowerCase().includes(ql) || String(s.regno||'').toLowerCase().includes(ql));
  return (
    <div onClick={onClose} style={{ position:'fixed',inset:0,zIndex:6000,backgroundColor:'rgba(0,0,0,0.7)',display:'flex',alignItems:'flex-end' }}>
      <div onClick={e=>e.stopPropagation()} style={{ backgroundColor:'#fff',width:'100%',maxHeight:'85vh',borderRadius:'20px 20px 0 0',overflowY:'auto',paddingBottom:30 }}>
        <div style={{ backgroundColor:C.green,padding:'15px 18px',borderRadius:'20px 20px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center' }}>
          <div style={{ color:'#fff',fontWeight:800,fontSize:16 }}>Tag Students ({sel.length} selected)</div>
          <button onClick={onClose} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.8)',fontSize:22,cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ padding:'14px 16px 0' }}>
          <div style={{ display:'flex',flexWrap:'wrap',gap:6,marginBottom:12 }}>
            {TAG_TYPES.map(t=><button key={t} onClick={()=>setTag(t)} style={{ padding:'6px 14px',borderRadius:20,border:'none',cursor:'pointer',fontWeight:700,fontSize:12,backgroundColor:tag===t?C.green:'#f0f0f0',color:tag===t?'#fff':'#555' }}>{t}</button>)}
          </div>
          <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Coach note…"
            style={{ width:'100%',borderRadius:8,border:`1px solid ${C.border}`,padding:'8px 10px',fontSize:14,marginBottom:10,boxSizing:'border-box' as const }} />
          <div style={{ display:'flex',gap:8,backgroundColor:'#f5f5f5',borderRadius:8,padding:'8px 10px',marginBottom:8 }}>
            <span>🔍</span>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search students…"
              style={{ flex:1,border:'none',outline:'none',fontSize:13,background:'transparent' }} />
          </div>
          <div style={{ maxHeight:200,overflowY:'auto',borderRadius:10,border:`1px solid ${C.border}`,marginBottom:12 }}>
            {filt.slice(0,60).map((s,i)=>{ const on=sel.includes(Number(s.id)); return (
              <button key={Number(s.id)} onClick={()=>toggle(s.id)} style={{ display:'flex',alignItems:'center',gap:10,width:'100%',padding:'9px 12px',background:on?C.green+'12':'none',border:'none',borderBottom:i<filt.length-1?`1px solid ${C.border}`:'none',cursor:'pointer',textAlign:'left' }}>
                <div style={{ width:20,height:20,borderRadius:'50%',border:`2px solid ${on?C.green:'#ccc'}`,backgroundColor:on?C.green:'transparent',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,flexShrink:0 }}>{on?'✔':''}</div>
                <div><div style={{ fontSize:13,fontWeight:700,color:on?C.green:'#222' }}>{s.name}</div><div style={{ fontSize:11,color:C.gray }}>{[s.regno && String(s.regno).padStart(3,'0'), s.level].filter(Boolean).join(' · ')}</div></div>
              </button>
            );})}
          </div>
          <div style={{ display:'flex',gap:10 }}>
            <button onClick={onClose} style={{ flex:1,padding:'12px 0',borderRadius:10,border:`1px solid ${C.border}`,backgroundColor:'#fff',fontWeight:700,fontSize:14,cursor:'pointer',color:'#666' }}>Cancel</button>
            <button onClick={()=>onSave(sel,tag,note)} style={{ flex:2,padding:'12px 0',borderRadius:10,border:'none',backgroundColor:C.green,color:'#fff',fontWeight:700,fontSize:14,cursor:'pointer' }}>✔ Save Tags</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Item preview modal (Sync tab) ───────────────────────────────────────────
// Opens blob from OPFS, plays photo/video, shows file info, allows tagging
function PreviewModal({ item, students, onTag, onDelete, onClose }: {
  item: any; students: any[];
  onTag: (item:any)=>void;
  onDelete: (item:any)=>void;
  onClose: ()=>void;
}) {
  const [blobUrl, setBlobUrl] = useState<string|null>(null);
  const [fileInfo, setFileInfo] = useState('');
  const [loading,  setLoading]  = useState(true);

  const fileName = blobFileName(item.id, item.video_mime || (item.resource_type==='video'?'video/webm':'image/jpeg'));

  useEffect(() => {
    let created: string | null = null;
    opfsLoad(fileName).then(blob => {
      setLoading(false);
      if (blob) {
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
        setFileInfo(`📁 ${fileName} · ${fmtSz(blob.size)}`);
      } else {
        setFileInfo(`⚠ File not in device storage: ${fileName}`);
      }
    });
    return () => { if (created) URL.revokeObjectURL(created); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validIds = (item.student_ids||[]).map(Number).filter((n:number)=>!isNaN(n)&&n>0);
  const isVideo  = item.resource_type === 'video';

  return (
    <div onClick={onClose} style={{ position:'fixed',inset:0,zIndex:5000,backgroundColor:'rgba(0,0,0,0.92)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-start',paddingTop:20,overflowY:'auto' }}>
      <div onClick={e=>e.stopPropagation()} style={{ width:'100%',maxWidth:480,backgroundColor:'#111',borderRadius:16,overflow:'hidden',margin:'0 12px' }}>

        {/* Media preview */}
        <div style={{ backgroundColor:'#000',minHeight:220,display:'flex',alignItems:'center',justifyContent:'center' }}>
          {loading && <div style={{ color:'#555',fontSize:14 }}>Loading from storage…</div>}
          {!loading && !blobUrl && <div style={{ color:C.red,fontSize:13,padding:20,textAlign:'center' }}>File not found in device storage.<br/>You need to re-capture this item.</div>}
          {!loading && blobUrl && !isVideo && (
            <img src={blobUrl} alt="" style={{ width:'100%',maxHeight:320,objectFit:'contain' }} />
          )}
          {!loading && blobUrl && isVideo && (
            <video src={blobUrl} controls playsInline autoPlay style={{ width:'100%',maxHeight:320 }}>
              <source src={blobUrl} type={item.video_mime||'video/webm'} />
            </video>
          )}
        </div>

        {/* Info panel */}
        <div style={{ padding:'14px 16px' }}>
          {/* File location info */}
          <div style={{ backgroundColor:'#1a1a1a',borderRadius:8,padding:'8px 12px',marginBottom:12 }}>
            <div style={{ color:'#888',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:3 }}>Device Storage Location</div>
            <div style={{ color:'#bbb',fontSize:12,fontFamily:'monospace',wordBreak:'break-all' }}>{fileInfo || '…'}</div>
            <div style={{ color:'#555',fontSize:10,marginTop:3 }}>OPFS (Origin Private File System) — app internal storage</div>
          </div>

          {/* Details */}
          <div style={{ display:'flex',gap:10,marginBottom:10,flexWrap:'wrap' }}>
            <span style={{ fontSize:11,backgroundColor:'#222',color:'#aaa',padding:'3px 8px',borderRadius:6 }}>{isVideo?'🎥 Video':'📷 Photo'}</span>
            <span style={{ fontSize:11,backgroundColor:'#222',color:'#aaa',padding:'3px 8px',borderRadius:6 }}>{fmtSz(item.file_size_bytes)}</span>
            <span style={{ fontSize:11,backgroundColor:'#222',color:'#aaa',padding:'3px 8px',borderRadius:6 }}>{item.tag_type||'Training'}</span>
            <span style={{ fontSize:11,backgroundColor:'#222',color:'#aaa',padding:'3px 8px',borderRadius:6 }}>{fmtDate(item.attendance_date||item.created_at)}</span>
            <SBadge s={item.status} />
          </div>

          {/* Tagged students */}
          <div style={{ marginBottom:12 }}>
            <div style={{ color:'#888',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6 }}>Tagged Students</div>
            {validIds.length === 0 ? (
              <div style={{ color:C.red,fontSize:12 }}>⚠ No students tagged yet — tap Tag below</div>
            ) : (
              <div style={{ display:'flex',flexWrap:'wrap',gap:4 }}>
                {validIds.map((id:number)=>(
                  <span key={id} style={{ fontSize:12,backgroundColor:'#1a472a33',color:'#4caf77',padding:'3px 10px',borderRadius:10,fontWeight:600 }}>{sName(students,id)}</span>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display:'flex',gap:8 }}>
            <button onClick={onClose} style={{ flex:1,padding:'11px 0',borderRadius:10,border:'1px solid #333',backgroundColor:'transparent',color:'#aaa',fontWeight:700,fontSize:13,cursor:'pointer' }}>Close</button>
            <button onClick={()=>onTag(item)} style={{ flex:2,padding:'11px 0',borderRadius:10,border:'none',backgroundColor:C.gold,color:C.green,fontWeight:800,fontSize:13,cursor:'pointer' }}>✏ Tag Students</button>
            <button onClick={()=>onDelete(item)} style={{ padding:'11px 14px',borderRadius:10,border:`1px solid ${C.red}44`,backgroundColor:'transparent',color:C.red,fontWeight:700,fontSize:13,cursor:'pointer' }}>🗑</button>
          </div>
        </div>
      </div>
      <div style={{ color:'rgba(255,255,255,0.25)',fontSize:12,marginTop:16,marginBottom:20 }}>Tap outside to close</div>
    </div>
  );
}

// ─── Capture tab ──────────────────────────────────────────────────────────────
function CaptureTab({ onCaptured, navState }: { onCaptured:(id:number)=>void; navState:any }) {
  const { can } = usePermissions();
  const [mode,    setMode]   = useState<'idle'|'photo_live'|'video_live'|'photo_pre'|'video_pre'>('idle');
  const [blob,    setBlob]   = useState<Blob|null>(null);
  const [preview, setPrev]   = useState<string|null>(null);
  const [info,    setInfo]   = useState('');
  const [vMime,   setVMime]  = useState('video/webm');
  const [saving,  setSaving] = useState(false);
  const [msg,     setMsg]    = useState('');
  const [recSecs, setRecSec] = useState(0);
  const [recBytes,setRecByt] = useState(0);
  const [stream,  setStream] = useState<MediaStream|null>(null);

  const vidRef  = useRef<HTMLVideoElement>(null);
  const phRef   = useRef<HTMLVideoElement>(null);
  const sRef    = useRef<MediaStream|null>(null);
  const recRef  = useRef<MediaRecorder|null>(null);
  const chnkRef = useRef<Blob[]>([]);
  const tmrRef  = useRef<ReturnType<typeof setInterval>|null>(null);

  const galRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => stopStream(), []);
  useEffect(() => {
    if (!stream) return;
    const el = mode==='photo_live' ? phRef.current : vidRef.current;
    if (el) { el.srcObject=stream; el.play().catch(()=>{}); }
  }, [stream, mode]);

  const stopStream = () => {
    // Explicitly stop every track AND null srcObject — prevents mic staying locked
    // in Android WebView between getUserMedia calls
    if (sRef.current) {
      sRef.current.getTracks().forEach(t => { t.stop(); t.enabled = false; });
      sRef.current = null;
    }
    // Null srcObject on both video elements to release hardware immediately
    if (vidRef.current)  { vidRef.current.srcObject  = null; }
    if (phRef.current)   { phRef.current.srcObject   = null; }
    setStream(null);
    if (tmrRef.current) { clearInterval(tmrRef.current); tmrRef.current = null; }
  };

  const retake = () => {
    stopStream();
    if (preview) URL.revokeObjectURL(preview);
    setBlob(null); setPrev(null); setInfo(''); setMode('idle');
    setVMime('video/webm'); setRecSec(0); setRecByt(0); setMsg('');
  };

  const reqPerm = async () => {
    try {
      const Cap = (window as any).Capacitor;
      if (Cap?.isNativePlatform?.()) {
        const P = Cap.Plugins?.Permissions as any;
        if (P?.requestPermissions) await P.requestPermissions({ permissions:['camera','microphone'] });
      }
    } catch {}
  };

  const camStream = async (audio: boolean): Promise<MediaStream> => {
    // Try with requested audio setting first
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode:'environment', width:{ideal:1280}, height:{ideal:720} },
        audio: audio ? { echoCancellation:true, noiseSuppression:true, sampleRate:44100 } : false,
      });
    } catch (e: any) {
      // If NotReadableError with audio=true, the WebView audio context is stuck.
      // Release it by creating a silent AudioContext and closing it, then retry.
      if (audio && (e?.name === 'NotReadableError' || e?.name === 'AbortError')) {
        try {
          const ac = new AudioContext();
          await ac.close();
          // Small delay for Android audio HAL to release the mic
          await new Promise(r => setTimeout(r, 300));
          return await navigator.mediaDevices.getUserMedia({
            video: { facingMode:'environment', width:{ideal:1280}, height:{ideal:720} },
            audio: { echoCancellation:true, noiseSuppression:true },
          });
        } catch {
          // AudioContext trick failed — fall through to video-only
        }
      }
      throw e;
    }
  };

  const startPhoto = async () => {
    setMsg(''); await reqPerm();
    try {
      const s = await camStream(false);
      sRef.current=s; setMode('photo_live'); setStream(s);
    } catch(e:any) {
      const n=e?.name??'';
      if(n==='NotAllowedError'||n==='PermissionDeniedError') setMsg('BLOCKED');
      else if(n==='NotReadableError') setMsg('⚠ Camera busy — close other apps');
      else setMsg(`⚠ ${n}`);
    }
  };

  const snapPhoto = () => {
    if (!phRef.current) return;
    const v=phRef.current, cv=document.createElement('canvas');
    let w=v.videoWidth||1280, h=v.videoHeight||720;
    if(Math.max(w,h)>PHOTO_MAX_PX){if(w>=h){h=Math.round(h*PHOTO_MAX_PX/w);w=PHOTO_MAX_PX;}else{w=Math.round(w*PHOTO_MAX_PX/h);h=PHOTO_MAX_PX;}}
    cv.width=w; cv.height=h;
    cv.getContext('2d')!.drawImage(v,0,0,w,h);
    stopStream();
    cv.toBlob(b=>{
      if(!b){setMsg('⚠ Snap failed');setMode('idle');return;}
      const url=URL.createObjectURL(b);
      setBlob(b); setPrev(url); setInfo(`${fmtSz(b.size)} · ${w}×${h}`); setMode('photo_pre');
    },'image/jpeg',PHOTO_Q);
  };

  const startVideo = async () => {
    setMsg('Starting camera…'); await reqPerm();
    // Small delay to let Android audio HAL fully release from any prior session
    await new Promise(r => setTimeout(r, 200));
    try {
      const s = await camStream(true);
      sRef.current=s; setMode('video_live'); setStream(s); setMsg('');
    } catch(e:any) {
      const n = e?.name ?? '';
      if (n==='NotAllowedError'||n==='PermissionDeniedError') {
        setMsg('BLOCKED');
      } else if (n==='NotReadableError'||n==='AbortError') {
        // Mic still locked — video only
        setMsg('Mic unavailable, trying video only…');
        await new Promise(r => setTimeout(r, 500));
        try {
          const s = await camStream(false);
          sRef.current=s; setMode('video_live'); setStream(s);
          setMsg('⚠ Recording without audio (mic unavailable)');
        } catch(e2:any) { setMsg(`⚠ Camera error: ${(e2 as any)?.name}`); }
      } else {
        setMsg(`⚠ ${n}: ${e?.message ?? ''}`);
      }
    }
  };

  const startRec = () => {
    if(!sRef.current) return;
    chnkRef.current=[]; let total=0;
    const mime=['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm','video/mp4'].find(m=>MediaRecorder.isTypeSupported(m))||'';
    const rec=new MediaRecorder(sRef.current, mime?{mimeType:mime}:{});
    recRef.current=rec;
    rec.ondataavailable=e=>{
      if(!e.data.size) return;
      chnkRef.current.push(e.data); total+=e.data.size; setRecByt(total);
      if(total>=MAX_BYTES) rec.stop();
    };
    rec.onstop=()=>{
      stopStream();
      const am=mime||'video/webm';
      const b=new Blob(chnkRef.current,{type:am});
      const url=URL.createObjectURL(b);
      setBlob(b); setPrev(url); setVMime(am); setInfo(`${fmtSz(b.size)} · ${am.split(';')[0]}`); setMode('video_pre');
      if(tmrRef.current){clearInterval(tmrRef.current);tmrRef.current=null;}
    };
    rec.start(200);
    tmrRef.current=setInterval(()=>setRecSec(s=>s+1),1000);
  };

  const stopRec = () => recRef.current?.state==='recording' && recRef.current.stop();

  // Gallery — file input change handler
  const onGallery = () => { if (!can('media:upload')) { setMsg('🔒 Permission denied: media:upload'); return; } galRef.current?.click(); };

  const onGalleryWeb = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f=e.target.files?.[0]; e.target.value='';
    if(!f) return;
    if(f.size>MAX_BYTES){setMsg(`⚠ Too large (${fmtSz(f.size)}). Max 80 MB.`);return;}
    setMsg('Processing…');
    try {
      if(f.type.startsWith('image/')) {
        const c=await compressPhoto(f); const url=URL.createObjectURL(c);
        setBlob(c); setPrev(url); setInfo(`${fmtSz(f.size)} → ${fmtSz(c.size)}`); setMode('photo_pre');
      } else {
        const url=URL.createObjectURL(f);
        setBlob(f); setPrev(url); setVMime(f.type||'video/webm'); setInfo(fmtSz(f.size)); setMode('video_pre');
      }
      setMsg('');
    } catch(err:any){ setMsg('⚠ '+err.message); }
  };

  // Save immediately — tag later
  const doSave = async () => {
    if(!blob){setMsg('Nothing captured');return;}
    setSaving(true); setMsg('Saving to device…');
    try {
      const isVid = mode==='video_pre';
      const mime  = isVid ? vMime : 'image/jpeg';
      const initIds = navState?.student_id ? [Number(navState.student_id)] : [];
      const newId = await insertPendingMedia({
        local_path:'', resource_type:isVid?'video':'image',
        file_size_bytes:blob.size, student_ids:initIds,
        tag_type:'Training', coach_note:'',
        session_type:navState?.session_type??'',
        attendance_date:navState?.attendance_date??'',
        video_mime:mime,
      });
      await opfsSave(blobFileName(newId, mime), blob);
      setMsg('✔ Saved! Go to Sync tab to tag & upload.');
      setTimeout(()=>{ retake(); onCaptured(newId); },900);
    } catch(e:any){ setMsg('⚠ '+(e?.message??e)); }
    finally{ setSaving(false); }
  };

  const isPre = mode==='photo_pre'||mode==='video_pre';

  return (
    <div style={{ padding:'10px 10px 24px' }}>
      {mode==='idle' && (<>
        {navState?.student_id && (
          <div style={{ ...CARD, padding:'7px 12px', marginBottom:8, fontSize:12, color:C.green, fontWeight:700 }}>
            🏷 Will be tagged to the student you came from — you can change it before upload
          </div>
        )}
        <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:10 }}>
          {[{ icon:'📷', label:'Photo', on:startPhoto }, { icon:'🎥', label:'Video', on:startVideo }].map(b => (
            <button key={b.label} onClick={b.on} style={{ ...CARD, padding:'12px 4px', cursor:'pointer',
              display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              <span style={{ fontSize:22 }}>{b.icon}</span>
              <span style={{ fontSize:12, fontWeight:800, color:C.green }}>{b.label}</span>
            </button>
          ))}
          {/* From phone — the input covers the tile for a reliable Android tap */}
          <div style={{ ...CARD, padding:'12px 4px', position:'relative', display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
            <span style={{ fontSize:22, pointerEvents:'none' }}>🖼</span>
            <span style={{ fontSize:12, fontWeight:800, color:C.green, pointerEvents:'none' }}>From phone</span>
            <input ref={galRef} type="file" accept="image/*,video/*" onChange={onGalleryWeb} aria-label="Pick from phone"
              style={{ position:'absolute', inset:0, width:'100%', height:'100%', opacity:0.01, cursor:'pointer' }}/>
          </div>
        </div>
        <div style={{ fontSize:11.5, color:C.gray, textAlign:'center', lineHeight:1.5 }}>
          Capture now — it's kept on this phone. Tag students and upload later from the ☁ Sync tab.
        </div>
      </>)}

      {mode==='photo_live' && (
        <div style={{ marginBottom:14 }}>
          <video ref={phRef} muted playsInline autoPlay style={{ width:'100%',borderRadius:12,maxHeight:340,objectFit:'cover',backgroundColor:'#000' }} />
          <div style={{ display:'flex',gap:8,marginTop:10 }}>
            <button onClick={snapPhoto} style={{ ...CB('#27ae60'),flex:2,fontSize:16 }}>📸 Snap</button>
            <button onClick={retake}   style={{ ...CB(C.gray),flex:1 }}>✕</button>
          </div>
        </div>
      )}

      {mode==='video_live' && (
        <div style={{ marginBottom:14,position:'relative' }}>
          <video ref={vidRef} muted playsInline autoPlay style={{ width:'100%',borderRadius:12,maxHeight:260,objectFit:'cover',backgroundColor:'#000' }} />
          {recRef.current?.state==='recording' && (
            <>
              <div style={{ position:'absolute',top:10,left:12,display:'flex',alignItems:'center',gap:6,backgroundColor:'rgba(0,0,0,0.65)',borderRadius:8,padding:'4px 10px' }}>
                <div style={{ width:8,height:8,borderRadius:'50%',backgroundColor:C.red }} />
                <span style={{ color:'#fff',fontSize:12,fontWeight:800 }}>{String(Math.floor(recSecs/60)).padStart(2,'0')}:{String(recSecs%60).padStart(2,'0')}</span>
                <span style={{ color:'rgba(255,255,255,0.6)',fontSize:11 }}>{fmtSz(recBytes)}/{fmtSz(MAX_BYTES)}</span>
              </div>
              <div style={{ position:'absolute',bottom:54,left:0,right:0,height:4,backgroundColor:'rgba(0,0,0,0.3)' }}>
                <div style={{ width:`${Math.min(100,recBytes/MAX_BYTES*100)}%`,height:'100%',backgroundColor:recBytes>MAX_BYTES*0.8?C.red:C.gold }} />
              </div>
            </>
          )}
          <div style={{ display:'flex',gap:8,marginTop:10 }}>
            {recRef.current?.state!=='recording'
              ? <button onClick={startRec} style={{ ...CB(C.red),flex:2 }}>⏺ Record</button>
              : <button onClick={stopRec}  style={{ ...CB(C.red),flex:2 }}>⏹ Stop</button>}
            <button onClick={retake} style={{ ...CB(C.gray),flex:1 }}>✕</button>
          </div>
        </div>
      )}

      {isPre && preview && (
        <div style={{ marginBottom:14,position:'relative' }}>
          {mode==='video_pre'
            ? <video controls playsInline style={{ width:'100%',borderRadius:12,maxHeight:260,backgroundColor:'#000' }}><source src={preview} type={vMime}/></video>
            : <img src={preview} alt="" style={{ width:'100%',borderRadius:12,maxHeight:280,objectFit:'cover' }}/>}
          <div style={{ position:'absolute',top:8,left:8,right:8,display:'flex',justifyContent:'space-between' }}>
            <span style={{ backgroundColor:'rgba(0,0,0,0.65)',color:'#fff',fontSize:11,padding:'3px 8px',borderRadius:8,fontWeight:700 }}>{info}</span>
            <button onClick={retake} style={{ backgroundColor:'rgba(0,0,0,0.65)',color:'#fff',border:'none',borderRadius:8,padding:'3px 10px',cursor:'pointer',fontSize:12,fontWeight:700 }}>✕ Retake</button>
          </div>
        </div>
      )}

      {msg==='BLOCKED' ? (
        <div style={{ padding:'12px 14px',borderRadius:10,marginBottom:12,backgroundColor:'#fdecea',borderLeft:`4px solid ${C.red}` }}>
          <div style={{ fontWeight:800,fontSize:14,color:C.red,marginBottom:4 }}>⚠ Camera blocked</div>
          <div style={{ fontSize:12,color:'#666',lineHeight:1.5 }}>Settings → Apps → QCA → Permissions → Camera: Allow · Microphone: Allow</div>
        </div>
      ) : msg ? (
        <div style={{ padding:'8px 12px',borderRadius:10,marginBottom:10,fontSize:12.5,fontWeight:700,
          backgroundColor:msg.startsWith('✔')?'#e8f5e9':msg.startsWith('⚠')||msg.startsWith('🔒')?'#fdecea':'#f0f4f0',
          color:msg.startsWith('✔')?'#166534':msg.startsWith('⚠')||msg.startsWith('🔒')?C.red:C.green }}>{msg}</div>
      ) : null}

      {isPre && (
        <button onClick={doSave} disabled={saving} style={{ width:'100%',padding:11,borderRadius:11,border:'none',backgroundColor:saving?'#ccc':C.green,color:saving?'#fff':C.gold,fontWeight:900,fontSize:14,cursor:saving?'not-allowed':'pointer' }}>
          {saving ? '⏳ Saving…' : '💾 Save Now — Tag & Upload Later'}
        </button>
      )}
    </div>
  );
}

// ─── Storage Inspector modal ─────────────────────────────────────────────────
function StorageInspector({ items, onClose }: { items: any[]; onClose: ()=>void }) {
  const [opfsFiles, setOpfsFiles] = useState<{name:string;size:number}[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [estimate,  setEstimate]  = useState<{usage:number;quota:number}|null>(null);

  useEffect(() => {
    Promise.all([
      opfsList(),
      navigator.storage?.estimate?.() ?? Promise.resolve(null),
    ]).then(([files, est]) => {
      setOpfsFiles(files);
      if (est) setEstimate({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
      setLoading(false);
    });
  }, []);

  // Match OPFS files to pending_media rows
  const pendingMap: Record<string, any> = {};
  items.forEach(i => {
    const fn = blobFileName(i.id, i.video_mime || (i.resource_type==='video'?'video/webm':'image/jpeg'));
    pendingMap[fn] = i;
  });

  const pct = estimate && estimate.quota ? Math.min(100, estimate.usage / estimate.quota * 100) : 0;
  return (
    <div onClick={onClose} style={{ position:'fixed',inset:0,zIndex:6000,backgroundColor:'rgba(0,0,0,0.55)',display:'flex',alignItems:'flex-end' }}>
      <div onClick={e=>e.stopPropagation()} style={{ backgroundColor:C.bg,width:'100%',maxHeight:'85vh',borderRadius:'16px 16px 0 0',overflowY:'auto',paddingBottom:24 }}>
        <div style={{ backgroundColor:C.green,padding:'12px 14px',display:'flex',justifyContent:'space-between',alignItems:'center' }}>
          <div>
            <div style={{ color:'#fff',fontWeight:800,fontSize:15 }}>📦 Files on this phone</div>
            <div style={{ color:'rgba(255,255,255,0.7)',fontSize:11,marginTop:1 }}>Captured media waiting to upload</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background:'none',border:'none',color:'rgba(255,255,255,0.85)',fontSize:20,cursor:'pointer' }}>✕</button>
        </div>

        <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
          {estimate && (
            <div style={{ ...CARD, padding:'9px 12px' }}>
              <div style={{ display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:6 }}>
                <span style={{ color:C.gray }}>App storage used</span>
                <span><b style={{ color:C.green }}>{fmtSz(estimate.usage)}</b> <span style={{ color:C.gray }}>of {fmtSz(estimate.quota)}</span></span>
              </div>
              <div style={{ height:5,backgroundColor:'#e5e7eb',borderRadius:3,overflow:'hidden' }}>
                <div style={{ width:`${pct}%`,height:'100%',backgroundColor:C.green }}/>
              </div>
            </div>
          )}

          <div style={{ fontSize:11.5, color:C.gray, lineHeight:1.5, padding:'0 2px' }}>
            Files live in the app's private storage (not visible in the phone's file manager) and are deleted automatically once uploaded.
          </div>

          <div style={{ fontSize:10.5,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.8px',margin:'4px 2px 0' }}>
            Files ({opfsFiles.length})
          </div>
          {loading && <div style={{ color:C.gray,textAlign:'center',padding:16,fontSize:13 }}>Scanning storage…</div>}
          {!loading && opfsFiles.length === 0 && (
            <div style={{ ...CARD, color:C.gray,textAlign:'center',padding:16,fontSize:12.5 }}>No media files waiting on this phone.</div>
          )}
          {opfsFiles.length > 0 && (
            <div style={CARD}>
              {opfsFiles.map((f, i) => {
                const linked = pendingMap[f.name];
                return (
                  <div key={f.name} style={{ padding:'8px 12px', borderTop: i ? `1px solid ${C.border}` : 'none',
                    boxShadow:`inset 3px 0 0 ${linked ? C.gold : '#d1d5db'}` }}>
                    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:8 }}>
                      <span style={{ fontFamily:'monospace',fontSize:11.5,color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{f.name}</span>
                      <span style={{ fontSize:11,color:C.gray,flexShrink:0 }}>{fmtSz(f.size)}</span>
                    </div>
                    <div style={{ fontSize:11,marginTop:2,color: linked ? '#92400e' : C.gray }}>
                      {linked
                        ? `Queued #${linked.id} · ${linked.tag_type||'Training'} · ${linked.status} · ${fmtDate(linked.attendance_date||linked.created_at)}`
                        : 'Orphaned — no queue entry'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sync tab ─────────────────────────────────────────────────────────────────
function SyncTab({ students, onSynced }: { students:any[]; onSynced:()=>void }) {
  const { can } = usePermissions();
  const [items,   setItems]   = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [log,     setLog]     = useState<string[]>([]);
  const [preview, setPreview] = useState<any|null>(null);  // item to preview
  const [tagItem, setTagItem] = useState<any|null>(null);  // item to tag
  const [showStorage, setShowStorage] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => setItems(await getPendingMedia()), []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight; }, [log]);

  const addLog = (m:string) => setLog(l=>[...l,`${new Date().toLocaleTimeString('en-GB',{hour12:false})} ${m}`]);

  const removeItem = async (item: any) => {
    await opfsDel(blobFileName(item.id, item.video_mime||''));
    await deletePendingMedia(item.id);
    setPreview(null); await reload();
  };

  const saveTag = async (ids:number[], tag:string, note:string) => {
    if(!tagItem) return;
    await updatePendingMediaTags(tagItem.id, ids.map(Number), tag, note);
    setTagItem(null); await reload();
    // Refresh preview if it's the same item
    if(preview?.id===tagItem.id) setPreview((prev:any)=>prev?{...prev,student_ids:ids,tag_type:tag,coach_note:note}:null);
  };

  const runSync = async () => {
    const ip=localStorage.getItem('server_ip');
    if(!ip){addLog('✖ No server configured');return;}
    setRunning(true); setLog([]);
    const base=buildBase(ip), H=hdrs();
    addLog('› Checking server…');
    try {
      const p=await Promise.race([fetch(`${base}/api/data/ping`,{method:'GET',headers:H}),new Promise<never>((_,r)=>setTimeout(()=>r(new Error('Timeout')),5000))]) as Response;
      if(!p.ok) throw new Error(`Server ${p.status}`);
      addLog('✔ Server reachable');
    } catch(e:any){addLog(`✖ ${e?.message}`);setRunning(false);return;}

    const pending=await getPendingMedia();
    if(!pending.length){addLog('✔ Nothing to sync');setRunning(false);return;}
    addLog(`▶ ${pending.length} item(s) to upload…`);

    for(const item of pending){
      const vIds=(item.student_ids||[]).map(Number).filter((n:number)=>!isNaN(n)&&n>0);
      addLog(`› #${item.id} ${item.resource_type} — ${vIds.map((id:number)=>sName(students,id)).join(', ')||'untagged'}`);
      try {
        let pubId=item.cloudinary_public_id||'', secUrl=item.secure_url||'';
        if(item.status!=='cld_uploaded'){
          const iR=await fetch(`${base}/api/data/media/init`,{method:'POST',headers:H,body:JSON.stringify({resource_type:item.resource_type})});
          if(!iR.ok) throw new Error(`Init ${iR.status}`);
          const iD=await iR.json();
          const fn=blobFileName(item.id,item.video_mime||(item.resource_type==='video'?'video/webm':'image/jpeg'));
          let fb:Blob|null=await opfsLoad(fn);
          if(!fb){addLog('  ⚠ File missing — remove and re-capture');await markMediaError(item.id,'File missing');await reload();continue;}
          const um=item.video_mime||(item.resource_type==='video'?'video/webm':'image/jpeg');
          const uploadName=`qca_${item.id}_${Date.now()}.${blobFileName(item.id,um).split('.').pop()}`;
          const nf=new File([fb],uploadName,{type:um});
          addLog(`  › Uploading ${fmtSz(item.file_size_bytes)} as ${uploadName}`);
          const fd=new FormData();
          fd.append('file',nf,uploadName); fd.append('api_key',iD.api_key);
          fd.append('timestamp',String(iD.timestamp)); fd.append('folder',iD.folder); fd.append('signature',iD.signature);
          const cR=await fetch(iD.upload_url,{method:'POST',body:fd});
          if(!cR.ok){const et=await cR.text().catch(()=>'');throw new Error(`Cloudinary ${cR.status}: ${et.slice(0,200)}`);}
          const cD=await cR.json(); pubId=cD.public_id; secUrl=cD.secure_url;
          await markMediaCldUploaded(item.id,pubId,secUrl);
          addLog('  ✔ Cloudinary done');
        }
        const sR=await fetch(`${base}/api/data/media/save`,{method:'POST',headers:H,body:JSON.stringify({cloudinary_public_id:pubId,secure_url:secUrl,resource_type:item.resource_type,student_ids:vIds,tag_type:item.tag_type||'Training',coach_note:item.coach_note||'',session_type:item.session_type||'',attendance_date:item.attendance_date||''})});
        const sD=await sR.json();
        if(!sR.ok) throw new Error(sD.error??sR.status);
        await markMediaSaved(item.id);
        await opfsDel(blobFileName(item.id,item.video_mime||''));
        addLog(`  ✔ Saved — media_id=${sD.media_id}`);
      } catch(e:any){await markMediaError(item.id,e?.message??String(e));addLog(`  ✖ ${e?.message}`);}
      await reload();
    }
    addLog('■ Done'); setRunning(false); onSynced();
  };

  const pending   = items.filter(i=>i.status!=='saved').length;
  const errors    = items.filter(i=>i.status==='error').length;
  const untagged  = items.filter(i=>i.status!=='saved' && !(i.student_ids||[]).map(Number).some((n:number)=>n>0)).length;
  const cell = (n: number, label: string, color: string, first?: boolean) => (
    <div style={{ flex:1, padding:'7px 4px', textAlign:'center', borderLeft: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize:16, fontWeight:900, color: n > 0 ? color : '#c0c4cc' }}>{n}</div>
      <div style={{ fontSize:9.5, fontWeight:700, color:C.gray, textTransform:'uppercase', letterSpacing:'0.4px' }}>{label}</div>
    </div>
  );

  return (
    <>
    <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
      <div style={CARD}>
        <div style={{ display:'flex' }}>
          {cell(items.filter(i=>i.status==='pending').length, 'Waiting', '#b45309', true)}
          {cell(items.filter(i=>i.status==='cld_uploaded').length, 'Half-done', C.blue)}
          {cell(untagged, 'Untagged', '#b45309')}
          {cell(errors, 'Errors', C.red)}
        </div>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button onClick={runSync} disabled={running||pending===0} style={{ flex:1, padding:11, borderRadius:11, border:'none',
          backgroundColor: running ? '#9ca3af' : pending===0 ? '#e8f5e9' : C.green,
          color: running ? '#fff' : pending===0 ? '#166534' : C.gold, fontWeight:900, fontSize:14,
          cursor: running||pending===0 ? 'not-allowed' : 'pointer' }}>
          {running ? '⏳ Uploading…' : pending===0 ? '✔ All uploaded' : `☁ Upload ${pending} item${pending>1?'s':''}`}
        </button>
        <button onClick={()=>setShowStorage(true)} aria-label="Files on this phone" style={{ flexShrink:0, padding:'0 12px', borderRadius:11,
          border:`1px solid ${C.border}`, backgroundColor:'#fff', color:C.green, fontWeight:700, fontSize:12, cursor:'pointer' }}>📦 Files</button>
      </div>
      {untagged > 0 && !running && (
        <div style={{ fontSize:11.5, color:'#92400e', padding:'0 2px' }}>
          ⚠ {untagged} item{untagged>1?'s have':' has'} no students — tap to tag before uploading (untagged items still upload)
        </div>
      )}

      {log.length>0 && (
        <div ref={logRef} style={{ ...CARD, padding:'8px 12px', fontFamily:'monospace', fontSize:11, maxHeight:140, overflowY:'auto', backgroundColor:'#f9fafb' }}>
          {log.map((l,i)=><div key={i} style={{ marginBottom:2, color:l.includes('✔')?'#166534':l.includes('✖')?C.red:l.includes('⚠')?'#b45309':C.gray }}>{l}</div>)}
        </div>
      )}

      {items.length===0 ? (
        <div style={{ ...CARD, padding:'26px 16px', textAlign:'center', color:C.gray }}>
          <div style={{ fontSize:30 }}>📭</div>
          <div style={{ fontWeight:800, fontSize:13.5, color:C.text, marginTop:6 }}>Nothing waiting</div>
          <div style={{ fontSize:12, marginTop:3 }}>Captured photos and videos appear here until uploaded</div>
        </div>
      ) : (
        <div style={CARD}>
          {items.map((item, i) => {
            const vIds = (item.student_ids||[]).map(Number).filter((n:number)=>!isNaN(n)&&n>0);
            const edge = item.status==='error' ? C.red : item.status==='cld_uploaded' ? C.blue : vIds.length ? C.gold : '#b45309';
            return (
              <button key={item.id} onClick={()=>setPreview(item)} style={{ display:'block', width:'100%', padding:'9px 12px', background:'none', border:'none',
                borderTop: i ? `1px solid ${C.border}` : 'none', boxShadow:`inset 3px 0 0 ${edge}`, cursor:'pointer', textAlign:'left' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{ fontSize:18, width:24, textAlign:'center' }}>{item.resource_type==='video'?'🎥':'📷'}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:800, fontSize:13, color:C.text }}>
                      {item.tag_type||'Training'} <span style={{ fontWeight:600, color:C.gray }}>· {fmtDate(item.attendance_date||item.created_at)} · {fmtSz(item.file_size_bytes)}</span>
                    </div>
                    <div style={{ fontSize:11.5, marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                      color: vIds.length ? C.green : '#b45309', fontWeight:700 }}>
                      {vIds.length ? vIds.map((id:number)=>sName(students,id)).join(', ') : '⚠ No students — tap to tag'}
                    </div>
                    {item.error_msg && <div style={{ fontSize:11, color:C.red, marginTop:2 }}>⚠ {item.error_msg}</div>}
                  </div>
                  <SBadge s={item.status} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>

    {preview && (
      <PreviewModal
        item={preview} students={students}
        onTag={item=>{setTagItem(item);}}
        onDelete={item=>{if(confirm('Remove this item from the phone? It has not been uploaded.')) removeItem(item);}}
        onClose={()=>setPreview(null)}
      />
    )}
    {tagItem && (
      <TagModal item={tagItem} students={students} onSave={saveTag} onClose={()=>setTagItem(null)} />
    )}
    {showStorage && (
      <StorageInspector items={items} onClose={()=>setShowStorage(false)} />
    )}
    </>
  );
}

// ─── History tab ─────────────────────────────────────────────────────────────
function HistoryTab({ students }: { students: any[] }) {
  const { can }    = usePermissions();
  const restricted = isDataRestricted();
  const linkedIds  = getLinkedStudentIds();

  const toStr = (d: Date) => d.toISOString().slice(0,10);
  const today  = toStr(new Date());
  const ago    = (days: number) => toStr(new Date(Date.now() - (days-1)*86400000));

  const [from,    setFrom]    = useState(ago(7));
  const [to,      setTo]      = useState(today);
  const [fType,   setFType]   = useState<'all'|'Photo'|'Video'>('all');
  const [search,  setSearch]  = useState('');
  const [items,   setItems]   = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [msg,     setMsg]     = useState('');
  const [retag,   setRetag]   = useState<any|null>(null);

  const load = useCallback(async () => {
    const ip   = localStorage.getItem('server_ip') || '';
    const base = buildBase(ip);
    const H    = hdrs();
    if (!ip) { setMsg('⚠ Server IP not configured — go to Settings'); setLoading(false); return; }
    setLoading(true); setFetched(false); setMsg('');
    try {
      const params = new URLSearchParams({ limit:'500', date_from:from, date_to:to });
      if (fType !== 'all') params.set('file_type', fType);
      if (restricted && linkedIds.length > 0) params.set('student_id', String(linkedIds[0]));
      const url = `${base}/api/data/media/list?${params}`;
      const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(10000) });
      if (res.ok) { const j = await res.json(); setItems(j.data||[]); setFetched(true); }
      else setMsg(`⚠ Server error ${res.status}`);
    } catch (e:any) {
      if (e?.name === 'TimeoutError') setMsg('⚠ Request timed out — check server connection');
      else setMsg('⚠ Cannot reach server');
    }
    finally { setLoading(false); }
  }, [from, to, fType, restricted]);

  // Auto-load on mount with default 7-day range
  useEffect(() => { load(); }, [load]);

  const filtered = items.filter(item => {
    if (fType !== 'all' && item.file_type !== fType) return false;
    if (search) {
      const q = search.toLowerCase();
      const inStudents = (item.students||[]).some((t:any) => t.name?.toLowerCase().includes(q));
      const inNote     = (item.description||'').toLowerCase().includes(q);
      if (!inStudents && !inNote) return false;
    }
    return true;
  });

  const del = async (item: any) => {
    if (!confirm(`Delete this ${item.file_type}?`)) return;
    const base = buildBase(localStorage.getItem('server_ip')||'');
    const H    = hdrs();
    try {
      const res = await fetch(`${base}/api/data/media/${item.media_id}`, {
        method:'DELETE', headers:{...H,'Content-Type':'application/json'},
        body: JSON.stringify({ cloudinary_public_id: item.cloudinary_public_id||'' }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.status);
      setMsg(`✔ Deleted`);
      setItems(prev => prev.filter(i => i.media_id !== item.media_id));
      setTimeout(() => setMsg(''), 3000);
    } catch (e:any) { setMsg('⚠ '+e?.message); }
  };

  const saveRetag = async (ids: number[], tag: string, note: string) => {
    if (!retag) return;
    const base = buildBase(localStorage.getItem('server_ip')||'');
    const H    = hdrs();
    try {
      const res = await fetch(`${base}/api/data/media/${retag.media_id}/tags`, {
        method:'PUT', headers:{...H,'Content-Type':'application/json'},
        body: JSON.stringify({ student_ids:ids, tag_type:tag, coach_note:note, mode:'replace' }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setMsg(`✔ Re-tagged (${j.tags_total} students)`);
      setRetag(null); load(); setTimeout(() => setMsg(''), 3000);
    } catch (e:any) { setMsg('⚠ '+e?.message); }
  };

  // Stats
  const photos = filtered.filter(i=>i.file_type==='Photo').length;
  const videos = filtered.filter(i=>i.file_type==='Video').length;

  const [viewer,     setViewer]     = useState<any|null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const RANGES = [7, 15, 30, 90];
  const activeDays = RANGES.find(d => from === ago(d) && to === today);
  const isDefault  = activeDays === 7 && fType === 'all' && !search;
  const resetAll   = () => { setFrom(ago(7)); setTo(today); setFType('all'); setSearch(''); setShowCustom(false); };
  const cell = (n: number, label: string, first?: boolean) => (
    <div style={{ flex:1, padding:'6px 4px', textAlign:'center', borderLeft: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize:15, fontWeight:900, color:C.green }}>{n}</div>
      <div style={{ fontSize:9.5, fontWeight:700, color:C.gray, textTransform:'uppercase', letterSpacing:'0.4px' }}>{label}</div>
    </div>
  );
  const vIdx = viewer ? filtered.findIndex(i => i.media_id === viewer.media_id) : -1;
  const tagOf = (item: any) => item.students?.[0]?.tag_type || item.tag_type || 'Training';

  return (
    <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>

      {/* ── Filters ── */}
      <div style={{ ...CARD, padding:10, display:'flex', flexDirection:'column', gap:7 }}>
        <div style={{ display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none' }}>
          {RANGES.map(d => (
            <Chip key={d} on={activeDays === d && !showCustom} onClick={() => { setShowCustom(false); setFrom(ago(d)); setTo(today); }}>{d} days</Chip>
          ))}
          <Chip on={showCustom || !activeDays} onClick={() => setShowCustom(v => !v)}>Custom</Chip>
        </div>
        {(showCustom || !activeDays) && (
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            <input type="date" value={from} max={to} aria-label="From date" onChange={e => setFrom(e.target.value)}
              style={{ flex:1, minWidth:0, padding:'6px 8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:13 }} />
            <span style={{ color:C.gray, fontSize:12 }}>→</span>
            <input type="date" value={to} min={from} max={today} aria-label="To date" onChange={e => setTo(e.target.value)}
              style={{ flex:1, minWidth:0, padding:'6px 8px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:13 }} />
          </div>
        )}
        <div style={{ display:'flex', gap:3, padding:3, borderRadius:8, backgroundColor:'#f3f4f6' }}>
          {([['all','All'],['Photo','📷 Photos'],['Video','🎥 Videos']] as const).map(([k,l]) => (
            <button key={k} onClick={() => setFType(k)} aria-pressed={fType === k}
              style={{ flex:1, height:26, borderRadius:6, border:'none', cursor:'pointer', fontSize:11.5, fontWeight:700,
                backgroundColor: fType === k ? '#fff' : 'transparent', color: fType === k ? C.green : C.gray,
                boxShadow: fType === k ? '0 1px 2px rgba(0,0,0,0.12)' : 'none' }}>{l}</button>
          ))}
        </div>
        <div style={{ position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:13 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Student name or note…" aria-label="Search student name or note"
            style={{ width:'100%', padding:'7px 30px', borderRadius:8, border:`1px solid ${C.border}`, fontSize:13, outline:'none', boxSizing:'border-box', backgroundColor:'#fff' }} />
          {search && <button onClick={() => setSearch('')} aria-label="Clear search" style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)',
            background:'none', border:'none', cursor:'pointer', fontSize:14, color:C.gray }}>✕</button>}
        </div>
      </div>

      {msg && (
        <div style={{ padding:'8px 12px', borderRadius:10, fontSize:12.5, fontWeight:700,
          backgroundColor: msg.startsWith('✔') ? '#dcfce7' : '#fee2e2',
          border: `1px solid ${msg.startsWith('✔') ? '#86efac' : '#fca5a5'}`,
          color: msg.startsWith('✔') ? '#166534' : '#dc2626' }}>{msg}</div>
      )}
      {restricted && linkedIds.length===0 && (
        <div style={{ padding:'8px 12px', borderRadius:10, backgroundColor:'#fef3c7', border:'1px solid #fcd34d', fontSize:12, fontWeight:700, color:'#92400e' }}>
          ⚠ Account not linked to a student — contact the academy
        </div>
      )}

      {/* ── Summary ── */}
      {fetched && filtered.length > 0 && (
        <div style={CARD}>
          <div style={{ display:'flex' }}>{cell(filtered.length,'Items',true)}{cell(photos,'Photos')}{cell(videos,'Videos')}</div>
          <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 10px', borderTop:`1px solid ${C.border}`,
            fontSize:11, color:C.gray, backgroundColor:'#fafafa' }}>
            <span>{fmtDate(from)} – {fmtDate(to)}{filtered.length < items.length ? ` · ${items.length} in range` : ''}</span>
            {!isDefault && <button onClick={resetAll} style={{ background:'none', border:'none', padding:0, color:C.green, fontWeight:800, fontSize:11, cursor:'pointer' }}>Reset filters</button>}
          </div>
        </div>
      )}

      {loading && !fetched && <div style={{ textAlign:'center', padding:'32px 0', color:C.gray, fontSize:13 }}>Loading…</div>}
      {fetched && filtered.length===0 && (
        <div style={{ ...CARD, padding:'26px 16px', textAlign:'center', color:C.gray }}>
          <div style={{ fontSize:30, marginBottom:6 }}>🔍</div>
          <div style={{ fontWeight:800, fontSize:13.5, color:C.text }}>Nothing found</div>
          <div style={{ fontSize:12, marginTop:3 }}>Try a wider date range or clear the filters</div>
          {!isDefault && <button onClick={resetAll} style={{ marginTop:10, padding:'7px 16px', borderRadius:9, border:'none',
            backgroundColor:C.green, color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer' }}>Reset filters</button>}
        </div>
      )}

      {/* ── Grid ── */}
      {filtered.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, opacity: loading ? 0.5 : 1 }}>
          {filtered.map(item => {
            const isVid = item.file_type === 'Video';
            const n = (item.students||[]).length;
            const tg = tagOf(item);
            return (
              <button key={item.media_id} onClick={() => setViewer(item)} aria-label={`${tg} ${isVid ? 'video' : 'photo'}`}
                style={{ position:'relative', width:'100%', padding:'100% 0 0 0', border:'none', borderRadius:8, overflow:'hidden',
                  backgroundColor:'#1f2937', cursor:'pointer' }}>
                {item.secure_url && <img src={thumbUrl(item.secure_url, isVid)} alt="" loading="lazy"
                  style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} />}
                {isVid && <span style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <span style={{ width:28, height:28, borderRadius:'50%', backgroundColor:'rgba(0,0,0,0.55)', color:'#fff', fontSize:11,
                    display:'flex', alignItems:'center', justifyContent:'center', paddingLeft:2 }}>▶</span></span>}
                <span style={{ position:'absolute', left:4, bottom:4, padding:'1px 6px', borderRadius:6, fontSize:9, fontWeight:800, color:'#fff',
                  backgroundColor:(TAG_COLORS[tg] || C.gray) + 'e6' }}>{tg}</span>
                <span style={{ position:'absolute', right:4, top:4, padding:'1px 6px', borderRadius:6, fontSize:9, fontWeight:800, color:'#fff',
                  backgroundColor: n ? 'rgba(0,0,0,0.55)' : 'rgba(180,83,9,0.9)' }}>👤 {n}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Viewer ── */}
      {viewer && (
        <div onClick={() => setViewer(null)} role="dialog" aria-label="Media viewer"
          style={{ position:'fixed', inset:0, zIndex:5000, backgroundColor:'rgba(0,0,0,0.94)', display:'flex', flexDirection:'column',
            paddingTop:'env(safe-area-inset-top)', paddingBottom:'env(safe-area-inset-bottom)' }}>
          <div onClick={e => e.stopPropagation()} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px' }}>
            <button onClick={() => setViewer(null)} aria-label="Close"
              style={{ background:'rgba(255,255,255,0.12)', border:'none', color:'#fff', fontSize:16, borderRadius:8, padding:'6px 11px', cursor:'pointer' }}>✕</button>
            <span style={{ flex:1, color:'rgba(255,255,255,0.6)', fontSize:12, textAlign:'center' }}>{vIdx + 1} / {filtered.length}</span>
            {can('media:upload') && (
              <button onClick={() => { setRetag({ ...viewer, student_ids:(viewer.students||[]).map((t:any) => Number(t.student_id)) }); setViewer(null); }}
                style={{ background:C.gold, border:'none', borderRadius:8, padding:'6px 10px', color:C.green, fontWeight:800, fontSize:12, cursor:'pointer' }}>✏ Re-tag</button>
            )}
            {can('media:delete') && (
              <button onClick={async () => { await del(viewer); setViewer(null); }} aria-label="Delete"
                style={{ background:'rgba(220,38,38,0.85)', border:'none', borderRadius:8, padding:'6px 10px', color:'#fff', fontWeight:800, fontSize:12, cursor:'pointer' }}>🗑</button>
            )}
          </div>
          <div onClick={e => e.stopPropagation()} style={{ flex:1, minHeight:0, display:'flex', alignItems:'center', justifyContent:'center', padding:'0 8px' }}>
            {viewer.file_type === 'Video'
              ? <ZoomableVideo key={viewer.media_id} src={viewer.secure_url} poster={thumbUrl(viewer.secure_url, true, 720)} style={{ borderRadius:10 }} />
              : <ZoomableImage src={viewer.secure_url} style={{ borderRadius:10 }} />}
          </div>
          <div onClick={e => e.stopPropagation()} style={{ padding:'10px 14px 14px', color:'#fff' }}>
            <div style={{ fontSize:12, color:'rgba(255,255,255,0.65)' }}>
              {[tagOf(viewer), fmtDate(viewer.upload_date || viewer.created_at)].join(' · ')}
            </div>
            {viewer.description && <div style={{ fontSize:13.5, marginTop:4 }}>{viewer.description}</div>}
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:8 }}>
              {(viewer.students||[]).length === 0
                ? <span style={{ fontSize:12, color:'#fbbf24' }}>⚠ No students tagged</span>
                : (viewer.students||[]).map((t:any) => (
                    <span key={t.student_id} style={{ fontSize:11.5, fontWeight:700, padding:'2px 9px', borderRadius:10,
                      backgroundColor:'rgba(255,255,255,0.12)', color:'#fff' }}>{t.name || `QCA-${t.student_id}`}</span>
                  ))}
            </div>
            <div style={{ display:'flex', gap:8, marginTop:10 }}>
              <button disabled={vIdx <= 0} onClick={() => setViewer(filtered[vIdx - 1])}
                style={{ flex:1, padding:'9px', borderRadius:9, border:'1px solid rgba(255,255,255,0.2)', background:'rgba(255,255,255,0.08)',
                  color: vIdx <= 0 ? 'rgba(255,255,255,0.3)' : '#fff', fontWeight:700, fontSize:13, cursor: vIdx <= 0 ? 'default' : 'pointer' }}>‹ Previous</button>
              <button disabled={vIdx >= filtered.length - 1} onClick={() => setViewer(filtered[vIdx + 1])}
                style={{ flex:1, padding:'9px', borderRadius:9, border:'none',
                  background: vIdx >= filtered.length - 1 ? 'rgba(255,255,255,0.08)' : C.gold,
                  color: vIdx >= filtered.length - 1 ? 'rgba(255,255,255,0.3)' : C.green, fontWeight:800, fontSize:13,
                  cursor: vIdx >= filtered.length - 1 ? 'default' : 'pointer' }}>Next ›</button>
            </div>
          </div>
        </div>
      )}

      {retag && (
        <TagModal item={{...retag,student_ids:retag.student_ids||[]}}
          students={students} onSave={saveRetag} onClose={() => setRetag(null)} />
      )}
    </div>
  );
}


// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MediaScreen() {
  const location=useLocation();
  const { can } = usePermissions();
  const navState = location.state as any;
  const [tab, setTab] = useState<'capture'|'sync'|'history'>(
    can('media:upload') ? 'capture' : 'history'
  );
  const [students, setStudents] = useState<any[]>([]);
  const [counts,   setCounts]   = useState({pending:0,cld_uploaded:0,error:0,saved:0});

  useEffect(() => { getActiveStudents().then(setStudents); getMediaSyncCounts().then(setCounts); }, []);
  const refresh = () => getMediaSyncCounts().then(setCounts);
  const total   = counts.pending + counts.cld_uploaded + counts.error;

  const TABS: [string,string][] = [
    ...(can('media:upload') ? [['capture','📷 Capture'] as [string,string]] : []),
    ...(can('media:upload') ? [[`sync`,`☁ Sync${total>0?' ('+total+')':''}`] as [string,string]] : []),
    ['history','📂 Gallery'],
  ];
  const subtitle = total === 0
    ? 'Session photos & videos, tagged to students'
    : `${total} waiting to upload${counts.error ? ` · ${counts.error} with errors` : ''}`;

  return (
    <div style={{ backgroundColor:C.bg,minHeight:'100%',fontFamily:'sans-serif',color:C.text,paddingBottom:24 }}>
      <ScreenHeader title="Media Centre" subtitle={subtitle}>
        <HeaderTabs value={tab} onChange={k=>setTab(k as any)} tabs={TABS.map(([id,label])=>({id,label}))} />
      </ScreenHeader>

      {tab==='capture' && <CaptureTab navState={navState} onCaptured={()=>{refresh();setTab('sync');}}/>}
      {tab==='sync'    && <SyncTab students={students} onSynced={refresh}/>}
      {tab==='history' && <HistoryTab students={students}/>}
    </div>
  );
}

function CB(color: string): React.CSSProperties {
  return { flex:1,padding:'11px 8px',borderRadius:11,border:'none',cursor:'pointer',backgroundColor:color,color:'#fff',fontWeight:800,fontSize:13.5 };
}
