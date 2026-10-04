/**
 * Media Centre — /media
 * Capture-first: save blob immediately, tag & upload later.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions, isDataRestricted, getLinkedStudentIds } from './usePermissions';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';
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
const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e0e0e0', gray:'#888', red:'#c0392b', blue:'#2980b9' };
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
function hdrs() {
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
function sName(students: any[], id: any) {
  const n = Number(id);
  return students.find(s => Number(s.id)===n)?.name ?? `QCA-${n}`;
}
function fmtSz(b: number) { return b > 1024*1024 ? `${(b/1024/1024).toFixed(1)} MB` : `${(b/1024).toFixed(0)} KB`; }
function fmtDate(s: string) { return s?.slice(0,10) || '—'; }

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
  const m: Record<string,[string,string]> = { pending:[C.gold,'⏳ Pending'], cld_uploaded:[C.blue,'☁ Uploaded'], saved:['#27ae60','✔ Saved'], error:[C.red,'✖ Error'] };
  const [col,lbl] = m[s]||[C.gray,s];
  return <span style={{ fontSize:11,fontWeight:700,padding:'3px 8px',borderRadius:10,backgroundColor:col+'20',color:col,border:`1px solid ${col}44` }}>{lbl}</span>;
}

// ─── Tag edit modal ───────────────────────────────────────────────────────────
function TagModal({ item, students, onSave, onClose }: { item:any; students:any[]; onSave:(ids:number[],tag:string,note:string)=>void; onClose:()=>void }) {
  const init = (item.student_ids||[]).map(Number).filter((n:number)=>!isNaN(n)&&n>0);
  const [sel, setSel]   = useState<number[]>(init);
  const [tag, setTag]   = useState(item.tag_type||'Training');
  const [note,setNote]  = useState(item.coach_note||'');
  const [q,   setQ]     = useState('');
  const toggle = (id: any) => { const n=Number(id); setSel(p=>p.includes(n)?p.filter(x=>x!==n):[...p,n]); };
  const filt = students.filter(s=>s.name.toLowerCase().includes(q.toLowerCase()) || s.regno?.toLowerCase().includes(q.toLowerCase()) || s.regno?.toLowerCase().includes(q.toLowerCase()));
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
                <div><div style={{ fontSize:13,fontWeight:700,color:on?C.green:'#222' }}>{s.name}</div><div style={{ fontSize:11,color:C.gray }}>{s.level}</div></div>
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
    opfsLoad(fileName).then(blob => {
      setLoading(false);
      if (blob) {
        setBlobUrl(URL.createObjectURL(blob));
        setFileInfo(`📁 ${fileName} · ${fmtSz(blob.size)}`);
      } else {
        setFileInfo(`⚠ File not in device storage: ${fileName}`);
      }
    });
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
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
            <button onClick={()=>onTag(item)} style={{ flex:2,padding:'11px 0',borderRadius:10,border:'none',backgroundColor:C.blue,color:'#fff',fontWeight:700,fontSize:13,cursor:'pointer' }}>✏ Tag Students</button>
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
    <div style={{ padding:'14px 16px 140px' }}>
      {mode==='idle' && (
        <div style={{ display:'flex',gap:8,marginBottom:14 }}>
          <button onClick={startPhoto} style={{ ...CB('#27ae60'),flex:1 }}>📷 Photo</button>
          <button onClick={startVideo} style={{ ...CB(C.blue),flex:1 }}>🎥 Video</button>
          {/* Gallery button — label wraps input for reliable Android tap */}
          <div style={{ ...CB('#8e44ad') as any, flex:1, position:'relative', overflow:'hidden' }}>
            <span style={{pointerEvents:'none'}}>🖼 Gallery</span>
            <input ref={galRef} type="file" accept="image/*,video/*"
              onChange={onGalleryWeb}
              style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',opacity:0.01,cursor:'pointer'}}/>
          </div>
        </div>
      )}

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
                <span style={{ color:'rgba(255,255,255,0.6)',fontSize:11 }}>{fmtSz(recBytes)}/5MB</span>
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
        <div style={{ padding:'10px 14px',borderRadius:10,marginBottom:12,fontSize:13,fontWeight:600,backgroundColor:msg.startsWith('✔')?'#e8f5e9':'#fdecea',color:msg.startsWith('✔')?'#27ae60':C.red }}>{msg}</div>
      ) : null}

      {isPre && (
        <button onClick={doSave} disabled={saving} style={{ width:'100%',padding:16,borderRadius:13,border:'none',backgroundColor:saving?'#ccc':C.green,color:'#fff',fontWeight:800,fontSize:15,cursor:saving?'not-allowed':'pointer' }}>
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

  return (
    <div onClick={onClose} style={{ position:'fixed',inset:0,zIndex:6000,backgroundColor:'rgba(0,0,0,0.85)',display:'flex',alignItems:'flex-end' }}>
      <div onClick={e=>e.stopPropagation()} style={{ backgroundColor:'#0d1f14',width:'100%',maxHeight:'85vh',borderRadius:'20px 20px 0 0',overflowY:'auto',paddingBottom:30 }}>
        {/* Header */}
        <div style={{ padding:'16px 18px',borderRadius:'20px 20px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #1a3a22' }}>
          <div>
            <div style={{ color:'#fff',fontWeight:800,fontSize:16 }}>📦 OPFS Storage Inspector</div>
            <div style={{ color:'#4caf77',fontSize:11,marginTop:2 }}>Origin Private File System — app internal only</div>
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.6)',fontSize:22,cursor:'pointer' }}>✕</button>
        </div>

        <div style={{ padding:'14px 16px 0' }}>
          {/* Storage quota */}
          {estimate && (
            <div style={{ backgroundColor:'#111',borderRadius:10,padding:'10px 14px',marginBottom:14 }}>
              <div style={{ color:'#888',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6 }}>Device Storage</div>
              <div style={{ display:'flex',justifyContent:'space-between',marginBottom:4 }}>
                <span style={{ color:'#aaa',fontSize:12 }}>Used by app</span>
                <span style={{ color:'#4caf77',fontSize:12,fontWeight:700 }}>{fmtSz(estimate.usage)}</span>
              </div>
              <div style={{ display:'flex',justifyContent:'space-between',marginBottom:8 }}>
                <span style={{ color:'#aaa',fontSize:12 }}>Available quota</span>
                <span style={{ color:'#aaa',fontSize:12 }}>{fmtSz(estimate.quota)}</span>
              </div>
              <div style={{ height:6,backgroundColor:'#222',borderRadius:3,overflow:'hidden' }}>
                <div style={{ width:`${Math.min(100, estimate.usage/estimate.quota*100)}%`,height:'100%',backgroundColor:'#27ae60',borderRadius:3 }}/>
              </div>
            </div>
          )}

          {/* How to access note */}
          <div style={{ backgroundColor:'#111',borderRadius:10,padding:'10px 14px',marginBottom:14,borderLeft:`3px solid ${C.gold}` }}>
            <div style={{ color:C.gold,fontSize:11,fontWeight:700,marginBottom:4 }}>ℹ How to access these files</div>
            <div style={{ color:'#888',fontSize:11,lineHeight:1.6 }}>
              OPFS is sandboxed inside the app — not accessible from Android file manager or USB.<br/>
              Files are auto-deleted after successful Cloudinary upload.<br/>
              To inspect manually: use Chrome DevTools → Application → Storage → OPFS<br/>
              (connect phone via USB with USB debugging enabled)
            </div>
          </div>

          {/* File list */}
          <div style={{ color:'#888',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:8 }}>
            Media Files in OPFS ({opfsFiles.length})
          </div>

          {loading && <div style={{ color:'#555',textAlign:'center',padding:20 }}>Scanning storage…</div>}

          {!loading && opfsFiles.length === 0 && (
            <div style={{ color:'#555',textAlign:'center',padding:20,fontSize:12 }}>
              No media files in OPFS.<br/>Files are saved here after capture and deleted after upload.
            </div>
          )}

          {opfsFiles.map(f => {
            const linked = pendingMap[f.name];
            return (
              <div key={f.name} style={{ backgroundColor:'#111',borderRadius:10,padding:'10px 14px',marginBottom:8,borderLeft:`3px solid ${linked?C.gold:'#333'}` }}>
                {/* Filename */}
                <div style={{ fontFamily:'monospace',fontSize:12,color:'#4caf77',marginBottom:4,wordBreak:'break-all' }}>
                  {f.name}
                </div>
                <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center' }}>
                  <span style={{ fontSize:11,color:'#555' }}>{fmtSz(f.size)}</span>
                  {linked ? (
                    <span style={{ fontSize:10,backgroundColor:C.gold+'22',color:C.gold,padding:'2px 8px',borderRadius:6,fontWeight:700 }}>
                      Pending #{linked.id} · {linked.tag_type||'Training'}
                    </span>
                  ) : (
                    <span style={{ fontSize:10,backgroundColor:'#333',color:'#555',padding:'2px 8px',borderRadius:6 }}>
                      Orphaned (no DB row)
                    </span>
                  )}
                </div>
                {linked && (
                  <div style={{ fontSize:10,color:'#555',marginTop:3 }}>
                    Status: {linked.status} · {fmtDate(linked.attendance_date||linked.created_at)}
                  </div>
                )}
              </div>
            );
          })}
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
    if(preview?.id===tagItem.id) setPreview(prev=>prev?{...prev,student_ids:ids,tag_type:tag,coach_note:note}:null);
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

  const pending=items.filter(i=>i.status!=='saved').length;
  const errors =items.filter(i=>i.status==='error').length;

  return (
    <>
    <div style={{ padding:'14px 16px 100px' }}>
      {/* Stats */}
      <div style={{ display:'flex',gap:8,marginBottom:12 }}>
        {([['Pending',items.filter(i=>i.status==='pending').length,C.gold],['Uploaded',items.filter(i=>i.status==='cld_uploaded').length,C.blue],['Error',errors,C.red]] as any[]).map(([l,v,c]:any)=>(
          <div key={l} style={{ flex:1,backgroundColor:'#fff',borderRadius:10,padding:'10px 8px',textAlign:'center',boxShadow:'0 1px 3px rgba(0,0,0,0.08)',borderTop:`3px solid ${c}` }}>
            <div style={{ fontSize:22,fontWeight:900,color:c }}>{v}</div>
            <div style={{ fontSize:10,color:C.gray,fontWeight:700 }}>{l}</div>
          </div>
        ))}
      </div>

      {log.length>0 && (
        <div ref={logRef} style={{ backgroundColor:'#080e0a',borderRadius:10,padding:'10px 14px',fontFamily:'monospace',fontSize:11,color:'#6b8f73',maxHeight:130,overflowY:'auto',marginBottom:12 }}>
          {log.map((l,i)=><div key={i} style={{ marginBottom:2,color:l.includes('✔')?'#4caf77':l.includes('✖')?C.red:l.includes('⚠')?C.gold:'#6b8f73' }}>{l}</div>)}
        </div>
      )}

      <div style={{ display:'flex',gap:8,marginBottom:12 }}>
        <button onClick={runSync} disabled={running||pending===0} style={{ flex:3,padding:14,borderRadius:12,border:'none',backgroundColor:running?'#ccc':pending===0?'#e8f5e9':C.green,color:pending===0?'#27ae60':'#fff',fontWeight:800,fontSize:14,cursor:running||pending===0?'not-allowed':'pointer' }}>
          {running?'⏳ Uploading…':pending===0?'✔ All synced':`▶ Upload ${pending} item${pending>1?'s':''}`}
        </button>
        <button onClick={()=>setShowStorage(true)} style={{ flex:1,padding:14,borderRadius:12,border:`1px solid ${C.border}`,backgroundColor:'#fff',color:C.green,fontWeight:700,fontSize:12,cursor:'pointer' }}>
          📦 Files
        </button>
      </div>

      {/* Hint */}
      {pending>0 && <div style={{ fontSize:12,color:C.gray,textAlign:'center',marginBottom:10 }}>Tap any item to preview, verify and tag students</div>}

      {items.length===0 ? (
        <div style={{ textAlign:'center',padding:'40px 0',color:C.gray }}><div style={{ fontSize:40 }}>📭</div><div style={{ marginTop:8 }}>Nothing queued</div></div>
      ) : items.map(item=>{
        const vIds=(item.student_ids||[]).map(Number).filter((n:number)=>!isNaN(n)&&n>0);
        return (
          <button key={item.id} onClick={()=>setPreview(item)} style={{ display:'block',width:'100%',backgroundColor:'#fff',borderRadius:12,padding:'12px 14px',marginBottom:10,boxShadow:'0 1px 4px rgba(0,0,0,0.08)',borderLeft:`4px solid ${item.status==='error'?C.red:item.status==='cld_uploaded'?C.blue:C.gold}`,border:`none`,cursor:'pointer',textAlign:'left' }}>
            <div style={{ borderLeft:`4px solid ${item.status==='error'?C.red:item.status==='cld_uploaded'?C.blue:C.gold}`,paddingLeft:10,marginLeft:-10,paddingBottom:1 }}>
            <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6 }}>
              <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                <span style={{ fontSize:20 }}>{item.resource_type==='video'?'🎥':'📷'}</span>
                <div>
                  <div style={{ fontWeight:700,fontSize:13 }}>{item.tag_type||'Training'} · {fmtDate(item.attendance_date||item.created_at)}</div>
                  <div style={{ fontSize:11,color:C.gray }}>{fmtSz(item.file_size_bytes)} · tap to preview</div>
                </div>
              </div>
              <SBadge s={item.status} />
            </div>
            <div style={{ display:'flex',flexWrap:'wrap',gap:4 }}>
              {vIds.length===0
                ? <span style={{ fontSize:11,color:C.red,fontWeight:600 }}>⚠ No students — tap to tag</span>
                : vIds.map((id:number)=><span key={id} style={{ fontSize:11,backgroundColor:'#f0f4f0',color:C.green,padding:'2px 8px',borderRadius:8,fontWeight:600 }}>{sName(students,id)}</span>)
              }
            </div>
            {item.error_msg&&<div style={{ fontSize:11,color:C.red,marginTop:4 }}>⚠ {item.error_msg}</div>}
            </div>
          </button>
        );
      })}
    </div>

    {preview && (
      <PreviewModal
        item={preview} students={students}
        onTag={item=>{setTagItem(item);}}
        onDelete={item=>{if(confirm('Remove this item from device?')) removeItem(item);}}
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

  const M = {
    navy:'#001f3f', green:'#1a472a', gold:'#c5a059',
    bg:'#f0f4f1', border:'#e5e7eb', muted:'#6b7280',
  };

  return (
    <div style={{ backgroundColor:M.bg, minHeight:'100%', paddingBottom:80 }}>

      {/* ── Filter panel ── */}
      <div style={{ backgroundColor:'#fff', borderBottom:`1px solid ${M.border}`,
        padding:'14px 16px' }}>

        {/* Date range pickers */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
          <div>
            <div style={{ fontSize:10,fontWeight:800,color:M.muted,
              textTransform:'uppercase' as const,letterSpacing:'0.5px',marginBottom:4 }}>From</div>
            <input type="date" value={from} max={to}
              onChange={e => setFrom(e.target.value)}
              style={{ width:'100%',padding:'9px 10px',borderRadius:10,
                border:`1.5px solid ${M.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const }} />
          </div>
          <div>
            <div style={{ fontSize:10,fontWeight:800,color:M.muted,
              textTransform:'uppercase' as const,letterSpacing:'0.5px',marginBottom:4 }}>To</div>
            <input type="date" value={to} min={from} max={today}
              onChange={e => setTo(e.target.value)}
              style={{ width:'100%',padding:'9px 10px',borderRadius:10,
                border:`1.5px solid ${M.border}`,fontSize:13,outline:'none',
                boxSizing:'border-box' as const }} />
          </div>
        </div>

        {/* Quick range chips — 7d default */}
        <div style={{ display:'flex',gap:6,marginBottom:10 }}>
          {([
            { label:'7d',  days:7  },
            { label:'15d', days:15 },
            { label:'30d', days:30 },
            { label:'90d', days:90 },
          ]).map(({label,days}) => {
            const f = ago(days);
            const active = from===f && to===today;
            return (
              <button key={label} onClick={() => { setFrom(f); setTo(today); }}
                style={{ padding:'5px 14px',borderRadius:20,border:'none',
                  cursor:'pointer',fontSize:11,fontWeight:800,
                  backgroundColor:active ? M.green : '#f3f4f6',
                  color:active ? '#fff' : M.muted,
                  boxShadow:active?'0 2px 6px rgba(26,71,42,0.3)':'none' }}>
                {label}
              </button>
            );
          })}
          {/* Custom badge if not a preset */}
          {![7,15,30,90].some(d=>ago(d)===from&&to===today) && from!==today && (
            <span style={{ padding:'5px 10px',borderRadius:20,
              backgroundColor:'#e0e7ff',color:'#3730a3',
              fontSize:10,fontWeight:700 }}>Custom</span>
          )}
        </div>

        {/* Type filter chips */}
        <div style={{ display:'flex',gap:6,marginBottom:10 }}>
          {([
            { key:'all',   label:'All Types', icon:'' },
            { key:'Photo', label:'Photos',    icon:'📷' },
            { key:'Video', label:'Videos',    icon:'🎥' },
          ] as const).map(t => (
            <button key={t.key} onClick={() => setFType(t.key)}
              style={{ padding:'5px 14px',borderRadius:20,border:'none',
                cursor:'pointer',fontSize:11,fontWeight:800,
                backgroundColor:fType===t.key ? M.navy : '#f3f4f6',
                color:fType===t.key ? '#fff' : M.muted }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Search bar */}
        <div style={{ position:'relative' }}>
          <span style={{ position:'absolute',left:11,top:'50%',
            transform:'translateY(-50%)',fontSize:14,color:M.muted }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search student name or note…"
            style={{ width:'100%',padding:'9px 12px 9px 32px',borderRadius:10,
              border:`1.5px solid ${M.border}`,fontSize:13,outline:'none',
              boxSizing:'border-box' as const,backgroundColor:'#f9fafb' }} />
          {search && (
            <button onClick={() => setSearch('')} style={{ position:'absolute',
              right:10,top:'50%',transform:'translateY(-50%)',
              background:'none',border:'none',cursor:'pointer',
              fontSize:15,color:M.muted }}>✕</button>
          )}
        </div>
      </div>

      {/* ── Action bar ── */}
      <div style={{ display:'flex',gap:8,padding:'12px 16px 0' }}>
        <button onClick={load} disabled={loading}
          style={{ flex:2,padding:'11px',borderRadius:11,border:'none',
            backgroundColor:loading ? '#9ca3af' : M.green,
            color:'#fff',fontWeight:800,fontSize:13,
            cursor:loading?'not-allowed':'pointer',
            boxShadow:loading?'none':'0 2px 8px rgba(26,71,42,0.3)' }}>
          {loading ? '⏳ Loading…' : '🔍 Search Gallery'}
        </button>
        <button onClick={() => {
            setFrom(ago(7)); setTo(today);
            setFType('all'); setSearch('');
            setItems([]); setFetched(false);
          }}
          style={{ flex:1,padding:'11px',borderRadius:11,
            border:`1px solid ${M.border}`,
            backgroundColor:'#fff',color:M.muted,
            fontWeight:700,fontSize:12,cursor:'pointer' }}>
          Reset
        </button>
      </div>

      {/* ── Status message ── */}
      {msg && (
        <div style={{ margin:'10px 16px 0',padding:'10px 14px',borderRadius:11,
          fontSize:13,fontWeight:700,
          backgroundColor:msg.startsWith('✔') ? '#dcfce7':'#fee2e2',
          border:`1px solid ${msg.startsWith('✔')?'#86efac':'#fca5a5'}`,
          color:msg.startsWith('✔') ? '#166534':'#dc2626' }}>
          {msg}
        </div>
      )}

      {/* ── Summary stats (when results loaded) ── */}
      {fetched && filtered.length > 0 && (
        <div style={{ display:'flex',gap:8,padding:'12px 16px 4px' }}>
          <div style={{ flex:1,backgroundColor:'#fff',borderRadius:12,padding:'10px',
            textAlign:'center' as const,border:`1px solid ${M.border}`,
            boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }}>
            <div style={{ fontWeight:900,fontSize:20,color:M.green }}>{filtered.length}</div>
            <div style={{ fontSize:9,color:M.muted,fontWeight:700,
              textTransform:'uppercase' as const,letterSpacing:'0.5px' }}>Total</div>
          </div>
          <div style={{ flex:1,backgroundColor:'#fff',borderRadius:12,padding:'10px',
            textAlign:'center' as const,border:`1px solid ${M.border}`,
            boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }}>
            <div style={{ fontWeight:900,fontSize:20,color:'#0369a1' }}>{photos}</div>
            <div style={{ fontSize:9,color:M.muted,fontWeight:700,
              textTransform:'uppercase' as const,letterSpacing:'0.5px' }}>📷 Photos</div>
          </div>
          <div style={{ flex:1,backgroundColor:'#fff',borderRadius:12,padding:'10px',
            textAlign:'center' as const,border:`1px solid ${M.border}`,
            boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }}>
            <div style={{ fontWeight:900,fontSize:20,color:'#7c3aed' }}>{videos}</div>
            <div style={{ fontSize:9,color:M.muted,fontWeight:700,
              textTransform:'uppercase' as const,letterSpacing:'0.5px' }}>🎥 Videos</div>
          </div>
        </div>
      )}

      {/* Results count */}
      {fetched && (
        <div style={{ padding:'6px 16px 8px',fontSize:12,color:M.muted }}>
          {filtered.length} of {items.length} item{items.length!==1?'s':''}
          {search && ` · "${search}"`}
          {fType!=='all' && ` · ${fType}s only`}
        </div>
      )}

      {/* ── Empty states ── */}
      {!fetched && !loading && (
        <div style={{ textAlign:'center',padding:'48px 20px',color:M.muted }}>
          <div style={{ fontSize:48,marginBottom:12 }}>📂</div>
          <div style={{ fontWeight:800,fontSize:15,color:'#111',marginBottom:6 }}>Media Gallery</div>
          <div style={{ fontSize:13,lineHeight:1.7,color:M.muted }}>
            Showing last 7 days by default.<br/>
            Use quick chips or date range to explore further.
          </div>
          {restricted && linkedIds.length===0 && (
            <div style={{ marginTop:16,padding:'12px 14px',borderRadius:11,
              backgroundColor:'#fef3c7',border:'1px solid #fcd34d',
              fontSize:12,fontWeight:700,color:'#92400e' }}>
              ⚠ Account not linked — contact admin
            </div>
          )}
        </div>
      )}
      {fetched && filtered.length===0 && (
        <div style={{ textAlign:'center',padding:'40px 20px',color:M.muted }}>
          <div style={{ fontSize:40,marginBottom:8 }}>🔍</div>
          <div style={{ fontWeight:800,fontSize:15,color:'#111',marginBottom:6 }}>No media found</div>
          <div style={{ fontSize:13 }}>Try a wider date range or clear filters</div>
          <button onClick={() => { setSearch(''); setFType('all'); }}
            style={{ marginTop:12,padding:'8px 20px',borderRadius:20,border:'none',
              backgroundColor:M.navy,color:M.gold,fontWeight:700,
              fontSize:12,cursor:'pointer' }}>
            Clear Filters
          </button>
        </div>
      )}

      {/* ── Media grid ── */}
      <div style={{ padding:'4px 16px 0' }}>
        {filtered.map(item => (
          <div key={item.media_id} style={{ backgroundColor:'#fff',borderRadius:16,
            marginBottom:14,boxShadow:'0 2px 12px rgba(0,0,0,0.07)',overflow:'hidden',
            border:`1px solid ${M.border}` }}>

            {/* Media preview */}
            {item.file_type==='Photo' && item.secure_url && (
              <div style={{ position:'relative' }}>
                <img src={item.secure_url} alt=""
                  style={{ width:'100%',height:210,objectFit:'cover',display:'block' }} />
                <div style={{ position:'absolute',top:10,left:10,
                  backgroundColor:'rgba(0,0,0,0.55)',borderRadius:8,
                  padding:'3px 10px',fontSize:11,fontWeight:800,color:'#fff' }}>
                  📷 Photo
                </div>
              </div>
            )}
            {item.file_type==='Video' && item.secure_url && (
              <div style={{ position:'relative' }}>
                <video src={item.secure_url} controls playsInline
                  style={{ width:'100%',height:210,objectFit:'cover',
                    display:'block',backgroundColor:'#000' }} />
                <div style={{ position:'absolute',top:10,left:10,
                  backgroundColor:'rgba(0,0,0,0.55)',borderRadius:8,
                  padding:'3px 10px',fontSize:11,fontWeight:800,color:'#fff' }}>
                  🎥 Video
                </div>
              </div>
            )}

            {/* Info section */}
            <div style={{ padding:'12px 14px 14px' }}>
              {/* Header row */}
              <div style={{ display:'flex',justifyContent:'space-between',
                alignItems:'center',marginBottom:8 }}>
                <div>
                  <div style={{ fontWeight:800,fontSize:14,color:'#111' }}>
                    {item.students?.[0]?.tag_type || item.tag_type || 'Training'}
                  </div>
                  <div style={{ fontSize:11,color:M.muted,marginTop:2 }}>
                    {fmtDate(item.upload_date || item.created_at)}
                  </div>
                </div>
                {item.description && (
                  <div style={{ fontSize:11,color:M.muted,maxWidth:130,
                    overflow:'hidden',textOverflow:'ellipsis',
                    whiteSpace:'nowrap' as const,
                    backgroundColor:'#f3f4f6',padding:'3px 8px',borderRadius:6 }}>
                    {item.description}
                  </div>
                )}
              </div>

              {/* Student tags */}
              <div style={{ display:'flex',flexWrap:'wrap' as const,gap:5,marginBottom:12 }}>
                {(item.students||[]).length===0
                  ? <span style={{ fontSize:11,color:M.muted,fontStyle:'italic' }}>
                      No students tagged
                    </span>
                  : (item.students||[]).map((t:any) => (
                      <span key={t.student_id} style={{ fontSize:11,
                        backgroundColor:'#f0fdf4',color:M.green,
                        padding:'3px 10px',borderRadius:20,fontWeight:700,
                        border:'1px solid #86efac' }}>
                        {t.name || `QCA-${t.student_id}`}
                      </span>
                    ))
                }
              </div>

              {/* Action buttons */}
              {can('media:upload') && (
                <div style={{ display:'flex',gap:8 }}>
                  <button
                    onClick={() => setRetag({
                      ...item,
                      student_ids:(item.students||[]).map((t:any) => Number(t.student_id))
                    })}
                    style={{ flex:1,padding:'9px',borderRadius:10,
                      border:`1px solid ${M.navy}33`,
                      backgroundColor:`${M.navy}08`,
                      color:M.navy,fontWeight:700,fontSize:12,cursor:'pointer' }}>
                    ✏ Re-tag
                  </button>
                  {can('media:delete') && (
                    <button onClick={() => del(item)}
                      style={{ flex:1,padding:'9px',borderRadius:10,
                        border:'1px solid #fca5a5',backgroundColor:'#fee2e2',
                        color:'#dc2626',fontWeight:700,fontSize:12,cursor:'pointer' }}>
                      🗑 Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {retag && (
        <TagModal item={{...retag,student_ids:retag.student_ids||[]}}
          students={students} onSave={saveRetag} onClose={() => setRetag(null)} />
      )}
    </div>
  );
}


// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MediaScreen() {
  const navigate=useNavigate();
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

  return (
    <div style={{ backgroundColor:C.bg,minHeight:'100vh',fontFamily:'sans-serif',paddingBottom:40 }}>

      {/* ── Header (pinned): title + tabs ── */}
      <ScreenHeader title="📷 Media Centre" subtitle="Photos · Videos · Session Gallery"
        background={`linear-gradient(135deg,#001f3f 0%,${C.green} 100%)`}
        actions={total>0 ? (
          <div style={{ backgroundColor:'#c0392b',color:'#fff',borderRadius:20,
            padding:'4px 10px',fontSize:12,fontWeight:800,marginRight:8,
            boxShadow:'0 2px 8px rgba(192,57,43,0.5)' }}>
            {total} pending
          </div>
        ) : undefined}>
        <HeaderTabs value={tab} onChange={k=>setTab(k as any)} tabs={TABS.map(([id,label])=>({id,label}))} />
      </ScreenHeader>

      {/* Stats — scroll away under the pinned header */}
      <div style={{ background:`linear-gradient(135deg,#001f3f 0%,${C.green} 100%)`,paddingBottom:6 }}>
        <div style={{ display:'flex',gap:0,padding:'2px 16px 0' }}>
          {[
            { label:'Pending',  value:counts.pending,      color:'#f59e0b' },
            { label:'Uploaded', value:counts.cld_uploaded, color:'#3b82f6' },
            { label:'Saved',    value:counts.saved,        color:'#22c55e' },
            { label:'Errors',   value:counts.error,        color:C.red     },
          ].map((s,i)=>(
            <div key={s.label} style={{ flex:1,textAlign:'center' as const,
              padding:'8px 4px',
              borderRight:i<3?'1px solid rgba(255,255,255,0.1)':'none' }}>
              <div style={{ color:s.value>0?s.color:'rgba(255,255,255,0.3)',
                fontWeight:900,fontSize:18 }}>{s.value}</div>
              <div style={{ color:'rgba(255,255,255,0.45)',fontSize:9,
                fontWeight:700,textTransform:'uppercase' as const,
                letterSpacing:'0.5px',marginTop:1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ backgroundColor:C.bg }}>
        {tab==='capture' && <CaptureTab navState={navState} onCaptured={()=>{refresh();setTab('sync');}}/>}
        {tab==='sync'    && <SyncTab students={students} onSynced={refresh}/>}
        {tab==='history' && <HistoryTab students={students}/>}
      </div>
    </div>
  );
}

function CB(color: string): React.CSSProperties {
  return { flex:1,padding:'14px 8px',borderRadius:12,border:`1.5px solid ${color}44`,cursor:'pointer',backgroundColor:color+'18',color,fontWeight:800,fontSize:13 };
}
