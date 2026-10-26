import { useState } from 'react';
import { Film } from 'lucide-react';

interface Props {
  src: string | null;
  alt: string;
  className?: string;
  /** Shown when there is no image (unmatched files). */
  fallbackTitle?: string;
  eager?: boolean;
}

/** Image with a soft fade-in and a stylised title card fallback. */
export default function Artwork({ src, alt, className = '', fallbackTitle, eager }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#2b2b2b] via-[#1c1c1c] to-[#101010] p-3 text-center ${className}`}
      >
        <Film className="h-6 w-6 text-nf-muted" strokeWidth={1.5} />
        {fallbackTitle && (
          <span className="line-clamp-2 text-sm font-semibold leading-tight text-white/85">{fallbackTitle}</span>
        )}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={`bg-[#232323] object-cover transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'} ${className}`}
    />
  );
}
