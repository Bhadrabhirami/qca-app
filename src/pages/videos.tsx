/**
 * videos.tsx — QCA Academy YouTube Channel
 * Offline-first. Full sync of all channel videos locally.
 * Tabs: Popular · Featured · Newest · Search
 * Player: inline YouTube embed, open on YouTube, previous / next
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getYoutubeVideos, countYoutubeVideos, upsertYoutubeVideos,
  syncYoutubeFromServer, ytMinutesSinceSync,
} from '../database/db';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';

const C = {
  green:'#1a472a', gold:'#d4af37', yt:'#ff0000', bg:'#f4f7f6',
  card:'#fff', border:'#e8e8e8', muted:'#6b7280', text:'#1f2937',
};
const CARD: React.CSSProperties = { backgroundColor:C.card, borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const PAGE = 12;
type Sort = 'popular'|'newest'|'featured';

function bld(ip:string){const h=(ip||'').trim().replace(/\/+$/,'');return h.startsWith('http')?h:`http://${h}`;}
function hdr(): Record<string,string> {
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
  return { 'Content-Type':'application/json', 'X-Username': localStorage.getItem('auth_user') ?? '' };
}
function fmtViews(n:number):string{if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'K';return String(n);}
function fmtDate(s:string):string{if(!s)return'';const d=new Date(s);return isNaN(d.getTime())?s:d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});}
const thumbOf=(item:any)=>item.thumbnail_url||`https://img.youtube.com/vi/${item.video_id}/mqdefault.jpg`;

// ─── Small pieces ─────────────────────────────────────────────────────────────
const Spinner = () => <div style={{textAlign:'center',padding:'40px 0',color:C.muted,fontSize:13}}>Loading videos…</div>;
const Empty = ({ icon, title, sub }: { icon:string; title:string; sub?:string }) => (
  <div style={{...CARD,padding:'28px 16px',textAlign:'center',color:C.muted}}>
    <div style={{fontSize:30,marginBottom:6}}>{icon}</div>
    <div style={{fontWeight:800,fontSize:13.5,color:C.text}}>{title}</div>
    {sub&&<div style={{fontSize:12,marginTop:3}}>{sub}</div>}
  </div>
);
function Pager({page,pages,onP,onN}:{page:number;pages:number;onP:()=>void;onN:()=>void}){
  const btn=(on:boolean):React.CSSProperties=>({width:40,height:32,borderRadius:9,border:`1px solid ${C.border}`,fontSize:16,fontWeight:800,
    backgroundColor:on?C.green:'#f3f4f6',color:on?'#fff':'#c0c4cc',cursor:on?'pointer':'default'});
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:12,padding:'4px 0'}}>
      <button aria-label="Previous page" onClick={onP} disabled={page<=1} style={btn(page>1)}>‹</button>
      <span style={{fontSize:12.5,color:C.muted,fontWeight:700,minWidth:70,textAlign:'center'}}>Page {page} / {pages}</span>
      <button aria-label="Next page" onClick={onN} disabled={page>=pages} style={btn(page<pages)}>›</button>
    </div>
  );
}

// ─── Video card (grid) ────────────────────────────────────────────────────────
function VCard({item,onOpen}:{item:any;onOpen:()=>void}){
  const [imgErr,setImgErr]=useState(false);
  return(
    <button onClick={onOpen} style={{...CARD,padding:0,cursor:'pointer',textAlign:'left',display:'flex',flexDirection:'column'}}>
      <div style={{position:'relative',width:'100%',paddingTop:'56.25%',backgroundColor:'#e5e7eb'}}>
        {!imgErr&&<img src={thumbOf(item)} alt="" loading="lazy" onError={()=>setImgErr(true)} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}}/>}
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <div style={{width:34,height:24,borderRadius:7,backgroundColor:'rgba(255,0,0,0.9)',display:'flex',alignItems:'center',justifyContent:'center'}}>
            <span style={{color:'#fff',fontSize:11,marginLeft:2}}>▶</span>
          </div>
        </div>
        {item.is_popular?<span style={{position:'absolute',top:6,left:6,backgroundColor:C.gold,color:C.green,padding:'1px 6px',borderRadius:6,fontSize:9.5,fontWeight:900}}>🔥 Popular</span>:null}
        {item.view_count>0&&<span style={{position:'absolute',bottom:5,right:5,backgroundColor:'rgba(0,0,0,0.7)',color:'#fff',padding:'1px 6px',borderRadius:5,fontSize:9.5,fontWeight:700}}>{fmtViews(item.view_count)} views</span>}
      </div>
      <div style={{padding:'7px 9px 8px'}}>
        <div style={{fontWeight:700,fontSize:12.5,color:C.text,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{item.title}</div>
        {item.published_at&&<div style={{fontSize:10.5,color:C.muted,marginTop:3}}>{fmtDate(item.published_at)}</div>}
      </div>
    </button>
  );
}

// ─── Video row (search results) ───────────────────────────────────────────────
function VRow({item,onOpen,first}:{item:any;onOpen:()=>void;first:boolean}){
  const [imgErr,setImgErr]=useState(false);
  return(
    <button onClick={onOpen} style={{width:'100%',display:'flex',alignItems:'center',gap:10,padding:'8px 12px',background:'none',border:'none',
      borderTop:first?'none':`1px solid ${C.border}`,cursor:'pointer',textAlign:'left'}}>
      <div style={{width:72,height:41,borderRadius:7,flexShrink:0,backgroundColor:'#e5e7eb',overflow:'hidden',position:'relative'}}>
        {!imgErr&&<img src={thumbOf(item)} alt="" loading="lazy" onError={()=>setImgErr(true)} style={{width:'100%',height:'100%',objectFit:'cover'}}/>}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:13,color:C.text,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{item.title}</div>
        <div style={{fontSize:10.5,color:C.muted,marginTop:3}}>
          {[item.view_count>0?`${fmtViews(item.view_count)} views`:'', item.published_at?fmtDate(item.published_at):''].filter(Boolean).join(' · ')}
          {item.is_popular?<span style={{color:'#a8862a',fontWeight:800}}> · 🔥</span>:null}
        </div>
      </div>
    </button>
  );
}

// ─── Player ───────────────────────────────────────────────────────────────────
function Player({item,onClose,onNext,onPrev}:{item:any;onClose:()=>void;onNext?:()=>void;onPrev?:()=>void}){
  const src=`https://www.youtube-nocookie.com/embed/${item.video_id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  const ytUrl=`https://www.youtube.com/watch?v=${item.video_id}`;
  return(
    <div style={{position:'fixed',inset:0,zIndex:4000,backgroundColor:'#0f1a13',display:'flex',flexDirection:'column'}}>
      <div style={{padding:'calc(8px + env(safe-area-inset-top, 0px)) 12px 8px',backgroundColor:C.green,display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
        <button onClick={onClose} aria-label="Close player" style={{background:'rgba(255,255,255,0.12)',border:'none',color:'#fff',fontSize:18,cursor:'pointer',borderRadius:8,padding:'6px 11px',lineHeight:1,flexShrink:0}}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:'#fff',fontWeight:800,fontSize:13.5,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{item.title}</div>
          <div style={{color:'rgba(255,255,255,0.6)',fontSize:10.5,marginTop:2}}>
            {[item.published_at?fmtDate(item.published_at):'', item.view_count>0?`${fmtViews(item.view_count)} views`:''].filter(Boolean).join(' · ')}
          </div>
        </div>
        <a href={ytUrl} target="_blank" rel="noreferrer" aria-label="Open on YouTube"
          style={{backgroundColor:C.yt,color:'#fff',fontSize:11,fontWeight:800,borderRadius:7,padding:'6px 9px',textDecoration:'none',flexShrink:0}}>YouTube ↗</a>
      </div>
      <div style={{width:'100%',paddingTop:'56.25%',position:'relative',backgroundColor:'#000',flexShrink:0}}>
        <iframe src={src} title={item.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{position:'absolute',inset:0,width:'100%',height:'100%',border:'none'}}/>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'12px 16px 20px'}}>
        {(onPrev||onNext)&&(
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button onClick={onPrev} disabled={!onPrev} style={{flex:1,padding:'10px',borderRadius:10,backgroundColor:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.15)',
              color:onPrev?'#fff':'rgba(255,255,255,0.3)',fontWeight:700,fontSize:13,cursor:onPrev?'pointer':'default'}}>‹ Previous</button>
            <button onClick={onNext} disabled={!onNext} style={{flex:1,padding:'10px',borderRadius:10,border:'none',
              backgroundColor:onNext?C.gold:'rgba(255,255,255,0.08)',color:onNext?C.green:'rgba(255,255,255,0.3)',fontWeight:800,fontSize:13,cursor:onNext?'pointer':'default'}}>Next ›</button>
          </div>
        )}
        {item.description&&<p style={{margin:0,color:'rgba(255,255,255,0.75)',fontSize:13,lineHeight:1.65,whiteSpace:'pre-line'}}>{item.description}</p>}
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

  const load=useCallback(async(p:number)=>{
    setLoading(true);setError('');
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
      // Nothing local yet — fetch this page from the server
      const r=await fetch(`${base}/api/data/videos?sort=${sort}&limit=${PAGE}&offset=${(p-1)*PAGE}`,{headers:hdr()});
      if(!r.ok){setError(`Server error ${r.status}`);return;}
      const j=await r.json();
      if(j.data?.length)await upsertYoutubeVideos(j.data);
      const fresh=await getYoutubeVideos(sort,PAGE,(p-1)*PAGE);
      const cnt2=await countYoutubeVideos();
      setItems(fresh);setTotal(cnt2);setPage(p);
    }catch{setError('Could not connect to the server');}
    finally{setLoading(false);}
  },[sort,base,checkLatest]);

  // Load on tab change; re-check latest every 60 min while open
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

  if(loading)return<Spinner/>;
  if(error)return<div style={{padding:'8px 12px',borderRadius:10,backgroundColor:'#fef3c7',border:'1px solid #fcd34d',fontWeight:700,fontSize:12.5,color:'#92400e'}}>⚠ {error}</div>;
  if(!items.length)return<Empty icon="📺" title="No videos yet" sub="Academy channel videos will appear here — tap ↻"/>;

  return(<>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
      {items.map((item,i)=><VCard key={item.video_id??i} item={item} onOpen={()=>onPlay(item,items)}/>)}
    </div>
    {pages>1&&<Pager page={page} pages={pages} onP={()=>load(page-1)} onN={()=>load(page+1)}/>}
  </>);
}

// ─── Search tab ───────────────────────────────────────────────────────────────
function SearchTab({onPlay}:{onPlay:(item:any,list:any[])=>void}){
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

  return(<>
    <div style={{position:'relative'}}>
      <span style={{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',fontSize:14}}>🔍</span>
      <input autoFocus value={q} onChange={e=>handleInput(e.target.value)} placeholder="Search academy videos…" aria-label="Search academy videos"
        style={{width:'100%',padding:'9px 34px',borderRadius:10,border:`1px solid ${C.border}`,fontSize:14,outline:'none',boxSizing:'border-box',backgroundColor:'#fff'}}/>
      {q&&<button onClick={()=>handleInput('')} aria-label="Clear search" style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:15,color:C.muted}}>✕</button>}
    </div>
    {!q&&<Empty icon="🔍" title="Search academy videos" sub="Matches, highlights, training, events"/>}
    {loading&&<div style={{textAlign:'center',padding:'24px 0',color:C.muted,fontSize:13}}>Searching…</div>}
    {!loading&&q&&results.length===0&&<Empty icon="📭" title={`No results for "${q}"`}/>}
    {!loading&&results.length>0&&(<>
      <div style={{fontSize:10.5,fontWeight:800,color:C.muted,letterSpacing:'0.8px',textTransform:'uppercase',margin:'6px 2px 0'}}>{total} result{total!==1?'s':''}</div>
      <div style={CARD}>{results.map((item,i)=><VRow key={item.video_id??i} first={i===0} item={item} onOpen={()=>onPlay(item,results)}/>)}</div>
    </>)}
    {!loading&&pages>1&&<Pager page={page} pages={pages} onP={()=>search(q,page-1)} onN={()=>search(q,page+1)}/>}
  </>);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const TABS:[Sort|'search', string, string][]=[
  ['popular','🔥','Popular'],
  ['featured','⭐','Featured'],
  ['newest','🆕','Newest'],
  ['search','🔍','Search'],
];

export default function VideosScreen(){
  const [tab,setTab]=useState<Sort|'search'>('popular');
  const [syncKey,setSyncKey]=useState(0);   // bump → grid reloads after a sync
  const [playing,setPlaying]=useState<any|null>(null);
  const [playlist,setPlaylist]=useState<any[]>([]);
  const [syncStatus,setSyncStatus]=useState<'idle'|'syncing'|'done'|'error'>('idle');
  const [syncProg,setSyncProg]=useState({fetched:0,total:0});
  const base=bld(localStorage.getItem('server_ip')??'');

  const runSync=()=>{
    setSyncStatus('syncing');
    setSyncProg({fetched:0,total:0});
    syncYoutubeFromServer(base,hdr(),'popular',(f,t)=>setSyncProg({fetched:f,total:t}))
      .then(({fetched,total})=>{
        setSyncProg({fetched,total});
        setSyncStatus('done');
        if(fetched>0)setSyncKey(k=>k+1);
        setTimeout(()=>setSyncStatus('idle'),3000);
      })
      .catch(()=>{setSyncStatus('error');setTimeout(()=>setSyncStatus('idle'),3000);});
  };

  // Background sync on open — if not synced in the last hour
  useEffect(()=>{
    if(ytMinutesSinceSync()<60)return;
    runSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const handlePlay=(item:any,list:any[]=[])=>{setPlaying(item);setPlaylist(list);};
  const handleRefresh=()=>{if(syncStatus!=='syncing')runSync();};
  const idx=playing?playlist.findIndex(v=>v.video_id===playing.video_id):-1;
  const hasNext=idx>=0&&idx<playlist.length-1;
  const hasPrev=idx>0;

  return(
    <>
    <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:24,fontFamily:'sans-serif',color:C.text}}>
      <ScreenHeader
        title={<span style={{display:'inline-flex',alignItems:'center',gap:8}}>
          <span style={{width:24,height:17,backgroundColor:C.yt,borderRadius:5,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'#fff',fontSize:9,marginLeft:1}}>▶</span></span>
          QCA Channel
        </span>}
        subtitle={syncStatus==='syncing'
          ?`⟳ Syncing… ${syncProg.fetched}${syncProg.total>0?' / '+syncProg.total:''}`
          :syncStatus==='done'
          ?`✔ ${syncProg.fetched} videos synced`
          :syncStatus==='error'
          ?'⚠ Sync failed — tap ↻ to retry'
          :'Academy · matches · highlights · training'}
        actions={<HeaderIconButton label="Sync videos" onClick={handleRefresh} disabled={syncStatus==='syncing'}>
          {syncStatus==='syncing'?'⟳':syncStatus==='done'?'✔':'↻'}
        </HeaderIconButton>}>
        <HeaderTabs value={tab} onChange={setTab} tabs={TABS.map(([id,icon,label])=>({id,label:`${icon} ${label}`}))} />
      </ScreenHeader>
      <div style={{padding:10,display:'flex',flexDirection:'column',gap:8}}>
        {tab==='search'
          ?<SearchTab onPlay={handlePlay}/>
          :<VideoGrid key={`${tab}-${syncKey}`} sort={tab} onPlay={handlePlay}/>}
      </div>
    </div>
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
