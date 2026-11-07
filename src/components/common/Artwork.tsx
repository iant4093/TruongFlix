import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Film } from 'lucide-react';

interface FadeImageProps {
  src: string;
  alt: string;
  className?: string;
  eager?: boolean;
  onError?: () => void;
  fit?: 'cover' | 'contain';
}

/**
 * An image that fades in once decoded. Images already in the cache show at once (no fade), so
 * revisiting a page never flickers. Size it with the caller's classes (aspect ratio or h/w).
 */
export function FadeImage({ src, alt, className = '', eager, onError, fit = 'cover' }: FadeImageProps) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [instant, setInstant] = useState(false);
  useLayoutEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth > 0) {
      setInstant(true);
      setLoaded(src);
    } else setInstant(false);
  }, [src]);
  const visible = loaded === src;
  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      draggable={false}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={() => setLoaded(src)}
      onError={onError}
      className={`${fit === 'cover' ? 'object-cover' : 'object-contain'} ${instant ? '' : 'transition-opacity duration-300 ease-out motion-reduce:transition-none'} ${visible ? 'opacity-100' : 'opacity-0'} ${className}`}
    />
  );
}

interface Props {
  src: string | null;
  alt: string;
  className?: string;
  /** Shown when there is no image (unmatched files). */
  fallbackTitle?: string;
  /** Replaces the default film-strip placeholder. */
  fallback?: ReactNode;
  eager?: boolean;
}

/** Artwork with a soft fade-in over a neutral tile, and a stylised title card fallback. */
export default function Artwork({ src, alt, className = '', fallbackTitle, fallback, eager }: Props) {
  const [failed, setFailed] = useState<string | null>(null);

  if (!src || failed === src) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-nf-raised via-[#1c1c1c] to-[#101010] p-3 text-center ${className}`}
      >
        {fallback ?? (
          <>
            <Film className="h-6 w-6 text-nf-muted" strokeWidth={1.5} />
            {fallbackTitle && (
              <span className="line-clamp-2 text-sm font-semibold leading-tight text-white/85">{fallbackTitle}</span>
            )}
          </>
        )}
      </div>
    );
  }
  return <FadeImage src={src} alt={alt} eager={eager} onError={() => setFailed(src)} className={`bg-nf-hover ${className}`} />;
}
