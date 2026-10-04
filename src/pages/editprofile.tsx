import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { updateLocalStudent, invalidateStudentImage } from '../database/db';
import { fmtRegNo } from './studentUtils';
import { usePermissions, getLinkedStudentIds } from './usePermissions';
import StudentPhoto from '../shared/StudentPhoto';
import ScreenHeader from '../shared/ScreenHeader';

// ── Constants — exact match with edit_student.html ────────────────────────────
const ISD_FLAGS: Record<string,string> = { '+91':'🇮🇳', '+971':'🇦🇪', '+44':'🇬🇧', '+1':'🇺🇸' };
const ISDS     = ['+971', '+91', '+44', '+1'];
const GENDERS  = ['Male', 'Female'];
const BLOOD    = ['', 'A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const LEVELS   = ['Beginner', 'Intermediate', 'Advanced', 'Elite'];
const TYPES    = ['Academy', 'Camp'];
const KIT_SIZES= ['', '22','24','26','28','30','32','34','36','38','40','S','M','L','XL','XXL'];
const REFERRAL = ['', 'Instagram', 'Facebook', 'Google', 'Friend/Reference', 'Banner', 'Other'];
const CATEGORY = ['REGULAR', 'TEMPORARY', 'SCHOLARSHIP'];
const STATUS   = ['Active', 'Club Member', 'Camp', 'Inactive'];
const DOM_SIDE_GROUPS = [
  { label: 'Pace All-Rounders', options: [
    'RHB | Right Arm Fast', 'RHB | Left Arm Fast',
    'LHB | Right Arm Fast', 'LHB | Left Arm Fast',
  ]},
  { label: 'Spin All-Rounders', options: [
    'RHB | Right Arm Off Spin', 'RHB | Right Arm Leg Spin',
    'RHB | Left Arm Orthodox',  'LHB | Right Arm Off Spin',
    'LHB | Left Arm Orthodox',  'RHB | Left Arm Chinaman',
  ]},
  { label: 'Wicket Keepers', options: [
    'Wicket Keeper Bat (RHB)', 'Wicket Keeper Bat (LHB)',
  ]},
  { label: 'Pure Specialists', options: [
    'Right Hand Bat Only', 'Left Hand Bat Only',
  ]},
];

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  navy:'#001f3f', gold:'#c5a059', green:'#1a472a',
  red:'#dc2626',  gray:'#6b7280', bg:'#f0f4f0',
  border:'#d1d5db', muted:'#9ca3af', blue:'#2563eb',
};
const INP: React.CSSProperties = {
  width:'100%', padding:'8px 11px', borderRadius:9,
  border:`1px solid ${C.border}`, fontSize:14, fontFamily:'sans-serif',
  outline:'none', backgroundColor:'#fff',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildBase(ip: string) {
  const u = (ip||'').trim().replace(/\/+$/,'');
  return u.startsWith('http') ? u : `http://${u}`;
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
function splitPhone(full: string): [string, string] {
  if (!full) return ['+91', ''];
  for (const isd of ISDS) {
    if (full.startsWith(isd)) return [isd, full.slice(isd.length)];
  }
  return ['+91', full.replace(/^\+\d{1,3}/,'')];
}
function calcAge(dob: string): string {
  if (!dob) return '';
  const b = new Date(dob), t = new Date();
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth()===b.getMonth() && t.getDate()<b.getDate())) a--;
  return a >= 0 ? `${a} yrs` : '';
}
const deepEqual = (a: any, b: any): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Smart Date Picker (year + month dropdowns) ────────────────────────────────
function SmartDatePicker({ value, onChange, maxDate }: {
  value: string; onChange: (v: string) => void; maxDate?: string;
}) {
  const now  = new Date();
  const maxY = maxDate ? parseInt(maxDate.split('-')[0]) : now.getFullYear();
  const minY = 1990;

  // Independent state per field — so each dropdown works regardless of order picked
  const parts = value ? value.split('-') : ['','',''];
  const [yr, setYr] = React.useState(parts[0]||'');
  const [mo, setMo] = React.useState(parts[1]||'');
  const [dy, setDy] = React.useState(parts[2]||'');

  // Sync when parent value changes (e.g. on load)
  React.useEffect(() => {
    const p = value ? value.split('-') : ['','',''];
    setYr(p[0]||''); setMo(p[1]||''); setDy(p[2]||'');
  }, [value]);

  const years  = Array.from({length: maxY - minY + 1}, (_, i) => String(maxY - i));
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const daysInMonth = (y: string, m: string) =>
    (!y || !m) ? 31 : new Date(parseInt(y), parseInt(m), 0).getDate();

  const days = Array.from(
    {length: daysInMonth(yr, mo)},
    (_, i) => String(i+1).padStart(2, '0')
  );

  // Emit full date only when all 3 fields are selected
  const emit = (y: string, m: string, d: string) => {
    if (y && m && d) {
      const maxD    = daysInMonth(y, m);
      const clampD  = String(Math.min(parseInt(d), maxD)).padStart(2, '0');
      onChange(`${y}-${m}-${clampD}`);
    } else {
      onChange('');
    }
  };

  const handleDy = (v: string) => { setDy(v); emit(yr, mo, v); };
  const handleMo = (v: string) => {
    setMo(v);
    const clampD = dy && v && yr
      ? String(Math.min(parseInt(dy), daysInMonth(yr, v))).padStart(2, '0')
      : dy;
    setDy(clampD);
    emit(yr, v, clampD);
  };
  const handleYr = (v: string) => { setYr(v); emit(v, mo, dy); };

  const sel: React.CSSProperties = {
    padding: '10px 6px', borderRadius: 8, border: `1px solid ${C.border}`,
    fontSize: 14, backgroundColor: '#fff', flex: 1, cursor: 'pointer',
    WebkitAppearance: 'menulist',
  };

  return (
    <div style={{display: 'flex', gap: 8}}>
      <select value={dy} onChange={e => handleDy(e.target.value)} style={sel}>
        <option value="">Day</option>
        {days.map(d => <option key={d} value={d}>{parseInt(d)}</option>)}
      </select>
      <select value={mo} onChange={e => handleMo(e.target.value)} style={{...sel, flex: 1.5}}>
        <option value="">Month</option>
        {months.map((m, i) => <option key={m} value={m}>{mNames[i]}</option>)}
      </select>
      <select value={yr} onChange={e => handleYr(e.target.value)} style={{...sel, flex: 1.5}}>
        <option value="">Year</option>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

// ── Phone field ───────────────────────────────────────────────────────────────
function PhoneField({ label, isd, num, onIsd, onNum, required }: {
  label:string; isd:string; num:string;
  onIsd:(v:string)=>void; onNum:(v:string)=>void; required?:boolean;
}) {
  const hasNum = num.trim().length > 0;
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
        {label}{required && <span style={{color:C.red}}> *</span>}
      </div>
      <div style={{display:'flex',gap:0}}>
        {/* ISD only shown when number is entered */}
        {hasNum && (
          <select value={isd} onChange={e=>onIsd(e.target.value)} style={{
            padding:'8px 6px', borderRadius:'9px 0 0 9px',
            border:`1px solid ${C.border}`, borderRight:'none',
            fontSize:13, fontWeight:700, backgroundColor:'#f8f9fa', width:80,
            flexShrink:0,
          }}>
            {ISDS.map(c => <option key={c} value={c}>{ISD_FLAGS[c]} {c}</option>)}
          </select>
        )}
        <input
          type="tel"
          value={num}
          onChange={e => {
            const digits = e.target.value.replace(/\D/g, '');
            onNum(digits);
          }}
          placeholder="Phone number (optional)"
          style={{
            ...INP,
            borderRadius: hasNum ? '0 10px 10px 0' : 10,
            flex:1,
          }}
        />
      </div>
      {hasNum && (isd === '+91' && num.length !== 10
        ? <div style={{fontSize:10.5,color:'#b45309',fontWeight:700,marginTop:3}}>
            ⚠ Indian mobile numbers have 10 digits — this one has {num.length}
          </div>
        : <div style={{fontSize:10,color:C.muted,marginTop:3}}>
            {ISD_FLAGS[isd]} {isd} — digits only, no spaces
          </div>)}
    </div>
  );
}

// ── Select field ──────────────────────────────────────────────────────────────
function SelField({ label, value, onChange, options, placeholder, required }: {
  label:string; value:string; onChange:(v:string)=>void;
  options:string[]; placeholder?:string; required?:boolean;
}) {
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
        {label}{required && <span style={{color:C.red}}> *</span>}
      </div>
      <select value={value} onChange={e=>onChange(e.target.value)} style={INP}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ── Section card (collapsible) ────────────────────────────────────────────────
function Section({ title, icon, children, defaultOpen=true }: {
  title:string; icon:string; children:React.ReactNode; defaultOpen?:boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{backgroundColor:'#fff', borderRadius:14, marginBottom:10,
      overflow:'hidden', boxShadow:'0 1px 6px rgba(0,0,0,0.07)'}}>
      <button onClick={()=>setOpen(v=>!v)} style={{
        width:'100%', display:'flex', justifyContent:'space-between', alignItems:'center',
        padding:'10px 14px', border:'none', background:'none', cursor:'pointer',
        borderBottom: open ? `1px solid ${C.border}` : 'none',
      }}>
        <span style={{fontWeight:800, fontSize:13, color:C.navy}}>{icon} {title}</span>
        <span style={{color:C.muted, fontSize:14}}>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div style={{padding:'10px 12px'}}>{children}</div>}
    </div>
  );
}

