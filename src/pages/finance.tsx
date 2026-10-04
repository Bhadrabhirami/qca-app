/**
 * finance.tsx — General Finance Entry + History
 * Permission: payments:record / payments:view
 */
import React, { useState, useCallback } from 'react';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader, { HeaderTabs } from '../shared/ScreenHeader';

const C = {
  navy:'#0d1b2a', green:'#1a472a', gold:'#c5a059',
  bg:'#f0f2f5', card:'#fff', border:'#e0e0e0', muted:'#6b7280',
  red:'#dc2626',
};
function bld() {
  const ip=(localStorage.getItem('server_ip')||'').trim().replace(/\/+$/,'');
  return ip.startsWith('http')?ip:`http://${ip}`;
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
function fmtAmt(n:number){
  return 'Rs.'+(n||0).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:2});
}
function toMonYY(yyyymm:string){
  if(!yyyymm) return '';
  const [y,m]=yyyymm.split('-');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(m)-1]+'-'+y.slice(2);
}

const LBL=({children}:{children:any})=>(
  <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:4,
    textTransform:'uppercase' as const,letterSpacing:'0.5px'}}>{children}</div>
);

export default function FinanceScreen() {
  const navigate=useNavigate();
  const {can}=usePermissions();
  const base=bld();
  const [tab,setTab]=useState<'entry'|'history'>('entry');

  // ── Entry form ──
  const [categories,setCategories]=useState<any[]>([]);
  const [catSearch,setCatSearch]=useState('');
  const [selectedCat,setSelectedCat]=useState<any>(null);
  const [showCatList,setShowCatList]=useState(false);
  const [accSearch,setAccSearch]=useState('');
  const [accResults,setAccResults]=useState<any[]>([]);
  const [selectedAcc,setSelectedAcc]=useState<any>(null);
  const [showAccList,setShowAccList]=useState(false);
  const [amount,setAmount]=useState('');
  const [date,setDate]=useState(new Date().toISOString().slice(0,10));
  const [mode,setMode]=useState('Cash');
  const [remarks,setRemarks]=useState('');
  const [status,setStatus]=useState('Paid');
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState('');

  // ── History ──
  const [hMonth,setHMonth]=useState(new Date().toISOString().slice(0,7));
  const [hDir,setHDir]=useState('');
  const [hSearch,setHSearch]=useState('');
  const [summary,setSummary]=useState<any>(null);
  const [details,setDetails]=useState<any[]>([]);
  const [selCat,setSelCat]=useState<string|null>(null);
  const [loadingH,setLoadingH]=useState(false);

  React.useEffect(()=>{
    fetch(`${base}/api/data/fee-categories`,{headers:hdr()})
      .then(r=>r.ok?r.json():{data:[]})
      .then(j=>setCategories(j.data||[]))
      .catch(()=>{});
  },[]);

  const searchAccounts=async(q:string)=>{
    if(!q.trim()){setAccResults([]);return;}
    try{
      const r=await fetch(`${base}/api/data/accounts/search?q=${encodeURIComponent(q)}`,{headers:hdr()});
      const j=await r.json();
      setAccResults(j.data||[]);
    }catch{setAccResults([]);}
  };

  const filteredCats=catSearch
    ?categories.filter(c=>c.name.toLowerCase().includes(catSearch.toLowerCase()))
    :categories;
  const incCats=filteredCats.filter(c=>c.txn_type==='INCOME');
  const expCats=filteredCats.filter(c=>c.txn_type==='EXPENSE');
  const isExpense=selectedCat?.txn_type==='EXPENSE';

  const submit=async()=>{
    if(!selectedCat){setMsg('Select a category');return;}
    if(!selectedAcc){setMsg('Select an account / payee');return;}
    if(!amount||parseFloat(amount)<=0){setMsg('Enter amount');return;}
    setSaving(true);setMsg('');
    try{
      const r=await fetch(`${base}/api/data/finance/record`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          category_id:selectedCat.id,
          account_id:selectedAcc.id,
          amount:parseFloat(amount),
          mode,payment_date:date,
          billing_month:toMonYY(date.slice(0,7)),
          remarks,status,
        })
      });
      const j=await r.json();
      if(r.ok&&j.success){
        setMsg(`✓ ${isExpense?'Expense':'Income'} recorded: ${fmtAmt(parseFloat(amount))} · ${j.receipt_no}`);
        setSelectedCat(null);setCatSearch('');setSelectedAcc(null);
        setAccSearch('');setAmount('');setRemarks('');
      } else setMsg(j.error||'Error');
    }catch{setMsg('Network error');}
    finally{setSaving(false);}
  };

  const [exporting,setExporting]=useState(false);

  const exportPdf=async()=>{
    if(!hMonth) return;
    setExporting(true);
    try{
      const url=`${base}/api/data/finance/pdf?month=${hMonth}`;
      const r=await fetch(url,{headers:hdr()});
      if(!r.ok){const j=await r.json();alert(j.error||'PDF error');return;}
      const blob=await r.blob();
      const reader=new FileReader();
      reader.onloadend=async()=>{
        const base64=(reader.result as string).split(',')[1];
        const fname=`finance_${hMonth}.pdf`;
        await Filesystem.writeFile({path:fname,data:base64,directory:Directory.Cache});
        const uri=await Filesystem.getUri({path:fname,directory:Directory.Cache});
        await Share.share({title:`Finance ${hMonth}`,url:uri.uri,dialogTitle:'Share Finance Report'});
      };
      reader.readAsDataURL(blob);
    }catch(e){alert('Export error: '+String(e));}
    finally{setExporting(false);}
  };

  const shareReceipt = async (receiptNo: string) => {
    if (!receiptNo) { alert('No receipt number'); return; }
    try {
      const r = await fetch(`${base}/api/data/payments/${receiptNo}/receipt-pdf`, {headers:hdr()});
      if (!r.ok) { alert('Failed to generate receipt'); return; }
      const blob = await r.blob();
      const reader = new FileReader();
      reader.onloadend = async () => {
        const b64 = (reader.result as string).split(',')[1];
        const fname = `receipt_${receiptNo}.pdf`;
        await Filesystem.writeFile({path:fname, data:b64, directory:Directory.Cache});
        const uri = await Filesystem.getUri({path:fname, directory:Directory.Cache});
        await Share.share({title:`Receipt ${receiptNo}`, url:uri.uri, dialogTitle:'Share Receipt'});
      };
      reader.readAsDataURL(blob);
    } catch(e) { alert('Error: '+String(e)); }
  };

  const loadSummary=useCallback(async()=>{
    if(!hMonth){setMsg('Select a month first');return;}
    setLoadingH(true);setSummary(null);setDetails([]);setSelCat(null);
    try{
      const p=new URLSearchParams({month:hMonth});
      if(hDir) p.set('direction',hDir);
      if(hSearch) p.set('q',hSearch);
      const r=await fetch(`${base}/api/data/finance/summary?${p}`,{headers:hdr()});
      const j=await r.json();
      if(j.data) setSummary(j.data);
    }catch{}
    finally{setLoadingH(false);}
  },[base,hMonth,hDir,hSearch]);

  const loadDetails=async(catId:number)=>{
    if(!hMonth) return;
    setSelCat(String(catId));setDetails([]);
    try{
      const p=new URLSearchParams({month:hMonth,category_id:String(catId),limit:'50'});
      const r=await fetch(`${base}/api/data/finance/history?${p}`,{headers:hdr()});
      const j=await r.json();
      setDetails(j.data||[]);
    }catch{}
  };

  return (
    <div style={{backgroundColor:C.bg,minHeight:'100vh',paddingBottom:80}}>
      <ScreenHeader title="💰 Finance Entry" subtitle="Record income & expenses" background={C.navy}>
        <HeaderTabs color={C.navy} value={tab as string} onChange={id=>{setTab(id as any);setMsg('');}}
          tabs={[{id:'entry',label:'📝 New Entry'},{id:'history',label:'📋 History'}]} />
      </ScreenHeader>

      <div style={{padding:'12px 16px'}}>

        {/* ── NEW ENTRY ── */}
        {tab==='entry'&&(
          <div>
            {msg&&(
              <div style={{borderRadius:10,padding:'10px 14px',marginBottom:12,
                backgroundColor:msg.startsWith('✓')?'#f0fdf4':'#fef2f2',
                color:msg.startsWith('✓')?'#16a34a':C.red,fontSize:13,fontWeight:600}}>
                {msg}
              </div>
            )}

            {/* Category */}
            <div style={{marginBottom:12,position:'relative' as const}}>
              <LBL>Category *</LBL>
              {selectedCat?(
                <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',
                  borderRadius:10,border:`2px solid ${isExpense?C.red:C.green}`,
                  backgroundColor:isExpense?'#fef2f2':'#f0fdf4'}}>
                  <span style={{fontSize:22}}>{isExpense?'📤':'📥'}</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:14}}>{selectedCat.name}</div>
                    <div style={{fontSize:11,color:isExpense?C.red:C.green,fontWeight:700}}>
                      {isExpense?'EXPENSE':'INCOME'}
                    </div>
                  </div>
                  <button onClick={()=>{setSelectedCat(null);setCatSearch('');}}
                    style={{background:'none',border:'none',fontSize:20,cursor:'pointer',color:C.muted}}>✕</button>
                </div>
              ):(
                <>
                  <input value={catSearch}
                    onChange={e=>{setCatSearch(e.target.value);setShowCatList(true);}}
                    onFocus={()=>setShowCatList(true)}
                    onBlur={()=>setTimeout(()=>setShowCatList(false),150)}
                    placeholder="Search category..."
                    style={{width:'100%',padding:'10px 12px',borderRadius:10,
                      border:`1px solid ${C.border}`,fontSize:14,outline:'none',
                      boxSizing:'border-box' as const}}/>
                  {showCatList&&(
                    <div style={{position:'absolute' as const,top:'100%',left:0,right:0,
                      backgroundColor:'#fff',borderRadius:10,zIndex:100,
                      boxShadow:'0 4px 20px rgba(0,0,0,0.15)',maxHeight:320,overflowY:'auto' as const}}>
                      {incCats.length>0&&(
                        <>
                          <div style={{padding:'6px 12px',fontSize:10,fontWeight:800,
                            color:C.green,backgroundColor:'#f0fdf4',textTransform:'uppercase' as const}}>
                            📥 Income
                          </div>
                          {incCats.map((cat:any)=>(
                            <div key={cat.id} onMouseDown={()=>{setSelectedCat(cat);setCatSearch('');setShowCatList(false);}}
                              style={{padding:'10px 14px',cursor:'pointer',fontSize:13,
                                borderBottom:`1px solid #f3f4f6`}}>{cat.name}</div>
                          ))}
                        </>
                      )}
                      {expCats.length>0&&(
                        <>
                          <div style={{padding:'6px 12px',fontSize:10,fontWeight:800,
                            color:C.red,backgroundColor:'#fef2f2',textTransform:'uppercase' as const}}>
                            📤 Expense
                          </div>
                          {expCats.map((cat:any)=>(
                            <div key={cat.id} onMouseDown={()=>{setSelectedCat(cat);setCatSearch('');setShowCatList(false);}}
                              style={{padding:'10px 14px',cursor:'pointer',fontSize:13,
                                borderBottom:`1px solid #f3f4f6`}}>{cat.name}</div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Account */}
            <div style={{marginBottom:12,position:'relative' as const}}>
              <LBL>Account / Payee *</LBL>
              {selectedAcc?(
                <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',
                  borderRadius:10,border:`1px solid ${C.border}`,backgroundColor:'#f8fafc'}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:14}}>{selectedAcc.display_name}</div>
                    <div style={{fontSize:11,color:C.muted}}>{selectedAcc.account_type}</div>
                  </div>
                  <button onClick={()=>{setSelectedAcc(null);setAccSearch('');}}
                    style={{background:'none',border:'none',fontSize:20,cursor:'pointer',color:C.muted}}>✕</button>
                </div>
              ):(
                <>
                  <input value={accSearch}
                    onChange={e=>{setAccSearch(e.target.value);searchAccounts(e.target.value);setShowAccList(true);}}
                    onFocus={()=>setShowAccList(true)}
                    onBlur={()=>setTimeout(()=>setShowAccList(false),150)}
                    placeholder="Search student, coach, vendor..."
                    style={{width:'100%',padding:'10px 12px',borderRadius:10,
                      border:`1px solid ${C.border}`,fontSize:14,outline:'none',
                      boxSizing:'border-box' as const}}/>
                  {showAccList&&accResults.length>0&&(
                    <div style={{position:'absolute' as const,top:'100%',left:0,right:0,
                      backgroundColor:'#fff',borderRadius:10,zIndex:100,
                      boxShadow:'0 4px 20px rgba(0,0,0,0.15)',maxHeight:200,overflowY:'auto' as const}}>
                      {accResults.map((a:any)=>(
                        <div key={a.id} onMouseDown={()=>{setSelectedAcc(a);setAccSearch('');setShowAccList(false);}}
                          style={{padding:'10px 14px',cursor:'pointer',borderBottom:`1px solid #f3f4f6`}}>
                          <div style={{fontWeight:700,fontSize:13}}>{a.display_name}</div>
                          <div style={{fontSize:11,color:C.muted}}>{a.account_type}{a.regno?` · ${a.regno}`:''}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Amount */}
            <div style={{marginBottom:12}}>
              <LBL>Amount *</LBL>
              <input type="number" value={amount} onChange={e=>setAmount(e.target.value)}
                placeholder="0.00"
                style={{width:'100%',padding:'11px 14px',borderRadius:10,
                  border:`1px solid ${C.border}`,fontSize:20,fontWeight:700,
                  outline:'none',boxSizing:'border-box' as const,textAlign:'right' as const}}/>
            </div>

            {/* Date & Mode */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              <div>
                <LBL>Date *</LBL>
                <input type="date" value={date} onChange={e=>setDate(e.target.value)}
                  style={{width:'100%',padding:'9px 10px',borderRadius:10,
                    border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                    boxSizing:'border-box' as const}}/>
              </div>
              <div>
                <LBL>Mode</LBL>
                <select value={mode} onChange={e=>setMode(e.target.value)}
                  style={{width:'100%',padding:'9px 10px',borderRadius:10,
                    border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                    boxSizing:'border-box' as const}}>
                  {['Cash','UPI','Bank Transfer','Cheque','Card','Online'].map(m=>(
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Status & Remarks */}
            <div style={{marginBottom:12}}>
              <LBL>Status</LBL>
              <select value={status} onChange={e=>setStatus(e.target.value)}
                style={{width:'100%',padding:'9px 10px',borderRadius:10,
                  border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                  boxSizing:'border-box' as const}}>
                <option>Paid</option><option>Pending</option><option>Partial</option>
              </select>
            </div>
            <div style={{marginBottom:16}}>
              <LBL>Remarks</LBL>
              <input value={remarks} onChange={e=>setRemarks(e.target.value)}
                placeholder="Description or reference..."
                style={{width:'100%',padding:'10px 12px',borderRadius:10,
                  border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                  boxSizing:'border-box' as const}}/>
            </div>

            <button onClick={submit} disabled={saving||!selectedCat||!selectedAcc||!amount}
              style={{width:'100%',padding:14,borderRadius:12,border:'none',
                backgroundColor:!selectedCat||!selectedAcc||!amount?'#e5e7eb':isExpense?C.red:C.green,
                color:'#fff',fontWeight:800,fontSize:15,
                cursor:!selectedCat||!selectedAcc||!amount?'not-allowed':'pointer'}}>
              {saving?'Recording...':`Record ${isExpense?'📤 Expense':'📥 Income'}`}
            </button>
          </div>
        )}

        {/* ── HISTORY ── */}
        {tab==='history'&&(
          <div>
            {/* Filters */}
            <div style={{backgroundColor:C.card,borderRadius:12,padding:12,
              marginBottom:12,border:`1px solid ${C.border}`}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
                <div>
                  <LBL>Month *</LBL>
                  <input type="month" value={hMonth} onChange={e=>setHMonth(e.target.value)}
                    style={{width:'100%',padding:'8px',borderRadius:8,
                      border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                      boxSizing:'border-box' as const}}/>
                </div>
                <div>
                  <LBL>Direction</LBL>
                  <select value={hDir} onChange={e=>setHDir(e.target.value)}
                    style={{width:'100%',padding:'8px',borderRadius:8,
                      border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                      boxSizing:'border-box' as const}}>
                    <option value="">All</option>
                    <option value="INCOME">Income</option>
                    <option value="EXPENSE">Expense</option>
                  </select>
                </div>
              </div>
              <div style={{display:'flex',gap:8}}>
                <input value={hSearch} onChange={e=>setHSearch(e.target.value)}
                  placeholder="Search remarks, category..."
                  style={{flex:1,padding:'8px 12px',borderRadius:8,
                    border:`1px solid ${C.border}`,fontSize:13,outline:'none',
                    boxSizing:'border-box' as const}}/>
                <button onClick={loadSummary} disabled={loadingH||!hMonth}
                  style={{padding:'8px 16px',borderRadius:8,border:'none',
                    backgroundColor:hMonth?C.navy:'#e5e7eb',
                    color:hMonth?'#fff':C.muted,fontWeight:700,fontSize:13,
                    cursor:hMonth?'pointer':'not-allowed'}}>
                  {loadingH?'...':'Load'}
                </button>
                <button onClick={exportPdf} disabled={exporting||!hMonth}
                  style={{padding:'8px 12px',borderRadius:8,border:'none',
                    backgroundColor:hMonth?'#7c3aed':'#e5e7eb',
                    color:hMonth?'#fff':C.muted,fontWeight:700,fontSize:13,
                    cursor:hMonth?'pointer':'not-allowed'}}>
                  {exporting?'...':'📄'}
                </button>
              </div>
            </div>

            {/* Summary cards */}
            {summary&&(
              <>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:12}}>
                  <div style={{backgroundColor:'#f0fdf4',borderRadius:10,padding:10,textAlign:'center' as const}}>
                    <div style={{fontSize:10,color:C.green,fontWeight:700,marginBottom:2}}>INCOME</div>
                    <div style={{fontWeight:900,fontSize:14,color:C.green}}>{fmtAmt(summary.total_in)}</div>
                  </div>
                  <div style={{backgroundColor:'#fef2f2',borderRadius:10,padding:10,textAlign:'center' as const}}>
                    <div style={{fontSize:10,color:C.red,fontWeight:700,marginBottom:2}}>EXPENSE</div>
                    <div style={{fontWeight:900,fontSize:14,color:C.red}}>{fmtAmt(summary.total_out)}</div>
                  </div>
                  <div style={{backgroundColor:'#f0f9ff',borderRadius:10,padding:10,textAlign:'center' as const}}>
                    <div style={{fontSize:10,color:C.navy,fontWeight:700,marginBottom:2}}>NET</div>
                    <div style={{fontWeight:900,fontSize:14,
                      color:summary.total_in-summary.total_out>=0?C.green:C.red}}>
                      {fmtAmt(Math.abs(summary.total_in-summary.total_out))}
                    </div>
                  </div>
                </div>

                {/* Category breakdown */}
                <div style={{fontWeight:700,fontSize:11,color:C.muted,
                  textTransform:'uppercase' as const,letterSpacing:'1px',marginBottom:6}}>
                  By Category
                </div>
                {summary.by_category?.map((cat:any)=>(
                  <button key={cat.category_id} onClick={()=>loadDetails(cat.category_id)}
                    style={{width:'100%',backgroundColor:C.card,borderRadius:10,
                      padding:'10px 14px',marginBottom:6,
                      border:`1px solid ${selCat===String(cat.category_id)?C.navy:C.border}`,
                      display:'flex',justifyContent:'space-between',alignItems:'center',
                      cursor:'pointer',textAlign:'left' as const,
                      borderLeft:`4px solid ${cat.txn_type==='EXPENSE'?C.red:C.green}`}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:13}}>{cat.fee_type}</div>
                      <div style={{fontSize:11,color:C.muted}}>{cat.count} transaction{cat.count!==1?'s':''}</div>
                    </div>
                    <div style={{fontWeight:900,fontSize:14,
                      color:cat.txn_type==='EXPENSE'?C.red:C.green}}>
                      {cat.txn_type==='EXPENSE'?'−':'+'}
                      {fmtAmt(cat.total)}
                    </div>
                  </button>
                ))}

                {/* Detail rows */}
                {details.length>0&&(
                  <div style={{marginTop:12}}>
                    <div style={{fontWeight:700,fontSize:11,color:C.muted,
                      textTransform:'uppercase' as const,letterSpacing:'1px',marginBottom:6}}>
                      Transactions
                    </div>
                    {details.map((p:any,i:number)=>(
                      <div key={i} style={{backgroundColor:C.card,borderRadius:10,
                        padding:'10px 14px',marginBottom:6,border:`1px solid ${C.border}`,
                        borderLeft:`3px solid ${(p.txn_direction==='EXPENSE'||p.txn_direction==='OUT')?C.red:C.green}`}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                          <div style={{flex:1}}>
                            <div style={{fontWeight:700,fontSize:13}}>{p.account_name||'—'}</div>
                            <div style={{fontSize:11,color:C.muted}}>
                              #{p.receipt_no} · {p.payment_date} · {p.payment_mode}
                            </div>
                            {p.remarks&&<div style={{fontSize:11,color:C.muted}}>{p.remarks}</div>}
                          </div>
                          <div style={{fontWeight:900,fontSize:14,flexShrink:0,marginLeft:8,
                            color:(p.txn_direction==='EXPENSE'||p.txn_direction==='OUT')?C.red:C.green}}>
                            {(p.txn_direction==='EXPENSE'||p.txn_direction==='OUT')?'−':'+'}
                            {fmtAmt(p.amount_paid)}
                          </div>
                          {p.receipt_no&&(
                            <button onClick={()=>shareReceipt(p.receipt_no)}
                              style={{fontSize:10,padding:'2px 8px',borderRadius:6,
                                border:'1px solid #e0e0e0',backgroundColor:'#f8fafc',
                                color:'#6b7280',cursor:'pointer',fontWeight:600,marginTop:4}}>
                              📄 Share Receipt
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {!summary&&!loadingH&&(
              <div style={{textAlign:'center' as const,padding:40,color:C.muted}}>
                <div style={{fontSize:32,marginBottom:8}}>📊</div>
                <div style={{fontWeight:600,fontSize:14}}>Select a month and tap Load</div>
                <div style={{fontSize:12,marginTop:4}}>Summary loads by category</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
