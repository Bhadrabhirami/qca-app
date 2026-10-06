/**
 * Matches — fixtures, results and scorecards
 * Create offline → upload when online; pull results scored on the web portal.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { usePermissions } from './usePermissions';
import {
  createLocalMatch, getLocalMatches, getLocalMatch, getOppData, getFallOfWickets,
  markMatchSynced, buildMatchSyncPayload,
  deleteLocalMatch, importServerMatch, refreshMatchFromServer, importMatchExtras,
} from '../database/db';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

// ─── Constants ────────────────────────────────────────────────────
const C = { green:'#1a472a', gold:'#d4af37', bg:'#f4f7f6', border:'#e8e8e8', red:'#c0392b', muted:'#6b7280', text:'#1f2937' };
const CARD: React.CSSProperties = { backgroundColor:'#fff', borderRadius:12, border:`1px solid ${C.border}`, overflow:'hidden' };
const M_TYPES = ['Friendly','T20','ODI','Test','Tournament','Practice'];
const OV_OPTS = [5,10,15,20,25,30,35,40,45,50];
const INP: React.CSSProperties = { width:'100%', borderRadius:8, border:`1px solid ${C.border}`, padding:'8px 10px', fontSize:14, boxSizing:'border-box', outline:'none', backgroundColor:'#fff' };
const LBL: React.CSSProperties = { fontSize:10.5, fontWeight:800, color:C.muted, marginBottom:4, textTransform:'uppercase', letterSpacing:'0.5px' };

function buildBase(ip:string){
  const u=(ip||'').trim().replace(/\/+$/,'');
  if(!u) return '';
  return u.startsWith('http')?u:`http://${u}`;
}
function hdrs(): Record<string,string> {
  const jwt = localStorage.getItem('jwt_token');
  const exp = parseInt(localStorage.getItem('jwt_expiry') || '0');
  if (jwt && exp) {
    if (Date.now() > exp) { window.dispatchEvent(new Event('jwt-expired')); return {}; }
    return {'Content-Type':'application/json','Authorization':'Bearer '+jwt,'X-Username':localStorage.getItem('auth_user')||''};
  }
  return { 'Content-Type':'application/json', 'X-Username': localStorage.getItem('auth_user') ?? '' };
}

// Local rows use match_status / result_status; older shapes used status / result
const statusOf = (m:any) => String(m?.match_status || m?.status || 'Scheduled');
const resultOf = (m:any) => m?.result_status || m?.result || '';
const fmtDay = (s:string) => {
  const d = new Date(String(s||'').slice(0,10)+'T00:00:00');
  return isNaN(d.getTime()) ? { day:'—', mon:'', full:s||'—' }
    : { day:String(d.getDate()), mon:d.toLocaleDateString('en-GB',{month:'short'}), full:d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'}) };
};
const score = (r:any, w:any, o:any) => (r == null || r === '') ? '—' : `${r}/${w ?? 0}${o != null && o !== '' ? ` (${o})` : ''}`;

function StatusChip({ m }: { m:any }) {
  const st = statusOf(m).toLowerCase();
  const res = String(resultOf(m)).toLowerCase();
  const [bg, fg, label] =
    res === 'won'  ? ['#dcfce7','#166534','Won'] :
    res === 'lost' ? ['#fee2e2','#b91c1c','Lost'] :
    res && res !== 'pending' ? ['#f3f4f6','#374151', resultOf(m)] :
    st.includes('live') || st.includes('progress') ? ['#fef3c7','#92400e','Live'] :
    st.includes('complete') ? ['#e0f2fe','#075985','Completed'] :
    ['#f3f4f6',C.muted, statusOf(m)];
  return <span style={{ fontSize:10.5, fontWeight:800, padding:'2px 8px', borderRadius:8, backgroundColor:bg, color:fg, whiteSpace:'nowrap' }}>{label}</span>;
}

const SectionLabel = ({ children }: { children:React.ReactNode }) => (
  <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, letterSpacing:'0.8px', textTransform:'uppercase', margin:'6px 2px 0' }}>{children}</div>
);
const Empty = ({ icon, title, sub }: { icon:string; title:string; sub?:string }) => (
  <div style={{ ...CARD, padding:'26px 16px', textAlign:'center', color:C.muted }}>
    <div style={{ fontSize:30, marginBottom:6 }}>{icon}</div>
    <div style={{ fontWeight:800, fontSize:13.5, color:C.text }}>{title}</div>
    {sub && <div style={{ fontSize:12, marginTop:3 }}>{sub}</div>}
  </div>
);

// ─── Scorecard ─────────────────────────────────────────────────────
function ScorecardTab({ match }: { match:any }) {
  const [data,  setData]  = useState<any>(null);
  const [opp,   setOpp]   = useState<{batting:any[];bowling:any[]}>({ batting:[], bowling:[] });
  const [fow,   setFow]   = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!match) return;
    (async () => {
      setLoading(true);
      try {
        const [m, o, f] = await Promise.all([getLocalMatch(match.id), getOppData(match.id), getFallOfWickets(match.id)]);
        setData(m); setOpp(o || { batting:[], bowling:[] }); setFow(f || []);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [match?.id]);

  if (!match) return <Empty icon="📋" title="No match selected" sub="Pick a match in the Matches tab to see its scorecard" />;
  if (loading || !data) return <div style={{ textAlign:'center', padding:32, color:C.muted, fontSize:13 }}>Loading scorecard…</div>;

  const m = data.match || match;
  const d = fmtDay(m.match_date);
  const batters = (data.stats||[]).filter((s:any) => s.batting_done || (s.balls_faced||0) > 0 || (s.runs_scored||0) > 0);
  const bowlers = (data.stats||[]).filter((s:any) => (Number(s.overs_bowled)||0) > 0);
  const th: React.CSSProperties = { fontSize:10, fontWeight:800, color:C.muted, textAlign:'right', padding:'5px 4px', textTransform:'uppercase' };
  const td: React.CSSProperties = { fontSize:12.5, textAlign:'right', padding:'5px 4px', color:C.text };
  const tdName: React.CSSProperties = { fontSize:12.5, padding:'5px 4px 5px 12px', color:C.text, fontWeight:700 };

  const BatTable = ({ rows, nameKey }: { rows:any[]; nameKey:string }) => (
    <div style={CARD}>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead><tr style={{ backgroundColor:'#fafafa' }}>
          <th style={{ ...th, textAlign:'left', paddingLeft:12 }}>Batter</th><th style={th}>R</th><th style={th}>B</th><th style={th}>4s</th><th style={{ ...th, paddingRight:12 }}>6s</th>
        </tr></thead>
        <tbody>{rows.map((s:any,i:number) => (
          <tr key={i} style={{ borderTop:`1px solid ${C.border}` }}>
            <td style={tdName}>{s[nameKey]}<div style={{ fontSize:10.5, fontWeight:500, color:C.muted }}>{s.how_out || 'not out'}</div></td>
            <td style={{ ...td, fontWeight:900 }}>{s.runs_scored ?? 0}</td><td style={td}>{s.balls_faced ?? 0}</td>
            <td style={td}>{s.fours ?? 0}</td><td style={{ ...td, paddingRight:12 }}>{s.sixes ?? 0}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
  const BowlTable = ({ rows, nameKey }: { rows:any[]; nameKey:string }) => (
    <div style={CARD}>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead><tr style={{ backgroundColor:'#fafafa' }}>
          <th style={{ ...th, textAlign:'left', paddingLeft:12 }}>Bowler</th><th style={th}>O</th><th style={th}>R</th><th style={{ ...th, paddingRight:12 }}>W</th>
        </tr></thead>
        <tbody>{rows.map((s:any,i:number) => (
          <tr key={i} style={{ borderTop:`1px solid ${C.border}` }}>
            <td style={tdName}>{s[nameKey]}</td>
            <td style={td}>{s.overs_bowled ?? 0}</td><td style={td}>{s.runs_conceded ?? 0}</td>
            <td style={{ ...td, fontWeight:900, paddingRight:12 }}>{s.wickets_taken ?? 0}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  return (<>
    {/* Match header + score line */}
    <div style={CARD}>
      <div style={{ padding:'10px 12px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ flex:1, minWidth:0, fontWeight:900, fontSize:16, color:C.green }}>QCA <span style={{ color:C.muted, fontWeight:600 }}>vs</span> {m.opponent_name}</div>
          <StatusChip m={m} />
        </div>
        <div style={{ fontSize:11.5, color:C.muted, marginTop:2 }}>
          {[m.match_type, m.total_overs ? `${m.total_overs} overs` : '', d.full, m.venue].filter(Boolean).join(' · ')}
        </div>
        {m.toss_winner && <div style={{ fontSize:11.5, color:C.muted, marginTop:2 }}>🪙 {m.toss_winner} won the toss, chose to {m.toss_decision || 'bat'}</div>}
      </div>
      <div style={{ display:'flex', borderTop:`1px solid ${C.border}`, backgroundColor:'#fafafa' }}>
        {[['QCA', score(m.qca_total_runs, m.qca_total_wickets, m.qca_total_overs)],
          [m.opponent_name || 'Opponent', score(m.opp_total_runs, m.opp_total_wickets, m.opp_total_overs)]].map(([t,s],i) => (
          <div key={i} style={{ flex:1, padding:'8px 10px', textAlign:'center', borderLeft: i ? `1px solid ${C.border}` : 'none' }}>
            <div style={{ fontSize:10.5, fontWeight:800, color:C.muted, textTransform:'uppercase', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t}</div>
            <div style={{ fontSize:17, fontWeight:900, color:C.text }}>{s}</div>
          </div>
        ))}
      </div>
    </div>

    {/* Innings + extras */}
    {(data.innings||[]).length > 0 && (<>
      <SectionLabel>Innings</SectionLabel>
      <div style={CARD}>
        {(data.innings||[]).map((inn:any, i:number) => {
          const extras = ['extras_wides','extras_noballs','extras_byes','extras_legbyes','extras_penalty'].reduce((a,k) => a + (Number(inn[k])||0), 0);
          return (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
              <span style={{ fontSize:11, fontWeight:800, color:C.muted, width:26 }}>{inn.innings_no === 1 ? '1st' : inn.innings_no === 2 ? '2nd' : `#${inn.innings_no}`}</span>
              <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:700 }}>{inn.batting_team || '—'}</span>
              <span style={{ fontSize:13.5, fontWeight:900 }}>{score(inn.total_runs, inn.total_wickets, inn.total_overs)}</span>
              {extras > 0 && <span style={{ fontSize:10.5, color:C.muted }}>+{extras} ext</span>}
            </div>
          );
        })}
      </div>
    </>)}

    {batters.length > 0 && (<><SectionLabel>QCA batting</SectionLabel><BatTable rows={batters} nameKey="student_name" /></>)}
    {bowlers.length > 0 && (<><SectionLabel>QCA bowling</SectionLabel><BowlTable rows={bowlers} nameKey="student_name" /></>)}
    {opp.batting.length > 0 && (<><SectionLabel>{m.opponent_name} batting</SectionLabel><BatTable rows={opp.batting} nameKey="player_name" /></>)}
    {opp.bowling.length > 0 && (<><SectionLabel>{m.opponent_name} bowling</SectionLabel><BowlTable rows={opp.bowling} nameKey="player_name" /></>)}

    {fow.length > 0 && (<>
      <SectionLabel>Fall of wickets</SectionLabel>
      <div style={{ ...CARD, padding:'8px 12px', fontSize:12, color:C.text, lineHeight:1.7 }}>
        {fow.map((f:any,i:number) => <span key={i}>{i ? ' · ' : ''}{f.score ?? f.runs ?? '?'}-{f.wicket_no}{f.player_name || f.batter_name ? ` (${f.player_name || f.batter_name})` : ''}</span>)}
      </div>
    </>)}

    {(data.lineup||[]).length > 0 && batters.length === 0 && (<>
      <SectionLabel>Playing XI · {(data.lineup||[]).length}</SectionLabel>
      <div style={{ ...CARD, padding:10, display:'flex', flexWrap:'wrap', gap:5 }}>
        {(data.lineup||[]).map((p:any) => (
          <span key={p.student_id} style={{ fontSize:12, fontWeight:700, padding:'3px 9px', borderRadius:12, backgroundColor:'#f0f4f0', color:C.green }}>
            {p.student_name || p.name}{p.is_captain ? ' (c)' : ''}{p.is_wicketkeeper ? ' †' : ''}
          </span>
        ))}
      </div>
    </>)}

    {batters.length === 0 && bowlers.length === 0 && opp.batting.length === 0 && (
      <div style={{ fontSize:12, color:C.muted, textAlign:'center', padding:'4px 12px' }}>
        No ball-by-ball details on this phone yet. Scores entered on the web portal appear after ☁ Sync → Pull.
      </div>
    )}
  </>);
}

