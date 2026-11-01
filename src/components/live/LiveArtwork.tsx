import { useEffect, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { liveArtwork } from '../../services/live';

export function LiveArtwork({ url, className = '' }: { url: string; className?: string }) {
  const [src, setSrc] = useState('');
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setSrc('');
    let alive = true;
    if (url && visible)
      void liveArtwork(url)
        .then((path) => {
          if (alive) setSrc(path);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url, visible]);
  return (
    <span ref={ref} className={`inline-flex shrink-0 items-center justify-center ${className}`}>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-contain" onError={() => setSrc('')} />
      ) : (
        <Radio className="h-1/2 w-1/2 text-white/30" />
      )}
    </span>
  );
}
