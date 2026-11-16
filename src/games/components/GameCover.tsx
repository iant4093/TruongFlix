import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Gamepad2 } from 'lucide-react';
import { FadeImage } from '../../components/common/Artwork';

const cache = new Map<string, Promise<string | null>>();

/** Source artwork is downloaded once and shown from disk (the app's CSP blocks remote hosts). */
export function cachedImage(url: string | null | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  let pending = cache.get(url);
  if (!pending) {
    pending = invoke<string>('games_cache_image', { url }).then(convertFileSrc).catch(() => null);
    cache.set(url, pending);
    pending.then((src) => { if (!src) cache.delete(url); });
  }
  return pending;
}

/** The local file for remote artwork, and whether resolving it has finished. */
export function useCachedImageStatus(url: string | null | undefined, fallbackUrl?: string | null) {
  const key = `${url ?? ''}\n${fallbackUrl ?? ''}`;
  const [state, setState] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    void cachedImage(url).then((resolved) => resolved ?? cachedImage(fallbackUrl)).then((resolved) => {
      if (active) setState({ key, src: resolved });
    });
    return () => { active = false; };
  }, [url, fallbackUrl, key]);
  const current = state?.key === key ? state : null;
  return { src: current?.src ?? null, settled: !!current };
}

/**
 * Several images, cached in order; each appears as soon as it's on disk (for cycling hover stills).
 * `limit` caps how many are fetched.
 */
export function useCachedImages(urls: string[], limit = 6): string[] {
  const key = urls.slice(0, limit).join('\n');
  const [state, setState] = useState<{ key: string; list: (string | null)[] }>({ key: '', list: [] });
  useEffect(() => {
    const wanted = key ? key.split('\n') : [];
    setState({ key, list: wanted.map(() => null) });
    let active = true;
    wanted.forEach((url, i) => {
      void cachedImage(url).then((src) => {
        if (!active || !src) return;
        setState((prev) => (prev.key !== key ? prev : { key, list: prev.list.map((v, j) => (j === i ? src : v)) }));
      });
    });
    return () => { active = false; };
  }, [key]);
  return state.key === key ? state.list.filter((v): v is string => !!v) : [];
}

export function useCachedImage(url: string | null | undefined, fallbackUrl?: string | null) {
  return useCachedImageStatus(url, fallbackUrl).src;
}

export default function GameCover({ url, title, className = '' }: { url: string | null; title: string; className?: string }) {
  const { src: resolved, settled } = useCachedImageStatus(url);
  const [failed, setFailed] = useState<string | null>(null);
  const src = resolved && failed !== resolved ? resolved : null;
  // Until the cached file resolves, only the tile shows, so the title never flashes before the art.
  const pending = !!url && !settled;
  return <div className={`relative overflow-hidden bg-gradient-to-br from-white/10 to-white/[0.02] ${className}`}>
    {src
      ? <FadeImage src={src} alt={title} eager onError={() => setFailed(src)} className="absolute inset-0 h-full w-full" />
      : !pending && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
        <Gamepad2 aria-hidden="true" className="h-7 w-7 text-white/30" />
        <span className="line-clamp-3 text-xs font-semibold text-white/70">{title}</span>
      </div>}
  </div>;
}
