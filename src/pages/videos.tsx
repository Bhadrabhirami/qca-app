/**
 * videos.tsx — QCA Academy YouTube Channel
 * Offline-first. Full sync of all channel videos locally.
 * Tabs: Featured · Popular · Newest · Search
 * Player: inline YouTube embed with share + favourite
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getYoutubeVideos, countYoutubeVideos, upsertYoutubeVideos,
  syncYoutubeFromServer, ytMinutesSinceSync,
} from '../database/db';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';

const C = {
  green:'#1a472a', gold:'#d4af37', red:'#ff0000',
  navy:'#0d1b2a', bg:'#f0f4f1', card:'#fff',
  border:'#e5e7eb', muted:'#6b7280',
};
const PAGE = 12;
type Sort = 'popular'|'newest'|'featured';

function bld(ip:string){const h=(ip||'').trim().replace(/\/+$/,'');return h.startsWith('http')?h:`http://${h}`;}
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
function ytId(url:string):string{if(!url)return'';for(const p of[/youtu\.be\/([^?&#/]+)/,/[?&]v=([^?&#/]+)/,/\/embed\/([^?&#/]+)/,/\/shorts\/([^?&#/]+)/]){const m=url.match(p);if(m?.[1])return m[1];}return'';}
function fmtViews(n:number):string{if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'K';return String(n);}
function fmtDate(s:string):string{if(!s)return'';try{return new Date(s).toLocaleDateString('en-GB',{month:'short',year:'numeric'});}catch{return s;}}

// ─── Paginator ────────────────────────────────────────────────────────────────
function Pager({page,pages,onP,onN}:{page:number;pages:number;onP:()=>void;onN:()=>void}){
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,padding:'16px 0'}}>
      <button onClick={onP} disabled={page<=1} style={{padding:'8px 20px',borderRadius:9,border:`1px solid ${C.border}`,backgroundColor:page<=1?'#f3f4f6':C.green,color:page<=1?C.muted:'#fff',fontWeight:700,fontSize:13,cursor:page<=1?'default':'pointer'}}>← Prev</button>
      <span style={{fontSize:13,color:C.muted,minWidth:80,textAlign:'center'as const}}>{page} / {pages}</span>
      <button onClick={onN} disabled={page>=pages} style={{padding:'8px 20px',borderRadius:9,border:`1px solid ${C.border}`,backgroundColor:page>=pages?'#f3f4f6':C.green,color:page>=pages?C.muted:'#fff',fontWeight:700,fontSize:13,cursor:page>=pages?'default':'pointer'}}>Next →</button>
    </div>
  );
}

// ─── Video card ───────────────────────────────────────────────────────────────
function VCard({item,onOpen}:{item:any;onOpen:()=>void}){
  const [imgErr,setImgErr]=useState(false);
  const thumb=!imgErr&&item.thumbnail_url?item.thumbnail_url:'';
  const id=ytId('https://youtube.com/watch?v='+item.video_id);
  const autoThumb=`https://img.youtube.com/vi/${item.video_id}/mqdefault.jpg`;
  const src=thumb||autoThumb;
  return(
    <div onClick={onOpen} style={{backgroundColor:C.card,borderRadius:14,overflow:'hidden',cursor:'pointer',border:`1px solid ${C.border}`,boxShadow:'0 2px 8px rgba(0,0,0,0.06)'}}>
      {/* Thumbnail */}
      <div style={{position:'relative',width:'100%',paddingTop:'56.25%',backgroundColor:'#1a1a2e',overflow:'hidden'}}>
        <img src={src} alt={item.title} onError={()=>setImgErr(true)} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}}/>
        {/* Gradient */}
        <div style={{position:'absolute',inset:0,background:'linear-gradient(to top,rgba(0,0,0,0.7) 0%,transparent 50%)'}}/>
        {/* Play button */}
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <div style={{width:50,height:50,borderRadius:'50%',backgroundColor:'rgba(255,0,0,0.9)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 4px 16px rgba(0,0,0,0.4)'}}>
            <span style={{color:'#fff',fontSize:22,marginLeft:4}}>▶</span>
          </div>
        </div>
        {/* Popular badge */}
        {item.is_popular?<div style={{position:'absolute',top:8,left:8,backgroundColor:C.gold,color:C.navy,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:800}}>🔥 Popular</div>:null}
        {/* Views */}
        {item.view_count>0&&<div style={{position:'absolute',bottom:8,right:8,backgroundColor:'rgba(0,0,0,0.7)',color:'#fff',padding:'2px 7px',borderRadius:6,fontSize:10,fontWeight:700}}>👁 {fmtViews(item.view_count)}</div>}
      </div>
      {/* Info */}
      <div style={{padding:'10px 12px 12px'}}>
        <div style={{fontWeight:700,fontSize:13,color:C.navy,lineHeight:1.4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'as const}}>{item.title}</div>
        {item.published_at&&<div style={{fontSize:11,color:C.muted,marginTop:4}}>📅 {fmtDate(item.published_at)}</div>}
      </div>
    </div>
  );
}

