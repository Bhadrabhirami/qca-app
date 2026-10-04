/**
 * library.tsx — Coaching Library
 * Offline-first. 4 tabs: Home · Browse · Saved · Search
 * Features: progress tracking, bookmarks, notes, star ratings,
 *           assignments, continue watching, category stats, playlist
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getLibraryWithActivity, countLibrary, getLibraryStats,
  upsertLibraryItems, syncLibraryFromServer, libraryMinutesSinceSync,
  getBookmarks, getRecentlyWatched,
  getAssignments, getLibraryCategoryStats,
  markWatched, toggleBookmark, saveVideoNote, saveVideoRating,
} from '../database/db';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';

const C = {
  green:'#1a472a', gold:'#d4af37', navy:'#0d1b2a',
  bg:'#f0f4f1', card:'#ffffff', border:'#e5e7eb',
  muted:'#6b7280', red:'#dc2626',
};
const PAGE = 10;
type Tab = 'home'|'browse'|'saved'|'search';

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
function ytId(url:string):string{if(!url)return '';for(const p of[/youtu\.be\/([^?&#/]+)/,/[?&]v=([^?&#/]+)/,/\/embed\/([^?&#/]+)/,/\/shorts\/([^?&#/]+)/]){const m=url.match(p);if(m?.[1])return m[1];}return '';}
function isYT(url:string){return!!(url&&(url.includes('youtube.com')||url.includes('youtu.be')));}
function thumb(url:string,ui:string):string{if(ui)return ui;const id=ytId(url||'');return id?`https://img.youtube.com/vi/${id}/mqdefault.jpg`:'';}
const CAT_CLR:Record<string,string>={batting:'#c0392b',bowling:'#1a472a',fielding:'#2980b9',fitness:'#8e44ad',mental:'#d97706',tactics:'#0d9488'};
function catClr(c:string){return CAT_CLR[(c||'').toLowerCase()]||C.green;}

// ─── Paginator ────────────────────────────────────────────────────────────────
function Pager({page,pages,onPrev,onNext}:{page:number;pages:number;onPrev:()=>void;onNext:()=>void}){
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,padding:'16px 0'}}>
      <button onClick={onPrev} disabled={page<=1} style={{padding:'8px 20px',borderRadius:9,border:`1px solid ${C.border}`,backgroundColor:page<=1?'#f3f4f6':C.green,color:page<=1?C.muted:'#fff',fontWeight:700,fontSize:13,cursor:page<=1?'default':'pointer'}}>← Prev</button>
      <span style={{fontSize:13,color:C.muted,minWidth:80,textAlign:'center'as const}}>{page} / {pages}</span>
      <button onClick={onNext} disabled={page>=pages} style={{padding:'8px 20px',borderRadius:9,border:`1px solid ${C.border}`,backgroundColor:page>=pages?'#f3f4f6':C.green,color:page>=pages?C.muted:'#fff',fontWeight:700,fontSize:13,cursor:page>=pages?'default':'pointer'}}>Next →</button>
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────
function SH({title,action,onA}:{title:string;action?:string;onA?:()=>void}){
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
      <div style={{fontWeight:800,fontSize:14,color:C.navy}}>{title}</div>
      {action&&<button onClick={onA} style={{background:'none',border:'none',color:C.green,fontSize:12,fontWeight:700,cursor:'pointer'}}>{action} →</button>}
    </div>
  );
}

// ─── Video row (thumbnail + info) ─────────────────────────────────────────────
function VRow({item,onOpen,showCat}:{item:any;onOpen:()=>void;showCat?:boolean}){
  const [imgErr,setImgErr]=useState(false);
  const t=!imgErr?thumb(item.url||'',item.url_image||''):'';
  const pct=item.watch_pct||0;
  return(
    <div onClick={onOpen} style={{backgroundColor:C.card,borderRadius:12,padding:'10px 12px',marginBottom:8,cursor:'pointer',border:`1px solid ${C.border}`,display:'flex',alignItems:'center',gap:12}}>
      <div style={{width:72,height:48,borderRadius:8,flexShrink:0,backgroundColor:'#1a1a2e',overflow:'hidden',position:'relative'}}>
        {t?<img src={t} alt="" onError={()=>setImgErr(true)} style={{width:'100%',height:'100%',objectFit:'cover'}}/>:<div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{fontSize:22}}>🎬</span></div>}
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',backgroundColor:'rgba(0,0,0,0.3)'}}><span style={{color:'#fff',fontSize:14}}>▶</span></div>
        {pct>0&&<div style={{position:'absolute',bottom:0,left:0,right:0,height:3,backgroundColor:'rgba(255,255,255,0.2)'}}><div style={{height:'100%',width:`${pct}%`,backgroundColor:pct>=90?'#27ae60':C.gold}}/></div>}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:13,color:C.navy,lineHeight:1.35,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'as const}}>{item.title}</div>
        <div style={{display:'flex',gap:6,marginTop:4,alignItems:'center',flexWrap:'wrap'as const}}>
          {showCat&&item.category&&<span style={{fontSize:10,fontWeight:700,color:'#fff',backgroundColor:catClr(item.category),padding:'1px 7px',borderRadius:8,textTransform:'uppercase'as const}}>{item.category}</span>}
          {item.is_watched?<span style={{fontSize:10,color:'#27ae60',fontWeight:700}}>✔ Watched</span>:pct>0?<span style={{fontSize:10,color:C.gold,fontWeight:700}}>{pct}%</span>:null}
          {item.is_bookmarked?<span style={{fontSize:11}}>🔖</span>:null}
        </div>
      </div>
      <span style={{color:C.muted,fontSize:18,flexShrink:0}}>›</span>
    </div>
  );
}

// ─── Player ───────────────────────────────────────────────────────────────────
function Player({item,onClose,onNext}:{item:any;onClose:()=>void;onNext?:()=>void}){
  const [note,setNote]=useState(item.user_note||'');
  const [editNote,setEdit]=useState(false);
  const [bm,setBm]=useState(!!item.is_bookmarked);
  const [rating,setRating]=useState(item.rating||0);
  const [saved,setSaved]=useState(false);
  useEffect(()=>{markWatched(item.video_id,100);},[item.video_id]);
  const id=ytId(item.url||'');
  const src=id?`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`:'';
  const handleBm=async()=>{const n=await toggleBookmark(item.video_id);setBm(n);};
  const handleRate=async(r:number)=>{setRating(r);await saveVideoRating(item.video_id,r);};
  const handleSave=async()=>{await saveVideoNote(item.video_id,note);setEdit(false);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  return(
    <div style={{position:'fixed',inset:0,zIndex:4000,backgroundColor:'#000',display:'flex',flexDirection:'column'}}>
      <div style={{padding:'calc(10px + env(safe-area-inset-top, 0px)) 16px 10px',backgroundColor:C.navy,display:'flex',alignItems:'flex-start',gap:12,flexShrink:0}}>
        <button onClick={onClose} style={{background:'rgba(255,255,255,0.1)',border:'none',color:'#fff',fontSize:20,cursor:'pointer',borderRadius:8,padding:'6px 12px',lineHeight:1,flexShrink:0}}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:'#fff',fontWeight:800,fontSize:14,lineHeight:1.4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'as const}}>{item.title}</div>
          {item.category&&<div style={{color:C.gold,fontSize:11,fontWeight:700,marginTop:3,textTransform:'uppercase'as const}}>{item.category}</div>}
        </div>
        <button onClick={handleBm} style={{background:'none',border:'none',cursor:'pointer',fontSize:24,lineHeight:1,padding:4,flexShrink:0}}>{bm?'🔖':'🏷️'}</button>
      </div>
      {src
        ?<div style={{width:'100%',paddingTop:'56.25%',position:'relative',backgroundColor:'#000',flexShrink:0}}><iframe src={src} title={item.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{position:'absolute',inset:0,width:'100%',height:'100%',border:'none'}}/></div>
        :item.url?<div style={{padding:'24px 20px',textAlign:'center'}}><a href={item.url} target="_blank" rel="noreferrer" style={{display:'inline-block',padding:'13px 32px',borderRadius:12,backgroundColor:C.gold,color:C.navy,fontWeight:800,fontSize:15,textDecoration:'none'}}>Open Link ↗</a></div>
        :null}
      <div style={{flex:1,overflowY:'auto',backgroundColor:C.navy}}>
        {/* Stars */}
        <div style={{padding:'14px 18px 0',display:'flex',gap:4}}>
          {[1,2,3,4,5].map(n=>(
            <button key={n} onClick={()=>handleRate(n)} style={{background:'none',border:'none',cursor:'pointer',fontSize:24,padding:2,lineHeight:1,color:n<=rating?C.gold:'rgba(255,255,255,0.2)'}}>★</button>
          ))}
          <span style={{fontSize:12,color:'rgba(255,255,255,0.4)',alignSelf:'center',marginLeft:6}}>
            {rating>0?['','Poor','Fair','Good','Great','Must Watch'][rating]:'Rate this'}
          </span>
        </div>
        {item.description&&<div style={{padding:'12px 18px 0'}}><p style={{color:'rgba(255,255,255,0.75)',fontSize:13,lineHeight:1.8}}>{item.description}</p></div>}
        {/* Notes */}
        <div style={{padding:'14px 18px'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
            <span style={{color:'rgba(255,255,255,0.6)',fontSize:12,fontWeight:700,textTransform:'uppercase'as const,letterSpacing:'0.5px'}}>📝 My Notes</span>
            <button onClick={()=>setEdit(v=>!v)} style={{background:'rgba(255,255,255,0.1)',border:'none',color:'#fff',fontSize:11,fontWeight:700,cursor:'pointer',padding:'4px 10px',borderRadius:6}}>{editNote?'Cancel':'Edit'}</button>
          </div>
          {editNote
            ?<><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Key takeaways, drills to practice…" rows={4} style={{width:'100%',padding:'10px 12px',borderRadius:8,border:'1px solid rgba(255,255,255,0.2)',backgroundColor:'rgba(255,255,255,0.08)',color:'#fff',fontSize:13,resize:'none'as const,fontFamily:'inherit',boxSizing:'border-box'as const}}/><button onClick={handleSave} style={{marginTop:8,width:'100%',padding:'10px',borderRadius:8,backgroundColor:saved?'#27ae60':C.gold,border:'none',color:saved?'#fff':C.navy,fontWeight:800,fontSize:14,cursor:'pointer'}}>{saved?'✔ Saved':'Save Notes'}</button></>
            :<p style={{color:note?'rgba(255,255,255,0.8)':'rgba(255,255,255,0.25)',fontSize:13,lineHeight:1.7,fontStyle:note?'normal':'italic'}}>{note||'No notes yet — tap Edit to add your takeaways'}</p>}
        </div>
        {onNext&&<div style={{padding:'0 18px 24px'}}><button onClick={onNext} style={{width:'100%',padding:'12px',borderRadius:10,backgroundColor:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.15)',color:'#fff',fontWeight:700,fontSize:14,cursor:'pointer'}}>Next Video →</button></div>}
      </div>
    </div>
  );
}

// ─── Home tab ─────────────────────────────────────────────────────────────────
function HomeTab({onPlay,onTab}:{onPlay:(item:any,list?:any[])=>void;onTab:(t:Tab)=>void}){
  const [stats,setStats]=useState<any>({total:0,watched:0,bookmarks:0,assigned:0});
  const [cats,setCats]=useState<any[]>([]);
  const [recent,setRecent]=useState<any[]>([]);
  const [assigned,setAssigned]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    (async()=>{
      setLoading(true);
      const [s,cs,r,a]=await Promise.all([getLibraryStats(),getLibraryCategoryStats(),getRecentlyWatched(5),getAssignments()]);
      setStats(s);setCats(cs);setRecent(r);setAssigned(a.filter((x:any)=>!x.is_completed).slice(0,3));setLoading(false);
    })();
  },[]);
  const pct=stats.total>0?Math.round((stats.watched/stats.total)*100):0;
  if(loading)return <div style={{padding:'60px 0',textAlign:'center',color:C.muted}}><div style={{fontSize:32}}>⏳</div></div>;
  return(
    <div style={{padding:'16px 16px 0'}}>
      {/* Progress card */}
      <div style={{backgroundColor:C.green,borderRadius:16,padding:'18px 18px 14px',marginBottom:16,boxShadow:'0 4px 16px rgba(26,71,42,0.3)'}}>
        <div style={{color:'rgba(255,255,255,0.7)',fontSize:12,fontWeight:700,textTransform:'uppercase'as const,letterSpacing:'1px',marginBottom:10}}>Your Progress</div>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
          {[{n:stats.total,label:'Total',icon:'📚'},{n:stats.watched,label:'Watched',icon:'✅'},{n:stats.bookmarks,label:'Saved',icon:'🔖'},{n:stats.assigned,label:'Tasks',icon:'📋'}].map(s=>(
            <div key={s.label} style={{textAlign:'center'}}>
              <div style={{fontSize:11}}>{s.icon}</div>
              <div style={{color:'#fff',fontWeight:900,fontSize:20,lineHeight:1.1}}>{s.n}</div>
              <div style={{color:'rgba(255,255,255,0.6)',fontSize:10,fontWeight:700}}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{backgroundColor:'rgba(255,255,255,0.15)',borderRadius:8,height:8,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${pct}%`,backgroundColor:C.gold,borderRadius:8}}/>
        </div>
        <div style={{color:'rgba(255,255,255,0.6)',fontSize:11,marginTop:5,textAlign:'right'as const}}>{pct}% complete</div>
      </div>
      {/* Assigned */}
      {assigned.length>0&&<div style={{marginBottom:20}}><SH title="📋 Assigned to You" action="All" onA={()=>onTab('browse')}/>{assigned.map((a:any)=><VRow key={a.id} item={a} onOpen={()=>onPlay(a)} showCat/>)}</div>}
      {/* Continue watching */}
      {recent.length>0&&<div style={{marginBottom:20}}><SH title="▶ Continue Watching"/>{recent.map((v:any)=><VRow key={v.video_id} item={v} onOpen={()=>onPlay(v)} showCat/>)}</div>}
      {/* Categories */}
      {cats.length>0&&(
        <div style={{marginBottom:20}}>
          <SH title="📂 Browse by Category" action="All videos" onA={()=>onTab('browse')}/>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            {cats.map((c:any)=>(
              <button key={c.category} onClick={()=>onTab('browse')} style={{borderRadius:12,border:'none',cursor:'pointer',padding:'16px 14px',textAlign:'left'as const,backgroundColor:catClr(c.category),boxShadow:'0 2px 8px rgba(0,0,0,0.15)'}}>
                <div style={{color:'#fff',fontWeight:900,fontSize:15,textTransform:'capitalize'as const}}>{c.category}</div>
                <div style={{color:'rgba(255,255,255,0.75)',fontSize:12,marginTop:2}}>{c.total} video{c.total!==1?'s':''}{c.watched>0?` · ${c.watched} watched`:''}</div>
                <div style={{marginTop:10,backgroundColor:'rgba(255,255,255,0.2)',borderRadius:4,height:4}}><div style={{height:'100%',borderRadius:4,backgroundColor:'rgba(255,255,255,0.85)',width:`${c.total>0?Math.round((c.watched/c.total)*100):0}%`}}/></div>
              </button>
            ))}
          </div>
        </div>
      )}
      {stats.total===0&&<div style={{textAlign:'center',padding:'40px 0',color:C.muted}}><div style={{fontSize:48,marginBottom:12}}>📚</div><div style={{fontWeight:800,fontSize:15,color:C.navy,marginBottom:6}}>Library is empty</div><div style={{fontSize:13}}>Videos will sync when connected to the server</div></div>}
    </div>
  );
}

// ─── Browse tab ───────────────────────────────────────────────────────────────
const BROWSE_CATS=['All','Batting','Bowling','Fielding','Fitness','Mental','Tactics'];
function BrowseTab({onPlay}:{onPlay:(item:any,list:any[])=>void}){
  const [cat,setCat]=useState('All');
  const [items,setItems]=useState<any[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const base=bld(localStorage.getItem('server_ip')??'');

  // Smart latest-check: fetch only 5 newest from server, upsert if changed
  const checkLatest=useCallback(async(c:string)=>{
    try{
      const ps=new URLSearchParams({limit:'5',offset:'0'});
      if(c!=='All')ps.set('category',c);
      const r=await fetch(`${base}/api/data/library?${ps}`,{headers:hdr()});
      if(!r.ok)return false;
      const j=await r.json();
      if(!j.data?.length)return false;
      await upsertLibraryItems(j.data);
      return true;
    }catch{return false;}
  },[base]);

  const fetchPage=useCallback(async(c:string,p:number,silent=false)=>{
    if(!silent)setLoading(true);setError('');
    try{
      const catArg=c==='All'?undefined:c;
      const localCnt=await countLibrary(catArg);
      if(localCnt>0){
        const local=await getLibraryWithActivity(catArg,PAGE,(p-1)*PAGE);
        setItems(local);setTotal(localCnt);setPage(p);setLoading(false);
        // Check latest 5 from server in background — only upsert if new
        checkLatest(c).then(async(changed)=>{
          if(changed){
            const f=await getLibraryWithActivity(catArg,PAGE,(p-1)*PAGE);
            const cnt=await countLibrary(catArg);
            setItems(f);setTotal(cnt);
          }
        });
        return;
      }
      // No local data — full fetch from server
      const ps=new URLSearchParams({limit:String(PAGE),offset:String((p-1)*PAGE)});
      if(c!=='All')ps.set('category',c);
      const r=await fetch(`${base}/api/data/library?${ps}`,{headers:hdr()});
      if(!r.ok){setError(`Error ${r.status}`);return;}
      const j=await r.json();
      if(j.data?.length)await upsertLibraryItems(j.data);
      const catArg2=c==='All'?undefined:c;
      const fresh=await getLibraryWithActivity(catArg2,PAGE,(p-1)*PAGE);
      const cnt=await countLibrary(catArg2);
      setItems(fresh);setTotal(cnt);setPage(p);
    }catch{setError('Could not connect');}
    finally{setLoading(false);}
  },[base,checkLatest]);

  // Auto check latest every 60 min
  const lastLibSync=useRef(0);
  useEffect(()=>{
    fetchPage(cat,1);
    lastLibSync.current=Date.now();
    const id=setInterval(()=>{
      if(Date.now()-lastLibSync.current>60*60*1000){
        checkLatest(cat).then(async(changed)=>{
          if(changed){
            const catArg=cat==='All'?undefined:cat;
            const f=await getLibraryWithActivity(catArg,PAGE,0);
            const cnt=await countLibrary(catArg);
            setItems(f);setTotal(cnt);
          }
          lastLibSync.current=Date.now();
        });
      }
    },60*1000);
    return()=>clearInterval(id);
  },[cat,fetchPage,checkLatest]);
  const pages=Math.ceil(total/PAGE);

  return(
    <div>
      <div style={{backgroundColor:C.green,padding:'0 16px 12px'}}>
        <div style={{display:'flex',gap:8,overflowX:'auto'as const,scrollbarWidth:'none'as const}}>
          {BROWSE_CATS.map(c=>(
            <button key={c} onClick={()=>setCat(c)} style={{padding:'6px 14px',borderRadius:20,border:'none',cursor:'pointer',fontWeight:700,fontSize:12,flexShrink:0,backgroundColor:cat===c?C.gold:'rgba(255,255,255,0.15)',color:cat===c?C.navy:'#fff'}}>{c}</button>
          ))}
        </div>
      </div>
      <div style={{padding:'14px 16px 0'}}>
        {loading&&<div style={{textAlign:'center',padding:'48px 0',color:C.muted}}><div style={{fontSize:28}}>⏳</div></div>}
        {error&&<div style={{padding:'12px',borderRadius:10,backgroundColor:'#fef3c7',border:'1px solid #fcd34d',marginBottom:12}}><div style={{fontWeight:700,fontSize:13,color:'#92400e'}}>⚠ {error}</div></div>}
        {!loading&&items.length===0&&!error&&<div style={{textAlign:'center',padding:'48px 0',color:C.muted}}><div style={{fontSize:40,marginBottom:8}}>📭</div><div style={{fontWeight:700}}>No videos in {cat}</div></div>}
        {!loading&&items.map((item,i)=><VRow key={item.video_id??i} item={item} onOpen={()=>onPlay(item,items)}/>)}
        {!loading&&pages>1&&<Pager page={page} pages={pages} onPrev={()=>fetchPage(cat,page-1)} onNext={()=>fetchPage(cat,page+1)}/>}
      </div>
    </div>
  );
}

// ─── Saved tab ────────────────────────────────────────────────────────────────
function SavedTab({onPlay}:{onPlay:(item:any)=>void}){
  const [items,setItems]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{getBookmarks().then(b=>{setItems(b);setLoading(false);});},[]);
  if(loading)return <div style={{padding:'48px 0',textAlign:'center',color:C.muted}}><div style={{fontSize:28}}>⏳</div></div>;
  if(!items.length)return <div style={{padding:'60px 20px',textAlign:'center',color:C.muted}}><div style={{fontSize:48,marginBottom:12}}>🔖</div><div style={{fontWeight:800,fontSize:15,color:C.navy,marginBottom:6}}>No saved videos</div><div style={{fontSize:13}}>Tap 🏷️ while watching to bookmark</div></div>;
  return(
    <div style={{padding:'14px 16px 0'}}>
      <div style={{fontSize:13,color:C.muted,marginBottom:12}}>{items.length} bookmarked video{items.length!==1?'s':''}</div>
      {items.map((item,i)=><VRow key={item.video_id??i} item={item} showCat onOpen={()=>onPlay(item)}/>)}
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
      const localCnt=await countLibrary(undefined,query);
      if(localCnt>0){const local=await getLibraryWithActivity(undefined,PAGE,(p-1)*PAGE,query);setResults(local);setTotal(localCnt);setPage(p);setLoading(false);return;}
      const ps=new URLSearchParams({search:query.trim(),limit:String(PAGE),offset:String((p-1)*PAGE)});
      const r=await fetch(`${base}/api/data/library?${ps}`,{headers:hdr()});
      if(r.ok){const j=await r.json();setResults(j.data||[]);setTotal(j.total??j.count??0);setPage(p);if(j.data?.length)await upsertLibraryItems(j.data);}
    }catch{}
    finally{setLoading(false);}
  },[base]);

  const handleInput=(v:string)=>{setQ(v);setPage(1);clearTimeout(timer.current);if(!v.trim()){setResults([]);setTotal(0);return;}timer.current=setTimeout(()=>search(v,1),400);};
  const pages=Math.ceil(total/PAGE);

  return(
    <div style={{padding:'14px 16px 0'}}>
      <div style={{position:'relative',marginBottom:14}}>
        <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',fontSize:16}}>🔍</span>
        <input autoFocus value={q} onChange={e=>handleInput(e.target.value)} placeholder="Search videos, drills, techniques…" style={{width:'100%',padding:'11px 14px 11px 38px',borderRadius:12,border:`1.5px solid ${C.border}`,fontSize:14,outline:'none',boxSizing:'border-box'as const,backgroundColor:'#fff'}}/>
        {q&&<button onClick={()=>handleInput('')} style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.muted}}>✕</button>}
      </div>
      {!q&&<div style={{textAlign:'center',padding:'48px 0',color:C.muted}}><div style={{fontSize:36,marginBottom:10}}>🔍</div><div style={{fontWeight:700,fontSize:14}}>Search the library</div><div style={{fontSize:12,marginTop:4}}>Find drills, techniques, coaching tips</div></div>}
      {loading&&<div style={{textAlign:'center',padding:'32px 0',color:C.muted}}>Searching…</div>}
      {!loading&&q&&results.length===0&&<div style={{textAlign:'center',padding:'40px 0',color:C.muted}}><div style={{fontSize:32,marginBottom:8}}>📭</div>No results for "{q}"</div>}
      {/* Text-only results */}
      {!loading&&results.map((item,i)=>(
        <div key={item.video_id??i} onClick={()=>onPlay(item)} style={{backgroundColor:C.card,borderRadius:10,padding:'12px 14px',marginBottom:8,cursor:'pointer',border:`1px solid ${C.border}`,display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:36,height:36,borderRadius:8,flexShrink:0,backgroundColor:isYT(item.url)?'#ff0000':C.green,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'#fff',fontSize:14,marginLeft:2}}>▶</span></div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13,color:C.navy,lineHeight:1.35,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'as const}}>{item.title}</div>
            <div style={{display:'flex',gap:6,marginTop:3}}>
              {item.category&&<span style={{fontSize:10,fontWeight:700,color:'#fff',backgroundColor:catClr(item.category),padding:'1px 7px',borderRadius:8,textTransform:'uppercase'as const}}>{item.category}</span>}
              {item.is_watched&&<span style={{fontSize:10,color:'#27ae60',fontWeight:700}}>✔ Watched</span>}
            </div>
          </div>
          <span style={{color:C.muted,fontSize:18}}>›</span>
        </div>
      ))}
      {!loading&&pages>1&&<Pager page={page} pages={pages} onPrev={()=>search(q,page-1)} onNext={()=>search(q,page+1)}/>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const NAV:[Tab,string,string][]=[['home','🏠','Home'],['browse','📂','Browse'],['saved','🔖','Saved'],['search','🔍','Search']];

export default function LibraryScreen(){
  const navigate=useNavigate();
  const [tab,setTab]=useState<Tab>('home');
  const [playing,setPlaying]=useState<any|null>(null);
  const [playlist,setPlaylist]=useState<any[]>([]);
  const [syncStatus,setSyncStatus]=useState<'idle'|'syncing'|'done'|'error'>('idle');
  const [syncProgress,setSyncProgress]=useState({fetched:0,total:0});
  const base=bld(localStorage.getItem('server_ip')??'');

  // ── Background sync on mount — pulls ALL videos if not synced recently ──
  useEffect(()=>{
    const SYNC_INTERVAL_MINS = 60; // re-sync every hour
    if(libraryMinutesSinceSync() < SYNC_INTERVAL_MINS) return; // already fresh
    setSyncStatus('syncing');
    syncLibraryFromServer(base, hdr(), (fetched, total) => {
      setSyncProgress({fetched, total});
    }).then(({fetched, total}) => {
      if(fetched > 0) setSyncStatus('done');
      else setSyncStatus('idle');
      setTimeout(() => setSyncStatus('idle'), 4000);
    }).catch(() => {
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 3000);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const handlePlay=(item:any,list:any[]=[])=>{setPlaying(item);setPlaylist(list);};

  const handleRefresh=()=>{
    if(syncStatus==='syncing')return;
    setSyncStatus('syncing');
    setSyncProgress({fetched:0,total:0});
    syncLibraryFromServer(base,hdr(),(fetched,total)=>{
      setSyncProgress({fetched,total});
    }).then(({fetched,total})=>{
      setSyncProgress({fetched,total});
      setSyncStatus(fetched>0?'done':'idle');
      setTimeout(()=>setSyncStatus('idle'),3000);
      // Trigger re-render of current tab via event
      window.dispatchEvent(new CustomEvent('library-refreshed'));
    }).catch(()=>{
      setSyncStatus('error');
      setTimeout(()=>setSyncStatus('idle'),3000);
    });
  };
  const handleNext=()=>{if(!playlist.length||!playing)return;const idx=playlist.findIndex(v=>v.video_id===playing.video_id);if(idx<playlist.length-1)setPlaying(playlist[idx+1]);};
  const nextOk=playlist.length>0&&playing&&playlist.findIndex(v=>v.video_id===playing.video_id)<playlist.length-1;
  return(
    <>
      <div style={{backgroundColor:C.bg,minHeight:'100vh',paddingBottom:16}}>
        <ScreenHeader title="📚 Coaching Library"
          subtitle={syncStatus==='syncing'
            ? `⟳ Syncing… ${syncProgress.fetched}${syncProgress.total>0?' / '+syncProgress.total:''} videos`
            : syncStatus==='done'
            ? `✔ ${syncProgress.fetched} videos synced`
            : syncStatus==='error'
            ? '⚠ Sync failed — tap ↻ to retry'
            : 'Videos · Drills · Techniques'}
          actions={<HeaderIconButton label="Sync library" onClick={handleRefresh} disabled={syncStatus==='syncing'}>
            {syncStatus==='syncing'?'⟳':syncStatus==='done'?'✔':'↻'}
          </HeaderIconButton>}>
          <HeaderTabs value={tab} onChange={setTab} tabs={NAV.map(([id,icon,label])=>({id,label:`${icon} ${label}`}))} />
        </ScreenHeader>
        {tab==='home'&&<HomeTab onPlay={handlePlay} onTab={setTab}/>}
        {tab==='browse'&&<BrowseTab onPlay={handlePlay}/>}
        {tab==='saved'&&<SavedTab onPlay={handlePlay}/>}
        {tab==='search'&&<SearchTab onPlay={handlePlay}/>}
      </div>
      {/* Player */}
      {playing&&<Player item={playing} onClose={()=>{setPlaying(null);setPlaylist([]);}} onNext={nextOk?handleNext:undefined}/>}
    </>
  );
}
