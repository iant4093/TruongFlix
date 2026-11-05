import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, RefreshCw, Search, Settings2, ShieldCheck } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import type { CatalogList, SearchResult } from '../../services/tmdb';
import useCatalogFeed from '../../hooks/useCatalogFeed';
import { cancelSourceBrowser, validateSourceUrl } from '../../services/browse';
import Dropdown from '../common/Dropdown';
import Artwork from '../common/Artwork';
import Modal from '../live/LiveDialog';
import CatalogTitle from './CatalogTitle';
import DiscoverHero from './DiscoverHero';

const lists: { value: CatalogList; label: string }[] = [
  { value: 'trending', label: 'Trending this week' }, { value: 'popular', label: 'Popular' },
  { value: 'new', label: 'New releases' }, { value: 'top', label: 'Top rated' },
];

export default function Discover() {
  const settings = useLibraryStore((s) => s.settings);
  const profile = useLibraryStore((s) => s.activeProfile);
  const profileGate = useLibraryStore((s) => s.profileGate);
  const items = useLibraryStore((s) => s.items);
  const [kind, setKind] = useState<'movie' | 'tv'>('movie');
  const [list, setList] = useState<CatalogList>('trending');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const allowed = profile?.maturity === 'all' && !profileGate;
  const feed = useCatalogFeed(kind, list, query, settings.tmdb_api_key, profile?.id, allowed);
  const { items: data, loading, error } = feed;
  useEffect(() => { setSelected(null); }, [kind, list, query, profile?.id]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !allowed || loading || error || selected || sourceOpen || !feed.page || feed.page >= feed.pages) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) feed.loadMore();
    }, { rootMargin: '0px 0px 320px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [allowed, loading, error, selected, sourceOpen, feed.page, feed.pages, feed.loadMore]);
  useEffect(() => () => cancelSourceBrowser(), [profile?.id, profileGate]);
  useEffect(() => { if (!allowed) { setSelected(null); setSourceOpen(false); } }, [allowed]);

  if (!allowed) return <div className="px-[4%] pt-32"><h1 className="text-4xl font-bold">Browse</h1><p className="mt-5 text-nf-secondary">Switch to an unrestricted profile to browse titles and torrent sources.</p></div>;
  if (!settings.tmdb_api_key) return <div className="px-[4%] pt-32"><h1 className="text-4xl font-bold">Browse</h1><p className="my-5 text-nf-secondary">Connect TMDB in Settings to discover movies and TV shows.</p><button className="nf-btn-red" onClick={() => useLibraryStore.getState().setSettingsOpen(true, 'ratings')}>Connect TMDB</button></div>;
  const featured = query.trim() ? [] : data.filter((item) => item.backdrop).slice(0, 5);
  return <div className="pb-20">
    {featured.length > 0 && <DiscoverHero
      key={`${profile.id}:${kind}:${list}`}
      titles={featured}
      label={lists.find((option) => option.value === list)!.label}
      blocked={!!selected || sourceOpen}
      onSelect={setSelected}
    />}
    <section className={`relative z-10 flow-root px-[4%] ${featured.length ? '-mt-32' : 'pt-[108px]'}`}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-3xl font-bold">Browse</h2>
        <button className="nf-btn-ghost text-sm" onClick={() => setSourceOpen(true)}><ShieldCheck className="h-4 w-4" />{settings.browse_source_url ? 'Source settings' : 'Add torrent source'}<Settings2 className="h-4 w-4" /></button>
      </div>
      <div className="mb-7 flex flex-wrap items-center gap-4">
        <div className="flex rounded border border-white/20 bg-black/30 p-1" aria-label="Title type">
          {(['movie', 'tv'] as const).map((v) => <button key={v} aria-pressed={kind === v} onClick={() => setKind(v)} className={`rounded px-5 py-2 text-sm font-medium ${kind === v ? 'bg-white text-black' : 'text-white/65 hover:text-white'}`}>{v === 'movie' ? 'Movies' : 'TV Shows'}</button>)}
        </div>
        <Dropdown value={list} options={lists} onChange={setList} ariaLabel="Browse list" />
        <label className="ml-auto flex min-w-[220px] items-center gap-2 rounded border border-white/25 bg-black/40 px-3 py-2.5"><Search className="h-4 w-4 text-white/60" /><input aria-label="Search titles to browse" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search movies and TV shows" className="w-60 bg-transparent text-sm outline-none placeholder:text-white/40" /></label>
      </div>
      {error && <div role="alert" className="mb-6 flex items-center gap-3 rounded border border-white/15 bg-white/5 p-4 text-sm text-white/70"><span>{data.length ? (feed.page ? 'Could not load more titles. ' : 'Showing saved titles. ') : ''}{error}</span><button className="nf-btn-ghost ml-auto" onClick={feed.retry}><RefreshCw className="h-4 w-4" />Retry</button></div>}
      <div className="grid grid-cols-3 gap-x-4 gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {data.map((item) => <button key={`${item.kind}:${item.id}`} onClick={() => setSelected(item)} className="group min-w-0 text-left" aria-label={`View ${item.title}`}>
          <div className="relative overflow-hidden rounded-md bg-white/5 ring-white/70 transition duration-200 group-hover:-translate-y-1 group-hover:ring-2 group-focus-visible:ring-2">
            <Artwork key={item.poster} src={item.poster} alt={item.title} fallbackTitle={item.title} className="aspect-[2/3] w-full" />
            {items.some((i) => i.kind === item.kind && i.tmdbId === item.id) && <span className="absolute bottom-2 left-2 rounded bg-black/85 px-2 py-1 text-[10px] font-semibold">In your library</span>}
          </div>
          <h3 className="mt-3 truncate text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-white/45">{item.year ?? 'Coming soon'} · {item.kind === 'movie' ? 'Movie' : 'TV Show'}</p>
        </button>)}
      </div>
      {loading && <div role="status" className="flex justify-center gap-3 py-12 text-white/60"><Loader2 className="h-5 w-5 animate-spin" />Loading titles…</div>}
      {!loading && !error && !data.length && <div className="py-20 text-center text-white/50"><Film className="mx-auto mb-4 h-10 w-10" />No titles found.</div>}
      <div ref={sentinel} aria-hidden="true" className="h-1" />
    </section>
    {selected && <CatalogTitle key={`${profile?.id}:${selected.kind}:${selected.id}`} item={selected} suspended={sourceOpen} onClose={() => setSelected(null)} onSource={() => setSourceOpen(true)} />}
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
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
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
