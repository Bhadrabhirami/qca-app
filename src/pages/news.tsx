/**
 * news.tsx — Cricket Hub
 *
 * Architecture (mirrors Library/QCA Channel pattern):
 *  • Offline-first: reads from local SQLite (hub_news / hub_insights)
 *  • On mount: show local instantly → check latest 5 from server in background
 *  • Auto-sync every 60 min (same as library)
 *  • Manual ↻ refresh button in header triggers full sync
 *  • Sync progress shown in header subtitle
 *
 * Features:
 *  News tab:
 *    - Category filter chips (All / Match Report / Player News / ...)
 *    - Search bar
 *    - Bookmark (🔖) per card — persisted in local DB
 *    - Read/Unread indicator
 *    - Tap → full detail screen with coaching insight + source link
 *    - Saved tab: bookmarked news only
 *
 *  Insights tab:
 *    - Skill filter chips (All / Batting / Bowling / ...)
 *    - Search bar
 *    - Bookmark per card
 *    - Tap → 3-part coaching breakdown + drill tip + related
 *    - Saved tab: bookmarked insights only
 *
 *  Refresh button: instant full server sync with progress
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from './usePermissions';
import {
  upsertHubNews, upsertHubInsights,
  getHubNews, getHubInsights,
  countHubNews, countHubInsights,
  toggleNewsBookmark, toggleInsightBookmark,
  markNewsRead, markInsightRead,
  syncHubNewsFromServer, syncHubInsightsFromServer,
  checkLatestHubNews, checkLatestHubInsights,
  hubNewsMinutesSinceSync, hubInsightsMinutesSinceSync,
  getHubNewsCategories, getHubInsightSkills,
} from '../database/db';
import ScreenHeader, { HeaderIconButton, HeaderTabs } from '../shared/ScreenHeader';

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  navy: '#001f3f', gold: '#c5a059', green: '#1a472a',
  red: '#c0392b', orange: '#e67e22', bg: '#f0f2f5',
  card: '#fff', border: '#e5e7eb', muted: '#6b7280',
};

const SKILL_COLORS: Record<string, string> = {
  Batting: '#1a472a', Bowling: '#c0392b', Fielding: '#e67e22',
  Wicketkeeping: '#7c3aed', Leadership: '#001f3f', General: '#6b7280',
};
const CAT_COLORS: Record<string, string> = {
  'Match Report': '#001f3f', 'Player News': '#1a472a',
  'Series Update': '#c5a059', 'Coaching': '#7c3aed', 'Records': '#c0392b',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
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
function timeAgo(dt: string) {
  if (!dt) return '';
  const diff = (Date.now() - new Date(dt).getTime()) / 1000;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function openUrl(url: string) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── Pill ──────────────────────────────────────────────────────────────────────
function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      backgroundColor: color + '18', color, fontSize: 10,
      fontWeight: 800, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
      {label}
    </span>
  );
}

// ── Filter chips row ──────────────────────────────────────────────────────────
function FilterRow({ items, active, onSelect, colorMap }: {
  items: string[]; active: string; onSelect: (s: string) => void;
  colorMap?: Record<string, string>;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto' as const,
      padding: '10px 16px', scrollbarWidth: 'none' as any }}>
      {['All', ...items].map(s => {
        const col = colorMap?.[s] || C.navy;
        const isActive = (s === 'All' && !active) || s === active;
        return (
          <button key={s} onClick={() => onSelect(s === 'All' ? '' : s)}
            style={{ padding: '5px 14px', borderRadius: 20, border: 'none',
              cursor: 'pointer', fontSize: 11, fontWeight: 800,
              whiteSpace: 'nowrap' as const, flexShrink: 0,
              backgroundColor: isActive ? col : C.card,
              color: isActive ? '#fff' : C.muted,
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
              transition: 'all 0.15s' }}>
            {s}
          </button>
        );
      })}
    </div>
  );
}

// ── Search bar ────────────────────────────────────────────────────────────────
function SearchBar({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div style={{ position: 'relative', margin: '0 16px 10px' }}>
      <span style={{ position: 'absolute', left: 11, top: '50%',
        transform: 'translateY(-50%)', fontSize: 14, color: C.muted }}>🔍</span>
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder || 'Search…'}
        style={{ width: '100%', padding: '9px 34px 9px 32px', borderRadius: 10,
          border: `1px solid ${C.border}`, fontSize: 13, outline: 'none',
          boxSizing: 'border-box' as const, backgroundColor: C.card,
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }} />
      {value && (
        <button onClick={() => onChange('')} style={{ position: 'absolute',
          right: 10, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 15, color: C.muted }}>✕</button>
      )}
    </div>
  );
}

// ── News image with fallback ──────────────────────────────────────────────────
function NewsImage({ url, alt, height = 180 }: {
  url: string; alt: string; height?: number;
}) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div style={{ height, backgroundColor: '#e8f0e9',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 42 }}>
        🏏
      </div>
    );
  }
  return <img src={url} alt={alt} onError={() => setErr(true)}
    style={{ width: '100%', height, objectFit: 'cover', display: 'block' }} />;
}

// ── News card ─────────────────────────────────────────────────────────────────
function NewsCard({ item, onTap, onBookmark }: {
  item: any; onTap: () => void; onBookmark: () => void;
}) {
  const catColor = CAT_COLORS[item.category] || C.navy;
  return (
    <div style={{ backgroundColor: C.card, borderRadius: 16, overflow: 'hidden',
      marginBottom: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
      border: `1px solid ${C.border}`,
      opacity: item.is_read ? 0.85 : 1 }}>

      {/* Unread dot */}
      <div style={{ position: 'relative' }}>
        <div onClick={onTap} style={{ cursor: 'pointer' }}>
          <NewsImage url={item.media_url} alt={item.headline} height={170} />
        </div>
        {!item.is_read && (
          <div style={{ position: 'absolute', top: 10, left: 10,
            width: 8, height: 8, borderRadius: '50%',
            backgroundColor: C.gold, border: '2px solid #fff' }} />
        )}
        {/* Bookmark button */}
        <button onClick={e => { e.stopPropagation(); onBookmark(); }}
          style={{ position: 'absolute', top: 8, right: 8,
            width: 32, height: 32, borderRadius: '50%',
            backgroundColor: 'rgba(0,0,0,0.45)',
            border: 'none', cursor: 'pointer', fontSize: 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {item.is_bookmarked ? '🔖' : '🏷️'}
        </button>
      </div>

      <div onClick={onTap} style={{ padding: '12px 14px', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', marginBottom: 7 }}>
          <Pill label={item.category || 'Cricket'} color={catColor} />
          <span style={{ fontSize: 11, color: C.muted }}>
            {timeAgo(item.published_at || item.fetched_at)}
          </span>
        </div>
        <div style={{ fontWeight: 800, fontSize: 15, color: '#111',
          lineHeight: 1.35, marginBottom: 6 }}>
          {item.headline}
        </div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55,
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, marginBottom: 8 }}>
          {item.short_summary || item.summary}
        </div>
        {item.coaching_insight && (
          <div style={{ fontSize: 11, color: C.green, fontWeight: 700,
            backgroundColor: '#f0fdf4', padding: '5px 9px', borderRadius: 8,
            lineHeight: 1.4 }}>
            🎯 {item.coaching_insight.slice(0, 70)}{item.coaching_insight.length > 70 ? '…' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ── News detail ───────────────────────────────────────────────────────────────
function NewsDetail({ item, onBack, onBookmark }: {
  item: any; onBack: () => void; onBookmark: () => void;
}) {
  const catColor = CAT_COLORS[item.category] || C.navy;
  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 40, fontFamily: 'sans-serif' }}>
      <ScreenHeader back={onBack} background={`linear-gradient(135deg,${catColor},${catColor}cc)`}
        title={<Pill label={item.category || 'Cricket'} color="rgba(255,255,255,0.3)" />}
        subtitle={timeAgo(item.published_at || item.fetched_at)}
        actions={<HeaderIconButton label="Bookmark" onClick={onBookmark}>{item.is_bookmarked ? '🔖' : '🏷️'}</HeaderIconButton>} />

      <NewsImage url={item.media_url} alt={item.headline} height={210} />

      <div style={{ padding: '18px 16px 0' }}>
        <h1 style={{ fontSize: 20, fontWeight: 900, color: '#111',
          lineHeight: 1.3, margin: '0 0 14px' }}>{item.headline}</h1>

        <div style={{ backgroundColor: C.card, borderRadius: 14, padding: '16px',
          marginBottom: 14, border: `1px solid ${C.border}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.muted,
            textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginBottom: 8 }}>
            Full Story
          </div>
          <p style={{ fontSize: 14, color: '#333', lineHeight: 1.75, margin: 0 }}>
            {item.summary}
          </p>
        </div>

        {item.coaching_insight && (
          <div style={{ backgroundColor: '#f0fdf4', borderRadius: 14, padding: '16px',
            marginBottom: 14, border: '1px solid #86efac' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.green,
              textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginBottom: 8 }}>
              🎯 Coaching Insight
            </div>
            <p style={{ fontSize: 14, color: '#166534', lineHeight: 1.65, margin: 0 }}>
              {item.coaching_insight}
            </p>
          </div>
        )}

        {item.source_url && (
          <button onClick={() => openUrl(item.source_url)} style={{
            width: '100%', padding: '14px', borderRadius: 12, border: 'none',
            backgroundColor: catColor, color: '#fff', fontWeight: 800,
            fontSize: 14, cursor: 'pointer', boxShadow: `0 4px 14px ${catColor}44` }}>
            🔗 Read Full Article
          </button>
        )}
      </div>
    </div>
  );
}

// ── Insight card ──────────────────────────────────────────────────────────────
function InsightCard({ item, onTap, onBookmark }: {
  item: any; onTap: () => void; onBookmark: () => void;
}) {
  const sc = SKILL_COLORS[item.skill_focus] || C.muted;
  return (
    <div style={{ backgroundColor: C.card, borderRadius: 16, overflow: 'hidden',
      marginBottom: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
      border: `1px solid ${C.border}`, opacity: item.is_read ? 0.85 : 1 }}>

      <div style={{ height: 4, backgroundColor: sc }} />

      {/* Image if present */}
      {item.media_url && (
        <div onClick={onTap} style={{ cursor: 'pointer', position: 'relative' }}>
          <NewsImage url={item.media_url} alt={item.insight_title} height={140} />
          {!item.is_read && (
            <div style={{ position: 'absolute', top: 10, left: 10,
              width: 8, height: 8, borderRadius: '50%',
              backgroundColor: C.gold, border: '2px solid #fff' }} />
          )}
          <button onClick={e => { e.stopPropagation(); onBookmark(); }}
            style={{ position: 'absolute', top: 8, right: 8,
              width: 32, height: 32, borderRadius: '50%',
              backgroundColor: 'rgba(0,0,0,0.45)', border: 'none',
              cursor: 'pointer', fontSize: 15,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {item.is_bookmarked ? '🔖' : '🏷️'}
          </button>
        </div>
      )}

      <div onClick={onTap} style={{ padding: '12px 14px', cursor: 'pointer' }}>
        {!item.media_url && (
          <div style={{ display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!item.is_read && <div style={{ width: 7, height: 7, borderRadius: '50%',
                backgroundColor: C.gold, flexShrink: 0 }} />}
              <Pill label={item.skill_focus} color={sc} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: C.muted }}>
                {timeAgo(item.published_at || item.fetched_at)}
              </span>
              <button onClick={e => { e.stopPropagation(); onBookmark(); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 16, padding: 0 }}>
                {item.is_bookmarked ? '🔖' : '🏷️'}
              </button>
            </div>
          </div>
        )}
        {item.media_url && (
          <div style={{ display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: 6 }}>
            <Pill label={item.skill_focus} color={sc} />
            <span style={{ fontSize: 11, color: C.muted }}>
              {timeAgo(item.published_at || item.fetched_at)}
            </span>
          </div>
        )}

        <div style={{ fontWeight: 800, fontSize: 14, color: '#111',
          lineHeight: 1.35, marginBottom: 5 }}>
          {item.insight_title}
        </div>
        {item.player_name && (
          <div style={{ fontSize: 12, color: sc, fontWeight: 700, marginBottom: 3 }}>
            👤 {item.player_name}
            {item.match_teams && <span style={{ fontWeight: 400, color: C.muted }}> · {item.match_teams}</span>}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#555', lineHeight: 1.55,
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, marginBottom: 8 }}>
          {item.coaching_text}
        </div>
        {item.drill_tip && (
          <div style={{ fontSize: 11, color: '#92400e', backgroundColor: '#fffbeb',
            padding: '5px 9px', borderRadius: 8, border: '1px solid #fcd34d',
            fontWeight: 600, lineHeight: 1.4 }}>
            🏋️ {item.drill_tip.slice(0, 70)}{item.drill_tip.length > 70 ? '…' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Insight detail ────────────────────────────────────────────────────────────
function InsightDetail({ item, related, onBack, onBookmark, onRelatedTap }: {
  item: any; related: any[]; onBack: () => void;
  onBookmark: () => void; onRelatedTap: (id: number) => void;
}) {
  const sc = SKILL_COLORS[item.skill_focus] || C.muted;
  const sentences = (item.coaching_text || '').split(/(?<=\.)\s+/).filter(Boolean);
  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 40 }}>
      <ScreenHeader back={onBack} background={`linear-gradient(135deg,${sc},${sc}bb)`}
        title={<Pill label={item.skill_focus} color="rgba(255,255,255,0.3)" />}
        subtitle={<>{item.player_name && `${item.player_name} · `}{timeAgo(item.published_at || item.fetched_at)}</>}
        actions={<HeaderIconButton label="Bookmark" onClick={onBookmark}>{item.is_bookmarked ? '🔖' : '🏷️'}</HeaderIconButton>} />

      {item.media_url && <NewsImage url={item.media_url} alt={item.insight_title} height={200} />}

      <div style={{ padding: '18px 16px 0' }}>
        <h1 style={{ fontSize: 19, fontWeight: 900, color: '#111',
          lineHeight: 1.3, margin: '0 0 6px' }}>{item.insight_title}</h1>
        {item.match_context && (
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>
            📍 {item.match_context}
          </div>
        )}

        {/* 3-part coaching breakdown */}
        <div style={{ backgroundColor: C.card, borderRadius: 14, padding: '16px',
          marginBottom: 14, border: `1px solid ${C.border}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: sc,
            textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginBottom: 14 }}>
            🏏 Coaching Breakdown
          </div>
          {sentences.length >= 3 ? (
            [
              { icon: '📌', label: 'What happened',           text: sentences[0] },
              { icon: '⚙️', label: 'Biomechanical principle', text: sentences[1] },
              { icon: '🎯', label: 'Junior takeaway',         text: sentences[2] },
            ].map((s, i) => (
              <div key={i} style={{ marginBottom: i < 2 ? 14 : 0,
                paddingBottom: i < 2 ? 14 : 0,
                borderBottom: i < 2 ? `1px solid ${C.border}` : 'none' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: sc,
                  textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: 4 }}>
                  {s.icon} {s.label}
                </div>
                <p style={{ fontSize: 14, color: '#333', lineHeight: 1.7, margin: 0 }}>{s.text}</p>
              </div>
            ))
          ) : (
            <p style={{ fontSize: 14, color: '#333', lineHeight: 1.7, margin: 0 }}>
              {item.coaching_text}
            </p>
          )}
        </div>

        {/* Drill tip */}
        {item.drill_tip && (
          <div style={{ backgroundColor: '#fffbeb', borderRadius: 14, padding: '16px',
            marginBottom: 14, border: '1px solid #fcd34d' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#92400e',
              textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginBottom: 8 }}>
              🏋️ Today's Drill
            </div>
            <p style={{ fontSize: 14, color: '#78350f', lineHeight: 1.7, margin: 0, fontWeight: 500 }}>
              {item.drill_tip}
            </p>
          </div>
        )}

        {item.source_url && (
          <button onClick={() => openUrl(item.source_url)} style={{
            width: '100%', padding: '13px', borderRadius: 12, border: 'none',
            backgroundColor: sc, color: '#fff', fontWeight: 800,
            fontSize: 14, cursor: 'pointer', marginBottom: 20,
            boxShadow: `0 4px 14px ${sc}44` }}>
            🔗 View Match Report
          </button>
        )}

        {related.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.muted,
              textTransform: 'uppercase' as const, letterSpacing: '0.8px', marginBottom: 10 }}>
              Related Insights
            </div>
            {related.map(r => (
              <div key={r.id} onClick={() => onRelatedTap(r.id)}
                style={{ backgroundColor: C.card, borderRadius: 12,
                  padding: '11px 14px', marginBottom: 8, border: `1px solid ${C.border}`,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 4, height: 38, borderRadius: 2, flexShrink: 0,
                  backgroundColor: SKILL_COLORS[r.skill_focus] || C.muted }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#111',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                    {r.insight_title}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    {r.player_name} · {r.skill_focus}
                  </div>
                </div>
                <span style={{ color: C.muted, fontSize: 18 }}>›</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function Empty({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div style={{ textAlign: 'center' as const, padding: '48px 20px', color: C.muted }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontWeight: 800, fontSize: 16, color: '#111', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{sub}</div>
    </div>
  );
}

// ── News Tab ──────────────────────────────────────────────────────────────────
type NewsView = 'list' | 'detail' | 'saved';

function NewsTab({ base, onSyncDone }: { base: string; onSyncDone?: () => void }) {
  const [items,     setItems]     = useState<any[]>([]);
  const [total,     setTotal]     = useState(0);
  const [cats,      setCats]      = useState<string[]>([]);
  const [catFilter, setCatFilter] = useState('');
  const [search,    setSearch]    = useState('');
  const [view,      setView]      = useState<NewsView>('list');
  const [detail,    setDetail]    = useState<any|null>(null);
  const [loading,   setLoading]   = useState(true);
  const [showAll,   setShowAll]   = useState(false);
  const lastSync = useRef(0);

  const load = useCallback(async (all = showAll) => {
    setLoading(true);
    try {
      const rows = await getHubNews({
        category: catFilter || undefined,
        search: search || undefined,
        limit: all ? 999 : 10,
      });
      const cnt  = await countHubNews(catFilter || undefined, search || undefined);
      const cs   = await getHubNewsCategories();
      setItems(rows); setTotal(cnt); setCats(cs);
    } finally { setLoading(false); }
  }, [catFilter, search, showAll]);

  // On mount: full sync if local empty, else show local + check latest
  useEffect(() => {
    countHubNews().then(async (localCount) => {
      if (localCount === 0) {
        setLoading(true);
        await syncHubNewsFromServer(base, hdr());
        lastSync.current = Date.now();
        await load();
      } else {
        load();
        checkLatestHubNews(base, hdr()).then(changed => {
          if (changed) load();
          lastSync.current = Date.now();
        });
      }
    });
    const id = setInterval(() => {
      if (Date.now() - lastSync.current > 60 * 60 * 1000) {
        checkLatestHubNews(base, hdr()).then(changed => {
          if (changed) load();
          lastSync.current = Date.now();
        });
      }
    }, 60 * 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-load when filters change
  useEffect(() => { load(); }, [load]);

  const openDetail = async (item: any) => {
    await markNewsRead(item.id);
    setDetail({ ...item, is_read: 1 });
    setView('detail');
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_read: 1 } : i));
  };

  const handleBookmark = async (item: any) => {
    const val = await toggleNewsBookmark(item.id);
    const upd = { ...item, is_bookmarked: val ? 1 : 0 };
    setItems(prev => prev.map(i => i.id === item.id ? upd : i));
    if (detail?.id === item.id) setDetail(upd);
  };

  const saved = items.filter(i => i.is_bookmarked);

  if (view === 'detail' && detail) {
    return (
      <NewsDetail item={detail} onBack={() => setView('list')}
        onBookmark={() => handleBookmark(detail)} />
    );
  }

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', backgroundColor: '#f8fafc',
        borderBottom: `1px solid ${C.border}` }}>
        {(['list', 'saved'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 12,
            backgroundColor: 'transparent',
            color: view === v ? C.navy : C.muted,
            borderBottom: `2.5px solid ${view === v ? C.navy : 'transparent'}` }}>
            {v === 'list' ? `📰 All (${total})` : `🔖 Saved (${saved.length})`}
          </button>
        ))}
      </div>

      {view === 'saved' ? (
        <div style={{ padding: '12px 16px 0' }}>
          {saved.length === 0
            ? <Empty icon="🔖" title="No saved articles"
                sub="Tap 🏷️ on any article to save it for later" />
            : saved.map(item => (
                <NewsCard key={item.id} item={item}
                  onTap={() => openDetail(item)}
                  onBookmark={() => handleBookmark(item)} />
              ))
          }
        </div>
      ) : (
        <>
          <FilterRow items={cats} active={catFilter}
            onSelect={setCatFilter} colorMap={CAT_COLORS} />
          <SearchBar value={search} onChange={setSearch}
            placeholder={`Search ${total} articles…`} />
          <div style={{ padding: '0 16px' }}>
            {loading && <Empty icon="📰" title="Loading news…" sub="Reading from local cache" />}
            {!loading && items.length === 0 && (
              <Empty icon="📭" title="No articles yet"
                sub="Tap ↻ to sync from server. News auto-refreshes every hour." />
            )}
            {!loading && items.map(item => (
              <NewsCard key={item.id} item={item}
                onTap={() => openDetail(item)}
                onBookmark={() => handleBookmark(item)} />
            ))}
            {!loading && items.length > 0 && items.length < total && (
              <button onClick={() => { setShowAll(true); load(true); }}
                style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none',
                  backgroundColor: C.navy, color: C.gold, fontWeight: 800,
                  fontSize: 14, cursor: 'pointer', marginBottom: 16 }}>
                📰 Load All {total} Articles
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Insights Tab ──────────────────────────────────────────────────────────────
type InsightView = 'list' | 'detail' | 'saved';

function InsightsTab({ base }: { base: string }) {
  const [items,       setItems]       = useState<any[]>([]);
  const [total,       setTotal]       = useState(0);
  const [skills,      setSkills]      = useState<string[]>([]);
  const [skillFilter, setSkillFilter] = useState('');
  const [search,      setSearch]      = useState('');
  const [view,        setView]        = useState<InsightView>('list');
  const [detail,      setDetail]      = useState<any|null>(null);
  const [related,     setRelated]     = useState<any[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [showAll,     setShowAll]     = useState(false);
  const lastSync = useRef(0);

  const load = useCallback(async (all = showAll) => {
    setLoading(true);
    try {
      const rows = await getHubInsights({
        skill: skillFilter || undefined,
        search: search || undefined,
        limit: all ? 999 : 6,
      });
      const cnt  = await countHubInsights(skillFilter || undefined, search || undefined);
      const sks  = await getHubInsightSkills();
      setItems(rows); setTotal(cnt); setSkills(sks);
    } finally { setLoading(false); }
  }, [skillFilter, search, showAll]);

  useEffect(() => {
    // Check local count first — if empty, run full sync (first time or permission just granted)
    countHubInsights().then(async (localCount) => {
      if (localCount === 0) {
        // No local data — do a full server sync before loading
        setLoading(true);
        await syncHubInsightsFromServer(base, hdr());
        lastSync.current = Date.now();
        await load();
      } else {
        // Have local data — show it immediately, check latest in background
        load();
        checkLatestHubInsights(base, hdr()).then(changed => {
          if (changed) load();
          lastSync.current = Date.now();
        });
      }
    });
    // Auto-refresh every 60 min
    const id = setInterval(() => {
      if (Date.now() - lastSync.current > 60 * 60 * 1000) {
        checkLatestHubInsights(base, hdr()).then(changed => {
          if (changed) load();
          lastSync.current = Date.now();
        });
      }
    }, 60 * 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (item: any) => {
    await markInsightRead(item.id);
    // Build related from local DB
    const allIns = await getHubInsights({ skill: item.skill_focus, limit: 10 });
    const rel = allIns.filter(i => i.id !== item.id).slice(0, 3);
    setDetail({ ...item, is_read: 1 });
    setRelated(rel);
    setView('detail');
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_read: 1 } : i));
  };

  const handleBookmark = async (item: any) => {
    const val = await toggleInsightBookmark(item.id);
    const upd = { ...item, is_bookmarked: val ? 1 : 0 };
    setItems(prev => prev.map(i => i.id === item.id ? upd : i));
    if (detail?.id === item.id) setDetail(upd);
  };

  const saved = items.filter(i => i.is_bookmarked);

  if (view === 'detail' && detail) {
    return (
      <InsightDetail item={detail} related={related}
        onBack={() => setView('list')}
        onBookmark={() => handleBookmark(detail)}
        onRelatedTap={async (id) => {
          const found = items.find(i => i.id === id) ||
                        (await getHubInsights({ limit: 999 })).find((i: any) => i.id === id);
          if (found) openDetail(found);
        }} />
    );
  }

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', backgroundColor: '#f8fafc',
        borderBottom: `1px solid ${C.border}` }}>
        {(['list', 'saved'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 12, backgroundColor: 'transparent',
            color: view === v ? C.green : C.muted,
            borderBottom: `2.5px solid ${view === v ? C.green : 'transparent'}` }}>
            {v === 'list' ? `🎯 All (${total})` : `🔖 Saved (${saved.length})`}
          </button>
        ))}
      </div>

      {view === 'saved' ? (
        <div style={{ padding: '12px 16px 0' }}>
          {saved.length === 0
            ? <Empty icon="🔖" title="No saved insights"
                sub="Tap 🏷️ on any insight to save it for later" />
            : saved.map(item => (
                <InsightCard key={item.id} item={item}
                  onTap={() => openDetail(item)}
                  onBookmark={() => handleBookmark(item)} />
              ))
          }
        </div>
      ) : (
        <>
          <FilterRow items={skills} active={skillFilter}
            onSelect={setSkillFilter} colorMap={SKILL_COLORS} />
          <SearchBar value={search} onChange={setSearch}
            placeholder={`Search ${total} insights…`} />
          <div style={{ padding: '0 16px' }}>
            {loading && <Empty icon="🎯" title="Loading insights…" sub="Reading from local cache" />}
            {!loading && items.length === 0 && (
              <Empty icon="📭" title="No insights yet"
                sub="Tap ↻ to sync from server. AI generates new insights 5× daily." />
            )}
            {!loading && items.map(item => (
              <InsightCard key={item.id} item={item}
                onTap={() => openDetail(item)}
                onBookmark={() => handleBookmark(item)} />
            ))}
            {!loading && items.length > 0 && items.length < total && (
              <button onClick={() => { setShowAll(true); load(true); }}
                style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none',
                  backgroundColor: C.green, color: '#fff', fontWeight: 800,
                  fontSize: 14, cursor: 'pointer', marginBottom: 16 }}>
                🎯 Load All {total} Insights
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
type MainTab = 'news' | 'insights';
type SyncState = 'idle' | 'syncing' | 'done' | 'error';


export default function NewsScreen() {
  const navigate = useNavigate();
  const { can }  = usePermissions();
  const base     = bld(localStorage.getItem('server_ip') ?? '');
  const [tab,        setTab]        = useState<MainTab>('news');
  const [syncStatus, setSyncStatus] = useState<SyncState>('idle');
  const [syncProg,   setSyncProg]   = useState({ fetched: 0, total: 0 });

  // On mount: full sync if stale (> 60 min) OR if local DB is empty
  useEffect(() => {
    Promise.all([countHubNews(), countHubInsights()]).then(([nc, ic]) => {
      const newsStale     = nc === 0 || hubNewsMinutesSinceSync()     > 60;
      const insightsStale = ic === 0 || hubInsightsMinutesSinceSync() > 60;
      if (!newsStale && !insightsStale) return;
    setSyncStatus('syncing');
    Promise.all([
      newsStale     ? syncHubNewsFromServer(base, hdr(),
          (f, t) => setSyncProg({ fetched: f, total: t }))
        : Promise.resolve({ fetched: 0, total: 0 }),
      insightsStale ? syncHubInsightsFromServer(base, hdr())
        : Promise.resolve({ fetched: 0, total: 0 }),
    ]).then(([n, i]) => {
      setSyncProg({ fetched: n.fetched + i.fetched, total: n.total + i.total });
      setSyncStatus('done');
      setTimeout(() => setSyncStatus('idle'), 3000);
      }).catch(() => {
        setSyncStatus('error');
        setTimeout(() => setSyncStatus('idle'), 3000);
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    if (syncStatus === 'syncing') return;
    setSyncStatus('syncing');
    setSyncProg({ fetched: 0, total: 0 });
    Promise.all([
      syncHubNewsFromServer(base, hdr(), (f, t) => setSyncProg({ fetched: f, total: t })),
      syncHubInsightsFromServer(base, hdr()),
    ]).then(([n, i]) => {
      setSyncProg({ fetched: n.fetched + i.fetched, total: n.total + i.total });
      setSyncStatus('done');
      setTimeout(() => setSyncStatus('idle'), 3000);
      window.dispatchEvent(new CustomEvent('hub-refreshed'));
    }).catch(() => {
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 3000);
    });
  };

  const subtitle =
    syncStatus === 'syncing' ? `⟳ Syncing… ${syncProg.fetched}${syncProg.total > 0 ? ' / ' + syncProg.total : ''} items`
    : syncStatus === 'done'   ? `✔ ${syncProg.fetched} items synced`
    : syncStatus === 'error'  ? '⚠ Sync failed — tap ↻ to retry'
    : 'AI-powered news & coaching insights';

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', paddingBottom: 40 }}>

      <ScreenHeader background={`linear-gradient(135deg,${C.navy} 60%,#002b5c 100%)`}
        title={<span style={{ color: C.gold }}>🏏 Cricket Hub</span>}
        subtitle={subtitle}
        actions={<HeaderIconButton label="Refresh" onClick={handleRefresh} disabled={syncStatus === 'syncing'}>
          {syncStatus === 'syncing' ? '⟳' : syncStatus === 'done' ? '✔' : '↻'}
        </HeaderIconButton>}>
        <HeaderTabs color={C.navy} value={tab} onChange={setTab}
          tabs={[{ id: 'news' as const, label: '📰 News' }, { id: 'insights' as const, label: '🎯 Insights' }]} />
      </ScreenHeader>

      {/* Content */}
      {tab === 'news'     && <NewsTab     base={base} />}
      {tab === 'insights' && <InsightsTab base={base} />}
    </div>
  );
}