// ─── Match list ────────────────────────────────────────────────────
function ListTab({ matches, onSelect, can, refresh }: {
  matches:any[]; onSelect:(m:any)=>void; can:(s:string)=>boolean; refresh:()=>void;
}) {
  const [deleting, setDeleting] = useState<number|null>(null);
  const handleDelete = async (m:any) => {
    const note = Number(m.synced) === 0 ? 'It has NOT been uploaded and will be lost.' : 'The copy on the server is not affected.';
    if (!window.confirm(`Delete the match vs ${m.opponent_name} from this phone?\n${note}`)) return;
    setDeleting(m.id);
    try { await deleteLocalMatch(m.id); refresh(); } catch(e) { console.error(e); }
    setDeleting(null);
  };

  if (matches.length === 0) return <Empty icon="🏏" title="No matches yet" sub="Create one in ➕ New, or pull results in ☁ Sync" />;

  const won  = matches.filter(m => String(resultOf(m)).toLowerCase() === 'won').length;
  const lost = matches.filter(m => String(resultOf(m)).toLowerCase() === 'lost').length;
  const cell = (n:number, label:string, color:string, first?:boolean) => (
    <div style={{ flex:1, padding:'6px 4px', textAlign:'center', borderLeft: first ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize:16, fontWeight:900, color }}>{n}</div>
      <div style={{ fontSize:9.5, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'0.4px' }}>{label}</div>
    </div>
  );

  return (<>
    <div style={CARD}>
      <div style={{ display:'flex' }}>
        {cell(matches.length,'Played',C.green,true)}{cell(won,'Won','#166534')}{cell(lost,'Lost','#b91c1c')}{cell(matches.length-won-lost,'Other',C.muted)}
      </div>
    </div>
    <div style={CARD}>
      {matches.map((m, i) => {
        const d = fmtDay(m.match_date);
        const hasScore = m.qca_total_runs != null || m.opp_total_runs != null;
        return (
          <div key={m.id} onClick={() => onSelect(m)} role="button" tabIndex={0}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px 9px 12px', cursor:'pointer', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
            <div style={{ width:40, flexShrink:0, textAlign:'center', borderRadius:8, backgroundColor:'#f0f4f0', padding:'4px 0' }}>
              <div style={{ fontSize:16, fontWeight:900, color:C.green, lineHeight:1 }}>{d.day}</div>
              <div style={{ fontSize:9.5, fontWeight:800, color:C.muted, textTransform:'uppercase' }}>{d.mon}</div>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:800, fontSize:13.5, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>vs {m.opponent_name}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {[m.match_type, m.total_overs ? `${m.total_overs} ov` : '', m.venue].filter(Boolean).join(' · ') || '—'}
              </div>
              {hasScore && (
                <div style={{ fontSize:11.5, fontWeight:800, color:C.text, marginTop:1 }}>
                  {score(m.qca_total_runs, m.qca_total_wickets, null)} <span style={{ color:C.muted, fontWeight:600 }}>v</span> {score(m.opp_total_runs, m.opp_total_wickets, null)}
                </div>
              )}
            </div>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
              <StatusChip m={m} />
              {Number(m.synced) === 0 && <span style={{ fontSize:10, fontWeight:800, color:'#b45309' }}>⚠ Not uploaded</span>}
              {can('matches:delete') && (
                <button onClick={e => { e.stopPropagation(); handleDelete(m); }} disabled={deleting === m.id} aria-label={`Delete match vs ${m.opponent_name}`}
                  style={{ padding:'2px 7px', borderRadius:6, border:`1px solid ${C.border}`, backgroundColor:'#fff', color:C.red, fontSize:10.5, fontWeight:700, cursor:'pointer' }}>
                  {deleting === m.id ? '…' : '🗑'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  </>);
}

// ─── New match ─────────────────────────────────────────────────────
function NewMatchTab({ can, onCreated }: { can:(s:string)=>boolean; onCreated:()=>void }) {
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
      await createLocalMatch({ ...form, opponent_name: form.opponent_name.trim(), total_overs: Number(form.total_overs) });
      setMsg('✅ Match created');
      setTimeout(()=>{ onCreated(); },800);
    } catch(e:any) { setMsg('⚠ '+e.message); }
    setSaving(false);
  };

  if (!can('matches:create')) return <Empty icon="🔒" title="No permission" sub="Your role can't create matches" />;

  const chip = (on:boolean): React.CSSProperties => ({ padding:'5px 11px', borderRadius:16, cursor:'pointer', fontWeight:700, fontSize:12,
    border:`1px solid ${on ? C.green : C.border}`, backgroundColor:on ? C.green : '#fff', color:on ? '#fff' : '#374151' });
  const seg = (on:boolean): React.CSSProperties => ({ flex:1, height:30, borderRadius:6, border:'none', cursor:'pointer', fontWeight:700, fontSize:12,
    backgroundColor:on ? '#fff' : 'transparent', color:on ? C.green : C.muted, boxShadow:on ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', padding:'0 4px' });
  const oppLabel = form.opponent_name.trim() || 'Opponent';

  return (<>
    {msg && <div style={{ padding:'8px 12px', borderRadius:10, fontSize:12.5, fontWeight:700,
      backgroundColor:msg.startsWith('✅')?'#e8f5e9':'#fef2f2', color:msg.startsWith('✅')?'#166534':C.red }}>{msg}</div>}
    <div style={{ ...CARD, padding:12, display:'flex', flexDirection:'column', gap:10 }}>
      <div>
        <div style={LBL}>Opponent</div>
        <input value={form.opponent_name} onChange={e=>setF('opponent_name',e.target.value)} placeholder="e.g. Kerala XI" style={INP}/>
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <div style={{ flex:'0 0 46%' }}>
          <div style={LBL}>Date</div>
          <input type="date" value={form.match_date} onChange={e=>setF('match_date',e.target.value)} style={INP}/>
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={LBL}>Venue</div>
          <input value={form.venue} onChange={e=>setF('venue',e.target.value)} placeholder="Ground name" style={INP}/>
        </div>
      </div>
      <div>
        <div style={LBL}>Match type</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
          {M_TYPES.map(t => <button key={t} onClick={()=>setF('match_type',t)} aria-pressed={form.match_type===t} style={chip(form.match_type===t)}>{t}</button>)}
        </div>
      </div>
      <div>
        <div style={LBL}>Overs</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
          {OV_OPTS.map(o => <button key={o} onClick={()=>setF('total_overs',o)} aria-pressed={form.total_overs===o} style={chip(form.total_overs===o)}>{o}</button>)}
        </div>
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={LBL}>Toss won by</div>
          <div style={{ display:'flex', gap:3, padding:3, borderRadius:8, backgroundColor:'#f3f4f6' }}>
            <button onClick={()=>setF('toss_winner','QCA')} style={seg(form.toss_winner==='QCA')}>QCA</button>
            <button onClick={()=>setF('toss_winner',form.opponent_name.trim() || 'Opponent')} style={seg(form.toss_winner!=='QCA')}>{oppLabel}</button>
          </div>
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={LBL}>Chose to</div>
          <div style={{ display:'flex', gap:3, padding:3, borderRadius:8, backgroundColor:'#f3f4f6' }}>
            {['bat','field'].map(dc => <button key={dc} onClick={()=>setF('toss_decision',dc)} style={seg(form.toss_decision===dc)}>{dc === 'bat' ? 'Bat' : 'Field'}</button>)}
          </div>
        </div>
      </div>
      <button onClick={submit} disabled={saving}
        style={{ width:'100%', padding:11, borderRadius:11, border:'none', backgroundColor:saving?'#9ca3af':C.green, color:saving?'#fff':C.gold,
          fontWeight:900, fontSize:14, cursor:saving?'not-allowed':'pointer' }}>
        {saving ? 'Creating…' : '➕ Create match'}
      </button>
    </div>
  </>);
}

// ─── Sync ──────────────────────────────────────────────────────────
function SyncTab({ matches, can, refresh }: { matches:any[]; can:(s:string)=>boolean; refresh:()=>void }) {
  const [syncing, setSyncing]   = useState(false);
  const [results, setResults]   = useState<string[]>([]);
  const [pulling, setPulling]   = useState(false);
  const base = buildBase(localStorage.getItem('server_ip')||'');

  const unsynced = matches.filter(m=>Number(m.synced)===0);

  const pushAll = async () => {
    if (!can('matches:edit')) { setResults(['⚠ No permission to sync']); return; }
    setSyncing(true);
    setResults(['Starting upload…']);
    const logs: string[] = [];
    for (const m of unsynced) {
      try {
        const payload = await buildMatchSyncPayload(m.id);
        if (!payload) { logs.push(`⚠ vs ${m.opponent_name}: not found on this phone`); continue; }
        const res = await fetch(`${base}/api/data/matches/save`, {
          method:'POST', headers:{ ...hdrs(), 'Content-Type':'application/json' }, body:JSON.stringify(payload),
        });
        if (res.ok) {
          const j = await res.json().catch(()=>({}));
          if (!j.match_id) { logs.push(`⚠ vs ${m.opponent_name}: server did not return an id`); continue; }
          await markMatchSynced(m.id, j.match_id);
          logs.push(`✅ vs ${m.opponent_name} uploaded (server #${j.match_id})`);
        } else {
          const j = await res.json().catch(()=>({}));
          logs.push(`⚠ vs ${m.opponent_name}: ${j.error||res.status}`);
        }
      } catch(e:any) { logs.push(`⚠ vs ${m.opponent_name}: ${e.message}`); }
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

  return (<>
    <div style={{ ...CARD, padding:12 }}>
      <div style={{ fontSize:13, color: unsynced.length ? '#b45309' : '#166534', fontWeight:800, marginBottom:10 }}>
        {unsynced.length ? `⚠ ${unsynced.length} match${unsynced.length!==1?'es':''} not uploaded yet` : '✔ Everything on this phone is uploaded'}
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <button onClick={pushAll} disabled={syncing||unsynced.length===0}
          style={{ flex:1, padding:10, borderRadius:10, border:'none', fontWeight:800, fontSize:13,
            cursor: syncing||unsynced.length===0 ? 'not-allowed' : 'pointer',
            backgroundColor: unsynced.length>0 ? C.green : '#e5e7eb', color: unsynced.length>0 ? C.gold : C.muted }}>
          {syncing ? 'Uploading…' : '⬆ Upload'}
        </button>
        <button onClick={pullFromServer} disabled={pulling}
          style={{ flex:1, padding:10, borderRadius:10, border:`1px solid ${C.green}`, cursor:'pointer', fontWeight:800, fontSize:13,
            backgroundColor:'#fff', color:C.green }}>
          {pulling ? 'Pulling…' : '⬇ Pull results'}
        </button>
      </div>
      <div style={{ fontSize:11, color:C.muted, marginTop:8, lineHeight:1.5 }}>
        Pull brings in matches and scores entered on the web portal. Matches changed on this phone and not uploaded are never overwritten.
      </div>
    </div>
    {results.length > 0 && (
      <div style={{ ...CARD, padding:'8px 12px', backgroundColor:'#f9fafb' }}>
        {results.map((r,i)=>(
          <div key={i} style={{ fontSize:12.5, padding:'3px 0', color:r.startsWith('✅')?'#166534':r.startsWith('⏸')||r.startsWith('Pull')||r.startsWith('Start')?C.muted:C.red }}>{r}</div>
        ))}
      </div>
    )}
  </>);
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
  const { can } = usePermissions();
  const [tab, setTab] = useState<'score'|'list'|'new'|'sync'>('list');
  const [matches, setMatches] = useState<any[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);

  const refresh = useCallback(async()=>{ setMatches(await getLocalMatches()); },[]);
  useEffect(()=>{ refresh(); },[refresh]);

  const unsynced = matches.filter(m=>Number(m.synced)===0).length;

  const TABS: Array<['score'|'list'|'new'|'sync', string]> = [
    ['list',  '📋 Matches'],
    ['score', '📊 Scorecard'],
    ...(can('matches:create') ? [['new', '➕ New'] as ['new', string]] : []),
    ...(can('matches:edit')   ? [['sync', `☁ Sync${unsynced>0?` (${unsynced})`:''}`] as ['sync', string]] : []),
  ];

  return(
    <MatchErrorBoundary>
    <div style={{ backgroundColor:C.bg, minHeight:'100%', fontFamily:'sans-serif', color:C.text, paddingBottom:24 }}>
      <ScreenHeader title="Matches"
        subtitle={tab==='score' && selectedMatch ? `vs ${selectedMatch.opponent_name}` : `${matches.length} match${matches.length===1?'':'es'}${unsynced ? ` · ${unsynced} not uploaded` : ''}`}>
        <HeaderTabs value={tab} onChange={setTab} tabs={TABS.map(([id,label])=>({id,label}))} />
      </ScreenHeader>

      <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
        {tab==='list'  && <ListTab matches={matches} onSelect={m=>{setSelectedMatch(m);setTab('score');}} can={can} refresh={refresh} />}
        {tab==='score' && <ScorecardTab match={selectedMatch} />}
        {tab==='new'   && <NewMatchTab can={can} onCreated={()=>{refresh();setTab('list');}} />}
        {tab==='sync'  && <SyncTab matches={matches} can={can} refresh={refresh} />}
      </div>
    </div>
    </MatchErrorBoundary>
  );
}