// ─── Player ───────────────────────────────────────────────────────────────────
function Player({item,onClose,onNext,onPrev}:{item:any;onClose:()=>void;onNext?:()=>void;onPrev?:()=>void}){
  const src=`https://www.youtube-nocookie.com/embed/${item.video_id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  const ytUrl=`https://www.youtube.com/watch?v=${item.video_id}`;
  return(
    <div style={{position:'fixed',inset:0,zIndex:4000,backgroundColor:'#000',display:'flex',flexDirection:'column'}}>
      {/* Header */}
      <div style={{padding:'calc(10px + env(safe-area-inset-top, 0px)) 16px 10px',backgroundColor:C.navy,display:'flex',alignItems:'flex-start',gap:12,flexShrink:0}}>
        <button onClick={onClose} style={{background:'rgba(255,255,255,0.1)',border:'none',color:'#fff',fontSize:20,cursor:'pointer',borderRadius:8,padding:'6px 12px',lineHeight:1,flexShrink:0}}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:'#fff',fontWeight:800,fontSize:14,lineHeight:1.4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'as const}}>{item.title}</div>
          {item.published_at&&<div style={{color:'rgba(255,255,255,0.5)',fontSize:11,marginTop:2}}>{fmtDate(item.published_at)}</div>}
        </div>
        {/* YouTube link */}
        <a href={ytUrl} target="_blank" rel="noreferrer" style={{background:'rgba(255,0,0,0.8)',border:'none',color:'#fff',fontSize:11,fontWeight:800,borderRadius:6,padding:'5px 8px',textDecoration:'none',flexShrink:0}}>YT ↗</a>
      </div>
      {/* Player */}
      <div style={{width:'100%',paddingTop:'56.25%',position:'relative',backgroundColor:'#000',flexShrink:0}}>
        <iframe src={src} title={item.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{position:'absolute',inset:0,width:'100%',height:'100%',border:'none'}}/>
      </div>
      {/* Description + nav */}
      <div style={{flex:1,overflowY:'auto',backgroundColor:C.navy,padding:'16px 18px'}}>
        {item.view_count>0&&<div style={{color:C.gold,fontWeight:700,fontSize:13,marginBottom:10}}>👁 {fmtViews(item.view_count)} views</div>}
        {item.description&&<p style={{color:'rgba(255,255,255,0.75)',fontSize:13,lineHeight:1.8}}>{item.description}</p>}
        {/* Prev / Next nav */}
        {(onPrev||onNext)&&(
          <div style={{display:'flex',gap:10,marginTop:20}}>
            {onPrev&&<button onClick={onPrev} style={{flex:1,padding:'11px',borderRadius:10,backgroundColor:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.15)',color:'#fff',fontWeight:700,fontSize:13,cursor:'pointer'}}>← Previous</button>}
            {onNext&&<button onClick={onNext} style={{flex:1,padding:'11px',borderRadius:10,backgroundColor:C.green,border:'none',color:'#fff',fontWeight:700,fontSize:13,cursor:'pointer'}}>Next →</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Video grid tab ───────────────────────────────────────────────────────────
function VideoGrid({sort,onPlay}:{sort:Sort;onPlay:(item:any,list:any[])=>void}){
  const [items,setItems]=useState<any[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const base=bld(localStorage.getItem('server_ip')??'');

  // Smart latest-check: fetch only 5 newest from server, upsert if changed
  const checkLatest=useCallback(async()=>{
    try{
      const r=await fetch(`${base}/api/data/videos?sort=newest&limit=5&offset=0`,{headers:hdr()});
      if(!r.ok)return false;
      const j=await r.json();
      if(!j.data?.length)return false;
      await upsertYoutubeVideos(j.data);
      return true;
    }catch{return false;}
  },[base]);

  const load=useCallback(async(p:number,silent=false)=>{
    if(!silent)setLoading(true);setError('');
    try{
      const cnt=await countYoutubeVideos();
      if(cnt>0){
        const local=await getYoutubeVideos(sort,PAGE,(p-1)*PAGE);
        setItems(local);setTotal(cnt);setPage(p);setLoading(false);
        // Check latest 5 in background — only refresh UI if something new
        checkLatest().then(async(changed)=>{
          if(changed){
            const f=await getYoutubeVideos(sort,PAGE,(p-1)*PAGE);
            const c=await countYoutubeVideos();
            setItems(f);setTotal(c);
          }
        });
        return;
      }
      // No local — full fetch
      const r=await fetch(`${base}/api/data/videos?sort=${sort}&limit=${PAGE}&offset=${(p-1)*PAGE}`,{headers:hdr()});
      if(!r.ok){setError(`Error ${r.status}`);return;}
      const j=await r.json();
      if(j.data?.length)await upsertYoutubeVideos(j.data);
      const fresh=await getYoutubeVideos(sort,PAGE,(p-1)*PAGE);
      const cnt2=await countYoutubeVideos();
      setItems(fresh);setTotal(cnt2);setPage(p);
    }catch{setError('Could not connect');}
    finally{setLoading(false);}
  },[sort,base,checkLatest]);

  // Auto check latest every 60 min
  const lastVideoSync=useRef(0);
  useEffect(()=>{
    load(1);
    lastVideoSync.current=Date.now();
    const id=setInterval(()=>{
      if(Date.now()-lastVideoSync.current>60*60*1000){
        checkLatest().then(async(changed)=>{
          if(changed){
            const f=await getYoutubeVideos(sort,PAGE,0);
            const c=await countYoutubeVideos();
            setItems(f);setTotal(c);
          }
          lastVideoSync.current=Date.now();
        });
      }
    },60*1000);
    return()=>clearInterval(id);
  },[sort,load,checkLatest]);
  const pages=Math.ceil(total/PAGE);

  if(loading)return<div style={{padding:'60px 0',textAlign:'center',color:C.muted}}><div style={{fontSize:32,marginBottom:8}}>⏳</div><div style={{fontWeight:700}}>Loading videos…</div></div>;
  if(error)return<div style={{padding:'16px',margin:'16px',borderRadius:10,backgroundColor:'#fef3c7',border:'1px solid #fcd34d'}}><div style={{fontWeight:700,color:'#92400e'}}>⚠ {error}</div></div>;
  if(!items.length)return<div style={{padding:'60px 20px',textAlign:'center',color:C.muted}}><div style={{fontSize:48,marginBottom:12}}>📺</div><div style={{fontWeight:800,fontSize:15,color:C.navy,marginBottom:6}}>No videos yet</div><div style={{fontSize:13}}>Academy channel videos will appear here</div></div>;

  return(
    <div style={{padding:'14px 16px 0'}}>
      <div style={{fontSize:12,color:C.muted,marginBottom:12}}>{total} videos</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        {items.map((item,i)=><VCard key={item.video_id??i} item={item} onOpen={()=>onPlay(item,items)}/>)}
      </div>
      {pages>1&&<Pager page={page} pages={pages} onP={()=>load(page-1)} onN={()=>load(page+1)}/>}
    </div>
  );
}

// ─── Search tab ───────────────────────────────────────────────────────────────
function SearchTab({onPlay}:{onPlay:(item:any)=>void}){
  const [q,setQ]=useState('');
  const [results,setResults]=useState<any[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const timer=useRef<any>(null);
  const base=bld(localStorage.getItem('server_ip')??'');

  const search=useCallback(async(query:string,p:number)=>{
    if(!query.trim()){setResults([]);setTotal(0);return;}
    setLoading(true);
    try{
      const cnt=await countYoutubeVideos(query);
      if(cnt>0){const local=await getYoutubeVideos('popular',PAGE,(p-1)*PAGE,query);setResults(local);setTotal(cnt);setPage(p);setLoading(false);return;}
      const ps=new URLSearchParams({search:query.trim(),limit:String(PAGE),offset:String((p-1)*PAGE)});
      const r=await fetch(`${base}/api/data/videos?${ps}`,{headers:hdr()});
      if(r.ok){const j=await r.json();setResults(j.data||[]);setTotal(j.total??0);setPage(p);if(j.data?.length)await upsertYoutubeVideos(j.data);}
    }catch{}
    finally{setLoading(false);}
  },[base]);

  const handleInput=(v:string)=>{setQ(v);setPage(1);clearTimeout(timer.current);if(!v.trim()){setResults([]);setTotal(0);return;}timer.current=setTimeout(()=>search(v,1),400);};
  const pages=Math.ceil(total/PAGE);

  return(
    <div style={{padding:'14px 16px 0'}}>
      <div style={{position:'relative',marginBottom:14}}>
        <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',fontSize:16}}>🔍</span>
        <input autoFocus value={q} onChange={e=>handleInput(e.target.value)} placeholder="Search academy videos…" style={{width:'100%',padding:'11px 14px 11px 38px',borderRadius:12,border:`1.5px solid ${C.border}`,fontSize:14,outline:'none',boxSizing:'border-box'as const,backgroundColor:'#fff'}}/>
        {q&&<button onClick={()=>handleInput('')} style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.muted}}>✕</button>}
      </div>
      {!q&&<div style={{textAlign:'center',padding:'48px 0',color:C.muted}}><div style={{fontSize:36,marginBottom:10}}>🔍</div><div style={{fontWeight:700,fontSize:14}}>Search academy videos</div><div style={{fontSize:12,marginTop:4}}>Matches, highlights, training, events</div></div>}
      {loading&&<div style={{textAlign:'center',padding:'32px 0',color:C.muted}}>Searching…</div>}
      {!loading&&q&&results.length===0&&<div style={{textAlign:'center',padding:'40px 0',color:C.muted}}><div style={{fontSize:32,marginBottom:8}}>📭</div>No results for "{q}"</div>}
      {/* Text list — no images in search */}
      {!loading&&results.map((item,i)=>(
        <div key={item.video_id??i} onClick={()=>onPlay(item)} style={{backgroundColor:C.card,borderRadius:10,padding:'12px 14px',marginBottom:8,cursor:'pointer',border:`1px solid ${C.border}`,display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:40,height:40,borderRadius:8,flexShrink:0,backgroundColor:C.red,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'#fff',fontSize:16,marginLeft:3}}>▶</span></div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13,color:C.navy,lineHeight:1.35,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'as const}}>{item.title}</div>
            <div style={{display:'flex',gap:8,marginTop:3}}>
              {item.view_count>0&&<span style={{fontSize:11,color:C.muted}}>👁 {fmtViews(item.view_count)}</span>}
              {item.published_at&&<span style={{fontSize:11,color:C.muted}}>📅 {fmtDate(item.published_at)}</span>}
              {item.is_popular?<span style={{fontSize:10,fontWeight:700,color:C.gold}}>🔥</span>:null}
            </div>
          </div>
          <span style={{color:C.muted,fontSize:18}}>›</span>
        </div>
      ))}
      {!loading&&pages>1&&<Pager page={page} pages={pages} onP={()=>search(q,page-1)} onN={()=>search(q,page+1)}/>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const TABS:[Sort|'search', string, string][]=[
  ['popular','🔥','Popular'],
  ['featured','⭐','Featured'],
  ['newest','🆕','Newest'],
  ['search','🔍','Search'],
];

export default function VideosScreen(){
  const navigate=useNavigate();
  const [tab,setTab]=useState<Sort|'search'>('popular');
  const [playing,setPlaying]=useState<any|null>(null);
  const [playlist,setPlaylist]=useState<any[]>([]);
  const [syncStatus,setSyncStatus]=useState<'idle'|'syncing'|'done'>('idle');
  const [syncProg,setSyncProg]=useState({fetched:0,total:0});
  const base=bld(localStorage.getItem('server_ip')??'');

  // Background sync on mount
  useEffect(()=>{
    if(ytMinutesSinceSync()<60)return;
    setSyncStatus('syncing');
    syncYoutubeFromServer(base,hdr(),'popular',(f,t)=>setSyncProg({fetched:f,total:t}))
      .then(({fetched,total})=>{setSyncProg({fetched,total});setSyncStatus('done');setTimeout(()=>setSyncStatus('idle'),4000);})
      .catch(()=>setSyncStatus('idle'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const handlePlay=(item:any,list:any[]=[])=>{setPlaying(item);setPlaylist(list);};

  const handleRefresh=()=>{
    if(syncStatus==='syncing')return;
    setSyncStatus('syncing');
    setSyncProg({fetched:0,total:0});
    syncYoutubeFromServer(base,hdr(),'popular',(f,t)=>setSyncProg({fetched:f,total:t}))
      .then(({fetched,total})=>{
        setSyncProg({fetched,total});
        setSyncStatus('done');
        setTimeout(()=>setSyncStatus('idle'),3000);
        window.dispatchEvent(new CustomEvent('videos-refreshed'));
      })
      .catch(()=>setSyncStatus('idle'));
  };
  const idx=playing?playlist.findIndex(v=>v.video_id===playing.video_id):-1;
  const hasNext=idx>=0&&idx<playlist.length-1;
  const hasPrev=idx>0;

  return(
    <>
    <div style={{backgroundColor:C.bg,minHeight:'100vh',paddingBottom:16}}>
      <ScreenHeader background={C.navy}
        title={<span style={{display:'inline-flex',alignItems:'center',gap:8}}>
          <span style={{width:24,height:24,backgroundColor:C.red,borderRadius:6,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'#fff',fontSize:12,marginLeft:2}}>▶</span></span>
          QCA Channel
        </span>}
        subtitle={syncStatus==='syncing'
          ?`⟳ Syncing… ${syncProg.fetched}${syncProg.total>0?' / '+syncProg.total:''}`
          :syncStatus==='done'
          ?`✔ ${syncProg.fetched} videos synced`
          :'Academy · Matches · Highlights · Training'}
        actions={<HeaderIconButton label="Sync videos" onClick={handleRefresh} disabled={syncStatus==='syncing'}>
          {syncStatus==='syncing'?'⟳':syncStatus==='done'?'✔':'↻'}
        </HeaderIconButton>}>
        <HeaderTabs color={C.navy} value={tab} onChange={setTab} tabs={TABS.map(([id,icon,label])=>({id,label:`${icon} ${label}`}))} />
      </ScreenHeader>
      {/* Content */}
      {tab==='search'
        ?<SearchTab onPlay={item=>handlePlay(item)}/>
        :<VideoGrid sort={tab} onPlay={handlePlay}/>}
    </div>
    {/* Player */}
    {playing&&(
      <Player
        item={playing}
        onClose={()=>{setPlaying(null);setPlaylist([]);}}
        onNext={hasNext?()=>setPlaying(playlist[idx+1]):undefined}
        onPrev={hasPrev?()=>setPlaying(playlist[idx-1]):undefined}
      />
    )}
    </>
  );
}
