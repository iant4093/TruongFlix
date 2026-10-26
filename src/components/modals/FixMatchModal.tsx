import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Search, Star, X } from 'lucide-react';
import { selectItem, useLibraryStore } from '../../store/useLibraryStore';
import { applyFixMatch, runImdbSync } from '../../services/scanner';
import { searchTitles, type SearchResult } from '../../services/tmdb';
import Artwork from '../common/Artwork';

/** Manual TMDB override for files the parser/matcher got wrong. */
export default function FixMatchModal() {
  const fixKey = useLibraryStore((s) => s.fixMatchKey);
  const liveItem = useLibraryStore(selectItem(fixKey));
  const lastItem = useRef(liveItem);
  if (liveItem) lastItem.current = liveItem;
  const item = liveItem ?? lastItem.current;
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const openFixMatch = useLibraryStore((s) => s.openFixMatch);
  const detailKey = useLibraryStore((s) => s.detailKey);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const toast = useLibraryStore((s) => s.toast);

  const [query, setQuery] = useState(item?.title ?? '');
  const [year, setYear] = useState(item?.year ? String(item.year) : '');
  const [kind, setKind] = useState<'movie' | 'tv'>(item?.kind ?? 'movie');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const y = /^\d{4}$/.test(year.trim()) ? parseInt(year, 10) : null;
        const r = await searchTitles(kind, q, y);
        if (!cancelled) {
          setResults(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, year, kind]);

  if (!item) return null;

  const eps = item.kind === 'tv' ? (episodesBySeries.get(item.id) ?? []) : [];
  const paths = item.kind === 'movie' ? [item.filePath ?? ''] : eps.map((e) => e.file_path);

  const choose = async (r: SearchResult) => {
    setApplying(r.id);
    try {
      const newKey = await applyFixMatch(item, r);
      toast(`Matched to “${r.title}${r.year ? ` (${r.year})` : ''}”`, 'success');
      openFixMatch(null);
      if (detailKey) openDetail(newKey);
      void runImdbSync();
    } catch (e) {
      toast(`Fix Match failed: ${String(e instanceof Error ? e.message : e)}`, 'error');
    } finally {
      setApplying(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => e.target === e.currentTarget && openFixMatch(null)}
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/75 px-4 py-12 backdrop-blur-xs"
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ duration: 0.22 }}
        className="w-full max-w-2xl overflow-hidden rounded-xl bg-nf-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-7 py-5">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold">Fix Match</h2>
            <p className="mt-0.5 text-sm text-nf-secondary">
              Currently matched as <span className="font-semibold text-white">{item.title}</span>
              {item.year ? ` (${item.year})` : ''} · {item.kind === 'movie' ? 'Movie' : 'TV Series'}
            </p>
          </div>
          <button onClick={() => openFixMatch(null)} className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-7 py-5">
          <div className="selectable max-h-24 overflow-y-auto rounded bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-nf-secondary">
            {paths.slice(0, 6).map((p) => (
              <div key={p} className="break-all">
                {p}
              </div>
            ))}
            {paths.length > 6 && <div className="text-nf-muted">…and {paths.length - 6} more files</div>}
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-nf-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search TMDB…"
                className="nf-input pl-10"
              />
            </div>
            <input
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="Year"
              className="nf-input w-24 text-center"
            />
            <div className="flex rounded border border-[#5a5a5a] p-1">
              {(['movie', 'tv'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`rounded-sm px-3 text-sm font-semibold transition-colors ${
                    kind === k ? 'bg-white text-black' : 'text-nf-secondary hover:text-white'
                  }`}
                >
                  {k === 'movie' ? 'Movie' : 'TV'}
                </button>
              ))}
            </div>
          </div>
          {kind !== item.kind && (
            <p className="text-xs text-nf-secondary">
              {kind === 'tv'
                ? 'Converting to a TV series: season/episode numbers are read from the filename (defaults to S1E1).'
                : 'Converting to a movie: every episode file in this series will become this movie.'}
            </p>
          )}
        </div>

        <div className="max-h-[52vh] min-h-[160px] overflow-y-auto px-4 pb-5">
          {loading && !results.length && (
            <div className="flex justify-center py-10">
              <Loader2 className="h-7 w-7 animate-spin text-nf-red" />
            </div>
          )}
          {error && <p className="px-3 py-6 text-center text-sm text-nf-red">{error}</p>}
          {!loading && !error && query.trim() && !results.length && (
            <p className="px-3 py-10 text-center text-sm text-nf-secondary">No results. Try a different title, year, or type.</p>
          )}
          {results.map((r) => {
            const current = r.id === item.tmdbId && r.kind === item.kind;
            return (
              <button
                key={`${r.kind}-${r.id}`}
                disabled={applying != null}
                onClick={() => choose(r)}
                className={`flex w-full items-start gap-4 rounded-md px-3 py-3 text-left transition-colors hover:bg-white/10 disabled:cursor-wait ${
                  current ? 'bg-white/5 ring-1 ring-inset ring-nf-green/60' : ''
                }`}
              >
                <div className="relative aspect-[2/3] w-[64px] shrink-0 overflow-hidden rounded">
                  <Artwork src={r.poster} alt={r.title} className="h-full w-full" />
                  {applying === r.id && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{r.title}</span>
                    {r.year && <span className="shrink-0 text-sm text-nf-secondary">{r.year}</span>}
                    {current && <span className="shrink-0 text-[11px] font-semibold uppercase text-nf-green">Current</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-xs text-nf-muted">
                    <Star className="h-3 w-3 fill-current" />
                    {r.voteAverage ? r.voteAverage.toFixed(1) : '–'} · TMDB #{r.id}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-nf-secondary">{r.overview || 'No overview.'}</p>
                </div>
              </button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}
