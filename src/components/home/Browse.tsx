import { useMemo } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import type { MediaItem } from '../../types/media';
import { useLibraryStore, type View } from '../../store/useLibraryStore';
import { continueWatching, genreBuckets, seededShuffle } from '../../store/selectors';
import { runScan } from '../../services/scanner';
import HeroBillboard from './HeroBillboard';
import MediaCard from './MediaCard';
import MediaRow, { useItemsPerRow, type RowEntry } from './MediaRow';
import Top10Row from './Top10Row';

const SESSION_SEED = Math.floor(Math.random() * 100000);
const PRIORITY_GENRES = ['Action & Adventure', 'Sci-Fi', 'Drama', 'Comedy'];
const wrap = (items: MediaItem[]): RowEntry[] => items.map((item) => ({ item }));
const byNewest = (a: MediaItem, b: MediaItem) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;

function pickFeatured(items: MediaItem[], seed: number): MediaItem | null {
  const withArt = items.filter((i) => i.backdrop && i.overview);
  const withLogo = withArt.filter((i) => i.logo);
  const pool = withLogo.length ? withLogo : withArt.length ? withArt : items;
  if (!pool.length) return null;
  return seededShuffle(pool, seed)[0];
}

function EmptyLibrary() {
  const scan = useLibraryStore((s) => s.scan);
  const openSettings = useLibraryStore((s) => s.setSettingsOpen);
  const dirs = useLibraryStore((s) => s.settings.media_directories);
  return (
    <section className="relative flex h-[85vh] min-h-[520px] items-center overflow-hidden px-[4%]">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(229,9,20,0.25),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(229,9,20,0.12),transparent_50%)]" />
      <div className="relative max-w-xl space-y-5">
        <h1 className="text-5xl font-black leading-tight">
          {scan.running ? 'Building your library…' : 'Your library is empty'}
        </h1>
        <p className="text-lg text-nf-secondary">
          {scan.running
            ? `Matching ${scan.total || ''} files with TMDB. Titles will appear here as they are identified.`
            : dirs.length
              ? 'Scan your media folders to fetch posters, logos and metadata for every movie and episode.'
              : 'Add the folders where your movies and TV shows live, then scan to build your TruongFlix library.'}
        </p>
        <div className="flex gap-3">
          <button onClick={() => runScan()} disabled={scan.running || !dirs.length} className="nf-btn-play text-lg disabled:opacity-50">
            <RefreshCw className={`h-6 w-6 ${scan.running ? 'animate-spin' : ''}`} />
            Scan Library
          </button>
          <button onClick={() => openSettings(true, 'library')} className="nf-btn-info text-lg">
            <FolderOpen className="h-6 w-6" />
            Media Folders
          </button>
        </div>
      </div>
    </section>
  );
}