// ── Toast notification (prominent, full-width) ────────────────────────────────
function Toast({ msg, onDone }: { msg:{text:string; type:'success'|'error'|'info'}|null; onDone:()=>void }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onDone, msg.type === 'success' ? 3000 : 5000);
    return () => clearTimeout(t);
  }, [msg]);

  if (!msg) return null;
  const bg = msg.type === 'success' ? '#166534' : msg.type === 'error' ? '#991b1b' : '#1e40af';
  return (
    <div style={{
      position:'fixed', bottom:20, left:16, right:16, zIndex:9999,
      backgroundColor:bg, color:'#fff', borderRadius:14,
      padding:'14px 18px', fontSize:14, fontWeight:700,
      boxShadow:'0 8px 30px rgba(0,0,0,0.3)',
      display:'flex', alignItems:'center', justifyContent:'space-between',
      animation:'slideUp 0.3s ease',
    }}>
      <span style={{flex:1}}>{msg.text}</span>
      <button onClick={onDone} style={{background:'none',border:'none',color:'rgba(255,255,255,0.7)',
        fontSize:20,cursor:'pointer',padding:'0 0 0 12px'}}>✕</button>
    </div>
  );
}

// ── Saving overlay ────────────────────────────────────────────────────────────
function SavingOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div style={{
      position:'fixed', inset:0, backgroundColor:'rgba(0,31,63,0.6)',
      zIndex:9000, display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', gap:16,
    }}>
      <div style={{
        width:64, height:64, border:'6px solid rgba(255,255,255,0.3)',
        borderTop:'6px solid #c5a059', borderRadius:'50%',
        animation:'spin 0.8s linear infinite',
      }}/>
      <div style={{color:'#fff', fontWeight:800, fontSize:16}}>Saving profile…</div>
      <div style={{color:'rgba(255,255,255,0.6)', fontSize:12}}>Please wait</div>
    </div>
  );
}

