/**
 * news.tsx — Cricket Hub
 *
 * Architecture (mirrors Library/QCA Channel pattern):
 *  • Offline-first: reads from local SQLite (hub_news / hub_insights)
 *  • On mount: show local instantly → check latest 5 from server in background
 *  • Auto-sync every 60 min (same as library)
 *  • Manual ↻ refresh button in header triggers full sync, then lists reload
 *
 *  News tab:     category chips · search · All / Saved · read/unread · bookmark
 *                tap → article (summary, coaching insight, source link)
 *  Insights tab: skill chips · search · All / Saved · read/unread · bookmark
 *                tap → 3-part coaching breakdown + drill tip + related
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
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

// ── Theme (same tokens as the rest of the app) ────────────────────────────────
const C = {
  green: '#1a472a', gold: '#d4af37', red: '#c0392b', bg: '#f4f7f6',
  card: '#fff', border: '#e8e8e8', muted: '#6b7280', text: '#1f2937',
};
const CARD: React.CSSProperties = { backgroundColor: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' };

const SKILL_COLORS: Record<string, string> = {
  Batting: '#1a472a', Bowling: '#c0392b', Fielding: '#e67e22',
  Wicketkeeping: '#7c3aed', Leadership: '#0f766e', General: '#6b7280',
};
const CAT_COLORS: Record<string, string> = {
  'Match Report': '#1e40af', 'Player News': '#1a472a',
  'Series Update': '#a8862a', 'Coaching': '#7c3aed', 'Records': '#c0392b',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function bld(ip: string) {
  const h = (ip || '').trim().replace(/\/+$/, '');
  return h.startsWith('http') ? h : `http://${h}`;
}
function hdr(): Record<string, string> {
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
  return { 'Content-Type': 'application/json', 'X-Username': localStorage.getItem('auth_user') ?? '' };
}
function timeAgo(dt: string) {
  if (!dt) return '';
  const diff = (Date.now() - new Date(dt).getTime()) / 1000;
  if (isNaN(diff)) return '';
  if (diff < 3600)  return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function openUrl(url: string) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
const clamp = (lines: number): React.CSSProperties =>
  ({ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical' });

// ── Small pieces ──────────────────────────────────────────────────────────────
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, letterSpacing: '0.8px', textTransform: 'uppercase', margin: '6px 2px 0' }}>{children}</div>
);

function Empty({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div style={{ ...CARD, padding: '28px 16px', textAlign: 'center', color: C.muted }}>
      <div style={{ fontSize: 30, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontWeight: 800, fontSize: 13.5, color: C.text }}>{title}</div>
      {sub && <div style={{ fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}

function Chips({ items, active, onSelect, colorMap }: {
  items: string[]; active: string; onSelect: (s: string) => void; colorMap?: Record<string, string>;
}) {
  return (
    <div style={{ display: 'flex', gap: 5, overflowX: 'auto', scrollbarWidth: 'none' }}>
      {['All', ...items].map(s => {
        const on = (s === 'All' && !active) || s === active;
        const col = s === 'All' ? C.green : (colorMap?.[s] || C.green);
        return (
          <button key={s} onClick={() => onSelect(s === 'All' ? '' : s)} aria-pressed={on}
            style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 16, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
              border: `1px solid ${on ? col : C.border}`, backgroundColor: on ? col : '#fff', color: on ? '#fff' : '#374151' }}>
            {s}
          </button>
        );
      })}
    </div>
  );
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 13 }}>🔍</span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || 'Search…'} aria-label={placeholder || 'Search'}
        style={{ width: '100%', padding: '8px 32px', borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 13.5, outline: 'none',
          boxSizing: 'border-box', backgroundColor: C.card }} />
      {value && (
        <button onClick={() => onChange('')} aria-label="Clear search" style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: C.muted }}>✕</button>
      )}
    </div>
  );
}

/** All / Saved switch inside each tab */
function ViewSwitch({ view, onChange, allLabel, total, savedCount }: {
  view: 'list'|'saved'; onChange: (v: 'list'|'saved') => void; allLabel: string; total: number; savedCount: number;
}) {
  const seg = (on: boolean): React.CSSProperties => ({
    flex: 1, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12,
    backgroundColor: on ? '#fff' : 'transparent', color: on ? C.green : C.muted, boxShadow: on ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
  });
  return (
    <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 8, backgroundColor: '#e5e7eb' }}>
      <button onClick={() => onChange('list')}  aria-pressed={view === 'list'}  style={seg(view === 'list')}>{allLabel} ({total})</button>
      <button onClick={() => onChange('saved')} aria-pressed={view === 'saved'} style={seg(view === 'saved')}>🔖 Saved ({savedCount})</button>
    </div>
  );
}

