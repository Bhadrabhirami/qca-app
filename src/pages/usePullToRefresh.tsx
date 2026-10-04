/**
 * usePullToRefresh — Reusable pull-to-refresh hook + visual indicator
 *
 * Usage in any page:
 *   const { pullProps, PullIndicator } = usePullToRefresh(async () => {
 *     await syncMyData();          // page-specific sync
 *     await reloadFromLocalDb();   // refresh page state
 *   });
 *
 *   return (
 *     <div {...pullProps}>          // attach to the scrollable page root
 *       <PullIndicator />           // renders the spinner/arrow at top
 *       ...page content...
 *     </div>
 *   );
 *
 * Behaviour:
 *   • Only triggers when the page is scrolled to the very top
 *   • User pulls down ≥ 70px → release → onRefresh() runs
 *   • Spinner shows while the async refresh runs
 *   • Works with native touch scrolling (Android WebView / Capacitor)
 */
import React, { useRef, useState, useCallback } from 'react';

const THRESHOLD = 70;   // px pull distance to trigger
const MAX_PULL  = 110;  // px max visual pull

export function usePullToRefresh(onRefresh: () => Promise<void>) {
  const [pull,       setPull]       = useState(0);      // current pull distance
  const [refreshing, setRefreshing] = useState(false);
  const startY    = useRef(0);
  const pulling   = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Only start a pull when the list is scrolled to the very top. Pages
    // scroll inside SimpleLayout's .app-scroll container, not the window —
    // checking the page element itself was always 0, so scrolling *up*
    // mid-list used to trigger a full re-sync.
    const el = e.currentTarget as HTMLElement;
    const scroller = el.closest('.app-scroll') as HTMLElement | null;
    const atTop = (scroller ? scroller.scrollTop : window.scrollY) <= 0 && el.scrollTop <= 0;
    if (!atTop || refreshing) { pulling.current = false; return; }
    startY.current  = e.touches[0].clientY;
    pulling.current = true;
  }, [refreshing]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling.current || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy <= 0) { setPull(0); return; }
    // Resistance curve — pull feels heavier the further you go
    const eased = Math.min(MAX_PULL, dy * 0.5);
    setPull(eased);
  }, [refreshing]);

  const onTouchEnd = useCallback(async () => {
    if (!pulling.current) return;
    pulling.current = false;
    if (pull >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPull(THRESHOLD);   // hold indicator visible while running
      try {
        await onRefresh();
      } catch (e) {
        console.warn('[PullToRefresh] refresh error:', e);
      } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
  }, [pull, refreshing, onRefresh]);

  const pullProps = {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  };

  const PullIndicator = useCallback(() => {
    if (pull <= 0 && !refreshing) return null;
    const ready = pull >= THRESHOLD;
    return (
      <div style={{
        height: pull, overflow: 'hidden',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        transition: pulling.current ? 'none' : 'height 0.25s ease',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          paddingBottom: 10, fontSize: 12, fontWeight: 700,
          color: ready || refreshing ? '#1a472a' : '#9ca3af',
        }}>
          {refreshing ? (
            <>
              <span style={{
                width: 16, height: 16, borderRadius: '50%',
                border: '2px solid #1a472a', borderTopColor: 'transparent',
                display: 'inline-block',
                animation: 'qca-ptr-spin 0.7s linear infinite',
              }} />
              Syncing…
            </>
          ) : (
            <>
              <span style={{
                display: 'inline-block',
                transform: ready ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}>↓</span>
              {ready ? 'Release to refresh' : 'Pull to refresh'}
            </>
          )}
        </div>
        <style>{`@keyframes qca-ptr-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }, [pull, refreshing]);

  return { pullProps, PullIndicator, refreshing }
}
export default usePullToRefresh;