// ── Change indicator dot ──────────────────────────────────────────────────────
function ChangeDot({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return <span style={{display:'inline-block', width:7, height:7, borderRadius:'50%',
    backgroundColor:C.gold, marginLeft:6, verticalAlign:'middle'}}/>;
}

// ── Fetch with hard timeout — module level so available everywhere ─────────
async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ══════════════════════════════════════════════════════════════════════════════

export default function EditProfileScreen() {
  const { studentId } = useParams<{ studentId: string }>();
  const navigate      = useNavigate();
  const base          = buildBase(localStorage.getItem('server_ip') || '');
  const H             = hdrs();

  const { can, roleLabel } = usePermissions();
  const linkedIds = getLinkedStudentIds();
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<{text:string;type:'success'|'error'|'info'}|null>(null);
  const [student,  setStudent]  = useState<any>(null);
  const [zoomPhoto,   setZoomPhoto]   = useState(false);
  const [photoAction, setPhotoAction] = useState<null|'uploading'|'deleting'>(null);
  const [photoPreview,setPhotoPreview]= useState<string|null>(null);  // local preview before upload

  const showToast = (text: string, type: 'success'|'error'|'info' = 'info') => setToast({text, type});

  // ── Photo upload via file input ──────────────────────────────────────────────
  const webFileInputRef = useRef<HTMLInputElement>(null);
  const handleWebFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/jpeg','image/jpg','image/png'].includes(file.type)) {
      showToast('⚠ Only JPEG or PNG photos allowed', 'error'); return;
    }
    if (file.size > 1024 * 1024) {
      showToast(`⚠ Too large (${Math.round(file.size/1024)}KB). Max 1MB.`, 'error'); return;
    }
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoAction('uploading');
    try {
      const fd   = new FormData();
      fd.append('file', file);
      const res = await fetchWithTimeout(
        `${base}/api/data/students/${studentId}/photo`,
        { method:'POST', headers:(() => {
        const h = hdrs();
        delete (h as any)['Content-Type']; // Let browser set multipart boundary
        return h;
      })(), body:fd },
        15000
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      // Same filename is reused ("<id>.jpg"), so drop both old and new from the
      // photo cache — otherwise the previous picture keeps showing
      await invalidateStudentImage(student?.profile_image ?? null);
      await invalidateStudentImage(j.filename);
      setStudent((prev: any) => ({...prev, profile_image: j.filename}));
      await updateLocalStudent(parseInt(studentId!), { profile_image: j.filename });
      showToast(`✔ Photo updated (${j.size_kb}KB)`, 'success');
    } catch (err: any) {
      setPhotoPreview(null);
      showToast(`⚠ ${err?.message}`, 'error');
    }
    setPhotoAction(null);
  };

  const handlePhotoSelect = () => {
    if (!can('student:photo:upload')) { showToast('🔒 Permission denied: student:photo:upload', 'error'); return; }
    webFileInputRef.current?.click();
  };

  const handlePhotoDelete = async () => {
    if (!can('student:photo:delete')) { showToast('🔒 Permission denied: student:photo:delete', 'error'); return; }
    if (!student?.profile_image) return;
    if (!window.confirm('Remove profile photo?')) return;
    setPhotoAction('deleting');
    try {
      const { key, user, pass } = {
        key:  localStorage.getItem('secret_key') || '',
        user: localStorage.getItem('auth_user')  || '',
        pass: localStorage.getItem('auth_pass')  || '',
      };
      const res = await fetchWithTimeout(
        `${base}/api/data/students/${studentId}/photo`,
        { method:'DELETE', headers:(()=>{const _j=localStorage.getItem('jwt_token'),_e=parseInt(localStorage.getItem('jwt_expiry')||'0');if(_j&&Date.now()<_e-60000)return{'Content-Type':'application/json','Authorization':'Bearer '+_j,'X-Username':localStorage.getItem('auth_user')||''};return{'Content-Type':'application/json','X-Username':localStorage.getItem('auth_user')||'','X-Password':localStorage.getItem('auth_pass')||''};})() },
        8000
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setStudent((prev: any) => ({...prev, profile_image: null}));
      setPhotoPreview(null);
      // Bust image cache
      await invalidateStudentImage(student?.profile_image ?? null);
      await updateLocalStudent(parseInt(studentId!), { profile_image: null });
      showToast('✔ Photo removed', 'success');
    } catch (err: any) {
      showToast(`⚠ ${err.message}`, 'error');
    }
    setPhotoAction(null);
  };

  // ── Form state (one object for easy dirty-check) ─────────────────────────
  const initForm = () => ({
    gender:'', dob:'', bloodGroup:'',
    school:'', grade:'', medical:'',
    email:'', stuPhoneIsd:'+91', stuPhoneNum:'',
    phoneIsd:'+91', phoneNum:'',
    parentName:'', parentIsd:'+91', parentNum:'', parentEmail:'',
    emgName:'', emgIsd:'+91', emgNum:'',
    level:'Beginner', stuType:'Academy', domSide:'', kitSize:'', isNightSession:false,
    referral:'', category:'REGULAR', status:'Active',
    fee:'', coachId:'', enrollDate:'', regno:'', address:'', qcaId:'',
  });

  const [form,    setForm]    = useState(initForm());
  const [origForm, setOrigForm] = useState(initForm());
  const isDirty = !deepEqual(form, origForm);

  const setF = (key: keyof typeof form) => (v: string) =>
    setForm(prev => ({...prev, [key]: v}));

  // ── Load ──────────────────────────────────────────────────────────────────
  // fetchWithTimeout defined at module level below

  const [connError, setConnError] = useState<string|null>(null);

  useEffect(() => {
    if (!base || base === 'http://') {
      setConnError('No server configured. Go to Settings and set your server address.');
      setLoading(false);
      return;
    }

    let cancelled = false;  // prevent state update after unmount

    (async () => {
      // ── Step 1: Ping first (3s timeout) ─────────────────────────────────
      try {
        await fetchWithTimeout(`${base}/api/data/ping`, { headers: H }, 3000);
      } catch (pingErr: any) {
        if (cancelled) return;
        const isTimeout = pingErr?.name === 'AbortError';
        setConnError(
          isTimeout
            ? 'Server not responding (timeout). Check your connection in Settings.'
            : `Cannot reach server: ${pingErr?.message || 'Network error'}. Go to Settings to fix.`
        );
        setLoading(false);
        return;
      }

      // ── Step 2: Load profile (8s timeout) ───────────────────────────────
      try {
        const res = await fetchWithTimeout(
          `${base}/api/data/students/${studentId}/profile`,
          { headers: H },
          8000
        );
        if (cancelled) return;

        const j = await res.json();
        if (!res.ok) {
          setConnError(`Server error: ${j.error || 'HTTP ' + res.status}`);
          setLoading(false);
          return;
        }

        const d = j.data;
        setStudent(d);

        const [pi, pn] = splitPhone(d.phone || '');
        const [ri, rn] = splitPhone(d.parent_phone || '');
        const [ei, en] = splitPhone(d.emergency_contact_phone || '');

        const loaded = {
          gender:      d.gender || '',
          regno:       d.regno || '',
          address:     d.address || '',
          qcaId:       d.qca_id ? String(d.qca_id) : '',
          dob:         d.date_of_birth || '',
          bloodGroup:  d.blood_group || '',
          school:      d.school_name || '',
          grade:       d.current_grade || '',
          medical:     d.medical_conditions || '',
          email:    d.email || '',
          phoneIsd: pi, phoneNum: pn,
          parentName:  d.parent_name || '',
          parentIsd:ri, parentNum:rn,
          parentEmail: d.parent_email || '',
          emgName:     d.emergency_contact_name || '',
          emgIsd:ei,   emgNum:en,
          level:       d.level || 'Beginner',
          stuType:     d.student_type || 'Academy',
          domSide:     d.dominant_side || '',
          kitSize:     d.kit_size || '',
          isNightSession: !!d.is_night_session,
          referral:    d.referral_source || '',
          category:    d.student_category || 'REGULAR',
          status:      d.status || 'Active',
          fee:         d.monthly_fee != null ? String(d.monthly_fee) : '',
          coachId:     d.coach_id ? String(d.coach_id) : '',
          enrollDate:  d.enrollment_date || '',
        };
        if (!cancelled) {
          setForm(loaded);
          setOrigForm(loaded);
          setConnError(null);
        }
      } catch (e: any) {
        if (cancelled) return;
        const isTimeout = e?.name === 'AbortError';
        setConnError(
          isTimeout
            ? 'Profile load timed out. Server may be busy — tap Retry.'
            : `Load failed: ${e?.message}`
        );
      }
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };  // cleanup on unmount
  }, [studentId, base]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    // Check permission — student:edit:any for any, student:edit:own for own profile only
    const editingOwnProfile = linkedIds.includes(Number(studentId));
    const canEditThis = can('student:edit:any') || (can('student:edit:own') && editingOwnProfile) || can('student:edit');
    if (!canEditThis) { showToast('🔒 Permission denied: student:edit', 'error'); return; }
    if (!isDirty) { showToast('No changes to save', 'info'); return; }

    // ── Client-side validation ─────────────────────────────────────────────
    const valErrors: string[] = [];

    // Mandatory fields
    if (!form.dob)        valErrors.push('Date of Birth is required');
    if (!form.enrollDate) valErrors.push('Enrollment Date is required');
    if (!form.stuType)    valErrors.push('Admission Type is required');
    if (!form.category)   valErrors.push('Student Category is required');
    if (!form.status)     valErrors.push('Account Status is required');

    // Phone format — only if entered (not mandatory)
    const phoneRe = /^[0-9]{7,15}$/;
    if (form.phoneNum    && !phoneRe.test(form.phoneNum))
      valErrors.push('Primary phone: digits only, 7–15 numbers');
    if (form.parentNum   && !phoneRe.test(form.parentNum))
      valErrors.push('Parent phone: digits only, 7–15 numbers');
    if (form.emgNum      && !phoneRe.test(form.emgNum))
      valErrors.push('Emergency phone: digits only, 7–15 numbers');

    // Email format — only if entered (not mandatory)
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (form.email && !emailRe.test(form.email))
      valErrors.push('Student email: invalid email format');
    if (form.parentEmail && !emailRe.test(form.parentEmail))
      valErrors.push('Parent email: invalid email format');

    if (valErrors.length > 0) {
      showToast('⚠ ' + valErrors.join(' | '), 'error');
      return;
    }

    setSaving(true);
    try {
      const payload: any = {
        gender:             form.gender     || undefined,
        regno:              form.regno      || undefined,
        address:            form.address    || undefined,
        qca_id:             form.qcaId ? parseInt(form.qcaId) : undefined,
        date_of_birth:      form.dob        || undefined,
        blood_group:        form.bloodGroup || undefined,
        school_name:        form.school     || undefined,
        current_grade:      form.grade      || undefined,
        medical_conditions: form.medical    || undefined,
        is_night_session:   form.isNightSession ? 1 : 0,
        email:              form.email || null,
        // Phone: send ISD+number when present; send null to clear
        ...(form.phoneNum
          ? { phone_isd: form.phoneIsd, phone_number: form.phoneNum }
          : { phone: null }),
        parent_name:        form.parentName || null,
        ...(form.parentNum
          ? { parent_phone_isd: form.parentIsd, parent_phone_number: form.parentNum }
          : { parent_phone: null }),
        parent_email:       form.parentEmail || null,
        emergency_contact_name: form.emgName || null,
        ...(form.emgNum
          ? { emergency_isd: form.emgIsd, emergency_phone_number: form.emgNum }
          : { emergency_contact_phone: null }),
        enrollment_date: form.enrollDate || undefined,
        level:          form.level,
        student_type:   form.stuType,
        dominant_side:  form.domSide   || undefined,
        kit_size:       form.kitSize   || undefined,
        referral_source:form.referral  || undefined,
        student_category: form.category,
        status:           form.status,
        // monthly_fee: read-only — not sent to server
        coach_id:         form.coachId ? parseInt(form.coachId) : undefined,
      };

      // Remove undefined only — keep null (null = clear the field on server)
      Object.keys(payload).forEach(k => { if (payload[k] === undefined) delete payload[k]; });

      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${base}/api/data/students/${studentId}/profile`,
          { method: 'PUT', headers: H, body: JSON.stringify(payload) },
          10000
        );
      } catch (fetchErr: any) {
        const isTimeout = fetchErr?.name === 'AbortError';
        showToast(isTimeout ? '⚠ Save timed out — check connection and retry' : `⚠ ${fetchErr?.message}`, 'error');
        setSaving(false);
        return;
      }
      let j: any = {};
      try {
        j = await res.json();
      } catch {
        // Server returned non-JSON (e.g. HTML error page, 502, 504)
        showToast(`⚠ Server error (${res.status}) — check connection`, 'error');
        setSaving(false);
        return;
      }

      if (!res.ok) {
        // j.error = our custom format | j.detail = FastAPI HTTPException format
        const errMsg = j.error || j.detail || j.message || `Save failed (${res.status})`;
        const details = j.details ? '\n' + j.details.join('\n') : '';
        showToast(`⚠ ${errMsg}${details}`, 'error');
      } else {
        // ── Sync to local SQLite ───────────────────────────────────────────
        try {
          // Calculate age from DOB for local DB
          const dobAge = form.dob ? (() => {
            const b = new Date(form.dob), t = new Date();
            let a = t.getFullYear() - b.getFullYear();
            if (t.getMonth() < b.getMonth() || (t.getMonth()===b.getMonth()&&t.getDate()<b.getDate())) a--;
            return a >= 0 ? a : 0;
          })() : null;

          await updateLocalStudent(parseInt(studentId!), {
            gender:                   form.gender,
            regno:                    form.regno || null,
            address:                  form.address || null,
            qca_id:                   form.qcaId ? parseInt(form.qcaId) : null,
            date_of_birth:            form.dob,
            age:                      dobAge,
            blood_group:              form.bloodGroup,
            school_name:              form.school,
            current_grade:            form.grade,
            medical_conditions:       form.medical,
            email:                    form.email,
            phone:                    form.phoneNum ? `${form.phoneIsd}${form.phoneNum}` : '',
            parent_name:              form.parentName,
            parent_phone:             form.parentNum ? `${form.parentIsd}${form.parentNum}` : '',
            parent_email:             form.parentEmail,
            emergency_contact_name:   form.emgName,
            emergency_contact_phone:  form.emgNum ? `${form.emgIsd}${form.emgNum}` : '',
            enrollment_date:          form.enrollDate,
            level:                    form.level,
            student_type:             form.stuType,
            dominant_side:            form.domSide,
            kit_size:                 form.kitSize,
            referral_source:          form.referral,
            student_category:         form.category,
            status:                   form.status,
            // monthly_fee not updated locally — admin-only field
          });
        } catch (dbErr) {
          console.warn('Local DB sync failed — server saved OK', dbErr);
        }

        // ── Mark form clean ────────────────────────────────────────────────
        setOrigForm({...form});
        showToast(`✔ Profile saved — ${j.updated?.length || 0} field(s) updated`, 'success');
      }
    } catch (e: any) {
      showToast(`⚠ ${e.message}`, 'error');
    }
    setSaving(false);
  }, [form, isDirty, studentId, base]);

  // ── Render ────────────────────────────────────────────────────────────────
  // Connection error screen
  if (!loading && connError) return (
    <div style={{minHeight:'100vh', backgroundColor:C.bg, fontFamily:'sans-serif'}}>
      <ScreenHeader title="Edit Profile" background={C.navy} />
      <div style={{padding:24}}>
        <div style={{backgroundColor:'#fff', borderRadius:16, padding:24, boxShadow:'0 2px 12px rgba(0,0,0,0.08)', textAlign:'center'}}>
          <div style={{fontSize:56, marginBottom:16}}>📡</div>
          <div style={{fontWeight:900, fontSize:17, color:C.navy, marginBottom:10}}>No Connection</div>
          <div style={{fontSize:14, color:C.gray, lineHeight:1.6, marginBottom:24}}>{connError}</div>
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            <button onClick={()=>{ setLoading(true); setConnError(null); }}
              style={{padding:'13px', borderRadius:12, border:'none', backgroundColor:C.navy,
                color:'#fff', fontWeight:800, fontSize:14, cursor:'pointer'}}>
              🔄 Retry
            </button>
            <button onClick={()=>navigate('/settings')}
              style={{padding:'13px', borderRadius:12, border:`1px solid ${C.border}`,
                backgroundColor:'#fff', color:C.gray, fontWeight:700, fontSize:14, cursor:'pointer'}}>
              ⚙️ Go to Settings
            </button>
            <button onClick={()=>navigate(-1)}
              style={{padding:'13px', borderRadius:12, border:`1px solid ${C.border}`,
                backgroundColor:'#fff', color:C.gray, fontWeight:700, fontSize:14, cursor:'pointer'}}>
              ← Go Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',
      fontFamily:'sans-serif', backgroundColor:C.bg}}>
      <div style={{textAlign:'center',color:C.muted}}>
        <div style={{fontSize:40,marginBottom:12,animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</div>
        <div style={{fontWeight:700, marginTop:12}}>Connecting to server…</div>
        <div style={{fontSize:12,color:C.muted,marginTop:6}}>Pinging server, please wait</div>
      </div>
    </div>
  );

  if (!student) return (
    <div style={{padding:24,fontFamily:'sans-serif'}}>
      <button onClick={()=>navigate(-1)} style={{marginBottom:12,background:'none',border:'none',cursor:'pointer',color:C.blue,fontSize:16}}>← Back</button>
      <div style={{color:C.red,fontWeight:700}}>Student not found</div>
    </div>
  );

  const changed = (key: keyof typeof form) =>
    (form as any)[key] !== (origForm as any)[key];

  return (
    <div style={{backgroundColor:C.bg, minHeight:'100vh', fontFamily:'sans-serif', paddingBottom:120}}>
      {/* CSS animations */}
      <style>{`
        @keyframes slideUp { from { transform:translateY(60px); opacity:0; } to { transform:translateY(0); opacity:1; } }
        @keyframes spin { to { transform:rotate(360deg); } }
      `}</style>

      {/* Header */}
      <ScreenHeader title="✏️ Edit Profile" background={C.navy}
        actions={<div style={{fontSize:10,color:'rgba(255,255,255,0.45)',textAlign:'right',marginRight:10,lineHeight:1.3}}>ID & Name<br/>read-only</div>} />
      <div style={{backgroundColor:C.navy, padding:'4px 16px 16px'}}>
        {/* Profile photo + identity card */}
        <div style={{display:'flex', alignItems:'center', gap:14, padding:'12px 14px',
          backgroundColor:'rgba(255,255,255,0.07)', borderRadius:14}}>
          {/* Photo circle — label wraps input for reliable Android tap */}
          <div style={{position:'relative', flexShrink:0}}>
            <div onClick={()=>{ if(student.profile_image||photoPreview) setZoomPhoto(true); }}
              style={{cursor:(student.profile_image||photoPreview)?'zoom-in':'default', position:'relative'}}>
              <StudentPhoto
                student={photoPreview ? {...student, profile_image: photoPreview} : student}
                size={60}
                style={{border:'3px solid rgba(197,160,89,0.6)', opacity: photoAction ? 0.5 : 1}}/>
              {photoAction && (
                <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',
                  justifyContent:'center',borderRadius:'50%',backgroundColor:'rgba(0,0,0,0.4)'}}>
                  <span style={{fontSize:16}}>{photoAction==='uploading'?'⬆':'🗑'}</span>
                </div>
              )}
            </div>
            {/* Camera badge — tap to pick photo */}
            <div
              onClick={handlePhotoSelect}
              style={{position:'absolute', bottom:0, right:0, backgroundColor:C.gold,
                borderRadius:'50%', width:22, height:22, display:'flex', alignItems:'center',
                justifyContent:'center', fontSize:11, border:'2px solid ' + C.navy,
                cursor: photoAction ? 'not-allowed' : 'pointer',
                boxShadow:'0 2px 6px rgba(0,0,0,0.3)'}}>
              {photoAction==='uploading' ? '⏳' : '📷'}
            </div>
            {/* Hidden file input for web browser fallback */}
            <input ref={webFileInputRef} type="file" accept="image/jpeg,image/jpg,image/png"
              onChange={handleWebFileSelect} style={{display:'none'}}/>
          </div>

          {/* Student info + photo actions */}
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontWeight:900, fontSize:16, color:'#fff', whiteSpace:'nowrap',
              overflow:'hidden', textOverflow:'ellipsis'}}>{student.name}</div>
            <div style={{fontSize:11, color:'rgba(255,255,255,0.7)', marginTop:3}}>
              <span style={{color:C.gold, fontWeight:800}}>
                {[fmtRegNo(student.regno), student.qca_id ? `Q${String(student.qca_id).padStart(3,'0')}` : ''].filter(Boolean).join(' · ') || 'No reg no'}
              </span>
              &nbsp;·&nbsp; {student.status || 'Active'}
            </div>
            {student.level && (
              <div style={{marginTop:5, display:'inline-block', fontSize:10, fontWeight:700,
                backgroundColor:C.gold+'33', color:C.gold, borderRadius:6, padding:'2px 8px'}}>
                {student.level}
              </div>
            )}
            {/* Photo action buttons — also use label for Change button */}
            <div style={{display:'flex', gap:6, marginTop:7}}>
              {!photoAction ? (
                <button
                  onClick={handlePhotoSelect}
                  style={{padding:'3px 10px', borderRadius:7, border:'none', cursor:'pointer',
                    backgroundColor:'rgba(197,160,89,0.25)', color:C.gold,
                    fontWeight:700, fontSize:10}}>
                  {student.profile_image ? '🔄 Change Photo' : '📷 Add Photo'}
                </button>
              ) : (
                <span style={{padding:'3px 10px', borderRadius:7,
                  backgroundColor:'rgba(197,160,89,0.15)', color:'rgba(197,160,89,0.6)',
                  fontWeight:700, fontSize:10}}>
                  {photoAction==='uploading' ? '⬆ Uploading…' : '🗑 Removing…'}
                </span>
              )}
              {student.profile_image && !photoAction && (
                <button onClick={handlePhotoDelete}
                  style={{padding:'3px 10px', borderRadius:7, border:'none', cursor:'pointer',
                    backgroundColor:'rgba(220,38,38,0.2)', color:'#fca5a5',
                    fontWeight:700, fontSize:10}}>
                  🗑 Remove
                </button>
              )}
            </div>
          </div>
          {isDirty && (
            <div style={{backgroundColor:C.gold, color:C.navy, borderRadius:8,
              padding:'4px 8px', fontSize:10, fontWeight:900, flexShrink:0}}>
              UNSAVED
            </div>
          )}
        </div>
      </div>

      <div style={{padding:'14px 16px'}}>

        {/* ── Personal ──────────────────────────────────────────── */}
        {/* Mandatory legend */}
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10,padding:'7px 12px',
          backgroundColor:'#fff7ed',borderRadius:8,fontSize:11,color:'#92400e'}}>
          <span style={{color:C.red,fontWeight:900,fontSize:14}}>*</span>
          <span>Required: Date of Birth, Enrollment Date, Admission Type, Category, Account Status</span>
        </div>

        <Section title="Personal" icon="👤">
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Gender{changed('gender') && <ChangeDot changed/>}
            </div>
            <div style={{display:'flex',gap:8}}>
              {GENDERS.map(g => (
                <button key={g} onClick={()=>setF('gender')(g)}
                  style={{flex:1,padding:'10px',borderRadius:10,border:`2px solid ${form.gender===g?C.navy:C.border}`,
                    backgroundColor:form.gender===g?C.navy:'#fff',
                    color:form.gender===g?'#fff':C.gray, fontWeight:700, fontSize:13, cursor:'pointer'}}>
                  {g === 'Male' ? '♂ Male' : '♀ Female'}
                </button>
              ))}
            </div>
          </div>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Date of Birth <span style={{color:C.red}}>*</span>{changed('dob') && <ChangeDot changed/>}
            </div>
            <SmartDatePicker value={form.dob} onChange={setF('dob')} maxDate={new Date().toISOString().split('T')[0]}/>
            {form.dob && (
              <div style={{marginTop:6,padding:'7px 12px',borderRadius:8,backgroundColor:'#eff6ff',
                display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontSize:18}}>🎂</span>
                <div>
                  <span style={{fontWeight:800,fontSize:15,color:C.blue}}>{calcAge(form.dob)}</span>
                  <span style={{fontSize:12,color:C.muted,marginLeft:6}}>old</span>
                  <div style={{fontSize:11,color:C.muted}}>{form.dob}</div>
                </div>
              </div>
            )}
          </div>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Blood Group{changed('bloodGroup') && <ChangeDot changed/>}
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
              {BLOOD.filter(b=>b).map(b => (
                <button key={b} onClick={()=>setF('bloodGroup')(form.bloodGroup===b?'':b)}
                  style={{padding:'6px 14px',borderRadius:8,border:`2px solid ${form.bloodGroup===b?C.red:C.border}`,
                    backgroundColor:form.bloodGroup===b?C.red+'15':'#fff',
                    color:form.bloodGroup===b?C.red:C.gray, fontWeight:700, fontSize:13, cursor:'pointer'}}>
                  {b}
                </button>
              ))}
            </div>
          </div>

          <div style={{marginBottom:4}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Medical / Notes{changed('medical') && <ChangeDot changed/>}
            </div>
            <textarea value={form.medical} onChange={e=>setF('medical')(e.target.value)}
              rows={3} placeholder="Allergies, injuries, or other medical notes…"
              style={{...INP, resize:'vertical'}}/>
          </div>
        </Section>

        {/* Education */}
        <Section title="Education" icon="🏫">
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              School / College{changed('school') && <ChangeDot changed/>}
            </div>
            <input type="text" value={form.school} onChange={e=>setF('school')(e.target.value)}
              placeholder="School or college name" style={INP}/>
          </div>

          <div style={{marginBottom:4}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Grade / Year{changed('grade') && <ChangeDot changed/>}
            </div>
            <select value={form.grade} onChange={e=>setF('grade')(e.target.value)} style={INP}>
              <option value="">-- Select Grade --</option>
              <option value="KG">KG (Kindergarten)</option>
              {['1','2','3','4','5','6','7','8','9','10','11','12'].map(g=>(
                <option key={g} value={g}>Grade {g}</option>
              ))}
              <option value="Graduate">Graduate / College</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </Section>

        {/* ── Contact ───────────────────────────────────────────── */}
        <Section title="Contact" icon="📞">
          {/* Student's own phone */}
          <PhoneField
            label={`Student Phone (optional)${changed('phoneNum')||changed('phoneIsd')?' •':''}`}
            isd={form.phoneIsd} num={form.phoneNum}
            onIsd={setF('phoneIsd')} onNum={setF('phoneNum')}/>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Student Email (optional){changed('email') && <ChangeDot changed/>}
            </div>
            <input type="email" value={form.email} onChange={e=>setF('email')(e.target.value)}
              placeholder="student@email.com" style={INP}/>
          </div>

          <div style={{height:1, backgroundColor:C.border, margin:'4px 0 16px'}}/>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Parent / Guardian Name{changed('parentName') && <ChangeDot changed/>}
            </div>
            <input type="text" value={form.parentName} onChange={e=>setF('parentName')(e.target.value)}
              placeholder="Full name" style={INP}/>
          </div>

          <PhoneField label={`Parent Phone${changed('parentNum')||changed('parentIsd')?' •':''}`}
            isd={form.parentIsd} num={form.parentNum} onIsd={setF('parentIsd')} onNum={setF('parentNum')}/>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Parent Email (optional){changed('parentEmail') && <ChangeDot changed/>}
            </div>
            <input type="email" value={form.parentEmail} onChange={e=>setF('parentEmail')(e.target.value)}
              placeholder="parent@email.com" style={INP}/>
          </div>

          {/* Address in Contact */}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Address{changed('address') && <ChangeDot changed/>}
              {' '}<span style={{fontSize:10,color:'#6b7280',fontWeight:600}}>(Admin only)</span>
            </div>
            {(localStorage.getItem('user_role')||'').toLowerCase() === 'admin' ? (
              <textarea value={form.address} onChange={e=>setF('address')(e.target.value)}
                rows={3} placeholder="Full address..."
                style={{...INP, resize:'vertical'}}/>
            ) : (
              <div style={{...INP, backgroundColor:'#f3f4f6', color:'#6b7280', minHeight:72,
                display:'flex', alignItems:'flex-start', gap:6}}>
                <span style={{fontWeight:700, flex:1}}>{form.address || '—'}</span>
                <span style={{fontSize:11, flexShrink:0}}>Admin only</span>
              </div>
            )}
          </div>

          <div style={{height:1, backgroundColor:C.border, margin:'8px 0 16px'}}/>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.red,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Emergency Contact Name{changed('emgName') && <ChangeDot changed/>}
            </div>
            <input type="text" value={form.emgName} onChange={e=>setF('emgName')(e.target.value)}
              placeholder="Emergency contact full name" style={INP}/>
          </div>

          <PhoneField label={`Emergency Phone${changed('emgNum')||changed('emgIsd')?' •':''}`}
            isd={form.emgIsd} num={form.emgNum} onIsd={setF('emgIsd')} onNum={setF('emgNum')}/>
        </Section>

        {/* ── Academy ───────────────────────────────────────────── */}
        <Section title="Academy" icon="🏏">
          {/* Enrollment Date — mandatory */}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Enrollment Date <span style={{color:C.red}}>*</span>{changed('enrollDate') && <ChangeDot changed/>}
            </div>
            <SmartDatePicker
              value={form.enrollDate}
              onChange={setF('enrollDate')}
              maxDate={new Date().toISOString().split('T')[0]}
            />
            {form.enrollDate && (
              <div style={{marginTop:5,fontSize:11,color:C.muted}}>
                📅 Enrolled: {new Date(form.enrollDate + 'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'})}
              </div>
            )}
            {!form.enrollDate && (
              <div style={{marginTop:5,fontSize:11,color:C.red}}>⚠ Enrollment date is required</div>
            )}
          </div>

          {/* QCA ID -- Admin editable */}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              QCA ID (Number){changed('qcaId') && <ChangeDot changed/>}
              {' '}<span style={{fontSize:10,color:'#6b7280',fontWeight:600}}>(Admin only)</span>
            </div>
            {(localStorage.getItem('user_role')||'').toLowerCase() === 'admin' ? (
              <input type="number" value={form.qcaId} onChange={e=>setF('qcaId')(e.target.value)}
                placeholder="e.g. 30" style={INP}/>
            ) : (
              <div style={{...INP, backgroundColor:'#f3f4f6', color:'#6b7280', display:'flex', alignItems:'center', gap:6}}>
                <span style={{fontWeight:700}}>{form.qcaId || '—'}</span>
                <span style={{fontSize:11, marginLeft:'auto'}}>Admin only</span>
              </div>
            )}
          </div>

          {/* Registration No -- Admin editable */}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Registration No{changed('regno') && <ChangeDot changed/>}
              {' '}<span style={{fontSize:10,color:'#6b7280',fontWeight:600}}>(Admin only)</span>
            </div>
            {(localStorage.getItem('user_role')||'').toLowerCase() === 'admin' ? (
              <input value={form.regno} onChange={e=>setF('regno')(e.target.value)}
                placeholder="e.g. QCA-2025-001"
                style={INP}/>
            ) : (
              <div style={{...INP, backgroundColor:'#f3f4f6', color:'#6b7280', display:'flex', alignItems:'center', gap:6}}>
                <span style={{fontWeight:700}}>{form.regno || '—'}</span>
                <span style={{fontSize:11, marginLeft:'auto'}}>Admin only</span>
              </div>
            )}
          </div>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Specialization{changed('domSide') && <ChangeDot changed/>}
            </div>
            <select value={form.domSide} onChange={e=>setF('domSide')(e.target.value)} style={INP}>
              <option value="">-- Select Player Role --</option>
              {DOM_SIDE_GROUPS.map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map(o => <option key={o} value={o}>{o}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
                Level{changed('level') && <ChangeDot changed/>}
              </div>
              <select value={form.level} onChange={e=>setF('level')(e.target.value)} style={INP}>
                {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
                Uniform Size{changed('kitSize') && <ChangeDot changed/>}
              </div>
              <select value={form.kitSize} onChange={e=>setF('kitSize')(e.target.value)} style={INP}>
                {KIT_SIZES.map(s => <option key={s} value={s}>{s||'-- Select --'}</option>)}
              </select>
            </div>
          </div>

          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
                Admission Type <span style={{color:C.red}}>*</span>{changed('stuType') && <ChangeDot changed/>}
              </div>
              <select value={form.stuType} onChange={e=>setF('stuType')(e.target.value)} style={INP}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {/* Night Session Toggle */}
            <div style={{gridColumn:'1/-1'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',
                padding:'12px 14px',backgroundColor:'#f0fdf4',borderRadius:10,border:'1px solid #86efac'}}>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:'#166534'}}>🌙 Night Session</div>
                  <div style={{fontSize:11,color:'#6b7280',marginTop:2}}>Student attends night training sessions</div>
                </div>
                <button onClick={()=>setF('isNightSession')(!form.isNightSession)}
                  style={{position:'relative',width:48,height:26,borderRadius:13,border:'none',
                    cursor:'pointer',backgroundColor:form.isNightSession?'#166534':'#d1d5db',
                    transition:'background-color 0.2s',flexShrink:0}}>
                  <div style={{position:'absolute',top:3,
                    left:form.isNightSession?24:3,width:20,height:20,
                    borderRadius:'50%',backgroundColor:'#fff',
                    transition:'left 0.2s',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}}/>
                </button>
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
                Category <span style={{color:C.red}}>*</span>{changed('category') && <ChangeDot changed/>}
              </div>
              <select value={form.category} onChange={e=>setF('category')(e.target.value)} style={INP}>
                {CATEGORY.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
                Monthly Fee
              </div>
              <div style={{...INP, backgroundColor:'#f3f4f6', color:C.muted, display:'flex', alignItems:'center', gap:6}}>
                <span style={{fontSize:16}}>💰</span>
                <span style={{fontWeight:700}}>{form.fee || '—'}</span>
                <span style={{fontSize:11, marginLeft:'auto'}}>Admin only</span>
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
                Referral Source{changed('referral') && <ChangeDot changed/>}
              </div>
              <select value={form.referral} onChange={e=>setF('referral')(e.target.value)} style={INP}>
                {REFERRAL.map(r => <option key={r} value={r}>{r||'-- Select --'}</option>)}
              </select>
            </div>
          </div>

          <div style={{marginBottom:4}}>
            <div style={{fontSize:10,fontWeight:800,color:C.gray,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:5}}>
              Account Status <span style={{color:C.red}}>*</span>{changed('status') && <ChangeDot changed/>}
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
              {STATUS.map(s => {
                const active = form.status === s;
                const col = s==='Active'?C.green : s==='Inactive'?C.red : C.navy;
                return (
                  <button key={s} onClick={()=>setF('status')(s)}
                    style={{padding:'6px 14px',borderRadius:8,border:`2px solid ${active?col:C.border}`,
                      backgroundColor:active?col+'15':'#fff',
                      color:active?col:C.gray, fontWeight:700, fontSize:12, cursor:'pointer'}}>
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
        </Section>

        {/* ── Save button ────────────────────────────────────────── */}
        <div style={{position:'sticky', bottom:16}}>
          <button onClick={save} disabled={saving || !isDirty}
            style={{
              width:'100%', padding:'16px', borderRadius:14, border:'none',
              backgroundColor: !isDirty ? '#d1d5db' : C.navy,
              color: !isDirty ? C.muted : '#fff',
              fontWeight:900, fontSize:15, cursor: !isDirty ? 'not-allowed' : 'pointer',
              boxShadow: isDirty ? '0 4px 20px rgba(0,31,63,0.35)' : 'none',
              transition:'all 0.2s',
              display:'flex', alignItems:'center', justifyContent:'center', gap:10,
            }}>
            <span style={{fontSize:20}}>☁</span>
            {!isDirty ? 'No changes' : 'Save Updates'}
            {isDirty && <span style={{fontSize:11,opacity:0.7,fontWeight:600}}>
              ({Object.keys(form).filter(k => (form as any)[k] !== (origForm as any)[k]).length} changed)
            </span>}
          </button>
          {isDirty && (
            <button onClick={()=>{setForm({...origForm}); showToast('Changes discarded', 'info');}}
              style={{width:'100%',marginTop:8,padding:'10px',borderRadius:12,border:`1px solid ${C.border}`,
                backgroundColor:'#fff', color:C.gray, fontWeight:700, fontSize:13, cursor:'pointer'}}>
              Discard Changes
            </button>
          )}
        </div>
      </div>

      {/* Photo zoom modal */}
      {zoomPhoto && (student?.profile_image || photoPreview) && (
        <div onClick={()=>setZoomPhoto(false)}
          style={{position:'fixed',inset:0,backgroundColor:'rgba(0,0,0,0.92)',
            zIndex:9998,display:'flex',flexDirection:'column',
            alignItems:'center',justifyContent:'center',padding:20}}>
          <button onClick={()=>setZoomPhoto(false)}
            style={{position:'absolute',top:16,right:16,background:'none',border:'none',
              color:'#fff',fontSize:28,cursor:'pointer',lineHeight:1}}>✕</button>
          <StudentPhoto
            student={photoPreview ? {...student, profile_image: photoPreview} : student}
            size={Math.min(window.innerWidth - 40, window.innerHeight - 120)}
            style={{borderRadius:16, border:'3px solid rgba(197,160,89,0.5)',
              objectFit:'cover', maxWidth:'100%', maxHeight:'80vh'}}/>
          <div style={{color:'rgba(255,255,255,0.5)',fontSize:12,marginTop:12}}>
            Tap anywhere to close
          </div>
        </div>
      )}

      {/* Saving overlay */}
      <SavingOverlay visible={saving}/>

      {/* Toast */}
      <Toast msg={toast} onDone={()=>setToast(null)}/>
    </div>
  );
}
