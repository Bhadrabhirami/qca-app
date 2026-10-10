/**
 * ScreenHeader — the one header every screen uses.
 *
 * Replaces the per-page green top bars that each hardcoded 44–50px of
 * "status bar" padding. On Android (targetSdk 34, not edge-to-edge) the
 * WebView already starts below the status bar, so that padding was dead
 * space. Here the top padding comes from the real safe-area inset instead:
 * 0 on Android / browser, correct under a notch.
 *
 * The header is sticky inside SimpleLayout's scroll area, so the title,
 * actions and anything passed as `children` (search box, filter chips)
 * stay on screen while the list scrolls.
 *
 * Usage:
 *   <ScreenHeader title="Students" subtitle="76 shown · 145 total"
 *     actions={<HeaderIconButton label="Refresh" onClick={refresh}>↻</HeaderIconButton>}>
 *     <SearchBar … />            // optional rows pinned under the title
 *   </ScreenHeader>
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { confirmLeave } from './backNav';

export const HEADER_GREEN = '#1a472a';

interface ScreenHeaderProps {
  title:     React.ReactNode;
  subtitle?: React.ReactNode;
  /** Back button: true (default) = navigate(-1), false = hidden, or a custom handler */
  back?:     boolean | (() => void);
  /** Element shown in place of the back button (e.g. the logo on Home) */
  leading?:  React.ReactNode;
  /** Right-aligned buttons/chips in the title row */
  actions?:  React.ReactNode;
  /** Extra rows pinned under the title row (search, filters, tabs) */
  children?: React.ReactNode;
  /** Pin to the top of the scroll area (default true) */
  sticky?:   boolean;
  /** Header background (color or gradient) — defaults to academy green */
  background?: string;
}

export default function ScreenHeader({
  title, subtitle, back = true, leading, actions, children, sticky = true,
  background = HEADER_GREEN,
}: ScreenHeaderProps) {
  const navigate = useNavigate();
  // Ask about unsaved changes before leaving (see shared/backNav)
  const onBack = async () => { if (!(await confirmLeave())) return; typeof back === 'function' ? back() : navigate(-1); };

  return (
    <header style={{
      ...(sticky ? { position: 'sticky', top: 0, zIndex: 50 } : {}),
      background,
      paddingTop: 'env(safe-area-inset-top, 0px)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        minHeight: 56, padding: '6px 8px 6px 4px',
      }}>
        {leading ? (
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px 0 8px', flexShrink: 0 }}>{leading}</div>
        ) : back !== false ? (
          <HeaderIconButton label="Back" onClick={onBack}>←</HeaderIconButton>
        ) : <span style={{ width: 12 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{
            color: '#fff', fontWeight: 700, fontSize: 18, lineHeight: 1.2, margin: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{title}</h1>
          {subtitle ? (
            <p style={{
              color: 'rgba(255,255,255,0.72)', fontSize: 12, margin: '1px 0 0',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>{actions}</div>
        ) : null}
      </div>
      {children ? <div style={{ padding: '0 12px 10px' }}>{children}</div> : null}
    </header>
  );
}

/** 44×44 touch target for header icons (back, refresh, etc.) */
export function HeaderIconButton({ label, onClick, disabled, children }: {
  label: string; onClick?: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label} style={{
      width: 44, height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'none', border: 'none', borderRadius: 22, cursor: disabled ? 'default' : 'pointer',
      color: disabled ? 'rgba(255,255,255,0.45)' : '#fff', fontSize: 22, lineHeight: 1,
    }}>{children}</button>
  );
}

/** Search field styled for use inside a ScreenHeader */
export function HeaderSearch({ value, onChange, placeholder, inputRef }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, backgroundColor: '#fff',
      borderRadius: 10, padding: '0 6px 0 12px', height: 40,
    }}>
      <span aria-hidden style={{ color: '#9ca3af', fontSize: 15 }}>🔍</span>
      <input
        ref={inputRef}
        type="text" inputMode="search" enterKeyHint="search" value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', fontSize: 15, background: 'transparent' }}
      />
      {value ? (
        <button onClick={() => { onChange(''); (inputRef as React.RefObject<HTMLInputElement>)?.current?.focus(); }} aria-label="Clear search" style={{
          width: 32, height: 32, border: 'none', background: 'none', color: '#9ca3af', fontSize: 15, cursor: 'pointer',
        }}>✕</button>
      ) : null}
    </div>
  );
}

/** Small pill button for use on the green header background */
export function HeaderPill({ active, onClick, disabled, children, title }: {
  active?: boolean; onClick?: () => void; disabled?: boolean; children: React.ReactNode; title?: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      flexShrink: 0, height: 40, padding: '0 12px', borderRadius: 10, border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
      fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap',
      backgroundColor: active ? '#fff' : 'rgba(255,255,255,0.14)',
      color: active ? HEADER_GREEN : '#fff',
    }}>{children}</button>
  );
}

/** Segmented tab control for use inside a ScreenHeader (scrolls sideways if crowded) */
export function HeaderTabs<T extends string>({ tabs, value, onChange, color = HEADER_GREEN }: {
  tabs: { id: T; label: React.ReactNode }[];
  value: T; onChange: (id: T) => void;
  /** Text color of the selected tab — pass the header's base color */
  color?: string;
}) {
  return (
    <div role="tablist" style={{
      display: 'flex', gap: 4, padding: 3, borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.22)', overflowX: 'auto', scrollbarWidth: 'none',
    }}>
      {tabs.map(t => {
        const on = t.id === value;
        return (
          <button key={t.id} role="tab" aria-selected={on} onClick={() => onChange(t.id)} style={{
            flex: '1 0 auto', height: 32, padding: '0 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontWeight: on ? 800 : 600, fontSize: 12, whiteSpace: 'nowrap',
            backgroundColor: on ? '#fff' : 'transparent',
            color: on ? color : 'rgba(255,255,255,0.85)',
          }}>{t.label}</button>
        );
      })}
    </div>
  );
}
