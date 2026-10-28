import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Info, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { MediaItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { playTargetFor } from '../../store/selectors';
import { playItem } from '../../services/player';
import TechBadges from '../common/TechBadges';
import ImdbRating from '../common/ImdbRating';
import CriticScores from '../common/CriticScores';

/** Seconds of still backdrop before the trailer fades in (like Netflix's home page). */
const TRAILER_DELAY_MS = 4000;

type TrailerPhase = 'waiting' | 'loading' | 'playing' | 'ended' | 'failed';

function trailerUrl(key: string) {
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    iv_load_policy: '3',
    cc_load_policy: '0',
    modestbranding: '1',
    playsinline: '1',
    rel: '0',
    vq: 'hd1080',
    enablejsapi: '1',
  });
  if (window.location.protocol.startsWith('http')) {
    params.set('origin', window.location.origin);
  }
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?${params}`;
}

/** Whether the banner trailer may play right now (nothing on top of it, window visible, scrolled to top). */
function useTrailerAllowed() {
  const enabled = useLibraryStore((s) => s.settings.trailers_autoplay);
  const blocked = useLibraryStore(
    (s) => !!s.detailKey || !!s.playerSession || s.settingsOpen || s.onboardingOpen || !!s.fixMatchKey || !!s.profileGate || !!s.actor || !!s.overlay,
  );
  const [visible, setVisible] = useState(() => !document.hidden && window.scrollY < window.innerHeight * 0.5);
  useEffect(() => {
    const update = () => setVisible(!document.hidden && window.scrollY < window.innerHeight * 0.5);
    window.addEventListener('scroll', update, { passive: true });
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('scroll', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return { enabled, playing: enabled && !blocked && visible };
}

interface Props {
  item: MediaItem;
}

export default function HeroBillboard({ item }: Props) {
  const openDetail = useLibraryStore((s) => s.openDetail);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const [logoFailed, setLogoFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const target = playTargetFor(item, episodesBySeries);
  const resume = !!target && target.startTime > 0;

  // Trailer (muted YouTube embed) that takes over from the backdrop after a few seconds.
  const { enabled, playing } = useTrailerAllowed();
  const [phase, setPhase] = useState<TrailerPhase>('waiting');
  const [ytState, setYtState] = useState<number | null>(null);
  const [muted, setMuted] = useState(true);
  const sectionRef = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const trailerKey = enabled ? item.trailerKey : null;
  const [box, setBox] = useState(() => ({ w: window.innerWidth || 1920, h: Math.max(520, (window.innerHeight || 1080) * 0.85) }));

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const send = (func: string, args: unknown[] = []) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');

  const forceHd = () => {
    send('setPlaybackQualityRange', ['hd1080', 'highres']);
    send('setPlaybackQuality', ['hd1080']);
  };

  useEffect(() => {
    if (!trailerKey || phase !== 'waiting' || !playing) return;
    const t = window.setTimeout(() => setPhase('loading'), TRAILER_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [trailerKey, phase, playing]);

  // YouTube iframe API messages: playing / paused / buffering / ended / errors.
  useEffect(() => {
    if (phase === 'waiting' || phase === 'failed') return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return;
      let msg: { event?: string; info?: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.event === 'onReady') {
        forceHd();
        return;
      }
      const state =
        msg.event === 'onStateChange'
          ? typeof msg.info === 'number'
            ? msg.info
            : undefined
          : msg.event === 'infoDelivery'
            ? (msg.info as { playerState?: number })?.playerState
            : undefined;
      if (typeof state === 'number') setYtState(state);
      if (msg.event === 'onError') setPhase('failed');
      else if (state === 1) {
        forceHd();
        setPhase((p) => (p === 'ended' ? p : 'playing'));
      } else if (state === 0) setPhase('ended');
    };
    window.addEventListener('message', onMessage);
    // Give up quietly if the video never starts (blocked embed, offline, …).
    const giveUp = window.setTimeout(() => setPhase((p) => (p === 'loading' ? 'failed' : p)), 15000);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(giveUp);
    };
  }, [phase]);

  // Fade the iframe out first when something covers the banner, then pause once hidden so YouTube's
  // pause icon / end-screen overlay never flashes; resume afterwards if we paused it.
  const pausedByUs = useRef(false);
  useEffect(() => {
    if (phase !== 'playing') return;
    if (!playing) {
      pausedByUs.current = true;
      const t = window.setTimeout(() => send('pauseVideo'), 180);
      return () => window.clearTimeout(t);
    }
    if (pausedByUs.current) {
      send('playVideo');
      pausedByUs.current = false;
    }
  }, [playing, phase]);

  const toggleMute = () => {
    if (phase === 'ended') {
      setYtState(null);
      setPhase('loading');
      send('seekTo', [0, true]);
      send('playVideo');
      return;
    }
    send(muted ? 'unMute' : 'mute');
    setMuted(!muted);
  };

  // Only reveal the embed while YouTube is actively playing (never while paused, buffering, or covered).
  const trailerOn = phase === 'playing' && playing && ytState === 1;

  // Render the iframe at >= 1920x1080 CSS px and scale via transform so YouTube ABR picks 1080p+
  // even on Windows high-DPI displays (125%–175% scaling) where the CSS viewport is < 1280x720.
  const coverW = Math.max(box.w, (box.h * 16) / 9) * 1.18;
  const iframeW = Math.max(1920, Math.ceil(coverW));
  const iframeH = Math.ceil((iframeW * 9) / 16);
  const iframeScale = coverW / iframeW;

  return (
    <section ref={sectionRef} className="relative h-[85vh] min-h-[520px] w-full overflow-hidden">
      {item.backdrop && (
        <motion.img
          key={item.backdrop}
          src={item.backdrop}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: loaded ? 1 : 0, scale: loaded ? 1 : 1.04 }}
          transition={{ duration: 1.1, ease: 'easeOut' }}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      )}

      {trailerKey && (phase === 'loading' || phase === 'playing' || phase === 'ended') && (
        <motion.div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: trailerOn ? 1 : 0 }}
          transition={{ duration: trailerOn ? 0.9 : 0.15, ease: 'easeOut' }}
        >
          <iframe
            ref={frame}
            src={trailerUrl(trailerKey)}
            title={`${item.title} trailer`}
            tabIndex={-1}
            allow="autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => {
              const win = frame.current?.contentWindow;
              if (!win) return;
              win.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
              for (const ev of ['onReady', 'onStateChange', 'onError']) {
                win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: [ev] }), '*');
              }
            }}
            className="pointer-events-none absolute left-1/2 top-1/2 border-0"
            style={{
              width: `${iframeW}px`,
              height: `${iframeH}px`,
              transform: `translate(-50%, -50%) scale(${iframeScale})`,
            }}
          />
        </motion.div>
      )}

      {/* Left text-protection vignette */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(77deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 85%)' }}
      />
      {/* Bottom fade into the rows */}
      <div
        className="absolute inset-x-0 bottom-0 h-[45%]"
        style={{ background: 'linear-gradient(180deg, rgba(20,20,20,0) 0%, rgba(20,20,20,0.6) 60%, #141414 100%)' }}
      />

      <motion.div
        key={item.key}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.2 }}
        className="absolute bottom-[28%] left-[4%] z-10 flex max-w-[40%] flex-col gap-4"
      >
        {item.logo && !logoFailed ? (
          <img
            src={item.logo}
            alt={item.title}
            draggable={false}
            onError={() => setLogoFailed(true)}
            className="max-h-[130px] max-w-full self-start object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]"
          />
        ) : (
          <h1 className="text-shadow text-[clamp(2.2rem,4.6vw,4.5rem)] font-black uppercase leading-[0.95] tracking-tight">
            {item.title}
          </h1>
        )}

        <div className="text-shadow flex flex-wrap items-center gap-x-3 gap-y-1 text-[clamp(0.85rem,1.1vw,1.05rem)] font-medium">
          <ImdbRating rating={item.imdbRating} size="md" />
          <CriticScores rt={item.rtScore} metacritic={item.metacritic} size="md" />
          {item.year && <span className="text-[#e5e5e5]">{item.year}</span>}
          {item.kind === 'tv' && item.seasonCount > 0 && (
            <span className="text-[#e5e5e5]">
              {item.seasonCount} Season{item.seasonCount > 1 ? 's' : ''}
            </span>
          )}
          <TechBadges tech={item.tech} showCodec={false} size="md" />
        </div>

        <AnimatePresence initial={false}>
          {item.overview && !trailerOn && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.6 }}
              className="text-shadow line-clamp-3 text-lg leading-snug text-white drop-shadow-lg"
            >
              {item.overview}
            </motion.p>
          )}
        </AnimatePresence>

        <div className="mt-1 flex items-center gap-3">
          <button onClick={() => playItem(item)} className="nf-btn-play text-lg">
            <Play className="h-7 w-7 fill-black" strokeWidth={0} />
            {resume ? 'Resume' : 'Play'}
          </button>
          <button onClick={() => openDetail(item.key)} className="nf-btn-info text-lg">
            <Info className="h-7 w-7" />
            More Info
          </button>
        </div>
      </motion.div>

      {/* Right side: trailer sound / replay + maturity rating, as on Netflix */}
      <div className="absolute bottom-[32%] right-0 z-10 flex items-center gap-3">
        {(phase === 'playing' || phase === 'ended') && (
          <button
            onClick={toggleMute}
            title={phase === 'ended' ? 'Replay trailer' : muted ? 'Unmute trailer' : 'Mute trailer'}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-white/60 bg-black/20 transition hover:bg-white/10"
          >
            {phase === 'ended' ? <RotateCcw className="h-5 w-5" /> : muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
        )}
        {item.certification && (
          <div className="flex h-9 items-center border-l-[3px] border-[#dcdcdc] bg-[rgba(51,51,51,0.6)] pl-3 pr-[4vw] text-lg">
            {item.certification}
          </div>
        )}
      </div>
    </section>
  );
}