/** Home / TV Shows / Movies pages: hero billboard + Netflix rows. */
export function BrowseView({ view }: { view: Extract<View, 'home' | 'tv' | 'movies'> }) {
  const allItems = useLibraryStore((s) => s.items);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const imdbEnabled = useLibraryStore((s) => s.settings.imdb_enabled);
  const collections = useLibraryStore((s) => s.collections);

  const items = useMemo(
    () => (view === 'home' ? allItems : allItems.filter((i) => i.kind === (view === 'tv' ? 'tv' : 'movie'))),
    [allItems, view],
  );

  const featured = useMemo(() => pickFeatured(items, SESSION_SEED + view.length), [items, view]);

  const rows = useMemo(() => {
    const out: { title: string; entries: RowEntry[]; top10?: MediaItem[] }[] = [];
    const noun = view === 'tv' ? 'TV Shows' : view === 'movies' ? 'Movies' : '';

    const cw = continueWatching(items, episodesBySeries);
    out.push({ title: 'Continue Watching for You', entries: cw.map((entry) => ({ item: entry.item, entry })) });
    out.push({ title: view === 'home' ? 'Recently Added' : `New ${noun} in Your Library`, entries: wrap([...items].sort(byNewest).slice(0, 24)) });

    const score = (i: MediaItem) => (imdbEnabled && i.imdbRating != null ? i.imdbRating : i.voteAverage);
    const rated = items.filter((i) => i.matched && score(i) > 0).sort((a, b) => score(b) - score(a));
    const usesImdb = imdbEnabled && rated.slice(0, 10).some((i) => i.imdbRating != null);
    if (rated.length >= 3) {
      out.push({
        title:
          (view === 'home' ? 'Top 10 Highest Rated in Your Library' : `Top 10 ${noun} in Your Library`) +
          (usesImdb ? ' on IMDb' : ''),
        entries: [],
        top10: rated.slice(0, 10),
      });
    }

    if (view === 'home') {
      const myList = items.filter((i) => i.myList);
      out.push({ title: 'My List', entries: wrap(myList) });
      out.push({ title: 'TV Shows', entries: wrap(seededShuffle(items.filter((i) => i.kind === 'tv'), SESSION_SEED + 1)) });
      out.push({ title: 'Movies', entries: wrap(seededShuffle(items.filter((i) => i.kind === 'movie'), SESSION_SEED + 2)) });
    }

    // Franchise rows ("The Matrix Collection") in watch order, when you own at least two films.
    if (view !== 'tv') {
      const byCollection = new Map<number, MediaItem[]>();
      for (const i of items) if (i.kind === 'movie' && i.collectionId) byCollection.set(i.collectionId, [...(byCollection.get(i.collectionId) ?? []), i]);
      const groups = [...byCollection.entries()].filter(([, list]) => list.length >= 2);
      groups.sort((a, b) => b[1].length - a[1].length);
      for (const [id, list] of groups.slice(0, 6)) {
        const c = collections.find((x) => x.id === id);
        let order: number[] = [];
        try {
          order = c?.parts ? (JSON.parse(c.parts) as { tmdb_id: number }[]).map((p) => p.tmdb_id) : [];
        } catch {
          /* fall back to release year */
        }
        const rank = (i: MediaItem) => {
          const at = order.indexOf(i.tmdbId ?? -1);
          return at >= 0 ? at : 1000 + (i.year ?? 0);
        };
        out.push({ title: c?.name ?? list[0].collectionName ?? 'Collection', entries: wrap([...list].sort((a, b) => rank(a) - rank(b))) });
      }
    }

    // Dynamic genre rows, with Netflix's staple categories first.
    const genreMap = new Map<string, MediaItem[]>();
    for (const item of items)
      for (const g of genreBuckets(item.genres)) {
        const list = genreMap.get(g);
        if (list) list.push(item);
        else genreMap.set(g, [item]);
      }
    const minCount = items.length > 30 ? 3 : 1;
    const genreNames = [...genreMap.keys()]
      .filter((g) => genreMap.get(g)!.length >= minCount)
      .sort((a, b) => {
        const pa = PRIORITY_GENRES.indexOf(a);
        const pb = PRIORITY_GENRES.indexOf(b);
        if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        return genreMap.get(b)!.length - genreMap.get(a)!.length;
      })
      .slice(0, 12);

    const uhd = items.filter((i) => i.tech.resolution === '4K' || i.tech.hdr_format);
    genreNames.forEach((g, idx) => {
      out.push({ title: noun ? `${g} ${noun}` : g, entries: wrap(seededShuffle(genreMap.get(g)!, SESSION_SEED + idx + 10)) });
      if (idx === 1) out.push({ title: '4K Ultra HD & HDR Collection', entries: wrap(uhd) });
    });
    if (genreNames.length < 2) out.push({ title: '4K Ultra HD & HDR Collection', entries: wrap(uhd) });

    out.push({ title: 'Unidentified Files · Fix Match', entries: wrap(items.filter((i) => !i.matched)) });
    return out.filter((r) => r.entries.length || r.top10?.length);
  }, [items, episodesBySeries, view, imdbEnabled, collections]);

  if (!items.length) return <EmptyLibrary />;

  return (
    <>
      {featured && <HeroBillboard key={featured.key} item={featured} />}
      <div className={`relative z-10 flow-root pb-16 ${featured ? '-mt-32' : 'pt-24'}`}>
        {rows.map((r) =>
          r.top10 ? <Top10Row key={r.title} title={r.title} items={r.top10} /> : <MediaRow key={r.title} title={r.title} entries={r.entries} />,
        )}
      </div>
    </>
  );
}

/** Grid layout used by My List and Search. */
export function GridView({ title, items, empty }: { title: string; items: MediaItem[]; empty: string }) {
  const perRow = useItemsPerRow();
  return (
    <div className="min-h-screen px-[4%] pb-16 pt-28">
      <h1 className="mb-6 text-[clamp(1.4rem,2.2vw,2.2rem)] font-semibold text-white">{title}</h1>
      {items.length ? (
        <div className="grid gap-x-[0.4vw] gap-y-[3.5vw]" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}>
          {items.map((item) => (
            <MediaCard key={item.key} item={item} />
          ))}
        </div>
      ) : (
        <p className="pt-10 text-center text-lg text-nf-secondary">{empty}</p>
      )}
    </div>
  );
}

export function MyListView() {
  const items = useLibraryStore((s) => s.items);
  const list = useMemo(() => items.filter((i) => i.myList).sort((a, b) => a.title.localeCompare(b.title)), [items]);
  return <GridView title="My List" items={list} empty="You haven’t added any titles to your list yet. Hover a title and press +." />;
}

export function SearchView({ query }: { query: string }) {
  const items = useLibraryStore((s) => s.items);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const score = (i: MediaItem) => {
      const t = i.title.toLowerCase();
      if (t === q) return 100;
      if (t.startsWith(q)) return 80;
      if (t.includes(q)) return 60;
      if (i.cast.some((c) => c.name.toLowerCase().includes(q))) return 40;
      if (i.genres.some((g) => g.toLowerCase().includes(q))) return 30;
      if (String(i.year ?? '') === q) return 20;
      if (i.overview.toLowerCase().includes(q)) return 10;
      return 0;
    };
    return items
      .map((i) => [i, score(i)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[0].title.localeCompare(b[0].title))
      .map(([i]) => i);
  }, [items, query]);
  return (
    <GridView
      title={`Results for “${query}”`}
      items={results}
      empty={`Your search for “${query}” did not have any matches in your library.`}
    />
  );
}
