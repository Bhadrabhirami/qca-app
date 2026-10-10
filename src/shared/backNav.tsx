/**
 * backNav.tsx — Android back button + "unsaved changes" protection for the whole app.
 *
 * Back button (hardware / gesture), first that applies:
 *   1. the Discard-changes dialog is open      → close it (keep editing)
 *   2. a screen registered its own back step     → useBackHandler(fn) returning true
 *   3. a form has unsaved changes                → ask Save / Discard / Keep editing
 *   4. a popup / bottom sheet is open            → close it (its ✕ / Close / Cancel button)
 *   5. otherwise go back one screen; on Home, sign-in or lock screens "press back again to exit"
 *
 * Unsaved changes: a form calls useUnsavedChanges(dirty, { onSave }). The header ← arrow,
 * the bottom bar and the back button all call confirmLeave() before leaving.
 * Full-screen layers that must never be "closed" by back carry data-back-root.
 */
import React, { useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';

// ── back-step handlers (latest registered wins) ─────────────────────────
type BackFn = () => boolean | void;
const backStack: { id: number; fn: BackFn }[] = [];
let nextId = 1;

export function useBackHandler(fn: BackFn, active = true) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = nextId++;
    backStack.push({ id, fn: () => ref.current() });
    return () => { const i = backStack.findIndex(h => h.id === id); if (i >= 0) backStack.splice(i, 1); };
  }, [active]);
}

// ── unsaved-changes guards ──────────────────────────────────────────────
type Guard = { id: number; dirty: () => boolean; onSave?: () => Promise<boolean | void> | boolean | void; message?: string };
const guards: Guard[] = [];

/** Mark this form as having unsaved changes while `dirty` is true. `onSave` adds a Save button
 *  to the prompt (return false if saving failed so the user stays). */
export function useUnsavedChanges(dirty: boolean, opts: { onSave?: Guard['onSave']; message?: string } = {}) {
  const ref = useRef({ dirty, opts }); ref.current = { dirty, opts };
  useEffect(() => {
    const id = nextId++;
    // getters, so the latest onSave / message are used (and Save only shows when the form gave an onSave)
    guards.push({ id, dirty: () => ref.current.dirty,
      get onSave() { return ref.current.opts.onSave; },
      get message() { return ref.current.opts.message; } } as Guard);
    return () => { const i = guards.findIndex(g => g.id === id); if (i >= 0) guards.splice(i, 1); };
  }, []);
}
const activeGuard = () => [...guards].reverse().find(g => g.dirty());
export const hasUnsavedChanges = () => !!activeGuard();

// ── the Save / Discard / Keep editing dialog ────────────────────────────
type Ask = { message: string; canSave: boolean; resolve: (r: 'save' | 'discard' | 'stay') => void };
let showAsk: ((a: Ask | null) => void) | null = null;
let askOpen: Ask | null = null;

/** Resolves true when it's fine to leave: nothing unsaved, saved successfully, or discarded. */
export async function confirmLeave(): Promise<boolean> {
  const g = activeGuard();
  if (!g) return true;
  if (!showAsk) return window.confirm(g.message || 'You have unsaved changes. Discard them?');
  const choice = await new Promise<'save' | 'discard' | 'stay'>(resolve => {
    askOpen = { message: g.message || 'You have unsaved changes.', canSave: !!g.onSave, resolve };
    showAsk!(askOpen);
  });
  askOpen = null; showAsk?.(null);
  if (choice === 'stay') return false;
  if (choice === 'save') {
    try { const ok = await g.onSave!(); return ok !== false; } catch { return false; }
  }
  // discarded: this form no longer counts as dirty for the rest of this leave
  const i = guards.indexOf(g); if (i >= 0) guards.splice(i, 1);
  return true;
}

