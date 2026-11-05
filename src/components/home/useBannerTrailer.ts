import { useEffect, useRef, useState } from 'react';
import { resolveTrailer, type TrailerSource, type TrailerTitle } from '../../services/trailers';
import { useLibraryStore } from '../../store/useLibraryStore';
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
  const [resolved, setResolved] = useState<{ identity: string; source: TrailerSource } | null>(null);
  const source = enabled && resolved?.identity === identity ? resolved.source : null;
  const [phase, setPhase] = useState<Phase>('waiting');
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(true);
  const [delayPassed, setDelayPassed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
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
    if (!enabled || !playing || source || phase === 'failed' || phase === 'ended' || (!item.trailerKey && !item.tmdbId)) return;
    let alive = true;
    setPhase('loading');
    void resolveTrailer(item, retry > 0).then((source) => {
      if (alive) setResolved({ identity, source });
    }).catch(() => { if (alive) setPhase('failed'); });
    return () => { alive = false; };
  }, [identity, enabled, playing, source, retry]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !source) return;
    let alive = true;
    let frame = 0;
    let audioPending = false;
    let nextAudioAttempt = 0;
    let framed = false;
    const frameTrailer = () => {
      if (framed || !video.videoWidth) return;
      framed = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 90;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(video, 0, 0, 160, 90);
        setCrop(trailerInsets(context.getImageData(0, 0, 160, 90).data, 160, 90));
      } catch { /* Keep the natural frame when pixel access is unavailable. */ }
    };
    const sync = () => {
      if (!audio || audio.muted || !allowedRef.current || video.paused || video.readyState < 3 || video.seeking) return;
      if (audio.readyState && !audio.seeking && Math.abs(audio.currentTime - video.currentTime) > 0.3) audio.currentTime = video.currentTime;
      if (audio.paused && !audioPending && Date.now() >= nextAudioAttempt) {
        audioPending = true;
        void audio.play().catch(() => { nextAudioAttempt = Date.now() + 2000; }).finally(() => { audioPending = false; });
      }
    };
    const reveal = () => {
      if (!alive || !allowedRef.current || video.paused || video.ended || video.readyState < 2) return;
      // Set the framing before showing the first frame and keep it for the whole trailer.
      frameTrailer();
      setActive(true); setPhase('playing'); sync();
    };
    const started = () => {
      if (typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(reveal);
      else reveal();
    };
    const hide = () => { setActive(false); audio?.pause(); };
    const ended = () => { hide(); setPhase('ended'); };
    const failed = () => { hide(); video.pause(); setPhase('failed'); };
    video.addEventListener('playing', started);
    video.addEventListener('waiting', hide);
    video.addEventListener('seeking', hide);
    video.addEventListener('pause', hide);
    video.addEventListener('ended', ended);
    video.addEventListener('error', failed);
    audio?.addEventListener('canplay', sync);
    const timer = window.setInterval(sync, 250);
    return () => {
      alive = false;
      if (frame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame);
      window.clearInterval(timer);
      video.pause(); audio?.pause();
      video.removeEventListener('playing', started);
      video.removeEventListener('waiting', hide);
      video.removeEventListener('seeking', hide);
      video.removeEventListener('pause', hide);
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', failed);
      audio?.removeEventListener('canplay', sync);
    };
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !source) return;
    video.muted = source.audioUrl ? true : muted;
    if (audio) audio.muted = muted;
    if (!enabled || !playing || !delayPassed || phase === 'failed') {
      video.pause(); audio?.pause(); setActive(false); return;
    }
    if (video.ended || phase === 'ended') return;
    let cancelled = false;
    void video.play().catch(() => { if (!cancelled) { setActive(false); setPhase('failed'); } });
    return () => { cancelled = true; };
  }, [enabled, playing, delayPassed, source, muted]);

  useEffect(() => {
    if (!source || !playing || !delayPassed || active || phase === 'ended' || phase === 'failed') return;
    const timer = window.setTimeout(() => {
      videoRef.current?.pause(); audioRef.current?.pause(); setPhase('failed');
    }, 25_000);
    return () => window.clearTimeout(timer);
  }, [source, playing, delayPassed, active, phase]);

  const toggleMute = () => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (phase === 'failed') { setRetry((n) => n + 1); return; }
    if (!video) return;
    if (phase === 'ended') {
      video.currentTime = 0;
      if (audio) audio.currentTime = 0;
      setPhase('loading');
      void video.play().catch(() => setPhase('failed'));
      return;
    }
    const next = !muted;
    setMuted(next);
    if (audio) {
      audio.muted = next;
      if (!next && allowedRef.current && !video.paused) {
        audio.currentTime = video.currentTime;
        // Start within the button's user gesture for WebKit's audio policy.
        void audio.play().catch(() => setMuted(true));
      } else audio.pause();
    } else video.muted = next;
  };
  const frameStyle = { width: `${100 / (1 - crop.x * 2)}%`, height: `${100 / (1 - crop.y * 2)}%`, transform: 'translate(-50%, -50%)' };
  return { source, phase, active: visible, muted, videoRef, audioRef, toggleMute, frameStyle };
}
