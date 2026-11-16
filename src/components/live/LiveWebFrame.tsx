import { useEffect, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { webPlayerUrl } from '../../services/live';

let fullscreenByFrame = false;
let watchingFullscreen = 0;

/**
 * A web player going full screen (its own button, or a double-click on the video) only fills the
 * app's web view; this makes the TruongFlix window full screen with it, and back again on exit.
 */
function onFrameFullscreen() {
  const el = document.fullscreenElement;
  if (el instanceof HTMLIFrameElement) {
    fullscreenByFrame = true;
    void getCurrentWindow().setFullscreen(true).catch(() => {});
  } else if (!el && fullscreenByFrame) {
    fullscreenByFrame = false;
    void getCurrentWindow().setFullscreen(false).catch(() => {});
  }
}

function useFrameFullscreen() {
  useEffect(() => {
    if (watchingFullscreen++ === 0) document.addEventListener('fullscreenchange', onFrameFullscreen);
    return () => {
      if (--watchingFullscreen === 0) document.removeEventListener('fullscreenchange', onFrameFullscreen);
    };
  }, []);
}

export type WebFrameStatus = 'loading' | 'ready' | 'failed';

/**
 * A web channel's player in a locked-down frame: no popups, downloads or navigating the
 * TruongFlix window. `reload` changes force a fresh load; so do `muted` and `compact`.
 */
export default function LiveWebFrame({
  url,
  title,
  muted = false,
  compact = false,
  reload = 0,
  className = '',
  style,
  onStatus,
}: {
  url: string;
  title: string;
  muted?: boolean;
  compact?: boolean;
  reload?: number;
  className?: string;
  style?: CSSProperties;
  onStatus?: (status: WebFrameStatus) => void;
}) {
  const src = webPlayerUrl(url, { muted, compact });
  const load = `${src}:${reload}`;
  const [loadedFor, setLoadedFor] = useState('');
  const loaded = loadedFor === load;
  useFrameFullscreen();
  useEffect(() => {
    if (loaded) {
      onStatus?.('ready');
      return;
    }
    onStatus?.('loading');
    const timer = window.setTimeout(() => onStatus?.('failed'), 20_000);
    return () => window.clearTimeout(timer);
  }, [load, loaded]);
  return (
    <iframe
      key={load}
      title={title}
      src={src}
      sandbox="allow-scripts allow-same-origin allow-presentation"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      className={`border-0 bg-black ${className}`}
      style={style}
      onLoad={() => setLoadedFor(load)}
    />
  );
}
