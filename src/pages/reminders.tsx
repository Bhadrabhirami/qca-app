/**
 * reminders.tsx — Payment Reminder Hub (Redesigned)
 * - Live SQL query with search + filter (name, unpaid months, balance)
 * - Student card with photo, parent info, due months breakdown
 * - Per-month: Email + WhatsApp reminders (separate triggers)
 * - Inline Record Payment — pre-fills student from row, coach enters amount/month
 * - Config panel: grace days, UPI VPA, QR code
 */

import { matchesStudentSearch, formatRegno } from './studentUtils';
import StudentPhoto from '../shared/StudentPhoto';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import ScreenHeader, { HeaderIconButton } from '../shared/ScreenHeader';

// ── Constants ─────────────────────────────────────────────────────────────────
const C = {
  navy:'#001f3f', gold:'#c5a059', green:'#1a472a',
  red:'#c0392b', orange:'#e67e22', bg:'#f0f2f5',
  card:'#fff', border:'#e5e7eb', muted:'#6b7280',
};
const TIER_LABELS = ['','1st Reminder','2nd Reminder','Final Notice'];
const TIER_COLORS = ['','#c5a059','#e67e22','#c0392b'];
const TIER_ICONS  = ['','📩','📨','🚨'];

function bld(ip:string){
  const h=(ip||'').trim().replace(/\/+$/,'');
  return h.startsWith('http')?h:`http://${h}`;
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
// ── Avatar ────────────────────────────────────────────────────────────────────
function Avatar({name,photo,size=40}:{name:string;photo?:string;size?:number}){
  const [err,setErr]=useState(false);
  if(photo&&!err){
    return(
      <img src={photo} alt={name} onError={()=>setErr(true)}
        style={{width:size,height:size,borderRadius:'50%',
          objectFit:'cover',flexShrink:0,border:'2px solid #e5e7eb'}}/>
    );
  }
  return(
    <div style={{width:size,height:size,borderRadius:'50%',flexShrink:0,
      backgroundColor:C.navy,display:'flex',alignItems:'center',
      justifyContent:'center',color:C.gold,fontWeight:900,
      fontSize:Math.floor(size*0.4)}}>
      {(name||'?')[0].toUpperCase()}
    </div>
  );
}

// ── Quick Record Payment Modal ────────────────────────────────────────────────
function QuickPayModal({student,base,onClose,onSuccess}:{
  student:any; base:string;
  onClose:()=>void; onSuccess:(receipt:string)=>void;
}){
  // Generate last 12 months
  const monthOpts = Array.from({length:12},(_,i)=>{
    const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-i);
    return d.toLocaleDateString('en-GB',{month:'short',year:'2-digit'}).replace(' ','-');
  });

  const [form,setForm]=useState({
    category_id:'1',
    amount:     String(student.monthly_fee||''),
    mode:       'Cash',
    payment_date:new Date().toISOString().slice(0,10),
    billing_month:monthOpts[0],
    note:       '',
  });
  const [touched,  setTouched]  =useState<Record<string,boolean>>({});
  const [saving,   setSaving]   =useState(false);
  const [error,    setError]    =useState('');
  const [success,  setSuccess]  =useState('');
  const [receipt,  setReceipt]  =useState('');
  const [waSend,   setWASend]   =useState(false);
  const [waRes,    setWARes]    =useState('');

  const fStyle=(key:string,val:string):React.CSSProperties=>({
    width:'100%',padding:'11px 14px',borderRadius:10,fontSize:14,
    outline:'none',boxSizing:'border-box' as const,
    fontFamily:'inherit',backgroundColor:'#fff',
    border:touched[key]&&!val?'2px solid #dc2626':val?'2px solid #d4af37':'1.5px solid #e5e7eb',
  });

  const Label=({t,req}:{t:string;req?:boolean})=>(
    <div style={{fontSize:11,fontWeight:800,color:'#374151',
      textTransform:'uppercase' as const,letterSpacing:'0.5px',
      marginBottom:4,marginTop:12,display:'flex',alignItems:'center',gap:3}}>
      {t}{req&&<span style={{color:'#dc2626',fontWeight:900}}>*</span>}
    </div>
  );

  const handleSubmit=async()=>{
    setTouched({amount:true,payment_date:true,billing_month:true});
    if(!form.amount||Number(form.amount)<=0){setError('Amount required');return;}
    setSaving(true);setError('');
    try{
      const r=await fetch(`${base}/api/data/payments/record`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          student_id:   student.student_id,
          category_id:  Number(form.category_id),
          amount:       Number(form.amount),
          direction:    'IN',
          mode:         form.mode,
          payment_date: form.payment_date,
          billing_month:form.billing_month,
          note:         form.note,
        }),
      });
      const j=await r.json();
      if(j.success){
        setSuccess(`✅ ${j.receipt_no} recorded`);
        setReceipt(j.receipt_no);
      } else if(r.status===409){
        setError(`Already paid: ${j.message} (${j.receipt_no})`);
      } else {
        setError(j.error||'Failed');
      }
    }catch{setError('Network error');}
    finally{setSaving(false);}
  };

  const handleWA=async()=>{
    if(!receipt)return;
    setWASend(true);setWARes('');
    try{
      const r=await fetch(`${base}/api/data/payments/send_receipt_wa`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          student_id:   student.student_id,
          receipt_no:   receipt,
          amount:       Number(form.amount),
          billing_month:form.billing_month,
          mode:         form.mode,
        }),
      });
      const j=await r.json();
      setWARes(j.success?'✅ WhatsApp sent!':'❌ '+(j.error||'Failed'));
    }catch{setWARes('❌ Network error');}
    finally{setWASend(false);}
  };

  return(
    <div style={{position:'fixed',inset:0,zIndex:4000,
      backgroundColor:'rgba(0,0,0,0.6)',display:'flex',alignItems:'flex-end'}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{backgroundColor:'#f0f4f1',width:'100%',
        borderRadius:'22px 22px 0 0',maxHeight:'88vh',
        overflowY:'auto',paddingBottom:32}}>

        {/* Handle */}
        <div style={{display:'flex',justifyContent:'center',padding:'10px 0 0'}}>
          <div style={{width:40,height:4,borderRadius:2,backgroundColor:'#d1d5db'}}/>
        </div>

        {/* Header */}
        <div style={{display:'flex',justifyContent:'space-between',
          alignItems:'center',padding:'12px 18px 8px'}}>
          <div>
            <div style={{fontWeight:900,fontSize:17,color:C.navy}}>💰 Record Payment</div>
            <div style={{fontSize:11,color:C.muted,marginTop:1}}>
              <span style={{color:'#dc2626',fontWeight:800}}>*</span> Required fields
            </div>
          </div>
          <button onClick={onClose} style={{background:'rgba(0,0,0,0.07)',
            border:'none',width:30,height:30,borderRadius:'50%',
            fontSize:15,cursor:'pointer',color:C.muted}}>✕</button>
        </div>

        <div style={{padding:'0 16px'}}>
          {/* Student card — pre-filled, read-only */}
          <div style={{display:'flex',alignItems:'center',gap:12,
            backgroundColor:C.navy,borderRadius:14,padding:'12px 14px',marginBottom:4}}>
            <Avatar name={student.student_name} size={44}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:'#fff',fontWeight:800,fontSize:15,
                overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
                {student.student_name}
              </div>
              <div style={{color:'rgba(255,255,255,0.65)',fontSize:11,marginTop:2}}>
                ₹{(student.monthly_fee||0).toLocaleString('en-IN')}/mo
                {student.parent_name&&` · ${student.parent_name}`}
              </div>
            </div>
            <div style={{color:C.gold,fontSize:11,fontWeight:800,textAlign:'right' as const}}>
              <div>₹{(student.balance_due||0).toLocaleString('en-IN')}</div>
              <div style={{opacity:0.7}}>{student.total_unpaid} mo due</div>
            </div>
          </div>

          {/* Success */}
          {success&&(
            <div style={{padding:'14px',borderRadius:14,marginTop:8,
              backgroundColor:'#dcfce7',border:'1px solid #86efac'}}>
              <div style={{fontWeight:900,fontSize:14,color:'#166534'}}>{success}</div>
              <div style={{fontSize:11,color:'#166534',marginTop:3,marginBottom:12}}>
                ✉️ Email receipt sent automatically
              </div>
              <button onClick={handleWA} disabled={waSend||!!waRes}
                style={{width:'100%',padding:'10px',borderRadius:10,border:'none',
                  backgroundColor:waRes?(waRes.startsWith('✅')?'#25d366':C.red):'#25d366',
                  color:'#fff',fontWeight:800,fontSize:13,
                  cursor:waSend||!!waRes?'default':'pointer'}}>
                {waSend?'⏳ Sending…':waRes||'💬 Send WhatsApp Receipt'}
              </button>
              <button onClick={()=>onSuccess(receipt)}
                style={{width:'100%',marginTop:8,padding:'10px',borderRadius:10,
                  border:'1px solid #86efac',backgroundColor:'transparent',
                  color:'#166534',fontWeight:800,fontSize:13,cursor:'pointer'}}>
                Done ✓
              </button>
            </div>
          )}

          {/* Error */}
          {error&&!success&&(
            <div style={{padding:'10px 14px',borderRadius:10,marginTop:8,
              backgroundColor:'#fee2e2',border:'1px solid #fca5a5',
              fontWeight:700,fontSize:12,color:'#dc2626'}}>⚠ {error}</div>
          )}

          {!success&&(<>
          {/* Billing month */}
          <Label t="Billing Month" req/>
          <select value={form.billing_month}
            onBlur={()=>setTouched(t=>({...t,billing_month:true}))}
            onChange={e=>setForm(f=>({...f,billing_month:e.target.value}))}
            style={fStyle('billing_month',form.billing_month)}>
            {monthOpts.map(m=><option key={m} value={m}>{m}</option>)}
          </select>

          {/* Amount */}
          <Label t="Amount (₹)" req/>
          <div style={{position:'relative'}}>
            <span style={{position:'absolute',left:14,top:'50%',
              transform:'translateY(-50%)',fontWeight:800,
              color:C.muted,fontSize:13}}>₹</span>
            <input type="number" value={form.amount}
              onBlur={()=>setTouched(t=>({...t,amount:true}))}
              onChange={e=>setForm(f=>({...f,amount:e.target.value}))}
              placeholder="0" min="1"
              style={{...fStyle('amount',form.amount),paddingLeft:50}}/>
          </div>

          {/* Date + Mode */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <div>
              <Label t="Date" req/>
              <input type="date" value={form.payment_date}
                onChange={e=>setForm(f=>({...f,payment_date:e.target.value}))}
                style={fStyle('payment_date',form.payment_date)}/>
            </div>
            <div>
              <Label t="Mode"/>
              <select value={form.mode}
                onChange={e=>setForm(f=>({...f,mode:e.target.value}))}
                style={{...fStyle('mode','ok'),color:'#111'}}>
                {['Cash','UPI','Bank Transfer','Cheque','Card','Online'].map(m=>
                  <option key={m}>{m}</option>
                )}
              </select>
            </div>
          </div>

          {/* Note */}
          <Label t="Note (optional)"/>
          <input value={form.note}
            onChange={e=>setForm(f=>({...f,note:e.target.value}))}
            placeholder="Auto-generated if blank" maxLength={200}
            style={fStyle('note','ok')}/>

          {/* Submit */}
          <button onClick={handleSubmit} disabled={saving}
            style={{width:'100%',marginTop:16,padding:'15px',borderRadius:14,
              border:'none',
              backgroundColor:saving?'#9ca3af':C.green,
              color:'#fff',fontWeight:900,fontSize:15,
              cursor:saving?'not-allowed':'pointer',
              boxShadow:saving?'none':'0 4px 14px rgba(26,71,42,0.4)'}}>
            {saving?'⏳ Recording…':'✅ Record Payment'}
          </button>
          </>)}
        </div>
      </div>
    </div>
  );
}