function Thumb({ url, size = 64 }: { url?: string; size?: number }) {
  const [err, setErr] = useState(false);
  return (
    <div style={{ width: size * 1.3, height: size, borderRadius: 8, flexShrink: 0, overflow: 'hidden', backgroundColor: '#e8f0e9',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
      {url && !err
        ? <img src={url} alt="" loading="lazy" onError={() => setErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : '🏏'}
    </div>
  );
}

function BookmarkBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={e => { e.stopPropagation(); onClick(); }} aria-label={on ? 'Remove from saved' : 'Save'} aria-pressed={on}
      style={{ flexShrink: 0, alignSelf: 'flex-start', width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer',
        backgroundColor: on ? '#fdf6dd' : 'transparent', fontSize: 15, opacity: on ? 1 : 0.35 }}>🔖</button>
  );
}

const unreadDot = <span aria-label="Unread" style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: C.gold, flexShrink: 0, display: 'inline-block' }} />;

// ── News row ──────────────────────────────────────────────────────────────────
function NewsRow({ item, first, onTap, onBookmark }: { item: any; first: boolean; onTap: () => void; onBookmark: () => void }) {
  const col = CAT_COLORS[item.category] || C.green;
  return (
    <div onClick={onTap} role="button" tabIndex={0}
      style={{ display: 'flex', gap: 10, padding: '9px 8px 9px 12px', borderTop: first ? 'none' : `1px solid ${C.border}`, cursor: 'pointer' }}>
      <Thumb url={item.media_url} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 800 }}>
          {!item.is_read && unreadDot}
          <span style={{ color: col, textTransform: 'uppercase' }}>{item.category || 'Cricket'}</span>
          <span style={{ color: C.muted, fontWeight: 600 }}>· {timeAgo(item.published_at || item.fetched_at)}</span>
        </div>
        <div style={{ fontWeight: item.is_read ? 700 : 800, fontSize: 13.5, color: C.text, lineHeight: 1.3, marginTop: 2, ...clamp(2) }}>{item.headline}</div>
        <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4, marginTop: 2, ...clamp(1) }}>{item.short_summary || item.summary}</div>
      </div>
      <BookmarkBtn on={!!item.is_bookmarked} onClick={onBookmark} />
    </div>
  );
}

