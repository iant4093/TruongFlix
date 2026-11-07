import { useCallback, useEffect, useRef, useState } from 'react';
import { getCatalog, type CatalogList, type SearchResult } from '../services/tmdb';
import { errorMessage } from '../lib/errors';

type Page = Awaited<ReturnType<typeof getCatalog>>;
const cache = new Map<string, Page & { time: number }>();
let cacheKey = '';
const FRESH_MS = 15 * 60_000;
/** `stale`: the items are the previous list's, kept on screen until the new one arrives. */
interface Feed { scope: string; items: SearchResult[]; page: number; pages: number; loading: boolean; error: string; stale: boolean }
interface Cursor { scope: string; page: number; pages: number; pending: boolean; failedPage: number }

const dedupe = (items: SearchResult[]) => [...new Map(items.map((item) => [`${item.kind}:${item.id}`, item])).values()];

export default function useCatalogFeed(kind: 'movie' | 'tv', list: CatalogList, query: string, apiKey: string, profileId: number | undefined, allowed: boolean) {
  const scope = JSON.stringify([kind, list, query.trim().toLowerCase(), profileId, allowed]);
  const cursor = useRef<Cursor | null>(null);
  const [feed, setFeed] = useState<Feed>({ scope: '', items: [], page: 0, pages: 1, loading: true, error: '', stale: false });
  const pageKey = useCallback((page: number) => JSON.stringify([kind, list, query.trim().toLowerCase(), page]), [kind, list, query]);
  const load = useCallback(async (page: number, force = false) => {
    const current = cursor.current;
    if (!allowed || !apiKey || !current || current.scope !== scope || current.pending) return;
    current.pending = true;
    setFeed((f) => ({ ...f, loading: true, error: '' }));
    try {
      const key = pageKey(page);
      const saved = cache.get(key);
      const result = !force && saved && Date.now() - saved.time < FRESH_MS ? saved : await getCatalog(kind, list, page, query);
      if (cursor.current !== current) return;
      cache.set(key, { ...result, time: result === saved ? saved.time : Date.now() });
      if (cache.size > 30) cache.delete(cache.keys().next().value!);
      current.page = page;
      current.pages = result.items.length ? result.pages : page;
      current.failedPage = 0;
      setFeed((f) => ({ scope, items: dedupe(page === 1 ? result.items : [...f.items, ...result.items]),
        page, pages: current.pages, loading: false, error: '', stale: false }));
    } catch (e) {
      if (cursor.current !== current) return;
      current.failedPage = page;
      // Never leave the previous list's titles up under an error for this one.
      setFeed((f) => ({ ...f, scope, items: f.stale ? [] : f.items, loading: false, error: errorMessage(e), stale: false }));
    } finally { if (cursor.current === current) current.pending = false; }
  }, [kind, list, query, apiKey, scope, allowed, pageKey]);
  useEffect(() => {
    if (cacheKey !== apiKey) { cache.clear(); cacheKey = apiKey; }
    const current: Cursor = { scope, page: 0, pages: 1, pending: false, failedPage: 0 };
    cursor.current = current;
    const enabled = allowed && !!apiKey;
    const first = enabled ? cache.get(pageKey(1)) : undefined;
    if (first && Date.now() - first.time < FRESH_MS) {
      // Fresh pages already seen (coming back to Browse) are restored together, so the grid
      // and the scroll position come back exactly as they were.
      let items = first.items;
      let page = 1;
      let pages = first.items.length ? first.pages : 1;
      for (let next = cache.get(pageKey(2)); next && page < pages && Date.now() - next.time < FRESH_MS; next = cache.get(pageKey(page + 1))) {
        items = [...items, ...next.items];
        page += 1;
        pages = next.items.length ? next.pages : page;
      }
      current.page = page;
      current.pages = pages;
      setFeed({ scope, items: dedupe(items), page, pages, loading: false, error: '', stale: false });
      return () => { if (cursor.current === current) cursor.current = null; };
    }
    // Keep the previous titles visible (marked stale) until this list arrives, unless a cached copy can show now.
    setFeed((f) => first
      ? { scope, items: first.items, page: 0, pages: first.pages, loading: enabled, error: '', stale: false }
      : { scope, items: enabled ? f.items : [], page: 0, pages: 1, loading: enabled, error: '', stale: enabled && f.items.length > 0 });
    const timer = window.setTimeout(() => void load(1), query.trim() ? 300 : 0);
    return () => { clearTimeout(timer); if (cursor.current === current) cursor.current = null; };
  }, [load, scope, apiKey]);
  const loadMore = useCallback(() => {
    const current = cursor.current;
    if (current && current.scope === scope && current.page > 0 && current.page < current.pages && !current.failedPage) void load(current.page + 1);
  }, [load, scope]);
  const retry = useCallback(() => { const current = cursor.current; if (current?.failedPage) void load(current.failedPage, true); }, [load]);
  // Before the effect for a new scope runs, show the previous titles as stale rather than an empty grid.
  const view: Feed = feed.scope === scope ? feed : { ...feed, scope, page: 0, pages: 1, loading: true, error: '', stale: feed.items.length > 0 };
  return { ...view, loadMore, retry };
}
