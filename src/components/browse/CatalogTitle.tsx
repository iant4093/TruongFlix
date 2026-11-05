import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Download, Search, Loader2, Play, Star, UserRound } from 'lucide-react';
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
import CriticScores from '../common/CriticScores';
import ImdbRating from '../common/ImdbRating';
import MaturityRating from '../common/MaturityRating';
import { formatRuntime } from '../../store/selectors';
import useCatalogRatings from '../../hooks/useCatalogRatings';

export default function CatalogTitle({ item, onClose, onSource, suspended = false }: { item: SearchResult; onClose: () => void; onSource: () => void; suspended?: boolean }) {
  const sourceUrl = useLibraryStore((s) => s.settings.browse_source_url);
  const library = useLibraryStore((s) => s.items);
  const owned = library.find((i) => i.kind === item.kind && i.tmdbId === item.id);
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const { imdbRating, imdbVotes, rtScore, metacritic } = useCatalogRatings(detail?.imdbId, owned);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
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
  const statusRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if ((busy || error) && !verification) statusRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [busy, error, verification]);
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
  const tmdbRating = detail?.voteAverage ?? item.voteAverage;
  const selectedEpisode = typeof episode === 'number' ? seasonData?.episodes.find((e) => e.episode_number === episode) : null;
  let language = detail?.language ?? '';
  try { if (language) language = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language; } catch { /* Keep the supplied language if it is not a standard code. */ }
  const date = (raw: string | null | undefined) => {
    const value = new Date(`${raw?.slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(value.getTime()) ? value.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
  };
  return <><CatalogDialog title={item.title} onClose={onClose} active={!suspended && !browsing}>
    <div className="relative grid items-end overflow-hidden rounded-t-xl bg-nf-surface before:col-start-1 before:row-start-1 before:aspect-video before:min-h-[280px] before:w-full">
      <Artwork key={detail?.backdrop || item.backdrop || item.poster} src={detail?.backdrop || item.backdrop || item.poster} alt="" eager className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 bg-gradient-to-t from-nf-surface via-nf-surface/10 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-transparent to-transparent" />
      <div className="relative col-start-1 row-start-1 flex min-w-0 flex-col gap-5 px-6 pb-[4.5%] pt-16 md:px-12">
        {detail?.logo && !logoFailed ? <><h1 className="sr-only">{detail.title}</h1><img src={detail.logo} alt={detail.title} onError={() => setLogoFailed(true)} draggable={false} className="max-h-[110px] max-w-[45%] self-start object-contain object-left drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)]" /></>
          : <h1 className="text-shadow max-w-[85%] break-words text-3xl font-black uppercase leading-none tracking-tight md:max-w-[70%] md:text-5xl">{detail?.title || item.title}</h1>}
        {!!detail?.seasons.length && <fieldset disabled={busy} className="flex flex-wrap gap-2.5">
          <Dropdown value={season} options={detail.seasons.map((s) => ({ value: s.number, label: s.name || `Season ${s.number}`, hint: `${s.count} episodes` }))} onChange={(value) => { if (value !== season) { setSeasonData(null); setSeason(value); } }} ariaLabel="Choose season" />
          {seasonData && <Dropdown<number | 'season'> value={episode} options={[
            { value: 'season', label: 'Entire season', hint: seasonData.complete ? `${seasonData.episodes.length} episodes` : 'Choose manually if the season is incomplete' },
            ...seasonData.episodes.map((e) => ({ value: e.episode_number, label: `Episode ${e.episode_number}`, hint: e.title })),
          ]} onChange={setEpisode} ariaLabel="Choose episode or entire season" />}
        </fieldset>}
        <div className="flex flex-wrap items-center gap-2.5">
          <div ref={actionRef} className="relative">
            <button className="nf-btn-play px-4 disabled:opacity-50" aria-expanded={actionsOpen} aria-haspopup="menu" disabled={!ready || busy || (scope.kind === 'season' && !scope.complete)} onClick={() => setActionsOpen((v) => !v)}><Play className="h-5 w-5 shrink-0 fill-current" strokeWidth={0} />Quick stream / download<ChevronDown className="h-4 w-4 shrink-0" /></button>
            {actionsOpen && menuPosition && createPortal(<div ref={menuRef} role="menu" aria-label="Quick torrent actions" style={menuPosition} className="fixed z-[250] w-64 overflow-y-auto overscroll-contain rounded-md border border-white/20 bg-[#252525] py-1 shadow-2xl">
              {(['stream', 'download'] as const).flatMap((mode) => (['1080p', '4K'] as const).map((quality) => <button key={`${mode}:${quality}`} role="menuitem" className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/10 focus:bg-white/10" onClick={() => void run(mode, quality)}>{mode === 'stream' ? <Play className="h-4 w-4" /> : <Download className="h-4 w-4" />}{mode === 'stream' ? 'Stream' : 'Download'} {quality}</button>))}
            </div>, document.body)}
          </div>
          <button className="nf-btn-info px-4 disabled:opacity-50" disabled={!detail?.imdbId || busy} onClick={manual}><Search className="h-4 w-4" />Browse torrents</button>
          {owned && <button className="nf-btn-ghost" onClick={() => { onClose(); useLibraryStore.getState().openDetail(owned.key); }}>In your library</button>}
        </div>
      </div>
    </div>
    <div className="px-6 pb-9 pt-2 md:px-12">
      <div ref={statusRef}>
        {busy && <div role="status" className="mb-5 rounded-lg border border-white/15 bg-white/5 p-5">
          <p className="mb-2 text-xs font-semibold text-white/50">{selection}</p><div className="flex flex-wrap items-center justify-between gap-4"><p className="flex min-w-0 items-center gap-2 break-words text-sm"><Loader2 className="h-4 w-4 shrink-0 animate-spin" />{progress}</p>
            {!committing && <button className="nf-btn-ghost shrink-0 text-sm" onClick={() => { controller.current?.abort(); cancelSourceBrowser(); }}>Cancel search</button>}</div>
        </div>}
        {verification && <SourceVerification requestId={verification} />}
        {error && <p role="alert" className="mb-5 text-sm leading-relaxed text-red-300">{error}</p>}
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] md:gap-8">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[15px] text-nf-secondary">
            <ImdbRating rating={imdbRating} votes={imdbVotes} imdbId={detail?.imdbId} showVotes size="md" />
            {imdbRating == null && tmdbRating > 0 && <span className="inline-flex items-center gap-1.5"><Star className="h-3.5 w-3.5 fill-current text-amber-300" />{tmdbRating.toFixed(1)}<span className="text-xs text-nf-muted">TMDB</span></span>}
            <CriticScores rt={rtScore} metacritic={metacritic} size="md" />
            <span>{detail?.year ?? item.year}</span>
            <MaturityRating rating={detail?.certification ?? null} size="md" />
            {!!detail?.runtime && <span>{formatRuntime(detail.runtime)}{item.kind === 'tv' ? ' / episode' : ''}</span>}
            {!!detail?.seasons.length && <span>{detail.seasons.length} Season{detail.seasons.length === 1 ? '' : 's'}</span>}
          </div>
          {detail?.tagline && <p className="text-base italic text-white/70">{detail.tagline}</p>}
          <p className="text-[15px] leading-relaxed text-white">{detail?.overview || item.overview || 'No synopsis available.'}</p>
        </div>
        <div className="space-y-3 text-sm leading-relaxed">
          {!!people.length && <p><span className="text-nf-muted">Cast: </span>{people.slice(0, 4).map((person) => person.name).join(', ')}{people.length > 4 && <span className="italic text-white/80">, more</span>}</p>}
          {!!detail?.genres.length && <p><span className="text-nf-muted">Genres: </span>{detail.genres.join(', ')}</p>}
          {crew.map((person) => <p key={`${person.job}:${person.id ?? person.name}`}><span className="text-nf-muted">{person.job}: </span>{person.name}</p>)}
          {detail?.status && <p><span className="text-nf-muted">Status: </span>{detail.status}</p>}
          {detail?.releaseDate && <p><span className="text-nf-muted">{item.kind === 'movie' ? 'Release date' : 'First aired'}: </span>{date(detail.releaseDate)}</p>}
          {language && <p><span className="text-nf-muted">Original language: </span>{language}</p>}
          {!!detail?.totalEpisodes && <p><span className="text-nf-muted">Episodes: </span>{detail.totalEpisodes}</p>}
          {!!detail?.networks?.length && <p><span className="text-nf-muted">Network: </span>{detail.networks.join(', ')}</p>}
        </div>
      </div>
      {!detail && !detailError && <p role="status" className="my-6 flex items-center gap-2 text-sm text-white/55"><Loader2 className="h-4 w-4 animate-spin" />Loading title details…</p>}
      {detailError && <div role="alert" className="my-6 text-sm text-red-300">{detailError}<button className="nf-btn-ghost ml-3" onClick={() => setRetry((v) => v + 1)}>Retry</button></div>}
      {detail && !detail.imdbId && <p className="my-5 text-sm text-white/55">This title does not have an IMDb ID yet, so source matching is unavailable.</p>}
      {detail?.kind === 'tv' && <section className="mt-8 border-t border-white/10 pt-6">
        <h2 className="text-xl font-semibold">Episodes</h2>
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
      {!!people.length && <section aria-label="Cast" className="mt-9"><h2 className="mb-5 text-lg font-semibold">Cast</h2><div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
        {people.map((person) => <div key={person.id ?? person.name} className="min-w-0">{person.profile_path ? <Artwork src={person.profile_path} alt={person.name} className="aspect-[3/4] w-full rounded-lg" /> : <div className="flex aspect-[3/4] items-center justify-center rounded-lg bg-white/5"><UserRound className="h-12 w-12 text-white/20" /></div>}<p className="mt-2 truncate text-sm font-medium">{person.name}</p>{person.character && <p className="mt-1 truncate text-xs text-white/40">{person.character}</p>}</div>)}
      </div></section>}
    </div>
  </CatalogDialog>
    {browsing && !suspended && detail && <SourceBrowser item={detail} sourceUrl={sourceUrl} onBack={() => setBrowsing(false)} onSelected={onClose} />}
  </>;
}
