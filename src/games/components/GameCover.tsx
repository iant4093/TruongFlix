import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Gamepad2 } from 'lucide-react';

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

export function useCachedImage(url: string | null | undefined, fallbackUrl?: string | null) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    void cachedImage(url).then((resolved) => resolved ?? cachedImage(fallbackUrl)).then((resolved) => {
      if (active) setSrc(resolved);
    });
    return () => { active = false; };
  }, [url, fallbackUrl]);
  return src;
}

export default function GameCover({ url, title, className = '' }: { url: string | null; title: string; className?: string }) {
  const src = useCachedImage(url);
  const [failed, setFailed] = useState(false);
  return <div className={`relative overflow-hidden bg-gradient-to-br from-white/10 to-white/[0.02] ${className}`}>
    {src && !failed
      ? <img src={src} alt={title} draggable={false} onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
      : <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
        <Gamepad2 aria-hidden="true" className="h-7 w-7 text-white/30" />
        <span className="line-clamp-3 text-xs font-semibold text-white/70">{title}</span>
      </div>}
  </div>;
}