// ── Insight row ───────────────────────────────────────────────────────────────
function InsightRow({ item, first, onTap, onBookmark }: { item: any; first: boolean; onTap: () => void; onBookmark: () => void }) {
  const sc = SKILL_COLORS[item.skill_focus] || C.muted;
  return (
    <div onClick={onTap} role="button" tabIndex={0}
      style={{ display: 'flex', gap: 10, padding: '9px 8px 9px 12px', borderTop: first ? 'none' : `1px solid ${C.border}`,
        cursor: 'pointer', boxShadow: `inset 3px 0 0 ${sc}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 800, flexWrap: 'wrap' }}>
          {!item.is_read && unreadDot}
          <span style={{ color: sc, textTransform: 'uppercase' }}>{item.skill_focus || 'General'}</span>
          {item.player_name && <span style={{ color: C.text, fontWeight: 700 }}>· {item.player_name}</span>}
          <span style={{ color: C.muted, fontWeight: 600 }}>· {timeAgo(item.published_at || item.fetched_at)}</span>
        </div>
        <div style={{ fontWeight: item.is_read ? 700 : 800, fontSize: 13.5, color: C.text, lineHeight: 1.3, marginTop: 2, ...clamp(2) }}>{item.insight_title}</div>
        <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4, marginTop: 2, ...clamp(1) }}>{item.coaching_text}</div>
        {item.drill_tip && <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, marginTop: 3, ...clamp(1) }}>🏋️ {item.drill_tip}</div>}
      </div>
      {item.media_url && <Thumb url={item.media_url} size={48} />}
      <BookmarkBtn on={!!item.is_bookmarked} onClick={onBookmark} />
    </div>
  );
}

// ── Detail screen shell (covers the hub; one header only) ─────────────────────
function DetailShell({ title, subtitle, bookmarked, onBack, onBookmark, children }: {
  title: React.ReactNode; subtitle?: React.ReactNode; bookmarked: boolean;
  onBack: () => void; onBookmark: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, backgroundColor: C.bg, overflowY: 'auto', fontFamily: 'sans-serif', color: C.text }}>
      <ScreenHeader back={onBack} title={title} subtitle={subtitle}
        actions={<HeaderIconButton label={bookmarked ? 'Remove from saved' : 'Save'} onClick={onBookmark}>
          <span style={{ opacity: bookmarked ? 1 : 0.5 }}>🔖</span>
        </HeaderIconButton>} />
      <div style={{ padding: '10px 10px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function HeroImage({ url }: { url?: string }) {
  const [err, setErr] = useState(false);
  if (!url || err) return null;
  return <img src={url} alt="" onError={() => setErr(true)} style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 12, display: 'block' }} />;
}

const BlockTitle = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <div style={{ fontSize: 10.5, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>{children}</div>
);

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ width: '100%', padding: '11px', borderRadius: 11, border: 'none', cursor: 'pointer',
      backgroundColor: C.green, color: C.gold, fontWeight: 900, fontSize: 14 }}>{children}</button>
  );
}

// ── News detail ───────────────────────────────────────────────────────────────
function NewsDetail({ item, onBack, onBookmark }: { item: any; onBack: () => void; onBookmark: () => void }) {
  const col = CAT_COLORS[item.category] || C.green;
  return (
    <DetailShell title="Article" subtitle={[item.category || 'Cricket', timeAgo(item.published_at || item.fetched_at)].filter(Boolean).join(' · ')}
      bookmarked={!!item.is_bookmarked} onBack={onBack} onBookmark={onBookmark}>
      <HeroImage url={item.media_url} />
      <div style={{ padding: '2px 2px 0' }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: col, textTransform: 'uppercase' }}>{item.category || 'Cricket'}</span>
        <h1 style={{ fontSize: 18, fontWeight: 900, color: C.text, lineHeight: 1.3, margin: '3px 0 0' }}>{item.headline}</h1>
      </div>
      <div style={{ ...CARD, padding: 12 }}>
        <BlockTitle color={C.muted}>Full story</BlockTitle>
        <p style={{ fontSize: 14, color: '#333', lineHeight: 1.7, margin: 0, whiteSpace: 'pre-line' }}>{item.summary}</p>
      </div>
      {item.coaching_insight && (
        <div style={{ ...CARD, padding: 12, backgroundColor: '#f0fdf4', borderColor: '#86efac' }}>
          <BlockTitle color={C.green}>🎯 Coaching insight</BlockTitle>
          <p style={{ fontSize: 14, color: '#166534', lineHeight: 1.65, margin: 0 }}>{item.coaching_insight}</p>
        </div>
      )}
      {item.source_url && <PrimaryButton onClick={() => openUrl(item.source_url)}>🔗 Read full article</PrimaryButton>}
    </DetailShell>
  );
}

// ── Insight detail ────────────────────────────────────────────────────────────
function InsightDetail({ item, related, onBack, onBookmark, onRelatedTap }: {
  item: any; related: any[]; onBack: () => void; onBookmark: () => void; onRelatedTap: (r: any) => void;
}) {
  const sc = SKILL_COLORS[item.skill_focus] || C.muted;
  const sentences = (item.coaching_text || '').split(/(?<=\.)\s+/).filter(Boolean);
  return (
    <DetailShell title="Coaching insight"
      subtitle={[item.skill_focus, item.player_name, timeAgo(item.published_at || item.fetched_at)].filter(Boolean).join(' · ')}
      bookmarked={!!item.is_bookmarked} onBack={onBack} onBookmark={onBookmark}>
      <HeroImage url={item.media_url} />
      <div style={{ padding: '2px 2px 0' }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: sc, textTransform: 'uppercase' }}>{item.skill_focus || 'General'}</span>
        <h1 style={{ fontSize: 18, fontWeight: 900, color: C.text, lineHeight: 1.3, margin: '3px 0 0' }}>{item.insight_title}</h1>
        {item.match_context && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>📍 {item.match_context}</div>}
      </div>

      {/* 3-part coaching breakdown */}
      <div style={{ ...CARD, padding: 12, boxShadow: `inset 3px 0 0 ${sc}` }}>
        <BlockTitle color={sc}>🏏 Coaching breakdown</BlockTitle>
        {sentences.length >= 3 ? (
          [
            { icon: '📌', label: 'What happened',           text: sentences[0] },
            { icon: '⚙️', label: 'Biomechanical principle', text: sentences[1] },
            { icon: '🎯', label: 'Junior takeaway',         text: sentences.slice(2).join(' ') },
          ].map((s, i) => (
            <div key={i} style={{ paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0, borderTop: i ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 3 }}>{s.icon} {s.label}</div>
              <p style={{ fontSize: 14, color: '#333', lineHeight: 1.65, margin: 0 }}>{s.text}</p>
            </div>
          ))
        ) : (
          <p style={{ fontSize: 14, color: '#333', lineHeight: 1.65, margin: 0 }}>{item.coaching_text}</p>
        )}
      </div>

      {item.drill_tip && (
        <div style={{ ...CARD, padding: 12, backgroundColor: '#fffbeb', borderColor: '#fcd34d' }}>
          <BlockTitle color="#92400e">🏋️ Today's drill</BlockTitle>
          <p style={{ fontSize: 14, color: '#78350f', lineHeight: 1.65, margin: 0, fontWeight: 500 }}>{item.drill_tip}</p>
        </div>
      )}

      {item.source_url && <PrimaryButton onClick={() => openUrl(item.source_url)}>🔗 View match report</PrimaryButton>}

      {related.length > 0 && (<>
        <SectionLabel>Related insights</SectionLabel>
        <div style={CARD}>
          {related.map((r, i) => (
            <button key={r.id} onClick={() => onRelatedTap(r)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: 'none', border: 'none',
                borderTop: i ? `1px solid ${C.border}` : 'none', cursor: 'pointer', textAlign: 'left',
                boxShadow: `inset 3px 0 0 ${SKILL_COLORS[r.skill_focus] || C.muted}` }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 700, fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.insight_title}</span>
                <span style={{ display: 'block', fontSize: 11, color: C.muted, marginTop: 1 }}>{[r.player_name, r.skill_focus].filter(Boolean).join(' · ')}</span>
              </span>
              <span style={{ color: C.muted, fontSize: 15 }}>›</span>
            </button>
          ))}
        </div>
      </>)}
    </DetailShell>
  );
}

// ── News Tab ──────────────────────────────────────────────────────────────────
function NewsTab({ base }: { base: string }) {
  const [items,     setItems]     = useState<any[]>([]);
  const [savedList, setSavedList] = useState<any[]>([]);
  const [total,     setTotal]     = useState(0);
  const [cats,      setCats]      = useState<string[]>([]);
  const [catFilter, setCatFilter] = useState('');
  const [search,    setSearch]    = useState('');
  const [view,      setView]      = useState<'list'|'saved'>('list');
  const [detail,    setDetail]    = useState<any|null>(null);
  const [loading,   setLoading]   = useState(true);
  const [showAll,   setShowAll]   = useState(false);
  const lastSync = useRef(0);
  const [firstSync, setFirstSync] = useState(false);   // empty table → initial server sync running

  const loadSaved = useCallback(async () => {
    setSavedList(await getHubNews({ bookmarked: true, limit: 999 }));
  }, []);

  const load = useCallback(async (all = showAll) => {
    setLoading(true);
    try {
      const rows = await getHubNews({ category: catFilter || undefined, search: search || undefined, limit: all ? 999 : 10 });
      const cnt  = await countHubNews(catFilter || undefined, search || undefined);
      setItems(rows); setTotal(cnt); setCats(await getHubNewsCategories());
      await loadSaved();
    } finally { setLoading(false); }
  }, [catFilter, search, showAll, loadSaved]);

  // On mount: full sync if local empty, else show local + check latest
  useEffect(() => {
    countHubNews().then(async (localCount) => {
      if (localCount === 0) {
        setLoading(true); setFirstSync(true);
        await syncHubNewsFromServer(base, hdr()).catch(() => {});
        setFirstSync(false);
        lastSync.current = Date.now();
        await load();
      } else {
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

  // (Re)load when filters change
  useEffect(() => { load(); }, [load]);

  const openDetail = async (item: any) => {
    await markNewsRead(item.id);
    setDetail({ ...item, is_read: 1 });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_read: 1 } : i));
    setSavedList(prev => prev.map(i => i.id === item.id ? { ...i, is_read: 1 } : i));
  };

  const handleBookmark = async (item: any) => {
    const val = await toggleNewsBookmark(item.id);
    const upd = { ...item, is_bookmarked: val ? 1 : 0 };
    setItems(prev => prev.map(i => i.id === item.id ? upd : i));
    if (detail?.id === item.id) setDetail(upd);
    loadSaved();
  };

  const list = view === 'saved' ? savedList : items;

  return (<>
    <ViewSwitch view={view} onChange={setView} allLabel="📰 All" total={total} savedCount={savedList.length} />
    {view === 'list' && (<>
      <Chips items={cats} active={catFilter} onSelect={setCatFilter} colorMap={CAT_COLORS} />
      <SearchBar value={search} onChange={setSearch} placeholder={`Search ${total} articles…`} />
    </>)}
    {(loading || firstSync) && view === 'list'
      ? <div style={{ textAlign: 'center', padding: '28px 0', color: C.muted, fontSize: 13 }}>Loading news…</div>
      : list.length === 0
        ? (view === 'saved'
            ? <Empty icon="🔖" title="No saved articles" sub="Tap 🔖 on any article to keep it here" />
            : <Empty icon="📭" title="No articles yet" sub="Tap ↻ to sync. News refreshes every hour." />)
        : <div style={CARD}>
            {list.map((item, i) => <NewsRow key={item.id} first={i === 0} item={item} onTap={() => openDetail(item)} onBookmark={() => handleBookmark(item)} />)}
          </div>}
    {view === 'list' && !loading && items.length > 0 && items.length < total && (
      <button onClick={() => { setShowAll(true); load(true); }} style={{ padding: '9px', borderRadius: 10, border: `1px solid ${C.green}`,
        backgroundColor: '#fff', color: C.green, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
        Show all {total} articles
      </button>
    )}
    {detail && <NewsDetail item={detail} onBack={() => setDetail(null)} onBookmark={() => handleBookmark(detail)} />}
  </>);
}

// ── Insights Tab ──────────────────────────────────────────────────────────────
function InsightsTab({ base }: { base: string }) {
  const [items,       setItems]       = useState<any[]>([]);
  const [savedList,   setSavedList]   = useState<any[]>([]);
  const [total,       setTotal]       = useState(0);
  const [skills,      setSkills]      = useState<string[]>([]);
  const [skillFilter, setSkillFilter] = useState('');
  const [search,      setSearch]      = useState('');
  const [view,        setView]        = useState<'list'|'saved'>('list');
  const [detail,      setDetail]      = useState<any|null>(null);
  const [related,     setRelated]     = useState<any[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [showAll,     setShowAll]     = useState(false);
  const lastSync = useRef(0);
  const [firstSync, setFirstSync] = useState(false);   // empty table → initial server sync running

  const loadSaved = useCallback(async () => {
    setSavedList(await getHubInsights({ bookmarked: true, limit: 999 }));
  }, []);

  const load = useCallback(async (all = showAll) => {
    setLoading(true);
    try {
      const rows = await getHubInsights({ skill: skillFilter || undefined, search: search || undefined, limit: all ? 999 : 10 });
      const cnt  = await countHubInsights(skillFilter || undefined, search || undefined);
      setItems(rows); setTotal(cnt); setSkills(await getHubInsightSkills());
      await loadSaved();
    } finally { setLoading(false); }
  }, [skillFilter, search, showAll, loadSaved]);

  useEffect(() => {
    // Empty locally (first time / permission just granted) → full sync first
    countHubInsights().then(async (localCount) => {
      if (localCount === 0) {
        setLoading(true); setFirstSync(true);
        await syncHubInsightsFromServer(base, hdr()).catch(() => {});
        setFirstSync(false);
        lastSync.current = Date.now();
        await load();
      } else {
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
    const sameSkill = await getHubInsights({ skill: item.skill_focus, limit: 10 });
    setRelated(sameSkill.filter(i => i.id !== item.id).slice(0, 3));
    setDetail({ ...item, is_read: 1 });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_read: 1 } : i));
    setSavedList(prev => prev.map(i => i.id === item.id ? { ...i, is_read: 1 } : i));
  };

  const handleBookmark = async (item: any) => {
    const val = await toggleInsightBookmark(item.id);
    const upd = { ...item, is_bookmarked: val ? 1 : 0 };
    setItems(prev => prev.map(i => i.id === item.id ? upd : i));
    if (detail?.id === item.id) setDetail(upd);
    loadSaved();
  };

  const list = view === 'saved' ? savedList : items;

  return (<>
    <ViewSwitch view={view} onChange={setView} allLabel="🎯 All" total={total} savedCount={savedList.length} />
    {view === 'list' && (<>
      <Chips items={skills} active={skillFilter} onSelect={setSkillFilter} colorMap={SKILL_COLORS} />
      <SearchBar value={search} onChange={setSearch} placeholder={`Search ${total} insights…`} />
    </>)}
    {(loading || firstSync) && view === 'list'
      ? <div style={{ textAlign: 'center', padding: '28px 0', color: C.muted, fontSize: 13 }}>Loading insights…</div>
      : list.length === 0
        ? (view === 'saved'
            ? <Empty icon="🔖" title="No saved insights" sub="Tap 🔖 on any insight to keep it here" />
            : <Empty icon="📭" title="No insights yet" sub="Tap ↻ to sync. New insights are generated through the day." />)
        : <div style={CARD}>
            {list.map((item, i) => <InsightRow key={item.id} first={i === 0} item={item} onTap={() => openDetail(item)} onBookmark={() => handleBookmark(item)} />)}
          </div>}
    {view === 'list' && !loading && items.length > 0 && items.length < total && (
      <button onClick={() => { setShowAll(true); load(true); }} style={{ padding: '9px', borderRadius: 10, border: `1px solid ${C.green}`,
        backgroundColor: '#fff', color: C.green, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
        Show all {total} insights
      </button>
    )}
    {detail && <InsightDetail item={detail} related={related}
      onBack={() => setDetail(null)}
      onBookmark={() => handleBookmark(detail)}
      onRelatedTap={(r) => openDetail(r)} />}
  </>);
}

// ── Main Screen ───────────────────────────────────────────────────────────────
type MainTab = 'news' | 'insights';
type SyncState = 'idle' | 'syncing' | 'done' | 'error';

export default function NewsScreen() {
  const base = bld(localStorage.getItem('server_ip') ?? '');
  const [tab,        setTab]        = useState<MainTab>('news');
  const [syncKey,    setSyncKey]    = useState(0);   // bump → tabs reload from the local DB
  const [syncStatus, setSyncStatus] = useState<SyncState>('idle');
  const [syncProg,   setSyncProg]   = useState({ fetched: 0, total: 0 });

  const runSync = (newsToo: boolean, insightsToo: boolean) => {
    setSyncStatus('syncing');
    setSyncProg({ fetched: 0, total: 0 });
    Promise.all([
      newsToo     ? syncHubNewsFromServer(base, hdr(), (f, t) => setSyncProg({ fetched: f, total: t })) : Promise.resolve({ fetched: 0, total: 0 }),
      insightsToo ? syncHubInsightsFromServer(base, hdr())                                              : Promise.resolve({ fetched: 0, total: 0 }),
    ]).then(([n, i]) => {
      setSyncProg({ fetched: n.fetched + i.fetched, total: n.total + i.total });
      setSyncStatus('done');
      if (n.fetched + i.fetched > 0) setSyncKey(k => k + 1);
      setTimeout(() => setSyncStatus('idle'), 3000);
    }).catch(() => {
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 3000);
    });
  };

  // On open: full sync if stale (> 60 min) — empty tables are synced by the tabs themselves
  useEffect(() => {
    Promise.all([countHubNews(), countHubInsights()]).then(([nc, ic]) => {
      const newsStale     = nc > 0 && hubNewsMinutesSinceSync()     > 60;
      const insightsStale = ic > 0 && hubInsightsMinutesSinceSync() > 60;
      if (newsStale || insightsStale) runSync(newsStale, insightsStale);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => { if (syncStatus !== 'syncing') runSync(true, true); };

  const subtitle =
    syncStatus === 'syncing' ? `⟳ Syncing… ${syncProg.fetched}${syncProg.total > 0 ? ' / ' + syncProg.total : ''} items`
    : syncStatus === 'done'   ? `✔ ${syncProg.fetched} items synced`
    : syncStatus === 'error'  ? '⚠ Sync failed — tap ↻ to retry'
    : 'News and coaching insights';

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100%', paddingBottom: 24, fontFamily: 'sans-serif', color: C.text }}>
      <ScreenHeader title="Cricket Hub" subtitle={subtitle}
        actions={<HeaderIconButton label="Refresh" onClick={handleRefresh} disabled={syncStatus === 'syncing'}>
          {syncStatus === 'syncing' ? '⟳' : syncStatus === 'done' ? '✔' : '↻'}
        </HeaderIconButton>}>
        <HeaderTabs value={tab} onChange={setTab}
          tabs={[{ id: 'news' as const, label: '📰 News' }, { id: 'insights' as const, label: '🎯 Insights' }]} />
      </ScreenHeader>

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tab === 'news'     && <NewsTab     key={`n${syncKey}`} base={base} />}
        {tab === 'insights' && <InsightsTab key={`i${syncKey}`} base={base} />}
      </div>
    </div>
  );
}
