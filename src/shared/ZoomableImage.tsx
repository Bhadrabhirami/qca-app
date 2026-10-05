/**
 * ZoomableImage / ZoomableVideo — pinch to zoom, drag to pan, double-tap to zoom/reset.
 *
 * The Android WebView has page zoom off, so full-screen viewers need their own
 * gestures. Pointer events cover touch and mouse; touch-action:none stops the
 * browser from scrolling the page while media is being handled. Zoom resets
 * whenever `src` changes (next / previous item).
 *
 * Video: at 1× the native player controls are shown as usual. While zoomed the
 * native controls would be magnified off screen, so they are hidden and a small
 * bar outside the zoomed area offers play/pause and reset; a single tap on the
 * video also plays/pauses.
 */
import React, { useEffect, useRef, useState } from 'react';

const MIN = 1, MAX = 5, DOUBLE_TAP = 2.5, TAP_MS = 300;

function useZoom(src: string, onSingleTap?: () => void) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [animate, setAnimate] = useState(false);
  const boxRef   = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture  = useRef<{ dist: number; scale: number; mid: { x: number; y: number }; x: number; y: number } | null>(null);
  const drag     = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const lastTap  = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); }, [src]);
  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);

  /** Keep the media from being dragged completely off screen */
  const clampPan = (scale: number, x: number, y: number) => {
    const el = boxRef.current;
    if (!el || scale <= 1) return { x: 0, y: 0 };
    const maxX = (el.clientWidth  * (scale - 1)) / 2;
    const maxY = (el.clientHeight * (scale - 1)) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };
  const centre = (cx: number, cy: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
  };
  const reset = () => { setAnimate(true); setView({ scale: 1, x: 0, y: 0 }); };

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setAnimate(false);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: view.scale,
        mid: centre((a.x + b.x) / 2, (a.y + b.y) / 2), x: view.x, y: view.y };
      drag.current = null;
    } else if (pointers.current.size === 1) {
      drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.max(MIN, Math.min(MAX, g.scale * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist)));
      const k = scale / g.scale;   // zoom around the point between the fingers
      setView({ scale, ...clampPan(scale, g.mid.x - (g.mid.x - g.x) * k, g.mid.y - (g.mid.y - g.y) * k) });
    } else if (drag.current) {
      const d = drag.current;
      if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 8) d.moved = true;
      if (view.scale > 1) setView(v => ({ ...v, ...clampPan(v.scale, d.x + (e.clientX - d.px), d.y + (e.clientY - d.py)) }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasPinch = pointers.current.size >= 2;
    const moved = drag.current?.moved;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 1) {           // one finger left after a pinch → continue as a drag
      const [p] = [...pointers.current.values()];
      drag.current = { px: p.x, py: p.y, x: view.x, y: view.y, moved: true };
      return;
    }
    drag.current = null;
    if (wasPinch) { if (view.scale < 1.05) reset(); return; }
    if (moved) return;
    // Tap handling: double-tap zooms in on the spot / back out; single tap is optional
    const now = Date.now();
    if (now - lastTap.current < TAP_MS) {
      lastTap.current = 0;
      if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
      setAnimate(true);
      if (view.scale > 1) setView({ scale: 1, x: 0, y: 0 });
      else {
        const t = centre(e.clientX, e.clientY);
        setView({ scale: DOUBLE_TAP, ...clampPan(DOUBLE_TAP, -t.x * (DOUBLE_TAP - 1), -t.y * (DOUBLE_TAP - 1)) });
      }
    } else {
      lastTap.current = now;
      if (onSingleTap) tapTimer.current = setTimeout(() => { tapTimer.current = null; onSingleTap(); }, TAP_MS);
    }
  };

  const transform: React.CSSProperties = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    transition: animate ? 'transform 0.2s ease' : 'none', willChange: 'transform',
  };
  const boxProps = {
    ref: boxRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
    style: { position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center',
      justifyContent: 'center', overflow: 'hidden', touchAction: 'none', userSelect: 'none' } as React.CSSProperties,
  };
  return { view, transform, boxProps, reset };
}

const hintStyle: React.CSSProperties = {
  position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)', fontSize: 10.5,
  color: 'rgba(255,255,255,0.45)', pointerEvents: 'none', whiteSpace: 'nowrap',
};

export default function ZoomableImage({ src, alt = '', style }: { src: string; alt?: string; style?: React.CSSProperties }) {
  const { view, transform, boxProps } = useZoom(src);
  return (
    <div {...boxProps}>
      <img src={src} alt={alt} draggable={false}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', ...style, ...transform,
          cursor: view.scale > 1 ? 'grab' : 'zoom-in' }} />
      {view.scale === 1 && <span style={hintStyle}>Pinch or double-tap to zoom</span>}
    </div>
  );
}

export function ZoomableVideo({ src, poster, style, autoPlay = true }: {
  src: string; poster?: string; style?: React.CSSProperties; autoPlay?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(autoPlay);
  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  // Single tap plays/pauses only while zoomed (at 1× the native controls handle taps)
  const zoomedRef = useRef(false);
  const { view, transform, boxProps, reset } = useZoom(src, () => { if (zoomedRef.current) togglePlay(); });
  const zoomed = view.scale > 1;
  zoomedRef.current = zoomed;

  return (
    <div {...boxProps}>
      <video ref={videoRef} key={src} src={src} poster={poster} playsInline autoPlay={autoPlay}
        controls={!zoomed}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        style={{ width: '100%', maxHeight: '100%', backgroundColor: '#000', ...style, ...transform }} />
      {zoomed ? (
        <div onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
          style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8 }}>
          <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
            style={{ padding: '7px 14px', borderRadius: 18, border: 'none', backgroundColor: 'rgba(0,0,0,0.65)', color: '#fff',
              fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button onClick={reset} aria-label="Reset zoom"
            style={{ padding: '7px 14px', borderRadius: 18, border: 'none', backgroundColor: 'rgba(0,0,0,0.65)', color: '#fff',
              fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>⤢ {view.scale.toFixed(1)}× · Reset</button>
        </div>
      ) : (
        <span style={{ ...hintStyle, top: 6, bottom: 'auto' }}>Pinch or double-tap to zoom</span>
      )}
    </div>
  );
}
