import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Film, Loader2, RefreshCw, Search, Settings2, ShieldCheck } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { getCatalog, type CatalogList, type SearchResult } from '../../services/tmdb';
import { cancelSourceBrowser, validateSourceUrl } from '../../services/browse';
import Dropdown from '../common/Dropdown';
import Artwork from '../common/Artwork';
import Modal from '../live/LiveDialog';
import CatalogTitle from './CatalogTitle';

const lists: { value: CatalogList; label: string }[] = [
  { value: 'trending', label: 'Trending this week' }, { value: 'popular', label: 'Popular' },
  { value: 'new', label: 'New releases' }, { value: 'top', label: 'Top rated' },
];
const cache = new Map<string, { items: SearchResult[]; pages: number; time: number }>();

export default function Discover() {
  const settings = useLibraryStore((s) => s.settings);
  const profile = useLibraryStore((s) => s.activeProfile);
  const items = useLibraryStore((s) => s.items);
  const [kind, setKind] = useState<'movie' | 'tv'>('movie');
  const [list, setList] = useState<CatalogList>('trending');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<SearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const request = useRef(0);
  const allowed = profile?.maturity === 'all';
  const key = `${kind}:${list}:${query.trim().toLowerCase()}:${page}`;
  useEffect(() => { setPage(1); setData([]); setSelected(null); }, [kind, list, query, profile?.id]);
  useEffect(() => {
    const seq = ++request.current;
    if (!allowed || !settings.tmdb_api_key) return;
    const saved = cache.get(key);
    setError(''); setStale(false);
    if (saved) { setData(saved.items); setPages(saved.pages); }
    setLoading(true);
    const timer = window.setTimeout(() => {
      if (saved && !refresh && Date.now() - saved.time < 15 * 60_000) { setLoading(false); return; }
      void getCatalog(kind, list, page, query).then((result) => {
        if (seq !== request.current) return;
        setData((previous) => {
          const combined = page === 1 ? result.items : [...previous, ...result.items];
          const next = [...new Map(combined.map((item) => [`${item.kind}:${item.id}`, item])).values()];
          cache.set(key, { items: next, pages: result.pages, time: Date.now() });
          if (cache.size > 30) cache.delete(cache.keys().next().value!);
          return next;
        });
        setPages(result.pages);
      }).catch((e) => {
        if (seq !== request.current) return;
        setStale(!!saved); setError(e instanceof Error ? e.message : String(e));
      }).finally(() => { if (seq === request.current) setLoading(false); });
    }, query.trim() ? 300 : 0);
    return () => { clearTimeout(timer); request.current++; };
  }, [key, refresh, settings.tmdb_api_key, allowed, profile?.id]);
  useEffect(() => () => cancelSourceBrowser(), [profile?.id]);

  if (!allowed) return <div className="px-[4%] pt-32"><h1 className="text-4xl font-bold">Browse</h1><p className="mt-5 text-nf-secondary">Switch to an unrestricted profile to browse titles and torrent sources.</p></div>;
  if (!settings.tmdb_api_key) return <div className="px-[4%] pt-32"><h1 className="text-4xl font-bold">Browse</h1><p className="my-5 text-nf-secondary">Connect TMDB in Settings to discover movies and TV shows.</p><button className="nf-btn-red" onClick={() => useLibraryStore.getState().setSettingsOpen(true, 'ratings')}>Connect TMDB</button></div>;
  const hero = !query.trim() ? data.find((d) => d.backdrop) : null;
  return <div className="pb-20 pt-[68px]">
    {hero && <section className="relative h-[48vh] min-h-[300px] max-h-[550px] overflow-hidden">
      <Artwork key={hero.backdrop} src={hero.backdrop} alt="" eager className="absolute inset-0 h-full w-full object-cover object-top" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-nf-bg via-transparent to-transparent" />
      <div className="absolute inset-x-[4%] bottom-12 max-w-2xl">
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-white/65">{lists.find((l) => l.value === list)?.label}</p>
        <h1 className="text-4xl font-bold md:text-6xl">{hero.title}</h1>
        <p className="mt-4 line-clamp-2 max-w-xl text-base text-white/80">{hero.overview}</p>
        <button className="nf-btn-play mt-5" onClick={() => setSelected(hero)}>View title <ArrowRight className="h-5 w-5" /></button>
      </div>
    </section>}
    <section className={`px-[4%] ${hero ? '' : 'pt-10'}`}>
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
      {error && <div role="alert" className="mb-6 flex items-center gap-3 rounded border border-white/15 bg-white/5 p-4 text-sm text-white/70"><span>{stale ? 'Showing saved results. ' : ''}{error}</span><button className="nf-btn-ghost ml-auto" onClick={() => setRefresh((v) => v + 1)}><RefreshCw className="h-4 w-4" />Retry</button></div>}
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
      {!loading && page < pages && data.length > 0 && <div className="mt-10 text-center"><button className="nf-btn-ghost" onClick={() => setPage((p) => p + 1)}>Show more</button></div>}
      <p className="mt-12 text-xs text-white/35">Discovery and popularity lists provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
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
    <p className="mb-5 text-sm leading-relaxed text-white/60">Add your source website to search titles by IMDb ID. EXT-compatible websites are supported. Its browser session stays on this device.</p>
    <label className="mb-2 block text-sm" htmlFor="source-address">Website address</label>
    <input id="source-address" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-source.example" className="w-full rounded border border-white/20 bg-black/50 px-4 py-3 text-sm outline-none focus:border-white/60" />
    <p className="mt-4 flex items-center gap-2 text-xs text-white/55"><ShieldCheck className="h-4 w-4" />Ad and popup blocking is enabled automatically.</p>
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    <div className="mt-7 flex justify-end gap-3"><button className="nf-btn-ghost" onClick={onClose}>Cancel</button><button className="nf-btn-red" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save source'}</button></div>
  </Modal>;
}
