import { useEffect, useRef, useState } from 'react';
import { Bookmark, Film, Play, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { playTargetFor } from '../../store/selectors';
import { listSavedBrowseTitles, setSavedBrowseTitle } from '../../services/db';
import { playItem } from '../../services/player';
import type { CatalogList, SearchResult } from '../../services/tmdb';
import type { BrowseEntry, BrowseEpisodeSelection, SavedBrowseTitle } from '../../types/browse';
import useCatalogFeed from '../../hooks/useCatalogFeed';
import { cancelSourceBrowser, validateSourceUrl } from '../../services/browse';
import Dropdown from '../common/Dropdown';
import Artwork from '../common/Artwork';
import Modal from '../live/LiveDialog';
import SegmentedControl from '../common/SegmentedControl';
import SearchField from '../common/SearchField';
import { LoadingState, RestrictedProfileNotice } from '../common/States';
import { errorMessage } from '../../lib/errors';
import CatalogTitle from './CatalogTitle';
import DiscoverHero from './DiscoverHero';

const lists: { value: CatalogList; label: string }[] = [
  { value: 'trending', label: 'Trending this week' }, { value: 'popular', label: 'Popular' },
  { value: 'new', label: 'New releases' }, { value: 'top', label: 'Top rated' },
];

const titleKey = (item: SearchResult) => `${item.kind}:${item.id}`;
const browseViews = [{ label: 'Discover', saved: false }, { label: 'Saved in Browse', saved: true }];
// A save can outlive the Browse view. Reopening must read after it settles.
const pendingSaves = new Map<number, Promise<void>>();

function upcomingDate(value?: string | null) {
  if (!value || value <= new Date().toISOString().slice(0, 10)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : null;
}

export default function Discover() {
  const profile = useLibraryStore((s) => s.activeProfile);
  const profileGate = useLibraryStore((s) => s.profileGate);
  if (profile?.maturity !== 'all' || profileGate) return <RestrictedProfileNotice title="Browse" action="browse titles and torrent sources" />;
  return <BrowseCatalog key={profile.id} profileId={profile.id} />;
}

function BrowseCatalog({ profileId }: { profileId: number }) {
  const settings = useLibraryStore((s) => s.settings);
  const items = useLibraryStore((s) => s.items);
  const episodes = useLibraryStore((s) => s.episodesBySeries);
  const browseEntry = useLibraryStore((s) => s.browseEntry);
  const [kind, setKind] = useState<'movie' | 'tv'>('movie');
  const [list, setList] = useState<CatalogList>('trending');
  const [query, setQuery] = useState('');
  const [savedOnly, setSavedOnly] = useState(false);
  const [savedTitles, setSavedTitles] = useState<SavedBrowseTitle[] | null>(null);
  const [savedError, setSavedError] = useState('');
  const [savedRetry, setSavedRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<BrowseEntry | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const canDiscover = !!settings.tmdb_api_key;
  const feed = useCatalogFeed(kind, list, savedOnly ? '' : query, settings.tmdb_api_key, profileId, !savedOnly);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const data: SavedBrowseTitle[] = savedOnly ? (savedTitles ?? []).filter((item) => item.title.toLocaleLowerCase().includes(normalizedQuery)) : feed.items;
  const loading = savedOnly ? savedTitles === null && !savedError : feed.loading;
  const error = savedOnly ? savedError : feed.error;
  const isSaved = (item: SearchResult, selection?: BrowseEpisodeSelection) => savedTitles?.some((entry) =>
    titleKey(entry) === titleKey(item) && (!selection || (
      entry.selection?.season === selection.season && entry.selection?.episode === selection.episode
    ))) ?? false;

  useEffect(() => {
    let active = true;
    setSavedError('');
    const pending = pendingSaves.get(profileId);
    const load = pending
      ? pending.catch(() => {}).then(() => listSavedBrowseTitles(profileId))
      : listSavedBrowseTitles(profileId);
    void load.then((titles) => {
      if (active) setSavedTitles(titles);
    }).catch(() => {
      if (active) setSavedError('Could not load your saved Browse titles.');
    });
    return () => { active = false; };
  }, [profileId, savedRetry]);

  const toggleSave = async (item: SearchResult, selection?: BrowseEpisodeSelection) => {
    if (pendingSaves.has(profileId) || !savedTitles) return;
    const add = !isSaved(item, selection);
    const savedTitle = selection ? { ...item, selection } : item;
    setSaving(true);
    try {
      const write = setSavedBrowseTitle(profileId, savedTitle, add);
      pendingSaves.set(profileId, write);
      await write;
      setSavedTitles((titles) => {
        const remaining = (titles ?? []).filter((entry) => titleKey(entry) !== titleKey(item));
        return add ? [savedTitle, ...remaining] : remaining;
      });
    } catch {
      useLibraryStore.getState().toast('Could not update your saved Browse titles. Try again.', 'error');
    } finally {
      pendingSaves.delete(profileId);
      setSaving(false);
    }
  };

  useEffect(() => { setSelected(null); }, [kind, list, query, savedOnly]);
  useEffect(() => {
    if (!browseEntry) return;
    setSelected(browseEntry);
    useLibraryStore.getState().clearBrowseEntry();
  }, [browseEntry]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || savedOnly || loading || error || selected || sourceOpen || !feed.page || feed.page >= feed.pages) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) feed.loadMore();
    }, { rootMargin: '0px 0px 320px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [savedOnly, loading, error, selected, sourceOpen, feed.page, feed.pages, feed.loadMore]);
  useEffect(() => () => cancelSourceBrowser(), []);

  const featured = savedOnly || !canDiscover || query.trim() ? [] : data.filter((item) => item.backdrop).slice(0, 5);
  const visibleFeed = savedOnly || canDiscover;
  return <div className="pb-20">
    {featured.length > 0 && <DiscoverHero
      key={`${profileId}:${kind}:${list}`}
      titles={featured}
      blocked={!!selected || sourceOpen}
      onSelect={(item) => setSelected({ item })}
    />}
    <section className={`relative z-10 flow-root px-[4%] ${featured.length ? '-mt-32' : 'pt-[108px]'}`}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="text-3xl font-bold">Browse</h2>
          <SegmentedControl ariaLabel="Browse view" size="sm" value={savedOnly}
            options={browseViews.map(({ label, saved }) => ({ value: saved, label, icon: saved ? <Bookmark aria-hidden="true" className="h-4 w-4" /> : undefined }))}
            onChange={(saved) => {
              if (savedOnly !== saved) { setSavedOnly(saved); setQuery(''); window.scrollTo({ top: 0 }); }
            }} />
        </div>
        <button className="nf-btn-ghost text-sm" onClick={() => setSourceOpen(true)}><ShieldCheck className="h-4 w-4" />{settings.browse_source_url ? 'Source settings' : 'Add torrent source'}<Settings2 className="h-4 w-4" /></button>
      </div>
      {!visibleFeed && <div>
        <p className="my-5 text-nf-secondary">Connect TMDB under Ratings &amp; Data in Settings to discover movies and TV shows.</p>
        <button className="nf-btn-red" onClick={() => useLibraryStore.getState().setSettingsOpen(true, 'ratings')}>Connect TMDB</button>
      </div>}
      {visibleFeed && <div className="mb-7 flex flex-wrap items-center gap-4">
        {savedOnly ? <p className="text-sm text-white/55">Movies and TV shows saved from Browse.</p> : <>
          <SegmentedControl ariaLabel="Title type" value={kind} onChange={setKind}
            options={[{ value: 'movie', label: 'Movies' }, { value: 'tv', label: 'TV shows' }]} />
          <Dropdown value={list} options={lists} onChange={setList} ariaLabel="Browse list" />
        </>}
        <SearchField className="ml-auto min-w-[220px]" inputClassName="w-60" ariaLabel="Search titles to browse" value={query} onChange={setQuery} placeholder={savedOnly ? 'Search saved titles' : kind === 'movie' ? 'Search movies' : 'Search TV shows'} />
      </div>}
      {visibleFeed && error && <div role="alert" className="mb-6 flex items-center gap-3 rounded border border-white/15 bg-white/5 p-4 text-sm text-white/70"><span>{!savedOnly && data.length ? (feed.page ? 'Could not load more titles. ' : 'Showing cached titles. ') : ''}{error}</span><button className="nf-btn-ghost ml-auto" onClick={savedOnly ? () => setSavedRetry((value) => value + 1) : feed.retry}><RefreshCw className="h-4 w-4" />Retry</button></div>}
      <div className="grid grid-cols-3 gap-x-4 gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {visibleFeed && data.map((item) => {
          const owned = items.find((entry) => entry.kind === item.kind && entry.tmdbId === item.id);
          const selection = savedOnly ? item.selection : undefined;
          const target = savedOnly && owned && !selection ? playTargetFor(owned, episodes) : null;
          const action = target && target.startTime > 0 ? 'Resume' : 'Play';
          const releaseDate = savedOnly ? upcomingDate(item.releaseDate) : null;
          return <div key={titleKey(item)} className="min-w-0">
            <button type="button" onClick={() => setSelected({ item, episode: selection })} className="group w-full min-w-0 text-left" aria-label={`View ${item.title}`}>
              <div className="relative overflow-hidden rounded-md bg-white/5 ring-white/70 transition duration-200 group-hover:-translate-y-1 group-hover:ring-2 group-focus-visible:ring-2">
                <Artwork key={item.poster} src={item.poster} alt={item.title} fallbackTitle={item.title} className="aspect-[2/3] w-full" />
                {owned && (!selection || episodes.get(owned.id)?.some((entry) => entry.season_number === selection.season && entry.episode_number === selection.episode)) && <span className="absolute bottom-2 left-2 rounded bg-black/85 px-2 py-1 text-[10px] font-semibold">In your library</span>}
              </div>
              <h3 className="mt-3 truncate text-sm font-semibold">{item.title}</h3>
              <p className="mt-1 text-xs text-white/60">{selection ? `Season ${selection.season} · Episode ${selection.episode}` : <>{releaseDate ? `Coming ${releaseDate}` : item.year ?? 'Coming soon'} · {item.kind === 'movie' ? 'Movie' : 'TV show'}</>}</p>
            </button>
            {target && owned && <button type="button" className="mt-2 inline-flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs font-medium hover:bg-white/20"
              aria-label={`${action} ${item.title}`} onClick={() => void playItem(owned)}><Play aria-hidden="true" className="h-3 w-3 fill-current" />{action}</button>}
          </div>;
        })}
      </div>
      {visibleFeed && loading && <LoadingState inline label="Loading titles…" className="justify-center py-12" />}
      {visibleFeed && !loading && !error && !data.length && <div className="py-20 text-center text-white/50">
        {savedOnly ? <Bookmark className="mx-auto mb-4 h-10 w-10" /> : <Film className="mx-auto mb-4 h-10 w-10" />}
        {savedOnly && !normalizedQuery ? 'Save a title from Browse to find it here.' : 'No titles found.'}
      </div>}
      {!savedOnly && <div ref={sentinel} aria-hidden="true" className="h-1" />}
    </section>
    {selected && <CatalogTitle key={titleKey(selected.item)} item={selected.item} initialEpisode={selected.episode} suspended={sourceOpen}
      save={{ isSaved: (selection) => isSaved(selected.item, selection), pending: savedTitles === null || saving, onToggle: (item, selection) => void toggleSave(item, selection) }}
      onClose={() => setSelected(null)} onSource={() => setSourceOpen(true)} />}
    {sourceOpen && <SourceSettings onClose={() => setSourceOpen(false)} />}
  </div>;
}

function SourceSettings({ onClose }: { onClose: () => void }) {
  const source = useLibraryStore((s) => s.settings.browse_source_url);
  const [url, setUrl] = useState(source);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    try {
      setSaving(true); setError('');
      const origin = url.trim() ? validateSourceUrl(url) : '';
      await useLibraryStore.getState().updateSettings({ browse_source_url: origin });
      cancelSourceBrowser(); onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  };
  return <Modal title="Torrent source" onClose={onClose}>
    <p className="mb-5 text-sm leading-relaxed text-white/60">Add your source website to search titles by IMDb ID. The browser session stays on this device.</p>
    <label className="mb-2 block text-sm" htmlFor="source-address">Website address</label>
    <input id="source-address" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-source.example" className="w-full rounded border border-white/20 bg-black/50 px-4 py-3 text-sm outline-none focus:border-white/60" />
    <p className="mt-4 flex items-center gap-2 text-xs text-white/55"><ShieldCheck className="h-4 w-4" />Ad and popup blocking is enabled automatically.</p>
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    <div className="mt-7 flex justify-end gap-3"><button className="nf-btn-ghost" onClick={onClose}>Cancel</button><button className="nf-btn-red" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save source'}</button></div>
  </Modal>;
}
