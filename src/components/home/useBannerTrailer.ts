import { useEffect, useRef, useState } from 'react';
import { resolveTrailer, type TrailerSource, type TrailerTitle } from '../../services/trailers';
import { useLibraryStore } from '../../store/useLibraryStore';
import { attachTrailerMedia } from '../../services/trailerMedia';
import { trailerInsets } from '../../services/trailerFrame';

type Phase = 'waiting' | 'loading' | 'playing' | 'ended' | 'failed';
const DELAY = 4000;

export function useBannerVisibility(blocked = false) {
  const overlay = useLibraryStore(
    (s) => !!s.detailKey || !!s.playerSession || s.settingsOpen || s.onboardingOpen || !!s.fixMatchKey ||
      !!s.profileGate || !!s.actor || !!s.overlay || !!s.addTorrentModal?.open,
  );
  const isVisible = () => !document.hidden && window.scrollY < window.innerHeight * 0.5;
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return visible && !overlay && !blocked;
}

/** Background trailers never share the main player's sessions, history, audio devices or subtitles. */
export function useBannerTrailer(item: TrailerTitle & { key: string }, enabled: boolean, playing: boolean) {
  const identity = `${item.key}/${item.kind}/${item.tmdbId}/${item.trailerKey}`;
  const [retry, setRetry] = useState(0);
  const [resolved, setResolved] = useState<{ identity: string; retry: number; source: TrailerSource } | null>(null);
  const source = enabled && resolved?.identity === identity && resolved.retry === retry ? resolved.source : null;
  const [phase, setPhase] = useState<Phase>('waiting');
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(true);
  const [delayPassed, setDelayPassed] = useState(false);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = useRef<{ play: () => void; replay: () => void; fail: () => void } | null>(null);
  const allowedRef = useRef(false);
  allowedRef.current = enabled && playing && delayPassed;
  const visible = !!source && active && allowedRef.current;

  useEffect(() => {
    setResolved(null); setPhase('waiting'); setActive(false); setMuted(true); setDelayPassed(false); setCrop({ x: 0, y: 0 });
  }, [identity, enabled, retry]);

  useEffect(() => {
    if (!enabled || !playing || delayPassed) return;
    const timer = window.setTimeout(() => setDelayPassed(true), DELAY);
    return () => window.clearTimeout(timer);
  }, [identity, enabled, playing, delayPassed, retry]);

  useEffect(() => {
    if (!enabled || !playing || source || (!item.trailerKey && !item.tmdbId)) return;
    let alive = true;
    setPhase('loading');
    void resolveTrailer(item, retry > 0).then((source) => {
      if (alive) setResolved({ identity, retry, source });
    }).catch(() => { if (alive) setPhase('failed'); });
    return () => { alive = false; };
  }, [identity, enabled, playing, source, retry]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    let alive = true;
    let failed = false;
    let frame = 0;
    let framed = false;
    let request = 0;
    let dispose: (() => void) | undefined;
    const hide = () => {
      if (frame) video.cancelVideoFrameCallback?.(frame);
      frame = 0;
      setActive(false);
    };
    const fail = () => {
      if (!alive || failed) return;
      failed = true;
      hide();
      video.pause();
      video.removeAttribute('src');
      dispose?.();
      video.load();
      if (!source.audioUrl) { setPhase('failed'); return; }
      // A progressive rendition keeps one media clock if this webview cannot decode
      // the adaptive tracks. It may have a lower resolution than the adaptive stream.
      setPhase('loading');
      setMuted(true);
      void resolveTrailer(item, retry > 0, true).then((fallback) => {
        if (alive) setResolved({ identity, retry, source: fallback });
      }).catch(() => { if (alive) setPhase('failed'); });
    };
    const play = (replaying = false) => {
      if (!alive || failed || !allowedRef.current || (video.ended && !replaying)) return;
      const current = ++request;
      void video.play().catch(() => {
        if (current === request && allowedRef.current) fail();
      });
    };
    const attach = () => {
      dispose?.();
      try {
        const { videoUrl, audioUrl, videoCodec, audioCodec } = source;
        if (audioUrl) {
          if (!videoCodec || !audioCodec) throw new Error('Missing trailer codecs');
          const media = attachTrailerMedia(video, { videoUrl, audioUrl, videoCodec, audioCodec }, fail);
          dispose = media.dispose;
          video.src = media.url;
        } else video.src = videoUrl;
      } catch { fail(); }
    };
    const replay = () => {
      hide();
      setPhase('loading');
      // The adaptive buffer may have discarded earlier frames. Start a new buffer
      // on this same element so the replay gesture also authorizes its audio.
      if (source.audioUrl) attach();
      else video.currentTime = 0;
      play(true);
    };
    const reveal = () => {
      frame = 0;
      if (!alive || failed || !allowedRef.current || video.paused || video.ended || video.readyState < 2) return;
      if (!framed && video.videoWidth) {
        framed = true;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 160; canvas.height = 90;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(video, 0, 0, 160, 90);
            setCrop(trailerInsets(context.getImageData(0, 0, 160, 90).data, 160, 90));
          }
        } catch { /* Keep the natural frame when pixel access is unavailable. */ }
      }
      setActive(true); setPhase('playing');
    };
    const started = () => {
      if (frame) video.cancelVideoFrameCallback?.(frame);
      if (typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(reveal);
      else reveal();
    };
    const paused = () => { if (video.paused) hide(); };
    const ended = () => { if (!failed) { hide(); setPhase('ended'); } };
    video.addEventListener('playing', started);
    video.addEventListener('waiting', hide);
    video.addEventListener('seeking', hide);
    video.addEventListener('pause', paused);
    video.addEventListener('ended', ended);
    video.addEventListener('error', fail);
    playback.current = { play, replay, fail };
    setCrop({ x: 0, y: 0 });
    attach();
    return () => {
      alive = false;
      playback.current = null;
      if (frame) video.cancelVideoFrameCallback?.(frame);
      video.removeEventListener('playing', started);
      video.removeEventListener('waiting', hide);
      video.removeEventListener('seeking', hide);
      video.removeEventListener('pause', paused);
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', fail);
      video.pause();
      video.removeAttribute('src');
      dispose?.();
      video.load();
    };
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    if (!allowedRef.current) {
      video.pause();
      setActive(false);
      return;
    }
    playback.current?.play();
    return () => { video.pause(); };
  }, [enabled, playing, delayPassed, source]);

  useEffect(() => {
    if (!source || !playing || !delayPassed || active || phase === 'ended' || phase === 'failed') return;
    const timer = window.setTimeout(() => playback.current?.fail(), 25_000);
    return () => window.clearTimeout(timer);
  }, [source, playing, delayPassed, active, phase]);

  const toggleMute = () => {
    if (phase === 'failed') { setRetry((n) => n + 1); return; }
    if (phase === 'ended') { playback.current?.replay(); return; }
    const video = videoRef.current;
    if (!video) return;
    const next = !muted;
    video.muted = next;
    setMuted(next);
    // Unmute inside the gesture and leave the current media timeline untouched.
    if (!next && video.paused) playback.current?.play();
  };
  const frameStyle = { width: `${100 / (1 - crop.x * 2)}%`, height: `${100 / (1 - crop.y * 2)}%`, transform: 'translate(-50%, -50%)' };
  return { source, phase, active: visible, muted, videoRef, toggleMute, frameStyle };
}
