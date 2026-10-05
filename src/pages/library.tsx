/**
 * library.tsx — Coaching Library
 * Offline-first. 4 tabs: Home · Browse · Saved · Search
 * Features: progress tracking, bookmarks, notes, star ratings,
 *           assignments, recently watched, category stats, playlist
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getLibraryWithActivity, countLibrary, getLibraryStats,
  upsertLibraryItems, syncLibraryFromServer, libraryMinutesSinceSync,
  getBookmarks, getRecentlyWatched,
  getAssignments, getLibraryCategoryStats,
  markWatched, toggleBookmark, saveVideoNote, saveVideoRating,
} from '../database/db';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';

const C = {
  green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', card:'#ffffff',
  border:'#e8e8e8', muted:'#6b7280', text:'#1f2937', red:'#dc2626', ok:'#166534',
};
const CARD: React.CSSProperties = { backgroundColor:C.card, borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const PAGE = 10;
const WATCHED_AFTER_MS = 20_000;   // a video counts as watched after 20s in the player
type Tab = 'home'|'browse'|'saved'|'search';

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
function ytId(url:string):string{if(!url)return '';for(const p of[/youtu\.be\/([^?&#/]+)/,/[?&]v=([^?&#/]+)/,/\/embed\/([^?&#/]+)/,/\/shorts\/([^?&#/]+)/]){const m=url.match(p);if(m?.[1])return m[1];}return '';}
function thumb(url:string,ui:string):string{if(ui)return ui;const id=ytId(url||'');return id?`https://img.youtube.com/vi/${id}/mqdefault.jpg`:'';}
const CAT_CLR:Record<string,string>={batting:'#c0392b',bowling:'#1a472a',fielding:'#2980b9',fitness:'#8e44ad',mental:'#d97706',tactics:'#0d9488'};
function catClr(c:string){return CAT_CLR[(c||'').toLowerCase()]||C.green;}

// ─── Small pieces ─────────────────────────────────────────────────────────────
const SectionLabel = ({ children, action, onAction }: { children:React.ReactNode; action?:string; onAction?:()=>void }) => (
  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',margin:'6px 2px 0'}}>
    <span style={{fontSize:10.5,fontWeight:800,color:C.muted,letterSpacing:'0.8px',textTransform:'uppercase'}}>{children}</span>
    {action&&<button onClick={onAction} style={{background:'none',border:'none',color:C.green,fontSize:12,fontWeight:700,cursor:'pointer',padding:0}}>{action} ›</button>}
  </div>
);
const Spinner = () => <div style={{textAlign:'center',padding:'40px 0',color:C.muted,fontSize:13}}>Loading…</div>;
const Empty = ({ icon, title, sub }: { icon:string; title:string; sub?:string }) => (
  <div style={{...CARD,padding:'28px 16px',textAlign:'center',color:C.muted}}>
    <div style={{fontSize:30,marginBottom:6}}>{icon}</div>
    <div style={{fontWeight:800,fontSize:13.5,color:C.text}}>{title}</div>
    {sub&&<div style={{fontSize:12,marginTop:3}}>{sub}</div>}
  </div>
);

function Pager({page,pages,onPrev,onNext}:{page:number;pages:number;onPrev:()=>void;onNext:()=>void}){
  const btn=(on:boolean):React.CSSProperties=>({width:40,height:32,borderRadius:9,border:`1px solid ${C.border}`,fontSize:16,fontWeight:800,
    backgroundColor:on?C.green:'#f3f4f6',color:on?'#fff':'#c0c4cc',cursor:on?'pointer':'default'});
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:12,padding:'4px 0'}}>
      <button aria-label="Previous page" onClick={onPrev} disabled={page<=1} style={btn(page>1)}>‹</button>
      <span style={{fontSize:12.5,color:C.muted,fontWeight:700,minWidth:70,textAlign:'center'}}>Page {page} / {pages}</span>
      <button aria-label="Next page" onClick={onNext} disabled={page>=pages} style={btn(page<pages)}>›</button>
    </div>
  );
}

// ─── Video row (thumbnail + info) — rows sit inside one card ──────────────────
function VRow({item,onOpen,showCat,first}:{item:any;onOpen:()=>void;showCat?:boolean;first?:boolean}){
  const [imgErr,setImgErr]=useState(false);
  const t=!imgErr?thumb(item.url||'',item.url_image||''):'';
  const pct=item.watch_pct||0;
  return(
    <button onClick={onOpen} style={{width:'100%',display:'flex',alignItems:'center',gap:10,padding:'8px 12px',background:'none',border:'none',
      borderTop:first?'none':`1px solid ${C.border}`,cursor:'pointer',textAlign:'left'}}>
      <div style={{width:68,height:42,borderRadius:7,flexShrink:0,backgroundColor:'#e5e7eb',overflow:'hidden',position:'relative'}}>
        {t?<img src={t} alt="" loading="lazy" onError={()=>setImgErr(true)} style={{width:'100%',height:'100%',objectFit:'cover'}}/>
          :<div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>🎬</div>}
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',backgroundColor:'rgba(0,0,0,0.25)'}}><span style={{color:'#fff',fontSize:12}}>▶</span></div>
        {pct>0&&<div style={{position:'absolute',bottom:0,left:0,right:0,height:3,backgroundColor:'rgba(255,255,255,0.3)'}}><div style={{height:'100%',width:`${pct}%`,backgroundColor:pct>=90?'#22c55e':C.gold}}/></div>}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:13,color:C.text,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{item.title}</div>
        <div style={{display:'flex',gap:6,marginTop:3,alignItems:'center',fontSize:10.5,fontWeight:700}}>
          {showCat&&item.category&&<span style={{color:catClr(item.category),textTransform:'uppercase'}}>● {item.category}</span>}
          {item.is_watched?<span style={{color:C.ok}}>✔ Watched</span>:pct>0?<span style={{color:'#a8862a'}}>{pct}%</span>:null}
          {item.is_bookmarked?<span>🔖</span>:null}
          {item.due_date&&<span style={{color:'#b45309'}}>Due {String(item.due_date).slice(0,10)}</span>}
        </div>
      </div>
    </button>
  );
}

const VList = ({ items, onPlay, showCat }: { items:any[]; onPlay:(item:any,list:any[])=>void; showCat?:boolean }) => (
  <div style={CARD}>
    {items.map((it,i)=><VRow key={(it.id??it.video_id??'')+'-'+i} first={i===0} item={it} showCat={showCat} onOpen={()=>onPlay(it,items)}/>)}
  </div>
);

// ─── Player ───────────────────────────────────────────────────────────────────
function Player({item,onClose,onNext}:{item:any;onClose:()=>void;onNext?:()=>void}){
  const [note,setNote]=useState(item.user_note||'');
  const [editNote,setEdit]=useState(false);
  const [bm,setBm]=useState(!!item.is_bookmarked);
  const [rating,setRating]=useState(item.rating||0);
  const [saved,setSaved]=useState(false);
  // Count as watched only after it has been open a while — not on a quick peek
  useEffect(()=>{
    const t=setTimeout(()=>{markWatched(item.video_id,100);},WATCHED_AFTER_MS);
    return()=>clearTimeout(t);
  },[item.video_id]);
  useEffect(()=>{setNote(item.user_note||'');setBm(!!item.is_bookmarked);setRating(item.rating||0);setEdit(false);},[item.video_id]);
  const id=ytId(item.url||'');
  const src=id?`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`:'';
  const handleBm=async()=>{const n=await toggleBookmark(item.video_id);setBm(n);};
  const handleRate=async(r:number)=>{setRating(r);await saveVideoRating(item.video_id,r);};
  const handleSave=async()=>{await saveVideoNote(item.video_id,note);setEdit(false);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  const DARK='#0f1a13';
  return(
    <div style={{position:'fixed',inset:0,zIndex:4000,backgroundColor:DARK,display:'flex',flexDirection:'column'}}>
      <div style={{padding:'calc(8px + env(safe-area-inset-top, 0px)) 12px 8px',backgroundColor:C.green,display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
        <button onClick={onClose} aria-label="Close player" style={{background:'rgba(255,255,255,0.12)',border:'none',color:'#fff',fontSize:18,cursor:'pointer',borderRadius:8,padding:'6px 11px',lineHeight:1,flexShrink:0}}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:'#fff',fontWeight:800,fontSize:13.5,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{item.title}</div>
          {item.category&&<div style={{color:C.gold,fontSize:10.5,fontWeight:800,marginTop:2,textTransform:'uppercase'}}>{item.category}</div>}
        </div>
        <button onClick={handleBm} aria-label={bm?'Remove bookmark':'Bookmark'} aria-pressed={bm}
          style={{background:bm?C.gold:'rgba(255,255,255,0.12)',border:'none',cursor:'pointer',fontSize:12,fontWeight:800,borderRadius:8,padding:'7px 10px',
            color:bm?C.green:'#fff',flexShrink:0}}>{bm?'🔖 Saved':'🔖 Save'}</button>
      </div>
      {src
        ?<div style={{width:'100%',paddingTop:'56.25%',position:'relative',backgroundColor:'#000',flexShrink:0}}><iframe src={src} title={item.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{position:'absolute',inset:0,width:'100%',height:'100%',border:'none'}}/></div>
        :item.url?<div style={{padding:'24px 20px',textAlign:'center'}}><a href={item.url} target="_blank" rel="noreferrer" style={{display:'inline-block',padding:'12px 28px',borderRadius:11,backgroundColor:C.gold,color:C.green,fontWeight:800,fontSize:14,textDecoration:'none'}}>Open link ↗</a></div>
        :null}
      <div style={{flex:1,overflowY:'auto'}}>
        {/* Stars */}
        <div style={{padding:'12px 16px 0',display:'flex',gap:2,alignItems:'center'}}>
          {[1,2,3,4,5].map(n=>(
            <button key={n} onClick={()=>handleRate(n)} aria-label={`Rate ${n}`} style={{background:'none',border:'none',cursor:'pointer',fontSize:23,padding:2,lineHeight:1,color:n<=rating?C.gold:'rgba(255,255,255,0.2)'}}>★</button>
          ))}
          <span style={{fontSize:12,color:'rgba(255,255,255,0.45)',marginLeft:6}}>
            {rating>0?['','Poor','Fair','Good','Great','Must Watch'][rating]:'Rate this'}
          </span>
        </div>
        {item.description&&<p style={{margin:0,padding:'10px 16px 0',color:'rgba(255,255,255,0.75)',fontSize:13,lineHeight:1.65}}>{item.description}</p>}
        {/* Notes */}
        <div style={{padding:'14px 16px'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
            <span style={{color:'rgba(255,255,255,0.6)',fontSize:11,fontWeight:800,textTransform:'uppercase',letterSpacing:'0.5px'}}>📝 My notes</span>
            <button onClick={()=>setEdit(v=>!v)} style={{background:'rgba(255,255,255,0.1)',border:'none',color:'#fff',fontSize:11,fontWeight:700,cursor:'pointer',padding:'4px 10px',borderRadius:6}}>{editNote?'Cancel':'Edit'}</button>
          </div>
          {editNote
            ?<><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Key takeaways, drills to practice…" rows={4} style={{width:'100%',padding:'9px 11px',borderRadius:8,border:'1px solid rgba(255,255,255,0.2)',backgroundColor:'rgba(255,255,255,0.08)',color:'#fff',fontSize:13,resize:'none',fontFamily:'inherit',boxSizing:'border-box'}}/>
              <button onClick={handleSave} style={{marginTop:8,width:'100%',padding:'10px',borderRadius:9,backgroundColor:saved?'#22c55e':C.gold,border:'none',color:saved?'#fff':C.green,fontWeight:800,fontSize:13.5,cursor:'pointer'}}>{saved?'✔ Saved':'Save notes'}</button></>
            :<p style={{margin:0,color:note?'rgba(255,255,255,0.8)':'rgba(255,255,255,0.3)',fontSize:13,lineHeight:1.6,fontStyle:note?'normal':'italic'}}>{note||'No notes yet — tap Edit to add your takeaways'}</p>}
        </div>
        {onNext&&<div style={{padding:'0 16px 24px'}}><button onClick={onNext} style={{width:'100%',padding:'11px',borderRadius:10,backgroundColor:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.15)',color:'#fff',fontWeight:700,fontSize:13.5,cursor:'pointer'}}>Next video ›</button></div>}
      </div>
    </div>
  );
}

// ─── Home tab ─────────────────────────────────────────────────────────────────
function HomeTab({onPlay,onBrowse}:{onPlay:(item:any,list?:any[])=>void;onBrowse:(cat:string)=>void}){
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
  if(loading)return <Spinner/>;
  if(stats.total===0)return <Empty icon="📚" title="Library is empty" sub="Videos sync when connected to the server — tap ↻"/>;
  const cell=(n:number,label:string,first?:boolean)=>(
    <div style={{flex:1,padding:'7px 4px',textAlign:'center',borderLeft:first?'none':`1px solid ${C.border}`}}>
      <div style={{fontSize:16,fontWeight:900,color:C.green}}>{n.toLocaleString('en-IN')}</div>
      <div style={{fontSize:9.5,fontWeight:700,color:C.muted,textTransform:'uppercase',letterSpacing:'0.4px'}}>{label}</div>
    </div>
  );
  return(<>
    {/* Progress */}
    <div style={CARD}>
      <div style={{display:'flex'}}>
        {cell(stats.total,'Videos',true)}{cell(stats.watched,'Watched')}{cell(stats.bookmarks,'Saved')}{cell(stats.assigned,'Tasks')}
      </div>
      <div style={{padding:'0 12px 9px'}}>
        <div style={{backgroundColor:'#eef2ef',borderRadius:4,height:6,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${pct}%`,backgroundColor:C.gold,borderRadius:4}}/>
        </div>
        <div style={{fontSize:10.5,color:C.muted,marginTop:3,textAlign:'right'}}>{pct}% of the library watched</div>
      </div>
    </div>

    {assigned.length>0&&<><SectionLabel>📋 Assigned to you</SectionLabel><VList items={assigned} onPlay={onPlay} showCat/></>}
    {recent.length>0&&<><SectionLabel>▶ Recently watched</SectionLabel><VList items={recent} onPlay={onPlay} showCat/></>}

    {cats.length>0&&(<>
      <SectionLabel action="All videos" onAction={()=>onBrowse('All')}>📂 Categories</SectionLabel>
      <div style={CARD}>
        {cats.map((c:any,i:number)=>{
          const cp=c.total>0?Math.round((c.watched/c.total)*100):0;
          return(
            <button key={c.category} onClick={()=>onBrowse(c.category)} style={{width:'100%',display:'flex',alignItems:'center',gap:10,padding:'9px 12px',
              background:'none',border:'none',borderTop:i?`1px solid ${C.border}`:'none',cursor:'pointer',textAlign:'left'}}>
              <span style={{width:10,height:10,borderRadius:'50%',backgroundColor:catClr(c.category),flexShrink:0}}/>
              <span style={{flex:1,minWidth:0}}>
                <span style={{display:'block',fontWeight:800,fontSize:13.5,color:C.text,textTransform:'capitalize'}}>{c.category}</span>
                <span style={{display:'block',fontSize:11,color:C.muted}}>{c.total} video{c.total!==1?'s':''}{c.watched>0?` · ${c.watched} watched`:''}</span>
                <span style={{display:'block',marginTop:4,backgroundColor:'#eef2ef',borderRadius:3,height:4,overflow:'hidden'}}>
                  <span style={{display:'block',height:'100%',width:`${cp}%`,backgroundColor:catClr(c.category)}}/>
                </span>
              </span>
              <span style={{color:C.muted,fontSize:15}}>›</span>
            </button>
          );
        })}
      </div>
    </>)}
  </>);
}

// ─── Browse tab ───────────────────────────────────────────────────────────────
function BrowseTab({onPlay,initialCat}:{onPlay:(item:any,list:any[])=>void;initialCat:string}){
  const [cats,setCats]=useState<{category:string;total:number}[]>([]);
  const [cat,setCat]=useState(initialCat);
  const [items,setItems]=useState<any[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const base=bld(localStorage.getItem('server_ip')??'');

  useEffect(()=>{getLibraryCategoryStats().then(setCats).catch(()=>{});},[]);

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

  const fetchPage=useCallback(async(c:string,p:number)=>{
    setLoading(true);setError('');
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
      // No local data — fetch this page from server
      const ps=new URLSearchParams({limit:String(PAGE),offset:String((p-1)*PAGE)});
      if(c!=='All')ps.set('category',c);
      const r=await fetch(`${base}/api/data/library?${ps}`,{headers:hdr()});
      if(!r.ok){setError(`Server error ${r.status}`);return;}
      const j=await r.json();
      if(j.data?.length)await upsertLibraryItems(j.data);
      const fresh=await getLibraryWithActivity(catArg,PAGE,(p-1)*PAGE);
      const cnt=await countLibrary(catArg);
      setItems(fresh);setTotal(cnt);setPage(p);
    }catch{setError('Could not connect to the server');}
    finally{setLoading(false);}
  },[base,checkLatest]);

  // Load on category change; re-check latest every 60 min while open
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
  const allCount=cats.reduce((a,c)=>a+(c.total||0),0);
  const chips=[{category:'All',total:allCount},...cats];

  return(<>
    <div style={{display:'flex',gap:5,overflowX:'auto',scrollbarWidth:'none'}}>
      {chips.map(c=>(
        <button key={c.category} onClick={()=>setCat(c.category)} aria-pressed={cat===c.category}
          style={{flexShrink:0,padding:'5px 11px',borderRadius:16,cursor:'pointer',fontWeight:700,fontSize:11.5,
            border:`1px solid ${cat===c.category?C.green:C.border}`,backgroundColor:cat===c.category?C.green:'#fff',color:cat===c.category?'#fff':'#374151'}}>
          {c.category}{c.total?<span style={{opacity:0.7}}> {c.total}</span>:null}
        </button>
      ))}
    </div>
    {loading&&<Spinner/>}
    {error&&<div style={{padding:'8px 12px',borderRadius:10,backgroundColor:'#fef3c7',border:'1px solid #fcd34d',fontWeight:700,fontSize:12.5,color:'#92400e'}}>⚠ {error}</div>}
    {!loading&&!error&&items.length===0&&<Empty icon="📭" title={`No videos in ${cat}`}/>}
    {!loading&&items.length>0&&<VList items={items} onPlay={onPlay} showCat={cat==='All'}/>}
    {!loading&&pages>1&&<Pager page={page} pages={pages} onPrev={()=>fetchPage(cat,page-1)} onNext={()=>fetchPage(cat,page+1)}/>}
  </>);
}

// ─── Saved tab ────────────────────────────────────────────────────────────────
function SavedTab({onPlay}:{onPlay:(item:any,list:any[])=>void}){
  const [items,setItems]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{getBookmarks().then(b=>{setItems(b);setLoading(false);});},[]);
  if(loading)return <Spinner/>;
  if(!items.length)return <Empty icon="🔖" title="No saved videos" sub="Tap 🔖 Save while watching to keep a video here"/>;
  return(<>
    <SectionLabel>{items.length} saved video{items.length!==1?'s':''}</SectionLabel>
    <VList items={items} onPlay={onPlay} showCat/>
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

  return(<>
    <div style={{position:'relative'}}>
      <span style={{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',fontSize:14}}>🔍</span>
      <input autoFocus value={q} onChange={e=>handleInput(e.target.value)} placeholder="Search videos, drills, techniques…" aria-label="Search the library"
        style={{width:'100%',padding:'9px 34px 9px 34px',borderRadius:10,border:`1px solid ${C.border}`,fontSize:14,outline:'none',boxSizing:'border-box',backgroundColor:'#fff'}}/>
      {q&&<button onClick={()=>handleInput('')} aria-label="Clear search" style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:15,color:C.muted}}>✕</button>}
    </div>
    {!q&&<Empty icon="🔍" title="Search the library" sub="Find drills, techniques and coaching tips"/>}
    {loading&&<div style={{textAlign:'center',padding:'24px 0',color:C.muted,fontSize:13}}>Searching…</div>}
    {!loading&&q&&results.length===0&&<Empty icon="📭" title={`No results for "${q}"`}/>}
    {!loading&&results.length>0&&<><SectionLabel>{total} result{total!==1?'s':''}</SectionLabel><VList items={results} onPlay={onPlay} showCat/></>}
    {!loading&&pages>1&&<Pager page={page} pages={pages} onPrev={()=>search(q,page-1)} onNext={()=>search(q,page+1)}/>}
  </>);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const NAV:[Tab,string,string][]=[['home','🏠','Home'],['browse','📂','Browse'],['saved','🔖','Saved'],['search','🔍','Search']];

export default function LibraryScreen(){
  const [tab,setTab]=useState<Tab>('home');
  const [browseCat,setBrowseCat]=useState('All');
  const [refreshKey,setRefreshKey]=useState(0);   // bump → Home/Saved reload from the local DB
  const [syncKey,setSyncKey]=useState(0);         // bump → Browse reloads (only after a sync, so its page is kept)
  const [playing,setPlaying]=useState<any|null>(null);
  const [playlist,setPlaylist]=useState<any[]>([]);
  const [syncStatus,setSyncStatus]=useState<'idle'|'syncing'|'done'|'error'>('idle');
  const [syncProgress,setSyncProgress]=useState({fetched:0,total:0});
  const base=bld(localStorage.getItem('server_ip')??'');

  const runSync=()=>{
    setSyncStatus('syncing');
    setSyncProgress({fetched:0,total:0});
    syncLibraryFromServer(base,hdr(),(fetched,total)=>{
      setSyncProgress({fetched,total});
    }).then(({fetched,total})=>{
      setSyncProgress({fetched,total});
      setSyncStatus(fetched>0?'done':'idle');
      if(fetched>0){setRefreshKey(k=>k+1);setSyncKey(k=>k+1);}
      setTimeout(()=>setSyncStatus('idle'),3000);
    }).catch(()=>{
      setSyncStatus('error');
      setTimeout(()=>setSyncStatus('idle'),3000);
    });
  };

  // Background sync on open — pulls ALL videos if not synced in the last hour
  useEffect(()=>{
    if(libraryMinutesSinceSync()<60)return;
    runSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const handleRefresh=()=>{if(syncStatus!=='syncing')runSync();};
  const handlePlay=(item:any,list:any[]=[])=>{setPlaying(item);setPlaylist(list);};
  const closePlayer=()=>{setPlaying(null);setPlaylist([]);setRefreshKey(k=>k+1);};   // watched / saved state may have changed
  const openBrowse=(cat:string)=>{setBrowseCat(cat);setTab('browse');};
  const idx=playing?playlist.findIndex(v=>v.video_id===playing.video_id):-1;
  const nextOk=idx>=0&&idx<playlist.length-1;
  const handleNext=()=>{if(nextOk)setPlaying(playlist[idx+1]);};

  return(
    <>
      <div style={{backgroundColor:C.bg,minHeight:'100%',paddingBottom:24,fontFamily:'sans-serif',color:C.text}}>
        <ScreenHeader title="Coaching Library"
          subtitle={syncStatus==='syncing'
            ? `⟳ Syncing… ${syncProgress.fetched}${syncProgress.total>0?' / '+syncProgress.total:''} videos`
            : syncStatus==='done'
            ? `✔ ${syncProgress.fetched} videos synced`
            : syncStatus==='error'
            ? '⚠ Sync failed — tap ↻ to retry'
            : 'Videos · drills · techniques'}
          actions={<HeaderIconButton label="Sync library" onClick={handleRefresh} disabled={syncStatus==='syncing'}>
            {syncStatus==='syncing'?'⟳':syncStatus==='done'?'✔':'↻'}
          </HeaderIconButton>}>
          <HeaderTabs value={tab} onChange={(t)=>{if(t==='browse')setBrowseCat('All');setTab(t);}}
            tabs={NAV.map(([id,icon,label])=>({id,label:`${icon} ${label}`}))} />
        </ScreenHeader>
        <div style={{padding:10,display:'flex',flexDirection:'column',gap:8}}>
          {tab==='home'&&<HomeTab key={refreshKey} onPlay={handlePlay} onBrowse={openBrowse}/>}
          {tab==='browse'&&<BrowseTab key={`${browseCat}-${syncKey}`} initialCat={browseCat} onPlay={handlePlay}/>}
          {tab==='saved'&&<SavedTab key={refreshKey} onPlay={handlePlay}/>}
          {tab==='search'&&<SearchTab onPlay={handlePlay}/>}
        </div>
      </div>
      {playing&&<Player item={playing} onClose={closePlayer} onNext={nextOk?handleNext:undefined}/>}
    </>
  );
}
