/**
 * EmptyAreaLogo — fills the leftover space at the bottom of a short screen
 * with the academy crest (and motto when there's room).
 *
 * Place it as the LAST growing child of a flex-column page:
 *   <div style={{ display:'flex', flexDirection:'column', minHeight:'100%' }}>
 *     …content…
 *     <EmptyAreaLogo />
 *   </div>
 * It takes flex:1, measures the height it was given, and shows nothing when
 * the content already fills the screen — so it never adds scrolling.
 */
import React, { useEffect, useRef, useState } from 'react';

const MIN_FOR_LOGO  = 140;   // px of free space before the crest appears
const MIN_FOR_MOTTO = 230;   // px of free space before the motto appears too

export default function EmptyAreaLogo({ opacity = 0.22, mottoColor = '#1a472a' }: {
  opacity?: number;
  /** Motto text colour — pass a light colour on dark screens */
  mottoColor?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setH(Math.round(e.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showLogo  = h >= MIN_FOR_LOGO;
  const showMotto = h >= MIN_FOR_MOTTO;
  // Crest size follows the free space, capped so it stays a quiet accent
  const size = Math.min(200, Math.round((showMotto ? h - 60 : h) * 0.7));

  return (
    <div ref={ref} aria-hidden style={{
      flex: '1 1 auto', minHeight: 0, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none', userSelect: 'none',
    }}>
      {showLogo && (
        <>
          <img src="/logo.png" alt="" draggable={false} style={{
            width: size, height: size, objectFit: 'contain', borderRadius: 20,
            opacity, filter: 'saturate(0.85)',
          }} />
          {showMotto && (
            <div style={{
              marginTop: 10, fontSize: 12.5, fontStyle: 'italic', fontWeight: 600,
              color: mottoColor, opacity: Math.min(1, opacity * 2.4), textAlign: 'center',
            }}>
              “Build Character before Champions”
            </div>
          )}
        </>
      )}
    </div>
  );
}