export function LeaveDialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => { showAsk = setAsk; return () => { showAsk = null; }; }, []);
  if (!ask) return null;
  const btn = (bg: string, fg: string, border?: string): React.CSSProperties => ({ width: '100%', padding: 12, borderRadius: 11,
    border: border ? `1px solid ${border}` : 'none', backgroundColor: bg, color: fg, fontWeight: 800, fontSize: 14.5, cursor: 'pointer' });
  return (
    <div role="dialog" aria-modal="true" aria-label="Unsaved changes" data-back-root
      style={{ position: 'fixed', inset: 0, zIndex: 10000, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 16, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,0.3)', fontFamily: 'sans-serif' }}>
        <div style={{ fontWeight: 900, fontSize: 17, color: '#111827', marginBottom: 6 }}>Unsaved changes</div>
        <div style={{ fontSize: 13.5, color: '#4b5563', lineHeight: 1.45, marginBottom: 16 }}>{ask.message} What would you like to do?</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ask.canSave && <button onClick={() => ask.resolve('save')} style={btn('#1a472a', '#fff')}>Save</button>}
          <button onClick={() => ask.resolve('discard')} style={btn('#fff', '#dc2626', '#fca5a5')}>Discard changes</button>
          <button onClick={() => ask.resolve('stay')} style={btn('#f3f4f6', '#374151')}>Keep editing</button>
        </div>
      </div>
    </div>
  );
}

// ── closing the top popup / bottom sheet ────────────────────────────────
const CLOSE_TEXT = /^(✕|×|x|X|Close|Cancel|✕ Close|✕ Cancel|Done|Back|←)$/;
function closeTopOverlay(): boolean {
  const W = window.innerWidth, H = window.innerHeight;
  const layers = [...document.querySelectorAll<HTMLElement>('body *')].filter(el => {
    if (el.closest('[data-back-root]')) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= W * 0.9 && r.height >= H * 0.5;
  });
  for (const layer of layers.reverse()) {                       // topmost (last in the page) first
    const buttons = [...layer.querySelectorAll<HTMLElement>('button, [role="button"]')];
    const close = buttons.find(b => /close|cancel|dismiss/i.test(b.getAttribute('aria-label') || ''))
      || buttons.find(b => CLOSE_TEXT.test((b.textContent || '').trim()));
    if (close) { close.click(); return true; }
  }
  return false;
}

// ── exit only on a second press ─────────────────────────────────────────
let lastExitTap = 0;
function toast(text: string) {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, { position: 'fixed', left: '50%', bottom: 'calc(90px + env(safe-area-inset-bottom, 0px))', transform: 'translateX(-50%)',
    background: 'rgba(17,24,39,0.92)', color: '#fff', padding: '9px 16px', borderRadius: '20px', fontSize: '13px', fontWeight: '700',
    zIndex: '10001', fontFamily: 'sans-serif', pointerEvents: 'none' } as CSSStyleDeclaration);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}
function exitOnSecondPress() {
  const now = Date.now();
  if (now - lastExitTap < 2000) { CapApp.exitApp(); return; }
  lastExitTap = now;
  toast('Press back again to exit');
}

/** Home / sign-in / lock screens: back doesn't go anywhere, it asks to exit */
function atRoot(): boolean {
  if (document.querySelector('[data-back-exit]')) return true;   // sign-in, lock, boot screens
  const h = window.location.hash.replace(/^#/, '').split('?')[0];
  return h === '' || h === '/';
}

let busy = false;
export async function handleBack() {
  if (busy) return; busy = true;
  try {
    if (askOpen) { askOpen.resolve('stay'); return; }
    for (let i = backStack.length - 1; i >= 0; i--) { if (backStack[i].fn() === true) return; }
    if (!(await confirmLeave())) return;
    if (closeTopOverlay()) return;
    if (atRoot()) { exitOnSecondPress(); return; }
    if (window.history.length > 1) window.history.back();
    else window.location.hash = '#/';
  } finally { busy = false; }
}

/** Call once at app start */
export function installBackButton() {
  const sub = CapApp.addListener('backButton', () => { handleBack(); });
  return () => { sub.then(s => s.remove()).catch(() => {}); };
}