// Students present within this many days count as attending (Reminders hub filter)
const ATTEND_DAYS = 90;
function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso.slice(0,10) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
const lastPresentText = (iso?: string | null) => {
  const n = daysSince(iso);
  return n === null ? 'never present' : n <= 0 ? 'present today' : n === 1 ? 'present yesterday' : `last present ${n}d ago`;
};

const chipStyle=(on:boolean,bg:string,fg:string):React.CSSProperties=>({
  padding:'6px 10px',borderRadius:20,border:'none',cursor:'pointer',fontSize:11.5,fontWeight:800,
  whiteSpace:'nowrap',backgroundColor:on?bg:'#fff',color:on?fg:C.muted,boxShadow:'0 1px 4px rgba(0,0,0,0.08)',
});

// ── Reminder Quick Pay ────────────────────────────────────────────────────────
// Uses bulk-record endpoint — one receipt per month, newest first
function ReminderQuickPay({row,base,onClose,onSuccess}:{
  row:any; base:string;
  onClose:()=>void; onSuccess:()=>void;
}){
  // The server sends due months newest first (same calculation as the Payments page)
  const ordered: string[] = (row.due_months||'').split(', ').filter(Boolean);
  const monthlyFee  = Number(row.monthly_fee)||0;

  const [selected,  setSelected]  = useState<Set<string>>(()=>new Set(ordered.slice(0,1)));
  const [mode,      setMode]      = useState('Cash');
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState('');
  const [results,   setResults]   = useState<any[]>([]);
  const total = selected.size * monthlyFee;

  const toggle=(m:string)=>setSelected(prev=>{
    const s=new Set(prev); s.has(m)?s.delete(m):s.add(m); return s;
  });

  const handlePay=async()=>{
    if(!selected.size){setMsg('Select at least one month');return;}
    setSaving(true);setMsg('');
    try{
      const r=await fetch(`${base}/api/data/payments/bulk-record`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          student_id:       row.student_id,
          months:           [...selected],
          amount_per_month: monthlyFee,
          mode,
          payment_date:     new Date().toISOString().split('T')[0],
          category_id:      16,  // 16 = Monthly Tuition Fee
        }),
      });
      const j=await r.json();
      if(j.status==='success'){
        setResults(j.results||[]);
        setMsg(`✅ ${j.recorded} receipt${j.recorded>1?'s':''} created`);
        // Stay open — user taps Done
      } else {
        setMsg('⚠ '+(j.error||'Failed'));
      }
    }catch{setMsg('⚠ Network error');}
    finally{setSaving(false);}
  };

  const MODES=['Cash','UPI','Bank Transfer','Card','Online'];

  return(
    <div style={{position:'fixed',inset:0,zIndex:5000,
      backgroundColor:'rgba(0,0,0,0.65)',display:'flex',alignItems:'flex-end'}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{backgroundColor:'#f0f4f1',width:'100%',
        borderRadius:'22px 22px 0 0',maxHeight:'90vh',
        display:'flex',flexDirection:'column' as const}}>

        <div style={{display:'flex',justifyContent:'center',padding:'10px 0 0'}}>
          <div style={{width:40,height:4,borderRadius:2,backgroundColor:'#d1d5db'}}/>
        </div>

        <div style={{display:'flex',justifyContent:'space-between',
          alignItems:'center',padding:'12px 18px 8px',flexShrink:0}}>
          <div>
            <div style={{fontWeight:900,fontSize:17,color:'#0d1b2a'}}>⚡ Quick Pay</div>
            <div style={{fontSize:12,color:'#6b7280',marginTop:2}}>
              {row.student_name} · ₹{monthlyFee.toLocaleString('en-IN')}/mo
            </div>
          </div>
          <button onClick={onClose} style={{background:'rgba(0,0,0,0.07)',
            border:'none',width:30,height:30,borderRadius:'50%',
            fontSize:15,cursor:'pointer',color:'#6b7280'}}>✕</button>
        </div>

        <div style={{overflowY:'auto',flex:1,padding:'0 16px 32px'}}>
          {msg&&(
            <div style={{padding:'10px 14px',borderRadius:10,marginBottom:10,
              backgroundColor:msg.startsWith('✅')?'#dcfce7':'#fee2e2',
              color:msg.startsWith('✅')?'#166534':'#dc2626',
              fontWeight:700,fontSize:13}}>{msg}</div>
          )}

          {/* Quick select */}
          <div style={{display:'flex',gap:8,marginBottom:10}}>
            <button onClick={()=>setSelected(new Set(ordered))}
              style={{flex:1,padding:'7px',borderRadius:10,
                border:'1px solid #1a472a',backgroundColor:'#f0fdf4',
                color:'#1a472a',fontWeight:700,fontSize:11,cursor:'pointer'}}>
              ☑ All ({ordered.length} months)
            </button>
            <button onClick={()=>setSelected(new Set(ordered.slice(0,1)))}
              style={{flex:1,padding:'7px',borderRadius:10,
                border:'1px solid #e5e7eb',backgroundColor:'#fff',
                color:'#6b7280',fontWeight:700,fontSize:11,cursor:'pointer'}}>
              Current Only
            </button>
            <button onClick={()=>setSelected(new Set())}
              style={{padding:'7px 10px',borderRadius:10,
                border:'1px solid #e5e7eb',backgroundColor:'#fff',
                color:'#6b7280',fontWeight:700,fontSize:11,cursor:'pointer'}}>
              Clear
            </button>
          </div>

          {/* Month list */}
          <div style={{backgroundColor:'#fff',borderRadius:14,
            border:'1px solid #e5e7eb',marginBottom:14,overflow:'hidden'}}>
            {ordered.length===0
              ? <div style={{padding:'16px',textAlign:'center' as const,
                  color:'#6b7280',fontSize:13}}>No unpaid months</div>
              : ordered.map((m,i)=>(
                <div key={m} onClick={()=>toggle(m)}
                  style={{display:'flex',alignItems:'center',gap:12,
                    padding:'11px 14px',cursor:'pointer',
                    borderBottom:i<ordered.length-1?'1px solid #f3f4f6':'none',
                    backgroundColor:selected.has(m)?'#f0fdf4':'#fff'}}>
                  <div style={{width:20,height:20,borderRadius:6,flexShrink:0,
                    border:`2px solid ${selected.has(m)?'#1a472a':'#d1d5db'}`,
                    backgroundColor:selected.has(m)?'#1a472a':'#fff',
                    display:'flex',alignItems:'center',justifyContent:'center'}}>
                    {selected.has(m)&&<span style={{color:'#fff',fontSize:12,fontWeight:900}}>✓</span>}
                  </div>
                  <span style={{flex:1,fontWeight:600,fontSize:14,
                    color:selected.has(m)?'#1a472a':'#111'}}>{m}</span>
                  <span style={{fontSize:13,color:'#6b7280'}}>
                    ₹{monthlyFee.toLocaleString('en-IN')}
                  </span>
                  {i===0&&(
                    <span style={{fontSize:10,backgroundColor:'#dbeafe',
                      color:'#1d4ed8',padding:'2px 8px',borderRadius:10,fontWeight:700}}>
                      Current
                    </span>
                  )}
                </div>
              ))
            }
          </div>

          {/* Running total */}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
            padding:'10px 14px',backgroundColor:'#0d1b2a',borderRadius:12,marginBottom:14}}>
            <span style={{color:'rgba(255,255,255,0.7)',fontSize:13}}>
              {selected.size} month{selected.size!==1?'s':''} selected
            </span>
            <span style={{color:'#c5a059',fontWeight:900,fontSize:18}}>
              ₹{total.toLocaleString('en-IN')}
            </span>
          </div>

          {/* Mode */}
          <div style={{fontSize:11,fontWeight:800,color:'#374151',
            textTransform:'uppercase' as const,letterSpacing:'0.5px',marginBottom:8}}>
            Payment Mode
          </div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap' as const,marginBottom:14}}>
            {MODES.map(m=>(
              <button key={m} onClick={()=>setMode(m)}
                style={{padding:'7px 14px',borderRadius:20,border:'none',
                  cursor:'pointer',fontSize:12,fontWeight:700,
                  backgroundColor:mode===m?'#1a472a':'#f3f4f6',
                  color:mode===m?'#fff':'#6b7280',
                  boxShadow:mode===m?'0 2px 6px rgba(26,71,42,0.3)':'none'}}>
                {m}
              </button>
            ))}
          </div>

          {/* Date */}
          <div style={{fontSize:12,color:'#6b7280',marginBottom:14,
            padding:'8px 12px',backgroundColor:'#f9fafb',
            borderRadius:10,border:'1px solid #e5e7eb'}}>
            📅 Payment Date: <strong>{new Date().toLocaleDateString('en-GB',{
              day:'numeric',month:'short',year:'numeric'
            })}</strong> (today)
          </div>

          {/* Confirm */}
          {results.length > 0 ? (
            <div style={{backgroundColor:'#f0fdf4',borderRadius:12,
              border:'1px solid #86efac',padding:'12px 14px'}}>
              <div style={{fontWeight:800,fontSize:13,color:'#166534',marginBottom:8}}>
                🧾 Receipts Created
              </div>
              {results.filter((r:any)=>r.status==='recorded').map((r:any)=>(
                <div key={r.month} style={{display:'flex',justifyContent:'space-between',
                  fontSize:12,marginBottom:4}}>
                  <span style={{color:'#166534',fontWeight:600}}>{r.month}</span>
                  <span style={{color:'#1a472a',fontWeight:800}}>{r.receipt_no}</span>
                </div>
              ))}
              {results.filter((r:any)=>r.status==='duplicate').map((r:any)=>(
                <div key={r.month} style={{fontSize:11,color:'#6b7280',marginBottom:4}}>
                  {r.month} — Already paid · {r.receipt_no}
                </div>
              ))}
              <button onClick={()=>onSuccess()}
                style={{width:'100%',marginTop:10,padding:'10px',borderRadius:10,
                  border:'none',backgroundColor:'#166534',color:'#fff',
                  fontWeight:800,fontSize:13,cursor:'pointer'}}>
                ✓ Done
              </button>
            </div>
          ) : (
            <button onClick={handlePay}
              disabled={saving||selected.size===0}
              style={{width:'100%',padding:'16px',borderRadius:14,border:'none',
                backgroundColor:saving||selected.size===0?'#9ca3af':'#1a472a',
                color:'#fff',fontWeight:900,fontSize:15,
                cursor:saving||selected.size===0?'not-allowed':'pointer',
                boxShadow:selected.size>0&&!saving?'0 4px 14px rgba(26,71,42,0.4)':'none'}}>
              {saving?'⏳ Recording…'
                :selected.size===0?'Select months to pay'
                :`✅ Pay Rs.${total.toLocaleString()} (${selected.size} month${selected.size!==1?'s':''})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Reminder Write-off ────────────────────────────────────────────────────────
function ReminderWriteOff({row,base,onClose,onSuccess}:{
  row:any; base:string;
  onClose:()=>void; onSuccess:()=>void;
}){
  const ordered: string[] = (row.due_months||'').split(', ').filter(Boolean);   // newest first, from the server
  const monthlyFee = Number(row.monthly_fee)||0;

  const [selected, setSelected] = useState<Set<string>>(new Set()); // none pre-ticked
  const [reason,   setReason]   = useState('Financial Hardship');
  const [remarks,  setRemarks]  = useState('');
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState('');
  const [woRes,    setWoRes]    = useState<any[]>([]);
  const total = selected.size * monthlyFee;

  const toggle=(m:string)=>setSelected(prev=>{
    const s=new Set(prev); s.has(m)?s.delete(m):s.add(m); return s;
  });

  const REASONS=[
    'Financial Hardship','Long Absence',
    'Management Decision','Scholarship / Sponsored','Other',
  ];

  const handleWriteOff=async()=>{
    if(!selected.size){setMsg('Select at least one month');return;}
    if(reason==='Other'&&!remarks.trim()){setMsg('Remarks required for Other');return;}
    setSaving(true);setMsg('');
    try{
      const r=await fetch(`${base}/api/data/write-offs/bulk-create`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          student_id:       row.student_id,
          months:           [...selected],
          amount_per_month: monthlyFee,
          reason,
          remarks,
        }),
      });
      const j=await r.json();
      if(j.status==='success'){
        setWoRes(j.results||[]);
        setMsg(`✅ ${j.written_off} month${j.written_off!==1?'s':''} written off`);
      } else {
        setMsg('⚠ '+(j.error||'Failed'));
      }
    }catch{setMsg('⚠ Network error');}
    finally{setSaving(false);}
  };

  return(
    <div style={{position:'fixed',inset:0,zIndex:5000,
      backgroundColor:'rgba(0,0,0,0.65)',display:'flex',alignItems:'flex-end'}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{backgroundColor:'#f0f4f1',width:'100%',
        borderRadius:'22px 22px 0 0',maxHeight:'90vh',
        display:'flex',flexDirection:'column' as const}}>

        <div style={{display:'flex',justifyContent:'center',padding:'10px 0 0'}}>
          <div style={{width:40,height:4,borderRadius:2,backgroundColor:'#d1d5db'}}/>
        </div>

        <div style={{display:'flex',justifyContent:'space-between',
          alignItems:'center',padding:'12px 18px 8px',flexShrink:0}}>
          <div>
            <div style={{fontWeight:900,fontSize:17,color:'#0d1b2a'}}>✏️ Write-off Fees</div>
            <div style={{fontSize:12,color:'#6b7280',marginTop:2}}>
              {row.student_name} · Admin only
            </div>
          </div>
          <button onClick={onClose} style={{background:'rgba(0,0,0,0.07)',
            border:'none',width:30,height:30,borderRadius:'50%',
            fontSize:15,cursor:'pointer',color:'#6b7280'}}>✕</button>
        </div>

        <div style={{overflowY:'auto',flex:1,padding:'0 16px 32px'}}>
          {msg&&(
            <div style={{padding:'10px 14px',borderRadius:10,marginBottom:10,
              backgroundColor:msg.startsWith('✅')?'#dcfce7':'#fee2e2',
              color:msg.startsWith('✅')?'#166534':'#dc2626',
              fontWeight:700,fontSize:13}}>{msg}</div>
          )}

          {/* Warning */}
          <div style={{padding:'10px 14px',borderRadius:10,marginBottom:14,
            backgroundColor:'#fffbeb',border:'1px solid #fcd34d',
            fontSize:12,color:'#92400e',fontWeight:600}}>
            ⚠ Write-offs are reversible but create a permanent audit record.
            Month will be marked as Waived — no payment receipt created.
          </div>

          {/* Quick select */}
          <div style={{display:'flex',gap:8,marginBottom:10}}>
            <button onClick={()=>setSelected(new Set(ordered))}
              style={{flex:1,padding:'7px',borderRadius:10,
                border:'1px solid #dc2626',backgroundColor:'#fee2e2',
                color:'#dc2626',fontWeight:700,fontSize:11,cursor:'pointer'}}>
              ☑ All Remaining ({ordered.length})
            </button>
            <button onClick={()=>setSelected(new Set())}
              style={{padding:'7px 10px',borderRadius:10,
                border:'1px solid #e5e7eb',backgroundColor:'#fff',
                color:'#6b7280',fontWeight:700,fontSize:11,cursor:'pointer'}}>
              Clear
            </button>
          </div>

          {/* Month list */}
          <div style={{backgroundColor:'#fff',borderRadius:14,
            border:'1px solid #e5e7eb',marginBottom:14,overflow:'hidden'}}>
            {ordered.length===0
              ? <div style={{padding:'16px',textAlign:'center' as const,
                  color:'#6b7280',fontSize:13}}>No unpaid months to write off</div>
              : ordered.map((m,i)=>(
                <div key={m} onClick={()=>toggle(m)}
                  style={{display:'flex',alignItems:'center',gap:12,
                    padding:'11px 14px',cursor:'pointer',
                    borderBottom:i<ordered.length-1?'1px solid #f3f4f6':'none',
                    backgroundColor:selected.has(m)?'#fee2e2':'#fff'}}>
                  <div style={{width:20,height:20,borderRadius:6,flexShrink:0,
                    border:`2px solid ${selected.has(m)?'#dc2626':'#d1d5db'}`,
                    backgroundColor:selected.has(m)?'#dc2626':'#fff',
                    display:'flex',alignItems:'center',justifyContent:'center'}}>
                    {selected.has(m)&&<span style={{color:'#fff',fontSize:12,fontWeight:900}}>✓</span>}
                  </div>
                  <span style={{flex:1,fontWeight:600,fontSize:14,
                    color:selected.has(m)?'#dc2626':'#111'}}>{m}</span>
                  <span style={{fontSize:13,color:'#6b7280'}}>
                    ₹{monthlyFee.toLocaleString('en-IN')}
                  </span>
                </div>
              ))
            }
          </div>

          {/* Running total */}
          {selected.size>0&&(
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
              padding:'10px 14px',backgroundColor:'#dc2626',borderRadius:12,marginBottom:14}}>
              <span style={{color:'rgba(255,255,255,0.8)',fontSize:13}}>
                Writing off {selected.size} month{selected.size!==1?'s':''}
              </span>
              <span style={{color:'#fff',fontWeight:900,fontSize:18}}>
                ₹{total.toLocaleString('en-IN')}
              </span>
            </div>
          )}

          {/* Reason */}
          <div style={{fontSize:11,fontWeight:800,color:'#374151',
            textTransform:'uppercase' as const,letterSpacing:'0.5px',marginBottom:8}}>
            Reason *
          </div>
          <div style={{display:'flex',flexDirection:'column' as const,gap:6,marginBottom:14}}>
            {REASONS.map(r=>(
              <button key={r} onClick={()=>setReason(r)}
                style={{padding:'10px 14px',borderRadius:10,border:'none',
                  cursor:'pointer',fontSize:13,fontWeight:600,
                  textAlign:'left' as const,
                  backgroundColor:reason===r?'#0d1b2a':'#fff',
                  color:reason===r?'#c5a059':'#374151',
                  outline:`1.5px solid ${reason===r?'#0d1b2a':'#e5e7eb'}`}}>
                {reason===r?'● ':'○ '}{r}
              </button>
            ))}
          </div>

          {/* Remarks */}
          <div style={{fontSize:11,fontWeight:800,color:'#374151',
            textTransform:'uppercase' as const,letterSpacing:'0.5px',marginBottom:6}}>
            Remarks {reason==='Other'?'* (required)':'(optional)'}
          </div>
          <textarea value={remarks} onChange={e=>setRemarks(e.target.value)}
            placeholder="Add notes about this write-off decision…"
            maxLength={500} rows={3}
            style={{width:'100%',padding:'10px 12px',borderRadius:10,
              border:`1.5px solid ${reason==='Other'&&!remarks?'#dc2626':'#e5e7eb'}`,
              fontSize:13,outline:'none',fontFamily:'inherit',
              boxSizing:'border-box' as const,resize:'none' as const,
              marginBottom:14}}/>

          {/* Confirm */}
          {woRes.length > 0 ? (
            <div style={{backgroundColor:'#f3f4f6',borderRadius:12,
              border:'1px solid #d1d5db',padding:'12px 14px'}}>
              <div style={{fontWeight:800,fontSize:13,color:'#374151',marginBottom:8}}>
                ⚫ Written Off
              </div>
              {woRes.filter((r:any)=>r.status==='written_off').map((r:any)=>(
                <div key={r.month} style={{fontSize:12,color:'#374151',
                  fontWeight:600,marginBottom:4}}>⚫ {r.month} — WO-{r.id}</div>
              ))}
              <button onClick={()=>onSuccess()}
                style={{width:'100%',marginTop:10,padding:'10px',borderRadius:10,
                  border:'none',backgroundColor:'#374151',color:'#fff',
                  fontWeight:800,fontSize:13,cursor:'pointer'}}>
                ✓ Done
              </button>
            </div>
          ) : (
            <button onClick={handleWriteOff}
              disabled={saving||selected.size===0}
              style={{width:'100%',padding:'16px',borderRadius:14,border:'none',
                backgroundColor:saving||selected.size===0?'#9ca3af':'#dc2626',
                color:'#fff',fontWeight:900,fontSize:15,
                cursor:saving||selected.size===0?'not-allowed':'pointer',
                boxShadow:selected.size>0&&!saving?'0 4px 14px rgba(220,38,38,0.4)':'none'}}>
              {saving?'⏳ Processing…'
                :selected.size===0?'Select months to write off'
                :`✏️ Write-off Rs.${total.toLocaleString()} (${selected.size} month${selected.size!==1?'s':''})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Student card ──────────────────────────────────────────────────────────────
function StudentCard({row,base,onSent,onPayment,can}:{
  row:any; base:string;
  onSent:(sid:number,month:string,tier:number)=>void;
  onPayment:()=>void;
  can:(s:string)=>boolean;
}){
  const months=(row.due_months||'').split(', ').filter(Boolean);
  const [expanded,    setExpanded]    =useState(false);   // reminder history
  const [open,        setOpen]        =useState(false);   // card details + actions
  const [sendEmail,   setSendEmail]   =useState<Record<string,boolean>>({});
  const [sendWA,      setSendWA]      =useState<Record<string,boolean>>({});
  const [emailSent,   setEmailSent]   =useState<Record<string,number>>({});
  const [waSent,      setWASent]      =useState<Record<string,number>>({});
  const [sentTiers,   setSentTiers]   =useState<Record<string,number>>(row.sent_tiers||{});
  const [error,       setError]       =useState('');
  const [showQuickPay,setShowQuickPay]=useState(false);
  const [showWriteOff,setShowWriteOff]=useState(false);
  const isAdmin=(localStorage.getItem('user_role')||'').toLowerCase()==='admin';

  const rawOf=(m:string)=>m.split(' ')[0];
  const nextTier=(raw:string)=>Math.min((sentTiers[raw]||0)+1,3) as 1|2|3;
  const tierColor=(t:number)=>TIER_COLORS[t]||C.gold;

  const doEmail=async(raw:string,full:string)=>{
    const tier=nextTier(raw);
    setSendEmail(s=>({...s,[raw]:true}));setError('');
    try{
      const r=await fetch(`${base}/api/data/reminders/send_email`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          student_id:   row.student_id,
          billing_month:raw,
          tier,
          parent_email: row.parent_email,
          parent_name:  row.parent_name,
          student_name: row.student_name,
          balance_due:  row.balance_due,
          monthly_fee:  row.monthly_fee,
        }),
      });
      const j=await r.json();
      if(j.success){setEmailSent(s=>({...s,[raw]:tier}));setSentTiers(s=>({...s,[raw]:tier}));onSent(row.student_id,raw,tier);}
      else setError('✉ '+(j.error||'Failed')+(j.hint?'\n'+j.hint:''));
    }catch{setError('Network error');}
    finally{setSendEmail(s=>({...s,[raw]:false}));}
  };

  const doWA=async(raw:string)=>{
    const tier=nextTier(raw);
    setSendWA(s=>({...s,[raw]:true}));setError('');
    try{
      const r=await fetch(`${base}/api/data/reminders/send_wa`,{
        method:'POST',headers:hdr(),
        body:JSON.stringify({
          student_id:   row.student_id,
          billing_month:raw,
          tier,
          parent_name:  row.parent_name,
          student_name: row.student_name,
          balance_due:  row.balance_due,
        }),
      });
      const j=await r.json();
      if(j.success){setWASent(s=>({...s,[raw]:tier}));setSentTiers(s=>({...s,[raw]:tier}));onSent(row.student_id,raw,tier);}
      else setError('💬 '+(j.error||'Failed'));
    }catch{setError('Network error');}
    finally{setSendWA(s=>({...s,[raw]:false}));}
  };

  // Urgency badge
  const urgency=row.total_unpaid>=3?'🔴 Critical':row.total_unpaid===2?'🟠 Overdue':'🟡 Due';
  const urgencyBg=row.total_unpaid>=3?'#fee2e2':row.total_unpaid===2?'#fff7ed':'#fefce8';
  const urgencyColor=row.total_unpaid>=3?C.red:row.total_unpaid===2?C.orange:'#ca8a04';

  return(
    <div style={{backgroundColor:C.card,borderRadius:14,marginBottom:8,
      boxShadow:'0 1px 4px rgba(0,0,0,0.05)',
      border:`1px solid ${open?C.navy+'55':C.border}`,overflow:'hidden'}}>

      {/* ── Student summary — tap to open ── */}
      <button onClick={()=>setOpen(v=>!v)} aria-expanded={open}
        style={{width:'100%',padding:'8px 12px',display:'flex',alignItems:'center',gap:10,
          background:'none',border:'none',cursor:'pointer',textAlign:'left' as const,
          boxShadow:`inset 3px 0 0 ${urgencyColor}`}}>
        <StudentPhoto student={{name:row.student_name,profile_image:row.profile_image||null}} size={38} style={{borderRadius:10,flexShrink:0}}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:800,fontSize:14,color:C.navy,
            overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
            {row.student_name}
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
            {(row.regno||row.qca_id) && (
              <span style={{color:'#1a472a',fontWeight:700}}>
                {row.regno ? formatRegno(row.regno) : ''}{row.qca_id ? ` · Q${String(row.qca_id).padStart(3,'0')}` : ''}
              </span>
            )}
            {row.parent_name ? ` · 👤 ${row.parent_name}` : ''}
            {!row.parent_phone && !row.parent_email && (
              <span style={{color:C.red,fontWeight:700}}> · ⚠ no phone or email</span>
            )}
          </div>
        </div>
        <div style={{flexShrink:0,textAlign:'right' as const}}>
          <div style={{fontWeight:900,fontSize:15,color:C.red}}>
            ₹{(row.balance_due||0).toLocaleString('en-IN')}
          </div>
          <div style={{fontSize:10,fontWeight:700,marginTop:1,color:urgencyColor}}>
            {row.total_unpaid} mo · {urgency.replace(/^\S+\s/,'')}
          </div>
        </div>
        <span style={{color:C.muted,fontSize:11,width:10,flexShrink:0}}>{open?'▲':'▼'}</span>
      </button>

      {open&&(<>
      {row.parent_email&&(
        <div style={{padding:'0 12px 6px 60px',fontSize:11,color:C.green,
          overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>
          ✉ {row.parent_email}
        </div>
      )}

      {/* ── Stats (one line) ── */}
      <div style={{padding:'5px 12px',backgroundColor:'#f8fafc',fontSize:11,color:C.muted,
        borderTop:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`}}>
        <b style={{color:C.green}}>{row.current_attendance}</b> sessions this month ·{' '}
        {'last_present' in row && <><span style={{color:(daysSince(row.last_present) ?? 9999) > ATTEND_DAYS ? C.red : C.muted}}>
          {lastPresentText(row.last_present)}</span> ·{' '}</>}
        <b style={{color:C.navy}}>₹{(row.monthly_fee||0).toLocaleString('en-IN')}</b>/mo ·{' '}
        joined {row.enrollment_date?.slice(0,10)||'—'}
      </div>

      {/* ── Due months ── */}
      <div style={{padding:'0 12px'}}>
        {months.map((m:string,i:number)=>{
          const raw=rawOf(m);
          const tier=sentTiers[raw]||0;
          const next=nextTier(raw);
          const isEmailSent=!!emailSent[raw];
          const isWASent=!!waSent[raw];

          return(
            <div key={i} style={{padding:'6px 0',display:'flex',alignItems:'center',gap:8,
              borderBottom:i<months.length-1?`1px solid #f3f4f6`:'none'}}>
              {/* Month */}
              <div style={{flex:1,minWidth:0}}>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:C.navy}} title={`Next: ${TIER_LABELS[next]}`}>
                    {raw} <span style={{fontSize:10,fontWeight:700,color:tierColor(next)}}>· next {TIER_LABELS[next]}</span>
                  </div>
                  {m.includes('(')&&(
                    <div style={{fontSize:10,color:C.muted,marginTop:2}}>
                      {m.slice(m.indexOf('('))}
                    </div>
                  )}
                  {tier>0&&(
                    <div style={{fontSize:10,fontWeight:700,marginTop:3,
                      color:tierColor(tier)}}>
                      {TIER_ICONS[tier]} {TIER_LABELS[tier]} sent
                    </div>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div style={{display:'flex',gap:5,flexShrink:0}}>
                {/* Email */}
                {can('payments:add') && (isEmailSent?(
                  <div style={{padding:'6px 8px',borderRadius:9,textAlign:'center' as const,
                    backgroundColor:'#f0fdf4',border:'1px solid #86efac',
                    fontSize:11,fontWeight:700,color:C.green}}>
                    ✉ Sent ✓
                  </div>
                ):row.parent_email?(
                  <button onClick={()=>doEmail(raw,m)}
                    disabled={sendEmail[raw]}
                    style={{padding:'7px 10px',borderRadius:9,border:'none',
                      cursor:sendEmail[raw]?'not-allowed':'pointer',
                      fontWeight:700,fontSize:11,
                      backgroundColor:sendEmail[raw]?'#f3f4f6':tierColor(next),
                      color:sendEmail[raw]?C.muted:'#fff',
                      opacity:sendEmail[raw]?0.7:1}}>
                    {sendEmail[raw]?'⏳…':`${TIER_ICONS[next]} Email`}
                  </button>
                ):(
                  <div title="No email on file" style={{padding:'6px 8px',borderRadius:9,textAlign:'center' as const,
                    backgroundColor:'#f9fafb',fontSize:11,color:C.muted}}>
                    No email
                  </div>
                ))}

                {/* WhatsApp */}
                {can('payments:add') && (isWASent?(
                  <div style={{padding:'6px 8px',borderRadius:9,textAlign:'center' as const,
                    backgroundColor:'#f0fdf4',border:'1px solid #86efac',
                    fontSize:11,fontWeight:700,color:'#25d366'}}>
                    💬 Sent ✓
                  </div>
                ):(
                  <button onClick={()=>doWA(raw)}
                    disabled={sendWA[raw]}
                    style={{padding:'7px 10px',borderRadius:9,border:'none',
                      cursor:sendWA[raw]?'not-allowed':'pointer',
                      fontWeight:700,fontSize:11,
                      backgroundColor:sendWA[raw]?'#f3f4f6':'#25d366',
                      color:sendWA[raw]?C.muted:'#fff',
                      opacity:sendWA[raw]?0.7:1}}>
                    {sendWA[raw]?'⏳…':'💬 WA'}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Error ── */}
      {error&&(
        <div style={{margin:'0 14px 10px',padding:'8px 12px',
          borderRadius:10,backgroundColor:'#fee2e2',
          fontSize:11,fontWeight:700,color:C.red,
          whiteSpace:'pre-line' as const}}>
          ⚠ {error}
        </div>
      )}

      {/* ── Footer actions ── */}
      <div style={{display:'flex',borderTop:`1px solid ${C.border}`,
        backgroundColor:'#fafafa',flexWrap:'wrap' as const}}>
        <button onClick={()=>setExpanded(v=>!v)}
          style={{flex:'0 0 30%',padding:'8px',border:'none',
            borderRight:`1px solid ${C.border}`,
            backgroundColor:'transparent',cursor:'pointer',
            fontSize:11,fontWeight:700,color:C.muted}}>
          {expanded?'▲ Less':'▼ History'}
        </button>
        {can('payments:add')&&(
          <button onClick={()=>setShowQuickPay(true)}
            style={{flex:'1 1 auto',padding:'8px',border:'none',
              borderRight:`1px solid ${C.border}`,
              backgroundColor:'#1a472a',cursor:'pointer',
              fontSize:12,fontWeight:800,color:'#fff'}}>
            ⚡ Quick Pay
          </button>
        )}
        {can('payments:add')&&(
          <button onClick={onPayment}
            style={{flex:'0 0 30%',padding:'8px',border:'none',
              borderRight:`1px solid ${C.border}`,
              backgroundColor:'#0d1b2a',cursor:'pointer',
              fontSize:11,fontWeight:700,color:'#c5a059'}}>
            💰 Custom
          </button>
        )}
        {isAdmin&&can('payments:add')&&(
          <button onClick={()=>setShowWriteOff(true)}
            style={{flex:'0 0 100%',padding:'8px',border:'none',
              borderTop:`1px solid ${C.border}`,
              backgroundColor:'#fee2e2',cursor:'pointer',
              fontSize:11,fontWeight:700,color:'#dc2626'}}>
            ✏️ Write-off Dues
          </button>
        )}
      </div>
      </>)}

      {/* Quick Pay modal */}
      {showQuickPay&&(
        <ReminderQuickPay
          row={row} base={base}
          onClose={()=>setShowQuickPay(false)}
          onSuccess={()=>{setShowQuickPay(false);onPayment();}}
        />
      )}

      {/* Write-off modal */}
      {showWriteOff&&(
        <ReminderWriteOff
          row={row} base={base}
          onClose={()=>setShowWriteOff(false)}
          onSuccess={()=>{setShowWriteOff(false);onPayment();}}
        />
      )}

      {/* ── Reminder history (expanded) ── */}
      {expanded&&(
        <div style={{padding:'12px 14px',backgroundColor:'#f9fafb',
          borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:10,fontWeight:800,color:C.muted,
            textTransform:'uppercase' as const,letterSpacing:'0.8px',marginBottom:8}}>
            Reminder History
          </div>
          {Object.keys(sentTiers).length===0?(
            <div style={{fontSize:12,color:C.muted,fontStyle:'italic'}}>
              No reminders sent yet
            </div>
          ):(
            Object.entries(sentTiers).map(([month,tier])=>(
              <div key={month} style={{display:'flex',justifyContent:'space-between',
                alignItems:'center',padding:'4px 0',
                borderBottom:'1px solid #f0f0f0'}}>
                <span style={{fontSize:12,color:C.navy,fontWeight:600}}>{month}</span>
                <span style={{fontSize:11,fontWeight:700,
                  color:tierColor(tier as number)}}>
                  {TIER_ICONS[tier as number]} {TIER_LABELS[tier as number]}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Config Panel ──────────────────────────────────────────────────────────────
function ConfigPanel({base,onClose}:{base:string;onClose:()=>void}){
  const [cfg,    setCfg]    =useState<Record<string,string>>({});
  const [loading,setLoading]=useState(true);
  const [saving, setSaving] =useState(false);
  const [msg,    setMsg]    =useState('');

  useEffect(()=>{
    fetch(`${base}/api/data/reminders/config`,{headers:hdr()})
      .then(r=>r.ok?r.json():null)
      .then(j=>{if(j?.config)setCfg(j.config);setLoading(false);})
      .catch(()=>setLoading(false));
  },[base]);

  const save=async()=>{
    setSaving(true);
    try{
      const r=await fetch(`${base}/api/data/reminders/config`,
        {method:'POST',headers:hdr(),body:JSON.stringify(cfg)});
      const j=await r.json();
      if(j.success){setMsg('✅ Saved');setTimeout(()=>{setMsg('');onClose();},1200);}
      else setMsg('❌ '+j.error);
    }catch{setMsg('❌ Network error');}
    finally{setSaving(false);}
  };

  const F:React.CSSProperties={width:'100%',padding:'11px 14px',borderRadius:10,
    border:`1.5px solid ${C.border}`,fontSize:14,outline:'none',
    boxSizing:'border-box' as const,fontFamily:'inherit'};
  const Label=({t}:{t:string})=>(
    <div style={{fontSize:11,fontWeight:800,color:'#374151',
      textTransform:'uppercase' as const,letterSpacing:'0.5px',
      marginBottom:4,marginTop:14}}>{t}</div>
  );

  if(loading)return<div style={{padding:24,textAlign:'center',color:C.muted}}>Loading…</div>;
  return(
    <div style={{padding:'0 16px 16px'}}>
      <Label t="Academy Name"/>
      <input value={cfg.academy_name||''} onChange={e=>setCfg(c=>({...c,academy_name:e.target.value}))}
        placeholder="Quickies Cricket Club" style={F}/>
      <Label t="Grace Period (day of month)"/>
      <input type="number" value={cfg.grace_day||'10'}
        onChange={e=>setCfg(c=>({...c,grace_day:e.target.value}))}
        min="1" max="28" style={F}/>
      <Label t="Escalate to 2nd Reminder (days after 1st)"/>
      <input type="number" value={cfg.tier2_days||'7'}
        onChange={e=>setCfg(c=>({...c,tier2_days:e.target.value}))} min="1" style={F}/>
      <Label t="Escalate to Final Notice (days after 2nd)"/>
      <input type="number" value={cfg.tier3_days||'14'}
        onChange={e=>setCfg(c=>({...c,tier3_days:e.target.value}))} min="1" style={F}/>
      <Label t="UPI Payment ID (VPA)"/>
      <input value={cfg.upi_vpa||''} onChange={e=>setCfg(c=>({...c,upi_vpa:e.target.value}))}
        placeholder="110236312057@cnrb" style={F}/>
      {cfg.upi_vpa&&(
        <div style={{marginTop:6,padding:'8px 12px',borderRadius:8,
          backgroundColor:'#f0fdf4',border:'1px solid #86efac',
          fontSize:11,color:'#166534'}}>
          GPay link: pay.google.com/…?pa={cfg.upi_vpa}
        </div>
      )}
      <Label t="QR Code URL (Cloudinary)"/>
      <input value={cfg.qr_url||''} onChange={e=>setCfg(c=>({...c,qr_url:e.target.value}))}
        placeholder="https://res.cloudinary.com/…/qr.png" style={F}/>
      {cfg.qr_url&&(
        <div style={{marginTop:8,textAlign:'center' as const}}>
          <img src={cfg.qr_url} alt="QR" style={{maxWidth:100,borderRadius:8,
            border:`2px solid ${C.border}`,padding:4}}/>
        </div>
      )}
      <div style={{marginTop:14,padding:'10px 12px',borderRadius:10,
        backgroundColor:'#f0f9ff',border:'1px solid #bae6fd'}}>
        <div style={{fontSize:11,fontWeight:700,color:'#0369a1',marginBottom:4}}>
          📋 Channel Config (server .env)
        </div>
        <div style={{fontSize:11,color:'#0369a1',lineHeight:1.7}}>
          ✉ Email: ZOHO_EMAIL + ZOHO_PASSWORD → RESEND_API_KEY (fallback)<br/>
          💬 WhatsApp: META_WA_TOKEN + META_WA_PHONE_ID
        </div>
      </div>
      {msg&&<div style={{marginTop:12,fontSize:13,fontWeight:700,textAlign:'center' as const,
        color:msg.startsWith('✅')?C.green:C.red}}>{msg}</div>}
      <div style={{display:'flex',gap:10,marginTop:16}}>
        <button onClick={onClose} style={{flex:1,padding:'11px',borderRadius:10,
          border:`1px solid ${C.border}`,backgroundColor:'#fff',
          color:C.muted,fontWeight:700,fontSize:13,cursor:'pointer'}}>
          Cancel
        </button>
        <button onClick={save} disabled={saving}
          style={{flex:2,padding:'11px',borderRadius:10,border:'none',
            backgroundColor:saving?C.muted:C.navy,color:C.gold,
            fontWeight:800,fontSize:13,cursor:saving?'not-allowed':'pointer'}}>
          {saving?'Saving…':'💾 Save Configuration'}
        </button>
      </div>
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function RemindersScreen(){
  const navigate  =useNavigate();
  const {can}     =usePermissions();
  const base      =bld(localStorage.getItem('server_ip')||'');

  const [data,    setData]    =useState<any[]>([]);
  const [summary, setSummary] =useState<any|null>(null);
  const [loading, setLoading] =useState(false);
  const [error,   setError]   =useState('');
  const [queried, setQueried] =useState(false);
  const [showCfg, setShowCfg] =useState(false);

  // Search + filter
  const [search,     setSearch]     =useState('');
  const [filterDue,  setFilterDue]  =useState<'all'|'1-2'|'3+'>('all');
  // Attending = marked present in the last 90 days (default on)
  const [attendingOnly,setAttendingOnly]=useState(true);
  const [sortBy,     setSortBy]     =useState<'due'|'name'>('due');

  // Quick pay modal
  const [payStudent,setPayStudent]=useState<any|null>(null);

  const runQuery=useCallback(async()=>{
    setLoading(true);setError('');setQueried(false);
    try{
      const r=await fetch(`${base}/api/data/reminders/query`,{headers:hdr()});
      if(!r.ok){setError(`Server error (${r.status})`);return;}
      const j=await r.json();
      setData(j.data||[]);
      setSummary(j.summary||null);
      setQueried(true);
    }catch{setError('Could not reach server — check Settings');}
    finally{setLoading(false);}
  },[base]);

  const handleSent=(sid:number,month:string,tier:number)=>{
    setData(d=>d.map(row=>
      row.student_id===sid
        ?{...row,sent_tiers:{...row.sent_tiers,[month]:tier}}
        :row
    ));
  };

  // Older servers don't send last_present: the attending filter is then switched off
  const hasPresence=data.some(r=>'last_present' in r);
  const isAttending=(r:any)=>{const n=daysSince(r.last_present);return n!==null&&n<=ATTEND_DAYS;};
  const attendingN=data.filter(isAttending).length;
  // Header totals follow the Attending / All active choice
  const scope=attendingOnly&&hasPresence?data.filter(isAttending):data;
  const stats={
    total_balance:   scope.reduce((t,r)=>t+(r.balance_due||0),0),
    total_accounts:  scope.length,
    urgent_accounts: scope.filter(r=>(r.total_unpaid||0)>=3).length,
  };

  // Apply search + filters + sort
  const filtered=data
    .filter(row=>{
      if(search){
        const q=search.toLowerCase();
        if(!matchesStudentSearch({name: row.student_name, regno: row.regno, qca_id: row.qca_id}, q) &&
           !row.parent_name?.toLowerCase().includes(q)&&
           !row.parent_email?.toLowerCase().includes(q)) return false;
      }
      if(filterDue!=='all'){
        const n=row.total_unpaid||0;
        if(filterDue==='1-2'&&n>2) return false;
        if(filterDue==='3+'&&n<3)  return false;
      }
      if(attendingOnly&&hasPresence){
        const n=daysSince(row.last_present);
        if(n===null||n>ATTEND_DAYS) return false;
      }
      return true;
    })
    .sort((a,b)=>{
      if(sortBy==='name')    return (a.student_name||'').localeCompare(b.student_name||'');
      return (b.balance_due||0)-(a.balance_due||0); // default: balance
    });

  if(!can('payments:alerts')){
    return(
      <div style={{backgroundColor:C.bg,minHeight:'100vh',display:'flex',
        alignItems:'center',justifyContent:'center',padding:24}}>
        <div style={{textAlign:'center',color:C.muted}}>
          <div style={{fontSize:48,marginBottom:12}}>🔒</div>
          <div style={{fontWeight:800,fontSize:16,color:C.navy}}>Access Restricted</div>
          <div style={{fontSize:13,marginTop:6}}>payments:alerts required</div>
        </div>
      </div>
    );
  }

  return(
    <div style={{backgroundColor:C.bg,minHeight:'100vh',paddingBottom:40}}>

      {/* ── Header ── */}
      <ScreenHeader background={`linear-gradient(135deg,${C.navy} 60%,#002b5c 100%)`}
        title={<span style={{color:C.gold}}>💳 Reminder Hub</span>}
        subtitle="Manual only · Every action requires your tap"
        actions={<HeaderIconButton label="Reminder settings" onClick={()=>setShowCfg(v=>!v)}>⚙️</HeaderIconButton>} />
      <div style={{background:`linear-gradient(135deg,${C.navy} 60%,#002b5c 100%)`}}>
        {/* Summary pills */}
        {summary&&!loading&&(
          <div style={{display:'flex',gap:6,padding:'2px 12px 0'}}>
            <div style={{flex:1,backgroundColor:'rgba(255,255,255,0.12)',
              borderRadius:10,padding:'6px 8px',textAlign:'center' as const}}>
              <div style={{color:C.gold,fontWeight:900,fontSize:16}}>
                ₹{(stats.total_balance||0).toLocaleString('en-IN')}
              </div>
              <div style={{color:'rgba(255,255,255,0.6)',fontSize:10,
                fontWeight:700,textTransform:'uppercase' as const,marginTop:1}}>
                Total Due
              </div>
            </div>
            <div style={{flex:1,backgroundColor:'rgba(255,255,255,0.12)',
              borderRadius:10,padding:'6px 8px',textAlign:'center' as const}}>
              <div style={{color:'#fff',fontWeight:900,fontSize:16}}>
                {stats.total_accounts}
              </div>
              <div style={{color:'rgba(255,255,255,0.6)',fontSize:10,
                fontWeight:700,textTransform:'uppercase' as const,marginTop:1}}>
                Accounts
              </div>
            </div>
            <div style={{flex:1,backgroundColor:'rgba(220,38,38,0.3)',
              borderRadius:10,padding:'6px 8px',textAlign:'center' as const}}>
              <div style={{color:'#fca5a5',fontWeight:900,fontSize:16}}>
                {stats.urgent_accounts}
              </div>
              <div style={{color:'rgba(255,255,255,0.6)',fontSize:10,
                fontWeight:700,textTransform:'uppercase' as const,marginTop:1}}>
                Critical
              </div>
            </div>
          </div>
        )}

        {/* Run Query button */}
        <div style={{padding:'8px 12px 10px'}}>
          <button onClick={runQuery} disabled={loading} style={{
            width:'100%',padding:'9px',borderRadius:10,
            background:loading?'rgba(255,255,255,0.1)':'rgba(255,255,255,0.15)',
            color:loading?'rgba(255,255,255,0.5)':C.gold,
            fontWeight:800,fontSize:14,cursor:loading?'not-allowed':'pointer',
            border:'1px solid rgba(255,255,255,0.2)' as any,
            letterSpacing:'0.3px',
          }}>
            {loading?'⏳ Scanning database…':queried?'🔄 Re-Run Live Query':'▶ Run Live Query'}
          </button>
        </div>
      </div>

      {/* ── Config panel ── */}
      {showCfg&&(
        <div style={{backgroundColor:C.card,margin:'12px 16px 0',
          borderRadius:16,boxShadow:'0 4px 16px rgba(0,0,0,0.1)',
          border:`1px solid ${C.border}`,overflow:'hidden'}}>
          <div style={{padding:'13px 16px',borderBottom:`1px solid ${C.border}`,
            fontWeight:800,fontSize:14,color:C.navy,
            display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>⚙️ Configuration</span>
            <button onClick={()=>setShowCfg(false)} style={{background:'none',
              border:'none',fontSize:18,cursor:'pointer',color:C.muted}}>✕</button>
          </div>
          <ConfigPanel base={base} onClose={()=>setShowCfg(false)}/>
        </div>
      )}

      {/* ── Loading ── */}
      {loading&&(
        <div style={{textAlign:'center',padding:'48px 0',color:C.muted}}>
          <div style={{fontSize:36,marginBottom:12}}>🔍</div>
          <div style={{fontWeight:700}}>Scanning attendance & payment records…</div>
          <div style={{fontSize:12,marginTop:4}}>This takes 2–3 seconds</div>
        </div>
      )}

      {/* ── Error ── */}
      {error&&!loading&&(
        <div style={{margin:'12px 16px 0',padding:'12px 14px',borderRadius:12,
          backgroundColor:'#fee2e2',border:'1px solid #fca5a5'}}>
          <div style={{fontWeight:700,fontSize:13,color:C.red}}>⚠ {error}</div>
        </div>
      )}

      {/* ── Search + Filters ── */}
      {queried&&!loading&&data.length>0&&(
        <div style={{padding:'12px 16px 0'}}>
          {/* Search bar */}
          <div style={{position:'relative',marginBottom:10}}>
            <span style={{position:'absolute',left:12,top:'50%',
              transform:'translateY(-50%)',fontSize:15,color:C.muted}}>🔍</span>
            <input value={search}
              onChange={e=>setSearch(e.target.value)}
              placeholder={`Search ${data.length} students by name or email…`}
              style={{width:'100%',padding:'11px 12px 11px 36px',borderRadius:12,
                border:`1px solid ${C.border}`,fontSize:14,outline:'none',
                boxSizing:'border-box' as const,backgroundColor:C.card,
                boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}/>
            {search&&(
              <button onClick={()=>setSearch('')} style={{position:'absolute',
                right:12,top:'50%',transform:'translateY(-50%)',
                background:'none',border:'none',cursor:'pointer',
                fontSize:16,color:C.muted}}>✕</button>
            )}
          </div>

          {/* Attending filter */}
          {hasPresence&&(
            <div style={{display:'flex',gap:0,marginBottom:8,borderRadius:10,overflow:'hidden',
              border:`1px solid ${C.border}`,backgroundColor:'#fff'}}>
              {([[true,`🟢 Attending · ${attendingN}`],[false,`All active · ${data.length}`]] as const).map(([on,label])=>(
                <button key={String(on)} onClick={()=>setAttendingOnly(on)} style={{
                  flex:1,padding:'8px 6px',border:'none',cursor:'pointer',fontSize:12,fontWeight:800,
                  backgroundColor:attendingOnly===on?C.green:'#fff',color:attendingOnly===on?'#fff':C.muted}}>{label}</button>
              ))}
            </div>
          )}
          {hasPresence&&(
            <div style={{fontSize:11,color:C.muted,margin:'-4px 2px 8px'}}>
              {attendingOnly?`Attending = present at least once in the last ${ATTEND_DAYS} days`
                :'All active students with dues, including those not seen for a while'}
            </div>
          )}

          {/* Sort + dues filter: one row */}
          <div style={{display:'flex',alignItems:'center',gap:5}}>
            {([['due','Most due'],['name','A–Z']] as const).map(([k,label])=>(
              <button key={k} onClick={()=>setSortBy(k)} style={chipStyle(sortBy===k,C.navy,C.gold)}>{label}</button>
            ))}
            <span style={{width:1,height:18,backgroundColor:C.border,margin:'0 2px'}}/>
            {([['all','All'],['1-2','1–2 mo'],['3+','3+ Critical']] as const).map(([k,label])=>(
              <button key={k} onClick={()=>setFilterDue(k)} style={chipStyle(filterDue===k,C.red,'#fff')}>{label}</button>
            ))}
          </div>

          {/* Results count */}
          <div style={{fontSize:12,color:C.muted,marginTop:8,marginBottom:4}}>
            Showing {filtered.length} of {data.length} students
            {search&&` matching "${search}"`}
            {` · ₹${filtered.reduce((t,r)=>t+(r.balance_due||0),0).toLocaleString('en-IN')} due`}
          </div>
        </div>
      )}

      {/* ── Student cards ── */}
      <div style={{padding:'8px 16px 0'}}>
        {queried&&!loading&&filtered.length===0&&data.length>0&&(
          <div style={{textAlign:'center',padding:'32px 0',color:C.muted}}>
            <div style={{fontSize:32,marginBottom:8}}>🔍</div>
            <div style={{fontWeight:700}}>{search?`No match for "${search}"`:'No students match these filters'}</div>
            <button onClick={()=>{setSearch('');setFilterDue('all');setAttendingOnly(false);}}
              style={{marginTop:10,padding:'7px 16px',borderRadius:20,border:'none',
                backgroundColor:C.navy,color:C.gold,fontWeight:700,
                fontSize:12,cursor:'pointer'}}>
              Clear Filters
            </button>
          </div>
        )}

        {queried&&!loading&&data.length===0&&(
          <div style={{textAlign:'center',padding:'48px 0',color:C.muted}}>
            <div style={{fontSize:48,marginBottom:12}}>🎉</div>
            <div style={{fontWeight:800,fontSize:16,color:C.navy}}>All Fees Cleared!</div>
            <div style={{fontSize:13,marginTop:6}}>No outstanding payments</div>
          </div>
        )}

        {!loading&&filtered.map(row=>(
          <StudentCard
            key={row.student_id}
            row={row}
            base={base}
            can={can}
            onSent={handleSent}
            onPayment={()=>setPayStudent(row)}
          />
        ))}

        {/* Pre-query state */}
        {!queried&&!loading&&!error&&(
          <div style={{textAlign:'center',padding:'48px 0',color:C.muted}}>
            <div style={{fontSize:48,marginBottom:12}}>📊</div>
            <div style={{fontWeight:800,fontSize:16,color:C.navy,marginBottom:8}}>
              Payment Reminder Hub
            </div>
            <div style={{fontSize:13,lineHeight:1.8,color:C.muted}}>
              Tap <strong style={{color:C.navy}}>Run Live Query</strong> above<br/>
              to scan attendance & payment records<br/>
              and find all students with outstanding fees.
            </div>
          </div>
        )}
      </div>

      {/* ── Quick Pay Modal ── */}
      {payStudent&&(
        <QuickPayModal
          student={payStudent}
          base={base}
          onClose={()=>setPayStudent(null)}
          onSuccess={(receipt)=>{
            setPayStudent(null);
            // Re-run query to reflect payment
            runQuery();
          }}
        />
      )}
    </div>
  );
}
