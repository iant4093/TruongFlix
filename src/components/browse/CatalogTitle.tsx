import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Download, ExternalLink, Loader2, Play, ShieldCheck } from 'lucide-react';
import { getCatalogDetail, getCatalogSeason, type SearchResult } from '../../services/tmdb';
import { browseSource, cancelSourceBrowser, quickTorrent } from '../../services/browse';
import type { BrowseScope, CatalogDetail, CatalogSeason } from '../../types/browse';
import { useLibraryStore } from '../../store/useLibraryStore';
import type { TorrentMode } from '../../types/media';
import Modal from '../live/LiveDialog';
import Dropdown from '../common/Dropdown';
import Artwork from '../common/Artwork';

export default function CatalogTitle({ item, onClose, onSource, suspended = false }: { item: SearchResult; onClose: () => void; onSource: () => void; suspended?: boolean }) {
  const sourceUrl = useLibraryStore((s) => s.settings.browse_source_url);
  const imdbEnabled = useLibraryStore((s) => s.settings.imdb_enabled);
  const library = useLibraryStore((s) => s.items);
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [season, setSeason] = useState(1);
  const [seasonData, setSeasonData] = useState<CatalogSeason | null>(null);
  const [seasonError, setSeasonError] = useState('');
  const [episode, setEpisode] = useState<number | 'season'>(1);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const actionRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setDetailError('');
    void getCatalogDetail(item).then((d) => {
      if (!alive) return;
      setDetail(d); setSeason(d.seasons[0]?.number ?? 1);
      if (imdbEnabled && d.imdbId) void invoke<{ ratings: Record<string, { rating: number }> }>('imdb_lookup', { titleIds: [d.imdbId], showIds: [], force: false })
        .then((r) => { if (alive) setRating(r.ratings[d.imdbId]?.rating ?? null); }).catch(() => {});
    }).catch((e) => { if (alive) setDetailError(String(e)); });
    return () => { alive = false; };
  }, [item.id, item.kind, retry]);
  useEffect(() => {
    if (!detail || detail.kind !== 'tv') return;
    let alive = true; setSeasonData(null); setSeasonError('');
    void getCatalogSeason(detail, season).then((data) => {
      if (!alive) return;
      setSeasonData(data); setEpisode(data.episodes[0]?.episode_number ?? 1);
    }).catch((e) => { if (alive) setSeasonError(String(e)); });
    return () => { alive = false; };
  }, [detail, season, retry]);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); cancelSourceBrowser(); }; }, []);
  useLayoutEffect(() => {
    if (!actionsOpen) return;
    const rect = actionRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 200 && above > below;
    setMenuPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)),
      maxHeight: Math.max(40, up ? above : below),
      ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
  }, [actionsOpen]);
  useEffect(() => {
    if (!actionsOpen || !menuPosition) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (e: MouseEvent) => { if (!actionRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setActionsOpen(false); };
    const close = () => setActionsOpen(false);
    const scroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setActionsOpen(false); actionRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus(); }
      if (e.key === 'Tab') setActionsOpen(false);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      } };
    document.addEventListener('mousedown', outside); window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close); window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true); };
  }, [actionsOpen, menuPosition]);

  const scope: BrowseScope = item.kind === 'movie' ? { kind: 'movie' } : episode === 'season'
    ? { kind: 'season', season, expected: seasonData?.episodes.map((e) => e.episode_number) ?? [], complete: seasonData?.complete ?? false }
    : { kind: 'episode', season, episode };
  const owned = library.find((i) => i.kind === item.kind && i.tmdbId === item.id);
  const ready = !!detail?.imdbId && (item.kind === 'movie' || !!seasonData?.episodes.length);
  const selection = scope.kind === 'movie' ? item.title : scope.kind === 'season' ? `Season ${season}` : `S${String(season).padStart(2, '0')} · E${String(episode).padStart(2, '0')}`;
  const run = async (mode: TorrentMode, quality: '1080p' | '4K') => {
    setActionsOpen(false); setError('');
    if (!sourceUrl) { onSource(); return; }
    if (!detail || !ready) return;
    const abort = new AbortController(); controller.current = abort; setBusy(true); setCommitting(false);
    try {
      await quickTorrent({ item: detail, target: { ...scope, imdbId: detail.imdbId, title: detail.title, year: detail.year, quality },
        mode, sourceUrl, signal: abort.signal, progress: (message) => {
          if (active.current) { setProgress(message); if (message === 'Preparing playback…' || message === 'Starting download…') setCommitting(true); }
        } });
    } catch (e) { if (active.current && !(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current) { setBusy(false); setProgress(''); setCommitting(false); } }
  };
  const manual = async () => {
    setError('');
    if (!sourceUrl) { onSource(); return; }
    if (!detail?.imdbId) return;
    setBusy(true); setProgress('Opening your source browser…'); setCommitting(false);
    try { await browseSource(detail, detail.imdbId, sourceUrl, onClose); }
    catch (e) { if (active.current && !(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current) { setBusy(false); setProgress(''); } }
  };
  return <Modal title={item.title} onClose={onClose} active={!suspended}>
    <div className="relative -mx-6 -mt-2 mb-6 h-56 overflow-hidden">
      <Artwork src={item.backdrop || item.poster} alt="" eager className="h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#181818] via-transparent to-transparent" />
    </div>
    <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-white/55">
      <span>{detail?.year ?? item.year}</span><span>{item.kind === 'movie' ? 'Movie' : 'TV Show'}</span>
      {detail?.certification && <span className="border border-white/35 px-1.5 text-xs">{detail.certification}</span>}
      {detail?.runtime && <span>{detail.runtime} min</span>}
      {rating != null && <span className="font-bold text-[#f5c518]">IMDb {rating.toFixed(1)}</span>}
      {owned && <button className="ml-auto text-sm text-white underline underline-offset-4" onClick={() => { onClose(); useLibraryStore.getState().openDetail(owned.key); }}>In your library</button>}
    </div>
    <p className="mb-3 text-sm leading-relaxed text-white/80">{detail?.overview || item.overview}</p>
    {!!detail?.genres.length && <p className="mb-6 text-xs text-white/45">{detail.genres.join(' · ')}</p>}
    {!detail && !detailError && <p role="status" className="my-6 flex items-center gap-2 text-sm text-white/55"><Loader2 className="h-4 w-4 animate-spin" />Loading title details…</p>}
    {detailError && <div role="alert" className="my-6 text-sm text-red-300">{detailError}<button className="nf-btn-ghost ml-3" onClick={() => setRetry((v) => v + 1)}>Retry</button></div>}
    {detail && !detail.imdbId && <p className="my-5 text-sm text-white/55">This title does not have an IMDb ID yet, so source matching is unavailable.</p>}
    {detail?.kind === 'tv' && <div className="my-6 rounded border border-white/10 bg-black/20 p-4">
      <div className="flex flex-wrap gap-3">
        <Dropdown value={season} options={detail.seasons.map((s) => ({ value: s.number, label: s.name || `Season ${s.number}`, hint: `${s.count} episodes` }))} onChange={setSeason} ariaLabel="Choose season" />
        {seasonData && <Dropdown<number | 'season'> value={episode} options={[
          { value: 'season', label: 'Entire season', hint: seasonData.complete ? `${seasonData.episodes.length} episodes` : 'Choose manually if the season is incomplete' },
          ...seasonData.episodes.map((e) => ({ value: e.episode_number, label: `Episode ${e.episode_number}`, hint: e.title })),
        ]} onChange={setEpisode} ariaLabel="Choose episode or entire season" />}
      </div>
      {!seasonData && !seasonError && <p role="status" className="mt-4 text-sm text-white/50">Loading episodes…</p>}
      {seasonError && <p role="alert" className="mt-4 text-sm text-red-300">{seasonError}<button className="ml-3 underline" onClick={() => setRetry((v) => v + 1)}>Retry</button></p>}
      {scope.kind === 'season' && !scope.complete && <p className="mt-4 text-xs leading-relaxed text-white/55">A complete season could not be confirmed. Quick actions are available for individual episodes; use the browser to select a pack manually.</p>}
      {typeof episode === 'number' && seasonData?.episodes.find((e) => e.episode_number === episode)?.overview && <p className="mt-4 text-sm leading-relaxed text-white/60">{seasonData.episodes.find((e) => e.episode_number === episode)?.overview}</p>}
    </div>}
    <div className="mt-7 flex flex-wrap gap-3">
      <div ref={actionRef} className="relative">
        <button className="nf-btn-red" aria-expanded={actionsOpen} aria-haspopup="menu" disabled={!ready || busy || (scope.kind === 'season' && !scope.complete)} onClick={() => setActionsOpen((v) => !v)}><Play className="h-4 w-4 fill-current" />Quick stream / download<ChevronDown className="h-4 w-4" /></button>
        {actionsOpen && menuPosition && createPortal(<div ref={menuRef} role="menu" aria-label="Quick torrent actions" style={menuPosition} className="fixed z-[250] w-64 overflow-y-auto overscroll-contain rounded-md border border-white/20 bg-[#252525] py-1 shadow-2xl">
          {(['stream', 'download'] as const).flatMap((mode) => (['1080p', '4K'] as const).map((quality) => <button key={`${mode}:${quality}`} role="menuitem" className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/10 focus:bg-white/10" onClick={() => void run(mode, quality)}>{mode === 'stream' ? <Play className="h-4 w-4" /> : <Download className="h-4 w-4" />}{mode === 'stream' ? 'Stream' : 'Download'} {quality}</button>))}
        </div>, document.body)}
      </div>
      <button className="nf-btn-ghost" disabled={!detail?.imdbId || busy} onClick={() => void manual()}><ExternalLink className="h-4 w-4" />Browse torrents</button>
    </div>
    {busy && <div role="status" className="mt-5 rounded border border-white/15 bg-white/5 p-4">
      <p className="mb-2 text-xs font-semibold text-white/50">{selection}</p><p className="flex items-center gap-2 break-words text-sm"><Loader2 className="h-4 w-4 shrink-0 animate-spin" />{progress}</p>
      {!committing && <button className="nf-btn-ghost mt-4 text-sm" onClick={() => { controller.current?.abort(); cancelSourceBrowser(); }}>Cancel search</button>}
    </div>}
    {error && <p role="alert" className="mt-5 text-sm leading-relaxed text-red-300">{error}</p>}
    <p className="mt-5 flex items-center gap-2 text-xs text-white/40"><ShieldCheck className="h-4 w-4" />{sourceUrl ? 'Source browser protected by ad and popup blocking' : 'Add your source website to use torrent actions'}</p>
  </Modal>;
}
