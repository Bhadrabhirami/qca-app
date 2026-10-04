/**
 * TileGrid — compact launcher card used by Home and More.
 *
 * One white card per section: small uppercase title, then a 4-column grid
 * of icon + short label. The longer description is kept for screen readers
 * and as a tooltip instead of taking a line on screen.
 */
import React from 'react';

export type TileItem = {
  Icon:   React.ComponentType<{ size?: number; stroke?: number }>;
  label:  string;
  sub?:   string;
  path:   string;
  /** Small red counter on the icon (e.g. students with dues) */
  badge?: number;
};

export default function TileGrid({ title, color, items, onSelect }: {
  title:    string;
  /** Icon tint for the whole section */
  color:    string;
  items:    TileItem[];
  onSelect: (item: TileItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section style={{
      backgroundColor: '#fff', borderRadius: 16, padding: '10px 6px 6px',
      marginBottom: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      <h2 style={{
        fontSize: 10, fontWeight: 800, color: '#9ca3af', margin: '0 8px 6px',
        textTransform: 'uppercase', letterSpacing: '1.2px',
      }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)' }}>
        {items.map(item => (
          <button
            key={item.path}
            onClick={() => onSelect(item)}
            aria-label={item.sub ? `${item.label} — ${item.sub}` : item.label}
            title={item.sub}
            style={{
              background: 'none', border: 'none', borderRadius: 12, cursor: 'pointer',
              padding: '8px 2px', minHeight: 76,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{
              position: 'relative', width: 42, height: 42, borderRadius: 12, flexShrink: 0,
              backgroundColor: color + '18', color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <item.Icon size={22} stroke={1.8} />
              {!!item.badge && (
                <span style={{
                  position: 'absolute', top: -5, right: -7,
                  backgroundColor: '#c0392b', color: '#fff', borderRadius: 9,
                  fontSize: 10, fontWeight: 800, padding: '1px 5px', minWidth: 16,
                  textAlign: 'center', lineHeight: '14px',
                }}>{item.badge > 99 ? '99+' : item.badge}</span>
              )}
            </span>
            <span style={{
              fontWeight: 600, fontSize: 11, lineHeight: 1.2, color: '#1f2937',
              textAlign: 'center', overflow: 'hidden', display: '-webkit-box',
              WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
            }}>{item.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
