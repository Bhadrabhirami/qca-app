/**
 * Matches — Cricket scorecard
 * Score offline → Push when online
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import {
  getActiveStudents,
  createLocalMatch, updateLocalMatchStatus, updateMatchMeta,
  getLocalMatches, getLocalMatch,
  saveLocalLineup, upsertLocalStats, upsertLocalInnings,
  upsertOppBatting, upsertOppBowling, getOppData, updateOppTotals,
  getUnsyncedMatches, markMatchSynced, markMatchUnsynced, buildMatchSyncPayload,
  deleteLocalMatch, importServerMatch, refreshMatchFromServer, importMatchExtras,
  addPlayerToMatch, removePlayerFromMatch,
  saveFallOfWicket, getFallOfWickets,
} from '../database/db';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

// ─── Constants ────────────────────────────────────────────────────
const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e0e0e0', gray:'#888', red:'#c0392b', navy:'#001f3f', muted:'#6b7280' };
const HOW_OUT   = ['Not Out','Bowled','Caught','LBW','Run Out','Stumped','Hit Wicket','Retired'];
const M_TYPES   = ['Friendly','T20','ODI','Test','Tournament','Practice'];
const OV_OPTS   = [5,10,15,20,25,30,35,40,45,50];
const INP: React.CSSProperties = { width:'100%', borderRadius:8, border:`1px solid ${C.border}`, padding:'10px 12px', fontSize:14, boxSizing:'border-box' as const };

function buildBase(ip:string){
  const u=(ip||'').trim().replace(/\/+$/,'');
  if(!u) return '';
  return u.startsWith('http')?u:`http://${u}`;
}
function hdrs() {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) { window.dispatchEvent(new Event('jwt-expired')); return {}; }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return {
    'Content-Type': 'application/json',
    'X-Username':   localStorage.getItem('auth_user') ?? '',
    'X-Password':   localStorage.getItem('auth_pass') ?? '',
  };
}

// ─── Sub-components ────────────────────────────────────────────────

function ScoreTab({ match, students, can, refresh }: { match:any; students:any[]; can:(s:string)=>boolean; refresh:()=>void }) {
  const [innings, setInnings] = useState<any>(null);
  const [lineup,  setLineup]  = useState<any[]>([]);
  const [stats,   setStats]   = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg,     setMsg]     = useState('');

  useEffect(() => {
    if (!match) return;
    loadData();
  }, [match?.id]);

  const loadData = async () => {
    if (!match) return;
    setLoading(true);
    try {
      const m = await getLocalMatch(match.id);
      if (m) {
        setInnings(m.innings);
        setLineup(m.lineup || []);
        setStats(m.stats || []);
      }
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const flash = (m:string) => { setMsg(m); setTimeout(()=>setMsg(''),3000); };

  if (!match) return (
    <div style={{padding:24,textAlign:'center',color:C.muted}}>
      Select a match from the List tab to score
    </div>
  );

  return (
    <div style={{padding:16}}>
      {msg && <div style={{backgroundColor:'#e8f5e9',borderRadius:8,padding:'8px 12px',marginBottom:12,color:C.green,fontWeight:700}}>{msg}</div>}
      <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
        <div style={{fontWeight:800,fontSize:15,color:C.navy,marginBottom:4}}>{match.match_type} — {match.match_date}</div>
        <div style={{fontSize:13,color:C.muted}}>QCA vs {match.opponent_name}</div>
        <div style={{fontSize:13,color:match.status==='completed'?C.green:C.gold,fontWeight:700,marginTop:4}}>
          Status: {match.status || 'scheduled'}
        </div>
        {match.result && <div style={{fontSize:13,color:C.green,marginTop:4}}>Result: {match.result}</div>}
      </div>

      {/* Innings Summary */}
      {innings && (
        <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
          <div style={{fontWeight:800,fontSize:14,color:C.navy,marginBottom:12}}>📊 Innings</div>
          {[1,2].map(n => {
            const inn = innings[`innings_${n}`];
            if (!inn) return null;
            return (
              <div key={n} style={{marginBottom:8,padding:'10px 12px',backgroundColor:'#f8f9fa',borderRadius:8}}>
                <div style={{fontWeight:700,fontSize:13}}>{n===1?'1st':'2nd'} Innings — {inn.batting_team}</div>
                <div style={{fontSize:13,color:C.muted,marginTop:4}}>
                  {inn.total_runs || 0}/{inn.total_wickets || 0} ({inn.total_overs || 0} overs)
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lineup */}
      {lineup.length > 0 && (
        <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
          <div style={{fontWeight:800,fontSize:14,color:C.navy,marginBottom:12}}>🏏 Playing XI</div>
          {lineup.map((p:any) => (
            <div key={p.student_id} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:13}}>{p.name || p.student_name}</span>
              <span style={{fontSize:12,color:C.muted}}>{p.role||''}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      {stats.length > 0 && (
        <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
          <div style={{fontWeight:800,fontSize:14,color:C.navy,marginBottom:12}}>📈 Performance Stats</div>
          {stats.map((s:any) => (
            <div key={s.student_id} style={{padding:'8px 0',borderBottom:`1px solid ${C.border}`}}>
              <div style={{fontWeight:700,fontSize:13}}>{s.name || s.student_name}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>
                {s.runs_scored != null && `Bat: ${s.runs_scored}(${s.balls_faced||0}b) `}
                {s.wickets_taken != null && `Bowl: ${s.wickets_taken}/${s.runs_conceded||0}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ListTab({ matches, onSelect, selectedId, can, refresh }: {
  matches:any[]; onSelect:(m:any)=>void; selectedId:number|null;
  can:(s:string)=>boolean; refresh:()=>void;
}) {
  const [deleting, setDeleting] = useState<number|null>(null);

  const handleDelete = async (id:number) => {
    if (!window.confirm('Delete this match?')) return;
    setDeleting(id);
    try { await deleteLocalMatch(id); refresh(); } catch(e) { console.error(e); }
    setDeleting(null);
  };

  if (matches.length === 0) return (
    <div style={{padding:24,textAlign:'center',color:C.muted}}>
      <div style={{fontSize:40,marginBottom:12}}>🏏</div>
      <div style={{fontWeight:700}}>No matches yet</div>
      <div style={{fontSize:13,marginTop:8}}>Create a new match to get started</div>
    </div>
  );

  return (
    <div style={{padding:16}}>
      {matches.map(m => (
        <div key={m.id}
          onClick={()=>onSelect(m)}
          style={{
            backgroundColor:selectedId===m.id?'#e8f5e9':'#fff',
            borderRadius:12, padding:16, marginBottom:10,
            boxShadow:'0 1px 4px rgba(0,0,0,0.08)',
            border:`2px solid ${selectedId===m.id?C.green:'transparent'}`,
            cursor:'pointer',
          }}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <div style={{fontWeight:800,fontSize:14,color:C.navy}}>
                {m.match_type} — {m.match_date}
              </div>
              <div style={{fontSize:13,color:C.muted,marginTop:2}}>vs {m.opponent_name}</div>
              {m.venue && <div style={{fontSize:12,color:C.muted}}>{m.venue}</div>}
            </div>
            <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:4}}>
              <span style={{
                fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:10,
                backgroundColor:m.status==='completed'?'#e8f5e9':m.status==='in_progress'?'#fef3c7':'#f3f4f6',
                color:m.status==='completed'?C.green:m.status==='in_progress'?'#92400e':C.muted,
              }}>{m.status||'scheduled'}</span>
              {m.synced===0 && <span style={{fontSize:10,color:C.gold}}>⚠ Unsynced</span>}
            </div>
          </div>
          {m.result && <div style={{fontSize:12,color:C.green,marginTop:6,fontWeight:700}}>{m.result}</div>}
          {can('matches:delete') && (
            <button onClick={e=>{e.stopPropagation();handleDelete(m.id);}}
              disabled={deleting===m.id}
              style={{marginTop:8,padding:'4px 10px',borderRadius:6,border:'none',
                backgroundColor:'#fee2e2',color:C.red,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              🗑 {deleting===m.id?'Deleting…':'Delete'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function NewMatchTab({ students, can, onCreated }: {
  students:any[]; can:(s:string)=>boolean; onCreated:()=>void;
}) {
  const [form, setForm] = useState({
    match_date: new Date().toISOString().split('T')[0],
    opponent_name: '', venue: '', match_type: 'T20',
    total_overs: 20, toss_winner: 'QCA', toss_decision: 'bat',
  });
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState('');

  const setF = (k:string,v:any) => setForm(p=>({...p,[k]:v}));

  const submit = async () => {
    if (!form.opponent_name.trim()) { setMsg('⚠ Opponent name required'); return; }
    setSaving(true);
    try {
      await createLocalMatch({
        ...form,
        total_overs: Number(form.total_overs),
        status: 'scheduled',
        synced: 0,
      });
      setMsg('✅ Match created!');
      setTimeout(()=>{ onCreated(); },1000);
    } catch(e:any) { setMsg('⚠ '+e.message); }
    setSaving(false);
  };

  if (!can('matches:create')) return (
    <div style={{padding:24,textAlign:'center',color:C.muted}}>
      You don't have permission to create matches
    </div>
  );

  return (
    <div style={{padding:16}}>
      {msg && <div style={{backgroundColor:msg.startsWith('✅')?'#e8f5e9':'#fef2f2',borderRadius:8,padding:'8px 12px',marginBottom:12,color:msg.startsWith('✅')?C.green:C.red,fontWeight:700}}>{msg}</div>}

      <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
        <div style={{fontWeight:800,fontSize:15,color:C.navy,marginBottom:16}}>🏏 New Match</div>

        {[
          {label:'Match Date',type:'date',key:'match_date'},
          {label:'Opponent',type:'text',key:'opponent_name',placeholder:'e.g. Kerala XI'},
          {label:'Venue',type:'text',key:'venue',placeholder:'Ground name'},
        ].map(f=>(
          <div key={f.key} style={{marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>{f.label}</div>
            <input type={f.type} value={(form as any)[f.key]}
              onChange={e=>setF(f.key,e.target.value)}
              placeholder={f.placeholder}
              style={INP}/>
          </div>
        ))}

        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Match Type</div>
          <div style={{display:'flex',flexWrap:'wrap' as const,gap:6}}>
            {M_TYPES.map(t=>(
              <button key={t} onClick={()=>setF('match_type',t)}
                style={{padding:'6px 12px',borderRadius:8,border:'none',cursor:'pointer',fontWeight:700,fontSize:12,
                  backgroundColor:form.match_type===t?C.green:'#f0f0f0',
                  color:form.match_type===t?'#fff':'#555'}}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Overs</div>
          <div style={{display:'flex',flexWrap:'wrap' as const,gap:6}}>
            {OV_OPTS.map(o=>(
              <button key={o} onClick={()=>setF('total_overs',o)}
                style={{padding:'6px 10px',borderRadius:8,border:'none',cursor:'pointer',fontWeight:700,fontSize:12,
                  backgroundColor:form.total_overs===o?C.green:'#f0f0f0',
                  color:form.total_overs===o?'#fff':'#555'}}>
                {o}
              </button>
            ))}
          </div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Toss Won By</div>
            <div style={{display:'flex',gap:6}}>
              {['QCA',form.opponent_name||'Opp'].map((t,i)=>(
                <button key={i} onClick={()=>setF('toss_winner',i===0?'QCA':form.opponent_name)}
                  style={{flex:1,padding:'8px 0',borderRadius:8,border:'none',cursor:'pointer',fontWeight:700,fontSize:12,
                    backgroundColor:(i===0?'QCA':form.opponent_name)===form.toss_winner?C.green:'#f0f0f0',
                    color:(i===0?'QCA':form.opponent_name)===form.toss_winner?'#fff':'#555'}}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:4,textTransform:'uppercase' as const}}>Decided To</div>
            <div style={{display:'flex',gap:6}}>
              {['bat','field'].map(d=>(
                <button key={d} onClick={()=>setF('toss_decision',d)}
                  style={{flex:1,padding:'8px 0',borderRadius:8,border:'none',cursor:'pointer',fontWeight:700,fontSize:12,
                    backgroundColor:form.toss_decision===d?C.green:'#f0f0f0',
                    color:form.toss_decision===d?'#fff':'#555'}}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button onClick={submit} disabled={saving}
          style={{width:'100%',padding:14,borderRadius:12,border:'none',
            backgroundColor:C.green,color:'#fff',fontWeight:800,fontSize:15,cursor:'pointer'}}>
          {saving?'Creating…':'✅ Create Match'}
        </button>
      </div>
    </div>
  );
}

function SyncTab({ matches, can, refresh }: { matches:any[]; can:(s:string)=>boolean; refresh:()=>void }) {
  const [syncing, setSyncing]   = useState(false);
  const [results, setResults]   = useState<string[]>([]);
  const [pulling, setPulling]   = useState(false);
  const base = buildBase(localStorage.getItem('server_ip')||'');

  const unsynced = matches.filter(m=>m.synced===0);

  const pushAll = async () => {
    if (!can('matches:edit')) { setResults(['⚠ No permission to sync']); return; }
    setSyncing(true);
    setResults(['Starting upload…']);
    const logs: string[] = [];
    for (const m of unsynced) {
      try {
        const payload = await buildMatchSyncPayload(m.id);
        if (!payload) { logs.push(`⚠ Match ${m.id}: not found locally`); continue; }
        const res = await fetch(`${base}/api/data/matches/save`, {
          method:'POST', headers:{ ...hdrs(), 'Content-Type':'application/json' }, body:JSON.stringify(payload),
        });
        if (res.ok) {
          const j = await res.json().catch(()=>({}));
          if (!j.match_id) { logs.push(`⚠ Match ${m.id}: server did not return an id`); continue; }
          await markMatchSynced(m.id, j.match_id);
          logs.push(`✅ Match ${m.id} synced (server #${j.match_id})`);
        } else {
          const j = await res.json().catch(()=>({}));
          logs.push(`⚠ Match ${m.id}: ${j.error||res.status}`);
        }
      } catch(e:any) { logs.push(`⚠ Match ${m.id}: ${e.message}`); }
    }
    setResults(logs);
    setSyncing(false);
    refresh();   // pending count + synced badges
  };

  const pullFromServer = async () => {
    setPulling(true);
    setResults(['Pulling from server…']);
    try {
      const res = await fetch(`${base}/api/data/matches`, { headers:hdrs() });
      if (res.ok) {
        const j = await res.json();
        const serverMatches = j.data || [];
        const logs: string[] = [];
        for (const sm of serverMatches) {
          // Never overwrite a match edited on this device but not uploaded yet
          const local = matches.find(m => String(m.local_id) === String(sm.match_id) || Number(m.server_match_id) === Number(sm.match_id));
          if (local && Number(local.synced) === 0) { logs.push(`⏸ ${sm.opponent_name}: kept local unsynced changes`); continue; }
          // The list has headers only — the detail call carries players, the
          // opponent scorecard and extras. Import all of them: the server
          // rebuilds each from the upload payload, so a partial copy would
          // erase server data on the next upload.
          const d = await fetch(`${base}/api/data/matches/${sm.match_id}`, { headers:hdrs() });
          if (!d.ok) { logs.push(`⚠ ${sm.opponent_name}: details unavailable (${d.status})`); continue; }
          const det = await d.json();
          const localId = await importServerMatch(det.match || sm, det.players || []);
          await refreshMatchFromServer(localId, det.match || sm, det.players || [], det.opp_bat || [], det.opp_bowl || []);
          await importMatchExtras(localId, det.extras || []);
        }
        setResults([`✅ Pulled ${serverMatches.length - logs.length} of ${serverMatches.length} matches from server`, ...logs]);
      } else {
        setResults(['⚠ Failed to pull from server']);
      }
    } catch(e:any) { setResults([`⚠ ${e.message}`]); }
    setPulling(false);
    refresh();   // show the imported matches in the list
  };

  return (
    <div style={{padding:16}}>
      <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
        <div style={{fontWeight:800,fontSize:14,color:C.navy,marginBottom:12}}>☁ Sync Status</div>
        <div style={{fontSize:13,color:C.muted,marginBottom:12}}>
          {unsynced.length} match{unsynced.length!==1?'es':''} pending upload
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={pushAll} disabled={syncing||unsynced.length===0}
            style={{flex:1,padding:12,borderRadius:10,border:'none',cursor:'pointer',fontWeight:700,fontSize:13,
              backgroundColor:unsynced.length>0?C.green:'#e5e7eb',color:unsynced.length>0?'#fff':C.muted}}>
            {syncing?'Uploading…':'⬆ Upload to Server'}
          </button>
          <button onClick={pullFromServer} disabled={pulling}
            style={{flex:1,padding:12,borderRadius:10,border:`1px solid ${C.green}`,cursor:'pointer',fontWeight:700,fontSize:13,
              backgroundColor:'#fff',color:C.green}}>
            {pulling?'Pulling…':'⬇ Pull from Server'}
          </button>
        </div>
      </div>
      {results.length > 0 && (
        <div style={{backgroundColor:'#fff',borderRadius:12,padding:16,boxShadow:'0 1px 4px rgba(0,0,0,0.08)'}}>
          {results.map((r,i)=>(
            <div key={i} style={{fontSize:13,padding:'4px 0',color:r.startsWith('✅')?C.green:C.red}}>{r}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Error Boundary ────────────────────────────────────────────────
class MatchErrorBoundary extends React.Component<{children:React.ReactNode},{hasError:boolean,err:string}> {
  constructor(p:any){super(p);this.state={hasError:false,err:''};}
  static getDerivedStateFromError(e:any){return{hasError:true,err:String(e?.message||e)};}
  render(){
    if(this.state.hasError) return(
      <div style={{padding:24,textAlign:'center'}}>
        <div style={{fontSize:32,marginBottom:12}}>⚠</div>
        <div style={{fontWeight:700,color:C.red,marginBottom:8}}>Something went wrong</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:16}}>{this.state.err}</div>
        <button onClick={()=>this.setState({hasError:false,err:''})}
          style={{padding:'8px 16px',borderRadius:8,border:'none',backgroundColor:C.green,color:'#fff',cursor:'pointer'}}>
          Try Again
        </button>
      </div>
    );
    return this.props.children;
  }
}

// ─── Main Screen ───────────────────────────────────────────────────
export default function MatchesScreen(){
  const navigate=useNavigate();
  const { can } = usePermissions();
  const [tab, setTab] = useState<'score'|'list'|'new'|'sync'>('list');
  const [students,setStudents]=useState<any[]>([]);
  const [matches, setMatches] =useState<any[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);

  const refresh=useCallback(async()=>{setMatches(await getLocalMatches());},[]);

  useEffect(()=>{
    refresh();
    if (can('matches:score') || can('matches:create')) {
      const base=buildBase(localStorage.getItem('server_ip')||'');
      const H=hdrs();
      fetch(`${base}/api/data/students?limit=500`,{headers:H}).then(r=>r.ok?r.json():null).then(j=>{
        if(j?.data) setStudents(j.data);
      }).catch(()=>{});
    }
  },[]);

  const unsynced = matches.filter(m=>m.synced===0).length;

  const TABS: Array<['score'|'list'|'new'|'sync', string]> = [
    ['list',  '📋 Matches'],
    ['score', '🏏 Score'],
    ...(can('matches:create') ? [['new', '➕ New'] as ['new', string]] : []),
    ...(can('matches:edit')   ? [['sync', `☁${unsynced>0?` (${unsynced})`:''}`] as ['sync', string]] : []),
  ];

  return(
    <MatchErrorBoundary>
    <div style={{backgroundColor:C.bg,minHeight:'100vh',fontFamily:'sans-serif',paddingBottom:80}}>
      <ScreenHeader title="🏏 Matches" background={C.navy}>
        <HeaderTabs color={C.navy} value={tab} onChange={setTab} tabs={TABS.map(([id,label])=>({id,label}))} />
      </ScreenHeader>

      {/* Content */}
      {tab==='list' && (
        <ListTab
          matches={matches}
          onSelect={m=>{setSelectedMatch(m);setTab('score');}}
          selectedId={selectedMatch?.id||null}
          can={can}
          refresh={refresh}
        />
      )}
      {tab==='score' && (
        <ScoreTab match={selectedMatch} students={students} can={can} refresh={refresh}/>
      )}
      {tab==='new' && (
        <NewMatchTab students={students} can={can} onCreated={()=>{refresh();setTab('list');}}/>
      )}
      {tab==='sync' && (
        <SyncTab matches={matches} can={can} refresh={refresh}/>
      )}
    </div>
    </MatchErrorBoundary>
  );
}
