import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Download, Search, Loader2, Play, ShieldCheck, Star, CalendarDays, Clock, UserRound } from 'lucide-react';
import { getCatalogDetail, getCatalogSeason, type SearchResult } from '../../services/tmdb';
import { cancelSourceBrowser, quickTorrent } from '../../services/browse';
import type { BrowseScope, CatalogDetail, CatalogSeason } from '../../types/browse';
import { useLibraryStore } from '../../store/useLibraryStore';
import type { TorrentMode } from '../../types/media';
import CatalogDialog from './CatalogDialog';
import SourceVerification from './SourceVerification';
import SourceBrowser from './SourceBrowser';
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
  const [verification, setVerification] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [browsing, setBrowsing] = useState(false);
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
        mode, sourceUrl, signal: abort.signal, verification: (id) => { if (active.current) setVerification(id); }, progress: (message) => {
          if (active.current) { setProgress(message); if (message === 'Preparing playback…' || message === 'Starting download…') setCommitting(true); }
        } });
    } catch (e) { if (active.current && !(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current) { setBusy(false); setProgress(''); setCommitting(false); setVerification(null); } }
  };
  const manual = () => {
    setError('');
    if (!sourceUrl) { onSource(); return; }
    if (!detail?.imdbId) return;
    setBrowsing(true);
  };
  const people = detail?.cast?.filter((person) => !person.job) ?? [];
  const crew = detail?.cast?.filter((person) => person.job) ?? [];
  const selectedEpisode = typeof episode === 'number' ? seasonData?.episodes.find((e) => e.episode_number === episode) : null;
  let language = detail?.language ?? '';
  try { if (language) language = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language; } catch { /* Keep the supplied language if it is not a standard code. */ }
  const date = (raw: string | null | undefined) => {
    const value = new Date(`${raw?.slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(value.getTime()) ? value.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
  };
  return <><CatalogDialog title={item.title} onClose={onClose} active={!suspended && !browsing}>
    <div className="relative h-[46vh] min-h-[280px] max-h-[520px] overflow-hidden rounded-t-xl bg-[#202020]">
      <Artwork key={detail?.backdrop || item.backdrop} src={detail?.backdrop || item.backdrop || item.poster} alt="" eager className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-nf-surface via-black/15 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/10 to-transparent" />
      <div className="absolute bottom-7 left-7 right-7 md:bottom-9 md:left-10 md:right-10">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-white/65">{item.kind === 'movie' ? 'Movie' : 'TV Series'}</p>
        {detail?.logo && !logoFailed ? <><h1 className="sr-only">{detail.title}</h1><img src={detail.logo} alt={detail.title} onError={() => setLogoFailed(true)} className="max-h-28 max-w-[75%] object-contain object-left drop-shadow-lg" /></>
          : <h1 className="max-w-[85%] text-4xl font-black leading-tight tracking-tight drop-shadow-lg md:text-6xl">{detail?.title || item.title}</h1>}
        {detail?.tagline && <p className="mt-4 max-w-2xl text-base italic text-white/75 md:text-lg">{detail.tagline}</p>}
      </div>
    </div>
    <div className="px-7 pb-9 md:px-10 md:pb-11">
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-white/60">
        {rating != null && <span className="rounded bg-[#f5c518] px-2 py-0.5 text-xs font-bold text-black">IMDb {rating.toFixed(1)}</span>}
        {(detail?.voteAverage ?? item.voteAverage) > 0 && <span className="flex items-center gap-1.5 text-white/80"><Star className="h-3.5 w-3.5 fill-current text-amber-300" />{(detail?.voteAverage ?? item.voteAverage).toFixed(1)}<span className="text-xs text-white/40">TMDB</span></span>}
        <span>{detail?.year ?? item.year}</span>
        {detail?.certification && <span className="border border-white/35 px-1.5 text-xs">{detail.certification}</span>}
        {!!detail?.runtime && <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{detail.runtime} min{item.kind === 'tv' ? ' / episode' : ''}</span>}
        {!!detail?.seasons.length && <span>{detail.seasons.length} {detail.seasons.length === 1 ? 'season' : 'seasons'}</span>}
        {owned && <button className="ml-auto text-sm text-white underline underline-offset-4" onClick={() => { onClose(); useLibraryStore.getState().openDetail(owned.key); }}>In your library</button>}
      </div>
      {detail?.kind === 'tv' && <div className="mb-5"><p className="mb-3 text-sm font-medium text-white/60">Choose an episode or season</p>
        <fieldset disabled={busy} className="flex flex-wrap gap-3">
          <Dropdown value={season} options={detail.seasons.map((s) => ({ value: s.number, label: s.name || `Season ${s.number}`, hint: `${s.count} episodes` }))} onChange={setSeason} ariaLabel="Choose season" />
          {seasonData && <Dropdown<number | 'season'> value={episode} options={[
            { value: 'season', label: 'Entire season', hint: seasonData.complete ? `${seasonData.episodes.length} episodes` : 'Choose manually if the season is incomplete' },
            ...seasonData.episodes.map((e) => ({ value: e.episode_number, label: `Episode ${e.episode_number}`, hint: e.title })),
          ]} onChange={setEpisode} ariaLabel="Choose episode or entire season" />}
        </fieldset>
        <p className="mt-3 text-xs text-white/45">{selection}{selectedEpisode ? ` · ${selectedEpisode.title}` : ''}</p>
      </div>}
      <div className="mb-5 flex flex-wrap gap-3">
        <div ref={actionRef} className="relative">
          <button className="nf-btn-red" aria-expanded={actionsOpen} aria-haspopup="menu" disabled={!ready || busy || (scope.kind === 'season' && !scope.complete)} onClick={() => setActionsOpen((v) => !v)}><Play className="h-4 w-4 fill-current" />Quick stream / download<ChevronDown className="h-4 w-4" /></button>
          {actionsOpen && menuPosition && createPortal(<div ref={menuRef} role="menu" aria-label="Quick torrent actions" style={menuPosition} className="fixed z-[250] w-64 overflow-y-auto overscroll-contain rounded-md border border-white/20 bg-[#252525] py-1 shadow-2xl">
            {(['stream', 'download'] as const).flatMap((mode) => (['1080p', '4K'] as const).map((quality) => <button key={`${mode}:${quality}`} role="menuitem" className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/10 focus:bg-white/10" onClick={() => void run(mode, quality)}>{mode === 'stream' ? <Play className="h-4 w-4" /> : <Download className="h-4 w-4" />}{mode === 'stream' ? 'Stream' : 'Download'} {quality}</button>))}
          </div>, document.body)}
        </div>
        <button className="nf-btn-ghost" disabled={!detail?.imdbId || busy} onClick={manual}><Search className="h-4 w-4" />Browse torrents</button>
      </div>
      {busy && <div role="status" className="mt-5 rounded-lg border border-white/15 bg-white/5 p-5">
        <p className="mb-2 text-xs font-semibold text-white/50">{selection}</p><div className="flex flex-wrap items-center justify-between gap-4"><p className="flex min-w-0 items-center gap-2 break-words text-sm"><Loader2 className="h-4 w-4 shrink-0 animate-spin" />{progress}</p>
          {!committing && <button className="nf-btn-ghost shrink-0 text-sm" onClick={() => { controller.current?.abort(); cancelSourceBrowser(); }}>Cancel search</button>}</div>
      </div>}
      {verification && <SourceVerification requestId={verification} />}
      {error && <p role="alert" className="mt-5 text-sm leading-relaxed text-red-300">{error}</p>}
      {!detail && !detailError && <p role="status" className="my-6 flex items-center gap-2 text-sm text-white/55"><Loader2 className="h-4 w-4 animate-spin" />Loading title details…</p>}
      {detailError && <div role="alert" className="my-6 text-sm text-red-300">{detailError}<button className="nf-btn-ghost ml-3" onClick={() => setRetry((v) => v + 1)}>Retry</button></div>}
      {detail && !detail.imdbId && <p className="my-5 text-sm text-white/55">This title does not have an IMDb ID yet, so source matching is unavailable.</p>}
      <div className="mt-8 grid gap-7 md:grid-cols-[minmax(0,2fr)_minmax(180px,1fr)] md:gap-9">
        <div><h2 className="mb-3 text-lg font-semibold">Overview</h2><p className="text-base leading-relaxed text-white/80">{detail?.overview || item.overview || 'An overview is not available yet.'}</p>
          {!!detail?.genres.length && <div className="mt-5 flex flex-wrap gap-2">{detail.genres.map((genre) => <span key={genre} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">{genre}</span>)}</div>}
        </div>
        <dl className="space-y-3 border-l border-white/10 pl-6 text-sm">
          {detail?.status && <div><dt className="text-white/40">Status</dt><dd className="mt-1 text-white/80">{detail.status}</dd></div>}
          {detail?.releaseDate && <div><dt className="flex items-center gap-1.5 text-white/40"><CalendarDays className="h-3.5 w-3.5" />{item.kind === 'movie' ? 'Release date' : 'First aired'}</dt><dd className="mt-1 text-white/80">{date(detail.releaseDate)}</dd></div>}
          {language && <div><dt className="text-white/40">Original language</dt><dd className="mt-1 text-white/80">{language}</dd></div>}
          {!!detail?.totalEpisodes && <div><dt className="text-white/40">Episodes</dt><dd className="mt-1 text-white/80">{detail.totalEpisodes}</dd></div>}
          {!!detail?.networks?.length && <div><dt className="text-white/40">Network</dt><dd className="mt-1 text-white/80">{detail.networks.join(', ')}</dd></div>}
          {crew.map((person) => <div key={`${person.job}:${person.id ?? person.name}`}><dt className="text-white/40">{person.job}</dt><dd className="mt-1 text-white/80">{person.name}</dd></div>)}
        </dl>
      </div>
      {detail?.kind === 'tv' && <section className="mt-9 rounded-lg border border-white/10 bg-black/20 p-5">
        <h2 className="mb-4 text-lg font-semibold">{episode === 'season' ? 'Season details' : 'Episode details'}</h2>

        {!seasonData && !seasonError && <p role="status" className="mt-4 text-sm text-white/50">Loading episodes…</p>}
        {seasonError && <p role="alert" className="mt-4 text-sm text-red-300">{seasonError}<button className="ml-3 underline" onClick={() => setRetry((v) => v + 1)}>Retry</button></p>}
        {scope.kind === 'season' && !scope.complete && <p className="mt-4 text-sm leading-relaxed text-white/55">A complete season could not be confirmed. Choose an episode for a quick action, or select a pack manually with Browse torrents.</p>}
        {selectedEpisode && <div className="mt-5 flex items-start gap-5">
          {selectedEpisode.still_path && <Artwork key={selectedEpisode.still_path} src={selectedEpisode.still_path} alt="" className="hidden aspect-video w-44 shrink-0 rounded-md md:block" />}
          <div><h3 className="font-semibold">{selectedEpisode.episode_number}. {selectedEpisode.title}</h3><p className="mt-1 text-xs text-white/40">{[date(selectedEpisode.air_date), selectedEpisode.runtime ? `${selectedEpisode.runtime} min` : ''].filter(Boolean).join(' · ')}</p>
            {selectedEpisode.overview && <p className="mt-3 text-sm leading-relaxed text-white/65">{selectedEpisode.overview}</p>}</div>
        </div>}
        {episode === 'season' && seasonData && <p className="mt-4 text-sm text-white/60">Season {season} · {seasonData.episodes.length} episodes{seasonData.complete ? ' · Complete season confirmed' : ''}</p>}
      </section>}
      {!!people.length && <section className="mt-9"><h2 className="mb-5 text-lg font-semibold">Cast</h2><div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
        {people.map((person) => <div key={person.id ?? person.name} className="min-w-0">{person.profile_path ? <Artwork src={person.profile_path} alt={person.name} className="aspect-[3/4] w-full rounded-lg" /> : <div className="flex aspect-[3/4] items-center justify-center rounded-lg bg-white/5"><UserRound className="h-12 w-12 text-white/20" /></div>}<p className="mt-2 truncate text-sm font-medium">{person.name}</p>{person.character && <p className="mt-1 truncate text-xs text-white/40">{person.character}</p>}</div>)}
      </div></section>}
      <p className="mt-8 flex items-center gap-2 border-t border-white/10 pt-5 text-xs text-white/40"><ShieldCheck className="h-4 w-4" />{sourceUrl ? 'Source browser protected by ad and popup blocking' : 'Add your source website to use torrent actions'}</p>
    </div>
  </CatalogDialog>
    {browsing && !suspended && detail && <SourceBrowser item={detail} sourceUrl={sourceUrl} onBack={() => setBrowsing(false)} onSelected={onClose} />}
  </>;
}
