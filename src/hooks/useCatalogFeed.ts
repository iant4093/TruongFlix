import { useCallback, useEffect, useRef, useState } from 'react';
import { getCatalog, type CatalogList, type SearchResult } from '../services/tmdb';

type Page = Awaited<ReturnType<typeof getCatalog>>;
const cache = new Map<string, Page & { time: number }>();
let cacheKey = '';
interface Feed { scope: string; items: SearchResult[]; page: number; pages: number; loading: boolean; error: string }
interface Cursor { scope: string; page: number; pages: number; pending: boolean; failedPage: number }

export default function useCatalogFeed(kind: 'movie' | 'tv', list: CatalogList, query: string, apiKey: string, profileId: number | undefined, allowed: boolean) {
  const scope = JSON.stringify([kind, list, query.trim().toLowerCase(), profileId, allowed]);
  const cursor = useRef<Cursor | null>(null);
  const [feed, setFeed] = useState<Feed>({ scope: '', items: [], page: 0, pages: 1, loading: true, error: '' });
  const load = useCallback(async (page: number, force = false) => {
    const current = cursor.current;
    if (!allowed || !apiKey || !current || current.scope !== scope || current.pending) return;
    current.pending = true;
    setFeed((f) => ({ ...f, loading: true, error: '' }));
    try {
      const key = JSON.stringify([kind, list, query.trim().toLowerCase(), page]);
      const saved = cache.get(key);
      const result = !force && saved && Date.now() - saved.time < 15 * 60_000 ? saved : await getCatalog(kind, list, page, query);
      if (cursor.current !== current) return;
      cache.set(key, { ...result, time: result === saved ? saved.time : Date.now() });
      if (cache.size > 30) cache.delete(cache.keys().next().value!);
      current.page = page;
      current.pages = result.items.length ? result.pages : page;
      current.failedPage = 0;
      setFeed((f) => ({ scope, items: [...new Map((page === 1 ? result.items : [...f.items, ...result.items]).map((item) => [`${item.kind}:${item.id}`, item])).values()],
        page, pages: current.pages, loading: false, error: '' }));
    } catch (e) {
      if (cursor.current !== current) return;
      current.failedPage = page;
      setFeed((f) => ({ ...f, loading: false, error: e instanceof Error ? e.message : String(e) }));
    } finally { if (cursor.current === current) current.pending = false; }
  }, [kind, list, query, apiKey, scope, allowed]);
  useEffect(() => {
    if (cacheKey !== apiKey) { cache.clear(); cacheKey = apiKey; }
    const current: Cursor = { scope, page: 0, pages: 1, pending: false, failedPage: 0 };
    cursor.current = current;
    const saved = allowed && apiKey ? cache.get(JSON.stringify([kind, list, query.trim().toLowerCase(), 1])) : null;
    setFeed({ scope, items: saved?.items ?? [], page: 0, pages: saved?.pages ?? 1, loading: allowed && !!apiKey, error: '' });
    const timer = window.setTimeout(() => void load(1), query.trim() ? 300 : 0);
    return () => { clearTimeout(timer); if (cursor.current === current) cursor.current = null; };
  }, [load, scope, apiKey]);
  const loadMore = useCallback(() => {
    const current = cursor.current;
    if (current && current.scope === scope && current.page > 0 && current.page < current.pages && !current.failedPage) void load(current.page + 1);
  }, [load, scope]);
  const retry = useCallback(() => { const current = cursor.current; if (current?.failedPage) void load(current.failedPage, true); }, [load]);
  return { ...(feed.scope === scope ? feed : { scope, items: [], page: 0, pages: 1, loading: true, error: '' }), loadMore, retry };
}
